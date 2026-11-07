import { it, expect, vi } from 'vitest';
import { createPlaylist, cleanupCreatedPlaylist } from './playlists';

it('uses the native SoundCloud model only after a definite native HTTP 403, and cleans its own creation', async () => {
    const destroyed = vi.fn();
    class Model {
        static prototypeType = 'playlist';
        constructor(private value: any) {}
        async save() {
            expect(this.value.tracks).toEqual([{ id: 7 }, { id: 11 }]);
            this.value.id = 1001;
        }
        toJSON() {
            return this.value;
        }
        async destroy() {
            destroyed(this.value.id);
        }
    }
    Object.assign(Model.prototype, { resource_type: 'playlist' });
    const request: any = vi.fn(async (operation: string) => {
        if (operation === 'me') return { id: 42 };
        throw Error('SoundCloud HTTP 403 (POST /playlists): no API error message');
    });
    const result = await createPlaylist('Import', [7, 11], request, () => [Model]);
    expect(result.id).toBe(1001);
    expect(request.mock.calls.filter(([operation]: [string]) => operation === 'createPlaylist')).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('createPlaylist', { title: 'Import', tracks: [7, 11] }, true, 42);
    await cleanupCreatedPlaylist(1001);
    expect(destroyed).toHaveBeenCalledWith(1001);
});

it('does not repeat an uncertain creation through another transport', async () => {
    const request: any = vi.fn(async (operation: string) => {
        if (operation === 'me') return { id: 42 };
        throw Error('SoundCloud network request failed');
    });
    const exports = vi.fn(() => []);
    await expect(createPlaylist('Import', [7], request, exports)).rejects.toThrow('network request failed');
    expect(exports).not.toHaveBeenCalled();
});
