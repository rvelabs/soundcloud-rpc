const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-controllers');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile-' + Date.now()));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    let window, wave, importer;
    try {
        const network = session.fromPartition('controller-fixture-' + Date.now());
        await network.protocol.handle('https', async (request) => {
            if (/\/a\/song-\d+$/.test(new URL(request.url).pathname)) {
                await wait(100);
                return new Response(
                    '<script>window.__sc_hydration=' +
                        JSON.stringify([
                            {
                                data: {
                                    permalink_url: request.url,
                                    streamable: true,
                                    state: 'finished',
                                    policy: 'ALLOW',
                                    media: { transcodings: [{ format: { protocol: 'hls' } }] },
                                },
                            },
                        ]) +
                        ';</script>',
                );
            }
            return new Response(
                '<!doctype html><main id="content"><div class="l-main"><div class="l-content"></div></div></main>',
            );
        });
        window = new BrowserWindow({
            show: false,
            webPreferences: {
                session: network,
                sandbox: false,
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false,
                preload: path.join(root, 'tsc/preload.js'),
            },
        });
        const contents = window.webContents;
        const values = new Map();
        const tracks = Array.from({ length: 32 }, (_, i) => ({
            artist: 'A',
            title: 'Song ' + i,
            durationSeconds: 180,
        }));
        values.set('importJobV1_qa', {
            id: 'saved-job',
            updatedAt: Date.now(),
            source: {
                platform: 'spotify',
                title: 'Partial',
                partial: false,
                tracks,
            },
            matches: tracks.map((source, i) => ({
                source,
                soundcloud: {
                    url: `https://soundcloud.com/a/song-${i}`,
                    title: source.title,
                    artist: 'A',
                    score: 1,
                    sourceQuery: source.title,
                    durationSeconds: 180,
                },
            })),
        });
        const writes = [];
        const store = {
            get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
            set: (key, value) => {
                writes.push(key);
                values.set(key, structuredClone(value));
            },
            delete: (key) => values.delete(key),
        };
        const trusted = (event) =>
            event.sender === contents && event.senderFrame?.url.startsWith('https://soundcloud.com/');
        const { ImportJournal } = require(path.join(root, 'tsc/import/importJournal.js'));
        const seed = values.get('importJobV1_qa');
        const journal = new ImportJournal(store, 'qa');
        const job = journal.begin(seed.source);
        job.matches = seed.matches;
        journal.save(job);
        journal.dispose();
        let track = {
            title: '',
            author: '',
            artwork: '',
            duration: '',
            elapsed: '',
            isPlaying: false,
            isLiked: false,
            url: '',
        };
        const common = {
            window,
            contents,
            libraryStore: store,
            account: 'qa',
            userAgent: contents.getUserAgent(),
            trusted,
            availabilityRoute: () => 'local-fixture',
            trace() {},
        };
        const { createWaveController } = require(path.join(root, 'tsc/wave/waveController.js'));
        const { createPlaylistImportController } = require(path.join(root, 'tsc/import/playlistImportController.js'));
        const listeners = {
            load: contents.listenerCount('did-finish-load'),
            input: contents.listenerCount('before-input-event'),
        };
        importer = createPlaylistImportController({
            ...common,
            playing: () => wave?.active || false,
            connection: () => ({}),
            russian: () => false,
        });
        const waveOptions = {
            ...common,
            store,
            getTrack: () => track,
            setTrack: (value) => {
                track = value;
            },
            quitting: () => false,
            events: () => [],
            importDiagnostics: () => importer.diagnostics(),
            languageChanged() {},
        };
        wave = createWaveController(waveOptions);
        await contents.loadURL('https://soundcloud.com/discover');
        assert.equal(
            await contents.executeJavaScript('(async()=> (await playlistImporter.draft()).matches.length)()'),
            32,
        );
        const state = await contents.executeJavaScript(
            `(async()=>{
            window.progress=[];playlistImporter.onProgress(value=>{progress.push(value);if(value.phase==='matching'&&value.completed>0)playlistImporter.cancel()});
            try { await playlistImporter.resume(); return { canceled:false }; }
            catch(error) { return {canceled:/отмен/.test(error.message),progress:progress.filter(value=>value.phase==='matching'&&value.completed>0).length}; }
        })()`,
            true,
        );
        assert(state.canceled && state.progress > 0, JSON.stringify(state));
        const saved = values.get('importJobV1_qa');
        const checked = saved.matches.filter((match) => match.soundcloud?.availability?.status === 'available').length;
        assert(checked > 0 && checked < 32, 'cancellation flushes completed rows: ' + checked);
        await contents.executeJavaScript("playlistImporter.selection({indexes:[0],title:'Keep partial'})");
        await wait(50);
        importer.dispose();
        wave.stop();
        assert.equal(values.get('importJobV1_qa').title, 'Keep partial');
        assert.equal(contents.listenerCount('did-finish-load'), listeners.load);
        assert.equal(contents.listenerCount('before-input-event'), listeners.input);
        for (const channel of ['wave-inline:ready', 'playlist-import:draft']) {
            ipcMain.handle(channel, () => null);
            ipcMain.removeHandler(channel);
        }
        wave = createWaveController(waveOptions);
        assert.equal(await contents.executeJavaScript('(async()=> (await waveInline.ready()).active)()'), false);
        wave.stop();
        const result = {
            standaloneControllers: true,
            canceledImportFlushed: true,
            completedRows: checked,
            selectionPreserved: true,
            ipcHandlersReleased: true,
            listenersReleased: true,
            waveCanBeRecreated: true,
        };
        fs.writeFileSync(path.join(out, 'controllers.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        window.destroy();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        importer?.dispose();
        wave?.stop();
        window?.destroy();
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 20000).unref();
