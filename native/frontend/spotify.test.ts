import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { completeSpotify } from './spotify';
import type { SourcePlaylist } from '../../src/import/source';
const link = 'https://open.spotify.com/playlist/1234567890123456789012';
const initial: SourcePlaylist = {
    platform: 'spotify',
    title: 'Import',
    tracks: [{ artist: 'Artist', title: 'One' }],
    partial: true,
    expectedTracks: 2,
};
const complete: SourcePlaylist = {
    ...initial,
    tracks: [...initial.tracks, { artist: 'Artist', title: 'Two' }],
    partial: false,
};
let call: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    call = vi.fn(async (command: string) => (command === 'profile_load' ? { language: 'en' } : null));
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: call } });
    vi.stubGlobal('navigator', { language: 'ru-RU' });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('never opens Spotify or asks for sign-in when the public list is complete', async () => {
    const ask = vi.fn(() => true);
    expect(await completeSpotify(complete, link, 7, new AbortController().signal, vi.fn(), ask)).toBe(complete);
    expect(call).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
});

it('collects anonymous continuation without showing a sign-in window', async () => {
    const ask = vi.fn(() => true);
    call.mockImplementation(async (command: string) =>
        command === 'profile_load'
            ? { language: 'en' }
            : command === 'spotify_state'
              ? { playlist: complete, closed: false, reachable: true }
              : null,
    );
    const result = await completeSpotify(initial, link, 7, new AbortController().signal, vi.fn(), ask);
    expect(result.tracks).toHaveLength(2);
    expect(ask).not.toHaveBeenCalled();
    expect(call.mock.calls.some(([command]) => command === 'spotify_show')).toBe(false);
    expect(call.mock.calls.some(([command]) => command === 'spotify_close')).toBe(true);
});

it('keeps the partial list when sign-in is declined and explains the reason in the selected language', async () => {
    const ask = vi.fn<(message: string) => boolean>(() => false);
    call.mockImplementation(async (command: string) =>
        command === 'profile_load'
            ? { language: 'en' }
            : command === 'spotify_state'
              ? { playlist: initial, closed: false, reachable: true }
              : null,
    );
    const task = completeSpotify(initial, link, 7, new AbortController().signal, vi.fn(), ask);
    await vi.advanceTimersByTimeAsync(12500);
    expect((await task).tracks).toEqual(initial.tracks);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][0]).toContain('You can decline');
    expect(call.mock.calls.some(([command]) => command === 'spotify_show')).toBe(false);
});

it('shows sign-in only after consent and resumes collecting without navigating SoundCloud', async () => {
    let shown = false;
    const ask = vi.fn(async () => true);
    call.mockImplementation(async (command: string) => {
        if (command === 'profile_load') return { language: 'en' };
        if (command === 'spotify_show') shown = true;
        return command === 'spotify_state'
            ? { playlist: shown ? complete : initial, closed: false, reachable: true }
            : null;
    });
    const task = completeSpotify(initial, link, 7, new AbortController().signal, vi.fn(), ask);
    await vi.advanceTimersByTimeAsync(12500);
    expect((await task).partial).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
    expect(call.mock.calls.filter(([command]) => command === 'spotify_show')).toHaveLength(1);
    expect(
        call.mock.calls.every(([command]) => String(command).startsWith('spotify_') || command === 'profile_load'),
    ).toBe(true);
});

it('closes its own window on cancellation and keeps results when the user closes the window', async () => {
    call.mockImplementation(async (command: string) =>
        command === 'profile_load'
            ? { language: 'en' }
            : command === 'spotify_state'
              ? { playlist: initial, closed: false, reachable: true }
              : null,
    );
    const controller = new AbortController();
    const task = completeSpotify(initial, link, 7, controller.signal, vi.fn(), vi.fn());
    const checked = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await checked;
    const opened = call.mock.calls.find(([command]) => command === 'spotify_open')![1] as { id: string };
    expect(call).toHaveBeenCalledWith('spotify_close', { id: opened.id });
    call.mockImplementation(async (command: string) =>
        command === 'spotify_state' ? { playlist: initial, closed: true, reachable: true } : {},
    );
    expect((await completeSpotify(initial, link, 7, new AbortController().signal, vi.fn(), vi.fn())).tracks).toEqual(
        initial.tracks,
    );
});
