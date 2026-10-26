const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-wave-experience');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'experience-empty-profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([
    { scheme: 'wave-experience', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
    let win;
    try {
        protocol.handle(
            'wave-experience',
            () =>
                new Response(
                    '<!doctype html><html><head><meta charset="utf-8"><style>body{background:#111;color:white;font:14px Arial;margin:0;padding:70px 6%}.l-main{width:min(870px,100%)}.mixedSelectionModule{height:800px}.playControls{position:fixed;bottom:0;left:0;right:0;background:#333;height:50px;z-index:20}</style></head><body><div id="content"><div class="l-main"><div class="l-content"><section class="mixedSelectionModule"><h2>More of what you like</h2></section></div></div></div><div class="playControls" id="native-player">SoundCloud native player</div></body></html>',
                    { headers: { 'content-type': 'text/html;charset=utf-8' } },
                ),
        );
        win = new BrowserWindow({
            show: false,
            width: 1280,
            height: 900,
            webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false },
        });
        const wc = win.webContents;
        let frame;
        wc.on('paint', (_event, _dirty, image) => {
            frame = image.toPNG();
        });
        await wc.loadURL('wave-experience://app/discover');
        wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        });
        const { waveEnglish, translateWaveText } = require(path.join(repo, 'tsc/wave/i18n'));
        await wc.executeJavaScript(
            `window.__waveEnglish=${JSON.stringify(waveEnglish)};window.__waveTranslate=(${translateWaveText.toString()});window.__waveInitialLanguage='en';window.__waveSystemLocale='en-US';window.channels=new Map;window.commands=[];window.waveInline={ready:async()=>({visible:true,active:true,interfaceLanguage:'en',controls:{mood:'calm'},track:{title:'Song',author:'Artist',url:'https://soundcloud.com/test/song',isPlaying:true,elapsed:'0:04',duration:'3:00'}}),on:(key,fn)=>channels.set(key,fn),controls(){},control:(...args)=>commands.push(args),setLanguage:async language=>{window.savedLanguage=language},start:async()=>{},copyDiagnostics:async()=>{}};window.playlistImporter={onProgress(){},scan:async()=>({title:'Playlist',matches:[]})};true;`,
        );
        await wc.insertCSS(fs.readFileSync(path.join(repo, 'src/wave/inline.css'), 'utf8'));
        await wc.executeJavaScript(fs.readFileSync(path.join(repo, 'src/wave/inline.js'), 'utf8'));
        await wait(700);
        const state = await wc.executeJavaScript(
            `({title:document.querySelector('#codex-wave-inline h2').textContent,settings:document.querySelector('.cw-settings-open').textContent,importTitle:document.querySelector('#codex-playlist-import h3').textContent,separate:!document.querySelector('#codex-wave-inline').contains(document.querySelector('#codex-playlist-import')),native:document.querySelector('#native-player').outerHTML})`,
        );
        assert.equal(state.title, 'My Wave');
        assert.equal(state.settings, 'Customize');
        assert.equal(state.separate, true);
        fs.writeFileSync(path.join(out, 'wave-experience-en.png'), frame);
        const wave = Buffer.alloc(44 + 44100 * 2);
        wave.write('RIFF');
        wave.writeUInt32LE(wave.length - 8, 4);
        wave.write('WAVEfmt ', 8);
        wave.writeUInt32LE(16, 16);
        wave.writeUInt16LE(1, 20);
        wave.writeUInt16LE(1, 22);
        wave.writeUInt32LE(44100, 24);
        wave.writeUInt32LE(88200, 28);
        wave.writeUInt16LE(2, 32);
        wave.writeUInt16LE(16, 34);
        wave.write('data', 36);
        wave.writeUInt32LE(wave.length - 44, 40);
        await wc.executeJavaScript(
            `window.testAudio=new Audio(${JSON.stringify('data:audio/wav;base64,' + wave.toString('base64'))});testAudio.muted=true;testAudio.loop=true;testAudio.play()`,
        );
        const sample = () =>
            wc.executeJavaScript(
                `({motion:document.querySelector('#codex-wave-inline').classList.contains('cw-motion'),time:document.querySelector('.cw-aurora i').getAnimations()[0]?.currentTime || 0,audio:testAudio.currentTime,paused:testAudio.paused})`,
            );
        const moving = await sample();
        await wait(160);
        const later = await sample();
        assert(later.time > moving.time, 'aurora moves when focused');
        await wc.executeJavaScript(`channels.get('visibility')(false)`);
        await wait(50);
        const paused = await sample();
        await wait(180);
        const frozen = await sample();
        assert.equal(frozen.motion, false);
        assert(Math.abs(paused.time - frozen.time) < 25, 'background animation frozen');
        assert.equal(frozen.paused, false);
        assert(frozen.audio !== paused.audio, 'media continues while animation pauses');
        await wc.executeJavaScript(`channels.get('visibility')(true)`);
        await wait(100);
        assert.equal((await sample()).motion, true);
        await wc.executeJavaScript(`window.scrollTo(0,2000)`);
        await wait(180);
        assert.equal((await sample()).motion, false, 'offscreen card pauses');
        await wc.executeJavaScript(`window.scrollTo(0,0);document.querySelector('.cw-settings-open').click()`);
        await wait(380);
        fs.writeFileSync(path.join(out, 'wave-settings-en.png'), frame);
        await wc.executeJavaScript(
            `const select=document.querySelector('.cw-interface-language select');select.value='ru';select.dispatchEvent(new Event('change',{bubbles:true}))`,
        );
        await wait(60);
        assert.equal(
            await wc.executeJavaScript(`document.querySelector('#codex-wave-inline h2').textContent`),
            'Моя волна',
        );
        assert.equal(
            await wc.executeJavaScript(`document.querySelector('.cw-settings-dialog').getAttribute('aria-label')`),
            'Настроить Мою волну',
        );
        assert.equal(await wc.executeJavaScript(`window.savedLanguage`), 'ru');
        assert.equal(await wc.executeJavaScript(`document.querySelector('#native-player').outerHTML`), state.native);
        const closing = await wc.executeJavaScript(
            `(()=>{document.querySelector('[data-command="settings-close"]').click();return document.querySelector('.cw-settings-dialog').open})()`,
        );
        assert.equal(closing, true, 'closing stays visible for the exit animation');
        await wait(260);
        assert.equal(await wc.executeJavaScript(`document.querySelector('.cw-settings-dialog').open`), false);
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await wait(100);
        assert.equal((await sample()).motion, false, 'reduced motion respected');
        await wc.executeJavaScript(`testAudio.pause()`);
        const results = {
            englishAndRussian: true,
            separateImport: true,
            focusPause: true,
            offscreenPause: true,
            mediaContinues: true,
            animatedClose: true,
            reducedMotion: true,
        };
        fs.writeFileSync(path.join(out, 'wave-experience.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(results));
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        win?.destroy();
    }
});
