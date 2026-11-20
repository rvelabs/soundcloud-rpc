import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { playback } from './worker.mjs';
import { invitation } from '../../docs/join/join.js';
let mf;
beforeAll(() => {
    mf = new Miniflare({
        modules: true,
        scriptPath: new URL('./worker.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        compatibilityDate: '2026-07-30',
        durableObjects: { ROOMS: { className: 'ListeningRoom', useSQLite: true } },
    });
});
afterAll(async () => {
    await mf?.dispose();
});
const track = (extra = {}) => ({
    type: 'state',
    seq: 1,
    trackUrl: 'https://soundcloud.com/artist/track',
    title: 'Track',
    author: 'Artist',
    playing: true,
    positionMs: 12000,
    durationMs: 180000,
    ...extra,
});
const room = async () => {
    const response = await mf.dispatchFetch('http://local/v1/rooms', { method: 'POST' });
    expect(response.status).toBe(201);
    return response.json();
};
const connect = async (room, key) => {
    const response = await mf.dispatchFetch(`http://local/v1/rooms/${room}/socket`, {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    ws.accept();
    return ws;
};
function message(ws, type) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.removeEventListener('message', listener);
            reject(Error('missing ' + type));
        }, 8000);
        const listener = (event) => {
            const value = JSON.parse(event.data);
            if (value.type === type) {
                clearTimeout(timeout);
                ws.removeEventListener('message', listener);
                resolve(value);
            }
        };
        ws.addEventListener('message', listener);
    });
}
it('validates finite bounded musical state and accepts only the invitation format', () => {
    expect(playback(track())).not.toBeNull();
    for (const bad of [
        { trackUrl: 'https://evil.example/a/b' },
        { positionMs: NaN },
        { durationMs: Infinity },
        { playing: 'yes' },
        { seq: -1 },
    ])
        expect(playback(track(bad))).toBeNull();
    expect(invitation('#room=' + 'r'.repeat(24) + '&invite=' + 'i'.repeat(43))).toBe(
        'scwave://join?room=' + 'r'.repeat(24) + '&invite=' + 'i'.repeat(43),
    );
    expect(invitation('#room=x&invite=y')).toBeNull();
    expect(invitation('#room=' + 'r'.repeat(24) + '&invite=' + 'i'.repeat(43) + '&server=http://evil')).toBeNull();
});
it('synchronizes two clients, separates guest permission, and revokes an ended room', async () => {
    const created = await room();
    expect(created.hostKey).not.toBe(created.invite);
    const host = await connect(created.room, created.hostKey);
    const guest = await connect(created.room, created.invite);
    const got = message(guest, 'state');
    host.send(JSON.stringify(track()));
    const frame = await got;
    expect(frame.state.trackUrl).toBe(track().trackUrl);
    expect(frame.state.positionMs).toBe(12000);
    const pause = message(guest, 'state');
    host.send(JSON.stringify(track({ seq: 2, playing: false, positionMs: 15000 })));
    expect((await pause).state.playing).toBe(false);
    expect(
        (
            await mf.dispatchFetch(`http://local/v1/rooms/${created.room}/end`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${created.invite}` },
            })
        ).status,
    ).toBe(403);
    const ended = message(guest, 'ended');
    expect(
        (
            await mf.dispatchFetch(`http://local/v1/rooms/${created.room}/end`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${created.hostKey}` },
            })
        ).status,
    ).toBe(200);
    await ended;
    expect(
        (
            await mf.dispatchFetch(`http://local/v1/rooms/${created.room}/socket`, {
                headers: { Upgrade: 'websocket', Authorization: `Bearer ${created.invite}` },
            })
        ).status,
    ).toBe(410);
    host.close();
    guest.close();
});
it('rejects missing credentials, untrusted origins, and guest playback writes', async () => {
    expect(
        (
            await mf.dispatchFetch('http://local/v1/rooms', {
                method: 'POST',
                headers: { Origin: 'https://evil.example' },
            })
        ).status,
    ).toBe(403);
    const created = await room();
    expect(
        (await mf.dispatchFetch(`http://local/v1/rooms/${created.room}/socket`, { headers: { Upgrade: 'websocket' } }))
            .status,
    ).toBe(403);
    const guest = await connect(created.room, created.invite);
    const closed = new Promise((resolve) => guest.addEventListener('close', resolve, { once: true }));
    guest.send(JSON.stringify(track()));
    await closed;
    await mf.dispatchFetch(`http://local/v1/rooms/${created.room}/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.hostKey}` },
    });
});
it('keeps the invitation valid across a host reconnect and advances the shared revision', async () => {
    const created = await room();
    const host = await connect(created.room, created.hostKey);
    const guest = await connect(created.room, created.invite);
    const first = message(guest, 'state');
    host.send(JSON.stringify(track({ seq: 99 })));
    const initial = await first;
    const replacement = await connect(created.room, created.hostKey);
    const next = message(guest, 'state');
    replacement.send(JSON.stringify(track({ seq: 1, trackUrl: 'https://soundcloud.com/artist/next' })));
    const result = await next;
    expect(result.state.revision).toBeGreaterThan(initial.state.revision);
    expect(result.state.trackUrl).toContain('/next');
    await mf.dispatchFetch(`http://local/v1/rooms/${created.room}/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.hostKey}` },
    });
    host.close();
    replacement.close();
    guest.close();
});
it('reserves the host slot when guests arrive while the host is offline', async () => {
    const created = await room();
    const guests = [];
    for (let n = 0; n < 24; n++) guests.push(await connect(created.room, created.invite));
    const full = await mf.dispatchFetch(`http://local/v1/rooms/${created.room}/socket`, {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${created.invite}` },
    });
    expect(full.status).toBe(409);
    const host = await connect(created.room, created.hostKey);
    await mf.dispatchFetch(`http://local/v1/rooms/${created.room}/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.hostKey}` },
    });
    host.close();
    for (const guest of guests) guest.close();
});
