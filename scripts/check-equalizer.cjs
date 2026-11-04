const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-equalizer-check');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile-' + Date.now()));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nativeTransport = process.env.EQUALIZER_NATIVE_TRANSPORT === '1';
const { equalizerPresets, equalizerFrequencies, normalizeEqualizer } = require(
    path.join(root, 'tsc/audio/equalizerSettings.js'),
);
let saved = normalizeEqualizer();
const audioFeatures = [];
ipcMain.on('wave-inline:audio', (_event, value) => audioFeatures.push(value));
ipcMain.handle('equalizer:load', () => ({
    settings: saved,
    presets: equalizerPresets,
    frequencies: equalizerFrequencies,
    interfaceLanguage: 'ru',
    systemLocale: 'ru-RU',
}));
ipcMain.on('equalizer:save', (_event, value) => {
    saved = normalizeEqualizer(value);
});
const fixture = `<!doctype html><meta charset="utf-8"><style>
body{background:#111;color:#eee;margin:0;font:14px Arial}main{padding:36px}h1{font-size:26px}.playControls{position:fixed;bottom:0;width:100%;height:48px;background:#303030}.playControls__elements{height:48px;display:flex;align-items:center;gap:14px;padding:0 16px;max-width:1240px}.native{border:0;background:transparent;color:white;font-size:18px}.timeline{height:2px;background:#666;flex:1;min-width:20px}.badge{width:160px;font-size:11px;white-space:nowrap;overflow:hidden}.badge b{display:block;color:#999}.queue{font-size:20px}</style>
<main><h1>SoundCloud</h1><p>Equalizer · native player integration</p></main>
<div class="playControls"><div class="playControls__elements"><button class="native">◀</button><button class="native playControls__play">Ⅱ</button><button class="native">▶</button><span>0:00</span><div class="timeline"></div><span>4:12</span><span>♫</span><div class="badge"><b>SoundCloud</b><a class="playbackSoundBadge__titleLink" href="https://soundcloud.com/test/one" style="color:white;text-decoration:none">Audio test</a></div><button class="native queue">☰</button></div></div>
<script>window.nativeKeys=0;for(const type of ['keydown','keypress','keyup'])window.addEventListener(type,()=>nativeKeys++);</script>`;
app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 680,
        webPreferences: {
            preload: path.join(root, 'tsc/preload.js'),
            sandbox: true,
            contextIsolation: true,
            backgroundThrottling: false,
        },
    });
    const wc = win.webContents;
    try {
        await session.defaultSession.protocol.handle(
            'https',
            () => new Response(fixture, { headers: { 'content-type': 'text/html' } }),
        );
        await wc.loadURL('https://soundcloud.com/');
        for (let i = 0; i < 80; i++) {
            if (await wc.executeJavaScript("!!document.querySelector('#sc-equalizer')?.shadowRoot")) break;
            await wait(25);
        }
        assert(
            await wc.executeJavaScript("!!document.querySelector('#sc-equalizer')?.shadowRoot"),
            'actual bundled preload mounts equalizer',
        );
        await wc.executeJavaScript(
            `window.eqRoot=document.querySelector('#sc-equalizer').shadowRoot;window.contexts=[];window.sourceCreations=0;
          const OriginalContext=AudioContext;window.AudioContext=class extends OriginalContext{constructor(...args){super(...args);contexts.push(this)}createMediaElementSource(media){sourceCreations++;return super.createMediaElementSource(media)}};
          const connect=AudioNode.prototype.connect;AudioNode.prototype.connect=function(destination,...args){const result=connect.call(this,destination,...args);if(destination instanceof AudioDestinationNode){if(window.outputProbe){try{outputProbe.node.disconnect(outputProbe.analyser)}catch{}}const analyser=this.context.createAnalyser();analyser.fftSize=8192;analyser.smoothingTimeConstant=0;connect.call(this,analyser);window.outputProbe={node:this,analyser}}return result};
          window.sourceBlob=(seconds=12)=>{const rate=48000,frames=rate*seconds,bytes=new ArrayBuffer(44+frames*2),view=new DataView(bytes);const put=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i))};put(0,'RIFF');view.setUint32(4,36+frames*2,true);put(8,'WAVE');put(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);put(36,'data');view.setUint32(40,frames*2,true);for(let i=0;i<frames;i++)view.setInt16(44+i*2,Math.round(5000*(Math.sin(2*Math.PI*110*i/rate)+Math.sin(2*Math.PI*6000*i/rate))),true);return URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}))};
          window.audio=new Audio(sourceBlob());audio.loop=true;audio.volume=.03;
          if(${nativeTransport}){window.nativeContext=new AudioContext();window.nativeGate=nativeContext.createGain();window.nativeVolume=nativeContext.createGain();window.nativeSource=nativeContext.createMediaElementSource(audio);nativeSource.connect(nativeGate);nativeGate.connect(nativeVolume);nativeVolume.connect(nativeContext.destination);void nativeContext.resume();}
          void audio.play();
          window.measure=()=>{const a=outputProbe.analyser,db=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(db);const peak=hz=>Math.max(...Array.from(db.slice(Math.max(0,Math.round(hz*a.fftSize/a.context.sampleRate)-2),Math.round(hz*a.fftSize/a.context.sampleRate)+3)));return {bass:peak(110),treble:peak(6000),time:audio.currentTime,volume:audio.volume,paused:audio.paused,state:__soundcloudEqualizer.snapshot()}};true;`,
            true,
        );
        await wait(300);
        assert.equal(
            await wc.executeJavaScript('contexts.length'),
            nativeTransport ? 1 : 0,
            'disabled equalizer creates no additional AudioContext',
        );
        await wc.executeJavaScript(
            "eqRoot.querySelector('.toggle').click();eqRoot.querySelector('select').value='bass';eqRoot.querySelector('select').dispatchEvent(new Event('change'));true;",
            true,
        );
        await wait(650);
        const bass = await wc.executeJavaScript('measure()');
        assert.equal(bass.state.mode, nativeTransport ? 'native' : 'direct');
        assert(bass.bass - bass.treble > 3, 'real 110Hz signal is boosted relative to 6kHz: ' + JSON.stringify(bass));
        assert(
            bass.state.headroomDb > 4 && bass.state.headroomDb < 12,
            'automatic headroom accounts for filter response',
        );
        assert.equal(bass.volume, 0.03, 'native media volume is preserved');
        await wc.executeJavaScript('audio.volume=.015;true;');
        await wait(200);
        const quieter = await wc.executeJavaScript('measure()');
        assert(
            bass.bass - quieter.bass > 4 && bass.bass - quieter.bass < 8,
            'native volume changes the actual processed signal',
        );
        await wc.executeJavaScript('audio.muted=true;true;');
        await wait(200);
        const muted = await wc.executeJavaScript('measure()');
        assert(muted.bass < quieter.bass - 35, 'native mute silences the processed signal');
        await wc.executeJavaScript('audio.muted=false;audio.volume=.03;audio.currentTime=3;true;');
        await wait(150);
        assert(
            await wc.executeJavaScript('audio.currentTime>=3&&!audio.paused'),
            'native seeking preserves playback with effects',
        );
        assert.equal(await wc.executeJavaScript('sourceCreations'), 1, 'one media source per element');
        await wc.executeJavaScript(
            "audio.dispatchEvent(new Event('pause'));audio.dispatchEvent(new Event('emptied'));true;",
        );
        await wait(150);
        const afterStaleEvents = await wc.executeJavaScript('measure()');
        assert(
            afterStaleEvents.state.contextState === 'running' &&
                afterStaleEvents.bass > -90 &&
                !afterStaleEvents.paused,
            'late events from an earlier load cannot disconnect the current playing track',
        );
        if (nativeTransport) {
            await wc.executeJavaScript('nativeSource.connect(nativeGate);nativeSource.connect(nativeGate);true;');
            await wait(150);
            const duplicate = await wc.executeJavaScript('measure()');
            assert(Math.abs(duplicate.bass - bass.bass) < 1, 'duplicate native connect never adds a parallel dry path');
            await wc.executeJavaScript('nativeVolume.gain.value=.5;true;');
            await wait(200);
            const nativeQuiet = await wc.executeJavaScript('measure()');
            assert(
                bass.bass - nativeQuiet.bass > 4 && bass.bass - nativeQuiet.bass < 8,
                'native volume-gate automation stays downstream of the equalizer',
            );
            await wc.executeJavaScript('nativeVolume.gain.value=1;true;');
        }
        win.minimize();
        await wc.executeJavaScript(
            "eqRoot.querySelector('select').value='treble';eqRoot.querySelector('select').dispatchEvent(new Event('change'));true;",
            true,
        );
        await wait(600);
        const treble = await wc.executeJavaScript('measure()');
        assert(treble.treble - treble.bass > 2, 'treble preset changes actual spectrum while minimized');
        assert(treble.time > bass.time && !treble.paused, 'processing continues while minimized');
        await wc.executeJavaScript("eqRoot.querySelector('.power').click();true;", true);
        await wait(600);
        const bypass = await wc.executeJavaScript('measure()');
        assert(Math.abs(bypass.bass - bypass.treble) < 2, 'bypass restores the original two-tone balance');
        assert(!bypass.paused && bypass.volume === 0.03, 'bypass preserves native playback and volume');
        await wc.executeJavaScript('audio.pause();true;');
        await wait(120);
        assert.equal(
            await wc.executeJavaScript('contexts[0].state'),
            nativeTransport ? 'running' : 'suspended',
            'only an owned audio context may be suspended; the native SoundCloud context remains managed by its player',
        );
        await wc.executeJavaScript("eqRoot.querySelector('.power').click();void audio.play();true;", true);
        await wait(300);
        assert.equal(await wc.executeJavaScript('contexts.length'), 1);
        assert.equal(await wc.executeJavaScript('sourceCreations'), 1, 'resuming never creates a duplicate source');
        await wc.executeJavaScript('audio.pause();void audio.play();true;', true);
        await wait(150);
        assert.equal(
            await wc.executeJavaScript('contexts[0].state'),
            'running',
            'a fast pause/resume cannot leave the output context suspended',
        );
        await wc.executeJavaScript('audio.src=sourceBlob();void audio.play();true;', true);
        await wait(300);
        assert.equal(
            await wc.executeJavaScript('sourceCreations'),
            1,
            'changing tracks on the same element reuses the graph',
        );
        if (nativeTransport) {
            for (const disconnect of [
                'nativeSource.disconnect(nativeGate)',
                'nativeSource.disconnect()',
                'nativeSource.disconnect(0)',
                'nativeSource.disconnect(undefined)',
            ]) {
                await wc.executeJavaScript(disconnect + ';true;');
                await wait(200);
                const quiet = await wc.executeJavaScript('measure()');
                assert(quiet.bass < -95, 'native disconnect removes all wet and dry outputs: ' + disconnect);
                await wc.executeJavaScript('nativeSource.connect(nativeGate);true;');
                await wait(200);
                assert((await wc.executeJavaScript('measure()')).bass > -90, 'native reconnect restores audio');
            }
            assert(
                await wc.executeJavaScript(
                    '(()=>{try{nativeSource.connect(nativeGate,99);return false}catch(error){return error.name==="IndexSizeError"}})()',
                ),
                'invalid native connection arguments retain browser errors',
            );
        }
        wc.send('wave-inline:active', true);
        await wc.executeJavaScript(
            "Object.assign(window.__waveMediaEndState,{active:true,currentPath:'/test/one'});window.dispatchEvent(new Event('__soundcloudWaveMediaState'));true;",
        );
        await wait(2300);
        assert(audioFeatures.length >= 1, 'wave audio analysis continues with the equalizer connected');
        assert(
            audioFeatures.some(
                (value) => value.bass > 0.35 && value.bass < 0.65 && value.treble > 0.35 && value.treble < 0.65,
            ),
            'recommendations measure the original two-tone track, before the equalizer',
        );
        await wc.executeJavaScript(
            "window.__waveMediaEndState.active=false;window.dispatchEvent(new Event('__soundcloudWaveMediaState'));true;",
        );
        if (nativeTransport) {
            await wc.executeJavaScript(
                "Object.defineProperty(audio,'mediaKeys',{value:{},configurable:true});eqRoot.querySelector('.power').click();eqRoot.querySelector('.power').click();true;",
                true,
            );
            await wait(200);
            assert.equal(
                (await wc.executeJavaScript('measure()')).state.status,
                'active',
                'an existing native source is reused even when a player has preattached media keys',
            );
        }
        const categories = await wc.executeJavaScript(
            "[...eqRoot.querySelectorAll('optgroup')].map(group=>group.label)",
        );
        assert.deepEqual(categories, ['Звучание', 'Жанры', 'Инструменты']);
        for (const id of ['small-speakers', 'trap', 'piano']) {
            await wc.executeJavaScript(
                `eqRoot.querySelector('select').value=${JSON.stringify(id)};eqRoot.querySelector('select').dispatchEvent(new Event('change'));true;`,
                true,
            );
            await wait(80);
            assert.equal(saved.preset, id, 'grouped preset reaches persistence: ' + id);
            assert(
                await wc.executeJavaScript(
                    "!eqRoot.querySelector('.description').hidden&&eqRoot.querySelector('.description').textContent.length>20",
                ),
                'new presets explain their purpose',
            );
        }
        const russianDescription = await wc.executeJavaScript("eqRoot.querySelector('.description').textContent");
        const presetBeforeLanguage = structuredClone(saved);
        wc.send('wave-inline:interface-language', 'en');
        await wait(50);
        assert.deepEqual(
            await wc.executeJavaScript("[...eqRoot.querySelectorAll('optgroup')].map(group=>group.label)"),
            ['Sound', 'Genres', 'Instruments'],
        );
        assert.notEqual(
            await wc.executeJavaScript("eqRoot.querySelector('.description').textContent"),
            russianDescription,
            'preset explanations follow the interface language',
        );
        assert.deepEqual(saved, presetBeforeLanguage, 'language changes never reset the selected curve');
        wc.send('wave-inline:interface-language', 'ru');
        await wait(50);
        const ui = await wc.executeJavaScript(
            `(()=>{const root=eqRoot;const slider=root.querySelector('[data-band="2"]');slider.value='-4.5';slider.dispatchEvent(new Event('input'));slider.focus();const before=nativeKeys;for(const type of ['keydown','keypress','keyup'])slider.dispatchEvent(new KeyboardEvent(type,{key:' ',bubbles:true,composed:true}));const custom=root.querySelector('select').value;root.querySelector('.panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true}));return {custom,keys:nativeKeys-before,closed:root.querySelector('.panel').hidden,focus:root.activeElement?.className,bands:root.querySelectorAll('.band input').length,presets:root.querySelectorAll('option:not(:disabled)').length}})()`,
        );
        assert.equal(ui.custom, 'custom');
        assert.equal(ui.keys, 0, 'slider keys do not trigger SoundCloud hotkeys');
        assert(ui.closed && ui.focus === 'toggle');
        assert.equal(ui.bands, 10);
        assert(ui.presets >= 25);
        await wait(50);
        assert.equal(saved.gains[2], -4.5, 'manual adjustments reach the persistence bridge');
        const persisted = { ...saved, gains: [...saved.gains] };
        wc.send('wave-inline:interface-language', 'en');
        await wait(50);
        assert.equal(await wc.executeJavaScript("eqRoot.querySelector('h2').textContent"), 'Equalizer');
        await wc.executeJavaScript("eqRoot.querySelector('.toggle').click();true;", true);
        for (const width of [480, 800, 1280, 1920]) {
            win.setSize(width, 680);
            await wait(80);
            const layout = await wc.executeJavaScript(
                `(()=>{const p=eqRoot.querySelector('.panel').getBoundingClientRect(),b=eqRoot.querySelector('.toggle').getBoundingClientRect(),q=document.querySelector('.queue').getBoundingClientRect();return {visible:!eqRoot.querySelector('.panel').hidden,panelWidth:p.width,left:p.left,right:p.right,width:innerWidth,bottom:p.bottom,height:innerHeight,buttonLeft:b.left,queueRight:q.right,overflow:eqRoot.querySelector('.panel').scrollWidth>eqRoot.querySelector('.panel').clientWidth}})()`,
            );
            assert(
                layout.visible &&
                    layout.panelWidth >= 400 &&
                    layout.left >= 0 &&
                    layout.right <= layout.width + 1 &&
                    layout.bottom < layout.height - 48 &&
                    !layout.overflow,
                JSON.stringify(layout),
            );
            assert(layout.buttonLeft >= layout.queueRight, 'equalizer does not cover native queue controls');
        }
        win.setSize(1000, 680);
        await wait(80);
        const preview = new BrowserWindow({
            show: false,
            width: 1000,
            height: 680,
            webPreferences: {
                preload: path.join(root, 'tsc/preload.js'),
                sandbox: true,
                contextIsolation: true,
                backgroundThrottling: false,
            },
        });
        await preview.webContents.loadURL('https://soundcloud.com/');
        for (let i = 0; i < 80; i++) {
            if (await preview.webContents.executeJavaScript("!!document.querySelector('#sc-equalizer')?.shadowRoot"))
                break;
            await wait(25);
        }
        await preview.webContents.executeJavaScript(
            "document.querySelector('#sc-equalizer').shadowRoot.querySelector('.toggle').click();true;",
            true,
        );
        await wait(200);
        fs.writeFileSync(
            path.join(out, 'equalizer-panel.png'),
            (await preview.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
        );
        preview.destroy();
        await wc.executeJavaScript(
            'document.querySelector(\'.playControls\').outerHTML=\'<div class="playControls"><div class="playControls__elements"><button class="queue">Queue</button></div></div>\';true;',
        );
        await wait(80);
        assert.equal(
            await wc.executeJavaScript("document.querySelectorAll('#sc-equalizer').length"),
            1,
            'player replacement remounts a single panel',
        );
        await wc.loadURL('https://soundcloud.com/you/library');
        await wait(200);
        assert.equal(
            await wc.executeJavaScript(
                "document.querySelector('#sc-equalizer').shadowRoot.querySelector('[data-band=\"2\"]').value",
            ),
            '-4.5',
            'saved curve survives a page reload',
        );
        await wc.executeJavaScript(
            `window.unsafe=new Audio();unsafe.src='https://third-party.invalid/audio';Object.defineProperty(unsafe,'paused',{value:false});Object.defineProperty(unsafe,'readyState',{value:4});unsafe.play().catch(()=>{});unsafe.dispatchEvent(new Event('playing'));true;`,
        );
        await wait(80);
        assert.equal(
            await wc.executeJavaScript('__soundcloudEqualizer.snapshot().attached'),
            0,
            'non-CORS media is never irreversibly routed',
        );
        assert.deepEqual(saved, persisted);
        const result = {
            nativeTransport,
            realSpectralChange: true,
            automaticHeadroom: true,
            nativeVolumePreserved: true,
            nativeVolumeAndMuteMeasured: true,
            nativeSeekPreserved: true,
            bypassVerified: true,
            minimizedPlayback: true,
            sourceReuse: true,
            pauseSuspendsContext: !nativeTransport,
            nativeContextPreserved: nativeTransport,
            originalAudioAnalysisPreserved: true,
            presets: equalizerPresets.length,
            manualSettingsRestored: true,
            hotkeysIsolated: true,
            nativePlayerRemounted: true,
            corsGuard: true,
            responsiveWidths: [480, 800, 1280, 1920],
            bass,
            treble,
            bypass,
        };
        fs.writeFileSync(path.join(out, 'equalizer.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        win.destroy();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        win.destroy();
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 30000).unref();
