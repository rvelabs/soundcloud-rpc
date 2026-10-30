import { afterEach, describe, expect, it, vi } from 'vitest';
import { EndedPlaybackRecovery } from './playbackRecovery';
afterEach(() => vi.useRealTimers());
describe('ended playback recovery', () => {
    it('retries a failed transition only while the same audio remains ended', async () => {
        vi.useFakeTimers();
        const advance = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
        const ended = vi.fn(async () => true);
        const failed = vi.fn();
        const recovery = new EndedPlaybackRecovery({ current: () => '/one', ended, advance, failed });
        await recovery.request();
        expect(advance).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(advance).toHaveBeenCalledTimes(2);
        expect(ended).toHaveBeenCalledWith('/one');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('preserves pause, replacement playback and explicit cancellation', async () => {
        vi.useFakeTimers();
        let current = '/one';
        const advance = vi.fn(async () => {
            throw new Error('offline');
        });
        const ended = vi.fn(async () => false);
        const recovery = new EndedPlaybackRecovery({ current: () => current, ended, advance, failed: vi.fn() });
        await recovery.request();
        await vi.advanceTimersByTimeAsync(2000);
        expect(advance).toHaveBeenCalledTimes(1);
        ended.mockResolvedValue(true);
        await recovery.request();
        current = '/two';
        await vi.advanceTimersByTimeAsync(2000);
        expect(advance).toHaveBeenCalledTimes(2);
        await recovery.request();
        recovery.cancel();
        await vi.advanceTimersByTimeAsync(30000);
        expect(advance).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('bounds retry attempts and cancels a pending asynchronous check', async () => {
        vi.useFakeTimers();
        const advance = vi.fn(async () => {
            throw new Error('offline');
        });
        const ended = vi.fn(async () => true);
        const recovery = new EndedPlaybackRecovery({ current: () => '/one', ended, advance, failed: vi.fn() });
        await recovery.request();
        await vi.advanceTimersByTimeAsync(60000);
        expect(advance).toHaveBeenCalledTimes(4);
        expect(vi.getTimerCount()).toBe(0);
        let resolve!: (value: boolean) => void;
        ended.mockImplementationOnce(
            () =>
                new Promise<boolean>((done) => {
                    resolve = done;
                }),
        );
        await recovery.request();
        await vi.advanceTimersByTimeAsync(2000);
        recovery.cancel();
        resolve(true);
        await Promise.resolve();
        expect(advance).toHaveBeenCalledTimes(5);
    });
});
