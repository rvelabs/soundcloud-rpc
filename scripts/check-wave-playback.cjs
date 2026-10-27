const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-wave-playback');
const profile = path.join(out, 'profile-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const ids = ['one', 'two', 'three', 'four'];
const seed = 'https://soundcloud.com/seed/favorite';
fs.writeFileSync(
    path.join(profile, 'config.json'),
    JSON.stringify({
        adBlocker: false,
        discordRichPresence: false,
        minimizeToTray: true,
        waveQueueUnavailableV17_2_default: Date.now(),
        waveControls_default: { mood: 'any', tone: 'bass', tempo: 'any', discovery: 'new' },
        waveFeedbackV1_default: [
            { track: { id: seed, title: 'Favorite', artist: 'Seed' }, kind: 'like', at: Date.now() - 7 * 86400000 },
        ],
        waveCandidatesV2_default: {
            at: Date.now(),
            tracks: ids.map((id, index) => ({
                url: 'https://soundcloud.com/artist/' + id,
                title: id,
                artist: 'Artist ' + index,
                genre: 'ambient',
                source: 'related',
                relatedTo: [seed],
                sourceRank: index,
                durationSeconds: 90,
                playability: 'available',
                catalogCheckedAt: Date.now(),
            })),
        },
    }),
);
const rate = 8000,
    frames = rate * 2;
const audio = Buffer.alloc(44 + frames * 2);
audio.write('RIFF');
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVE', 8);
audio.write('fmt ', 12);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(rate, 24);
audio.writeUInt32LE(rate * 2, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(frames * 2, 40);
const source = 'data:audio/wav;base64,' + audio.toString('base64');
const fixture = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111;color:white}</style>
<main id="content"><div class="l-main"><div class="l-content">${ids.map((id) => `<div class="sound"><a class="soundTitle__title" href="https://soundcloud.com/artist/${id}">${id}</a><div class="soundTitle__playButton"><button class="playButton" onclick="playTrack('${id}')">Play</button></div></div>`).join('')}</div></div></main>
<div class="playControls"><button class="playControls__play"></button><button class="skipControl__next" onclick="playTrack('wrong')">Next</button><a class="playbackSoundBadge__titleLink"></a><a class="playbackSoundBadge__lightLink">Artist</a><div class="playbackTimeline__timePassed"><span>0:00</span></div><div class="playbackTimeline__duration"><span>1:30</span></div></div>
<script>
window.audio=new Audio();audio.volume=0.01;window.played=[];window.endedAt=[];window.nativeAutoplay=0;
window.playTrack=(id)=>{played.push({id,at:Date.now()});document.querySelector('.playbackSoundBadge__titleLink').href='https://soundcloud.com/artist/'+id;document.querySelector('.playbackSoundBadge__titleLink').textContent=id;document.querySelector('.playControls__play').classList.add('playing');audio.src=${JSON.stringify(source)};void audio.play();};
audio.addEventListener('ended',()=>{endedAt.push(Date.now())},true);
audio.addEventListener('ended',()=>{nativeAutoplay++;playTrack('wrong')});
document.querySelector('.playControls__play').onclick=()=>{if(audio.paused){void audio.play();document.querySelector('.playControls__play').classList.add('playing')}else{audio.pause();document.querySelector('.playControls__play').classList.remove('playing')}};
setInterval(()=>{document.querySelector('.playbackTimeline__timePassed span').textContent='0:0'+Math.floor(audio.currentTime)},250);
</script>`;
app.on('browser-window-created', (_event, window) => window.on('show', () => window.hide()));
app.on('window-all-closed', () => {});
app.whenReady().then(() =>
    session.defaultSession.protocol.handle(
        'https',
        (request) =>
            new Response(/\/you\/(likes|history)/.test(request.url) ? '<main>Sign in</main>' : fixture, {
                headers: { 'content-type': 'text/html;charset=utf-8' },
            }),
    ),
);
require(path.join(root, 'tsc/main.js'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    try {
        let window, contents;
        for (let index = 0; index < 200; index++) {
            window = BrowserWindow.getAllWindows().find((item) => item.getBrowserViews().length >= 2);
            contents = window
                ?.getBrowserViews()
                .find((view) => view.webContents.getURL().startsWith('https://soundcloud.com/'))?.webContents;
            if (
                contents &&
                (await contents
                    .executeJavaScript("!!window.waveInline && !!document.querySelector('#codex-wave-inline')")
                    .catch(() => false))
            )
                break;
            await wait(50);
        }
        assert(contents, 'main client ready');
        await contents.executeJavaScript('waveInline.start()', true);
        window.minimize();
        for (let index = 0; index < 150; index++) {
            if (await contents.executeJavaScript('played.length>=3')) break;
            await wait(100);
        }
        const state = await contents.executeJavaScript(
            '({played,endedAt,nativeAutoplay,time:audio.currentTime,paused:audio.paused})',
        );
        assert(state.played.length >= 3, JSON.stringify(state));
        assert(
            state.played.every((item) => ids.includes(item.id)),
            'no unrelated native-autoplay track starts',
        );
        assert.equal(new Set(state.played.map((item) => item.id)).size, state.played.length);
        assert.equal(state.nativeAutoplay, 0);
        const gaps = state.played.slice(1).map((item, index) => item.at - state.endedAt[index]);
        assert(
            gaps.every((gap) => gap >= 0 && gap < 1500),
            JSON.stringify({ gaps, state }),
        );
        const report = {
            automaticTransitions: state.played.length - 1,
            minimized: window.isMinimized(),
            nativeAutoplaySuppressed: true,
            gapsMs: gaps,
        };
        fs.writeFileSync(path.join(out, 'wave-playback.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 30000).unref();
