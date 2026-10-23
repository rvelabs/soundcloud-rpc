export function allowedHost(host) {
    return (
        typeof host === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:soundcloud\.com|sndcdn\.com)$/.test(host)
    );
}
export function bridgeSocket(ws, socket) {
    const reader = socket.readable.getReader(),
        writer = socket.writable.getWriter();
    let closed = false,
        ack,
        timeout,
        writing = false;
    const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        ack?.();
        void reader.cancel().catch(() => {});
        void writer.abort().catch(() => {});
        void socket.close().catch(() => {});
        try {
            ws.close(1000, 'Tunnel closed');
        } catch {}
    };
    ws.addEventListener('close', close);
    ws.addEventListener('error', close);
    ws.addEventListener('message', (event) => {
        if (closed) return;
        if (typeof event.data === 'string') {
            if (event.data === 'ack' && ack) {
                clearTimeout(timeout);
                const done = ack;
                ack = undefined;
                done();
            } else close();
            return;
        }
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 65536 || writing) {
            close();
            return;
        }
        writing = true;
        void writer.write(new Uint8Array(event.data)).then(() => {
            writing = false;
            if (!closed) ws.send('ack');
        }, close);
    });
    void (async () => {
        try {
            while (!closed) {
                const { value, done } = await reader.read();
                if (done) break;
                for (let offset = 0; offset < value.byteLength && !closed; offset += 65536) {
                    await new Promise((resolve) => {
                        ack = resolve;
                        timeout = setTimeout(close, 15000);
                        ws.send(value.slice(offset, offset + 65536));
                    });
                }
            }
        } catch {
        } finally {
            close();
        }
    })();
    return close;
}
export function createRelayHandler(connect) {
    return async (request, env) => {
        const url = new URL(request.url),
            host = url.searchParams.get('host');
        if (
            request.method !== 'GET' ||
            url.pathname !== '/tunnel' ||
            request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
        )
            return new Response('Not found', { status: 404 });
        if (
            !env.RELAY_TOKEN ||
            env.RELAY_TOKEN.length < 32 ||
            request.headers.get('Authorization') !== 'Bearer ' + env.RELAY_TOKEN
        )
            return new Response('Unauthorized', { status: 401 });
        if (!allowedHost(host)) return new Response('Forbidden', { status: 403 });
        let socket, timer;
        try {
            socket = connect({ hostname: host, port: 443 }, { secureTransport: 'off' });
            await Promise.race([
                socket.opened,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Timeout')), 8000);
                }),
            ]);
        } catch {
            if (socket) void socket.close().catch(() => {});
            return new Response('Origin unavailable', { status: 502 });
        } finally {
            clearTimeout(timer);
        }
        const pair = new WebSocketPair();
        pair[1].accept();
        bridgeSocket(pair[1], socket);
        return new Response(null, { status: 101, webSocket: pair[0] });
    };
}
