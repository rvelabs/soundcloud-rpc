const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const { createHttpsFixture } = require('./helpers/https-fixture.cjs');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..'),
    out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-import-flow');
const profile = path.join(out, 'import-flow-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const progress = (stage, extra = {}) =>
    fs.appendFileSync(path.join(out, 'import-flow-progress.jsonl'), JSON.stringify({ stage, ...extra }) + '\n');
process.on('uncaughtException', (error) => {
    fs.writeFileSync(path.join(out, 'import-flow-error.txt'), error.stack || error.message);
    fs.writeSync(2, (error.stack || error.message) + '\n');
    app.exit(1);
});
app.whenReady().then(async () => {
    let win, fixture;
    try {
        const { loadSourcePlaylist } = require(path.join(repo, 'tsc/import/loadSource')),
            { fetchSourceRelay } = require(path.join(repo, 'tsc/import/sourceRelay'));
        const { saveImportSelection } = require(path.join(repo, 'tsc/import/saveSelection'));
        const { createSoundCloudPlaylist, addSoundCloudPlaylistTrack, PlaylistWriteError } = require(
            path.join(repo, 'tsc/import/nativePlaylist'),
        );
        const routes = [],
            requests = [],
            playlist = { created: false, title: '', tracks: [] };
        session.defaultSession.protocol.handle('https', () => new Response('Local source blocked', { status: 451 }));
        progress('source-start');
        const source = await loadSourcePlaylist('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', undefined, {
            relay: (url, signal) =>
                fetchSourceRelay(
                    'https://fixture.workers.dev',
                    process.env.WAVE_PLAYLIST_RELAY_KEY,
                    url,
                    (input, init) => {
                        const requested = new URL(input),
                            destination = new URL(
                                '/playlist-source' + requested.search,
                                process.env.WAVE_PLAYLIST_RELAY_URL,
                            );
                        return session.defaultSession.fetch(destination.href, init);
                    },
                    signal,
                ),
            onRoute: (route) => routes.push(route),
        });
        assert.deepEqual(routes, ['direct', 'relay']);
        progress('source-loaded');
        assert.equal(source.title, 'Cross border mix');
        assert.equal(source.tracks.length, 7);
        fixture = await createHttpsFixture(
            profile,
            ['soundcloud.com', 'api-v2.soundcloud.com'],
            (request, response) => {
                const url = new URL(request.url, 'https://' + request.headers.host);
                if (url.hostname === 'api-v2.soundcloud.com') {
                    response.setHeader('Access-Control-Allow-Origin', 'https://soundcloud.com');
                    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
                    response.setHeader('Access-Control-Allow-Methods', 'POST,PUT,OPTIONS');
                    if (request.method === 'OPTIONS') {
                        response.writeHead(204);
                        response.end();
                        return;
                    }
                    let body = '';
                    request.on('data', (chunk) => (body += chunk));
                    request.on('end', () => {
                        const data = JSON.parse(body),
                            status = data.track === 'removed' ? 403 : data.track === 'save-fails' ? 503 : 200;
                        requests.push({ method: request.method, track: data.track, status });
                        setTimeout(() => {
                            response.writeHead(status, { 'content-type': 'application/json' });
                            if (status === 200) {
                                playlist.created = true;
                                playlist.title = data.title;
                                if (!playlist.tracks.includes(data.track)) playlist.tracks.push(data.track);
                            }
                            response.end(
                                JSON.stringify(
                                    status === 200
                                        ? { id: 123 }
                                        : { errors: [{ message: 'Fixture track write rejected' }] },
                                ),
                            );
                        }, 100);
                    });
                    return;
                }
                if (url.pathname.startsWith('/search')) {
                    response.writeHead(404);
                    response.end('Search must not be needed');
                    return;
                }
                const track = url.pathname.split('/').pop(),
                    saved = playlist.tracks.includes(track);
                response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
                response.end(`<!doctype html><meta charset="utf-8"><div class="listenEngagement"><button class="sc-button-addtoset">Add to playlist</button></div><script>
    const track=${JSON.stringify(track)},exists=${playlist.created},title=${JSON.stringify(playlist.title)},saved=${saved};
    const root=()=>document.querySelector('.modal');
    function show(){document.body.insertAdjacentHTML('beforeend','<div class="modal"><button class="modal__closeButton">Close</button><div class="addToPlaylistTabs"><button class="tabs__tab">Add to playlist</button><button class="tabs__tab">Create a playlist</button></div><div class="panel"></div></div>');root().querySelector('.modal__closeButton').onclick=()=>root().remove();root().querySelectorAll('.tabs__tab')[0].onclick=list;root().querySelectorAll('.tabs__tab')[1].onclick=form;list();}
    function list(){root().querySelector('.panel').innerHTML=exists?'<div class="addToPlaylistList__item"><a class="addToPlaylistItem__titleLink"></a><button class="addToPlaylistButton '+(saved?'sc-button-selected':'')+'">'+(saved?'Added':'Add')+'</button></div>':'';if(!exists)return;root().querySelector('a').textContent=title;root().querySelector('.addToPlaylistButton').onclick=async()=>{const button=root().querySelector('.addToPlaylistButton');button.classList.add('sc-button-selected');const response=await fetch('https://api-v2.soundcloud.com/playlists/123',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,track})});if(!response.ok){button.classList.remove('sc-button-selected');return;}button.textContent='Added';};}
    function form(){root().querySelector('.panel').innerHTML='<div class="createPlaylist"><div class="createPlaylist__title"><input></div><div class="createPlaylist__sharing"><label data-radio-value="private"><input type="radio" name="privacy" value="private">Private</label></div><button class="createPlaylist__saveButton">Save</button></div>';root().querySelector('.createPlaylist__saveButton').onclick=async()=>{const name=root().querySelector('.createPlaylist__title input').value;const response=await fetch('https://api-v2.soundcloud.com/playlists',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:name,track})});if(response.ok)root().remove();};}
    document.querySelector('.sc-button-addtoset').onclick=show;
   </script>`);
            },
        );
        const target = session.fromPartition('import-write-fixture');
        await fixture.apply(target);
        win = new BrowserWindow({
            show: false,
            webPreferences: { session: target, sandbox: true, backgroundThrottling: false },
        });
        win.webContents.setAudioMuted(true);
        const matches = source.tracks.map((item) =>
            item.title.startsWith('missing')
                ? { source: item }
                : {
                      source: item,
                      soundcloud: {
                          url: 'https://soundcloud.com/fixture/' + item.title,
                          title: item.title,
                          artist: item.artist,
                          score: 1,
                          sourceQuery: 'search would fail',
                          availability: { status: 'available', reason: 'fresh scan', checkedAt: Date.now() },
                      },
                  },
        );
        const result = await saveImportSelection(matches, {
            check: async (url) => ({
                status: url.endsWith('region-blocked')
                    ? 'blocked'
                    : url.endsWith('timed-out-recheck')
                      ? 'unknown'
                      : 'available',
                reason: 'fixture',
                checkedAt: Date.now(),
            }),
            create: (item) =>
                createSoundCloudPlaylist(
                    win.webContents,
                    source.title,
                    item.soundcloud.url,
                    item.soundcloud.sourceQuery,
                ),
            add: (item) =>
                addSoundCloudPlaylistTrack(
                    win.webContents,
                    source.title,
                    item.soundcloud.url,
                    item.soundcloud.sourceQuery,
                ),
            concurrency: 3,
            stopOnError: (error) => error instanceof PlaylistWriteError && error.fatal,
            progress: (stage, completed, total) => progress(stage, { completed, total }),
        });
        assert(playlist.created);
        assert.equal(playlist.title, source.title);
        assert.deepEqual(playlist.tracks, ['saved-one', 'timed-out-recheck']);
        assert.equal(result.added, 2);
        assert.equal(result.failures.length, 3);
        assert.deepEqual(
            requests.map((item) => item.track),
            ['removed', 'saved-one', 'timed-out-recheck', 'save-fails'],
        );
        const report = {
            actualElectron: true,
            actualWorkerd: true,
            blockedDirectSource: true,
            relaySourceLoaded: true,
            sourceTracks: 7,
            savedTracks: result.added,
            failedOrBlocked: result.failures.length,
            notFound: matches.filter((item) => !item.soundcloud).length,
            partialPlaylistConfirmed: true,
            optimisticFailedWriteRejected: true,
            canonicalTrackPages: true,
        };
        fs.writeFileSync(path.join(out, 'import-flow.json'), JSON.stringify(report, null, 2));
        fs.writeSync(1, JSON.stringify(report) + '\n');
        app.exit(0);
    } catch (error) {
        fs.writeFileSync(path.join(out, 'import-flow-error.txt'), error.stack || error.message);
        fs.writeSync(2, error.stack + '\n');
        app.exit(1);
    } finally {
        if (win && !win.isDestroyed()) win.destroy();
        fixture?.close();
    }
});
setTimeout(() => {
    console.error('Import flow deadline');
    app.exit(2);
}, 50000).unref();
