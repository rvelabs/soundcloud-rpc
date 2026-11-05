import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { SoundCloudCatalog } from './catalog';
import { ApiWriteError, parsePlaylist } from './accountTypes';
import { saveApiPlaylist } from './playlistWriter';
import { nativeLikeModel } from './nativeLikeBridge';
import type { ImportMatch } from '../import/match';
import { WorkScheduler } from '../utils/workScheduler';
const origin = 'https://api-v2.soundcloud.com';
const track = (id: number) => ({
    id,
    kind: 'track',
    title: 'Track ' + id,
    permalink_url: 'https://soundcloud.com/artist/t' + id,
    user: { username: 'Artist' },
    duration: 180000,
    streamable: true,
    state: 'finished',
    policy: 'ALLOW',
    media: { transcodings: [{ format: { protocol: 'hls' } }] },
});
const matches = (count: number) =>
    Array.from(
        { length: count },
        (_, index): ImportMatch => ({
            source: { title: 'Track ' + (index + 1), artist: 'Artist' },
            soundcloud: {
                apiId: index + 1,
                url: track(index + 1).permalink_url,
                title: track(index + 1).title,
                artist: 'Artist',
                score: 1,
                sourceQuery: 'Track ' + (index + 1),
            },
        }),
    );
function fixture() {
    const lists = new Map<number, { id: number; title: string; ids: number[] }>();
    const liked = new Set<number>();
    let next = 100,
        rejectId = 0,
        dropCreate = false,
        dropUpdate = false,
        failUpdate = 0;
    const playlist = (id: number) => {
        const p = lists.get(id)!;
        return { id, user_id: 7, title: p.title, tracks: p.ids.map((id) => ({ id })), track_count: p.ids.length };
    };
    const request = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input)),
            method = init?.method || 'GET';
        if (url.pathname === '/me') return Response.json({ id: 7, username: 'Owner', permalink: 'owner' });
        if (url.pathname === '/tracks')
            return Response.json((url.searchParams.get('ids') || '').split(',').map(Number).map(track));
        if (url.pathname === '/resolve')
            return Response.json(track(Number(new URL(url.searchParams.get('url')!).pathname.match(/t(\d+)$/)![1])));
        if (url.pathname === '/users/7/playlists')
            return Response.json({ collection: [...lists.keys()].map(playlist), next_href: null });
        if (url.pathname === '/me/track_likes/ids') return Response.json({ collection: [...liked], next_href: null });
        if (/^\/users\/7\/track_likes\/\d+$/.test(url.pathname)) {
            const id = Number(url.pathname.split('/').pop());
            if (method === 'PUT') liked.add(id);
            else liked.delete(id);
            return new Response(null, { status: 204 });
        }
        if (url.pathname === '/playlists' && method === 'POST') {
            const data = JSON.parse(String(init?.body)).playlist;
            expect(data.sharing).toBe('private');
            expect(data.tracks.every((id: unknown) => typeof id === 'number')).toBe(true);
            if (data.tracks.includes(rejectId)) return new Response('{}', { status: 400 });
            const id = next++;
            lists.set(id, { id, title: data.title, ids: data.tracks });
            if (dropCreate) {
                dropCreate = false;
                throw new TypeError('Connection lost after commit');
            }
            return Response.json(playlist(id), { status: 201 });
        }
        if (/^\/playlists\/\d+$/.test(url.pathname)) {
            const id = Number(url.pathname.split('/').pop());
            if (!lists.has(id)) return new Response('{}', { status: 404 });
            if (method === 'GET') return Response.json(playlist(id));
            const ids = JSON.parse(String(init?.body)).playlist.tracks;
            if (ids.includes(rejectId)) return new Response('{}', { status: 400 });
            if (
                failUpdate &&
                request.mock.calls.filter(
                    ([, init]) => init?.method === 'PUT' && String(init.body).includes('playlist'),
                ).length >= failUpdate
            )
                return new Response('{}', { status: 503 });
            lists.get(id)!.ids = ids;
            if (dropUpdate) {
                dropUpdate = false;
                throw new TypeError('Connection lost after commit');
            }
            return Response.json(playlist(id));
        }
        return new Response('{}', { status: 404 });
    });
    const catalog = new SoundCloudCatalog(request);
    const login = () =>
        catalog.observe(origin + '/me?client_id=' + 'A'.repeat(32), { Authorization: 'OAuth account-fixture-token' });
    login();
    return {
        catalog,
        request,
        lists,
        liked,
        login,
        set reject(value: number) {
            rejectId = value;
        },
        set loseCreate(value: boolean) {
            dropCreate = value;
        },
        set loseUpdate(value: boolean) {
            dropUpdate = value;
        },
        set stopAfter(value: number) {
            failUpdate = value;
        },
    };
}
const options = () => ({ title: 'Imported', concurrency: 4, target: vi.fn(), saved: vi.fn(), progress: vi.fn() });
describe('account API and bulk playlist writer', () => {
    it('requires an authenticated identity, not only a public client ID', async () => {
        const request = vi.fn<typeof fetch>();
        const catalog = new SoundCloudCatalog(request);
        catalog.observe(origin + '/search?client_id=' + 'A'.repeat(32), {});
        expect(await catalog.profile()).toBeNull();
        expect(await saveApiPlaylist(catalog, matches(2), options())).toBeNull();
        expect(request).not.toHaveBeenCalled();
    });
    it('creates once and appends 65 ordered tracks in batches instead of 65 page operations', async () => {
        const f = fixture(),
            o = options();
        const result = await saveApiPlaylist(f.catalog, matches(65), o);
        expect(result).toMatchObject({ added: 65, already: 0, failures: [] });
        expect(f.lists.get(100)?.ids).toEqual(Array.from({ length: 65 }, (_, i) => i + 1));
        expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
        expect(f.request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(4);
        expect(o.target).toHaveBeenCalledWith(100, 7);
        expect(o.saved).toHaveBeenCalledTimes(65);
        expect(f.request.mock.calls.every(([url]) => new URL(String(url)).hostname === 'api-v2.soundcloud.com')).toBe(
            true,
        );
    });
    it('resumes by stored ID, preserves existing order and skips already saved tracks', async () => {
        const f = fixture();
        f.lists.set(41, { id: 41, title: 'Renamed elsewhere', ids: [90, 2, 91] });
        const result = await saveApiPlaylist(f.catalog, matches(4), { ...options(), playlistId: 41, accountId: 7 });
        expect(result).toMatchObject({ added: 3, already: 1, failures: [] });
        expect(f.lists.get(41)?.ids).toEqual([90, 2, 91, 1, 3, 4]);
        expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    });
    it('bisects an explicitly rejected group and saves good tracks around the rejected one', async () => {
        const f = fixture();
        f.reject = 3;
        const result = await saveApiPlaylist(f.catalog, matches(7), options());
        expect(result?.successful.map((item) => item.soundcloud?.apiId)).toEqual([1, 2, 4, 5, 6, 7]);
        expect(result?.failures).toHaveLength(1);
        expect(f.lists.get(100)?.ids).toEqual([1, 2, 4, 5, 6, 7]);
    });
    it('can create from a later valid track when the first create is explicitly rejected', async () => {
        const f = fixture();
        f.reject = 1;
        const result = await saveApiPlaylist(f.catalog, matches(4), options());
        expect(result?.successful.map((item) => item.soundcloud?.apiId)).toEqual([2, 3, 4]);
        expect(f.lists.get(100)?.ids).toEqual([2, 3, 4]);
        expect(result?.failures).toHaveLength(1);
    });
    it('recovers a lost POST reply through readback without issuing a second POST', async () => {
        const f = fixture();
        f.loseCreate = true;
        const result = await saveApiPlaylist(f.catalog, matches(3), options());
        expect(result?.added).toBe(3);
        expect(f.lists.size).toBe(1);
        expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    });
    it('recovers a lost PUT reply by reading persisted IDs without duplicating the append', async () => {
        const f = fixture();
        f.loseUpdate = true;
        const result = await saveApiPlaylist(f.catalog, matches(4), options());
        expect(result?.added).toBe(4);
        expect(f.lists.get(100)?.ids).toEqual([1, 2, 3, 4]);
        expect(f.request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    });
    it('retains confirmed progress if later writes fail and fills remaining capacity only', async () => {
        const f = fixture();
        f.stopAfter = 2;
        const result = await saveApiPlaylist(f.catalog, matches(45), options());
        expect(result?.added).toBe(21);
        expect(result?.failures).toHaveLength(24);
        expect(f.lists.get(100)?.ids).toHaveLength(21);
        const full = fixture();
        full.lists.set(41, { id: 41, title: 'Imported', ids: Array.from({ length: 497 }, (_, i) => 1000 + i) });
        const capacity = await saveApiPlaylist(full.catalog, matches(8), {
            ...options(),
            playlistId: 41,
            accountId: 7,
        });
        expect(capacity?.added).toBe(3);
        expect(capacity?.failures).toHaveLength(5);
        expect(full.lists.get(41)?.ids).toHaveLength(500);
    });
    it('refuses ambiguous destinations, foreign accounts and incomplete playlist snapshots before writing', async () => {
        const f = fixture();
        f.lists.set(1, { id: 1, title: 'Imported', ids: [] });
        f.lists.set(2, { id: 2, title: 'Imported', ids: [] });
        await expect(saveApiPlaylist(f.catalog, matches(2), options())).rejects.toThrow('несколько');
        await expect(
            saveApiPlaylist(f.catalog, matches(2), { ...options(), playlistId: 1, accountId: 8 }),
        ).rejects.toThrow('другому аккаунту');
        expect(parsePlaylist({ id: 1, user_id: 7, title: 'P', track_count: 4, tracks: [{ id: 1 }] })!.complete).toBe(
            false,
        );
        expect(f.request.mock.calls.some(([, init]) => ['POST', 'PUT'].includes(init?.method || ''))).toBe(false);
    });
    it('sets desired like state idempotently and invalidates a stale account scope', async () => {
        const f = fixture();
        expect(await f.catalog.setLiked(track(1).permalink_url, true)).toMatchObject({
            id: 1,
            liked: true,
            accountId: 7,
        });
        expect(f.liked.has(1)).toBe(true);
        expect(await f.catalog.likeState(1, true)).toBe(true);
        expect(await f.catalog.setLiked(track(1).permalink_url, false)).toMatchObject({ liked: false });
        expect(f.liked.has(1)).toBe(false);
        expect(await f.catalog.likeState(1, true)).toBe(false);
        const old = await f.catalog.profile();
        f.catalog.reset();
        f.login();
        await expect(f.catalog.createPlaylist(old!, 'Old scope', [1])).rejects.toBeInstanceOf(ApiWriteError);
        expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });
    it('uses only validated same-path pagination and does not stop on a short page', async () => {
        const request = vi.fn<typeof fetch>(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/me') return Response.json({ id: 7, username: 'Owner' });
            if (url.pathname.includes('/play-history/')) return Response.json({ collection: [{ track: track(9) }] });
            return Response.json(
                url.searchParams.has('cursor')
                    ? { collection: [{ track: track(2) }] }
                    : { collection: [{ track: track(1) }], next_href: origin + '/users/7/track_likes?cursor=next' },
            );
        });
        const catalog = new SoundCloudCatalog(request);
        catalog.observe(origin + '/me?client_id=' + 'A'.repeat(32), { Authorization: 'OAuth account-fixture-token' });
        const data = await catalog.personalHistory();
        expect(data?.likes?.map((item) => item.id)).toEqual([1, 2]);
        expect(data?.recent?.[0].id).toBe(9);
        catalog.reset();
        catalog.observe(origin + '/me?client_id=' + 'A'.repeat(32), { Authorization: 'OAuth account-fixture-token' });
        request.mockImplementation(async (input) =>
            String(input).includes('/me?')
                ? Response.json({ id: 7, username: 'Owner' })
                : Response.json({ collection: [{ track: track(1) }], next_href: 'https://evil.test/steal' }),
        );
        expect((await catalog.personalHistory())?.likes).toBeNull();
        expect(request.mock.calls.every(([url]) => new URL(String(url)).origin === origin)).toBe(true);
    });
    it('interleaves station-only candidates after hydrating them in one batch', async () => {
        const request = vi.fn<typeof fetch>(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/resolve') return Response.json(track(1));
            if (url.pathname.endsWith('/related')) return Response.json({ collection: [track(2), track(3)] });
            if (url.pathname.startsWith('/stations/'))
                return Response.json({
                    collection: [
                        { ...track(3), state: undefined },
                        { ...track(4), state: undefined },
                        { ...track(5), state: undefined },
                    ],
                });
            return Response.json((url.searchParams.get('ids') || '').split(',').map(Number).map(track));
        });
        const catalog = new SoundCloudCatalog(request);
        catalog.observe(origin + '/me?client_id=' + 'A'.repeat(32), {});
        expect((await catalog.discover(track(1).permalink_url))?.map((item) => item.id)).toEqual([2, 4, 3, 5]);
        expect(request.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/tracks')).toHaveLength(1);
    });
    it('preserves the discovery fallback when station metadata cannot be hydrated', async () => {
        const request = vi.fn<typeof fetch>(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/resolve') return Response.json(track(1));
            if (path.endsWith('/related')) return new Response('{}', { status: 503 });
            return Response.json({ collection: [{ ...track(4), state: undefined }] });
        });
        const catalog = new SoundCloudCatalog(request);
        catalog.observe(origin + '/me?client_id=' + 'A'.repeat(32), {});
        expect(await catalog.discover(track(1).permalink_url)).toBeNull();
    });
    it('stops already queued playlist writes after the first rate-limit response', async () => {
        const scheduler = new WorkScheduler(() => ({ network: 1, page: 1 }));
        const request = vi.fn<typeof fetch>(async (_input, init) =>
            init?.method === 'POST'
                ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
                : Response.json({ id: 7, username: 'Owner' }),
        );
        const catalog = new SoundCloudCatalog(request, scheduler);
        catalog.observe(origin + '/me?client_id=' + 'A'.repeat(32), { Authorization: 'OAuth account-fixture-token' });
        const scope = (await catalog.profile())!;
        let release!: () => void;
        const gate = scheduler.run(
            'network',
            'prefetch',
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        await Promise.resolve();
        const writes = Promise.allSettled([
            catalog.createPlaylist(scope, 'One', [1]),
            catalog.createPlaylist(scope, 'Two', [2]),
        ]);
        release();
        await gate;
        expect((await writes).every((result) => result.status === 'rejected')).toBe(true);
        expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
        scheduler.dispose();
    });
    it('synchronizes the native model without a second server write and rejects another account', async () => {
        let selected = false,
            calls = 0;
        const model = { id: 1, get: () => track(1).permalink_url };
        function Model() {}
        Model.prototype.resource_type = 'sound';
        const sound = Object.assign(Model, {
            instances: {
                find: (predicate: (entry: typeof model) => boolean) => (predicate(model) ? model : undefined),
            },
        });
        const actions = {
            notify() {},
            addToPlayHistory() {},
            like: async (_model: unknown, desired: boolean, options: { persist: boolean }) => {
                expect(options.persist).toBe(false);
                selected = desired;
                calls++;
            },
        };
        const runtime = Object.assign(() => {}, {
            c: {
                a: { exports: { isLoggedIn: () => true, currentUserId: () => 7 } },
                b: { exports: sound },
                c: { exports: actions },
            },
            m: {} as Record<string, unknown>,
        });
        const pending: unknown[] = [];
        const chunks: unknown[] = [];
        chunks.push = function (packet: unknown) {
            const [, factories, entries] = packet as [
                unknown,
                Record<string, (a: unknown, b: unknown, r: unknown) => void>,
                string[][],
            ];
            factories[entries[0][0]]({}, {}, runtime);
            return pending.push.apply(pending, []);
        };
        const context = { window: { webpackJsonp: chunks } };
        const run = (sync: boolean, accountId = 7) =>
            runInNewContext(
                `(${nativeLikeModel.toString()})({id:1,accountId:${accountId},sync:${sync},liked:true})`,
                context,
            );
        expect(await run(false)).toBe(true);
        expect(calls).toBe(0);
        expect(await run(true)).toBe(true);
        expect(selected).toBe(true);
        expect(calls).toBe(1);
        expect(await run(true, 8)).toBe(false);
        expect(calls).toBe(1);
    });
});
