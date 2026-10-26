const { app, BrowserWindow, safeStorage } = require('electron');
const { createServer } = require('node:http');
const { connect } = require('node:net');
const { Duplex } = require('node:stream');
const { WebSocketServer } = require('ws');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-relay-live');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'relay-live-' + Date.now()));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    let window, recovery;
    const tcp = new Set();
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    try {
        const { bridgeSocket } = await import(
            pathToFileURL(path.join(repo, 'cloudflare/soundcloud-relay/protocol.mjs'))
        );
        const { ConnectionRecovery } = require(path.join(repo, 'tsc/network/connectionRecovery.js'));
        const token = randomBytes(32).toString('hex');
        const hosts = [];
        let rejectStatus = 0,
            transferLimit = Infinity,
            firstFrameDelay = 0;
        server.on('upgrade', (request, socket, head) => {
            const host = new URL(request.url, 'http://localhost').searchParams.get('host');
            if (rejectStatus) {
                socket.end('HTTP/1.1 ' + rejectStatus + ' Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
                return;
            }
            if (
                !['soundcloud.com', 'api-v2.soundcloud.com'].includes(host) ||
                request.headers.authorization !== 'Bearer ' + token
            ) {
                socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                return;
            }
            hosts.push(host);
            const upstream = connect(443, host);
            tcp.add(upstream);
            upstream.on('close', () => tcp.delete(upstream));
            upstream.on('error', () => socket.destroy());
            upstream.once('connect', () =>
                wss.handleUpgrade(request, socket, head, (ws) => {
                    let received = 0,
                        delayed = false;
                    bridgeSocket(
                        {
                            send: (data) => {
                                if (typeof data === 'string') {
                                    if (ws.readyState === 1) ws.send(data);
                                    return;
                                }
                                const part = data.subarray(0, Math.max(0, transferLimit - received));
                                received += part.length;
                                const send = () => {
                                    if (ws.readyState !== 1) return;
                                    if (part.length) ws.send(part);
                                    if (received >= transferLimit) setTimeout(() => ws.terminate(), 20);
                                };
                                if (firstFrameDelay && !delayed) {
                                    delayed = true;
                                    setTimeout(send, firstFrameDelay);
                                } else send();
                            },
                            close: (...args) => ws.close(...args),
                            addEventListener: (name, listener) => {
                                if (name === 'message')
                                    ws.on(name, (data, binary) =>
                                        listener({
                                            data: binary
                                                ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                                                : data.toString(),
                                        }),
                                    );
                                else ws.on(name, listener);
                            },
                        },
                        { ...Duplex.toWeb(upstream), close: async () => upstream.destroy() },
                    );
                }),
            );
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, partition: 'relay-live-public' } });
        await window.loadURL('about:blank');
        const values = new Map([
            ['cloudflareEndpoint', 'https://relay.example'],
            ['cloudflareSecretEncrypted', safeStorage.encryptString(token).toString('base64')],
        ]);
        recovery = new ConnectionRecovery(
            window.webContents,
            {
                get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
                set: (key, value) => values.set(key, value),
            },
            () => {},
        );
        const start = recovery.gateway.start.bind(recovery.gateway);
        recovery.gateway.start = () => start('ws://127.0.0.1:' + server.address().port + '/tunnel', token, true);
        const began = Date.now();
        const pending = recovery.testRelay();
        assert.equal(recovery.testRelay(), pending, 'manual and automatic probes share one in-flight check');
        const result = await pending;
        const report = {
            actualElectronFetch: true,
            realPublicSoundCloud: true,
            workerRuntime: 'local TCP/WebSocket adapter',
            success: result,
            elapsedMs: Date.now() - began,
            hosts,
            diagnostics: recovery.getDiagnostics?.(),
        };
        fs.writeFileSync(path.join(out, 'relay-live.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        assert(result, 'actual Chromium HTTPS through CONNECT/WebSocket/TCP should pass');
        const cases = [];
        rejectStatus = 401;
        await recovery.configure();
        assert.equal(await recovery.testRelay(), false);
        assert.equal(recovery.getDiagnostics().tunnels[0].httpStatus, 401);
        assert(recovery.getTestMessage().includes('отклонил ключ'));
        cases.push({ case: 'Worker rejects key', report: recovery.getDiagnostics() });
        rejectStatus = 0;
        transferLimit = 16384;
        await recovery.configure();
        assert.equal(await recovery.testRelay(), false, 'partial TLS stream must not count as a working relay');
        const partial = recovery.getDiagnostics();
        assert(partial.tunnels.some((tunnel) => tunnel.opened && tunnel.receivedBytes > 0));
        cases.push({ case: 'transfer interrupted after 16 KiB', report: partial });
        transferLimit = Infinity;
        firstFrameDelay = 7000;
        await recovery.configure();
        assert.equal(
            await recovery.testRelay(),
            true,
            'each HTTPS stage can wait more than the old shared six-second deadline',
        );
        const slow = recovery.getDiagnostics();
        assert(slow.stages.every((stage) => stage.elapsedMs >= 7000));
        cases.push({ case: 'each TLS handshake delayed seven seconds', report: slow });
        assert(!JSON.stringify(cases).includes(token));
        fs.writeFileSync(path.join(out, 'relay-faults.json'), JSON.stringify(cases, null, 2));
        console.log(
            JSON.stringify({
                faultCases: cases.map((item) => ({
                    case: item.case,
                    success: item.report.success,
                    stages: item.report.stages,
                    tunnels: item.report.tunnels,
                })),
                secretExcluded: true,
            }),
        );
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        recovery?.gateway.close();
        for (const socket of tcp) socket.destroy();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close();
        if (window && !window.isDestroyed()) window.destroy();
    }
});
setTimeout(() => {
    console.error('relay-live deadline');
    app.exit(1);
}, 40000).unref();
