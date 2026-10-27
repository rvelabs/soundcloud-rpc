import { beforeEach, describe, it, expect, vi } from 'vitest';
const direct = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: direct } }));
import { loadSourcePlaylist } from './loadSource';
import { SourceRelayError } from './sourceRelay';
const link = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=ignored';
const body =
    '<script id="__NEXT_DATA__">' +
    JSON.stringify({
        props: {
            pageProps: {
                state: { data: { entity: { name: 'Imported', trackList: [{ title: 'Song', subtitle: 'Artist' }] } } },
            },
        },
    }) +
    '</script>';
beforeEach(() => {
    direct.mockReset();
});
describe('source loading with independent fallback', () => {
    it('routes album metadata through Worker when local access is blocked', async () => {
        direct.mockRejectedValue(Error('net::ERR_CONNECTION_CLOSED'));
        const relay = vi.fn<(url: string) => Promise<string>>().mockResolvedValue(body);
        const result = await loadSourcePlaylist(
            'https://open.spotify.com/intl-ru/album/4aawyAB9vmqN3uQ7FjRGTy?si=x',
            undefined,
            { relay },
        );
        expect(result.tracks).toHaveLength(1);
        expect(relay.mock.calls[0][0]).toBe('https://open.spotify.com/embed/album/4aawyAB9vmqN3uQ7FjRGTy');
    });
    it('loads through the Worker after a blocked direct connection and exposes the chosen route', async () => {
        direct.mockRejectedValue(Error('net::ERR_CONNECTION_CLOSED'));
        const relay = vi.fn(async () => body),
            onRoute = vi.fn();
        const result = await loadSourcePlaylist(link, undefined, { relay, onRoute });
        expect(result.title).toBe('Imported');
        expect(result.tracks).toHaveLength(1);
        expect(onRoute.mock.calls.map((args) => args[0])).toEqual(['direct', 'relay']);
        expect(relay.mock.calls).toHaveLength(1);
    });
    it('uses Worker first in always mode without waiting for the blocked local source', async () => {
        const relay = vi.fn(async () => body);
        await loadSourcePlaylist(link, undefined, { relay, preferRelay: true });
        expect(direct).not.toHaveBeenCalled();
    });
    it('tries the alternate route when HTTP succeeds but the source returned an interstitial page', async () => {
        direct.mockResolvedValue(new Response('<html>Access check</html>'));
        expect((await loadSourcePlaylist(link, undefined, { relay: async () => body })).tracks[0].artist).toBe(
            'Artist',
        );
    });
    it('keeps direct loading available if a Worker has not been updated yet', async () => {
        direct.mockResolvedValue(new Response(body));
        const result = await loadSourcePlaylist(link, undefined, {
            preferRelay: true,
            relay: async () => {
                throw new SourceRelayError('upgrade', 'Upgrade Worker');
            },
        });
        expect(result.title).toBe('Imported');
    });
    it('reports Worker upgrade when both direct access and the old relay fail', async () => {
        direct.mockRejectedValue(Error('TimeoutError'));
        await expect(
            loadSourcePlaylist(link, undefined, {
                relay: async () => {
                    throw new SourceRelayError('upgrade', 'Upgrade Worker');
                },
            }),
        ).rejects.toMatchObject({ code: 'upgrade' });
    });
    it('does not try another route after user cancellation', async () => {
        const controller = new AbortController(),
            relay = vi.fn(async () => body);
        direct.mockImplementation(async () => {
            controller.abort();
            throw Error('aborted');
        });
        await expect(loadSourcePlaylist(link, controller.signal, { relay })).rejects.toThrow();
        expect(relay).not.toHaveBeenCalled();
    });
    it('omits source account cookies and rejects a redirect outside supported sources', async () => {
        direct.mockImplementation(async (_url, init) => {
            expect(init.credentials).toBe('omit');
            return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
        });
        const result = await loadSourcePlaylist(link, undefined, { relay: async () => body });
        expect(result.title).toBe('Imported');
        expect(direct).toHaveBeenCalledTimes(1);
    });
});
