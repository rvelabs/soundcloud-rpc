import { describe, it, expect, vi } from 'vitest';
import { Discovery } from './discovery';

const track = (id: number) => ({
    id,
    title: 'Track ' + id,
    permalink_url: 'https://soundcloud.com/artist/t' + id,
    user: { id: 100 + id, username: 'Artist ' + id },
    duration: 180000,
    streamable: true,
    state: 'finished',
    policy: 'ALLOW',
    genre: 'jungle',
});
const seed = { id: track(1).permalink_url, apiId: 1, title: 'Seed', artist: 'First', genre: 'jungle' };
const setup = (
    handler: (operation: string, fields: any, background: boolean) => unknown,
    revision = () => 1,
    now = () => 0,
) => {
    const request = vi.fn(async (operation: string, fields: object, background: boolean) =>
        handler(operation, fields, background),
    );
    return { discovery: new Discovery(7, revision, request, now), request };
};

describe('native discovery integration', () => {
    it('shares an in-flight ID page between fast synchronization and catalogue enrichment', async () => {
        vi.useFakeTimers();
        let resolve!: (value: unknown) => void;
        const { discovery, request } = setup((operation, fields) => {
            if (operation === 'tracks') return fields.ids.map(track);
            if (fields.path === '/me/track_likes/ids')
                return fields.params.cursor
                    ? new Promise((done) => {
                          resolve = done;
                      })
                    : { collection: [1], next_href: 'https://api-v2.soundcloud.com/me/track_likes/ids?cursor=next' };
            return { collection: [] };
        });
        try {
            await discovery.initial();
            const sync = discovery.syncLibrary(() => {});
            await vi.advanceTimersByTimeAsync(1500);
            const enrichment = discovery.enrich();
            resolve({ collection: [2] });
            await Promise.all([sync, enrichment]);
            expect(
                request.mock.calls.filter(
                    ([, fields]) =>
                        (fields as any).path === '/me/track_likes/ids' && (fields as any).params.cursor === 'next',
                ),
            ).toHaveLength(1);
        } finally {
            discovery.dispose();
            vi.useRealTimers();
        }
    });

    it('backs off failed continuation pages instead of continuously retrying a blocked service', async () => {
        vi.useFakeTimers();
        const { discovery, request } = setup(
            (_operation, fields) => {
                if (fields.path === '/me/track_likes/ids') {
                    if (fields.params.cursor) throw Error('429');
                    return {
                        collection: [1],
                        next_href: 'https://api-v2.soundcloud.com/me/track_likes/ids?cursor=next',
                    };
                }
                return { collection: [] };
            },
            () => 1,
            () => Date.now(),
        );
        try {
            await discovery.initial();
            const sync = discovery.syncLibrary(() => {});
            await vi.advanceTimersByTimeAsync(30000);
            await sync;
            expect(request.mock.calls.filter(([, fields]) => (fields as any).params?.cursor === 'next')).toHaveLength(
                3,
            );
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            discovery.dispose();
            vi.useRealTimers();
        }
    });

    it('finishes library ID pages in the background and samples metadata across the completed library', async () => {
        vi.useFakeTimers();
        const { discovery, request } = setup((operation, fields) => {
            if (operation === 'likes') return { collection: [] };
            if (operation === 'tracks') return fields.ids.map(track);
            if (fields.path === '/me/track_likes/ids') {
                const page = Number(fields.params.cursor || 0);
                return {
                    collection: [page * 2 + 1, page * 2 + 2],
                    next_href:
                        page < 2 ? `https://api-v2.soundcloud.com/me/track_likes/ids?cursor=${page + 1}` : undefined,
                };
            }
            return { collection: [] };
        });
        try {
            await discovery.initial();
            const update = vi.fn();
            const sync = discovery.syncLibrary(update);
            const duplicate = discovery.syncLibrary(update);
            await vi.advanceTimersByTimeAsync(3000);
            await Promise.all([sync, duplicate]);
            expect(update.mock.calls[update.mock.calls.length - 1]?.[0]).toMatchObject({
                likedIds: [1, 2, 3, 4, 5, 6],
                likesComplete: true,
            });
            expect(update.mock.calls.flatMap(([, items]) => items).map((item) => item.apiId)).toEqual([
                1, 2, 3, 4, 5, 6,
            ]);
            const requests = request.mock.calls.length;
            await discovery.syncLibrary(update);
            expect(request.mock.calls.length).toBe(requests);
            expect(
                request.mock.calls
                    .filter(([operation]) => operation === 'tracks')
                    .every(([, fields, background]) => (fields as any).ids.length <= 40 && background),
            ).toBe(true);
        } finally {
            discovery.dispose();
            vi.useRealTimers();
        }
    });

    it('cancels a pending library continuation on disposal and ignores a changed account', async () => {
        vi.useFakeTimers();
        let revision = 1;
        const { discovery, request } = setup(
            (_operation, fields) =>
                fields.path === '/me/track_likes/ids'
                    ? { collection: [1], next_href: 'https://api-v2.soundcloud.com/me/track_likes/ids?cursor=next' }
                    : { collection: [] },
            () => revision,
        );
        try {
            await discovery.initial();
            const calls = request.mock.calls.length,
                update = vi.fn();
            const sync = discovery.syncLibrary(update);
            revision++;
            await vi.advanceTimersByTimeAsync(1500);
            await sync;
            expect(request.mock.calls.length).toBe(calls);
            expect(update).not.toHaveBeenCalled();
            const cancelled = discovery.syncLibrary(update);
            discovery.dispose();
            await cancelled;
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            discovery.dispose();
            vi.useRealTimers();
        }
    });

    it('does not restore a heart removed while sampled metadata was in flight', async () => {
        let resolve!: (value: unknown) => void;
        const { discovery } = setup((operation, fields) => {
            if (operation === 'tracks')
                return new Promise((done) => {
                    resolve = done;
                });
            return { collection: fields.path === '/me/track_likes/ids' ? [1, 2] : [] };
        });
        await discovery.initial();
        const update = vi.fn(),
            sync = discovery.syncLibrary(update);
        discovery.reacted(2, false);
        resolve([track(1), track(2)]);
        await sync;
        expect(update.mock.calls.flatMap(([, items]) => items).map((item) => item.apiId)).toEqual([1]);
        discovery.dispose();
    });

    it('resolves imported recordings without API IDs and reuses their catalog metadata', async () => {
        const { discovery, request } = setup((operation, fields) =>
            operation === 'resolve'
                ? track(1)
                : fields.path === '/tracks/1/related'
                  ? { collection: [track(2)] }
                  : { collection: [] },
        );
        const hydrated = vi.fn();
        const legacy = { ...seed, apiId: undefined, genre: undefined };
        expect((await discovery.related([legacy], hydrated)).map((item) => item.apiId)).toEqual([2]);
        expect(hydrated).toHaveBeenCalledWith([
            expect.objectContaining({ apiId: 1, genre: 'jungle', metadataChecked: true }),
        ]);
        await discovery.related([legacy], hydrated);
        expect(request.mock.calls.filter(([operation]) => operation === 'resolve')).toHaveLength(1);
        expect(request.mock.calls.some(([, fields]) => (fields as any).path === '/tracks/1/related')).toBe(true);
    });
    it('coalesces metadata work, backs off failures and never accepts another track identity', async () => {
        let now = 0;
        const { discovery, request } = setup(
            () => track(2),
            () => 1,
            () => now,
        );
        expect(await Promise.all([discovery.hydrate([seed]), discovery.hydrate([seed])])).toEqual([[], []]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(await discovery.hydrate([seed])).toEqual([]);
        expect(request).toHaveBeenCalledTimes(1);
        now = 60001;
        await discovery.hydrate([seed]);
        expect(request).toHaveBeenCalledTimes(2);
    });
    it('discards resolution results when the account changes', async () => {
        let revision = 1;
        let done!: (value: unknown) => void;
        const { discovery } = setup(
            () =>
                new Promise((resolve) => {
                    done = resolve;
                }),
            () => revision,
        );
        const hydrated = vi.fn();
        const task = discovery.related([{ ...seed, apiId: undefined }], hydrated);
        revision++;
        done(track(1));
        expect(await task).toEqual([]);
        expect(hydrated).not.toHaveBeenCalled();
    });
    it('limits artist fallback to two distinct uploaders and retains its provenance', async () => {
        const { discovery, request } = setup((operation, fields) =>
            operation === 'tracks'
                ? fields.ids.map(track)
                : fields.path?.endsWith('/toptracks')
                  ? { collection: [track(Number(fields.path.split('/')[2]))] }
                  : { collection: [] },
        );
        await discovery.related([
            { ...seed, uploaderId: 71 },
            { ...seed, id: 'second', apiId: 2, uploaderId: 72 },
            { ...seed, id: 'third', apiId: 3, uploaderId: 71 },
            { ...seed, id: 'fourth', apiId: 4, uploaderId: 73 },
        ]);
        const result = await discovery.enrich();
        expect(result.tracks.filter((item) => item.source === 'artist').map((item) => item.apiId)).toEqual([71, 72]);
        expect(
            request.mock.calls.filter(([, fields]) => (fields as { path?: string }).path?.endsWith('/toptracks')),
        ).toHaveLength(2);
        const count = request.mock.calls.length;
        await discovery.enrich();
        expect(request.mock.calls).toHaveLength(count);
    });
    it('continues library IDs beyond the first metadata pages and retains explicit unlikes', async () => {
        const { discovery, request } = setup((operation, fields) => {
            if (operation === 'likes') return { collection: fields.offset ? [] : [{ track: track(1) }] };
            if (fields.path === '/me/mutings/users/ids') return { collection: ['soundcloud:users:22'] };
            if (fields.path === '/me/track_likes/ids')
                return fields.params.cursor
                    ? { collection: [2, 3] }
                    : { collection: [1, 2], next_href: 'https://api-v2.soundcloud.com/me/track_likes/ids?cursor=next' };
            if (operation === 'tracks') return fields.ids.map(track);
            return { collection: [] };
        });
        const initial = await discovery.initial();
        expect(initial.likes.map((item) => item.apiId)).toEqual([1]);
        expect(initial.signals).toMatchObject({ likedIds: [1, 2], blockedIds: [22], likesComplete: false });
        discovery.reacted(2, false);
        const next = await discovery.enrich();
        expect(next.signals).toMatchObject({ likedIds: [1, 3], blockedIds: [22], likesComplete: true });
        expect(next.likes.map((item) => item.apiId)).not.toContain(2);
        expect(request.mock.calls.some(([, fields]) => (fields as any).params?.cursor === 'next')).toBe(true);
    });

    it('advances related pages, retains provenance and reserves priority for playback preparation', async () => {
        let now = 0;
        const { discovery, request } = setup(
            (_operation, fields) =>
                fields.params.cursor
                    ? { collection: [track(3)] }
                    : {
                          collection: [track(2)],
                          next_href: 'https://api-v2.soundcloud.com/tracks/1/related?cursor=second',
                      },
            () => 1,
            () => now,
        );
        expect((await discovery.related([seed]))[0]).toMatchObject({
            apiId: 2,
            source: 'related',
            relatedTo: [seed.id],
        });
        expect((await discovery.related([seed]))[0]?.apiId).toBe(2);
        now = 60001;
        expect((await discovery.related([seed]))[0]?.apiId).toBe(3);
        now = 120002;
        expect(await discovery.related([seed])).toEqual([]);
        expect(request.mock.calls.every(([, , background]) => background === false)).toBe(true);
        discovery.dispose();
    });

    it('merges the early second page with the selected track station and hydrates station IDs once', async () => {
        const { discovery, request } = setup(
            (operation, fields) => {
                if (operation === 'tracks') return fields.ids.map(track);
                if (fields.path === '/stations/soundcloud%3Atrack-stations%3A1/tracks')
                    return { collection: [{ id: 1 }, { track: { id: 4 } }, { track: track(3) }] };
                return fields.params.cursor
                    ? { collection: [track(3)] }
                    : {
                          collection: [track(2)],
                          next_href: 'https://api-v2.soundcloud.com/tracks/1/related?cursor=second',
                      };
            },
            () => 1,
            () => 1000,
        );
        await discovery.related([seed]);
        expect(await discovery.related([seed], undefined, true)).toEqual([
            expect.objectContaining({ apiId: 3, relatedTo: [seed.id], stationSeed: seed.id, stationRank: 1 }),
            expect.objectContaining({ apiId: 4, stationSeed: seed.id, stationRank: 0 }),
        ]);
        expect((await discovery.related([seed], undefined, true)).map((item) => item.apiId)).toEqual([3, 4]);
        expect(request).toHaveBeenCalledTimes(4);
    });

    it('combines subscriptions, history and co-occurrence without adding homepage trends to a personal direction', async () => {
        const { discovery, request } = setup((operation, fields) => {
            if (operation === 'tracks') return fields.ids.map(track);
            if (fields.path === '/mixed-selections') return { collection: [{ items: [{ kind: 'track', id: 30 }] }] };
            if (fields.path === '/stream') throw Error('403');
            if (fields.path === '/me/play-history/tracks') return { collection: [{ track: track(40) }] };
            if (fields.path?.endsWith('/related')) return { collection: [track(2)] };
            if (fields.path?.endsWith('/playlists_without_albums'))
                return { collection: [{ id: 90, user_id: 20, track_count: 6 }] };
            if (fields.path === '/playlists/90') return { tracks: [1, 50, 51, 52, 53, 54] };
            return { collection: [] };
        });
        await discovery.related([seed]);
        const result = await discovery.enrich();
        expect(result.likes).toEqual([]);
        expect(result.recent[0]).toMatchObject({ apiId: 40, source: 'personal' });
        expect(result.tracks.find((item) => item.apiId === 30)).toBeUndefined();
        expect(request.mock.calls.some(([, fields]) => (fields as any).path === '/mixed-selections')).toBe(false);
        expect(result.tracks.find((item) => item.apiId === 50)?.source).toBe('collection');
        expect(result.tracks.every((item) => item.liked !== true)).toBe(true);
        expect(discovery.diagnostics()).toMatchObject({ failures: { '/stream': 1 } });
        const requests = request.mock.calls.length;
        await discovery.enrich();
        expect(request.mock.calls.length).toBe(requests);
    });

    it('uses the homepage as a genuine cold-start fallback when no taste seeds exist', async () => {
        const { discovery } = setup((operation, fields) => {
            if (operation === 'tracks') return fields.ids.map(track);
            return { collection: [{ items: [{ kind: 'track', id: 30 }] }] };
        });
        expect(await discovery.related([])).toEqual([expect.objectContaining({ apiId: 30, source: 'home' })]);
    });

    it('discards in-flight data across account changes and disposal', async () => {
        let revision = 1;
        let resolve!: (value: unknown) => void;
        const pending = new Promise((done) => {
            resolve = done;
        });
        const { discovery } = setup(
            () => pending,
            () => revision,
        );
        const related = discovery.related([seed]);
        revision++;
        resolve({ collection: [track(2)] });
        expect(await related).toEqual([]);
        discovery.dispose();
        expect(await discovery.related([seed])).toEqual([]);
        await expect(discovery.initial()).rejects.toThrow('account changed');
    });

    it('does not request a foreign continuation received from a source', async () => {
        let now = 0;
        const { discovery, request } = setup(
            () => ({ collection: [track(2)], next_href: 'https://foreign.invalid/cursor' }),
            () => 1,
            () => now,
        );
        await discovery.related([seed]);
        now = 60001;
        expect(await discovery.related([seed])).toEqual([]);
        expect(request).toHaveBeenCalledTimes(1);
    });
});
