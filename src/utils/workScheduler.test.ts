import { describe, expect, it, vi } from 'vitest';
import { WorkScheduler } from './workScheduler';
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
describe('shared background admission', () => {
    it('keeps playback responsive during import saturation and selects queued urgent work first', async () => {
        const scheduler = new WorkScheduler(() => ({ network: 3, page: 2 }));
        const importGate = deferred(),
            urgentGate = deferred();
        const calls: string[] = [];
        const imports = Array.from({ length: 5 }, (_, i) =>
            scheduler.run('network', 'import', async () => {
                calls.push('import-' + i);
                await importGate.promise;
            }),
        );
        const prefetch = scheduler.run('network', 'prefetch', async () => {
            calls.push('prefetch');
            await urgentGate.promise;
        });
        await Promise.resolve();
        expect(calls).toEqual(['import-0', 'import-1', 'prefetch']);
        const playback = scheduler.run('network', 'playback', async () => {
            calls.push('playback');
        });
        urgentGate.resolve();
        await prefetch;
        await playback;
        expect(calls[3]).toBe('playback');
        importGate.resolve();
        await Promise.all(imports);
        scheduler.dispose();
    });
    it('cancels waiting work without consuming capacity or running it later', async () => {
        const scheduler = new WorkScheduler(() => ({ network: 2, page: 2 }));
        const gate = deferred(),
            controller = new AbortController();
        const busy = scheduler.run('page', 'import', () => gate.promise);
        const run = vi.fn(async () => {});
        const queued = scheduler.run('page', 'catalog', run, controller.signal).catch((error) => error);
        controller.abort();
        expect((await queued).name).toBe('AbortError');
        gate.resolve();
        await busy;
        expect(run).not.toHaveBeenCalled();
        scheduler.dispose();
    });
    it('releases slots after errors and rejects queued work on shutdown', async () => {
        const scheduler = new WorkScheduler(() => ({ network: 1, page: 1 }));
        await expect(
            scheduler.run('network', 'playback', async () => {
                throw Error('offline');
            }),
        ).rejects.toThrow('offline');
        const gate = deferred();
        const active = scheduler.run('page', 'import', () => gate.promise);
        const queued = scheduler.run('page', 'playback', async () => {}).catch((error) => error);
        scheduler.dispose();
        expect((await queued).message).toContain('disposed');
        gate.resolve();
        await active;
    });
});
