import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { relayTarget, workerEndpoint } from './relayTargets';
import { networkErrorCode, type TunnelDiagnostic } from './relayDiagnostics';
interface Tunnel extends EventEmitter {
    send(data: Buffer | string, callback?: (error?: Error) => void): void;
    terminate(): void;
}
const WebSocket = require('ws') as new (url: string, options: object) => Tunnel;
export class CloudflareGateway {
    private server?: Server;
    private sockets = new Set<Socket>();
    private tunnels = new Set<Tunnel>();
    private diagnostics: TunnelDiagnostic[] = [];
    private sequence = 0;
    getDiagnosticCursor(): number {
        return this.sequence;
    }
    getDiagnostics(after = 0): TunnelDiagnostic[] {
        return this.diagnostics.filter((item) => item.id > after).map((item) => ({ ...item }));
    }
    async start(endpoint: string, secret: string, localTest = false): Promise<number> {
        if (this.server) throw new Error('Туннель уже запущен.');
        const base = localTest ? endpoint : workerEndpoint(endpoint);
        if (secret.length < 32 || secret.length > 256 || /[^a-zA-Z0-9_-]/.test(secret))
            throw new Error('Ключ Worker: от 32 до 256 символов A–Z, a–z, 0–9, _ или -.');
        const server = createServer((_req, res) => {
            res.writeHead(405);
            res.end();
        });
        server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
            socket.setTimeout(120000, () => socket.destroy());
        });
        server.on('connect', (req, stream, head) => {
            const socket = stream as Socket;
            const match = /^([a-z0-9.-]+):443$/i.exec(req.url || '');
            if (!match || !relayTarget(match[1]) || this.tunnels.size >= 64) {
                socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
                return;
            }
            socket.pause();
            const began = Date.now();
            const diagnostic: TunnelDiagnostic = {
                id: ++this.sequence,
                host: match[1].toLowerCase(),
                opened: false,
                sentBytes: 0,
                receivedBytes: 0,
                elapsedMs: 0,
            };
            this.diagnostics.push(diagnostic);
            if (this.diagnostics.length > 32) this.diagnostics.shift();
            const url = new URL(base);
            url.searchParams.set('host', match[1].toLowerCase());
            const ws = new WebSocket(url.href, {
                headers: { Authorization: 'Bearer ' + secret },
                handshakeTimeout: 12000,
                maxPayload: 65536,
                perMessageDeflate: false,
                followRedirects: false,
            });
            this.tunnels.add(ws);
            let opened = false,
                closed = false,
                receiving = false,
                ack: (() => void) | undefined;
            let ackTimer: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
                if (closed) return;
                closed = true;
                diagnostic.elapsedMs = Date.now() - began;
                if (!opened) diagnostic.failure ||= 'closed-before-open';
                clearTimeout(ackTimer);
                const release = ack;
                ack = undefined;
                release?.();
                this.tunnels.delete(ws);
                ws.terminate();
                if (!opened && !socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
                else socket.destroy();
            };
            const send = async (data: Buffer) => {
                for (let offset = 0; offset < data.length; offset += 65536) {
                    await new Promise<void>((resolve, reject) => {
                        ack = () => {
                            clearTimeout(ackTimer);
                            ack = undefined;
                            resolve();
                        };
                        ackTimer = setTimeout(() => {
                            diagnostic.failure ||= 'ack-timeout';
                            reject(new Error('Relay acknowledgement timed out'));
                            finish();
                        }, 15000);
                        ws.send(data.subarray(offset, offset + 65536), (error) => {
                            if (error) {
                                reject(error);
                                finish();
                            } else diagnostic.sentBytes += Math.min(65536, data.length - offset);
                        });
                    });
                    if (closed) throw new Error('Relay closed');
                }
            };
            ws.on('open', () => {
                opened = true;
                diagnostic.opened = true;
                diagnostic.elapsedMs = Date.now() - began;
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                socket.on('data', (data: Buffer) => {
                    socket.pause();
                    void send(data).then(() => socket.resume(), finish);
                });
                if (head.length) void send(head).then(() => socket.resume(), finish);
                else socket.resume();
            });
            ws.on('message', (data: Buffer, binary: boolean) => {
                if (closed) return;
                if (!binary) {
                    if (data.toString() === 'ack' && ack) ack();
                    else {
                        diagnostic.failure ||= 'protocol';
                        finish();
                    }
                    return;
                }
                if (!opened || receiving) {
                    diagnostic.failure ||= 'protocol';
                    finish();
                    return;
                }
                receiving = true;
                diagnostic.receivedBytes += data.length;
                socket.write(data, () => {
                    receiving = false;
                    if (!closed)
                        ws.send('ack', (error) => {
                            if (error) finish();
                        });
                });
            });
            ws.on('unexpected-response', (_request: unknown, response: IncomingMessage) => {
                diagnostic.failure = 'http';
                diagnostic.httpStatus = response.statusCode;
                response.destroy();
                finish();
            });
            ws.on('error', (error: Error) => {
                diagnostic.failure ||= /opening handshake.*timed out/i.test(error.message)
                    ? 'handshake-timeout'
                    : 'network';
                diagnostic.networkCode ||= networkErrorCode(error);
                finish();
            });
            ws.on('close', finish);
            socket.on('error', finish);
            socket.on('close', finish);
        });
        server.maxConnections = 80;
        server.headersTimeout = 10000;
        server.requestTimeout = 10000;
        this.server = server;
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Не удалось открыть локальный туннель.');
            return address.port;
        } catch (error) {
            this.close();
            throw error;
        }
    }
    close(): void {
        for (const ws of this.tunnels) ws.terminate();
        this.tunnels.clear();
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        this.server?.close();
        this.server = undefined;
    }
}
