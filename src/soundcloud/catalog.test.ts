import { describe, expect, it, vi } from 'vitest';
import { SoundCloudCatalog, parseApiTrack } from './catalog';
import { PublicSoundCloudSearch } from '../import/publicSearch';
import { createAvailabilityChecker } from '../import/availability';
import { WorkScheduler } from '../utils/workScheduler';
import type { Session } from 'electron';

const clientId = 'A'.repeat(32),
    authorization = 'OAuth catalog-fixture-token';
const address = 'https://soundcloud.com/archive/song';
const track = (id = 1) => ({
    id,
    kind: 'track',
    permalink_url: id === 1 ? address : `https://soundcloud.com/other/song-${id}`,
    title: id === 1 ? 'Original Artist — Song' : 'Next Song',
    user: { username: 'Archive' },
    publisher_metadata: { artist: 'Original Artist' },
    duration: 180000,
    streamable: true,
    state: 'finished',
    policy: 'ALLOW',
    media: { transcodings: [{ url: 'https://signed.invalid/?secret=never-retain', format: { protocol: 'hls' } }] },
});
const observe = (catalog: SoundCloudCatalog, token = authorization) =>
    catalog.observe(`https://api-v2.soundcloud.com/me?client_id=${clientId}`, { Authorization: token });
const source = { title: 'Song', artist: 'Original Artist', durationSeconds: 180 };

