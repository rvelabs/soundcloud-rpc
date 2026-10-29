import { describe, expect, it, vi } from 'vitest';
import { PlaybackCoordinator } from './playbackCoordinator';
describe('playback transition ownership', () => {
    it('coalesces overlapping next requests from buttons and media keys', async () => {
        let finish!: (value: boolean) => void;
        const advanceNative = vi.fn(
            () =>
                new Promise<boolean>((resolve) => {
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
        finish(true);
        await first;
        expect(select).not.toHaveBeenCalled();
        advanceNative.mockResolvedValue(true);
        await coordinator.request('finish');
        expect(advanceNative).toHaveBeenCalledTimes(2);
        expect(advanceNative).toHaveBeenLastCalledWith('finish');
    });
    it('cancels a stale request before it starts and recovers after a failed transition', async () => {
        const select = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
        const coordinator = new PlaybackCoordinator({
            active: () => true,
            nativeReady: () => false,
            advanceNative: async () => false,
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
    it('falls back when a supposedly ready native queue does not advance', async () => {
        const select = vi.fn(async () => {});
        const advanceNative = vi.fn(async () => false);
        const coordinator = new PlaybackCoordinator({
            active: () => true,
            nativeReady: () => true,
            advanceNative,
            select,
        });
        await coordinator.request('finish');
        expect(advanceNative).toHaveBeenCalledWith('finish');
        expect(select).toHaveBeenCalledWith('finish');
        await coordinator.request('native-user');
        expect(select).toHaveBeenLastCalledWith('user');
        await coordinator.request('error');
        expect(advanceNative).toHaveBeenLastCalledWith('error');
        expect(select).toHaveBeenLastCalledWith('error');
    });
});
