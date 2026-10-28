export function allowedHost(host) {
    return (
        typeof host === 'string' &&
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:soundcloud\.com|sndcdn\.com|spotify\.com|scdn\.co|spotifycdn\.com|spotifycdn\.net)$/.test(
            host,
        )
    );
}
export function bridgeSocket(ws, socket, windowSize = 1) {
    windowSize = windowSize === 4 ? 4 : 1;
    const reader = socket.readable.getReader(),
        writer = socket.writable.getWriter();
    const acknowledgements = [];
    let closed = false,
        writing = 0,
        writeTail = Promise.resolve();
    const close = () => {
        if (closed) return;
        closed = true;
        for (const pending of acknowledgements.splice(0)) {
            clearTimeout(pending.timer);
            pending.resolve();
        }
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
            const pending = event.data === 'ack' ? acknowledgements.shift() : undefined;
            if (!pending) {
                close();
                return;
            }
            clearTimeout(pending.timer);
            pending.resolve();
            return;
        }
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 65536 || writing >= windowSize) {
            close();
            return;
        }
        writing++;
        const data = new Uint8Array(event.data);
        writeTail = writeTail
            .then(async () => {
                if (closed) return;
                await writer.write(data);
                writing--;
                if (!closed) ws.send('ack');
            })
            .catch(close);
    });
    const send = (data) =>
        new Promise((resolve) => {
            const pending = { resolve, timer: setTimeout(close, 15000) };
            acknowledgements.push(pending);
            try {
                ws.send(data);
            } catch {
                close();
            }
        });
    void (async () => {
        const pending = [];
        try {
            while (!closed) {
                const { value, done } = await reader.read();
                if (done) break;
                for (let offset = 0; offset < value.byteLength && !closed; offset += 65536) {
                    pending.push(send(value.slice(offset, offset + 65536)));
                    if (pending.length >= windowSize) await pending.shift();
                }
            }
            await Promise.all(pending);
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
        pair[1].binaryType = 'arraybuffer';
        pair[1].accept();
        const windowSize = url.searchParams.get('window') === '4' ? 4 : 1;
        if (windowSize === 4) pair[1].send('window:4');
        bridgeSocket(pair[1], socket, windowSize);
        return new Response(null, { status: 101, webSocket: pair[0] });
    };
}
