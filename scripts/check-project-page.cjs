const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-project-page-check');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'page-empty-profile'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    let win;
    try {
        win = new BrowserWindow({
            show: false,
            width: 1440,
            height: 1000,
            webPreferences: { sandbox: true, offscreen: true },
        });
        let frame;
        win.webContents.on('paint', (_event, _dirty, image) => {
            frame = image.toPNG();
        });
        await win.loadFile(path.join(repo, 'docs', 'index.html'));
        const results = [];
        for (const [name, width, height] of [
            ['desktop', 1440, 1000],
            ['mobile', 390, 844],
        ]) {
            win.setContentSize(width, height);
            await new Promise((r) => setTimeout(r, 350));
            const state = await win.webContents.executeJavaScript(
                `({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,title:document.title,canonical:document.querySelector('link[rel="canonical"]').href,schema:JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent),download:document.querySelector('.button').href,h1:document.querySelectorAll('h1').length})`,
            );
            assert.equal(state.h1, 1);
            assert(state.scrollWidth <= state.width, 'horizontal overflow');
            assert.equal(state.schema['@type'], 'SoftwareApplication');
            assert.equal(state.canonical, 'https://rvelabs.github.io/soundcloud-rpc/');
            assert.equal(state.download, 'https://github.com/rvelabs/soundcloud-rpc/releases/latest');
            for (const language of ['ru', 'en']) {
                const localized = await win.webContents.executeJavaScript(`(()=>{
                    document.querySelector('[data-site-language="${language}"]').click();
                    return {lang:document.documentElement.lang,heading:document.querySelector('h1').textContent,icon:document.querySelector('link[rel="icon"]').getAttribute('href')};
                })()`);
                assert.equal(localized.lang, language);
                assert(localized.heading.includes(language === 'ru' ? 'Ваш SoundCloud.' : 'Your SoundCloud.'));
                assert.equal(localized.icon, './favicon.ico');
            }
            fs.writeFileSync(
                path.join(out, `project-page-${name}.png`),
                frame || (await win.webContents.capturePage()).toPNG(),
            );
            results.push({ name, width: state.width, overflow: false });
        }
        console.log(JSON.stringify(results));
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        win?.destroy();
    }
});
