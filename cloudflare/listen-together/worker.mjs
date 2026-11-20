const MAX_AGE = 6 * 3600_000;
const MAX_PEERS = 25;
const token = (bytes = 32) =>
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
const digest = async (value) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
const json = (value, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const allowedOrigin = (request) =>
    !request.headers.has('Origin') || request.headers.get('Origin') === 'https://rvelabs.github.io';
const address = /^https:\/\/soundcloud\.com\/[\w.~-]+\/[\w.~-]+$/;
export function playback(value) {
    if (
        !value ||
        typeof value !== 'object' ||
        !Number.isSafeInteger(value.seq) ||
        value.seq < 1 ||
        typeof value.playing !== 'boolean' ||
        !Number.isFinite(value.positionMs) ||
        value.positionMs < 0 ||
        value.positionMs > 86400_000 ||
        !Number.isFinite(value.durationMs) ||
        value.durationMs <= 0 ||
        value.durationMs > 86400_000 ||
        value.positionMs > value.durationMs + 10_000 ||
        typeof value.trackUrl !== 'string' ||
        value.trackUrl.length > 500 ||
        !address.test(value.trackUrl) ||
        typeof value.title !== 'string' ||
        value.title.length > 200 ||
        typeof value.author !== 'string' ||
        value.author.length > 200
    )
        return null;
    return {
        seq: value.seq,
        trackUrl: value.trackUrl,
        title: value.title,
        author: value.author,
        positionMs: Math.min(value.positionMs, value.durationMs),
        durationMs: value.durationMs,
        playing: value.playing,
    };
}

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            if (!allowedOrigin(request)) return json({ error: 'origin' }, 403);
            if (url.pathname === '/health' && request.method === 'GET')
                return json({ service: 'soundcloud-listen-together', version: 1 });
            if (url.pathname === '/v1/rooms' && request.method === 'POST') {
                if (Number(request.headers.get('Content-Length') || 0) > 1024) return json({ error: 'size' }, 413);
                const bucket = await digest(request.headers.get('CF-Connecting-IP') || 'local');
                const gate = env.ROOMS.get(env.ROOMS.idFromName('gate:' + bucket));
                const permission = await gate.fetch('https://internal/gate', { method: 'POST' });
                if (!permission.ok) return json({ error: 'rate-limit' }, 429);
                const room = token(18),
                    hostKey = token(),
                    invite = token();
                const expiresAt = Date.now() + MAX_AGE;
                const stub = env.ROOMS.get(env.ROOMS.idFromName('room:' + room));
                const created = await stub.fetch('https://internal/create', {
                    method: 'POST',
                    body: JSON.stringify({
                        hostHash: await digest(hostKey),
                        inviteHash: await digest(invite),
                        expiresAt,
                    }),
                });
                if (!created.ok) return json({ error: 'creation' }, 503);
                return json({ version: 1, room, hostKey, invite, expiresAt }, 201);
            }
            const match = /^\/v1\/rooms\/([A-Za-z0-9_-]{24})\/(socket|end)$/.exec(url.pathname);
            if (!match || url.search || url.hash) return json({ error: 'route' }, 404);
            if (
                (match[2] === 'socket' && request.method !== 'GET') ||
                (match[2] === 'end' && request.method !== 'POST')
            )
                return json({ error: 'method' }, 405);
            return env.ROOMS.get(env.ROOMS.idFromName('room:' + match[1])).fetch(
                new Request('https://internal/' + match[2], request),
            );
        } catch {
            return json({ error: 'service-unavailable' }, 503);
        }
    },
};

