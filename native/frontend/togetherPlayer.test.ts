import { expect, it, vi } from 'vitest';
import { TogetherPlayer, type TogetherBackend, type LocalPlayback, type RemotePlayback } from './togetherPlayer';
const remote = (extra: Partial<RemotePlayback> = {}): RemotePlayback => ({
    trackUrl: 'https://soundcloud.com/a/b',
    title: 'Song',
    author: 'Artist',
    positionMs: 20000,
    durationMs: 180000,
    playing: true,
    ...extra,
});
function setup() {
    let current: LocalPlayback | undefined,
        autoplay = true,
        generation = 0;
    const backend: TogetherBackend = {
        current: () => current,
        load: vi.fn(async (url) => {
            current = { url, positionMs: 0, durationMs: 180000, playing: true, ad: false };
            return true;
        }),
        cancel: vi.fn(() => {
            generation++;
        }),
        seek: vi.fn((positionMs) => {
            if (current) current.positionMs = positionMs;
            return true;
        }),
        playing: vi.fn((value) => {
            if (current) current.playing = value;
            return true;
        }),
        autoplay: vi.fn((value) => {
            const old = autoplay;
            autoplay = value;
            return old;
        }),
    };
    const suspend = vi.fn(async () => {});
    let now = 100000;
    const player = new TogetherPlayer(backend, suspend, () => now);
    return {
        backend,
        player,
        suspend,
        current: () => current,
        set: (value: LocalPlayback) => {
            current = value;
        },
        autoplay: () => autoplay,
        epoch: () => generation,
        time: (value: number) => {
            now = value;
        },
    };
}
it('loads the host track, seeks to the current position and disables local autoplay after stopping My Wave', async () => {
    const s = setup();
    await s.player.update(remote());
    expect(s.suspend).toHaveBeenCalledTimes(1);
    expect(s.current()).toMatchObject({ url: remote().trackUrl, positionMs: 20000, playing: true });
    expect(s.autoplay()).toBe(false);
    await s.player.update(remote({ positionMs: 20500 }));
    expect(s.backend.load).toHaveBeenCalledTimes(1);
    expect(s.backend.seek).toHaveBeenCalledTimes(1);
    await s.player.update(remote({ positionMs: 21000, playing: false }));
    expect(s.current()?.playing).toBe(false);
    s.player.leave();
    expect(s.autoplay()).toBe(true);
});
it('cancels obsolete preparation when the host changes tracks during a load', async () => {
    const s = setup();
    let release: (value: boolean) => void = () => {};
    let started = false;
    vi.mocked(s.backend.load).mockImplementationOnce(() => {
        started = true;
        return new Promise((resolve) => {
            release = resolve;
        });
    });
    const pending = s.player.update(remote());
    while (!started) await Promise.resolve();
    await s.player.update(remote({ trackUrl: 'https://soundcloud.com/a/next' }));
    release(false);
    await pending;
    expect(s.current()?.url).toBe('https://soundcloud.com/a/next');
    expect(s.backend.cancel).toHaveBeenCalled();
});
it('preserves manual exit and never resumes from an old asynchronous load', async () => {
    const s = setup();
    let release: (value: boolean) => void = () => {};
    let started = false;
    vi.mocked(s.backend.load).mockImplementationOnce(() => {
        started = true;
        return new Promise((resolve) => {
            release = resolve;
        });
    });
    const pending = s.player.update(remote());
    while (!started) await Promise.resolve();
    s.player.leave();
    release(true);
    await pending;
    expect(s.backend.seek).not.toHaveBeenCalled();
    expect(s.backend.playing).not.toHaveBeenCalledWith(true);
    expect(s.autoplay()).toBe(true);
});
it('freezes playback while waiting for the host and stops unsynchronized audio', async () => {
    const s = setup();
    await s.player.update(remote());
    await s.player.update(null);
    expect(s.current()?.playing).toBe(false);
    vi.mocked(s.backend.seek).mockReturnValue(false);
    await s.player.update(remote({ positionMs: 80000 }));
    expect(s.player.error).toBe('sync-unavailable');
    expect(s.current()?.playing).toBe(false);
});
it('does not repeatedly resolve an unavailable regional track and accepts the next host track immediately', async () => {
    const s = setup();
    vi.mocked(s.backend.load).mockResolvedValueOnce(false);
    await s.player.update(remote());
    await s.player.update(remote({ positionMs: 30000 }));
    expect(s.backend.load).toHaveBeenCalledTimes(1);
    await s.player.update(remote({ trackUrl: 'https://soundcloud.com/a/next' }));
    expect(s.backend.load).toHaveBeenCalledTimes(2);
    expect(s.current()?.url).toContain('/next');
});
it('never seeks or starts an advertisement while waiting for the music player', async () => {
    const s = setup();
    s.set({ url: remote().trackUrl, positionMs: 0, durationMs: 180000, playing: true, ad: true });
    await s.player.update(remote());
    expect(s.player.error).toBe('ad');
    expect(s.backend.load).not.toHaveBeenCalled();
    expect(s.backend.seek).not.toHaveBeenCalled();
});
