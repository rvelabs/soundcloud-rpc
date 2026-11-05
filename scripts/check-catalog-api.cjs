const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const { createHttpsFixture } = require('./helpers/https-fixture.cjs');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-catalog-api');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'isolated-profile'));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    let fixture, win, intruder;
    try {
        const { installSoundCloudCatalog } = require(path.join(root, 'tsc/soundcloud/catalogSession'));
        const { PublicSoundCloudSearch } = require(path.join(root, 'tsc/import/publicSearch'));
        const { createAvailabilityChecker } = require(path.join(root, 'tsc/import/availability'));
        const { WorkScheduler } = require(path.join(root, 'tsc/utils/workScheduler'));
        const clientId = 'A'.repeat(32),
            auth = 'OAuth isolated-catalog-fixture-token';
        let rejectedMe = false,
            completed = 0,
            beforeHeaders = 0,
            route = 'direct',
            htmlReads = 0;
        const calls = [];
        const track = (id = 1) => ({
            id,
            kind: 'track',
            title: id === 1 ? 'Original Artist — Song' : 'Related song',
            permalink_url: `https://soundcloud.com/archive/song-${id}`,
            user: { username: 'Archive' },
            publisher_metadata: { artist: 'Original Artist' },
            duration: 180000,
            bpm: 118,
            genre: 'Electronic',
            streamable: true,
            state: 'finished',
            policy: 'ALLOW',
            media: { transcodings: [{ format: { protocol: 'hls' } }] },
        });
        fixture = await createHttpsFixture(
            path.join(out, 'https'),
            ['soundcloud.com', 'api-v2.soundcloud.com'],
            (req, res) => {
                const url = new URL(req.url, 'https://' + req.headers.host);
                res.setHeader('Access-Control-Allow-Origin', 'https://soundcloud.com');
                res.setHeader('Access-Control-Allow-Headers', 'Authorization');
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                if (url.hostname === 'soundcloud.com') {
                    if (url.pathname === '/') {
                        res.setHeader('Content-Type', 'text/html');
                        res.end(
                            '<!doctype html><title>Isolated SoundCloud catalog</title><main>Catalog fixture</main>',
                        );
                    } else {
                        htmlReads++;
                        res.writeHead(500);
                        res.end();
                    }
                    return;
                }
                calls.push({
                    path: url.pathname,
                    id: url.searchParams.get('client_id'),
                    auth: req.headers.authorization,
                    method: req.method,
                });
                res.setHeader('Content-Type', 'application/json');
                if (url.pathname === '/me') {
                    res.writeHead(rejectedMe ? 401 : 200);
                    res.end(JSON.stringify({ id: 100 }));
                } else if (url.pathname === '/search/tracks') {
                    if (url.searchParams.get('q') === 'limited') {
                        res.writeHead(429, { 'Retry-After': '60' });
                        res.end('{}');
                    } else
                        res.end(
                            JSON.stringify({ collection: url.searchParams.get('q') === 'missing' ? [] : [track()] }),
                        );
                } else if (url.pathname === '/resolve') res.end(JSON.stringify(track()));
                else if (url.pathname === '/tracks/1/related')
                    res.end(JSON.stringify({ collection: [track(2), track(3)] }));
                else {
                    res.writeHead(404);
                    res.end('{}');
                }
            },
        );
        const network = session.fromPartition('catalog-api-isolated');
        await fixture.apply(network);
        network.webRequest.onBeforeSendHeaders((details, done) => {
            beforeHeaders++;
            done({ requestHeaders: details.requestHeaders });
        });
        network.webRequest.onCompleted(() => {
            completed++;
        });
        win = new BrowserWindow({
            show: false,
            webPreferences: { session: network, sandbox: true, backgroundThrottling: false },
        });
        const scheduler = new WorkScheduler(() => ({ network: 1, page: 1 }));
        const catalog = installSoundCloudCatalog(win.webContents, scheduler, () => route);
        await win.loadURL('https://soundcloud.com/');
        const bootstrap = async (target = win.webContents, id = clientId, token = auth) => {
            await target.executeJavaScript(
                `fetch('https://api-v2.soundcloud.com/me?client_id=${id}',{headers:{Authorization:${JSON.stringify(token)}}}).then(()=>true)`,
            );
            await wait(50);
        };
        await bootstrap();
        assert(catalog.diagnostics().ready, 'captures only a normal web-client request');
        const nativeHooks = { completed, beforeHeaders };
        win.minimize();
        const results = await Promise.all([catalog.search('Song'), catalog.search('Song')]);
        assert.equal(results[0][0].title, 'Original Artist — Song');
        assert.equal(
            calls.filter((call) => call.path === '/search/tracks').length,
            1,
            'deduplicates simultaneous searches',
        );
        const resolved = await catalog.resolve('https://soundcloud.com/archive/song-1');
        assert.equal(resolved.bpm, 118);
        assert.equal(calls.filter((call) => call.path === '/resolve').length, 0, 'search results warm metadata');
        assert.equal((await catalog.related(resolved.permalink_url)).length, 2);
        let domFallbacks = 0;
        const source = { title: 'Song', artist: 'Original Artist', durationSeconds: 180 };
        const matcher = new PublicSoundCloudSearch(
            network.fetch.bind(network),
            async (track) => {
                domFallbacks++;
                return { source: track };
            },
            new AbortController().signal,
            () => 2,
            Date.now,
            scheduler,
            catalog,
        );
        const matched = await matcher.match(source);
        assert.equal(matched.soundcloud.url, resolved.permalink_url);
        const check = createAvailabilityChecker(
            network,
            undefined,
            route,
            (job) => scheduler.run('network', 'import', job),
            catalog,
        );
        assert.equal((await check(resolved.permalink_url)).status, 'available');
        intruder = new BrowserWindow({ show: false, webPreferences: { session: network, sandbox: true } });
        await intruder.loadURL('https://soundcloud.com/');
        await bootstrap(intruder.webContents, 'B'.repeat(32), 'OAuth foreign-window-fixture');
        route = 'worker';
        await catalog.resolve(resolved.permalink_url);
        const last = calls.filter((call) => call.path === '/resolve').at(-1);
        assert.equal(last.id, clientId, 'another window cannot replace the observed client identity');
        assert.equal(last.auth, auth, 'request headers stay scoped to the owning window');
        assert.equal(await catalog.search('missing').then((items) => items.length), 0);
        await catalog.search('limited');
        const limited = await matcher.match({ title: 'Other track', artist: 'Someone' });
        assert(limited.error.includes('частоту'));
        assert.equal(domFallbacks, 0, '429 does not trigger a renderer retry');
        assert.equal(htmlReads, 0, 'API reads do not navigate search or track pages');
        assert.equal(win.webContents.getURL(), 'https://soundcloud.com/');
        assert(calls.every((call) => call.method === 'GET'));
        assert(
            completed > nativeHooks.completed && beforeHeaders > nativeHooks.beforeHeaders,
            'existing network hooks still receive traffic',
        );
        await network.cookies.set({ url: 'https://soundcloud.com', name: 'oauth_token', value: 'fixture-rotated' });
        await wait(80);
        assert.equal(catalog.diagnostics().ready, false, 'auth-cookie changes clear credentials and cached data');
        await bootstrap();
        assert(catalog.diagnostics().ready);
        rejectedMe = true;
        await bootstrap();
        assert.equal(catalog.diagnostics().ready, false, 'session rejection clears stale account data');
        win.destroy();
        assert.equal(await catalog.search('closed'), null);
        const report = {
            actualElectron: true,
            actualHttps: true,
            passiveSessionCapture: true,
            ownerScopedCredentials: true,
            minimizedApiReads: true,
            deduplicatedSearch: true,
            metadataCacheReused: true,
            apiRelated: true,
            apiImportMatch: true,
            apiAvailability: true,
            networkHooksPreserved: true,
            authRotationClearsCache: true,
            rateLimitRespected: true,
            domFallbacks,
            htmlReads,
            externalAccountsUsed: false,
        };
        fs.writeFileSync(path.join(out, 'catalog-api.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        scheduler.dispose();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        if (win && !win.isDestroyed()) win.destroy();
        if (intruder && !intruder.isDestroyed()) intruder.destroy();
        fixture?.close();
    }
});
setTimeout(() => app.exit(2), 30000).unref();
