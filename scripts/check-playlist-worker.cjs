const { Miniflare, Log, LogLevel, createFetchMock } = require(process.env.WORKER_RUNTIME_MODULE || 'miniflare');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict'),
    crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'),
    folder = path.join(root, 'cloudflare/soundcloud-relay'),
    secret = crypto.randomBytes(32).toString('hex');
const id = '37i9dQZF1DXcBWIGoYBM5M',
    source = 'https://open.spotify.com/embed/playlist/' + id,
    album = 'https://open.spotify.com/embed/album/4aawyAB9vmqN3uQ7FjRGTy';
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
const youtubeClient = { clientName: 'WEB', clientVersion: '2.20261027.01.00', hl: 'en', gl: 'US' };
const youtubeItems = (offset, count, token) => [
    ...Array.from({ length: count }, (_, index) => ({
        playlistVideoRenderer: {
            videoId: 'video-' + (offset + index),
            title: { simpleText: 'Song ' + (offset + index) },
            shortBylineText: { simpleText: 'Artist' },
        },
    })),
    ...(token ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } }] : []),
];
const youtubeBody =
    '<script>ytcfg.set(' +
    JSON.stringify({ INNERTUBE_CONTEXT: { client: youtubeClient } }) +
    ');var ytInitialData = ' +
    JSON.stringify({
        metadata: { playlistMetadataRenderer: { title: 'Paged playlist' } },
        contents: { playlistVideoListRenderer: { contents: youtubeItems(0, 100, 'second') } },
    }) +
    ';</script>';
(async () => {
    let runtime;
    try {
        const mock = createFetchMock();
        mock.disableNetConnect();
        mock.get('https://open.spotify.com')
            .intercept({ path: '/embed/playlist/' + id, method: 'GET' })
            .reply(200, body, { headers: { 'content-type': 'text/html' } });
        mock.get('https://open.spotify.com')
            .intercept({ path: new URL(album).pathname, method: 'GET' })
            .reply(200, body, { headers: { 'content-type': 'text/html' } })
            .times(process.argv.includes('--electron') ? 2 : 1);
        mock.get('https://www.youtube.com')
            .intercept({
                path: '/youtubei/v1/browse',
                method: 'POST',
            })
            .reply(
                200,
                JSON.stringify({
                    onResponseReceivedActions: [
                        { appendContinuationItemsAction: { continuationItems: youtubeItems(100, 100, 'third') } },
                    ],
                }),
                { headers: { 'content-type': 'application/json' } },
            );
        mock.get('https://www.youtube.com')
            .intercept({
                path: '/youtubei/v1/browse',
                method: 'POST',
            })
            .reply(
                200,
                JSON.stringify({
                    onResponseReceivedActions: [
                        { appendContinuationItemsAction: { continuationItems: youtubeItems(200, 108) } },
                    ],
                }),
                { headers: { 'content-type': 'application/json' } },
            );
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
        url.searchParams.set('url', album);
        const albumResponse = await fetch(url, { headers: { Authorization: 'Bearer ' + secret } });
        assert.equal(albumResponse.status, 200);
        assert.equal(albumResponse.headers.get('x-soundcloud-playlist-relay-revision'), '5');
        assert.equal(await albumResponse.text(), body);
        const { loadYouTubePages } = require(path.join(root, 'tsc/import/youtubePagination'));
        const continuationResponses = [];
        const youtube = await loadYouTubePages(
            youtubeBody,
            'https://www.youtube.com/playlist?list=PL_fixture_playlist',
            async (target, signal, init) => {
                const endpoint = new URL('/playlist-source', base);
                endpoint.searchParams.set('url', target);
                const response = await fetch(endpoint, {
                    method: init?.method || 'GET',
                    body: init?.body,
                    signal,
                    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
                });
                continuationResponses.push({
                    status: response.status,
                    upstream: response.headers.get('x-playlist-source-status'),
                    message: response.status === 200 ? 'ok' : await response.text(),
                });
                assert.equal(response.status, 200);
                return response.text();
            },
        );
        assert.equal(
            youtube.tracks.length,
            308,
            JSON.stringify({ continuationResponses, reason: youtube.partialReason }),
        );
        assert.equal(youtube.partial, false);
        console.log(
            JSON.stringify({
                actualWorkerd: true,
                productionModules: 3,
                publicMetadataForwarding: true,
                spotifyAlbumForwarding: true,
                youtubeContinuationTracks: youtube.tracks.length,
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
                for (const resource of [source, album]) {
                    const target = new URL('/playlist-source', await live.ready);
                    target.searchParams.set('url', resource);
                    const response = await fetch(target, { headers: { Authorization: 'Bearer ' + secret } });
                    if (!response.ok)
                        throw new Error(
                            'Public source relay: ' +
                                JSON.stringify({
                                    status: response.status,
                                    headers: Object.fromEntries(response.headers),
                                    body: (await response.text()).slice(0, 400),
                                }),
                        );
                    assert.equal(
                        response.status,
                        200,
                        'Public source status: ' + response.headers.get('x-playlist-source-status'),
                    );
                    const playlist = require(path.join(root, 'tsc/import/source')).parseSpotifyEmbed(
                        await response.text(),
                    );
                    assert(playlist.tracks.length > 0);
                    if (resource === album) assert.equal(playlist.title, 'Global Warming');
                    console.log(
                        JSON.stringify({
                            actualWorkerd: true,
                            realPublicSpotify: true,
                            resource: resource === album ? 'album' : 'playlist',
                            sourceTracks: playlist.tracks.length,
                            partial: playlist.partial,
                        }),
                    );
                }
                const youtube = 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';
                const request = async (resource, signal, init) => {
                    const target = new URL('/playlist-source', await live.ready);
                    target.searchParams.set('url', resource);
                    const response = await fetch(target, {
                        method: init?.method || 'GET',
                        body: init?.body,
                        signal: signal
                            ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
                            : AbortSignal.timeout(25000),
                        headers: {
                            Authorization: 'Bearer ' + secret,
                            ...(init ? { 'Content-Type': 'application/json' } : {}),
                        },
                    });
                    if (!response.ok)
                        throw new Error(
                            'YouTube relay: ' +
                                JSON.stringify({
                                    status: response.status,
                                    headers: Object.fromEntries(response.headers),
                                    body: (await response.text()).slice(0, 400),
                                }),
                        );
                    return response.text();
                };
                const playlist = await require(path.join(root, 'tsc/import/youtubePagination')).loadYouTubePages(
                    await request(youtube),
                    youtube,
                    request,
                );
                assert(playlist.tracks.length > 100 && !playlist.partial, 'Live YouTube continuation must finish');
                console.log(
                    JSON.stringify({
                        actualWorkerd: true,
                        realPublicYouTube: true,
                        sourceTracks: playlist.tracks.length,
                        pages: playlist.pagesRead,
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
