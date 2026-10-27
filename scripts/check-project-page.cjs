const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = path.join(root, 'build-site-redesign');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'page-empty-profile'));
app.on('window-all-closed', () => {});
const checkpoint = (step) => fs.writeFileSync(path.join(out, 'page-progress.json'), JSON.stringify({ step }));
setTimeout(() => {
    fs.writeSync(2, 'Site renderer check timed out\n');
    app.exit(1);
}, 30000).unref();
app.whenReady().then(async () => {
    let win;
    try {
        win = new BrowserWindow({
            show: false,
            width: 1200,
            height: 800,
            webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false },
        });
        const wc = win.webContents,
            errors = [];
        wc.on('console-message', (details) => {
            if (details.level === 'error') errors.push(details.message);
        });
        checkpoint('loading');
        await wc.loadFile(path.join(root, 'docs/index.html'));
        wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        });
        await wc.executeJavaScript('document.fonts.ready.then(()=>true)');
        await wc.executeJavaScript(
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
        );
        const recordRunning = () =>
            wc.executeJavaScript(
                "document.querySelector('.vinyl').getAnimations().some(a=>a.animationName==='record-spin' && a.playState==='running')",
            );
        assert(await recordRunning(), 'record starts before any interaction, without document focus');
        assert.equal(
            await wc.executeJavaScript("document.querySelector('.record-toggle').getAttribute('aria-pressed')"),
            'true',
        );
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await wc.executeJavaScript(
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
        );
        assert.equal(
            await wc.executeJavaScript("document.getAnimations().filter(a=>a.playState==='running').length"),
            0,
        );
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        });
        await new Promise((resolve) => setTimeout(resolve, 140));
        assert(await recordRunning(), 'restoring motion resumes rotation without a click');
        checkpoint('loaded');
        for (const width of [320, 360, 375, 390, 393, 412, 430, 768, 844, 1024, 1200, 1440]) {
            checkpoint('viewport-' + width);
            await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
                width,
                height: 900,
                deviceScaleFactor: 1,
                mobile: width < 900,
            });
            for (const lang of ['ru', 'en']) {
                const result = await wc.executeJavaScript(
                    `(()=>{document.querySelector('[data-site-language="${lang}"]').click();return {w:innerWidth,s:document.documentElement.scrollWidth}})()`,
                );
                assert(result.s <= result.w, `${width}/${lang}: overflow`);
            }
        }
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
            width: 1200,
            height: 800,
            deviceScaleFactor: 1,
            mobile: false,
        });
        checkpoint('focus');
        await wc.executeJavaScript(
            "document.querySelector('[data-site-language=ru]').click();scrollTo(0,0);dispatchEvent(new Event('focus'))",
        );
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(
            await wc.executeJavaScript("getComputedStyle(document.querySelector('.vinyl')).animationPlayState"),
            'running',
        );
        await wc.executeJavaScript("dispatchEvent(new Event('blur'))");
        await new Promise((r) => setTimeout(r, 70));
        assert.equal(
            await wc.executeJavaScript("getComputedStyle(document.querySelector('.vinyl')).animationPlayState"),
            'paused',
            await wc.executeJavaScript(
                "JSON.stringify({classes:document.querySelector('.record-art').className,focus:document.hasFocus(),hidden:document.hidden})",
            ),
        );
        const state = await wc.executeJavaScript(
            `({h1:document.querySelectorAll('h1').length,canonical:document.querySelector('link[rel=canonical]').href,schema:JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)})`,
        );
        assert.equal(state.h1, 1);
        assert.equal(state.canonical, 'https://rvelabs.github.io/soundcloud-rpc/');
        assert.equal(state.schema['@type'], 'SoftwareApplication');
        assert.deepEqual(errors, []);
        await wc.insertCSS(
            '.header .navigation{height:88px}.hero.wrap{padding-top:36px}.hero .hero-copy h1{font-size:108px;margin-block:20px}.hero .record-art{width:420px;margin:0;align-self:start}.hero .hero-actions,.hero .fineprint,.hero .hero-baseline,.hero .demo-note,.hero .record-caption{display:none}',
        );
        await wc.executeJavaScript(
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
        );
        checkpoint('capture');
        const capture = await wc.capturePage(
            { x: 0, y: 0, width: 1200, height: 630 },
            { stayHidden: true, stayAwake: true },
        );
        const image = capture.toPNG();
        fs.writeFileSync(path.join(out, 'social-cover.png'), image);
        if (process.env.WAVE_EXPORT_SOCIAL === '1')
            fs.writeFileSync(path.join(root, 'docs/images/social-cover.png'), image);
        const result = {
            autoStartWithoutClick: true,
            resumeAfterReducedMotion: true,
            viewportChecks: 24,
            languageSwitch: true,
            focusPause: true,
            schema: true,
            consoleErrors: 0,
            socialPreview: true,
        };
        fs.writeFileSync(path.join(out, 'page-results.json'), JSON.stringify(result, null, 2));
        fs.writeSync(1, JSON.stringify(result) + '\n');
        app.exit(0);
    } catch (error) {
        fs.writeSync(2, String(error.stack || error) + '\n');
        app.exit(1);
    } finally {
        win?.destroy();
    }
});
