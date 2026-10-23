import { afterEach, describe, expect, it, vi } from 'vitest';
import { automaticImportConcurrency, cancelImportOperation, importConcurrency, mapImportTracks } from './parallel';
afterEach(() => vi.useRealTimers());
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
describe('parallel playlist matching', () => {
    it('cancels an Electron operation even when a closed page never settles its promise', async () => {
        const controller = new AbortController();
        const pending = new Promise<void>(() => {});
        const result = cancelImportOperation(pending, controller.signal).catch((error) => error);
        controller.abort();
        expect((await result).name).toBe('AbortError');
    });
    it.each([2, 3, 4, 5, 6, 7, 8, 9, 10])(
        'matches 320 tracks with %i isolated slots and preserves source order',
        async (concurrency) => {
            vi.useFakeTimers();
            const tracks = Array.from({ length: 320 }, (_, index) => index);
            const busy = new Set<number>();
            const progress: number[] = [],
                completedIndexes: number[] = [];
            let maximum = 0;
            const task = mapImportTracks(tracks, {
                concurrency,
                run: async (track, index, slot) => {
                    expect(busy.has(slot)).toBe(false);
                    busy.add(slot);
                    maximum = Math.max(maximum, busy.size);
                    await wait(1 + ((319 - index) % 17));
                    busy.delete(slot);
                    return { source: track, match: `track-${track}` };
                },
                onComplete: (_match, index, completed) => {
                    progress.push(completed);
                    completedIndexes.push(index);
                },
            });
            await vi.runAllTimersAsync();
            const result = await task;
            expect(maximum).toBe(concurrency);
            expect(busy.size).toBe(0);
            expect(result.map((item) => item.source)).toEqual(tracks);
            expect(result.map((item) => item.match)).toEqual(tracks.map((index) => `track-${index}`));
            expect(progress).toEqual(tracks.map((index) => index + 1));
            expect(completedIndexes).not.toEqual(tracks);
        },
    );
    it('stops scheduling after cancellation and waits for active jobs to leave their slots', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let started = 0,
            active = 0,
            published = 0;
        const task = mapImportTracks(Array.from({ length: 320 }), {
            concurrency: 6,
            signal: controller.signal,
            run: async () => {
                started++;
                active++;
                await wait(20);
                active--;
                return 'match';
            },
            onComplete: () => {
                published++;
            },
        });
        const outcome = task.catch((error) => error);
        controller.abort();
        await vi.runAllTimersAsync();
        expect((await outcome).name).toBe('AbortError');
        expect(started).toBe(6);
        expect(active).toBe(0);
        expect(published).toBe(0);
    });
    it('drains other active slots before rejecting an unexpected worker failure', async () => {
        vi.useFakeTimers();
        let active = 0,
            started = 0;
        const task = mapImportTracks(Array.from({ length: 20 }), {
            concurrency: 4,
            run: async (_item, index) => {
                started++;
                active++;
                try {
                    await wait(index === 0 ? 1 : 30);
                    if (index === 0) throw new Error('Renderer gone');
                    return index;
                } finally {
                    active--;
                }
            },
        });
        const outcome = task.catch((error) => error);
        await vi.runAllTimersAsync();
        expect((await outcome).message).toBe('Renderer gone');
        expect(active).toBe(0);
        expect(started).toBe(4);
    });
    it('does not create jobs for an empty playlist and limits untrusted parallelism', async () => {
        const run = vi.fn();
        expect(await mapImportTracks([], { concurrency: 6, run })).toEqual([]);
        expect(run).not.toHaveBeenCalled();
        expect(importConcurrency(10000)).toBe(10);
        expect(importConcurrency(-1)).toBe(2);
        expect(importConcurrency(3.9)).toBe(3);
        expect(importConcurrency(NaN)).toBe(6);
        expect(importConcurrency('6')).toBe(6);
    });
});
describe('automatic resource budget', () => {
    it('adapts to CPU, available memory and track count', () => {
        expect(automaticImportConcurrency(8, 8 * 1024 ** 3, 414)).toBe(10);
        expect(automaticImportConcurrency(2, 8 * 1024 ** 3, 414)).toBe(3);
        expect(automaticImportConcurrency(16, 1 * 1024 ** 3, 414)).toBe(2);
        expect(automaticImportConcurrency(16, 8 * 1024 ** 3, 1)).toBe(1);
    });
});
