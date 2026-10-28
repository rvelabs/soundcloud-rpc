import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CancellationToken } from 'builder-util-runtime';
import { UpdateController, updateKind, type UpdateMode } from './updateController';
class Backend extends EventEmitter {
    autoDownload = true;
    autoInstallOnAppQuit = true;
    allowPrerelease = true;
    allowDowngrade = true;
    checks = 0;
    downloads = 0;
    installs = 0;
    info = { version: '0.28.3' };
    check = async () => {
        this.emit('update-available', this.info);
    };
    load: (token?: CancellationToken) => Promise<void> = async () => {};
    constructor() {
        super();
        this.on('error', () => {});
    }
    async checkForUpdates() {
        this.checks++;
        await this.check();
    }
    async downloadUpdate(token?: CancellationToken) {
        this.downloads++;
        await this.load(token);
    }
    quitAndInstall() {
        this.installs++;
    }
}
function fixture(mode: UpdateMode = 'patch', worker = false) {
    const backend = new Backend();
    let pending = 0;
    const changed = vi.fn(),
        notify = vi.fn(),
        beforeInstall = vi.fn();
    const controller = new UpdateController(backend, {
        currentVersion: '0.28.2',
        mode,
        installSupported: true,
        canCheck: true,
        workerRevision: 2,
        usesWorker: () => worker,
        pendingWorker: () => pending,
        setPendingWorker: (value) => {
            pending = value;
        },
        changed,
        notify,
        beforeInstall,
    });
    return { backend, controller, changed, notify, beforeInstall, pending: () => pending };
}
afterEach(() => vi.useRealTimers());
describe('update policy and lifecycle', () => {
    it('keeps unsupported and development builds usable without creating a platform updater', async () => {
        const notify = vi.fn();
        const controller = new UpdateController(undefined, {
            currentVersion: '0.30.0',
            mode: 'patch',
            installSupported: false,
            canCheck: false,
            workerRevision: 4,
            usesWorker: () => false,
            pendingWorker: () => 0,
            setPendingWorker: () => {},
            changed: () => {},
            notify,
            beforeInstall: () => {},
        });
        controller.start();
        controller.setMode('notify');
        expect((await controller.check()).phase).toBe('idle');
        expect((await controller.download()).phase).toBe('idle');
        expect(() => controller.install()).toThrow('not ready');
        expect(notify).not.toHaveBeenCalled();
        controller.systemShutdown();
        controller.dispose();
    });
    it('ignores late automatic-check results after the user switches automatic checks off', async () => {
        const f = fixture();
        let resolve!: () => void;
        f.backend.check = () =>
            new Promise<void>((done) => {
                resolve = () => {
                    f.backend.emit('update-available', f.backend.info);
                    done();
                };
            });
        const checking = f.controller.check(false);
        f.controller.setMode('off');
        resolve();
        await checking;
        expect(f.backend.downloads).toBe(0);
        expect(f.notify).not.toHaveBeenCalled();
        expect(f.controller.snapshot().phase).toBe('idle');
        f.controller.dispose();
    });
    it('only classifies stable forward changes within the same minor series as small', () => {
        expect(updateKind('0.28.2', '0.28.3')).toBe('patch');
        for (const version of ['0.29.0', '1.0.0']) expect(updateKind('0.28.2', version)).toBe('larger');
        for (const version of ['0.28.2', '0.28.1', '0.27.9', '0.28.3-beta.1', 'evil', '9007199254740993.0.0'])
            expect(updateKind('0.28.2', version)).toBeNull();
    });
    it('downloads a patch, reports progress and waits for a normal quit or explicit install', async () => {
        const f = fixture();
        await f.controller.check();
        expect(f.backend.downloads).toBe(1);
        expect(f.backend.installs).toBe(0);
        f.backend.emit('download-progress', { percent: 42.9 });
        expect(f.controller.snapshot().percent).toBe(42);
        f.backend.emit('update-downloaded');
        expect(f.controller.snapshot().phase).toBe('ready');
        expect(f.backend.autoInstallOnAppQuit).toBe(true);
        expect(f.beforeInstall).not.toHaveBeenCalled();
        f.controller.install();
        expect(f.backend.installs).toBe(1);
        expect(f.beforeInstall).toHaveBeenCalledOnce();
        f.controller.dispose();
    });
    it('only notifies for larger releases and requires an explicit install after a manual download', async () => {
        const f = fixture();
        f.backend.info.version = '0.29.0';
        await f.controller.check();
        expect(f.backend.downloads).toBe(0);
        expect(f.controller.snapshot().phase).toBe('available');
        await f.controller.download();
        f.backend.emit('update-downloaded');
        expect(f.backend.autoInstallOnAppQuit).toBe(false);
        expect(f.backend.installs).toBe(0);
        f.controller.dispose();
    });
    it('revalidates a cached patch to arm the quit handler when automatic mode is enabled after downloading', async () => {
        const f = fixture('notify');
        f.backend.load = async () => {
            f.backend.emit('update-downloaded');
        };
        await f.controller.check();
        await f.controller.download();
        expect(f.backend.autoInstallOnAppQuit).toBe(false);
        f.controller.setMode('patch');
        await Promise.resolve();
        await f.controller.download();
        expect(f.backend.downloads).toBe(2);
        expect(f.controller.snapshot().phase).toBe('ready');
        expect(f.backend.autoInstallOnAppQuit).toBe(true);
        expect(f.backend.installs).toBe(0);
        f.controller.dispose();
    });
    it('coalesces concurrent checks and downloads and only notifies once per release stage', async () => {
        const f = fixture('notify');
        let finish!: () => void;
        f.backend.check = () =>
            new Promise<void>((resolve) => {
                finish = () => {
                    f.backend.emit('update-available', f.backend.info);
                    resolve();
                };
            });
        const a = f.controller.check(),
            b = f.controller.check();
        expect(a).toBe(b);
        finish();
        await a;
        f.backend.emit('update-available', f.backend.info);
        expect(f.notify).toHaveBeenCalledOnce();
        let complete!: () => void;
        f.backend.load = () =>
            new Promise<void>((resolve) => {
                complete = resolve;
            });
        const c = f.controller.download(),
            d = f.controller.download();
        expect(c).toBe(d);
        expect(f.backend.downloads).toBe(1);
        complete();
        await c;
        f.controller.dispose();
    });
    it('honors off and notify modes and disposes periodic work without leaking handlers', async () => {
        vi.useFakeTimers();
        const f = fixture('off');
        f.controller.start();
        await vi.advanceTimersByTimeAsync(30000);
        expect(f.backend.checks).toBe(0);
        await f.controller.check();
        expect(f.backend.downloads).toBe(0);
        f.controller.setMode('notify');
        f.controller.start();
        await vi.advanceTimersByTimeAsync(20000);
        expect(f.backend.checks).toBe(2);
        f.controller.setMode('off');
        await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
        expect(f.backend.checks).toBe(2);
        f.controller.dispose();
        expect(vi.getTimerCount()).toBe(0);
        expect(f.backend.listenerCount('update-available')).toBe(0);
        expect(f.backend.listenerCount('error')).toBe(1);
    });
    it('cancels an automatic download when automatic installation is disabled', async () => {
        const f = fixture();
        f.backend.load = (token) => token!.createPromise<void>(() => {});
        await f.controller.check();
        expect(f.controller.snapshot().phase).toBe('downloading');
        const cancelledDownload = f.controller.download();
        f.controller.setMode('off');
        await cancelledDownload;
        expect(f.backend.autoInstallOnAppQuit).toBe(false);
        expect(f.controller.snapshot().phase).toBe('available');
        f.controller.dispose();
    });
    it('never auto-installs during Windows shutdown and rejects install before verification completes', async () => {
        const f = fixture();
        expect(() => f.controller.install()).toThrow();
        await f.controller.check();
        f.controller.systemShutdown();
        f.backend.emit('update-downloaded');
        expect(f.backend.autoInstallOnAppQuit).toBe(false);
        expect(f.backend.installs).toBe(0);
        f.controller.dispose();
    });
    it('keeps Worker deployment changes manual and persists the notice until acknowledged', async () => {
        const f = fixture('patch', true);
        f.backend.info = { version: '0.28.3', workerProtocolRevision: 3 } as typeof f.backend.info;
        await f.controller.check();
        expect(f.pending()).toBe(3);
        expect(f.backend.downloads).toBe(0);
        expect(f.controller.snapshot()).toMatchObject({ kind: 'larger', workerNotice: true });
        f.controller.acknowledgeWorker();
        expect(f.pending()).toBe(0);
        expect(f.controller.snapshot().workerNotice).toBe(false);
        f.controller.dispose();
    });
    it('contains check and download failures without invoking installation', async () => {
        const f = fixture('notify');
        f.backend.check = async () => {
            throw new Error('offline');
        };
        await f.controller.check();
        expect(f.controller.snapshot().phase).toBe('error');
        f.backend.check = async () => {
            f.backend.emit('update-available', f.backend.info);
        };
        await f.controller.check();
        f.backend.load = async () => {
            f.backend.emit('error', new Error('checksum mismatch'));
            throw new Error('checksum mismatch');
        };
        await f.controller.download();
        expect(f.controller.snapshot().phase).toBe('error');
        expect(() => f.controller.install()).toThrow();
        expect(f.backend.installs).toBe(0);
        f.controller.dispose();
    });
});
