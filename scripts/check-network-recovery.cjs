const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-network-recovery');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile-' + Date.now()));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const contents = window.webContents;
    try {
        await contents.loadURL('data:text/html,<main class="header"></main>');
        const { ConnectionRecovery } = require(path.join(root, 'tsc/network/connectionRecovery.js'));
        const { PlaylistSourceNetwork } = require(path.join(root, 'tsc/import/sourceNetwork.js'));
        const { loadSourcePlaylist } = require(path.join(root, 'tsc/import/loadSource.js'));
        const values = new Map([
            ['cloudflareMode', 'auto'],
            ['cloudflareEndpoint', 'https://test.example.workers.dev'],
        ]);
        const store = { get: (key, fallback) => (values.has(key) ? values.get(key) : fallback) };
        const recovery = new ConnectionRecovery(contents, store, () => {});
        recovery.secret = () => 'test_key_'.repeat(8);
        recovery.gateway = { start: async () => 54322, close: () => {} };
        let relayHealthy = true,
            relayProbes = 0,
            directProbes = 0,
            reloads = 0,
            now = Date.now();
        recovery.probe = async (target) => {
            if ((await target.resolveProxy('https://soundcloud.com')) === 'PROXY 127.0.0.1:54322') {
                relayProbes++;
                return relayHealthy;
            }
            directProbes++;
            return false;
        };
        contents.getURL = () => 'https://soundcloud.com/discover';
        contents.loadURL = async () => {
            reloads++;
        };
        await recovery.configure();
        recovery.policy.now = () => now;
        await recovery.recover();
        assert.equal(recovery.routed, true);
        assert.equal(reloads, 1);

        const directSession = session.fromPartition('network-ru-source');
        await directSession.setProxy({ mode: 'direct' });
        const body = JSON.stringify({
            result: { title: 'RU playlist', trackCount: 1, tracks: [{ title: 'Song', artists: [{ name: 'Artist' }] }] },
        });
        let workerReads = 0;
        const sourceNetwork = new PlaylistSourceNetwork(async (url) => {
            assert.equal(await directSession.resolveProxy(url), 'DIRECT');
            return new Response(url.includes('/cdn-cgi/trace') ? 'loc=RU\n' : body);
        });
        const source = await loadSourcePlaylist('https://music.yandex.ru/playlists/test', undefined, {
            preferRelay: true,
            country: await sourceNetwork.country(),
            direct: (url, cancel, init) => sourceNetwork.load(url, cancel, init),
            relay: async () => {
                workerReads++;
                return body;
            },
        });
        assert.equal(source.tracks.length, 1);
        assert.equal(workerReads, 0);
        assert.equal(await contents.session.resolveProxy('https://soundcloud.com'), 'PROXY 127.0.0.1:54322');

        now += 120001;
        const probesBeforeFailure = relayProbes;
        contents.emit('did-fail-load', {}, -101, 'ERR_CONNECTION_RESET', 'https://soundcloud.com/discover', true);
        for (let i = 0; i < 200 && reloads < 2; i++) await wait(10);
        assert.equal(reloads, 2, 'a failed page recovers even after Worker routing was already enabled');
        assert.equal(relayProbes, probesBeforeFailure + 1);
        assert.equal(directProbes, 1, 'an already routed client does not silently switch to the blocked direct route');

        await contents.executeJavaScript(
            'document.body.innerHTML=\'<button class="playControls__play playing"></button>\'',
        );
        now += 120001;
        await recovery.recover();
        assert.equal(reloads, 2, 'playing audio is not interrupted');
        assert.equal(relayProbes, probesBeforeFailure + 1);
        await contents.executeJavaScript("document.querySelector('button').classList.remove('playing')");
        relayHealthy = false;
        await recovery.recover();
        assert(recovery.timer, 'an unavailable Worker schedules a bounded retry');
        const failedProbes = relayProbes;
        await Promise.all([recovery.recover(), recovery.recover(), recovery.recover()]);
        assert.equal(relayProbes, failedProbes, 'repeated failures obey cooldown without a request storm');
        now += 120001;
        relayHealthy = true;
        await recovery.recover();
        assert.equal(reloads, 3, 'the Worker can recover after a temporary outage');

        values.set('cloudflareMode', 'always');
        relayHealthy = false;
        await recovery.configure();
        assert(recovery.timer, 'a failed always-Worker startup is not abandoned permanently');
        recovery.policy.now = () => now;
        relayHealthy = true;
        const directBeforeAlways = directProbes;
        await recovery.recover();
        assert.equal(recovery.routed, true);
        assert.equal(directProbes, directBeforeAlways, 'always-Worker recovery keeps the explicit routing choice');

        const execute = contents.executeJavaScript.bind(contents);
        contents.executeJavaScript = () => new Promise(() => {});
        now += 120001;
        const reloadsBeforeSuspension = reloads;
        const began = Date.now();
        await recovery.recover();
        assert(Date.now() - began < 2000, 'a suspended page cannot block the recovery controller');
        assert.equal(reloads, reloadsBeforeSuspension, 'unknown playback state defers disruptive recovery');
        contents.executeJavaScript = execute;
        values.set('cloudflareMode', 'off');
        await recovery.configure();
        assert.equal(recovery.routed, false);
        assert.equal(await contents.session.resolveProxy('https://soundcloud.com'), 'DIRECT');
        const result = {
            ruPlaylistKeepsSoundCloudWorker: true,
            routedFailureRecovered: true,
            workerOutageRetry: true,
            alwaysStartupRetry: true,
            cooldownRespected: true,
            playingPreserved: true,
            suspendedPageBounded: true,
        };
        fs.writeFileSync(path.join(out, 'recovery.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        window.destroy();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        window.destroy();
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 20000).unref();
