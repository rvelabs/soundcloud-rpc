import { Buffer } from 'node:buffer';
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { PassThrough, Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { CloudflareGateway } from './cloudflareGateway';
import { bridgeSocket, createRelayHandler } from '../../cloudflare/soundcloud-relay/protocol.mjs';
const token = 'a'.repeat(48);
describe('Cloudflare transport', () => {
    it('rejects unauthenticated or unrelated destinations before opening TCP', async () => {
        let calls = 0;
        const handler = createRelayHandler(() => {
            calls++;
            throw Error('Must not connect');
        });
        const req = (host, secret) =>
            new Request('https://relay.test/tunnel?host=' + host, {
                headers: { Upgrade: 'websocket', Authorization: 'Bearer ' + secret },
            });
        expect((await handler(req('soundcloud.com', 'wrong'), { RELAY_TOKEN: token })).status).toBe(401);
        expect((await handler(req('127.0.0.1', token), { RELAY_TOKEN: token })).status).toBe(403);
        expect(calls).toBe(0);
    });
    it('streams two MiB through CONNECT and acknowledged WebSocket frames with bounded buffering', async () => {
        const server = createServer(),
            wss = new WebSocketServer({ noServer: true });
        let sawAuth = false;
        server.on('upgrade', (req, socket, head) => {
            sawAuth = req.headers.authorization === 'Bearer ' + token;
            wss.handleUpgrade(req, socket, head, (ws) => {
                const echo = new PassThrough({ highWaterMark: 65536 }),
                    streams = Duplex.toWeb(echo);
                const adapter = {
                    send: (data) => ws.send(data),
                    close: (...args) => ws.close(...args),
                    addEventListener: (name, fn) => {
                        if (name === 'message')
                            ws.on(name, (data, binary) =>
                                fn({
                                    data: binary
                                        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                                        : data.toString(),
                                }),
                            );
                        else ws.on(name, fn);
                    },
                };
                bridgeSocket(adapter, {
                    ...streams,
                    close: async () => {
                        echo.destroy();
                    },
                });
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const gateway = new CloudflareGateway();
        let client;
        try {
            const port = await gateway.start('ws://127.0.0.1:' + server.address().port + '/tunnel', token, true);
            client = connect(port, '127.0.0.1');
            const payload = randomBytes(2 * 1024 * 1024);
            let header = false,
                buffer = Buffer.alloc(0),
                parts = [],
                length = 0;
            const received = new Promise((resolve, reject) => {
                client.on('error', reject);
                client.on('data', (chunk) => {
                    if (!header) {
                        buffer = Buffer.concat([buffer, chunk]);
                        const end = buffer.indexOf('\r\n\r\n');
                        if (end < 0) return;
                        expect(buffer.subarray(0, end).toString()).toContain('200 Connection Established');
                        chunk = buffer.subarray(end + 4);
                        header = true;
                        client.write(payload);
                    }
                    if (chunk.length) {
                        parts.push(chunk);
                        length += chunk.length;
                        if (length === payload.length) resolve(Buffer.concat(parts));
                    }
                });
            });
            client.write('CONNECT api-v2.soundcloud.com:443 HTTP/1.1\r\nHost: api-v2.soundcloud.com:443\r\n\r\n');
            expect(await received).toEqual(payload);
            expect(sawAuth).toBe(true);
        } finally {
            client?.destroy();
            gateway.close();
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            await new Promise((resolve) => server.close(resolve));
        }
    }, 15000);
});
