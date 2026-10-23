import { safeStorage, session, type Session, type WebContents } from 'electron';
import type ElectronStore from 'electron-store';
import { CloudflareGateway } from './cloudflareGateway';
import { workerEndpoint } from './relayTargets';
import { RecoveryPolicy } from './recoveryPolicy';
const pac = (port: number) =>
    'data:application/x-ns-proxy-autoconfig;base64,' +
    Buffer.from(
        'function FindProxyForURL(url,host){if(host==="soundcloud.com"||dnsDomainIs(host,".soundcloud.com")||host==="sndcdn.com"||dnsDomainIs(host,".sndcdn.com"))return "PROXY 127.0.0.1:' +
            port +
            '";return "DIRECT";}',
    ).toString('base64');
export class ConnectionRecovery {
    private gateway = new CloudflareGateway();
    private port = 0;
    private gatewayTask?: Promise<number>;
    private routed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private status = 'Резервное подключение выключено';
    private policy?: RecoveryPolicy;
    private generation = 0;
    constructor(
        private contents: WebContents,
        private store: ElectronStore,
        private notify: (message: string) => void,
    ) {
        contents.on('did-start-navigation', (_event, url, _inPlace, main) => {
            if (main && url.startsWith('https://soundcloud.com/')) this.arm();
        });
        contents.on('did-fail-load', (_event, code, _description, url, main) => {
            if (main && code !== -3 && url.startsWith('https://soundcloud.com/')) void this.recover();
        });
        contents.on('did-frame-navigate', (_event, url, status, _text, main) => {
            if (main && url.startsWith('https://soundcloud.com/') && [403, 451, 500, 502, 503, 504].includes(status))
                void this.recover();
        });
        const networkSession = contents.session;
        networkSession.webRequest.onErrorOccurred(
            { urls: ['https://api-v2.soundcloud.com/*', 'https://*.sndcdn.com/*'] },
            (details) => {
                if (
                    (details.resourceType === 'media' || new URL(details.url).hostname === 'api-v2.soundcloud.com') &&
                    !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_CERT_/.test(details.error)
                )
                    void this.recover();
            },
        );
        contents.once('destroyed', () => {
            this.generation++;
            clearTimeout(this.timer);
            this.gateway.close();
            networkSession.webRequest.onErrorOccurred(null);
        });
    }
    getStatus(): string {
        return this.status;
    }
    private secret(): string {
        const saved = this.store.get('cloudflareSecretEncrypted');
        if (typeof saved !== 'string' || !saved) return '';
        try {
            return safeStorage.decryptString(Buffer.from(saved, 'base64'));
        } catch {
            return '';
        }
    }
    save(input: unknown): void {
        const data = input as {
            mode?: unknown;
            endpoint?: unknown;
            secret?: unknown;
        } | null;
        if (
            !data ||
            typeof data.mode !== 'string' ||
            !['off', 'auto', 'always'].includes(data.mode) ||
            typeof data.endpoint !== 'string' ||
            typeof data.secret !== 'string'
        )
            throw new Error('Некорректные настройки подключения.');
        const endpoint = data.endpoint.trim();
        if (endpoint) workerEndpoint(endpoint);
        if (data.mode !== 'off' && !endpoint) throw new Error('Сначала укажите адрес вашего Worker.');
        if (data.secret) {
            if (!/^[A-Za-z0-9_-]{32,256}$/.test(data.secret))
                throw new Error('Ключ: 32–256 символов A–Z, a–z, 0–9, _ или -.');
            if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное хранилище ключей недоступно.');
            this.store.set('cloudflareSecretEncrypted', safeStorage.encryptString(data.secret).toString('base64'));
        }
        if (data.mode !== 'off' && !this.secret()) throw new Error('Введите ключ Worker.');
        this.store.set('cloudflareEndpoint', endpoint);
        this.store.set('cloudflareMode', data.mode);
    }
    async configure(): Promise<void> {
        const wasRouted = this.routed;
        this.generation++;
        clearTimeout(this.timer);
        this.gateway.close();
        this.port = 0;
        this.gatewayTask = undefined;
        this.routed = false;
        this.policy = undefined;
        if (wasRouted && !this.store.get('proxyEnabled') && !this.contents.isDestroyed()) {
            await this.contents.session.setProxy({ mode: 'system' });
            await this.contents.session.closeAllConnections();
        }
        if (this.store.get('proxyEnabled')) {
            this.status = 'Используется вручную настроенный прокси';
            return;
        }
        const mode = this.store.get('cloudflareMode', 'off');
        if (mode === 'off') {
            this.status = 'Резервное подключение выключено';
            return;
        }
        if (!this.store.get('cloudflareEndpoint') || !this.secret()) {
            this.status = 'Нужны адрес и ключ вашего Cloudflare Worker';
            return;
        }
        const generation = this.generation;
        this.policy = new RecoveryPolicy({
            direct: () => this.probe(session.fromPartition('wave-connection-direct')),
            relay: async () => {
                try {
                    return await this.testRelay();
                } catch {
                    return false;
                }
            },
            playing: async () =>
                this.routed ||
                this.contents.isDestroyed() ||
                generation !== this.generation ||
                (await this.contents
                    .executeJavaScript('Boolean(document.querySelector(".playControls__play.playing"))')
                    .catch(() => false)),
            activate: async () => {
                if (generation !== this.generation || this.contents.isDestroyed()) return;
                await this.contents.session.setProxy({ mode: 'pac_script', pacScript: pac(this.port) });
                await this.contents.session.closeAllConnections();
                this.routed = true;
                this.status = 'SoundCloud подключён через Cloudflare';
                this.notify(this.status);
                void this.contents.loadURL('https://soundcloud.com/discover').catch(() => {});
            },
        });
        if (mode === 'always') {
            const available = await this.testRelay();
            if (generation !== this.generation || this.contents.isDestroyed()) return;
            if (available) {
                await this.contents.session.setProxy({ mode: 'pac_script', pacScript: pac(this.port) });
                await this.contents.session.closeAllConnections();
                this.routed = true;
                this.status = 'SoundCloud подключён через Cloudflare';
            } else {
                this.status = 'Worker недоступен. Проверьте адрес и ключ. Сохранено обычное подключение.';
                this.notify(this.status);
            }
        } else {
            this.status = 'Автоматически: сначала обычное подключение';
            this.arm();
        }
    }
    private arm(): void {
        clearTimeout(this.timer);
        if (!this.policy || this.routed || this.store.get('cloudflareMode') !== 'auto') return;
        this.timer = setTimeout(() => {
            void this.recover();
        }, 18000);
    }
    private async recover(): Promise<void> {
        if (!this.policy || this.routed || this.store.get('cloudflareMode') !== 'auto') return;
        const generation = this.generation;
        try {
            const result = await this.policy.recover();
            if (this.contents.isDestroyed() || generation !== this.generation) return;
            if (result === 'unavailable') {
                this.status = 'Обычное подключение и Worker недоступны. Автоперезагрузки остановлены.';
                this.notify(this.status);
            }
            if (result === 'direct') this.status = 'Обычное подключение работает';
            if (result === 'deferred') this.arm();
        } catch {
            if (this.contents.isDestroyed() || generation !== this.generation) return;
            this.status = 'Не удалось восстановить подключение';
            this.notify(this.status);
        }
    }
    async testRelay(): Promise<boolean> {
        const generation = this.generation;
        if (!this.port) {
            const task =
                this.gatewayTask || this.gateway.start(String(this.store.get('cloudflareEndpoint', '')), this.secret());
            this.gatewayTask = task;
            try {
                const port = await task;
                if (generation !== this.generation) return false;
                this.port = port;
            } finally {
                if (this.gatewayTask === task) this.gatewayTask = undefined;
            }
        }
        if (generation !== this.generation) return false;
        const probeSession = session.fromPartition('wave-connection-relay');
        await probeSession.setProxy({ mode: 'pac_script', pacScript: pac(this.port) });
        return this.probe(probeSession);
    }
    private async probe(target: Session): Promise<boolean> {
        target.setUserAgent(this.contents.getUserAgent());
        const controller = new AbortController(),
            timer = setTimeout(() => controller.abort(), 6000);
        try {
            const response = await target.fetch('https://soundcloud.com/discover', {
                signal: controller.signal,
                credentials: 'omit',
                cache: 'no-store',
            });
            if (!response.ok) return false;
            const html = await response.text();
            if (!html.includes('sndcdn.com') || !html.includes('<script')) return false;
            const api = await target.fetch('https://api-v2.soundcloud.com/', {
                signal: controller.signal,
                credentials: 'omit',
                cache: 'no-store',
            });
            return [200, 401, 404].includes(api.status);
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}
