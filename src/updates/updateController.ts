import { EventEmitter } from 'node:events';
import { CancellationToken, type UpdateInfo } from 'builder-util-runtime';
export type UpdateMode = 'patch' | 'notify' | 'off';
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
export interface UpdateState {
    phase: UpdatePhase;
    currentVersion: string;
    version?: string;
    kind?: 'patch' | 'larger';
    percent?: number;
    mode: UpdateMode;
    installSupported: boolean;
    workerNotice: boolean;
}
export interface UpdateBackend extends EventEmitter {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowPrerelease: boolean;
    allowDowngrade: boolean;
    checkForUpdates(): Promise<unknown>;
    downloadUpdate(token?: CancellationToken): Promise<unknown>;
    quitAndInstall(silent?: boolean, runAfter?: boolean): void;
}
const versionParts = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number);
export function updateKind(current: string, next: string): 'patch' | 'larger' | null {
    const a = versionParts(current),
        b = versionParts(next);
    if (!a || !b || [...a, ...b].some((value) => !Number.isSafeInteger(value))) return null;
    const difference = b.findIndex((value, index) => value !== a[index]);
    if (difference < 0 || b[difference] < a[difference]) return null;
    return difference === 2 ? 'patch' : 'larger';
}
export class UpdateController {
    private state: UpdateState;
    private checkTask?: Promise<UpdateState>;
    private downloadTask?: Promise<UpdateState>;
    private cancel?: CancellationToken;
    private startTimer?: ReturnType<typeof setTimeout>;
    private interval?: ReturnType<typeof setInterval>;
    private disposed = false;
    private systemEnding = false;
    private ignoreCheck = false;
    private manualCheck = false;
    private notified = new Set<string>();
    private listeners: [string, (...args: unknown[]) => void][] = [];
    constructor(
        private backend: UpdateBackend,
        private options: {
            currentVersion: string;
            mode: UpdateMode;
            installSupported: boolean;
            canCheck: boolean;
            workerRevision: number;
            usesWorker: () => boolean;
            pendingWorker: () => number;
            setPendingWorker: (revision: number) => void;
            changed: (state: UpdateState) => void;
            notify: (state: UpdateState) => void;
            beforeInstall: () => void;
        },
    ) {
        this.state = {
            phase: 'idle',
            currentVersion: options.currentVersion,
            mode: options.mode,
            installSupported: options.installSupported,
            workerNotice: options.pendingWorker() > 0,
        };
        backend.autoDownload = false;
        backend.autoInstallOnAppQuit = false;
        backend.allowPrerelease = false;
        backend.allowDowngrade = false;
        this.listen('update-available', (info: UpdateInfo) => {
            if (this.disposed || this.ignoreCheck) return;
            if (!info || typeof info.version !== 'string') {
                this.publish({ phase: 'error' });
                return;
            }
            let kind = updateKind(options.currentVersion, info.version);
            if (!kind) {
                this.publish({ phase: 'current' });
                return;
            }
            const revision = (info as UpdateInfo & { workerProtocolRevision?: unknown }).workerProtocolRevision;
            if (
                options.usesWorker() &&
                typeof revision === 'number' &&
                Number.isSafeInteger(revision) &&
                revision > options.workerRevision
            ) {
                kind = 'larger';
                options.setPendingWorker(revision);
            }
            this.publish({
                phase: 'available',
                version: info.version,
                kind,
                percent: undefined,
                workerNotice: options.pendingWorker() > 0,
            });
            this.notifyOnce('available');
            if (!this.systemEnding && this.state.mode === 'patch' && kind === 'patch' && options.installSupported)
                void this.download();
        });
        this.listen('update-not-available', () => {
            if (this.ignoreCheck) return;
            if (!this.downloadTask && this.state.phase !== 'ready') this.publish({ phase: 'current' });
        });
        this.listen('download-progress', (progress: { percent: number }) => {
            if (!progress || this.state.phase !== 'downloading' || !Number.isFinite(progress.percent)) return;
            const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
            if (percent !== this.state.percent) this.publish({ percent });
        });
        this.listen('update-downloaded', () => {
            if (this.disposed) return;
            this.backend.autoInstallOnAppQuit = this.autoInstall();
            this.publish({ phase: 'ready', percent: 100 });
            this.notifyOnce('ready');
        });
        this.listen('error', () => {
            if (!this.disposed && !this.ignoreCheck && !this.cancel?.cancelled) this.publish({ phase: 'error' });
        });
    }
    private listen<T extends unknown[]>(event: string, listener: (...args: T) => void): void {
        const callback = (...args: unknown[]) => listener(...(args as T));
        this.backend.on(event, callback);
        this.listeners.push([event, callback]);
    }
    private publish(change: Partial<UpdateState>): void {
        if (this.disposed) return;
        this.state = { ...this.state, ...change };
        this.options.changed(this.snapshot());
    }
    private notifyOnce(phase: string): void {
        const key = this.state.version + ':' + phase;
        if (this.notified.has(key)) return;
        this.notified.add(key);
        if (this.notified.size > 40) this.notified.delete(this.notified.values().next().value!);
        this.options.notify(this.snapshot());
    }
    private autoInstall(): boolean {
        return !this.systemEnding && this.state.mode === 'patch' && this.state.kind === 'patch';
    }
    snapshot(): UpdateState {
        return { ...this.state };
    }
    start(): void {
        if (this.disposed || this.startTimer || this.interval || !this.options.canCheck || this.state.mode === 'off')
            return;
        this.startTimer = setTimeout(() => {
            this.startTimer = undefined;
            void this.check(false);
        }, 20000);
        this.interval = setInterval(
            () => {
                void this.check(false);
            },
            6 * 60 * 60 * 1000,
        );
        this.startTimer.unref?.();
        this.interval.unref?.();
    }
    setMode(mode: unknown): UpdateState {
        if (mode !== 'off' && mode !== 'notify' && mode !== 'patch') throw new Error('Invalid update mode');
        const rearm =
            mode === 'patch' &&
            this.state.phase === 'ready' &&
            this.state.kind === 'patch' &&
            !this.backend.autoInstallOnAppQuit;
        clearTimeout(this.startTimer);
        clearInterval(this.interval);
        this.startTimer = undefined;
        this.interval = undefined;
        this.ignoreCheck = mode === 'off' && Boolean(this.checkTask) && !this.manualCheck;
        this.publish({
            mode,
            ...(this.ignoreCheck && this.state.phase === 'checking' ? { phase: 'idle' as const } : {}),
        });
        this.backend.autoInstallOnAppQuit = !rearm && this.autoInstall();
        if (mode !== 'patch') this.cancel?.cancel();
        this.start();
        if (rearm) {
            this.publish({ phase: 'available', percent: undefined });
            void Promise.resolve(this.downloadTask).then(() => {
                if (!this.disposed && this.state.mode === 'patch' && this.state.phase === 'available')
                    void this.download();
            });
            return this.snapshot();
        }
        if (
            mode === 'patch' &&
            this.state.phase === 'available' &&
            this.state.kind === 'patch' &&
            this.options.installSupported
        )
            void this.download();
        return this.snapshot();
    }
    check(manual = true): Promise<UpdateState> {
        if (this.checkTask) {
            if (manual) {
                this.ignoreCheck = false;
                this.manualCheck = true;
            }
            return this.checkTask;
        }
        if (
            this.disposed ||
            !this.options.canCheck ||
            (!manual && this.state.mode === 'off') ||
            this.downloadTask ||
            this.state.phase === 'ready'
        )
            return Promise.resolve(this.snapshot());
        this.ignoreCheck = false;
        this.manualCheck = manual;
        this.publish({ phase: 'checking' });
        const task = (async () => {
            try {
                await this.backend.checkForUpdates();
            } catch {
                if (!this.ignoreCheck) this.publish({ phase: 'error' });
            }
            return this.snapshot();
        })();
        this.checkTask = task;
        void task
            .finally(() => {
                if (this.checkTask === task) this.checkTask = undefined;
            })
            .catch(() => {});
        return task;
    }
    download(): Promise<UpdateState> {
        if (this.downloadTask) return this.downloadTask;
        if (
            this.disposed ||
            !this.options.installSupported ||
            !this.state.version ||
            !['available', 'error'].includes(this.state.phase)
        )
            return Promise.resolve(this.snapshot());
        const token = new CancellationToken();
        this.cancel = token;
        this.publish({ phase: 'downloading', percent: 0 });
        const task = (async () => {
            try {
                await this.backend.downloadUpdate(token);
            } catch {
                this.publish({ phase: token.cancelled ? 'available' : 'error', percent: undefined });
            } finally {
                if (this.cancel === token) this.cancel = undefined;
            }
            return this.snapshot();
        })();
        this.downloadTask = task;
        void task
            .finally(() => {
                if (this.downloadTask === task) this.downloadTask = undefined;
            })
            .catch(() => {});
        return task;
    }
    install(): void {
        if (this.disposed || !this.options.installSupported || this.state.phase !== 'ready')
            throw new Error('Update is not ready');
        this.options.beforeInstall();
        this.backend.quitAndInstall(true, true);
    }
    acknowledgeWorker(): UpdateState {
        this.options.setPendingWorker(0);
        this.publish({ workerNotice: false });
        return this.snapshot();
    }
    systemShutdown(): void {
        this.systemEnding = true;
        this.backend.autoInstallOnAppQuit = false;
    }
    dispose(): void {
        this.disposed = true;
        clearTimeout(this.startTimer);
        clearInterval(this.interval);
        this.cancel?.cancel();
        for (const [event, listener] of this.listeners) this.backend.removeListener(event, listener);
        this.listeners = [];
    }
}
