import { it, expect, vi } from 'vitest';
import { createPlaylist, cleanupCreatedPlaylist, deletePlaylist } from './playlists';
import { PlaylistRequestError, playlistRequestError } from './playlistErrors';

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

it('preserves a definite browser rejection and its server reason without exposing challenge URLs', async () => {
    const release = vi.fn();
    class Model {
        async save() {
            throw {
                status: 403,
                responseJSON: {
                    errors: [{ error_message: 'CAPTCHA required https://challenge.example/?token=private' }],
                },
            };
        }
        release = release;
    }
    Object.assign(Model.prototype, { resource_type: 'playlist' });
    const request: any = vi.fn(async (operation: string) => {
        if (operation === 'me') return { id: 42 };
        throw Error('SoundCloud HTTP 403 (POST /playlists): no API error message');
    });
    const error = await createPlaylist('Import', [7], request, () => [Model]).catch((error) => error);
    expect(error).toBeInstanceOf(PlaylistRequestError);
    expect(error).toMatchObject({ status: 403, action: 'create', transport: 'browser', definite: true });
    expect(error.message).toContain('CAPTCHA required');
    expect(error.message).not.toContain('private');
    expect(release).toHaveBeenCalledTimes(1);
});

it('keeps missing responses and timeouts uncertain, and never confuses HTTP 4030 with 403', () => {
    expect(playlistRequestError({ status: 0 }, 'create', 'browser').definite).toBe(false);
    expect(playlistRequestError({ status: 408 }, 'create', 'browser').definite).toBe(false);
    expect(playlistRequestError(Error('HTTP 4030'), 'create', 'browser').status).toBe(0);
    expect(
        playlistRequestError({ status: 403, responseText: '<html>challenge</html>' }, 'create', 'browser').status,
    ).toBe(403);
    const error = playlistRequestError(
        { status: 403, responseJSON: { message: 'Bearer private authorization=secret' } },
        'create',
        'browser',
    );
    expect(error.detail).not.toContain('private');
    expect(error.detail).not.toContain('secret');
});

it('deletes an owned playlist through the page model and refuses foreign or missing ones', async () => {
    const destroyed = vi.fn();
    class Model {
        constructor(private value: any) {}
        async destroy() {
            destroyed(this.value.id);
        }
    }
    Object.assign(Model.prototype, { resource_type: 'playlist' });
    const request: any = vi.fn(async (operation: string, fields: any) => {
        if (operation === 'me') return { id: 42 };
        if (fields?.id === 1) return { id: 1, user: { id: 42 } };
        if (fields?.id === 2) return { playlist: { id: 2, user: { id: 7 } } };
        throw Error('SoundCloud HTTP 404 (GET /playlists/3)');
    });
    expect(await deletePlaylist(1, 42, request, () => [Model])).toBe(true);
    expect(destroyed).toHaveBeenCalledWith(1);
    await expect(deletePlaylist(2, 42, request, () => [Model])).rejects.toThrow('another SoundCloud account');
    expect(await deletePlaylist(3, 42, request, () => [Model])).toBe(false);
    await expect(deletePlaylist(1, 99, request, () => [Model])).rejects.toThrow('account changed');
    expect(destroyed).toHaveBeenCalledTimes(1);
});

it('keeps expired playlists that were renamed, edited, made public, or kept during verification', async () => {
    const destroy = vi.fn(),
        release = vi.fn();
    class Model {
        destroy = destroy;
        release = release;
    }
    Object.assign(Model.prototype, { resource_type: 'playlist', destroy });
    const original = {
        id: 7,
        title: 'Mix',
        user: { id: 42 },
        sharing: 'private',
        track_count: 2,
        tracks: [{ id: 1 }, { id: 2 }],
    };
    const expected = { title: 'Mix', tracks: [1, 2] };
    for (const change of [
        { title: 'Kept' },
        { tracks: [{ id: 2 }, { id: 1 }] },
        { sharing: 'public' },
        { track_count: 3 },
    ]) {
        const request: any = async (operation: string) =>
            operation === 'me' ? { id: 42 } : { ...original, ...change };
        expect(await deletePlaylist(7, 42, request, () => [Model], expected)).toBe(false);
    }
    const request: any = async (operation: string) => (operation === 'me' ? { id: 42 } : original);
    expect(
        await deletePlaylist(
            7,
            42,
            request,
            () => [Model],
            expected,
            () => false,
        ),
    ).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(await deletePlaylist(7, 42, request, () => [Model], expected)).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
});

it('rechecks the account immediately before deleting and rejects invalid ids without network calls', async () => {
    const destroy = vi.fn(),
        release = vi.fn();
    class Model {
        destroy = destroy;
        release = release;
    }
    Object.assign(Model.prototype, { resource_type: 'playlist', destroy });
    let count = 0;
    const request: any = vi.fn(async (operation: string) =>
        operation === 'me' ? { id: ++count === 1 ? 42 : 99 } : { user: { id: 42 } },
    );
    await expect(deletePlaylist(7, 42, request, () => [Model])).rejects.toThrow('account changed');
    expect(destroy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    request.mockClear();
    await expect(deletePlaylist(-1, 42, request, () => [Model])).rejects.toThrow('Invalid');
    expect(request).not.toHaveBeenCalled();
});
