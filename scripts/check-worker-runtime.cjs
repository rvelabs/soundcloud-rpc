const { Miniflare, Log, LogLevel } = require(process.env.WORKER_RUNTIME_MODULE || 'miniflare');
const WebSocket = require('ws');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const token = crypto.randomBytes(32).toString('hex');
const echoEntry = `import { createRelayHandler } from './protocol.mjs';
const relay=createRelayHandler(()=>{const echo=new TransformStream();return {opened:Promise.resolve(),readable:echo.readable,writable:echo.writable,close:async()=>{}}});
export default {fetch(request,env){if(new URL(request.url).pathname==='/runtime-info'){const pair=new WebSocketPair();return Response.json({binaryType:pair[1].binaryType});}return relay(request,env);}};`;
async function runtime(protocol, entry = echoEntry) {
    const instance = new Miniflare({
        host: '127.0.0.1',
        port: 0,
        compatibilityDate: '2026-07-30',
        log: new Log(LogLevel.ERROR),
        bindings: { RELAY_TOKEN: token },
        modulesRoot: path.join(root, 'cloudflare/soundcloud-relay'),
        modules: [
            { type: 'ESModule', path: path.join(root, 'cloudflare/soundcloud-relay/worker.mjs'), contents: entry },
            { type: 'ESModule', path: path.join(root, 'cloudflare/soundcloud-relay/protocol.mjs'), contents: protocol },
            {
                type: 'ESModule',
                path: path.join(root, 'cloudflare/soundcloud-relay/playlist-source.mjs'),
                contents: await fs.readFile(path.join(root, 'cloudflare/soundcloud-relay/playlist-source.mjs'), 'utf8'),
            },
        ],
    });
    try {
        const url = await instance.ready;
        return { instance, url };
    } catch (error) {
        await instance.dispose();
        throw error;
    }
}
async function transfer(base, payload, secret = token) {
    const url = new URL('/tunnel?host=soundcloud.com', base);
    url.protocol = 'ws:';
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + secret }, perMessageDeflate: false });
        const parts = [];
        let sent = 0,
            received = 0,
            settled = false;
        const timer = setTimeout(() => finish(new Error('Worker runtime transfer deadline')), 10000);
        const finish = (error, closeCode, httpStatus) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const result = { sent, received, closeCode, httpStatus, data: Buffer.concat(parts) };
            if (error) {
                ws.terminate();
                reject(error);
            } else if (ws.readyState === WebSocket.OPEN) {
                ws.once('close', () => resolve(result));
                ws.close(1000, 'Transfer complete');
            } else {
                ws.terminate();
                resolve(result);
            }
        };
        const send = () => {
            if (sent >= payload.length) return;
            const data = payload.subarray(sent, sent + 32768);
            sent += data.length;
            ws.send(data);
        };
        ws.on('open', send);
        ws.on('message', (data, binary) => {
            if (binary) {
                parts.push(data);
                received += data.length;
                ws.send('ack');
                if (received === payload.length) finish();
            } else if (data.toString() === 'ack') send();
            else finish(new Error('Unexpected control frame'));
        });
        ws.on('error', (error) => finish(error));
        ws.on('close', (code) => finish(undefined, code));
        ws.on('unexpected-response', (_request, response) => {
            response.resume();
            response.once('end', () => finish(undefined, undefined, response.statusCode));
        });
    });
}
(async () => {
    const protocol = await fs.readFile(path.join(root, 'cloudflare/soundcloud-relay/protocol.mjs'), 'utf8');
    const assignment = /\s*pair\[1\]\.binaryType\s*=\s*['"]arraybuffer['"];?/;
    assert(assignment.test(protocol), 'Worker must choose its binary delivery type before accept');
    const legacy = await runtime(protocol.replace(assignment, ''));
    try {
        const info = await (await fetch(new URL('/runtime-info', legacy.url))).json();
        assert.equal(info.binaryType, 'blob', 'test uses Cloudflare modern binary default');
        const result = await transfer(legacy.url, crypto.randomBytes(1800));
        assert.equal(result.received, 0);
        assert.equal(result.closeCode, 1000);
        console.log(
            JSON.stringify({
                legacyWorker: 'reproduced first-frame closure',
                sent: result.sent,
                received: result.received,
                defaultBinaryType: info.binaryType,
            }),
        );
    } finally {
        await legacy.instance.dispose();
    }
    const fixed = await runtime(protocol);
    try {
        const payload = crypto.randomBytes(2 * 1024 * 1024),
            result = await transfer(fixed.url, payload);
        assert.equal(result.received, payload.length);
        assert(result.data.equals(payload));
        const unauthorized = await transfer(fixed.url, Buffer.alloc(0), 'wrong');
        assert.equal(unauthorized.httpStatus, 401);
        console.log(
            JSON.stringify({
                fixedWorker: 'passed',
                verifiedBytes: result.received,
                unauthorizedStatus: unauthorized.httpStatus,
                engine: 'workerd',
                compatibilityFlag: 'websocket_standard_binary_type',
            }),
        );
    } finally {
        await fixed.instance.dispose();
    }
    if (process.argv.includes('--live')) {
        const entry = await fs.readFile(path.join(root, 'cloudflare/soundcloud-relay/worker.mjs'), 'utf8');
        const live = await runtime(protocol, entry);
        try {
            const url = new URL('/tunnel', live.url);
            url.protocol = 'ws:';
            const executable = process.env.WAVE_ELECTRON_PROBE_EXE;
            assert(executable, 'Set WAVE_ELECTRON_PROBE_EXE to an isolated Electron runner');
            const result = await require('node:util').promisify(require('node:child_process').execFile)(
                executable,
                [],
                {
                    cwd: root,
                    windowsHide: true,
                    timeout: 45000,
                    maxBuffer: 1024 * 1024,
                    env: {
                        ...process.env,
                        WAVE_CHECK_SCRIPT: 'check-relay-live.cjs',
                        WAVE_RELAY_RUNTIME_URL: url.href,
                        WAVE_RELAY_RUNTIME_KEY: token,
                    },
                },
            );
            process.stdout.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
        } finally {
            await live.instance.dispose();
        }
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
