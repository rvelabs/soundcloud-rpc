const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-source-pagination');
const profile = path.join(out, 'profile-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_, window) => window.on('show', () => window.hide()));
const id = (index) => String(index).padStart(22, '0');
const initial = {
    platform: 'spotify',
    title: 'Large playlist',
    partial: true,
    tracks: Array.from({ length: 100 }, (_, index) => ({
        title: 'Song ' + index,
        artist: 'Artist ' + index,
        sourceId: 'spotify:track:' + id(index),
    })),
};
const address = 'https://open.spotify.com/playlist/' + id(9999);
const fixture = (
    total,
    restricted,
) => `<!doctype html><style>#scroll{height:450px;overflow:auto}#grid{position:relative;height:${total * 30 + 30}px}.row{height:30px;position:absolute;left:0}</style><main><h1>Large playlist</h1><p>${total} songs</p><button data-testid="login-button">Log in</button><div id="scroll"><div id="grid" role="grid" aria-rowcount="${total + 1}"><div role="columnheader">Title</div></div></div></main><script>
let unlocked=${!restricted};const scroll=document.querySelector('#scroll'),grid=document.querySelector('#grid');
function render(){grid.querySelectorAll('.row').forEach(row=>row.remove());const begin=unlocked?Math.floor(scroll.scrollTop/30):0;const end=unlocked?Math.min(${total},begin+45):10;for(let i=begin;i<end;i++){const row=document.createElement('div');row.className='row';row.dataset.testid='tracklist-row';row.setAttribute('role','row');row.setAttribute('aria-rowindex',i+2);row.style.top=(i*30+30)+'px';row.innerHTML='<a href="/track/'+String(i).padStart(22,'0')+'">Song '+i+'</a><a href="/artist/'+String(i).padStart(22,'0')+'">Artist '+i+'</a><span>3:00</span>';grid.append(row)}}
scroll.onscroll=render;document.querySelector('button').onclick=()=>{unlocked=true;scroll.scrollTop=0;render()};render();</script>`;
app.whenReady().then(async () => {
    const { collectSpotifyRows, completeSpotifyPlaylist } = require(path.join(repo, 'tsc/import/spotifyBrowser'));
    let parent, reader;
    try {
        parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
        reader = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
        await session.defaultSession.protocol.handle(
            'https',
            () => new Response(fixture(308, false), { headers: { 'Content-Type': 'text/html' } }),
        );
        await reader.loadURL(address);
        const publicList = await collectSpotifyRows(reader.webContents, initial, undefined, Date.now() + 20000);
        assert.equal(publicList.playlist.tracks.length, 308);
        assert.equal(
            publicList.playlist.partial,
            false,
            JSON.stringify({ ...publicList.playlist, tracks: publicList.playlist.tracks.length }),
        );
        assert.equal(publicList.playlist.tracks[0].title, 'Song 0');
        assert.equal(publicList.playlist.tracks.at(-1).title, 'Song 307');
        reader.destroy();
        reader = undefined;
        const account = 'refusal-' + Date.now();
        await session
            .fromPartition('persist:spotify-import-' + account)
            .protocol.handle(
                'https',
                () => new Response(fixture(308, true), { headers: { 'Content-Type': 'text/html' } }),
            );
        let asked = 0;
        const routes = [];
        const declined = await completeSpotifyPlaylist(initial, address, {
            parent,
            account,
            russian: false,
            configure: async (_target, force) => {
                routes.push(force);
                return false;
            },
            ask: async () => {
                asked++;
                return false;
            },
        });
        assert.equal(asked, 1);
        assert.deepEqual(routes, [false], 'do not reread a reachable authorization-limited playlist through another route');
        assert.equal(declined.partial, true);
        assert.equal(declined.tracks.length, 100);
        assert.equal(BrowserWindow.getAllWindows().length, 1, 'source window released after refusal');
        const loginAccount = 'login-' + Date.now();
        await session
            .fromPartition('persist:spotify-import-' + loginAccount)
            .protocol.handle(
                'https',
                () => new Response(fixture(124, true), { headers: { 'Content-Type': 'text/html' } }),
            );
        const signedIn = await completeSpotifyPlaylist(initial, address, {
            parent,
            account: loginAccount,
            russian: false,
            ask: async () => true,
        });
        assert.equal(signedIn.partial, false);
        assert.equal(signedIn.tracks.length, 124);
        assert.equal(BrowserWindow.getAllWindows().length, 1, 'source window released after completion');
        const blockedAccount = 'blocked-' + Date.now();
        await session.fromPartition('persist:spotify-import-' + blockedAccount).protocol.handle('https', () => Response.error());
        const began = Date.now();
        const blocked = await completeSpotifyPlaylist(initial, address, { parent, account: blockedAccount, russian: false, configure: async () => false,
            ask: async () => { throw Error('Do not ask for login when the network failed'); } });
        assert.equal(blocked.tracks.length, 100);
        assert.equal(blocked.partialReason, 'network');
        assert(Date.now() - began < 4000, 'an explicit navigation failure must not consume the full 12-second scan');
        assert.equal(BrowserWindow.getAllWindows().length, 1);
        const result = {
            actualElectron: true,
            publicVirtualizedTracks: 308,
            optionalLoginTracks: 124,
            refusalPreservesTracks: declined.tracks.length,
            sourceWindowsReleased: true,
            externalAccountsUsed: false,
            blockedNavigationReturnsPromptly: true,
        };
        fs.writeFileSync(path.join(out, 'source-pagination.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        parent.destroy();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        reader?.destroy();
        parent?.destroy();
        app.exit(1);
    }
});
setTimeout(() => {
    console.error('source pagination deadline');
    app.exit(2);
}, 65000).unref();