export class ListeningRoom {
    constructor(ctx) {
        this.ctx = ctx;
    }
    peers() {
        return this.ctx.getWebSockets();
    }
    send(ws, value) {
        try {
            ws.send(JSON.stringify(value));
        } catch {
            /* closed peer */
        }
    }
    broadcast(value) {
        for (const ws of this.peers()) this.send(ws, value);
    }
    participantCount() {
        return this.peers().filter((ws) => ws.deserializeAttachment()?.role === 'guest').length + 1;
    }
    state() {
        const host = this.peers().find((ws) => ws.deserializeAttachment()?.role === 'host');
        const snapshot = host?.deserializeAttachment();
        return { active: Boolean(snapshot && Date.now() - snapshot.seen < 60_000), snapshot: snapshot?.state || null };
    }
    async fetch(request) {
        const route = new URL(request.url).pathname;
        if (route === '/gate') {
            const now = Date.now();
            const old = await this.ctx.storage.get('gate');
            const next = !old || now - old.at > 60_000 ? { at: now, count: 1 } : { at: old.at, count: old.count + 1 };
            if (next.count > 8) return json({ error: 'rate-limit' }, 429);
            await this.ctx.storage.put('gate', next);
            await this.ctx.storage.setAlarm(now + 120_000);
            return json({ ok: true });
        }
        if (route === '/create') {
            if (await this.ctx.storage.get('meta')) return json({ error: 'exists' }, 409);
            const meta = await request.json();
            await this.ctx.storage.put('meta', meta);
            await this.ctx.storage.setAlarm(meta.expiresAt);
            return json({ ok: true });
        }
        const meta = await this.ctx.storage.get('meta');
        if (!meta || Date.now() >= meta.expiresAt) return json({ error: 'expired' }, 410);
        const raw = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '')?.[1];
        const hashed = raw && (await digest(raw));
        const role = hashed === meta.hostHash ? 'host' : hashed === meta.inviteHash ? 'guest' : null;
        if (!role) return json({ error: 'invitation' }, 403);
        if (route === '/end') {
            if (role !== 'host') return json({ error: 'role' }, 403);
            await this.close();
            return json({ ok: true });
        }
        if (route !== '/socket' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
            return json({ error: 'websocket' }, 400);
        // Reserve the host's slot even while its connection is being restored.
        if (role === 'guest' && this.participantCount() >= MAX_PEERS) return json({ error: 'full' }, 409);
        const previous = this.state().snapshot;
        if (role === 'host')
            for (const peer of this.peers())
                if (peer.deserializeAttachment()?.role === 'host') {
                    peer.serializeAttachment({ ...peer.deserializeAttachment(), role: 'replaced' });
                    peer.close(4001, 'Reconnected');
                }
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({
            role,
            seq: 0,
            seen: Date.now(),
            window: Date.now(),
            messages: 0,
            state: role === 'host' ? previous : null,
        });
        const current = this.state();
        this.send(server, {
            type: 'welcome',
            role,
            expiresAt: meta.expiresAt,
            participants: this.participantCount(),
            serverNow: Date.now(),
            active: current.active,
            state: current.snapshot,
        });
        this.broadcast({ type: 'participants', count: this.participantCount() });
        return new Response(null, { status: 101, webSocket: client });
    }
    async webSocketMessage(ws, message) {
        const attachment = ws.deserializeAttachment();
        const now = Date.now();
        if (typeof message !== 'string' || message.length > 4096) {
            ws.close(1009, 'Message too large');
            return;
        }
        if (now - attachment.window >= 10_000) {
            attachment.window = now;
            attachment.messages = 0;
        }
        if (++attachment.messages > 25) {
            ws.close(1008, 'Rate limit');
            return;
        }
        let value;
        try {
            value = JSON.parse(message);
        } catch {
            ws.close(1008, 'Invalid message');
            return;
        }
        const meta = await this.ctx.storage.get('meta');
        if (!meta || now >= meta.expiresAt) {
            await this.close();
            return;
        }
        if (value.type === 'ping') {
            ws.serializeAttachment(attachment);
            this.send(ws, { type: 'pong', serverNow: now });
            return;
        }
        if (attachment.role !== 'host' || value.type !== 'state') {
            ws.close(1008, 'Host controls playback');
            return;
        }
        const next = playback(value);
        if (!next || next.seq <= attachment.seq) {
            ws.close(1008, 'Invalid playback');
            return;
        }
        attachment.seq = next.seq;
        attachment.seen = now;
        attachment.state = {
            ...next,
            revision: Math.max(now * 100, (attachment.state?.revision || 0) + 1),
            observedAt: now,
        };
        ws.serializeAttachment(attachment);
        this.broadcast({ type: 'state', active: true, state: attachment.state, serverNow: now });
    }
    async webSocketClose(ws, code) {
        const role = ws.deserializeAttachment()?.role;
        if (role === 'host') this.broadcast({ type: 'host-away' });
        else this.broadcast({ type: 'participants', count: Math.max(1, this.participantCount() - 1) });
        try {
            ws.close(code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000);
        } catch {
            /* already closed */
        }
    }
    async webSocketError(ws) {
        try {
            ws.close(1011, 'Connection lost');
        } catch {
            /* already closed */
        }
    }
    async close() {
        this.broadcast({ type: 'ended' });
        for (const ws of this.peers())
            try {
                ws.close(1000, 'Session ended');
            } catch {
                /* already closed */
            }
        await this.ctx.storage.deleteAll();
    }
    async alarm() {
        await this.close();
    }
}
