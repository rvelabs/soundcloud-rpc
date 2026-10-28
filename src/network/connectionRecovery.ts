import { safeStorage, session, type Session, type WebContents } from 'electron';
import type ElectronStore from 'electron-store';
import { CloudflareGateway } from './cloudflareGateway';
import { relayPac, relayTarget, workerEndpoint, playlistBrowserPac } from './relayTargets';
import { RecoveryPolicy } from './recoveryPolicy';
import { probeSoundCloud, describeRelayDiagnostic, networkErrorCode, type RelayDiagnostic } from './relayDiagnostics';
import { fetchSourceRelay } from '../import/sourceRelay';
import type { SourceRequestInit } from '../import/youtubePagination';
import { interfaceText } from '../i18n/interfaceText';
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
    private bootstrapFailed = false;
    private pageFailures: {
        host: string;
        type: string;
        workerAllowed: boolean;
        count: number;
        error?: string;
        httpStatus?: number;
    }[] = [];
    private mainStatus?: number;
    private mainError?: string;
    constructor(
        private contents: WebContents,
        private store: ElectronStore,
        private notify: (message: string) => void,
    ) {
        contents.on('did-start-navigation', (_event, url, _inPlace, main) => {
            if (main && url.startsWith('https://soundcloud.com/')) {
                this.bootstrapFailed = false;
                this.pageFailures = [];
                this.mainStatus = undefined;
                this.mainError = undefined;
                this.arm();
            }
        });
        contents.on('did-fail-load', (_event, code, _description, url, main) => {
            if (main && code !== -3 && url.startsWith('https://soundcloud.com/')) {
                this.mainError = networkErrorCode(_description) || String(code);
                void this.recover();
            }
        });
        contents.on('did-frame-navigate', (_event, url, status, _text, main) => {
            if (main && url.startsWith('https://soundcloud.com/')) {
                this.mainStatus = status;
                if ([403, 451, 500, 502, 503, 504].includes(status)) void this.recover();
            }
        });
        const networkSession = contents.session;
        networkSession.webRequest.onErrorOccurred({ urls: ['https://*/*'] }, (details) => {
            if (details.webContentsId !== contents.id || /ERR_ABORTED/.test(details.error)) return;
            this.recordFailure(details.url, details.resourceType, { error: networkErrorCode(details.error) });
            if (
                this.criticalResource(details.url, details.resourceType) &&
                !/ERR_CERT_|ERR_BLOCKED_BY_CLIENT/.test(details.error)
            ) {
                if (details.resourceType === 'script' || details.resourceType === 'stylesheet')
                    this.bootstrapFailed = true;
                void this.recover();
            }
        });
        networkSession.webRequest.onCompleted({ urls: ['https://*/*'] }, (details) => {
            if (details.webContentsId !== contents.id || details.statusCode < 400) return;
            this.recordFailure(details.url, details.resourceType, { httpStatus: details.statusCode });
            if (
                this.criticalResource(details.url, details.resourceType) &&
                (details.resourceType === 'script' ||
                    details.resourceType === 'stylesheet' ||
                    [403, 451, 500, 502, 503, 504].includes(details.statusCode))
            ) {
                if (details.resourceType === 'script' || details.resourceType === 'stylesheet')
                    this.bootstrapFailed = true;
                void this.recover();
            }
        });
        contents.once('destroyed', () => {
            this.generation++;
            this.relayProbeAbort?.abort();
            clearTimeout(this.timer);
            this.gateway.close();
            networkSession.webRequest.onErrorOccurred(null);
            networkSession.webRequest.onCompleted(null);
        });
    }
    getStatus(language: 'ru' | 'en' = 'ru'): string {
        if (language === 'en' && this.diagnostic && this.status.startsWith(describeRelayDiagnostic(this.diagnostic)))
            return (
                describeRelayDiagnostic(this.diagnostic, language) +
                (this.status.endsWith('Автоперезагрузки остановлены.') ? ' Automatic reloads stopped.' : '')
            );
        return interfaceText(this.status, language);
    }
    canLoadPlaylistSource(): boolean {
        return (
            this.store.get('cloudflareMode', 'off') !== 'off' &&
            Boolean(this.store.get('cloudflareEndpoint')) &&
            Boolean(this.secret())
        );
    }
    async configurePlaylistSession(target: Session, force = false): Promise<boolean> {
        if (
            !this.canLoadPlaylistSource() ||
            (!force && !this.routed && this.store.get('cloudflareMode') !== 'always')
        ) {
            await target.setProxy({ mode: 'system' });
            await target.closeAllConnections();
            return false;
        }
        const generation = this.generation;
        if (!this.port) {
            const task =
                this.gatewayTask || this.gateway.start(String(this.store.get('cloudflareEndpoint')), this.secret());
            this.gatewayTask = task;
            try {
                const port = await task;
                if (generation !== this.generation) return false;
                this.port = port;
            } finally {
                if (this.gatewayTask === task) this.gatewayTask = undefined;
            }
        }
        await target.setProxy({ mode: 'pac_script', pacScript: playlistBrowserPac(this.port) });
        await target.closeAllConnections();
        return true;
    }
    workerSetupTarget(): { endpoint: string; secret: string } | undefined {
        const endpoint = String(this.store.get('cloudflareEndpoint', '')),
            secret = this.secret();
        return endpoint && secret ? { endpoint, secret } : undefined;
    }
    async loadPlaylistSource(url: string, signal?: AbortSignal, init?: SourceRequestInit): Promise<string> {
        if (!this.canLoadPlaylistSource()) throw new Error('Для резервной загрузки плейлиста настройте Worker в F1.');
        const target = session.fromPartition('wave-playlist-relay');
        return fetchSourceRelay(
            String(this.store.get('cloudflareEndpoint')),
            this.secret(),
            url,
            target.fetch.bind(target) as typeof fetch,
            signal,
            init,
        );
    }
    getDiagnostics(): RelayDiagnostic | null {
        return this.diagnostic ? structuredClone(this.diagnostic) : null;
    }
    getTestMessage(language: 'ru' | 'en' = 'ru'): string {
        return describeRelayDiagnostic(this.diagnostic, language);
    }
    private criticalResource(url: string, type: string): boolean {
        const host = new URL(url).hostname;
        return (
            relayTarget(host) &&
            (host === 'api-v2.soundcloud.com' ||
                host === 'api-auth.soundcloud.com' ||
                type === 'media' ||
                type === 'script' ||
                type === 'stylesheet' ||
                (type === 'subFrame' && host === 'secure.soundcloud.com'))
        );
    }
    private recordFailure(url: string, type: string, failure: { error?: string; httpStatus?: number }): void {
        const host = new URL(url).hostname;
        const workerAllowed = relayTarget(host);
        if (!workerAllowed && !['script', 'stylesheet', 'subFrame', 'xhr'].includes(type)) return;
        const previous = this.pageFailures.find(
            (item) =>
                item.host === host &&
                item.type === type &&
                item.error === failure.error &&
                item.httpStatus === failure.httpStatus,
        );
        if (previous) {
            previous.count++;
            return;
        }
        this.pageFailures.push({ host, type, workerAllowed, count: 1, ...failure });
        if (this.pageFailures.length > 20) this.pageFailures.shift();
    }
    private async pageState(): Promise<{ readyState: string; appShell: boolean; errorPage: boolean } | null> {
        if (this.contents.isDestroyed()) return null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.contents.executeJavaScript(
                    `(()=>({readyState:document.readyState,appShell:Boolean(document.querySelector('.header,.playControls,.l-front,.listenEngagement')),errorPage:/Sorry!?\\s*Something went wrong/i.test(document.body?.innerText||'')}))()`,
                ),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), 750);
                }),
            ]);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }
    async getPageDiagnostics() {
        const state = await this.pageState();
        const routes: Record<string, string> = {};
        if (!this.contents.isDestroyed()) {
            const lookups = [
                'soundcloud.com',
                'a-v2.sndcdn.com',
                'style.sndcdn.com',
                'api-v2.soundcloud.com',
                'api-auth.soundcloud.com',
                'cf-hls-media.sndcdn.com',
            ].map(async (host) => {
                routes[host] = 'unavailable';
                try {
                    const value = await this.contents.session.resolveProxy('https://' + host);
                    routes[host] =
                        this.port && value === 'PROXY 127.0.0.1:' + this.port
                            ? 'worker'
                            : value === 'DIRECT'
                              ? 'direct'
                              : 'other-proxy';
                } catch {
                    routes[host] = 'unavailable';
                }
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.all(lookups),
                    new Promise((resolve) => {
                        timer = setTimeout(resolve, 1000);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        }
        return {
            mode: this.store.get('cloudflareMode', 'off'),
            routed: this.routed,
            status: this.status,
            page: {
                ...state,
                httpStatus: this.mainStatus,
                error: this.mainError,
                failures: this.pageFailures.map((item) => ({ ...item })),
            },
            routes: { ...routes },
        };
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
    async configure(refreshPage = false): Promise<void> {
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
            if (refreshPage && wasRouted) this.reloadPage();
            return;
        }
        if (!this.store.get('cloudflareEndpoint') || !this.secret()) {
            this.status = 'Нужны адрес и ключ вашего Cloudflare Worker';
            return;
        }
        const generation = this.generation;
        this.policy = new RecoveryPolicy({
            direct: async () =>
                !this.bootstrapFailed &&
                !(await this.pageState())?.errorPage &&
                this.probe(session.fromPartition('wave-connection-direct')),
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
                await this.contents.session.setProxy({ mode: 'pac_script', pacScript: relayPac(this.port) });
                await this.contents.session.closeAllConnections();
                this.routed = true;
                this.status = 'SoundCloud подключён через Cloudflare';
                this.notify(this.status);
                this.reloadPage();
            },
        });
        if (mode === 'always') {
            const available = await this.testRelay();
            if (generation !== this.generation || this.contents.isDestroyed()) return;
            if (available) {
                await this.contents.session.setProxy({ mode: 'pac_script', pacScript: relayPac(this.port) });
                await this.contents.session.closeAllConnections();
                this.routed = true;
                this.status = 'SoundCloud подключён через Cloudflare';
                if (refreshPage) this.reloadPage();
            } else {
                this.status = this.getTestMessage();
                this.notify(this.status);
            }
        } else {
            this.status = 'Автоматически: сначала обычное подключение';
            this.arm();
            if (refreshPage && this.contents.getURL().startsWith('https://soundcloud.com/')) await this.recover();
        }
    }
    private reloadPage(): void {
        if (this.contents.isDestroyed()) return;
        const current = this.contents.getURL();
        if (!current.startsWith('https://soundcloud.com/')) return;
        void this.contents
            .loadURL('https://soundcloud.com/discover', {
                extraHeaders: 'Pragma: no-cache\r\nCache-Control: no-cache\r\n',
            })
            .catch(() => {});
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
            await probeSession.setProxy({ mode: 'pac_script', pacScript: relayPac(this.port) });
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
        return stages.length === 4 && stages.every((stage) => stage.outcome === 'ok');
    }
}
