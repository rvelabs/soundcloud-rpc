import { expect, it, vi } from 'vitest';
import { TaskbarBridge } from './taskbar';
it('updates play, pause and like separately and coalesces ordinary progress', () => {
    const send = vi.fn(async () => {}),
        bridge = new TaskbarBridge(send, () => 'ru-RU');
    const frame = { url: 'https://soundcloud.com/a/b', title: 'Song', isPlaying: true, isLiked: false };
    bridge.observe(frame);
    bridge.observe(frame);
    expect(send).toHaveBeenCalledTimes(1);
    bridge.observe({ ...frame, isLiked: true });
    bridge.observe({ ...frame, isPlaying: false });
    bridge.clear();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith({ available: false, playing: false, liked: false, russian: true });
});
