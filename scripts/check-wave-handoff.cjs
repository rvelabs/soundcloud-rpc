const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_BASELINE_REPO || process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-wave-playback');
const profile = path.join(out, 'profile-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const balanced = process.env.WAVE_TEST_BALANCED === '1';
const healthy = process.env.WAVE_TEST_HEALTHY_HANDOFF === '1';
const manual = process.env.WAVE_TEST_MANUAL_HANDOFF === '1';
const ids = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const seed = balanced ? 'https://soundcloud.com/artist/three' : 'https://soundcloud.com/seed/favorite';
fs.writeFileSync(
    path.join(profile, 'config.json'),
    JSON.stringify({
        adBlocker: false,
        discordRichPresence: false,
        minimizeToTray: true,
        waveQueueUnavailableV17_2_default: 0,
        waveControls_default: { mood: 'any', tone: 'bass', tempo: 'any', discovery: balanced ? 'balanced' : 'new' },
        waveFeedbackV1_default: [
            { track: { id: seed, title: 'Favorite', artist: 'Seed' }, kind: 'like', at: Date.now() - 7 * 86400000 },
        ],
        ...(balanced
            ? {
                  waveFeedbackV1_default: [
                      {
                          track: { id: seed, title: 'three', artist: 'Artist 2', genre: 'ambient' },
                          kind: 'like',
                          at: Date.now() - 7 * 86400000,
                      },
                      {
                          track: {
                              id: 'https://soundcloud.com/artist/six',
                              title: 'six',
                              artist: 'Artist 5',
                              genre: 'ambient',
                          },
                          kind: 'complete',
                          listenedFraction: 1,
                          at: Date.now() - 8 * 86400000,
                      },
                  ],
              }
            : {}),
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
<main id="content"><div class="l-main"><div class="l-content">${ids.map((id) => `<div class="sound"><a class="soundTitle__title" href="https://soundcloud.com/artist/${id}">${id}</a><div class="soundTitle__playButton"><button class="playButton" onclick="playTrack('${id}')">Play</button></div><button class="sc-button-more" onclick="showMore('${id}')">More</button></div>`).join('')}</div></div></main>
<ul class="queue__itemsContainer"></ul><div class="playControls"><button class="playControls__play"></button><button class="skipControl__next" onclick="window.nextClicks=(window.nextClicks||0)+1; if(${healthy})nextQueued()">Next</button><a class="playbackSoundBadge__titleLink"></a><a class="playbackSoundBadge__lightLink">Artist</a><div class="playbackTimeline__timePassed"><span>0:00</span></div><div class="playbackTimeline__duration"><span>1:30</span></div></div>
<script>
window.maxQueued=0;new MutationObserver(()=>{window.maxQueued=Math.max(window.maxQueued,document.querySelectorAll('.queue__itemsContainer .queueItemView').length)}).observe(document.querySelector('.queue__itemsContainer'),{childList:true});
window.showMore=(id)=>{document.querySelector('.dropdownMenu')?.remove();const menu=document.createElement('div');menu.className='dropdownMenu';menu.innerHTML='<button class="addToNextUp" title="Add to Next up">Add</button>';const button=menu.firstChild;button.onclick=()=>{button.classList.add('sc-button-selected');const row=document.createElement('li');row.className='queueItemView';row.innerHTML='<a href="https://soundcloud.com/artist/'+id+'">'+id+'</a><button class="queueItemView__remove" onclick="this.parentElement.remove()">Remove</button>';document.querySelector('.queue__itemsContainer').append(row)};document.body.append(menu)};window.audio=new Audio();audio.volume=0.01;window.played=[];window.endedAt=[];window.nativeAutoplay=0;
window.playTrack=(id)=>{played.push({id,at:Date.now()});document.querySelector('.playbackSoundBadge__titleLink').href='https://soundcloud.com/artist/'+id;document.querySelector('.playbackSoundBadge__titleLink').textContent=id;document.querySelector('.playControls__play').classList.add('playing');audio.src=${JSON.stringify(source)};void audio.play();};
audio.addEventListener('ended',()=>{endedAt.push({id:document.querySelector('.playbackSoundBadge__titleLink').pathname.split('/').pop(),at:Date.now()})},true);
window.nextQueued=()=>{const link=document.querySelector('.queue__itemsContainer a');if(link){const id=link.pathname.split('/').pop();link.closest('li').remove();playTrack(id)}};audio.addEventListener('ended',()=>{nativeAutoplay++;if(${healthy})nextQueued()});
document.querySelector('.playControls__play').onclick=()=>{if(audio.paused){void audio.play();document.querySelector('.playControls__play').classList.add('playing')}else{audio.pause();document.querySelector('.playControls__play').classList.remove('playing')}};
setInterval(()=>{document.querySelector('.playbackTimeline__timePassed span').textContent='0:0'+Math.floor(audio.currentTime)},250);
setInterval(()=>{if(audio.currentTime>1.5 && window.__waveMediaEndState)window.__waveMediaEndState.queueReady=true},40);
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
            window = BrowserWindow.getAllWindows().find(
                (item) => item.contentView.children.filter((view) => view.webContents).length >= 2,
            );
            contents = window?.contentView.children
                .filter((view) => view.webContents)
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
        if (manual) {
            for (let index = 0; index < 40; index++) {
                if (await contents.executeJavaScript('window.__waveMediaEndState?.queueReady===true')) break;
                await wait(25);
            }
            await contents.executeJavaScript("document.querySelector('.skipControl__next').click()", true);
        }
        for (let index = 0; index < 280; index++) {
            if (await contents.executeJavaScript('played.length>=7')) break;
            await wait(100);
        }
        const state = await contents.executeJavaScript(
            '({played,endedAt,nativeAutoplay,maxQueued,time:audio.currentTime,paused:audio.paused})',
        );
        assert(state.played.length >= 7, JSON.stringify(state));
        assert(state.maxQueued <= 2, 'native lookahead is bounded while further alternatives remain adaptable: ' + state.maxQueued);
        assert(
            state.played.every((item) => ids.includes(item.id)),
            'no unrelated native-autoplay track starts',
        );
        assert.equal(new Set(state.played.map((item) => item.id)).size, state.played.length);
        assert(state.nativeAutoplay >= 1, 'native queue initially owns the ended event');
        if (balanced)
            assert.deepEqual(
                state.played.slice(0, 7).map((item) => ['three', 'six'].includes(item.id)),
                [false, false, true, false, false, true, false],
                'balanced pattern survives prebuffering and fallback',
            );
        const gaps = state.played.slice(1).map((item, index) => {
            const end = state.endedAt.find((entry) => entry.id === state.played[index].id);
            return end ? item.at - end.at : null;
        });
        assert(
            gaps.every(
                (gap, index) => (manual && index === 0 && gap === null) || (gap !== null && gap >= 0 && gap < 3500),
            ),
            JSON.stringify({ gaps, state }),
        );
        if (healthy) assert(state.nativeAutoplay >= 6, 'healthy native queue keeps ownership');
        if (healthy) {
            await contents.executeJavaScript(
                "document.querySelector('.skipControl__next').click();document.querySelector('.playControls__play').click();true;",
                true,
            );
            await wait(2600);
            const paused = await contents.executeJavaScript('({paused:audio.paused,count:played.length})');
            assert(
                paused.paused && paused.count === state.played.length + 1,
                'pause during native handoff is preserved: ' + JSON.stringify(paused),
            );
        }
        if (manual)
            assert.equal(
                await contents.executeJavaScript('window.nextClicks||0'),
                1,
                'one native click per user request',
            );
        if (!healthy && !manual && !balanced) {
            const dislike = await contents.executeJavaScript(
                `(async()=>{const previous=document.querySelector('.playbackSoundBadge__titleLink').href;await waveInline.dislike(previous);return {previous,current:document.querySelector('.playbackSoundBadge__titleLink').href,playing:!audio.paused}})()`,
                true,
            );
            assert(
                dislike.playing && dislike.current !== dislike.previous,
                'dislike clears the prepared queue and starts a fresh choice: ' + JSON.stringify(dislike),
            );
        }
        const report = {
            healthyNativeQueue: healthy,
            balancedPrebuffer: balanced,
            dislikeRecalculatesQueue: !healthy && !manual && !balanced,
            pauseDuringHandoffPreserved: healthy,
            manualNextRecovery: manual,
            automaticTransitions: state.played.length - 1,
            maximumCommittedQueue: state.maxQueued,
            minimized: window.isMinimized(),
            nativeQueueInitiallyObserved: true,
            gapsMs: gaps,
        };
        fs.writeFileSync(path.join(out, 'wave-handoff.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 45000).unref();
