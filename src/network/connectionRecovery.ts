import { safeStorage, session, type Session, type WebContents } from 'electron';
import type ElectronStore from 'electron-store';
import { CloudflareGateway } from './cloudflareGateway';
import { workerEndpoint } from './relayTargets';
import { RecoveryPolicy } from './recoveryPolicy';
import { probeSoundCloud, describeRelayDiagnostic, type RelayDiagnostic } from './relayDiagnostics';
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
    private relayTestTask?: Promise<boolean>;
    private relayProbeAbort?: AbortController;
    private diagnostic?: RelayDiagnostic;
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
            this.relayProbeAbort?.abort();
            clearTimeout(this.timer);
            this.gateway.close();
            networkSession.webRequest.onErrorOccurred(null);
        });
    }
    getStatus(): string {
        return this.status;
    }
    getDiagnostics(): RelayDiagnostic | null {
        return this.diagnostic ? structuredClone(this.diagnostic) : null;
    }
    getTestMessage(): string {
        return describeRelayDiagnostic(this.diagnostic);
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
        this.relayProbeAbort?.abort();
        this.relayTestTask = undefined;
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
                this.status = this.getTestMessage();
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
                this.status = this.getTestMessage() + ' Автоперезагрузки остановлены.';
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
    testRelay(): Promise<boolean> {
        if (this.relayTestTask) return this.relayTestTask;
        const task = this.runRelayTest();
        this.relayTestTask = task;
        void task
            .finally(() => {
                if (this.relayTestTask === task) this.relayTestTask = undefined;
            })
            .catch(() => {});
        return task;
    }
    private async runRelayTest(): Promise<boolean> {
        const generation = this.generation;
        const began = Date.now();
        const report: RelayDiagnostic = {
            checkedAt: new Date().toISOString(),
            endpointHost: '',
            success: false,
            elapsedMs: 0,
            stages: [],
            tunnels: [],
        };
        this.diagnostic = report;
        const cursor = this.gateway.getDiagnosticCursor?.() ?? 0;
        this.relayProbeAbort = new AbortController();
        const endpoint = String(this.store.get('cloudflareEndpoint', ''));
        try {
            if (!endpoint) {
                report.setupFailure = 'missing-endpoint';
                return false;
            }
            try {
                report.endpointHost = new URL(workerEndpoint(endpoint)).hostname;
            } catch {
                report.setupFailure = 'invalid-endpoint';
                return false;
            }
            const secret = this.secret();
            if (!/^[a-zA-Z0-9_-]{32,256}$/.test(secret)) {
                report.setupFailure = 'missing-key';
                return false;
            }
            if (!this.port) {
                const task = this.gatewayTask || this.gateway.start(endpoint, secret);
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
            await probeSession.closeAllConnections();
            report.success = await this.probe(probeSession, report);
            if (generation !== this.generation) report.success = false;
            return report.success;
        } catch {
            report.setupFailure = 'gateway';
            return false;
        } finally {
            report.elapsedMs = Date.now() - began;
            report.tunnels = this.gateway.getDiagnostics?.(cursor) ?? [];
        }
    }
    private async probe(target: Session, report?: RelayDiagnostic): Promise<boolean> {
        if (this.contents.isDestroyed()) return false;
        target.setUserAgent(this.contents.getUserAgent());
        const stages = await probeSoundCloud(target.fetch.bind(target) as typeof fetch, {
            timeoutMs: report ? 15000 : 6000,
            signal: report ? this.relayProbeAbort?.signal : undefined,
        });
        if (report) report.stages = stages;
        return stages.length === 2 && stages.every((stage) => stage.outcome === 'ok');
    }
}
