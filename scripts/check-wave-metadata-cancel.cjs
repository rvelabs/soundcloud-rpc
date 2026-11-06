const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const output = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-wave-metadata-cancel');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile-' + Date.now()));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    let window, wave;
    const originalFetch = global.fetch;
    try {
        let fallbackReads = 0;
        global.fetch = async () => {
            fallbackReads++;
            return new Response('');
        };
        const network = session.fromPartition('metadata-cancel-fixture');
        await network.protocol.handle(
            'https',
            () =>
                new Response(
                    '<!doctype html><main>' +
                        Array.from(
                            { length: 8 },
                            (_, i) =>
                                `<article class="sound"><a class="soundTitle__title" href="https://soundcloud.com/artist/song-${i}">Song ${i}</a><span class="soundTitle__username">Artist ${i}</span></article>`,
                        ).join('') +
                        '</main>',
                    { headers: { 'content-type': 'text/html' } },
                ),
        );
        window = new BrowserWindow({
            show: false,
            webPreferences: { session: network, sandbox: true, backgroundThrottling: false },
        });
        const contents = window.webContents,
            values = new Map(),
            pending = [];
        const store = {
            get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
            set: (key, value) => values.set(key, value),
        };
        const catalog = {
            available: true,
            resolve: () => new Promise((resolve) => pending.push(resolve)),
            batch: async () => [],
        };
        const { createWaveController } = require(path.join(root, 'tsc/wave/waveController'));
        wave = createWaveController({
            catalog,
            window,
            contents,
            store,
            libraryStore: store,
            account: 'metadata-cancel',
            userAgent: contents.getUserAgent(),
            getTrack: () => ({
                title: '',
                author: '',
                artwork: '',
                elapsed: '',
                duration: '',
                url: '',
                isPlaying: false,
                isLiked: false,
            }),
            setTrack() {},
            trusted: () => false,
            quitting: () => false,
            availabilityRoute: () => 'fixture',
            languageChanged() {},
            events: () => [],
            importDiagnostics() {},
            trace() {},
        });
        await contents.loadURL('https://soundcloud.com/discover');
        for (let n = 0; n < 40 && !pending.length; n++) await wait(100);
        assert.ok(pending.length > 0, 'metadata lookup started before shutdown');
        wave.stop();
        pending.forEach((resolve) => resolve(null));
        await wait(400);
        assert.equal(fallbackReads, 0, 'late API result must not start a public fetch after stop');
        const report = { delayedMetadataReads: pending.length, fallbackReadsAfterStop: fallbackReads };
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        window.destroy();
        global.fetch = originalFetch;
        app.exit(0);
    } catch (error) {
        global.fetch = originalFetch;
        console.error(error.stack);
        wave?.stop();
        window?.destroy();
        app.exit(1);
    }
});
