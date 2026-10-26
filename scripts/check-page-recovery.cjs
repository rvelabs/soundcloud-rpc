const { app, BrowserWindow, session } = require('electron');
const { createServer: createHttpServer } = require('node:http');
const { createServer: createHttpsServer } = require('node:https');
const { connect } = require('node:net');
const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-page-recovery');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'page-recovery-' + Date.now()));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    let win, recovery;
    const servers = [],
        sockets = new Set();
    try {
        const { ConnectionRecovery } = require(path.join(repo, 'tsc/network/connectionRecovery'));
        const values = new Map(),
            store = {
                get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
                set: (key, value) => values.set(key, value),
            };
        const certDir = app.getPath('userData');
        fs.mkdirSync(certDir, { recursive: true });
        const keyPath = path.join(certDir, 'fixture.key'),
            certPath = path.join(certDir, 'fixture.crt');
        execFileSync(
            process.env.OPENSSL_PATH || 'C:/Program Files/Git/usr/bin/openssl.exe',
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-noenc',
                '-keyout',
                keyPath,
                '-out',
                certPath,
                '-days',
                '1',
                '-subj',
                '/CN=soundcloud.com',
                '-addext',
                'subjectAltName=DNS:soundcloud.com,DNS:a-v2.sndcdn.com,DNS:api-v2.soundcloud.com',
            ],
            { stdio: 'ignore' },
        );
        const cert = fs.readFileSync(certPath),
            key = fs.readFileSync(keyPath),
            pinned = new X509Certificate(cert);
        let playing = false,
            documents = 0;
        const listen = (server) =>
            new Promise((resolve) => {
                servers.push(server);
                server.listen(0, '127.0.0.1', () => resolve(server.address().port));
            });
        const proxy = async (relay) => {
            const tls = createHttpsServer({ key, cert }, (request, response) => {
                const url = new URL(request.url, 'https://' + request.headers.host);
                if (url.hostname === 'soundcloud.com') {
                    documents++;
                    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
                    return response.end(
                        '<!doctype html><div id="app"></div>' +
                            (playing ? '<div class="playControls__play playing"></div>' : '') +
                            '<script src="https://a-v2.sndcdn.com/assets/app.js" onerror="document.getElementById(\'app\').textContent=\'Sorry! Something went wrong\'"></script>',
                    );
                }
                if (url.hostname === 'a-v2.sndcdn.com') {
                    if (!relay) {
                        response.writeHead(503);
                        return response.end();
                    }
                    response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
                    return response.end(
                        'document.getElementById("app").className="header";document.getElementById("app").textContent="SoundCloud loaded";',
                    );
                }
                response.writeHead(url.hostname === 'api-v2.soundcloud.com' ? 401 : 404);
                response.end();
            });
            const tlsPort = await listen(tls),
                server = createHttpServer();
            server.on('connect', (request, socket, head) => {
                assert(
                    ['soundcloud.com:443', 'a-v2.sndcdn.com:443', 'api-v2.soundcloud.com:443'].includes(request.url),
                );
                const upstream = connect(tlsPort, '127.0.0.1', () => {
                    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    if (head.length) upstream.write(head);
                    socket.pipe(upstream);
                    upstream.pipe(socket);
                });
                for (const item of [socket, upstream]) {
                    sockets.add(item);
                    item.on('close', () => sockets.delete(item));
                    item.on('error', () => {
                        socket.destroy();
                        upstream.destroy();
                    });
                }
            });
            return listen(server);
        };
        const directPort = await proxy(false),
            port = await proxy(true);
        const directRoute = (target) =>
            target.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:' + directPort });
        const fixtures = [];
        for (const partition of ['page-recovery-account', 'wave-connection-direct', 'wave-connection-relay']) {
            const target = session.fromPartition(partition);
            target.setCertificateVerifyProc((request, callback) => {
                try {
                    callback(
                        ['soundcloud.com', 'a-v2.sndcdn.com', 'api-v2.soundcloud.com'].includes(request.hostname) &&
                            new X509Certificate(request.certificate.data).raw.equals(pinned.raw)
                            ? 0
                            : -3,
                    );
                } catch {
                    callback(-3);
                }
            });
            await directRoute(target);
            fixtures.push(target);
        }
        win = new BrowserWindow({ show: false, webPreferences: { partition: 'page-recovery-account', sandbox: true } });
        const contents = win.webContents;
        recovery = new ConnectionRecovery(contents, store, () => {});
        const token = 'fixture_key_'.repeat(6);
        recovery.save({ mode: 'off', endpoint: 'https://fixture.workers.dev', secret: token });
        await recovery.configure();
        recovery.gateway = {
            start: async () => port,
            close: () => {},
            getDiagnosticCursor: () => 0,
            getDiagnostics: () => [],
        };
        await contents.loadURL('https://soundcloud.com/discover');
        await wait(100);
        const broken = await recovery.getPageDiagnostics();
        assert.equal(broken.page.errorPage, true);
        assert(broken.page.failures.some((f) => f.host === 'a-v2.sndcdn.com' && f.httpStatus === 503));
        assert.equal(broken.routes['a-v2.sndcdn.com'], 'other-proxy');
        assert.equal(await recovery.probe(fixtures[1]), false, 'HTML and API alone cannot establish page health');
        assert.equal(await recovery.testRelay(), true);
        assert.deepEqual(
            recovery.getDiagnostics().stages.map((s) => s.stage),
            ['website', 'assets', 'api'],
        );
        await contents.session.cookies.set({
            url: 'https://soundcloud.com',
            name: 'fixture-session',
            value: 'PRIVATE_COOKIE_VALUE',
            secure: true,
        });
        const awaitShell = async () => {
            for (let i = 0; i < 200; i++) {
                if (await contents.executeJavaScript('Boolean(document.querySelector(".header"))').catch(() => false))
                    return;
                await wait(20);
            }
            throw Error('Interface did not recover: ' + JSON.stringify(await recovery.getPageDiagnostics()));
        };
        store.set('cloudflareMode', 'always');
        const before = documents;
        await recovery.configure(true);
        await awaitShell();
        assert(documents > before, 'Saving the always mode reloads an already broken page');
        const healthy = await recovery.getPageDiagnostics();
        assert.equal(healthy.page.appShell, true);
        assert.equal(healthy.page.errorPage, false);
        assert(Object.values(healthy.routes).every((route) => route === 'worker'));
        assert.equal(
            (await contents.session.cookies.get({ name: 'fixture-session' }))[0].value,
            'PRIVATE_COOKIE_VALUE',
        );
        assert(!JSON.stringify(healthy).includes('PRIVATE_COOKIE_VALUE'));
        assert(!JSON.stringify(healthy).includes(token));
        store.set('cloudflareMode', 'off');
        await recovery.configure();
        await directRoute(contents.session);
        store.set('cloudflareMode', 'auto');
        await recovery.configure();
        await contents.loadURL('https://soundcloud.com/discover');
        await awaitShell();
        assert.equal(recovery.routed, true, 'A failed renderer bootstrap triggers automatic recovery');
        store.set('cloudflareMode', 'off');
        await recovery.configure();
        await directRoute(contents.session);
        playing = true;
        store.set('cloudflareMode', 'auto');
        await recovery.configure();
        await contents.loadURL('https://soundcloud.com/discover');
        await wait(150);
        assert.equal(recovery.routed, false, 'Network recovery must not interrupt an active player');
        playing = false;
        await contents.executeJavaScript('document.querySelector(".playing").classList.remove("playing")');
        await recovery.recover();
        await awaitShell();
        const report = {
            actualElectronPage: true,
            blockedCdnDetected: true,
            workerProbeIncludesAssets: true,
            automaticRecovery: true,
            saveReloadsBrokenPage: true,
            activePlayerPreserved: true,
            cookiesPreserved: true,
            diagnosticsExcludeSecrets: true,
        };
        fs.writeFileSync(path.join(out, 'page-recovery-results.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        recovery?.gateway.close();
        for (const socket of sockets) socket.destroy();
        for (const server of servers) server.close();
        if (win && !win.isDestroyed()) win.destroy();
    }
});
setTimeout(() => {
    console.error('Page recovery deadline');
    app.exit(1);
}, 30000).unref();
