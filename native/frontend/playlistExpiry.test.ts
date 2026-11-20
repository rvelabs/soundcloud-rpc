import { expect, it, vi } from 'vitest';
import { PlaylistExpiry } from './playlistExpiry';

const entry = { id: 7, title: 'Temporary', tracks: [1, 2], deleteAt: 100 };
function setup(entries: unknown = [entry], owner = 42) {
    const data = new Map([['trackPlaylistExpiryV1', entries]]);
    const store = {
        get: (key: string) => data.get(key),
        set: (key: string, value: unknown) => {
            data.set(key, structuredClone(value));
        },
        flush: vi.fn(async () => {}),
    };
    const remove = vi.fn(async (_entry: typeof entry, allowed: () => boolean) => allowed());
    const currentOwner = vi.fn(async () => owner);
    const controller = new PlaylistExpiry(42, store, remove, currentOwner, () => 200);
    return { controller, remove, currentOwner, store, data };
}
it('persists only opt-in expiry records durably and leaves future playlists alone', async () => {
    const { controller, remove, store } = setup([]);
    await controller.schedule({ ...entry, deleteAt: 300 });
    expect(store.flush).toHaveBeenCalledWith(true);
    expect(await controller.sweep()).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    await controller.keep(7);
    expect(await controller.sweep()).toBe(0);
});
it('never deletes another account’s playlists and ignores malformed schedule data', async () => {
    const foreign = setup([entry], 99);
    expect(await foreign.controller.sweep()).toBe(0);
    expect(foreign.remove).not.toHaveBeenCalled();
    const invalid = setup([
        { ...entry, id: -7 },
        { ...entry, tracks: [] },
        { ...entry, deleteAt: NaN },
    ]);
    expect(await invalid.controller.sweep()).toBe(0);
    expect(invalid.remove).not.toHaveBeenCalled();
});
it('serializes overlapping sweeps and forgets edited or already missing playlists', async () => {
    const { controller, remove, data } = setup();
    remove.mockResolvedValue(false);
    const one = controller.sweep(),
        two = controller.sweep();
    expect(one).toBe(two);
    expect(await one).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(data.get('trackPlaylistExpiryV1')).toEqual([]);
});
it('honors Keep while asynchronous verification is pending', async () => {
    const { controller, remove, data } = setup();
    remove.mockImplementation(async (_entry, allowed) => {
        await controller.keep(7);
        return allowed();
    });
    expect(await controller.sweep()).toBe(0);
    expect(data.get('trackPlaylistExpiryV1')).toEqual([]);
});
it('stops when the dialog host is disposed and caps retries for unavailable page models', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { controller, remove, data } = setup();
    expect(await controller.sweep(() => false)).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    remove.mockRejectedValue(Error('model unavailable'));
    for (let i = 0; i < 5; i++) await controller.sweep();
    expect(remove).toHaveBeenCalledTimes(5);
    expect(data.get('trackPlaylistExpiryV1')).toEqual([]);
    log.mockRestore();
});
