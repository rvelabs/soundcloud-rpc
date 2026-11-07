import { expect, it, vi } from 'vitest';
import { Discovery } from './discovery';
import { candidate } from './tracks';
import { RelatedDiscovery } from '../../src/wave/relatedDiscovery';
import type { Track } from '../../src/wave/recommendation/types';

const raw = (id: number) => ({
    id,
    title: 'Track ' + id,
    genre: 'jungle',
    permalink_url: 'https://soundcloud.com/test/track-' + id,
    user: { id: 100 + id, username: 'Artist ' + id },
    duration: 180000,
    streamable: true,
    state: 'finished',
    policy: 'ALLOW',
});
it('matches Electron discovery across cached refreshes, paging and shared recommendations', async () => {
    let now = 0;
    const seeds: Track[] = [1, 2].map((id) => ({
        id: raw(id).permalink_url,
        apiId: id,
        genre: 'jungle',
        title: 'Seed',
        artist: 'Artist ' + id,
    }));
    const page = (id: number, advance: boolean) => [raw(99), raw(id + (advance ? 200 : 100))];
    const electronLoad = vi.fn(async (url: string, advance = false) =>
        page(Number(url.split('-').pop()), advance).map((raw, sourceRank) => ({ ...candidate(raw)!, sourceRank })),
    );
    const electron = new RelatedDiscovery(electronLoad, () => now);
    const request = vi.fn(async (_operation: string, fields: any) => {
        const id = Number(fields.path.split('/')[2]);
        return {
            collection: page(id, Boolean(fields.params.cursor)),
            next_href: fields.params.cursor
                ? undefined
                : `https://api-v2.soundcloud.com/tracks/${id}/related?cursor=second`,
        };
    });
    const native = new Discovery(
        7,
        () => 1,
        request,
        () => now,
    );
    const compact = (tracks: Awaited<ReturnType<Discovery['related']>>) =>
        tracks.map(({ url, sourceRank, source, relatedTo }) => ({ url, sourceRank, source, relatedTo }));
    for (const time of [0, 1000, 20000, 61000]) {
        now = time;
        const [actual, expected] = await Promise.all([native.related(seeds), electron.discover(seeds)]);
        expect(compact(actual)).toEqual(compact(expected));
        expect(actual.find((track) => track.apiId === 99)?.relatedTo).toEqual(seeds.map((seed) => seed.id));
    }
    expect(electronLoad).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenCalledTimes(4);
});
