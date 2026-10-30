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
const delayedBadge = process.env.WAVE_TEST_DELAYED_BADGE === '1';
const cachedPlay = process.env.WAVE_TEST_CACHED_PLAY === '1';
const modalSearch = process.env.WAVE_TEST_MODAL_SEARCH === '1';
const settingsOpen = modalSearch && process.env.WAVE_TEST_MODAL_CLOSED !== '1';
const lostEnded = process.env.WAVE_TEST_LOST_ENDED === '1';
const transientFailure = process.env.WAVE_TEST_TRANSIENT_FAILURE === '1';
const longPlayback = process.env.WAVE_TEST_LONG_PLAYBACK === '1';
const audioCache = process.env.WAVE_TEST_AUDIO_CACHE === '1';
const stalledBackgroundInput = process.env.WAVE_TEST_BACKGROUND_INPUT_STALL === '1';
const importPressure = process.env.WAVE_TEST_IMPORT_PRESSURE === '1';
const terminalPause = process.env.WAVE_TEST_TERMINAL_PAUSE === '1';
const coldBuffer = process.env.WAVE_TEST_COLD_BUFFER === '1';
const extended =
    delayedBadge ||
    cachedPlay ||
    modalSearch ||
    lostEnded ||
    transientFailure ||
    audioCache ||
    importPressure ||
    terminalPause ||
    coldBuffer;
