import { expect, it, vi } from 'vitest';
import { selectTrackPlaylist } from './playlistSelection';
import { candidate } from './tracks';
import { toTrack } from '../../src/wave/recommendation/soundcloudAdapter';
import type { DataStore } from '../../src/storage/asyncDataStore';
import { AudioAnalysisCache } from '../../src/wave/audioAnalysisCache';

function raw(id: number, extra: any = {}) {
    return {
        id,
        title: `Song ${id}`,
        permalink_url: `https://soundcloud.com/artist-${id}/song-${id}`,
        user: { id: id + 1000, username: `Artist ${id}` },
        genre: 'jungle',
        tag_list: 'jungle breakbeat',
        duration: 180000,
        state: 'finished',
        streamable: true,
        policy: 'ALLOW',
        media: { transcodings: [{ format: { protocol: 'hls' } }] },
        ...extra,
    };
}
const seed = raw(1);
function setup(
    extras: {
        feedback?: any[];
        excluded?: string[];
        related?: any[];
        likes?: any[];
        station?: any[];
        search?: any[];
    } = {},
) {
    const values: Record<string, unknown> = {
        waveFeedbackV1_42: extras.feedback || [],
        waveExcludedArtistsV1_42: extras.excluded || [],
    };
    const store: DataStore = { get: (key, fallback) => values[key] ?? fallback, set: vi.fn() };
    const request = vi.fn(async (operation: string, fields: any) => {
        if (operation === 'me') return { id: 42 };
        if (operation === 'resolve') return seed;
        if (operation === 'related') return { collection: fields.offset ? [] : extras.related || [raw(2), raw(3)] };
        if (operation === 'radio') return { collection: extras.station || [], next_href: null };
        if (operation === 'search') return { collection: extras.search || [] };
        if (operation === 'likes') return { collection: (extras.likes || []).map((track) => ({ track })) };
        if (operation === 'tracks') return fields.ids.map((id: number) => raw(id));
        throw Error('Unexpected operation: ' + operation);
    });
    return { request, store, dependencies: { request: request as any, loadProfile: async () => store } };
}
it('prepares a private-playlist preview without writing preferences, changing queues or calling Claude', async () => {
    const { dependencies, request, store } = setup();
    const result = await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies);
    expect(result).toMatchObject({ owner: 42, requested: 10, title: 'Mix · Song 1' });
    expect(result.tracks.map((track) => track.apiId).sort()).toEqual([2, 3]);
    expect(result.warnings.join(' ')).toContain('Fewer');
    expect(store.set).not.toHaveBeenCalled();
    expect(
        request.mock.calls.every(([operation]) => !/create|update|delete|cleanup|claude|ai_playlist/i.test(operation)),
    ).toBe(true);
    expect(
        request.mock.calls
            .filter(([operation]) => operation !== 'me')
            .every((call) => (call as any)[2] === true && (call as any)[3] === 42),
    ).toBe(true);
});
it('uses restricted seed metadata as a reference while keeping unavailable result tracks out', async () => {
    for (const restriction of [
        { policy: 'BLOCK', streamable: false },
        { policy: 'SNIP' },
        { media: { transcodings: [{ format: { protocol: 'encrypted_hls' } }] } },
    ]) {
        const { dependencies, request } = setup({ related: [raw(2), raw(3, { policy: 'BLOCK' })] });
        const base = request.getMockImplementation()!;
        request.mockImplementation(async (operation, fields) =>
            operation === 'resolve' ? { ...seed, ...restriction } : base(operation, fields),
        );
        const result = await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies);
        expect(result.tracks.map((track) => track.apiId)).toEqual([2]);
        expect(request.mock.calls.some(([operation]) => operation === 'related')).toBe(true);
    }
});
it('keeps the seed fixed, refuses other styles, and applies exclusions and explicit dislikes', async () => {
    const related = [raw(2), raw(3), raw(4), raw(5, { genre: 'Ambient', tag_list: 'drone ambient' }), raw(6)];
    const feedback = [{ at: Date.now(), kind: 'dislike', track: toTrack(candidate(raw(3))!) }];
    const { dependencies, request } = setup({
        related,
        excluded: ['Artist 4'],
        feedback,
        search: [raw(7, { genre: 'Classical', tag_list: 'piano' })],
    });
    const result = await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies);
    expect(result.tracks.map((track) => track.apiId).sort()).toEqual([2, 6]);
    expect(
        request.mock.calls.filter(([operation]) => operation === 'related').every(([, fields]) => fields.id === 1),
    ).toBe(true);
});
it('uses matching likes when requested but never saves an unrelated liked genre to fill the count', async () => {
    const { dependencies } = setup({
        related: [raw(2)],
        likes: [raw(3), raw(4, { genre: 'Ambient', tag_list: 'ambient drone' })],
    });
    const result = await selectTrackPlaylist(seed.permalink_url, 'only my likes', 10, undefined, dependencies);
    expect(result.tracks.map((track) => track.apiId)).toEqual([3]);
});
it('deduplicates reuploads of a recording and excludes the original seed recording', async () => {
    const { dependencies } = setup({
        related: [
            raw(2, { title: 'Same Artist - Same Song' }),
            raw(3, { title: 'Same Artist - Same Song (Official Audio)' }),
            raw(4, { title: 'Artist 1 - Song 1' }),
        ],
    });
    const result = await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies);
    expect(result.tracks).toHaveLength(1);
    expect([2, 3]).toContain(result.tracks[0].apiId);
});
it('does not save tracks that became previews or disappeared during final verification', async () => {
    const { dependencies, request } = setup();
    request.mockImplementation(async (operation: string) => {
        if (operation === 'me') return { id: 42 };
        if (operation === 'resolve') return seed;
        if (operation === 'related') return { collection: [raw(2), raw(3)] };
        if (operation === 'tracks') return [raw(2, { policy: 'SNIP' })];
        return { collection: [] };
    });
    const result = await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies);
    expect(result.tracks).toEqual([]);
});
it('handles a failed optional source with useful partial results and refuses an account change', async () => {
    const { dependencies, request } = setup();
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (operation, fields) => {
        if (operation === 'likes') throw Error('HTTP 403');
        return base(operation, fields);
    });
    expect((await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies)).tracks).toHaveLength(2);
    let meCalls = 0;
    request.mockImplementation(async (operation, fields) =>
        operation === 'me' ? { id: ++meCalls === 1 ? 42 : 99 } : base(operation, fields),
    );
    await expect(selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies)).rejects.toThrow(
        'account changed',
    );
});
it('stops before discovery on cancellation or contradictory wishes', async () => {
    const { dependencies, request } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
        selectTrackPlaylist(seed.permalink_url, '', 10, controller.signal, dependencies),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(selectTrackPlaylist(seed.permalink_url, 'slow and fast', 10, undefined, dependencies)).rejects.toThrow(
        'Conflicting',
    );
    expect(request).not.toHaveBeenCalled();
});

