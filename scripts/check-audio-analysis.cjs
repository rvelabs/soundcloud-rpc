const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const output = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-audio-analysis');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile-' + Date.now()));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
    try {
        const contents = window.webContents;
        await contents.loadURL(
            'data:text/html,' +
                encodeURIComponent(
                    '<a class="playbackSoundBadge__titleLink" href="https://soundcloud.com/test/one">One</a>',
                ),
        );
        const capture = require(path.join(root, 'tsc/wave/audioFeatureCapture.js')).installAudioFeatureCapture;
        await contents.executeJavaScript(
            `window.samples=[];window.soundcloudAPI={sendAudioFeatures:value=>samples.push(value)};window.__waveMediaEndState={active:true};(${capture.toString()})();window.firstPlay=HTMLMediaElement.prototype.play;(${capture.toString()})();`,
        );
        await contents.executeJavaScript(
            `(async()=>{
            const rate=32000,frames=rate*16,buffer=new ArrayBuffer(44+frames*2),view=new DataView(buffer);
            const text=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
            text(0,'RIFF');view.setUint32(4,36+frames*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,frames*2,true);
            for(let i=0;i<frames;i++)view.setInt16(44+i*2,Math.sin(i*2*Math.PI*110/rate)*6000,true);
            window.testSource=URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));
            window.testAudio=new Audio(testSource);testAudio.volume=0.01;await testAudio.play();
        })()`,
            true,
        );
        await wait(3500);
        const measured = await contents.executeJavaScript(
            '({samples,paused:testAudio.paused,time:testAudio.currentTime,sameHook:firstPlay===HTMLMediaElement.prototype.play})',
        );
        assert(measured.samples.length >= 2, 'real detached HTMLAudioElement produces measurements');
        assert(
            measured.samples.every(
                (item) =>
                    item.path === '/test/one' &&
                    item.source === 'media-element-v1' &&
                    Number.isFinite(item.energy) &&
                    item.energy > 0 &&
                    item.energy <= 1,
            ),
        );
        assert(
            measured.samples.some((item) => item.bass > 0.8),
            '110Hz fixture is measured in the bass band',
        );
        assert(!measured.paused && measured.time > 2 && measured.sameHook);
        await contents.executeJavaScript(
            "Object.assign(window.__waveMediaEndState,{currentPath:'/test/one',analysisReadyPath:'/test/one'});window.dispatchEvent(new Event('__soundcloudWaveMediaState'))",
        );
        await wait(1300);
        assert.equal(
            await contents.executeJavaScript('samples.length'),
            measured.samples.length,
            'cached analysis suppresses further sampling',
        );
        assert.equal(
            await contents.executeJavaScript('testAudio.paused'),
            false,
            'cache reuse preserves audio playback',
        );
        await contents.executeJavaScript(
            "delete window.__waveMediaEndState.analysisReadyPath;window.dispatchEvent(new Event('__soundcloudWaveMediaState'))",
        );
        await wait(2300);
        assert(
            (await contents.executeJavaScript('samples.length')) > measured.samples.length,
            'invalidating analysis wakes sampling',
        );
        const count = await contents.executeJavaScript('samples.length');
        await contents.executeJavaScript('window.__waveMediaEndState.active=false');
        await wait(1300);
        const stopped = await contents.executeJavaScript(
            '({count:samples.length,time:testAudio.currentTime,paused:testAudio.paused})',
        );
        assert.equal(stopped.count, count);
        assert(stopped.time > measured.time && !stopped.paused, 'analysis stops while native playback continues');
        await contents.executeJavaScript(
            `(async()=>{testAudio.pause();window.second=new Audio(testSource);second.volume=0.01;Object.defineProperty(second,'currentSrc',{value:'https://uncorsed.invalid/file'});window.__waveMediaEndState.active=true;await second.play();})()`,
            true,
        );
        await wait(1300);
        assert.equal(
            await contents.executeJavaScript('samples.length'),
            count,
            'unsafe cross-origin media is left untouched',
        );
        assert.equal(await contents.executeJavaScript('second.paused'), false);
        const result = {
            detachedAudioMeasured: true,
            spectralCheck: true,
            playbackContinuesWithoutAnalysis: true,
            unsafeCorsSkipped: true,
            cachedAnalysisSkipsSampling: true,
            samples: measured.samples.length,
        };
        fs.writeFileSync(path.join(output, 'audio-analysis.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        window.destroy();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        window.destroy();
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 20000).unref();