const ids = [
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    ...(extended ? Array.from({ length: 8 }, (_, index) => 'extra-' + index) : []),
];
const targetTracks = longPlayback ? 4 : extended ? 12 : 7;
const seed = balanced ? 'https://soundcloud.com/artist/three' : 'https://soundcloud.com/seed/favorite';
fs.writeFileSync(
    path.join(profile, 'config.json'),
    JSON.stringify({
        adBlocker: false,
        discordRichPresence: false,
        minimizeToTray: true,
        waveQueueUnavailableV17_2_default: modalSearch ? Date.now() : 0,
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
            tracks: (coldBuffer ? ids.slice(0, 3) : ids).map((id, index) => ({
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
        ...(audioCache
            ? {
                  waveAudioAnalysisV1_default: ids.map((id) => [
                      JSON.stringify(['/artist/' + id, 90, '']),
                      {
                          at: Date.now(),
                          version: 1,
                          features: {
                              source: 'media-element-v1',
                              sampleSeconds: 60,
                              energy: 0.25,
                              bass: 0.6,
                              brightness: 0.2,
                          },
                      },
                  ]),
              }
            : {}),
    }),
);
const rate = 8000,
    frames = rate * (longPlayback ? 31 : 2);
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
${modalSearch ? '<header><input class="headerSearch__input"><button class="headerSearch__submit">Search</button></header>' : ''}
<main id="content"><div class="l-main"><div class="l-content">${modalSearch ? '' : ids.map((id) => `<div class="sound"><a class="soundTitle__title" href="https://soundcloud.com/artist/${id}">${id}</a><div class="soundTitle__playButton"><button class="playButton" onclick="playTrack('${id}')">Play</button></div><button class="sc-button-more" onclick="showMore('${id}')">More</button></div>`).join('')}</div></div></main>
<ul class="queue__itemsContainer"></ul><div class="playControls"><button class="playControls__play"></button><button class="skipControl__next" onclick="window.nextClicks=(window.nextClicks||0)+1; if(${healthy})nextQueued()">Next</button><a class="playbackSoundBadge__titleLink"></a><a class="playbackSoundBadge__lightLink">Artist</a><div class="playbackTimeline__timePassed"><span>0:00</span></div><div class="playbackTimeline__duration"><span>1:30</span></div></div>
<script>
window.sitePlay=HTMLMediaElement.prototype.play;
if(${modalSearch}){window.searches=[];document.querySelector('.headerSearch__input').addEventListener('input',event=>{window.searchModel=event.target.value});document.querySelector('.headerSearch__submit').onclick=()=>{const id=window.searchModel;searches.push(id);if(!${JSON.stringify(ids)}.includes(id))throw Error('Search model did not receive query');history.pushState({},'','/search?q='+encodeURIComponent(id));const panel=document.querySelector('.l-main');panel.innerHTML='<div class="l-content"><div class="sound"><a class="soundTitle__title" href="https://soundcloud.com/artist/'+id+'">'+id+'</a><div class="soundTitle__playButton"><button class="playButton">Play</button></div></div></div>';panel.querySelector('.playButton').onclick=()=>playTrack(id)};onpopstate=()=>{document.querySelector('.l-main').innerHTML='<div class="l-content"></div>'};}
window.maxQueued=0;new MutationObserver(()=>{window.maxQueued=Math.max(window.maxQueued,document.querySelectorAll('.queue__itemsContainer .queueItemView').length)}).observe(document.querySelector('.queue__itemsContainer'),{childList:true});
window.showMore=(id)=>{document.querySelector('.dropdownMenu')?.remove();const menu=document.createElement('div');menu.className='dropdownMenu';menu.innerHTML='<button class="addToNextUp" title="Add to Next up">Add</button>';const button=menu.firstChild;button.onclick=()=>{button.classList.add('sc-button-selected');const row=document.createElement('li');row.className='queueItemView';row.innerHTML='<a href="https://soundcloud.com/artist/'+id+'">'+id+'</a><button class="queueItemView__remove" onclick="this.parentElement.remove()">Remove</button>';document.querySelector('.queue__itemsContainer').append(row)};document.body.append(menu)};window.audio=new Audio();audio.volume=0.01;window.played=[];window.endedAt=[];window.nativeAutoplay=0;
if(${terminalPause}){const ended=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'ended').get;Object.defineProperty(audio,'ended',{get(){return played.length>=3?false:ended.call(this)}});}
window.failedPlayClicks=0;window.playTrack=(id)=>{if(${transientFailure}&&played.length===2&&failedPlayClicks<3){failedPlayClicks++;return}played.push({id,at:Date.now()});const badge=()=>{document.querySelector('.playbackSoundBadge__titleLink').href='https://soundcloud.com/artist/'+id;document.querySelector('.playbackSoundBadge__titleLink').textContent=id;};if(!${delayedBadge}||played.length<3)badge();document.querySelector('.playControls__play').classList.add('playing');audio.src=${JSON.stringify(source)};void (${cachedPlay}?sitePlay.call(audio):audio.play());if(${delayedBadge}&&played.length>=3)setTimeout(badge,150);};
audio.addEventListener('ended',event=>{endedAt.push({id:document.querySelector('.playbackSoundBadge__titleLink').pathname.split('/').pop(),at:Date.now()});if((${lostEnded}||${terminalPause})&&played.length>=3)event.stopImmediatePropagation()},true);
window.nextQueued=()=>{const link=document.querySelector('.queue__itemsContainer a');if(link){const id=link.pathname.split('/').pop();link.closest('li').remove();playTrack(id)}};audio.addEventListener('ended',()=>{nativeAutoplay++;if(${healthy}||(${delayedBadge}&&played.length<3))nextQueued()});
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
let pressureScheduler;
if (importPressure) {
    const { WorkScheduler } = require(path.join(root, 'tsc/utils/workScheduler.js'));
    const run = WorkScheduler.prototype.run;
    WorkScheduler.prototype.run = function (...args) {
        if (!pressureScheduler) {
            pressureScheduler = this;
            for (const lane of ['page', 'network'])
                for (let i = 0; i < 12; i++)
                    void run.call(this, lane, 'import', () => new Promise(() => {})).catch(() => {});
        }
        return run.apply(this, args);
    };
}
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
        let backgroundPhase = false,
            blockedInput = 0;
        if (stalledBackgroundInput) {
            const insertText = contents.insertText.bind(contents);
            contents.insertText = (text) => {
                if (!backgroundPhase) return insertText(text);
                blockedInput++;
                return new Promise(() => {});
            };
        }
        if (settingsOpen)
            await contents.executeJavaScript("document.querySelector('.cw-settings-dialog').showModal()", true);
        await contents.executeJavaScript('waveInline.start()', true);
        backgroundPhase = true;
        window.minimize();
        if (manual) {
            for (let index = 0; index < 40; index++) {
                if (await contents.executeJavaScript('window.__waveMediaEndState?.queueReady===true')) break;
                await wait(25);
            }
            await contents.executeJavaScript("document.querySelector('.skipControl__next').click()", true);
        }
        for (let index = 0; index < (longPlayback ? 1250 : extended ? 480 : 280); index++) {
            if (await contents.executeJavaScript('played.length>=' + targetTracks)) break;
            await wait(100);
        }
        const state = await contents.executeJavaScript(
            '({played,endedAt,nativeAutoplay,maxQueued,time:audio.currentTime,paused:audio.paused})',
        );
        assert(state.played.length >= targetTracks, JSON.stringify(state));
        if (coldBuffer) {
            const discovery = await contents.executeJavaScript(
                '(async()=> (await waveInline.ready()).diagnostics.discovery)()',
            );
            assert(discovery.loads > 0, 'continuation requires related-track discovery after the three cached tracks');
        }
        if (importPressure)
            assert(
                pressureScheduler.diagnostics().queued > 0,
                'wave continues while background import slots remain saturated',
            );
        if (stalledBackgroundInput)
            assert.equal(blockedInput, 0, 'background handoffs do not depend on native focused input');
        assert(
            state.maxQueued <= 2,
            'native lookahead is bounded while further alternatives remain adaptable: ' + state.maxQueued,
        );
        assert(
            state.played.every((item) => ids.includes(item.id)),
            'no unrelated native-autoplay track starts',
        );
        assert.equal(new Set(state.played.map((item) => item.id)).size, state.played.length);
        if (!modalSearch) assert(state.nativeAutoplay >= 1, 'native queue initially owns the ended event');
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
                (gap, index) =>
                    (manual && index === 0 && gap === null) ||
                    (gap !== null && gap >= 0 && gap < (transientFailure ? 22000 : 3500)),
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
        if (!healthy && !manual && !balanced && !modalSearch && !longPlayback) {
            for (let index = 0; delayedBadge && index < 50; index++) {
                if (
                    await contents.executeJavaScript(
                        "(async()=>{const state=await waveInline.ready();return state.candidate?.url===document.querySelector('.playbackSoundBadge__titleLink').href&&!state.diagnostics.choosing&&!state.diagnostics.transitionPending})()",
                    )
                )
                    break;
                await wait(25);
            }
            const dislike = await contents.executeJavaScript(
                `(async()=>{const previous=document.querySelector('.playbackSoundBadge__titleLink').href;await waveInline.dislike(previous);return {previous,current:document.querySelector('.playbackSoundBadge__titleLink').href,playing:!audio.paused}})()`,
                true,
            );
            assert(
                dislike.playing && dislike.current !== dislike.previous,
                'dislike clears the prepared queue and starts a fresh choice: ' + JSON.stringify(dislike),
            );
        }
        const capture = await contents.executeJavaScript('window.__waveMediaEndSnapshot()');
        if (audioCache) {
            let reused = false;
            for (let i = 0; i < 40; i++) {
                reused = await contents.executeJavaScript(
                    `(async()=>{const state=await waveInline.ready();return state.candidate?.features?.sampleSeconds===60&&window.__waveMediaEndState.analysisReadyPath===document.querySelector('.playbackSoundBadge__titleLink').pathname})()`,
                );
                if (reused) break;
                await wait(50);
            }
            assert(reused, 'persisted high-quality analysis reaches ranking and suppresses renderer sampling');
        }
        if (modalSearch) {
            assert.equal(
                await contents.executeJavaScript("document.querySelector('.cw-settings-dialog')?.matches(':modal')"),
                settingsOpen,
                'settings state is preserved across real SPA content replacements',
            );
            assert(
                (await contents.executeJavaScript('searches.length')) >= targetTracks,
                'every track uses the native search without taking focus from settings',
            );
        }
        assert(
            capture.endedEvents + (capture.recoveredEvents || 0) >= targetTracks - 1 - (manual ? 1 : 0),
            'media completion remains observed across the entire sequence, excluding the manually skipped track',
        );
        assert(capture.media.length <= 8, 'diagnostics retain at most eight weak media references');
        if (lostEnded)
            assert(
                capture.recoveredEvents >= targetTracks - 3,
                'lost end events are recovered after the first two tracks',
            );
        if (terminalPause)
            assert(
                capture.terminalPauseEvents >= targetTracks - 3,
                'terminal pauses recover when ended stays false after track three',
            );
        if (transientFailure)
            assert.equal(
                await contents.executeJavaScript('failedPlayClicks'),
                3,
                'three failed play attempts recover without user input',
            );
        const report = {
            capturedEndEvents: capture.endedEvents,
            recoveredEndEvents: capture.recoveredEvents || 0,
            transientFailureRecovery: transientFailure,
            trackDurationSeconds: longPlayback ? 31 : 2,
            delayedBadge,
            cachedPlay,
            audioAnalysisReused: audioCache,
            backgroundInputIndependent: stalledBackgroundInput,
            importPressure,
            terminalPause,
            coldBuffer,
            terminalPauseEvents: capture.terminalPauseEvents || 0,
            modalSearch,
            settingsOpen,
            healthyNativeQueue: healthy,
            balancedPrebuffer: balanced,
            dislikeRecalculatesQueue: !healthy && !manual && !balanced && !modalSearch && !longPlayback,
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
setTimeout(() => app.exit(2), longPlayback ? 135000 : extended ? 75000 : 45000).unref();