it('reuses measured audio features without decoding or rewriting the listening profile', async () => {
    const { dependencies, store } = setup();
    const values = new Map<string, unknown>();
    const writable = {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => {
            values.set(key, value);
        },
    };
    const audio = new AudioAnalysisCache(writable, '42');
    audio.remember(candidate(seed)!, {
        source: 'media-element-v1',
        sampleSeconds: 35,
        energy: 0.08,
        bass: 0.7,
        brightness: 0.1,
    });
    audio.remember(candidate(raw(2))!, {
        source: 'media-element-v1',
        sampleSeconds: 35,
        energy: 0.081,
        bass: 0.69,
        brightness: 0.11,
    });
    audio.remember(candidate(raw(3))!, {
        source: 'media-element-v1',
        sampleSeconds: 35,
        energy: 0.4,
        bass: 0.05,
        brightness: 0.8,
    });
    dependencies.loadProfile = async () => ({ get: writable.get, set: store.set });
    const result = await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies);
    expect(result.seed.features?.source).toBe('media-element-v1');
    expect(result.tracks[0].apiId).toBe(2);
    expect(result.tracks[0].recommendationReasons).toContain('похожее звучание по аудиоанализу');
    expect(store.set).not.toHaveBeenCalled();
});

it('honors SoundCloud blocked users and known likes beyond the first likes page', async () => {
    const { dependencies, request } = setup();
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (operation, fields) => {
        if (operation === 'radio' && fields.path === '/me/track_likes/ids') return { collection: [3] };
        if (operation === 'radio' && fields.path === '/me/mutings/users/ids') return { collection: [1002] };
        return base(operation, fields);
    });
    const result = await selectTrackPlaylist(seed.permalink_url, 'only my likes', 10, undefined, dependencies);
    expect(result.tracks.map((track) => track.apiId)).toEqual([3]);
});

it('leaves capacity for playback with at most two simultaneous catalog reads', async () => {
    const { dependencies, request } = setup();
    const base = request.getMockImplementation()!;
    let active = 0,
        maximum = 0;
    request.mockImplementation(async (operation, fields) => {
        active++;
        maximum = Math.max(maximum, active);
        try {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return await base(operation, fields);
        } finally {
            active--;
        }
    });
    await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(request.mock.calls.length).toBeLessThanOrEqual(12);
});

it('cancels a hung read immediately and never proceeds to discovery or saving', async () => {
    const { dependencies, request } = setup();
    const controller = new AbortController();
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (operation, fields) => {
        if (operation === 'resolve') {
            queueMicrotask(() => controller.abort());
            return new Promise(() => {});
        }
        return base(operation, fields);
    });
    await expect(
        selectTrackPlaylist(seed.permalink_url, '', 10, controller.signal, dependencies),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.mock.calls.map(([operation]) => operation)).toEqual(['me', 'resolve']);
});

it('keeps large same-artist pools bounded and avoids consecutive artists when alternatives exist', async () => {
    const related = Array.from({ length: 30 }, (_, index) =>
        raw(index + 2, { user: { id: 1000 + (index % 3), username: `Group ${index % 3}` } }),
    );
    const { dependencies } = setup({ related });
    const result = await selectTrackPlaylist(seed.permalink_url, '', 10, undefined, dependencies);
    const counts = new Map<string, number>();
    result.tracks.forEach((track) => counts.set(track.artist, (counts.get(track.artist) || 0) + 1));
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(result.tracks.slice(1).every((track, index) => track.artist !== result.tracks[index].artist)).toBe(true);
});
