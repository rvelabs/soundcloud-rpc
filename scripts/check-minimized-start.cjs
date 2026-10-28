const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-minimized-start');
const profile = path.join(out, 'minimized-start-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const url = 'https://soundcloud.com/test/next',
    seed = 'https://soundcloud.com/seed/favorite';
fs.writeFileSync(
    path.join(profile, 'config.json'),
    JSON.stringify({
        adBlocker: false,
        discordRichPresence: false,
        minimizeToTray: true,
        waveControls_default: { mood: 'any', tone: 'bass', tempo: 'any', discovery: 'new' },
        waveFeedbackV1_default: [
            { track: { id: seed, title: 'Favorite', artist: 'Seed artist' }, kind: 'like', at: Date.now() },
        ],
        waveCandidatesV2_default: {
            at: Date.now(),
            tracks: [
                {
                    url,
                    title: 'Next',
                    artist: 'New artist',
                    source: 'related',
                    relatedTo: [seed],
                    sourceRank: 0,
                    durationSeconds: 90,
                    playability: 'available',
                    catalogCheckedAt: Date.now(),
                },
            ],
        },
    }),
);
app.setPath('userData', profile);
let done = false;
process.on('uncaughtException', (error) => {
    console.error(error.stack);
    app.exit(1);
});
app.on('before-quit', (event) => {
    if (!done) event.preventDefault();
});
const audio = Buffer.alloc(44 + 44100 * 2);
audio.write('RIFF');
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(44100, 24);
audio.writeUInt32LE(88200, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(audio.length - 44, 40);
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#111;color:white}.playControls{position:fixed;bottom:0;height:50px;width:100%}</style></head><body><input class="headerSearch__input"><button class="headerSearch__submit">Search</button><main id="content"><div class="l-main"><div class="l-content"></div></div></main><div class="playControls"><button class="playControls__play"></button><a class="playbackSoundBadge__titleLink"></a></div><script>
window.audio=new Audio(${JSON.stringify('data:audio/wav;base64,' + audio.toString('base64'))});audio.loop=true;
document.querySelector('.headerSearch__submit').onclick=()=>{history.pushState({},'', '/search/sounds?q=Next');document.querySelector('main').innerHTML='<div class="sound"><a class="soundTitle__title" href="${url}">Next</a><div class="soundTitle__playButton"><button class="playButton">Play</button></div></div>';document.querySelector('.sound .playButton').onclick=()=>{document.querySelector('.playbackSoundBadge__titleLink').href='${url}';document.querySelector('.playControls__play').classList.add('playing');audio.play()};};
</script></body></html>`;
app.whenReady().then(() =>
    session.defaultSession.protocol.handle(
        'https',
        () => new Response(fixture, { headers: { 'content-type': 'text/html;charset=utf-8' } }),
    ),
);
require(path.join(repo, 'tsc/main.js'));
app.whenReady().then(async () => {
    try {
        app.emit('activate');
        app.emit('activate');
        let win, page;
        for (let i = 0; i < 200; i++) {
            win = BrowserWindow.getAllWindows().find(
                (win) => win.contentView.children.filter((view) => view.webContents).length >= 2,
            );
            page = win?.contentView.children
                .filter((view) => view.webContents)
                .find((view) => view.webContents?.getURL().startsWith('https://soundcloud.com/'));
            if (
                page &&
                (await page.webContents
                    .executeJavaScript("!!window.waveInline && !!document.querySelector('#codex-wave-inline')")
                    .catch(() => false))
            )
                break;
            await new Promise((r) => setTimeout(r, 50));
        }
        assert(page, 'main client ready');
        assert.equal(
            BrowserWindow.getAllWindows().filter(
                (window) => window.contentView.children.filter((view) => view.webContents).length >= 2,
            ).length,
            1,
            'concurrent activation creates only one client window',
        );
        const wc = page.webContents;
        const stallCapture = process.env.WAVE_TEST_CAPTURE_STALL === '1';
        if (stallCapture) {
            win.restore();
            win.showInactive();
            await new Promise((r) => setTimeout(r, 200));
        }
        let captures = 0;
        const originalCapture = wc.capturePage.bind(wc);
        wc.capturePage = (...args) => {
            captures++;
            if (stallCapture) {
                win.minimize();
                return new Promise(() => {});
            }
            return originalCapture(...args);
        };
        await wc.executeJavaScript(
            `window.waveStart=window.waveInline.start();window.waveStart.catch(error=>window.startError=error.message);true;`,
            true,
        );
        if (!stallCapture) win.minimize();
        const start = Date.now();
        let state;
        for (let i = 0; i < 100; i++) {
            state = await wc.executeJavaScript(
                `({playing:!audio.paused,time:audio.currentTime,error:window.startError,path:location.pathname})`,
            );
            if (state.playing && state.time > 0.05) break;
            if (state.error) throw Error(state.error);
            await new Promise((r) => setTimeout(r, 60));
        }
        assert(win.isMinimized() || !win.isVisible(), 'window remains minimized or in tray');
        if (stallCapture) assert(captures > 0, 'capture stalled after minimizing');
        assert(
            state.playing && state.time > 0.05,
            'audio starts before restoring the window: ' + JSON.stringify(state),
        );
        console.log(JSON.stringify({ startedWhileMinimized: true, startMs: Date.now() - start, captures, state }));
        done = true;
        if (process.env.WAVE_TEST_GRACEFUL === '1') app.quit();
        else app.exit(0);
    } catch (error) {
        console.error(error.stack);
        done = true;
        app.exit(1);
    }
});
setTimeout(() => {
    console.error('minimized-start deadline');
    done = true;
    app.exit(1);
}, 25000).unref();
