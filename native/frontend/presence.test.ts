import { describe, it, expect, vi } from 'vitest';
import { PresenceBridge } from './presence';
describe('native presence event bridge', () => {
    it('coalesces regular progress and updates seeks, pauses and track changes', () => {
        let now = 100000;
        const send = vi.fn(async () => {});
        const bridge = new PresenceBridge(send, () => now);
        const track = {
            title: 'Track',
            author: 'Artist',
            url: 'https://soundcloud.com/a/b',
            isPlaying: true,
            elapsed: '0:10',
            duration: '3:00',
        };
        bridge.observe(track);
        now += 5000;
        bridge.observe({ ...track, elapsed: '0:15' });
        expect(send).toHaveBeenCalledTimes(1);
        bridge.observe({ ...track, elapsed: '1:00' });
        bridge.observe({ ...track, elapsed: '1:00', isPlaying: false });
        bridge.observe({ ...track, title: 'Next', url: 'https://soundcloud.com/a/c' });
        expect(send).toHaveBeenCalledTimes(4);
    });
});
