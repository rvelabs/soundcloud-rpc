import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import {
    classifyTrackAvailability,
    createAvailabilityChecker,
    parseTrackAvailability,
    confirmTrackPlayback,
    cacheTrackAvailability,
} from './availability';
import { findSoundCloudMatch } from './match';
import type { WebContents } from 'electron';
import { EventEmitter } from 'node:events';
const url = 'https://soundcloud.com/artist/track';
const full = {
    permalink_url: url,
    streamable: true,
    state: 'finished',
    policy: 'MONETIZE',
    media: { transcodings: [{ snipped: false, format: { protocol: 'hls' } }] },
};
const html = (data: unknown) => `<script>window.__sc_hydration = ${JSON.stringify(data)};</script>`;
describe('availability gate', () => {
    it('reuses a checked public-search response when saving, without crossing routes or weakening playback evidence', async () => {
        const fetch = vi.fn(async () => new Response(html([{ data: full }])));
        const session = { fetch } as unknown as Session;
        cacheTrackAvailability(session, url, 'direct', classifyTrackAvailability(full));
        expect((await createAvailabilityChecker(session, undefined, 'direct')(url)).status).toBe('available');
        expect(fetch).not.toHaveBeenCalled();
        confirmTrackPlayback(session, url, 'direct');
        cacheTrackAvailability(session, url, 'direct', classifyTrackAvailability(full));
        expect((await createAvailabilityChecker(session, undefined, 'direct')(url)).evidence).toBe('playback');
        await createAvailabilityChecker(session, undefined, 'relay')(url);
        expect(fetch).toHaveBeenCalledTimes(1);
        cacheTrackAvailability(session, 'https://soundcloud.com/artist/stale', 'direct', {
            ...classifyTrackAvailability(full),
            checkedAt: Date.now() - 3 * 60000,
        });
        await createAvailabilityChecker(session, undefined, 'direct')('https://soundcloud.com/artist/stale');
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('separates metadata from confirmed playback and scopes cached results to the network route', async () => {
        const fetch = vi.fn(async () => new Response(html([{ data: full }])));
        const session = { fetch } as unknown as Session;
        const direct = createAvailabilityChecker(session, undefined, 'direct');
        expect((await direct(url)).evidence).toBe('metadata');
        confirmTrackPlayback(session, url, 'direct');
        expect((await direct(url)).evidence).toBe('playback');
        expect(fetch).toHaveBeenCalledTimes(1);
        await createAvailabilityChecker(session, undefined, 'relay')(url);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('accepts a full clear stream and rejects blocked, preview and protected versions', () => {
        expect(classifyTrackAvailability(full).status).toBe('available');
        expect(classifyTrackAvailability({ ...full, policy: 'BLOCK' }).status).toBe('blocked');
        expect(classifyTrackAvailability({ ...full, policy: 'SNIP' }).status).toBe('preview');
        expect(classifyTrackAvailability({ ...full, streamable: false }).status).toBe('blocked');
        expect(
            classifyTrackAvailability({
                ...full,
                media: { transcodings: [{ snipped: false, format: { protocol: 'cbc-encrypted-hls' } }] },
            }).status,
        ).toBe('protected');
        expect(classifyTrackAvailability({ ...full, media: {} }).status).toBe('unknown');
    });
    it('parses escaped hydration safely and never borrows another track availability', () => {
        expect(parseTrackAvailability(html([{ data: { title: 'a]b\\"c' } }, { data: full }]), url).status).toBe(
            'available',
        );
        expect(parseTrackAvailability(html([{ data: full }]), 'https://soundcloud.com/artist/other').status).toBe(
            'blocked',
        );
        expect(parseTrackAvailability('captcha', url).status).toBe('unknown');
        expect(parseTrackAvailability('window.__sc_hydration = [invalid]', url).status).toBe('unknown');
    });
    it('deduplicates concurrent checks, rejects unrelated URLs and respects cancellation', async () => {
        const fetch = vi.fn(async () => new Response(html([{ data: full }])));
        const controller = new AbortController();
        const check = createAvailabilityChecker({ fetch } as unknown as Session, controller.signal);
        const results = await Promise.all([check(url), check(url)]);
        expect(results.every((r) => r.status === 'available')).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect((await check('https://example.com/x/y')).status).toBe('blocked');
        controller.abort();
        await expect(check('https://soundcloud.com/artist/new')).rejects.toThrow();
    });
    it('selects the next available match instead of the highest scoring blocked result', async () => {
        const view = Object.assign(new EventEmitter(), {
            loadURL: vi.fn(async () => {}),
            executeJavaScript: vi.fn(async () => [
                { url, title: 'Track', artist: 'Artist' },
                { url: 'https://soundcloud.com/artist/alternate', title: 'Track', artist: 'Artist' },
            ]),
        });
        const check = vi.fn(async (candidate: string) => ({
            status: candidate === url ? ('blocked' as const) : ('available' as const),
            reason: 'fixture',
            checkedAt: Date.now(),
        }));
        const match = await findSoundCloudMatch(
            view as unknown as WebContents,
            { title: 'Track', artist: 'Artist' },
            undefined,
            check,
        );
        expect(match.soundcloud?.url).toBe('https://soundcloud.com/artist/alternate');
        expect(check).toHaveBeenCalledTimes(2);
        expect(view.listenerCount('dom-ready')).toBe(0);
    });
});
