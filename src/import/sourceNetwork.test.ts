import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
import { PlaylistSourceNetwork, traceCountry } from './sourceNetwork';
describe('direct source country detection', () => {
    it('bypasses the app relay for Yandex while keeping the configured client route for other sources', async () => {
        const direct = vi.fn<typeof fetch>(async () => new Response('Yandex'));
        const client = vi.fn<typeof fetch>(async () => new Response('Spotify'));
        const network = new PlaylistSourceNetwork(direct, Date.now, client);
        expect(await network.load('https://api.music.yandex.ru/playlist/test')).toBe('Yandex');
        expect(await network.load('https://open.spotify.com/embed/playlist/test')).toBe('Spotify');
        expect(direct).toHaveBeenCalledTimes(1);
        expect(client).toHaveBeenCalledTimes(1);
    });
    it('reads the client country rather than the edge data center, language or IP address', () => {
        expect(traceCountry('ip=192.0.2.1\ncolo=FRA\nloc=RU\n')).toBe('RU');
        expect(traceCountry('loc=DE\r\n')).toBe('DE');
        expect(traceCountry('colo=RU\n')).toBeUndefined();
        expect(traceCountry('loc=<script>')).toBeUndefined();
    });
    it('coalesces detection, keeps only the country and refreshes a bounded cache', async () => {
        let now = 100000;
        const request = vi.fn<typeof fetch>(async () => new Response('ip=192.0.2.1\nloc=RU\n'));
        const network = new PlaylistSourceNetwork(request as typeof fetch, () => now);
        expect(await Promise.all([network.country(), network.country()])).toEqual(['RU', 'RU']);
        expect(await network.country()).toBe('RU');
        expect(request).toHaveBeenCalledTimes(1);
        now += 5 * 60000 + 1;
        await network.country();
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[0][0]).toBe('https://www.cloudflare.com/cdn-cgi/trace');
    });
    it('does not fail import when geolocation is unavailable or malformed', async () => {
        const network = new PlaylistSourceNetwork(
            vi.fn(async () => {
                throw new Error('offline');
            }) as typeof fetch,
        );
        expect(await network.country()).toBeUndefined();
    });
    it('cancels one caller without cancelling shared country discovery for other imports', async () => {
        let finish!: (response: Response) => void;
        const network = new PlaylistSourceNetwork(
            (() =>
                new Promise((resolve) => {
                    finish = resolve;
                })) as typeof fetch,
        );
        const cancel = new AbortController();
        const first = network.country(cancel.signal).catch((error) => error);
        const second = network.country();
        cancel.abort();
        finish(new Response('loc=RU\n'));
        expect((await first).name).toBe('AbortError');
        expect(await second).toBe('RU');
    });
});
