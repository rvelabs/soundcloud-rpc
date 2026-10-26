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
        await win.loadFile(path.join(repo, 'docs', 'index.html'));
        win.webContents.debugger.attach('1.3');
        const command = (method, params) => win.webContents.debugger.sendCommand(method, params);
        const results = [];
        for (const [name, width, height, scale] of [
            ['desktop', 1440, 1000, 1],
            ['small-phone', 320, 568, 2],
            ['android-small', 360, 800, 3],
            ['iphone-se', 375, 667, 2],
            ['iphone', 390, 844, 3],
            ['android-393', 393, 873, 2.75],
            ['android-large', 412, 915, 2.625],
            ['iphone-large', 430, 932, 3],
            ['phone-landscape', 844, 390, 3],
            ['tablet', 768, 1024, 2],
        ]) {
            win.setContentSize(width, height);
            await command('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: scale,
                mobile: width !== 1440,
            });
            await command('Emulation.setTouchEmulationEnabled', { enabled: width !== 1440 });
            await new Promise((r) => setTimeout(r, 150));
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
                const layout = await win.webContents.executeJavaScript(`(()=>{
                    scrollTo(0,0);
                    const controls=[...document.querySelectorAll('nav a,nav button,.button,summary')];
                    const bad=controls.map(e=>({label:e.textContent.trim(),r:e.getBoundingClientRect()}))
                        .filter(({r})=>r.left < -1 || r.right > innerWidth+1 || r.height < 43);
                    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bad:bad.map(e=>e.label)};
                })()`);
                assert.equal(layout.width, width, name + ': viewport width');
                assert(layout.scrollWidth <= layout.width, name + '/' + language + ': horizontal overflow');
                assert.deepEqual(layout.bad, [], name + '/' + language + ': clipped or small touch target');
            }
            await new Promise((r) => setTimeout(r, 850));
            const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(path.join(out, `project-page-${name}.png`), Buffer.from(screenshot.data, 'base64'));
            results.push({ name, width: state.width, overflow: false });
        }
        await command('Emulation.setDeviceMetricsOverride', {
            width: 360,
            height: 800,
            deviceScaleFactor: 2,
            mobile: true,
        });
        await command('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await win.webContents.executeJavaScript("document.documentElement.style.fontSize='200%'");
        for (const language of ['ru', 'en']) {
            const accessible = await win.webContents.executeJavaScript(`(()=>{
                document.querySelector('[data-site-language="${language}"]').click();
                return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth};
            })()`);
            assert(accessible.scrollWidth <= accessible.width, language + ': enlarged text does not overflow');
        }
        const faq = await win.webContents.executeJavaScript(`(async()=>{
            document.documentElement.style.fontSize='';
            document.querySelector('summary').click();
            document.querySelector('details').scrollIntoView();
            await new Promise(r=>setTimeout(r,150));
            return {open:document.querySelector('details').open,active:document.getAnimations().filter(a=>a.playState==='running').length,
                readable:[...document.querySelectorAll('.card,.flow,details')].every(e=>getComputedStyle(e).opacity==='1')};
        })()`);
        assert(faq.open && faq.readable, 'native FAQ and content remain accessible');
        assert.equal(faq.active, 0, 'reduced motion stops decorative and reveal animations');
        await command('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        });
        await win.webContents.executeJavaScript('scrollTo(0,0)');
        await new Promise((r) => setTimeout(r, 200));
        assert(
            await win.webContents.executeJavaScript("document.getAnimations().some(a=>a.playState==='running')"),
            'ambient resumes',
        );
        await win.webContents.executeJavaScript('scrollTo(0,document.body.scrollHeight)');
        await new Promise((r) => setTimeout(r, 900));
        assert.equal(
            await win.webContents.executeJavaScript(
                "document.getAnimations().filter(a=>a.playState==='running').length",
            ),
            0,
            'offscreen ambient pauses',
        );
        results.push({ enlargedText: '200%', languages: ['ru', 'en'], reducedMotion: true, offscreenPause: true });
        fs.writeFileSync(path.join(out, 'project-page-results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(results));
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        win?.destroy();
    }
});
