import { describe, expect, it, vi } from 'vitest';
import { loadYouTubePages, readYouTubePage } from './youtubePagination';
const row = (id: number) => ({
    playlistVideoRenderer: {
        videoId: 'id-' + id,
        title: { simpleText: 'Track ' + id },
        shortBylineText: { simpleText: 'Artist ' + id },
        lengthSeconds: '180',
    },
});
const next = (token: string) => ({
    continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token } } } },
});
const items = (start: number, count: number, token?: string) => [
    ...Array.from({ length: count }, (_, i) => row(start + i)),
    ...(token ? [next(token)] : []),
];
const initial = (count: number, token?: string, total = count) =>
    `<script>ytcfg.set(${JSON.stringify({ INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261027.01.00', hl: 'en', gl: 'US', remoteHost: 'PRIVATE', visitorData: 'DO_NOT_FORWARD' } } })});var ytInitialData = ${JSON.stringify({ header: { playlistHeaderRenderer: { title: { simpleText: 'Full list' }, numVideosText: { simpleText: total + ' videos' } } }, contents: { playlistVideoListRenderer: { contents: items(0, count, token) } }, secondaryContents: { contents: [row(9999)] } })};</script>`;
const page = (start: number, count: number, token?: string) =>
    JSON.stringify({
        onResponseReceivedActions: [
            { appendContinuationItemsAction: { continuationItems: items(start, count, token) } },
        ],
    });
const url = 'https://www.youtube.com/playlist?list=PL_test_playlist_123';
describe('YouTube source pagination', () => {
    it('reads 308 tracks in order, excluding recommendations and private bootstrap fields', async () => {
        const request = vi.fn(async (_url, _signal, init) => {
            const input = JSON.parse(init.body);
            expect(input.context.client.remoteHost).toBeUndefined();
            expect(input.context.client.visitorData).toBeUndefined();
            return input.continuation === 'page-2' ? page(100, 100, 'page-3') : page(200, 108);
        });
        const progress = vi.fn();
        const result = await loadYouTubePages(initial(100, 'page-2', 308), url, request, undefined, progress);
        expect(result).toMatchObject({ partial: false, expectedTracks: 308, readTracks: 308, pagesRead: 3 });
        expect(result.tracks.map((track) => track.sourceId)).toEqual(Array.from({ length: 308 }, (_, i) => 'id-' + i));
        expect(request).toHaveBeenCalledTimes(2);
        expect(progress.mock.calls.map(([list]) => list.tracks.length)).toEqual([100, 200, 308]);
    });
    it('keeps 200 loaded tracks on a later network failure', async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(page(100, 100, 'page-3'))
            .mockRejectedValueOnce(Error('offline'));
        const result = await loadYouTubePages(initial(100, 'page-2', 300), url, request);
        expect(result).toMatchObject({ partial: true, partialReason: 'network', readTracks: 200 });
        expect(result.tracks).toHaveLength(200);
    });
    it('does not count overlapping pages toward the playlist limit', async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(page(50, 100, 'last'))
            .mockResolvedValueOnce(page(150, 60));
        const result = await loadYouTubePages(initial(100, 'overlap', 210), url, request);
        expect(result).toMatchObject({ partial: false, readTracks: 210, expectedTracks: 210 });
        expect(result.tracks[result.tracks.length - 1]?.sourceId).toBe('id-209');
    });
    it('stops a repeated continuation and caps a larger playlist at the SoundCloud limit', async () => {
        const repeated = await loadYouTubePages(initial(2, 'same', 10), url, async () => page(2, 2, 'same'));
        expect(repeated).toMatchObject({ partial: true, partialReason: 'repeated', pagesRead: 2 });
        let offset = 100;
        const request = vi.fn(async () => {
            const response = page(offset, 100, String(offset + 100));
            offset += 100;
            return response;
        });
        const capped = await loadYouTubePages(initial(100, '100', 601), url, request);
        expect(capped).toMatchObject({ partial: true, partialReason: 'limit', expectedTracks: 601 });
        expect(capped.tracks).toHaveLength(500);
        expect(request).toHaveBeenCalledTimes(4);
    });
    it('does not interpret an interstitial or a cancelled read as successful completion', async () => {
        expect(() => readYouTubePage('<html>Please sign in</html>')).toThrow();
        const abort = new AbortController();
        await expect(
            loadYouTubePages(
                initial(2, 'next', 10),
                url,
                async () => {
                    abort.abort();
                    throw Error('cancelled');
                },
                abort.signal,
            ),
        ).rejects.toThrow();
    });
});
