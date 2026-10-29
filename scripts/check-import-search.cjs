const { app, BrowserWindow, session, webContents } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-import-search');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'isolated-' + Date.now()));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    let parent;
    try {
        const { PlaylistSourceNetwork } = require(path.join(repo, 'tsc/import/sourceNetwork'));
        const { PlaylistSourceReader } = require(path.join(repo, 'tsc/import/sourceReader'));
        const { PublicSoundCloudSearch } = require(path.join(repo, 'tsc/import/publicSearch'));
        const { mapImportTracks } = require(path.join(repo, 'tsc/import/parallel'));
        const titles = ['Новый день', 'Чужой район', 'Только превью'];
        const body = JSON.stringify({ result: { title: 'Original collection', trackCount: 3, tracks: titles.map((title) => ({ title, artists: [{ name: '1.klas$' }], durationMs: 180000 })) } });
        const direct = session.fromPartition('import-direct-fixture');
        let country = 'RU', directReads = 0, workerReads = 0;
        await direct.protocol.handle('https', (request) => {
            if (new URL(request.url).pathname === '/cdn-cgi/trace') return new Response('colo=FRA\nloc=' + country + '\n');
            directReads++;
            return new Response(body);
        });
        const connection = { canLoadPlaylistSource: () => true, loadPlaylistSource: async () => { workerReads++; return body; } };
        parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        const options = { parent, account: 'isolated', connection, relayFirst: () => true, russian: () => true, progress() {} };
        const source = await new PlaylistSourceReader({ ...options, network: new PlaylistSourceNetwork(direct.fetch.bind(direct)) }).read('https://music.yandex.ru/playlists/test-list', new AbortController().signal);
        assert.equal(workerReads, 0, 'Russian IP bypasses Worker-first');
        assert.equal(directReads, 1);
        country = 'DE';
        await new PlaylistSourceReader({ ...options, network: new PlaylistSourceNetwork(direct.fetch.bind(direct)) }).read('https://music.yandex.ru/playlists/test-list', new AbortController().signal);
        assert.equal(workerReads, 1, 'non-Russian IP retains Worker-first');
        assert.equal(directReads, 1);
        const searchSession = session.fromPartition('import-search-fixture');
        let requests = 0, browserFallbacks = 0;
        await searchSession.protocol.handle('https', (request) => {
            requests++;
            const address = new URL(request.url);
            const index = address.pathname.includes('/search/') ? titles.findIndex((title) => address.searchParams.get('q').includes(title)) : Number(address.pathname.split('/').pop());
            const title = index === 0 ? '1.Klass — ' + titles[index] : titles[index];
            if (address.pathname.includes('/search/')) return new Response(`<noscript><a href="/search/sounds">Tracks</a><h2><a href="/archive/${index}">${title}</a></h2></noscript>`);
            return new Response('window.__sc_hydration=' + JSON.stringify([{ hydratable: 'sound', data: {
                permalink_url: 'https://soundcloud.com' + address.pathname, title, user: { username: 'Archive uploader' },
                streamable: true, state: 'finished', policy: index === 2 ? 'SNIP' : 'ALLOW', duration: 180000,
                media: { transcodings: [{ format: { protocol: 'hls' } }] },
            } }]));
        });
        const before = webContents.getAllWebContents().length;
        const matcher = new PublicSoundCloudSearch(searchSession.fetch.bind(searchSession), async (track) => { browserFallbacks++; return { source: track }; }, new AbortController().signal, () => 3);
        const matched = await mapImportTracks(source.tracks, { concurrency: 3, run: (track) => matcher.match(track) });
        assert.equal(matched[0].soundcloud.requiresReview, false);
        assert.equal(matched[0].soundcloud.artist, 'Archive uploader');
        assert.equal(matched[1].soundcloud.requiresReview, true);
        assert(matched[1].soundcloud.score < 0.85);
        assert.equal(matched[2].soundcloud, undefined);
        assert.equal(browserFallbacks, 1, 'only the unmatched preview needs a fallback');
        assert.equal(webContents.getAllWebContents().length, before, 'HTTP matching creates no search renderers');
        const report = { actualElectron: true, russianIpDirect: true, foreignIpWorkerFirst: true, httpRequests: requests, originalArtistReupload: true, titleOnlyNeedsReview: true, previewRejected: true, searchRenderersCreated: 0, externalAccountsUsed: false };
        fs.writeFileSync(path.join(out, 'import-search.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        app.exit(0);
    } catch (error) { console.error(error.stack); app.exit(1); }
    finally { if (parent && !parent.isDestroyed()) parent.destroy(); }
});
setTimeout(() => app.exit(2), 20000).unref();
