import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicSoundCloudSearch, parsePublicSearch } from './publicSearch';
import { mapImportTracks } from './parallel';
import type { SourceTrack } from './source';
const base = 'https://soundcloud.com';
const page = (rows: Array<{ url: string; title: string }>) =>
    '<noscript><a href="/search/sounds">Tracks</a><ul>' +
    rows.map((row) => `<li><h2><a href="${row.url}">${row.title}</a></h2></li>`).join('') +
    '</ul></noscript>';
const metadata = (path: string, title = 'Original Song', artist = 'Original Artist', policy = 'ALLOW') =>
    'window.__sc_hydration = ' +
    JSON.stringify([
        {
            hydratable: 'sound',
            data: {
                permalink_url: base + path,
                title,
                user: { username: artist },
                publisher_metadata: {},
                duration: 180000,
                streamable: true,
                state: 'finished',
                policy,
                media: { transcodings: [{ format: { protocol: 'hls' } }] },
            },
        },
    ]) +
    ';';
const source = { title: 'Original Song', artist: 'Original Artist', durationSeconds: 180 };
afterEach(() => vi.useRealTimers());
describe('lightweight public SoundCloud search', () => {
    it('parses public result links, entities and hydration without running JavaScript', () => {
        const parsed = parsePublicSearch(
            page([
                { url: '/archive/song', title: 'A &amp; B &#8212; Song' },
                { url: 'https://evil.test/a/b', title: 'External' },
            ]),
        );
        expect(parsed.supported).toBe(true);
        expect(parsed.tracks).toEqual([{ url: base + '/archive/song', title: 'A & B — Song', artist: 'archive' }]);
        expect(parsePublicSearch(metadata('/a/song')).tracks[0].artist).toBe('Original Artist');
    });
    it('checks a reupload using two HTTP requests and never opens a search browser', async () => {
        const request = vi.fn<typeof fetch>(
            async (url) =>
                new Response(
                    String(url).includes('/search/')
                        ? page([{ url: '/archive/song', title: 'Original Artist - Original Song' }])
                        : metadata('/archive/song', 'Original Artist - Original Song', 'Archive uploader'),
                ),
        );
        const fallback = vi.fn(async () => ({ source }));
        const model = new PublicSoundCloudSearch(request, fallback, new AbortController().signal);
        const result = await model.match(source);
        expect(result.soundcloud?.score).toBeGreaterThan(0.9);
        expect(result.soundcloud?.artist).toBe('Archive uploader');
        expect(result.soundcloud?.availability?.status).toBe('available');
        expect(result.soundcloud?.requiresReview).toBe(false);
        expect(request).toHaveBeenCalledTimes(2);
        expect(fallback).not.toHaveBeenCalled();
    });
    it('keeps title-only recordings for review without repeating their detail request', async () => {
        const request = vi.fn<typeof fetch>(
            async (url) =>
                new Response(
                    String(url).includes('/search/')
                        ? page([{ url: '/archive/song', title: source.title }])
                        : metadata('/archive/song', source.title, 'Archive'),
                ),
        );
        const result = await new PublicSoundCloudSearch(
            request,
            async () => ({ source }),
            new AbortController().signal,
        ).match(source);
        expect(result.soundcloud?.requiresReview).toBe(true);
        expect(result.soundcloud!.score).toBeLessThan(0.85);
        expect(request).toHaveBeenCalledTimes(3);
    });
    it('prefers a later confirmed artist match over an earlier title-only result', async () => {
        const request = vi.fn<typeof fetch>(async (url) => {
            const address = new URL(String(url));
            if (address.pathname.includes('/search/'))
                return new Response(
                    page([
                        {
                            url: address.searchParams.get('q') === source.title ? '/artist/song' : '/archive/song',
                            title: source.title,
                        },
                    ]),
                );
            return new Response(
                metadata(
                    address.pathname,
                    source.title,
                    address.pathname.startsWith('/artist/') ? source.artist : 'Archive',
                ),
            );
        });
        const result = await new PublicSoundCloudSearch(
            request,
            async () => ({ source }),
            new AbortController().signal,
        ).match(source);
        expect(result.soundcloud?.url).toBe(base + '/artist/song');
        expect(result.soundcloud?.requiresReview).toBe(false);
    });
    it('skips unavailable previews instead of importing a grey nonplayable track', async () => {
        const request = vi.fn<typeof fetch>(async (url) => {
            const address = new URL(String(url));
            return new Response(
                address.pathname.includes('/search/')
                    ? page([
                          { url: '/artist/preview', title: source.title },
                          { url: '/artist/full', title: source.title },
                      ])
                    : metadata(
                          address.pathname,
                          source.title,
                          source.artist,
                          address.pathname.endsWith('/preview') ? 'SNIP' : 'ALLOW',
                      ),
            );
        });
        expect(
            (
                await new PublicSoundCloudSearch(request, async () => ({ source }), new AbortController().signal).match(
                    source,
                )
            ).soundcloud?.url,
        ).toBe(base + '/artist/full');
    });
    it('shares concurrent identical searches and metadata checks', async () => {
        const request = vi.fn<typeof fetch>(
            async (url) =>
                new Response(
                    String(url).includes('/search/')
                        ? page([{ url: '/artist/song', title: source.title }])
                        : metadata('/artist/song'),
                ),
        );
        const model = new PublicSoundCloudSearch(request, async () => ({ source }), new AbortController().signal);
        const results = await Promise.all([model.match(source), model.match(source)]);
        expect(results.every((item) => item.soundcloud?.url === base + '/artist/song')).toBe(true);
        expect(request).toHaveBeenCalledTimes(2);
    });
    it('uses a lazy browser fallback when the public layout is unsupported', async () => {
        const request = vi.fn<typeof fetch>(async () => new Response('<html>JavaScript app shell</html>'));
        const fallback = vi.fn(async (track: SourceTrack) => ({ source: track }));
        const model = new PublicSoundCloudSearch(request, fallback, new AbortController().signal);
        await model.match(source);
        await model.match({ ...source, title: 'Another Song' });
        expect(fallback).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('honors rate limits instead of adding browser traffic to an overloaded service', async () => {
        const request = vi.fn<typeof fetch>(
            async () => new Response('', { status: 429, headers: { 'retry-after': '10' } }),
        );
        const fallback = vi.fn(async () => ({ source }));
        const model = new PublicSoundCloudSearch(request, fallback, new AbortController().signal);
        expect((await model.match(source)).error).toContain('частоту');
        await model.match({ ...source, title: 'Another' });
        expect(request).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
    });
    it('bounds concurrent requests for a 320-track import and preserves source order', async () => {
        vi.useFakeTimers();
        let active = 0,
            maximum = 0;
        const request = vi.fn<typeof fetch>(async (url) => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            const address = new URL(String(url));
            const id = address.searchParams.get('q')?.match(/Song (\d+)/)?.[1] || address.pathname.split('/').pop();
            return new Response(
                address.pathname.includes('/search/')
                    ? page([{ url: '/artist/' + id, title: 'Song ' + id }])
                    : metadata(address.pathname, 'Song ' + id),
            );
        });
        const fallback = vi.fn(async (track: SourceTrack) => ({ source: track }));
        const model = new PublicSoundCloudSearch(request, fallback, new AbortController().signal, () => 10);
        const tracks = Array.from({ length: 320 }, (_, index) => ({ ...source, title: 'Song ' + index }));
        const pending = mapImportTracks(tracks, { concurrency: 10, run: (track) => model.match(track) });
        await vi.runAllTimersAsync();
        const results = await pending;
        expect(results.map((item) => item.source)).toEqual(tracks);
        expect(results.every((item) => item.soundcloud?.availability?.status === 'available')).toBe(true);
        expect(maximum).toBeLessThanOrEqual(10);
        expect(request).toHaveBeenCalledTimes(640);
        expect(fallback).not.toHaveBeenCalled();
    });
    it('does not start a lookup after cancellation', async () => {
        const controller = new AbortController();
        controller.abort();
        const request = vi.fn<typeof fetch>();
        await expect(
            new PublicSoundCloudSearch(request, async () => ({ source }), controller.signal).match(source),
        ).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });
});
