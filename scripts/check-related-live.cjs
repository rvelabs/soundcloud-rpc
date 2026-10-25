const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-related-check');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'related-public-profile'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    let win;
    try {
        win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
        const wc = win.webContents;
        const { discoverRelatedCandidates } = require(path.join(repo, 'tsc/wave/nativeWave'));
        const seed = 'https://soundcloud.com/75n/sheets';
        const tracks = await discoverRelatedCandidates(wc, seed);
        const shape = await wc.executeJavaScript(
            `({path:location.pathname,cards:document.querySelectorAll('.sound').length,links:document.querySelectorAll('a.soundTitle__title').length,title:document.title})`,
        );
        await new Promise((r) => setTimeout(r, 4000));
        let reload = false;
        wc.on('will-navigate', (event) => {
            reload = true;
            event.preventDefault();
        });
        const link = await wc.executeJavaScript(
            `(()=>{const a=document.querySelector('.sound a.soundTitle__title');const shape=a?.outerHTML; a?.click();return shape})()`,
        );
        await new Promise((r) => setTimeout(r, 1800));
        const route = await wc.executeJavaScript(
            `({path:location.pathname,fullHero:!!document.querySelector('.fullHero'),play:!!document.querySelector('.fullHero .playButton'),more:!!document.querySelector('.listenEngagement .sc-button-more')})`,
        );
        const result = {
            shape,
            tracks: tracks.slice(0, 5),
            count: tracks.length,
            directNavigation: route,
            reload,
            link,
        };
        fs.writeFileSync(path.join(out, 'related-live.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
        app.exit(tracks.length && !reload ? 0 : 1);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        win?.destroy();
    }
});
