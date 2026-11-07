import { describe, expect, it, vi } from 'vitest';
import { ListeningBridge } from './listening';

const frame = {
    title: 'Song',
    author: 'Artist',
    url: 'https://soundcloud.com/a/b',
    elapsed: '0:00',
    duration: '3:00',
    isPlaying: true,
};
describe('native listening bridge', () => {
    it('does no work while disabled and coalesces confirmed playback progress', () => {
        let now = 0;
        const send = vi.fn<(track: object | null) => Promise<void>>(async () => {}),
            bridge = new ListeningBridge(send, () => now);
        bridge.observe(frame);
        expect(send).not.toHaveBeenCalled();
        bridge.configure(true);
        expect(send).toHaveBeenCalledTimes(1);
        for (let second = 1; second <= 10; second++) {
            now = second * 1000;
            bridge.observe({ ...frame, elapsed: `0:${String(second).padStart(2, '0')}` });
        }
        expect(send).toHaveBeenCalledTimes(3);
        bridge.configure(false);
        bridge.observe(frame);
        expect(send).toHaveBeenCalledTimes(4);
        expect(send.mock.calls[send.mock.calls.length - 1]).toEqual([null]);
    });
    it('immediately forwards pauses, seeks and track changes, but never invalid time', () => {
        let now = 0;
        const send = vi.fn(async () => {}),
            bridge = new ListeningBridge(send, () => now);
        bridge.configure(true);
        bridge.observe(frame);
        now = 1000;
        bridge.observe({ ...frame, elapsed: '1:20' });
        bridge.observe({ ...frame, elapsed: '1:20', isPlaying: false });
        bridge.observe({ ...frame, url: 'https://soundcloud.com/a/c' });
        bridge.observe({ ...frame, elapsed: 'invalid' });
        expect(send).toHaveBeenCalledTimes(4);
    });
    it('retries failed IPC on the next event without starting a timer', async () => {
        const send = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined);
        const bridge = new ListeningBridge(send, () => 0);
        bridge.configure(true);
        bridge.observe(frame);
        await Promise.resolve();
        bridge.observe(frame);
        expect(send).toHaveBeenCalledTimes(2);
        await bridge.clear();
        expect(send).toHaveBeenLastCalledWith(null);
    });
});
