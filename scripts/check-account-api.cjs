const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const { createHttpsFixture } = require('./helpers/https-fixture.cjs');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-account-api');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'isolated-profile'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    let server, win;
    try {
        const { installSoundCloudCatalog } = require(path.join(root, 'tsc/soundcloud/catalogSession'));
        const { saveApiPlaylist } = require(path.join(root, 'tsc/soundcloud/playlistWriter'));
        const { nativeLikeBridge } = require(path.join(root, 'tsc/soundcloud/nativeLikeBridge'));
        const { WorkScheduler } = require(path.join(root, 'tsc/utils/workScheduler'));
        const id = 'A'.repeat(32),
            auth = 'OAuth isolated-account-fixture-token';
        let playlist = null,
            posts = 0,
            puts = 0,
            likes = 0,
            htmlReads = 0,
            dropUpdate = true;
        const liked = new Set(),
            calls = [];
        const track = (id) => ({
            id,
            kind: 'track',
            title: 'Track ' + id,
            permalink_url: `https://soundcloud.com/artist/t${id}`,
            user: { username: 'Artist' },
            duration: 180000,
            streamable: true,
            state: 'finished',
            policy: 'ALLOW',
            media: { transcodings: [{ format: { protocol: 'hls' } }] },
        });
        const playlistJson = () => ({
            id: 100,
            user_id: 7,
            title: 'Imported',
            tracks: playlist.ids.map((id) => ({ id })),
            track_count: playlist.ids.length,
        });
        server = await createHttpsFixture(
            path.join(out, 'https'),
            ['soundcloud.com', 'api-v2.soundcloud.com', 'api-auth.soundcloud.com'],
            (req, res) => {
                res.setHeader('Access-Control-Allow-Origin', 'https://soundcloud.com');
                res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                const url = new URL(req.url, 'https://' + req.headers.host);
                if (url.hostname === 'soundcloud.com') {
                    if (url.pathname !== '/') htmlReads++;
                    res.setHeader('Content-Type', 'text/html');
                    res.end(`<!doctype html><main>Account API fixture</main><button id="heart" aria-pressed="false">Like</button>
                <script>
                window.fixtureState={current:1,liked:new Set(),syncs:0};
                function Sound(){};Sound.prototype.resource_type='sound';
                Sound.instances={find:predicate=>{for(let id=1;id<=80;id++){const model={id,get:()=> 'https://soundcloud.com/artist/t'+id};if(predicate(model))return model}}};
                window.renderHeart=()=>document.querySelector('#heart').setAttribute('aria-pressed',String(fixtureState.liked.has(fixtureState.current)));
                const actions={notify(){},addToPlayHistory(){},like:async(model,liked,options)=>{if(options.persist!==false)throw Error('Duplicate native write');if(liked)fixtureState.liked.add(model.id);else fixtureState.liked.delete(model.id);fixtureState.syncs++;renderHeart();}};
                const runtime=Object.assign(()=>{},{c:{auth:{exports:{isLoggedIn:()=>true,currentUserId:()=>7}},sound:{exports:Sound},actions:{exports:actions}},m:{}}),pending=[];
                window.webpackJsonp=[];webpackJsonp.push=function(packet){const factories=packet[1],entries=packet[2];factories[entries[0][0]]({}, {}, runtime);return pending.push.apply(pending,[])};
                </script>`);
                    return;
                }
                if (url.hostname === 'api-auth.soundcloud.com') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                calls.push({ method: req.method, path: url.pathname });
                if (req.headers.authorization !== auth) {
                    res.writeHead(401);
                    res.end('{}');
                    return;
                }
                res.setHeader('Content-Type', 'application/json');
                const send = (value) => res.end(JSON.stringify(value));
                if (req.method === 'GET') {
                    if (url.pathname === '/me')
                        return send({ id: 7, username: 'Fixture Owner', permalink: 'fixture-owner' });
                    if (url.pathname === '/users/7/playlists')
                        return send({ collection: playlist ? [playlistJson()] : [] });
                    if (url.pathname === '/playlists/100') return send(playlistJson());
                    if (url.pathname === '/tracks')
                        return send((url.searchParams.get('ids') || '').split(',').map(Number).map(track));
                    if (url.pathname === '/resolve')
                        return send(track(Number(new URL(url.searchParams.get('url')).pathname.match(/t(\d+)$/)[1])));
                    if (url.pathname === '/users/7/track_likes')
                        return send(
                            url.searchParams.has('cursor')
                                ? { collection: [{ track: track(2) }] }
                                : {
                                      collection: [{ track: track(1) }],
                                      next_href: 'https://api-v2.soundcloud.com/users/7/track_likes?cursor=2',
                                  },
                        );
                    if (url.pathname === '/me/play-history/tracks') return send({ collection: [{ track: track(8) }] });
                    if (url.pathname === '/me/track_likes/ids') return send({ collection: [...liked] });
                    if (url.pathname === '/tracks/1/related') return send({ collection: [track(2), track(3)] });
                    if (url.pathname.startsWith('/stations/'))
                        return send({
                            collection: [
                                { ...track(4), state: undefined },
                                { ...track(5), policy: undefined },
                            ],
                        });
                }
                if (/^\/users\/7\/track_likes\/\d+$/.test(url.pathname)) {
                    const id = Number(url.pathname.split('/').pop());
                    if (req.method === 'PUT') liked.add(id);
                    else liked.delete(id);
                    likes++;
                    res.writeHead(204);
                    res.end();
                    return;
                }
                let body = '';
                req.on('data', (chunk) => (body += chunk));
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(body).playlist;
                        assert(payload.tracks.every(Number.isSafeInteger), 'playlist writes contain numeric IDs');
                        if (req.method === 'POST') {
                            assert.equal(payload.sharing, 'private');
                            posts++;
                            assert.equal(playlist, null, 'no duplicate creation');
                            playlist = { ids: payload.tracks };
                            res.writeHead(201);
                            send(playlistJson());
                            return;
                        }
                        if (req.method === 'PUT') {
                            puts++;
                            if (payload.tracks.includes(3)) {
                                res.writeHead(400);
                                res.end('{}');
                                return;
                            }
                            playlist.ids = payload.tracks;
                            if (dropUpdate) {
                                dropUpdate = false;
                                req.socket.destroy();
                                return;
                            }
                            send(playlistJson());
                            return;
                        }
                        res.writeHead(404);
                        res.end('{}');
                    } catch (error) {
                        res.writeHead(500);
                        res.end('{}');
                        console.error(error.message);
                    }
                });
            },
        );
        const network = session.fromPartition('account-api-fixture');
        await server.apply(network);
        win = new BrowserWindow({
            show: false,
            webPreferences: { session: network, sandbox: true, backgroundThrottling: false },
        });
        const scheduler = new WorkScheduler(() => ({ network: 2, page: 1 }));
        const catalog = installSoundCloudCatalog(win.webContents, scheduler, () => 'fixture');
        await win.loadURL('https://soundcloud.com/');
        await win.webContents.executeJavaScript(
            `fetch('https://api-v2.soundcloud.com/me?client_id=${id}',{headers:{Authorization:${JSON.stringify(auth)}}}).then(()=>true)`,
        );
        win.minimize();
        const personal = await catalog.personalHistory();
        assert.deepEqual(
            personal.likes.map((item) => item.id),
            [1, 2],
        );
        assert.equal(personal.recent[0].id, 8);
        const discovered = await catalog.discover(track(1).permalink_url);
        assert.deepEqual(
            discovered.map((item) => item.id),
            [2, 4, 3, 5],
        );
        const input = Array.from({ length: 65 }, (_, i) => ({
            source: { title: 'Track ' + (i + 1), artist: 'Artist' },
            soundcloud: {
                apiId: i + 1,
                url: track(i + 1).permalink_url,
                title: 'Track ' + (i + 1),
                artist: 'Artist',
                score: 1,
                sourceQuery: 'Track ' + (i + 1),
            },
        }));
        const targets = [],
            saved = [];
        const result = await saveApiPlaylist(catalog, input, {
            title: 'Imported',
            concurrency: 4,
            target: (id, user) => targets.push([id, user]),
            saved: (item) => saved.push(item.soundcloud.apiId),
            progress() {},
        });
        assert.equal(result.added, 64);
        assert.equal(result.failures.length, 1);
        assert.equal(posts, 1);
        assert(!playlist.ids.includes(3));
        assert.equal(playlist.ids.length, 64);
        assert.equal(saved.length, 64);
        assert.deepEqual(targets[0], [100, 7]);
        assert(puts < 20, 'bulk writes and rejection isolation avoid per-track dialogs');
        const resumed = await saveApiPlaylist(
            catalog,
            input.filter((item) => item.soundcloud.apiId !== 3),
            { title: 'Imported', playlistId: 100, accountId: 7, concurrency: 4, target() {}, progress() {} },
        );
        assert.equal(resumed.already, 64);
        assert.equal(resumed.added, 0);
        assert.equal(posts, 1);
        const bridge = { id: 1, accountId: 7, sync: false, liked: true };
        assert(await nativeLikeBridge(win.webContents, bridge));
        assert((await catalog.setLiked(track(1).permalink_url, true)).liked);
        assert(await nativeLikeBridge(win.webContents, { ...bridge, sync: true }));
        assert.equal(
            await win.webContents.executeJavaScript("document.querySelector('#heart').getAttribute('aria-pressed')"),
            'true',
        );
        await win.webContents.executeJavaScript('fixtureState.current=2;renderHeart();true;');
        assert.equal(
            await win.webContents.executeJavaScript("document.querySelector('#heart').getAttribute('aria-pressed')"),
            'false',
            'like does not visually leak to the next track',
        );
        assert.equal(likes, 1, 'native model sync sends no duplicate like write');
        await catalog.setLiked(track(1).permalink_url, false);
        await nativeLikeBridge(win.webContents, { ...bridge, sync: true, liked: false });
        assert(!liked.has(1));
        assert.equal(htmlReads, 0);
        assert.equal(win.webContents.getURL(), 'https://soundcloud.com/');
        await win.webContents.executeJavaScript(
            "fetch('https://api-auth.soundcloud.com/sign-out',{method:'POST'}).then(()=>true)",
        );
        assert.equal(catalog.available, false, 'native sign-out invalidates API session');
        const report = {
            actualElectron: true,
            actualHttps: true,
            minimized: true,
            accountHistory: true,
            stationHydration: true,
            playlistSaved: result.added,
            unavailableSkipped: result.failures.length,
            postCount: posts,
            putCount: puts,
            resumeById: true,
            droppedReplyRecovered: true,
            nativeLikeSynced: true,
            nextTrackLikeReset: true,
            duplicateLikeWrites: false,
            signOutClearsSession: true,
            htmlReads,
            externalAccountsUsed: false,
        };
        fs.writeFileSync(path.join(out, 'account-api.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        win.destroy();
        scheduler.dispose();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        if (win && !win.isDestroyed()) win.destroy();
        server?.close();
    }
});
setTimeout(() => app.exit(2), 60000).unref();
