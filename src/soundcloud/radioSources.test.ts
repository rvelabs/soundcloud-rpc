import { describe, it, expect, vi } from 'vitest';
import { SoundCloudCatalog } from './catalog';
import { RecommendationSession } from '../wave/recommendation/session';
const origin = 'https://api-v2.soundcloud.com';
const track = (id: number) => ({
    id,
    kind: 'track',
    title: 'Track ' + id,
    permalink_url: 'https://soundcloud.com/artist/t' + id,
    user: { id: 100 + id, username: 'Artist ' + id },
    duration: 180000,
    streamable: true,
    state: 'finished',
    policy: 'ALLOW',
    media: { transcodings: [] },
});
const setup = (handler: (url: URL, init?: RequestInit) => unknown, clock = () => 0) => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        const data = handler(url, init);
        return data instanceof Response ? data : Response.json(data);
    });
    const catalog = new SoundCloudCatalog(request, undefined, undefined, clock);
    catalog.observe(origin + '/me?client_id=' + 'A'.repeat(32), { Authorization: 'OAuth radio-fixture-account' });
    return { catalog, request };
};
describe('bounded API radio sources', () => {
    it('reads the real stream route and handles tracks and repost origins', async () => {
        const { catalog, request } = setup((url) => {
            if (url.pathname === '/me') return { id: 7, username: 'Owner' };
            return {
                collection: [
                    { type: 'track', track: track(1) },
                    { type: 'track-repost', origin: track(2) },
                    { type: 'playlist', origin: { kind: 'playlist', id: 99 } },
                ],
            };
        });
        expect((await catalog.followingCandidates())?.map((item) => item.id)).toEqual([1, 2]);
        expect(request.mock.calls.some(([url]) => new URL(String(url)).pathname === '/stream')).toBe(true);
    });
    it('continues a related list with the validated cursor, then stops at a foreign continuation', async () => {
        let now = 0;
        const { catalog, request } = setup(
            (url) => {
                if (url.pathname === '/resolve') return track(1);
                return url.searchParams.has('cursor')
                    ? { collection: [track(3)], next_href: 'https://foreign.invalid/steal' }
                    : { collection: [track(2)], next_href: origin + '/tracks/1/related?cursor=two' };
            },
            () => now,
        );
        expect((await catalog.related(track(1).permalink_url))?.map((t) => t.id)).toEqual([2]);
        expect((await catalog.related(track(1).permalink_url, true))?.map((t) => t.id)).toEqual([3]);
        now = 60001;
        expect(await catalog.related(track(1).permalink_url, true)).toBeNull();
        expect(request.mock.calls.every(([url]) => new URL(String(url)).origin === origin)).toBe(true);
        expect(request.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/related'))).toHaveLength(
            2,
        );
    });
    it('reads both home playlist types, deduplicates IDs and hydrates them without an HTML page', async () => {
        const { catalog, request } = setup((url) => {
            if (url.pathname === '/mixed-selections')
                return {
                    collection: [
                        {
                            items: {
                                collection: [
                                    { id: 90 },
                                    { id: 5, kind: 'track' },
                                    { urn: 'soundcloud:system-playlists:discovery:test' },
                                    { id: 90 },
                                ],
                            },
                        },
                    ],
                };
            if (url.pathname === '/playlists/90') return { tracks: [{ id: 2 }, { id: 3 }] };
            if (url.pathname.startsWith('/system-playlists/')) return { tracks: [{ id: 3 }, { id: 4 }] };
            if (url.pathname === '/tracks') return url.searchParams.get('ids')!.split(',').map(Number).map(track);
            throw Error('Unexpected HTML read');
        });
        const result = await catalog.homeCandidates();
        expect(result?.map((t) => t.id)).toEqual([5, 2, 3, 4]);
        expect(result?.every((t) => t.radioSource === 'home' && t.policy === 'ALLOW')).toBe(true);
        expect(request.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/tracks')).toHaveLength(1);
    });
    it('uses independent playlist owners and keeps collection provenance separate from related recommendations', async () => {
        const lists: Record<string, number[]> = { '90': [1, 2, 3, 4, 5], '92': [1, 2, 6, 7, 8] };
        const { catalog, request } = setup((url) => {
            if (url.pathname === '/resolve') return track(1);
            if (url.pathname.endsWith('/playlists_without_albums'))
                return {
                    collection: [
                        { id: 90, user: { id: 10 }, track_count: 5 },
                        { id: 91, user: { id: 10 }, track_count: 10 },
                        { id: 92, user_id: 11, track_count: 5 },
                    ],
                };
            if (url.pathname.startsWith('/playlists/'))
                return { tracks: lists[url.pathname.split('/').pop()!].map((id) => ({ id })) };
            return url.searchParams.get('ids')!.split(',').map(Number).map(track);
        });
        const result = await catalog.collectionCandidates(track(1).permalink_url);
        expect(result?.[0].id).toBe(2);
        expect(result?.map((t) => t.id)).not.toContain(1);
        expect(result?.every((t) => t.radioSource === 'collection')).toBe(true);
        const before = request.mock.calls.length;
        await catalog.collectionCandidates(track(1).permalink_url);
        expect(request).toHaveBeenCalledTimes(before);
        expect(request.mock.calls.some(([url]) => String(url).includes('/playlists/91'))).toBe(false);
    });
    it('progressively reads short ID pages, handles blocked-user URNs, and clears them across accounts', async () => {
        let owner = 7;
        const { catalog, request } = setup((url) => {
            if (url.pathname === '/me') return { id: owner, username: 'Owner' };
            if (url.pathname === '/me/mutings/users/ids')
                return { collection: owner === 7 ? ['soundcloud:users:22'] : [] };
            return owner !== 7
                ? { collection: [] }
                : url.searchParams.has('cursor')
                  ? { collection: [2, 3] }
                  : { collection: [1, '2'], next_href: origin + '/me/track_likes/ids?cursor=two' };
        });
        expect(await catalog.librarySignals()).toEqual({
            likedIds: [1, 2],
            blockedIds: [22],
            likesComplete: false,
            blocksComplete: true,
            more: true,
        });
        catalog.observeLike(7, 2, false);
        expect(await catalog.librarySignals()).toEqual({
            likedIds: [1, 3],
            blockedIds: [22],
            likesComplete: true,
            blocksComplete: true,
            more: false,
        });
        catalog.observeLike(7, 2, false);
        expect((await catalog.librarySignals())?.likedIds).toEqual([1, 3]);
        expect(request.mock.calls.filter(([url]) => new URL(String(url)).pathname.includes('mutings'))).toHaveLength(1);
        owner = 8;
        catalog.observe(origin + '/me?client_id=' + 'A'.repeat(32), { Authorization: 'OAuth another-radio-account' });
        expect((await catalog.librarySignals())?.likedIds).toEqual([]);
        expect((await catalog.librarySignals())?.blockedIds).toEqual([]);
    });
    it('does not disable catalog reads when an optional private source is forbidden', async () => {
        const { catalog } = setup((url) => {
            if (url.pathname === '/me') return { id: 7, username: 'Owner' };
            if (url.pathname === '/stream') return new Response('{}', { status: 403 });
            return { collection: [track(2)] };
        });
        expect(await catalog.followingCandidates()).toBeNull();
        expect(catalog.available).toBe(true);
        expect((await catalog.search('Music'))?.[0].id).toBe(2);
    });
    it('backs off a temporary library failure and resumes its cursor without losing prior IDs', async () => {
        let now = 0,
            failed = false;
        const { catalog, request } = setup(
            (url) => {
                if (url.pathname === '/me') return { id: 7, username: 'Owner' };
                if (url.pathname.includes('mutings')) return { collection: [] };
                if (!url.searchParams.has('cursor'))
                    return { collection: [1], next_href: origin + '/me/track_likes/ids?cursor=two' };
                if (!failed) {
                    failed = true;
                    return new Response('{}', { status: 503 });
                }
                return { collection: [2] };
            },
            () => now,
        );
        await catalog.librarySignals();
        expect((await catalog.librarySignals())?.likedIds).toEqual([1]);
        const count = request.mock.calls.length;
        await catalog.librarySignals();
        expect(request).toHaveBeenCalledTimes(count);
        now = 3001;
        const complete = await catalog.librarySignals();
        expect(complete?.likedIds).toEqual([1, 2]);
        expect(complete?.likesComplete).toBe(true);
    });
    it('filters known IDs and blocked uploaders without fabricating listening feedback', () => {
        const session = new RecommendationSession({ related: async () => [] });
        const entries = [1, 2, 3].map((id) => ({
            id: 'https://soundcloud.com/a/t' + id,
            apiId: id,
            uploaderId: id === 2 ? 55 : 56,
            title: 'Track ' + id,
            artist: 'Original ' + id,
            tags: [],
        }));
        session.addCandidates(entries);
        session.setLibrarySignals([1], [55]);
        session.setControls({ discovery: 'new' });
        expect(session.rank().map((x) => x.track.apiId)).toEqual([3]);
        session.setControls({ discovery: 'favorites' });
        expect(session.rank().map((x) => x.track.apiId)).toEqual([1]);
        expect(session.profile().heardIds.size).toBe(0);
        expect(session.profile().positiveSeeds).toHaveLength(0);
    });
    it('samples old likes and private collections in bounded batches without calling them all liked', async () => {
        let now = 0;
        const { catalog, request } = setup(
            (url) => {
                if (url.pathname === '/me') return { id: 7, username: 'Owner' };
                if (url.pathname === '/me/track_likes/ids')
                    return { collection: Array.from({ length: 200 }, (_, i) => i + 1) };
                if (url.pathname.includes('mutings')) return { collection: [] };
                if (url.pathname === '/users/7/playlists') return { collection: [{ id: 900, kind: 'playlist' }] };
                if (url.pathname === '/me/playlist_likes/ids') return { collection: [901] };
                if (url.pathname === '/playlists/900') return { tracks: [{ id: 300 }, { id: 301 }] };
                if (url.pathname === '/playlists/901') return { tracks: [{ id: 301 }, { id: 302 }] };
                if (url.pathname === '/me/play-history/tracks')
                    return { collection: [track(400)], next_href: origin + '/me/play-history/tracks?cursor=older' };
                if (url.pathname === '/tracks')
                    return url.searchParams
                        .get('ids')!
                        .split(',')
                        .map((id) => track(Number(id)));
                throw Error('Unexpected route ' + url.pathname);
            },
            () => now,
        );
        await catalog.librarySignals();
        const first = await catalog.libraryCandidates();
        expect(first?.likes.some((track) => track.id > 120)).toBe(true);
        expect(first?.likes.length).toBeLessThanOrEqual(12);
        expect(first?.playlists.map((track) => track.id)).toEqual([300, 301, 302]);
        expect(first?.recent.map((track) => track.id)).toEqual([400]);
        const reads = request.mock.calls.length;
        expect(await catalog.libraryCandidates()).toBeNull();
        expect(request).toHaveBeenCalledTimes(reads);
        now = 300001;
        const second = await catalog.libraryCandidates();
        expect(second?.likes.map((track) => track.id)).not.toEqual(first?.likes.map((track) => track.id));
        expect(request.mock.calls.some(([url]) => new URL(String(url)).searchParams.get('cursor') === 'older')).toBe(
            true,
        );
    });
    it('rejects a foreign history cursor without sending credentials to another host', async () => {
        let now = 0;
        const { catalog, request } = setup(
            (url) => {
                if (url.pathname === '/me') return { id: 7, username: 'Owner' };
                if (url.pathname === '/me/play-history/tracks')
                    return { collection: [track(1)], next_href: 'https://foreign.invalid/data' };
                return { collection: [] };
            },
            () => now,
        );
        await catalog.libraryCandidates();
        now = 300001;
        await catalog.libraryCandidates();
        expect(
            request.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/me/play-history/tracks'),
        ).toHaveLength(1);
        expect(request.mock.calls.every(([url]) => new URL(String(url)).origin === origin)).toBe(true);
    });
    it('caps artist contributions even when the server ignores limit and caches an unavailable source', async () => {
        const { catalog, request } = setup((url) => {
            if (url.pathname === '/resolve') return track(1);
            if (url.pathname.endsWith('/toptracks'))
                return { collection: Array.from({ length: 26 }, (_, i) => track(i + 2)) };
            if (url.pathname === '/tracks')
                return url.searchParams
                    .get('ids')!
                    .split(',')
                    .map((id) => track(Number(id)));
            throw Error('Unexpected route');
        });
        const list = await catalog.artistCandidates(track(1).permalink_url);
        expect(list?.length).toBe(4);
        expect(list?.every((track) => track.radioSource === 'artist')).toBe(true);
        const count = request.mock.calls.length;
        await catalog.artistCandidates(track(1).permalink_url);
        expect(request).toHaveBeenCalledTimes(count);
        const failed = setup((url) => (url.pathname === '/resolve' ? track(1) : new Response('{}', { status: 404 })));
        expect(await failed.catalog.artistCandidates(track(1).permalink_url)).toBeNull();
        await failed.catalog.artistCandidates(track(1).permalink_url);
        expect(
            failed.request.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/toptracks')),
        ).toHaveLength(1);
    });
});
