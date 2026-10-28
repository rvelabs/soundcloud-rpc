const { app, BrowserWindow, WebContentsView, session, nativeImage } = require('electron');
const assert = require('node:assert/strict'),
    fs = require('node:fs'),
    path = require('node:path');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-cover-check');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'cover-empty-profile'));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
    const errors = [];
    let win;
    try {
        const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#164e91;color:white;font:22px Arial}.playControls{position:fixed;bottom:0;height:50px;background:#252525;width:100%}button{height:35px}</style>
  <header><input class="headerSearch__input"><button class="headerSearch__submit">Search</button></header><main>HOME</main>
  <div class="playControls"><button id="pause" onclick="window.presses=(window.presses||0)+1">Native pause</button><button class="playControls__play" title="Play current">Play</button><a class="playbackSoundBadge__titleLink" href="https://soundcloud.com/old/track">Old track</a></div>
  <script>window.presses=0;function home(){document.body.style.background='#164e91';document.querySelector('main').textContent='HOME'}
  onpopstate=home;document.querySelector('.headerSearch__submit').onclick=()=>{history.pushState({},'', '/search?q=test');document.body.style.background='#d12e2e';document.querySelector('main').innerHTML='<div class="sound"><a class="soundTitle__title" href="https://soundcloud.com/test/next">Next</a><div class="soundTitle__playButton"><button class="playButton">Play next</button></div></div>';if(window.failAction){document.querySelector('.playButton').remove();return;}document.querySelector('.playButton').onclick=()=>setTimeout(()=>{document.querySelector('.playbackSoundBadge__titleLink').href='https://soundcloud.com/test/next';document.querySelector('.playControls__play').title='Приостановить';document.querySelector('.playControls__play').classList.add('playing')},1200)};</script>`;
        const partition = session.fromPartition('native-cover-fixture');
        partition.protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html' } }));
        win = new BrowserWindow({ width: 900, height: 650, show: true, webPreferences: { sandbox: true } });
        const content = new WebContentsView({
            webPreferences: { session: partition, sandbox: true, backgroundThrottling: false },
        });
        win.contentView.addChildView(content);
        const fit = () => {
            const [w, h] = win.getContentSize();
            content.setBounds({ x: 0, y: 0, width: w, height: h });
        };
        win.on('resize', fit);
        fit();
        const wc = content.webContents;
        await wc.loadURL('https://soundcloud.com/discover');
        win.showInactive();
        await wait(500);
        const { installNativePageCover } = require(path.join(repo, 'tsc/wave/nativePageCover.js'));
        const { playInNativePlayer } = require(path.join(repo, 'tsc/wave/nativeQueue.js'));
        installNativePageCover(win, content);
        const all = [];
        let operation = playInNativePlayer(wc, 'https://soundcloud.com/test/next', 'Next');
        operation.catch((e) => errors.push(e.message));
        for (let n = 0; n < 500; n++) {
            if (wc.getURL().includes('/search')) break;
            await wait(50);
        }
        assert(
            wc.getURL().includes('/search'),
            'underlying official page reached search: ' +
                JSON.stringify({
                    views: win.contentView.children
                        .filter((view) => view.webContents)
                        .map((v) => ({ url: v.webContents.getURL().slice(0, 90), bounds: v.getBounds() })),
                    errors,
                }),
        );
        assert.equal(
            win.contentView.children.filter((view) => view.webContents).length,
            2,
            'cover attached before search',
        );
        const cover = win.contentView.children.filter((view) => view.webContents).find((v) => v !== content),
            bounds = cover.getBounds();
        assert.equal(bounds.height, content.getBounds().height - 50, 'native transport remains uncovered');
        await wait(150);
        console.log('fixture: capture cover', win.isVisible(), win.isMinimized(), bounds);
        let frozen;
        try {
            frozen = await cover.webContents.capturePage();
        } catch (error) {
            console.log(
                'fixture: GPU readback unavailable, verifying displayed image and native view bounds',
                error.message,
            );
            const displayed = await cover.webContents.executeJavaScript(
                '(()=>{const i=document.querySelector("img"),r=i.getBoundingClientRect();return {src:i.src,width:i.naturalWidth,height:r.height}})()',
            );
            assert(displayed.width > 0 && displayed.height === bounds.height);
            frozen = nativeImage.createFromDataURL(displayed.src);
        }
        fs.writeFileSync(path.join(out, 'covered-page.png'), frozen.toPNG());
        const bitmap = frozen.toBitmap();
        const i = (150 * frozen.getSize().width + 150) * 4;
        assert(bitmap[i] > bitmap[i + 2], 'cover is blue original home, not red search');
        const nativeY = content.getBounds().height - 30;
        wc.sendInputEvent({ type: 'mouseDown', x: 50, y: nativeY, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: 50, y: nativeY, button: 'left', clickCount: 1 });
        await wait(50);
        assert.equal(await wc.executeJavaScript('window.presses'), 1, 'trusted bottom control works under cover');
        win.setSize(1000, 720);
        await wait(80);
        assert.equal(cover.getBounds().width, content.getBounds().width);
        console.log('fixture: await playback');
        await operation;
        assert.equal(wc.getURL(), 'https://soundcloud.com/discover');
        assert.equal(win.contentView.children.filter((view) => view.webContents).length, 1);
        assert.equal(
            await wc.executeJavaScript('document.querySelector(".playControls__play").title'),
            'Приостановить',
        );
        all.push('official search hidden; native control live; resize; exact return; cover detached');
        await wc.executeJavaScript('document.querySelector("main").textContent="HOME"');
        await wc.executeJavaScript(
            'document.querySelector(".playbackSoundBadge__titleLink").href="https://soundcloud.com/old/track";document.querySelector(".playControls__play").classList.remove("playing")',
        );
        wc.setZoomFactor(1.25);
        operation = playInNativePlayer(wc, 'https://soundcloud.com/test/next', 'Next');
        for (let n = 0; n < 150; n++) {
            if (wc.getURL().includes('/search')) break;
            await wait(30);
        }
        const zoomCover = win.contentView.children.filter((view) => view.webContents).find((v) => v !== content);
        assert(zoomCover, 'zoomed search has a cover');
        assert(
            Math.abs(content.getBounds().height - zoomCover.getBounds().height - 62.5) <= 2,
            'zoom leaves the entire native transport uncovered',
        );
        await operation;
        wc.setZoomFactor(1);
        all.push('125% UI scale keeps native transport uncovered');
        await wc.executeJavaScript('window.failAction=true');
        await assert.rejects(playInNativePlayer(wc, 'https://soundcloud.com/test/next', 'Next'));
        assert.equal(wc.getURL(), 'https://soundcloud.com/discover');
        assert.equal(win.contentView.children.filter((view) => view.webContents).length, 1);
        all.push('failure after search restores original route and uncovers');
        await wc.executeJavaScript('document.querySelector(".headerSearch__input").remove()');
        await assert.rejects(playInNativePlayer(wc, 'https://soundcloud.com/absent/track', 'Absent'));
        assert.equal(win.contentView.children.filter((view) => view.webContents).length, 1);
        all.push('failure restores presentation without leaking a view');
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(out, 'cover-results.json'), JSON.stringify({ passed: all }, null, 2));
        win.destroy();
        app.exit(0);
    } catch (e) {
        fs.writeFileSync(path.join(out, 'cover-results.json'), JSON.stringify({ error: e.stack, errors }, null, 2));
        if (win && !win.isDestroyed()) win.destroy();
        app.exit(1);
    }
});
