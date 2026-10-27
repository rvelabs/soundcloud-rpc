import { describe, expect, it, vi } from 'vitest';
import { PlaybackCoordinator } from './playbackCoordinator';
describe('playback transition ownership', () => {
    it('coalesces overlapping next requests from buttons and media keys', async () => {
        let finish!: () => void;
        const advanceNative = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const select = vi.fn(async () => {});
        const coordinator = new PlaybackCoordinator({
            active: () => true,
            nativeReady: () => true,
            advanceNative,
            select,
        });
        const first = coordinator.request('user');
        const second = coordinator.request('user');
        expect(first).toBe(second);
        await Promise.resolve();
        expect(advanceNative).toHaveBeenCalledTimes(1);
        finish();
        await first;
        expect(select).not.toHaveBeenCalled();
        await coordinator.request('finish');
        expect(advanceNative).toHaveBeenCalledTimes(1);
    });
    it('cancels a stale request before it starts and recovers after a failed transition', async () => {
        const select = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
        const coordinator = new PlaybackCoordinator({
            active: () => true,
            nativeReady: () => false,
            advanceNative: async () => {},
            select,
        });
        const canceled = coordinator.request('user');
        coordinator.invalidate();
        await canceled;
        expect(select).not.toHaveBeenCalled();
        await expect(coordinator.request('finish')).rejects.toThrow('offline');
        await coordinator.request('user');
        expect(select).toHaveBeenCalledTimes(2);
    });
});
