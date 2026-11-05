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
            if (url.pathname === '/stream/posts') return new Response('{}', { status: 403 });
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
});
