import { api } from './bridge';
import { nativeRuntimeExports } from '../../src/soundcloud/nativeRuntime';
import { playlistRequestError } from './playlistErrors';

const browserCreated = new Map<number, () => Promise<void>>();
export const createdPlaylistIds = () => [...browserCreated.keys()];

export async function createPlaylist(
    title: string,
    tracks: number[],
    request = api,
    exports = nativeRuntimeExports,
    expectedOwner?: number,
): Promise<any> {
    const owner = expectedOwner ?? (await request('me')).id;
    if (!Number.isSafeInteger(owner) || owner <= 0) throw Error('Sign in to SoundCloud first');
    try {
        return await request('createPlaylist', { title, tracks }, true, owner);
    } catch (error) {
        if (!String(error).includes('HTTP 403 (POST /playlists)')) throw error;
    }
    const Model = exports().find(
        (value: any) => value?.prototype?.resource_type === 'playlist' && typeof value.prototype.save === 'function',
    ) as any;
    if (!Model)
        throw playlistRequestError(
            Error('SoundCloud HTTP 403: playlist model is unavailable; open Library and retry'),
            'create',
            'browser',
        );
    if ((await request('me')).id !== owner) throw Error('SoundCloud account changed');
    const model = new Model({ title: title.trim(), sharing: 'private', tracks: tracks.map((id) => ({ id })) });
    model.hold?.();
    try {
        await Promise.resolve(model.save());
        const result = model.toJSON();
        if (!Number.isSafeInteger(result.id) || result.id <= 0)
            throw Error('SoundCloud did not confirm the new playlist');
        browserCreated.set(result.id, async () => {
            if ((await request('me')).id !== owner) throw Error('SoundCloud account changed');
            const cleanup = new Model({ id: result.id });
            cleanup.hold?.();
            try {
                await Promise.resolve(cleanup.destroy());
            } finally {
                cleanup.release?.();
            }
        });
        while (browserCreated.size > 100) browserCreated.delete(browserCreated.keys().next().value!);
        return result;
    } catch (error) {
        throw playlistRequestError(error, 'create', 'browser');
    } finally {
        model.release?.();
    }
}

export async function updatePlaylist(id: number, title: string, tracks: number[], expectedOwner: number): Promise<any> {
    try {
        return await api('updatePlaylist', { id, title, tracks }, true, expectedOwner);
    } catch (error) {
        if (!String(error).includes(`HTTP 403 (PUT /playlists/${id})`)) throw error;
    }
    const Model = nativeRuntimeExports().find(
        (value: any) => value?.prototype?.resource_type === 'playlist' && typeof value.prototype.save === 'function',
    ) as any;
    if (!Model)
        throw playlistRequestError(
            Error('SoundCloud HTTP 403: playlist model is unavailable; open Library and retry'),
            'update',
            'browser',
        );
    if ((await api('me')).id !== expectedOwner) throw Error('SoundCloud account changed');
    const current = await api('playlist', { id });
    if ((current.playlist || current).user?.id !== expectedOwner)
        throw Error('Playlist belongs to another SoundCloud account');
    const model = new Model({ id, title, tracks: tracks.map((id) => ({ id })) });
    model.hold?.();
    try {
        if ((await api('me')).id !== expectedOwner) throw Error('SoundCloud account changed');
        await Promise.resolve(model.save());
        return model.toJSON();
    } catch (error) {
        throw playlistRequestError(error, 'update', 'browser');
    } finally {
        model.release?.();
    }
}

/**
 * Deletes one of the user's playlists through SoundCloud's own page model (direct API writes can be
 * bot-blocked). Refuses unless the signed-in account owns it. Returns false if it no longer exists.
 */
export async function deletePlaylist(
    id: number,
    expectedOwner: number,
    request = api,
    exports = nativeRuntimeExports,
    expected?: { title: string; tracks: number[] },
    canDelete = () => true,
): Promise<boolean> {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(expectedOwner) || expectedOwner <= 0)
        throw Error('Invalid playlist or account ID');
    if ((await request('me')).id !== expectedOwner) throw Error('SoundCloud account changed');
    let current: any;
    try {
        current = await request('playlist', { id });
    } catch (error) {
        if (/HTTP 404/.test(String(error))) return false;
        throw error;
    }
    if ((current.playlist || current).user?.id !== expectedOwner)
        throw Error('Playlist belongs to another SoundCloud account');
    const playlist = current.playlist || current;
    if (
        expected &&
        (playlist.id !== id ||
            playlist.title !== expected.title ||
            playlist.sharing !== 'private' ||
            playlist.track_count !== expected.tracks.length ||
            !Array.isArray(playlist.tracks) ||
            playlist.tracks.length !== expected.tracks.length ||
            playlist.tracks.some((track: any, index: number) => track?.id !== expected.tracks[index]))
    )
        return false;
    const Model = exports().find(
        (value: any) => value?.prototype?.resource_type === 'playlist' && typeof value.prototype.destroy === 'function',
    ) as any;
    if (!Model) throw Error('SoundCloud playlist model is unavailable; open Library and retry');
    const model = new Model({ id });
    model.hold?.();
    try {
        if ((await request('me')).id !== expectedOwner) throw Error('SoundCloud account changed');
        if (!canDelete()) return false;
        await Promise.resolve(model.destroy());
        return true;
    } finally {
        model.release?.();
    }
}

export async function cleanupCreatedPlaylist(id: number): Promise<void> {
    const cleanup = browserCreated.get(id);
    if (cleanup) {
        await cleanup();
        browserCreated.delete(id);
    } else await api('cleanupPlaylist', { id });
}