describe('SoundCloud catalog transport', () => {
    it('stays inactive until a web-client request is observed and rejects foreign origins and invalid keys', async () => {
        const request = vi.fn<typeof fetch>();
        const catalog = new SoundCloudCatalog(request);
        catalog.observe(`https://api-v2.soundcloud.com.evil.test/search?client_id=${clientId}`, {
            Authorization: authorization,
        });
        catalog.observe('https://api-v2.soundcloud.com/search?client_id=invalid', {});
        expect(await catalog.search('Song')).toBeNull();
        expect(await catalog.resolve('https://evil.test/archive/song')).toBeNull();
        expect(request).not.toHaveBeenCalled();
    });
    it('reuses structured search data for metadata and related discovery without fetching HTML', async () => {
        const request = vi.fn<typeof fetch>(async (url, init) => {
            const target = new URL(String(url));
            expect(target.origin).toBe('https://api-v2.soundcloud.com');
            expect(init?.method).toBe('GET');
            expect(init?.credentials).toBe('omit');
            expect(init?.redirect).toBe('error');
            expect(new Headers(init?.headers).get('authorization')).toBe(authorization);
            return Response.json({ collection: target.pathname.endsWith('/related') ? [track(2)] : [track()] });
        });
        const catalog = new SoundCloudCatalog(request);
        observe(catalog);
        const results = await Promise.all([catalog.search('Song'), catalog.search('Song')]);
        results[0]![0].title = 'Changed by caller';
        expect((await catalog.resolve(address))?.title).toBe('Original Artist — Song');
        expect(await catalog.related(address)).toHaveLength(1);
        expect((await catalog.search('Song'))![0].title).toBe('Original Artist — Song');
        expect(request).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(results[1])).not.toContain('never-retain');
        expect(JSON.stringify(catalog.diagnostics())).not.toContain(authorization);
        expect(JSON.stringify(catalog.diagnostics())).not.toContain(clientId);
    });
    it('can cancel one caller without cancelling a shared search still needed by another caller', async () => {
        let finish!: (response: Response) => void;
        const request = vi.fn<typeof fetch>(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const catalog = new SoundCloudCatalog(request);
        observe(catalog);
        const abort = new AbortController();
        const first = catalog.search('shared', abort.signal);
        const second = catalog.search('shared');
        abort.abort(new Error('cancelled caller'));
        await expect(first).rejects.toThrow('cancelled caller');
        expect(request.mock.calls[0][1]?.signal?.aborted).toBe(false);
        finish(Response.json({ collection: [track()] }));
        expect(await second).toHaveLength(1);
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('invalidates cached and pending results when routing or the authenticated session changes', async () => {
        let route = 'direct',
            finish!: (response: Response) => void;
        const request = vi.fn<typeof fetch>(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const catalog = new SoundCloudCatalog(request, undefined, () => route);
        observe(catalog);
        const stale = catalog.search('stale');
        const oldFinish = finish;
        route = 'worker';
        const fresh = catalog.search('fresh');
        oldFinish(Response.json({ collection: [track()] }));
        expect(await stale).toBeNull();
        finish(Response.json({ collection: [track(2)] }));
        expect(await fresh).toHaveLength(1);
        observe(catalog, 'OAuth another-fixture-account');
        const reloaded = catalog.resolve('https://soundcloud.com/other/song-2');
        finish(Response.json(track(2)));
        expect(await reloaded).not.toBeNull();
        expect(request).toHaveBeenCalledTimes(3);
        catalog.reset();
        expect(await catalog.search('after logout')).toBeNull();
    });
    it('expires entries and never treats an API credential failure as a missing track', async () => {
        let now = 0;
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json({ collection: [track()] }))
            .mockResolvedValueOnce(new Response('', { status: 401 }))
            .mockResolvedValueOnce(Response.json({ collection: [] }));
        const catalog = new SoundCloudCatalog(request, undefined, undefined, () => now);
        observe(catalog);
        expect(await catalog.search('Song')).toHaveLength(1);
        now = 120001;
        expect(await catalog.search('Song')).toBeNull();
        observe(catalog);
        expect(await catalog.search('Song')).toBeNull();
        expect(request).toHaveBeenCalledTimes(2);
        observe(catalog, 'OAuth renewed-fixture-token');
        expect(await catalog.search('Song')).toEqual([]);
        expect(request).toHaveBeenCalledTimes(3);
    });
    it('honors 429 without an HTML or renderer retry and resumes when its cooldown expires', async () => {
        let now = 0;
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }))
            .mockResolvedValueOnce(Response.json({ collection: [track()] }));
        const catalog = new SoundCloudCatalog(request, undefined, undefined, () => now);
        observe(catalog);
        const html = vi.fn<typeof fetch>(),
            fallback = vi.fn(async () => ({ source }));
        const search = new PublicSoundCloudSearch(
            html,
            fallback,
            new AbortController().signal,
            () => 2,
            () => now,
            undefined,
            catalog,
        );
        expect((await search.match(source)).error).toMatch(/частоту/);
        observe(catalog, 'OAuth renewed-fixture-token');
        expect(await catalog.search('Still limited')).toBeNull();
        expect(catalog.retryAfterMs).toBe(120000);
        expect(html).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
        now = 120001;
        expect(await catalog.search('Ready')).toHaveLength(1);
    });
    it('rejects malformed, oversized and mismatched resolve responses rather than caching untrusted records', async () => {
        expect(parseApiTrack({ ...track(), id: '1' })).toBeNull();
        expect(parseApiTrack({ ...track(), permalink_url: 'https://evil.test/a/b' })).toBeNull();
        expect(parseApiTrack({ ...track(), kind: 'playlist' })).toBeNull();
        const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(track(2)));
        const catalog = new SoundCloudCatalog(request);
        observe(catalog);
        expect(await catalog.resolve(address)).toBeNull();
        catalog.reset();
        observe(catalog);
        request.mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': '3000001' } }));
        expect(await catalog.search('large')).toBeNull();
        catalog.reset();
        observe(catalog);
        request.mockResolvedValueOnce(Response.json({ unexpected: [] }));
        expect(await catalog.search('invalid')).toBeNull();
    });
    it('keeps a concurrent successful response from lifting a rate limit and still reuses cached data', async () => {
        const finishes = new Map<string, (response: Response) => void>();
        const request = vi.fn<typeof fetch>(
            (url) => new Promise((resolve) => finishes.set(new URL(String(url)).searchParams.get('q')!, resolve)),
        );
        const catalog = new SoundCloudCatalog(request);
        observe(catalog);
        const warm = catalog.search('warm');
        finishes.get('warm')!(Response.json({ collection: [track()] }));
        await warm;
        const limited = catalog.search('limited'),
            success = catalog.search('success');
        finishes.get('limited')!(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
        await limited;
        finishes.get('success')!(Response.json({ collection: [track(2)] }));
        await success;
        expect(catalog.limited).toBe(true);
        expect(await catalog.search('new')).toBeNull();
        expect((await catalog.resolve(address))?.id).toBe(1);
        expect((await catalog.search('warm'))?.length).toBe(1);
        expect(request).toHaveBeenCalledTimes(3);
    });
    it('aborts pending I/O on disposal and prevents later account data from being retained', async () => {
        let finish!: (response: Response) => void;
        const request = vi.fn<typeof fetch>(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const catalog = new SoundCloudCatalog(request);
        observe(catalog);
        const pending = catalog.search('Song');
        catalog.dispose();
        expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
        finish(Response.json({ collection: [track()] }));
        expect(await pending).toBeNull();
        observe(catalog);
        expect(await catalog.resolve(address)).toBeNull();
        expect(catalog.diagnostics()).toMatchObject({ ready: false, cachedTracks: 0, cachedRequests: 0 });
    });
    it('matches reuploads and checks availability using one API response with a one-slot scheduler', async () => {
        const request = vi.fn<typeof fetch>(async () => Response.json({ collection: [track()] }));
        const scheduler = new WorkScheduler(() => ({ network: 1, page: 1 }));
        const catalog = new SoundCloudCatalog(request, scheduler);
        observe(catalog);
        const html = vi.fn<typeof fetch>(),
            fallback = vi.fn(async () => ({ source }));
        const search = new PublicSoundCloudSearch(
            html,
            fallback,
            new AbortController().signal,
            () => 2,
            Date.now,
            scheduler,
            catalog,
        );
        const found = await search.match(source);
        expect(found.soundcloud?.url).toBe(address);
        expect(found.soundcloud?.publisherArtist).toBe('Original Artist');
        const fakeSession = { fetch: html } as unknown as Session;
        const availability = createAvailabilityChecker(
            fakeSession,
            undefined,
            'route',
            (task) => scheduler.run('network', 'import', task),
            catalog,
        );
        expect((await availability(address)).status).toBe('available');
        expect(request).toHaveBeenCalledTimes(1);
        expect(html).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
        scheduler.dispose();
    });
    it('accepts a valid empty result without opening a hidden renderer', async () => {
        const request = vi.fn<typeof fetch>(async () => Response.json({ collection: [] }));
        const catalog = new SoundCloudCatalog(request);
        observe(catalog);
        const html = vi.fn<typeof fetch>(),
            fallback = vi.fn(async () => ({ source }));
        const search = new PublicSoundCloudSearch(
            html,
            fallback,
            new AbortController().signal,
            undefined,
            undefined,
            undefined,
            catalog,
        );
        expect(await search.match(source)).toEqual({ source });
        expect(html).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });
    it('retains the existing HTML matcher when API data is unavailable', async () => {
        const catalog = new SoundCloudCatalog(vi.fn<typeof fetch>(async () => new Response('', { status: 401 })));
        observe(catalog);
        const html = vi.fn<typeof fetch>(
            async (url) =>
                new Response(
                    String(url).includes('/search/')
                        ? '<noscript><a href="/search/sounds">Search</a><h2><a href="/archive/song">Original Artist — Song</a></h2></noscript>'
                        : 'window.__sc_hydration=' + JSON.stringify([{ data: track() }]),
                ),
        );
        const fallback = vi.fn(async () => ({ source }));
        const search = new PublicSoundCloudSearch(
            html,
            fallback,
            new AbortController().signal,
            undefined,
            undefined,
            undefined,
            catalog,
        );
        expect((await search.match(source)).soundcloud?.url).toBe(address);
        expect(html).toHaveBeenCalledTimes(2);
        expect(fallback).not.toHaveBeenCalled();
    });
    it('switches an existing import from unsupported HTML to API when the web session becomes ready', async () => {
        const request = vi.fn<typeof fetch>(async () => Response.json({ collection: [track()] }));
        const catalog = new SoundCloudCatalog(request);
        const html = vi.fn<typeof fetch>(async () => new Response('<main>JavaScript required</main>'));
        const fallback = vi.fn(async () => ({ source }));
        const search = new PublicSoundCloudSearch(
            html,
            fallback,
            new AbortController().signal,
            undefined,
            undefined,
            undefined,
            catalog,
        );
        expect((await search.match(source)).soundcloud).toBeUndefined();
        expect(fallback).toHaveBeenCalledTimes(1);
        observe(catalog);
        expect((await search.match(source)).soundcloud?.url).toBe(address);
        expect(fallback).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('resolves incomplete search summaries before using them as availability metadata', async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                Response.json({
                    collection: [
                        {
                            id: 1,
                            kind: 'track',
                            title: 'Original Artist — Song',
                            permalink_url: address,
                        },
                    ],
                }),
            )
            .mockResolvedValueOnce(Response.json(track()));
        const catalog = new SoundCloudCatalog(request);
        observe(catalog);
        expect(await catalog.search('Song')).toHaveLength(1);
        expect((await catalog.resolve(address))?.policy).toBe('ALLOW');
        expect(request).toHaveBeenCalledTimes(2);
    });
});
