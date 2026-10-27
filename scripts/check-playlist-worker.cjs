const { Miniflare, Log, LogLevel, createFetchMock } = require(process.env.WORKER_RUNTIME_MODULE || 'miniflare');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict'),
    crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'),
    folder = path.join(root, 'cloudflare/soundcloud-relay'),
    secret = crypto.randomBytes(32).toString('hex');
const id = '37i9dQZF1DXcBWIGoYBM5M',
    source = 'https://open.spotify.com/embed/playlist/' + id;
const titles = [
    'missing-start',
    'removed',
    'saved-one',
    'region-blocked',
    'timed-out-recheck',
    'save-fails',
    'missing-end',
];
const body =
    '<script id="__NEXT_DATA__">' +
    JSON.stringify({
        props: {
            pageProps: {
                state: {
                    data: {
                        entity: {
                            name: 'Cross border mix',
                            trackList: titles.map((title) => ({ title, subtitle: 'Fixture Artist' })),
                        },
                    },
                },
            },
        },
    }) +
    '</script>';
(async () => {
    let runtime;
    try {
        const mock = createFetchMock();
        mock.disableNetConnect();
        mock.get('https://open.spotify.com')
            .intercept({ path: '/embed/playlist/' + id, method: 'GET' })
            .reply(200, body, { headers: { 'content-type': 'text/html' } })
            .times(process.argv.includes('--electron') ? 2 : 1);
        runtime = new Miniflare({
            host: '127.0.0.1',
            port: 0,
            compatibilityDate: '2026-07-30',
            log: new Log(LogLevel.ERROR),
            bindings: { RELAY_TOKEN: secret },
            fetchMock: mock,
            modulesRoot: folder,
            modules: ['worker.mjs', 'protocol.mjs', 'playlist-source.mjs'].map((name) => ({
                type: 'ESModule',
                path: path.join(folder, name),
                contents: fs.readFileSync(path.join(folder, name), 'utf8'),
            })),
        });
        const base = await runtime.ready;
        const url = new URL('/playlist-source', base);
        url.searchParams.set('url', source);
        assert.equal((await fetch(url)).status, 401);
        const blocked = new URL(url);
        blocked.searchParams.set('url', 'https://127.0.0.1/private');
        assert.equal((await fetch(blocked, { headers: { Authorization: 'Bearer ' + secret } })).status, 403);
        const response = await fetch(url, { headers: { Authorization: 'Bearer ' + secret } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-soundcloud-playlist-relay'), '1');
        assert.equal(await response.text(), body);
        console.log(
            JSON.stringify({
                actualWorkerd: true,
                productionModules: 3,
                publicMetadataForwarding: true,
                unauthorizedRejected: true,
                privateDestinationRejected: true,
            }),
        );
        if (process.argv.includes('--electron')) {
            const custom = process.env.WAVE_ELECTRON_PROBE_EXE,
                exe = custom || require('electron');
            const result = await require('node:util')
                .promisify(require('node:child_process').execFile)(
                    exe,
                    custom ? [] : [path.join(root, 'scripts/check-import-flow.cjs')],
                    {
                        cwd: root,
                        windowsHide: true,
                        timeout: 55000,
                        maxBuffer: 1024 * 1024,
                        env: {
                            ...process.env,
                            WAVE_CHECK_SCRIPT: 'check-import-flow.cjs',
                            WAVE_TEST_REPO: root,
                            WAVE_PLAYLIST_RELAY_URL: base.href,
                            WAVE_PLAYLIST_RELAY_KEY: secret,
                        },
                    },
                )
                .catch((error) => {
                    if (error.stdout) process.stdout.write(error.stdout);
                    if (error.stderr) process.stderr.write(error.stderr);
                    throw error;
                });
            process.stdout.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
        }
        mock.assertNoPendingInterceptors();
        if (process.argv.includes('--live')) {
            const live = new Miniflare({
                host: '127.0.0.1',
                port: 0,
                compatibilityDate: '2026-07-30',
                log: new Log(LogLevel.ERROR),
                bindings: { RELAY_TOKEN: secret },
                modulesRoot: folder,
                modules: ['worker.mjs', 'protocol.mjs', 'playlist-source.mjs'].map((name) => ({
                    type: 'ESModule',
                    path: path.join(folder, name),
                    contents: fs.readFileSync(path.join(folder, name), 'utf8'),
                })),
            });
            try {
                const target = new URL('/playlist-source', await live.ready);
                target.searchParams.set('url', source);
                const response = await fetch(target, { headers: { Authorization: 'Bearer ' + secret } });
                assert.equal(
                    response.status,
                    200,
                    'Public source status: ' + response.headers.get('x-playlist-source-status'),
                );
                const playlist = require(path.join(root, 'tsc/import/source')).parseSpotifyEmbed(await response.text());
                assert(playlist.tracks.length > 0);
                console.log(
                    JSON.stringify({
                        actualWorkerd: true,
                        realPublicSpotify: true,
                        sourceTracks: playlist.tracks.length,
                        partial: playlist.partial,
                    }),
                );
            } finally {
                await live.dispose();
            }
        }
    } finally {
        await runtime?.dispose();
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
