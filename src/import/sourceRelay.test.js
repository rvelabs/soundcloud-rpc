import { describe, it, expect, vi } from 'vitest';
import {
    createPublicPlaylistHandler,
    publicPlaylistResource,
} from '../../cloudflare/soundcloud-relay/playlist-source.mjs';
import { fetchSourceRelay } from './sourceRelay';
const secret = 'a'.repeat(64),
    source = 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M';
const call = (url = source, headers = { Authorization: 'Bearer ' + secret }) =>
    new Request('https://relay.workers.dev/playlist-source?url=' + encodeURIComponent(url), { headers });
describe('public metadata relay', () => {
    it('limits resources to supported playlist metadata rather than a general proxy', () => {
        for (const url of [
            source,
            'https://music.youtube.com/playlist?list=PL-zl0Qa3WDZ-XYzFHodllO2vHmE7kGODR',
            'https://api.music.yandex.ru/playlist/abc-def',
            'https://music.yandex.ru/handlers/playlist.jsx?owner=user&kinds=12',
        ])
            expect(publicPlaylistResource(url)).not.toBeNull();
        for (const url of [
            'http://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
            'https://127.0.0.1/',
            'https://open.spotify.com.evil.test/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
            'https://open.spotify.com/account',
            'https://api.spotify.com/v1/me',
            'https://www.youtube.com/watch?v=abc',
            'https://music.yandex.ru/handlers/playlist.jsx?owner=user&kinds=12&token=private',
            source + '?token=secret',
            source + '#fragment',
        ])
            expect(publicPlaylistResource(url)).toBeNull();
    });
    it('authenticates before fetching and never forwards cookies or the relay key to a source', async () => {
        const upstream = vi.fn(async (_url, init) => {
            expect(new Headers(init.headers).get('authorization')).toBeNull();
            expect(new Headers(init.headers).get('cookie')).toBeNull();
            return new Response('<html>public</html>', {
                headers: { 'content-type': 'text/html', 'set-cookie': 'SECRET_COOKIE' },
            });
        });
        const handler = createPublicPlaylistHandler(upstream);
        expect((await handler(call(source, {}), { RELAY_TOKEN: secret })).status).toBe(401);
        expect(upstream).not.toHaveBeenCalled();
        const response = await handler(call(source, { Authorization: 'Bearer ' + secret, Cookie: 'PRIVATE_SESSION' }), {
            RELAY_TOKEN: secret,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(response.headers.get('x-soundcloud-playlist-relay')).toBe('1');
        expect(await response.text()).toBe('<html>public</html>');
    });
    it('checks every redirect and rejects an outside or private destination before making that request', async () => {
        const upstream = vi.fn(
            async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
        );
        expect((await createPublicPlaylistHandler(upstream)(call(), { RELAY_TOKEN: secret })).status).toBe(502);
        expect(upstream).toHaveBeenCalledTimes(1);
    });
    it('rejects oversized or non-document bodies and preserves a source refusal without claiming success', async () => {
        for (const [response, status] of [
            [new Response('x', { headers: { 'content-length': '8000001' } }), 413],
            [new Response('binary', { headers: { 'content-type': 'audio/mpeg' } }), 415],
            [new Response('private', { status: 404 }), 502],
        ]) {
            const result = await createPublicPlaylistHandler(async () => response)(call(), { RELAY_TOKEN: secret });
            expect(result.status).toBe(status);
            expect(await result.text()).not.toContain('private');
        }
    });
    it('distinguishes an old Worker from a source refusing a private playlist', async () => {
        await expect(
            fetchSourceRelay(
                'https://relay.workers.dev',
                secret,
                source,
                async () => new Response('Not found', { status: 404 }),
            ),
        ).rejects.toMatchObject({ code: 'upgrade' });
        const handler = createPublicPlaylistHandler(async () => new Response('private', { status: 404 }));
        await expect(
            fetchSourceRelay('https://relay.workers.dev', secret, source, async (url, init) =>
                handler(new Request(url, init), { RELAY_TOKEN: secret }),
            ),
        ).rejects.toMatchObject({ code: 'source' });
    });
});
