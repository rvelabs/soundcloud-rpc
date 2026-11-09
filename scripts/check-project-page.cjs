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
                "document.querySelector('.vinyl-rotor').getAnimations().some(a=>a.animationName==='vinyl-spin' && a.playState==='running')",
            );
        assert(await recordRunning(), 'record starts before any interaction, without document focus');
        assert.equal(
            await wc.executeJavaScript(
                "document.querySelectorAll('.record-art button,.record-art [role=button],.record-art [tabindex]').length",
            ),
            0,
        );
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await wc.executeJavaScript(
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
        );
        assert.equal(
            await wc.executeJavaScript(
                "document.getAnimations().filter(a=>a.playState==='running' && !a.effect?.target?.classList.contains('vinyl-rotor')).length",
            ),
            0,
        );
        assert(await recordRunning(), 'decorative record rotates with system reduced motion');
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        });
        await new Promise((resolve) => setTimeout(resolve, 140));
        assert(await recordRunning(), 'restoring motion resumes rotation without a click');
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        const chooseMotion = (mode) =>
            wc.executeJavaScript(
                `(()=>{const choice=document.querySelector('[data-motion-preference]');choice.value='${mode}';choice.dispatchEvent(new Event('change'))})()`,
            );
        await chooseMotion('full');
        assert.equal(await wc.executeJavaScript('getComputedStyle(document.documentElement).scrollBehavior'), 'smooth');
        assert.equal(
            await wc.executeJavaScript("getComputedStyle(document.querySelector('.vinyl-rotor')).animationDuration"),
            '28s',
        );
        await wc.executeJavaScript("document.querySelector('[data-source=yandex]').click()");
        assert(
            await wc.executeJavaScript(
                "document.querySelector('[data-source-copy]').getAnimations().some(a=>a.playState==='running')",
            ),
            'explicit full motion overrides system reduction',
        );
        await wc.loadFile(path.join(root, 'docs/index.html'));
        await wc.executeJavaScript('document.fonts.ready.then(()=>true)');
        assert.equal(await wc.executeJavaScript('document.documentElement.dataset.motionMode'), 'full');
        assert.equal(await wc.executeJavaScript("document.querySelector('[data-motion-preference]').value"), 'full');
        assert.equal(await wc.executeJavaScript('getComputedStyle(document.documentElement).scrollBehavior'), 'smooth');
        assert(
            await wc.executeJavaScript("matchMedia('(prefers-reduced-motion:reduce)').matches"),
            'the OS setting has not been changed',
        );
        await wc.executeJavaScript("document.querySelector('[data-site-language=en]').click()");
        assert.equal(
            await wc.executeJavaScript("document.querySelector('[data-motion-preference] option:checked').textContent"),
            'On',
        );
        await chooseMotion('auto');
        await wc.loadFile(path.join(root, 'docs/index.html'));
        await wc.executeJavaScript('document.fonts.ready.then(()=>true)');
        await chooseMotion('full');
        assert(
            await wc.executeJavaScript(
                "document.querySelector('.hero-copy').getAnimations().some(a=>a.effect.getTiming().duration===650)",
            ),
            'enabling motion reveals elements skipped by the system preference',
        );
        await chooseMotion('reduced');
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        });
        await wc.executeJavaScript(
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
        );
        assert.equal(await wc.executeJavaScript('getComputedStyle(document.documentElement).scrollBehavior'), 'auto');
        assert.equal(
            await wc.executeJavaScript(
                "document.getAnimations().filter(a=>a.playState==='running'&&!a.effect?.target?.classList.contains('vinyl-rotor')).length",
            ),
            0,
        );
        await chooseMotion('auto');
        assert.equal(await wc.executeJavaScript('getComputedStyle(document.documentElement).scrollBehavior'), 'smooth');
        await wc.executeJavaScript("localStorage.removeItem('soundcloud-site-motion')");
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
            await wc.executeJavaScript("getComputedStyle(document.querySelector('.vinyl-rotor')).animationPlayState"),
            'running',
        );
        await wc.executeJavaScript("dispatchEvent(new Event('blur'))");
        await new Promise((r) => setTimeout(r, 70));
        assert.equal(
            await wc.executeJavaScript("getComputedStyle(document.querySelector('.vinyl-rotor')).animationPlayState"),
            'paused',
            await wc.executeJavaScript(
                "JSON.stringify({classes:document.querySelector('.record-art').className,focus:document.hasFocus(),hidden:document.hidden})",
            ),
        );
        await wc.executeJavaScript("dispatchEvent(new Event('focus'))");
        const state = await wc.executeJavaScript(
            `({h1:document.querySelectorAll('h1').length,canonical:document.querySelector('link[rel=canonical]').href,schema:JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)})`,
        );
        assert.equal(state.h1, 1);
        assert.equal(state.canonical, 'https://rvelabs.github.io/soundcloud-rpc/');
        assert.equal(state.schema['@type'], 'SoftwareApplication');
        assert.deepEqual(errors, []);
        for (const language of ['ru', 'en']) {
            await wc.executeJavaScript(`document.querySelector('[data-site-language="${language}"]').click()`);
            for (const tab of ['wave', 'settings', 'import', 'equalizer']) {
                await wc.executeJavaScript(`document.querySelector('[data-gallery="${tab}"]').click()`);
                const suffix = `app-${tab}${language === 'ru' ? '-ru' : ''}.webp`;
                let preview;
                for (let attempt = 0; attempt < 30; attempt++) {
                    preview = await wc.executeJavaScript(
                        `(()=>{const image=document.querySelector('#product-image');return {src:image.src,width:image.naturalWidth,selected:document.querySelector('[data-gallery][aria-selected="true"]').dataset.gallery,tabStops:document.querySelectorAll('[data-gallery][tabindex="0"]').length,error:image.dataset.loadError}})()`,
                    );
                    if (preview.src.endsWith(suffix) && preview.width === 1280) break;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                assert(preview.src.endsWith(suffix) && preview.width === 1280, 'localized preview loads');
                assert.equal(preview.selected, tab);
                assert.equal(preview.tabStops, 1);
                assert(!preview.error);
            }
        }
        await wc.executeJavaScript("document.querySelector('[data-gallery=wave]').focus()");
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
        assert.equal(await wc.executeJavaScript('document.activeElement.dataset.gallery'), 'equalizer');
        await wc.executeJavaScript("document.querySelector('[data-zoom]').click()");
        assert(await wc.executeJavaScript("document.querySelector('dialog').open"));
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Escape',
            code: 'Escape',
            windowsVirtualKeyCode: 27,
            nativeVirtualKeyCode: 27,
        });
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Escape',
            code: 'Escape',
            windowsVirtualKeyCode: 27,
            nativeVirtualKeyCode: 27,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(await wc.executeJavaScript("document.querySelector('dialog').open"), false);
        assert(await wc.executeJavaScript("document.activeElement.matches('[data-zoom]')"));
        for (const source of ['spotify', 'yandex', 'youtube', 'file']) {
            await wc.executeJavaScript(`document.querySelector('[data-source="${source}"]').click()`);
            assert.equal(
                await wc.executeJavaScript("document.querySelector('[data-source][aria-pressed=true]').dataset.source"),
                source,
            );
        }
        await wc.executeJavaScript("document.querySelector('[data-site-language=ru]').click()");
        await wc.executeJavaScript(
            "document.querySelector('#equalizer').scrollIntoView({behavior:'instant',block:'center'});true;",
        );
        await new Promise((resolve) => setTimeout(resolve, 140));
        assert(
            await wc.executeJavaScript(
                "document.querySelector('#equalizer').getAnimations().some(a=>a.effect.getTiming().duration===650)",
            ),
            'new section reveals when scrolled into view',
        );
        const { equalizerPresets } = require(path.join(root, 'tsc/audio/equalizerSettings.js'));
        for (const id of ['punch', 'vocal', 'warm']) {
            const preview = await wc.executeJavaScript(
                `(()=>{document.querySelector('[data-eq="${id}"]').click();return {selected:document.querySelectorAll('[data-eq][aria-pressed="true"]').length,gains:[...document.querySelectorAll('.eq-bands > div')].map(b=>Number(b.style.getPropertyValue('--gain')))}})()`,
            );
            assert.equal(preview.selected, 1);
            assert.deepEqual(
                preview.gains,
                equalizerPresets.find((preset) => preset.id === id).gains,
                'website preview matches the shipped preset',
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 1100));
        fs.writeFileSync(
            path.join(out, 'equalizer-desktop.png'),
            (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
        );
        await wc.executeJavaScript(
            "document.querySelector('#collection').scrollIntoView({behavior:'instant',block:'center'});true;",
        );
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.notEqual(
            await wc.executeJavaScript("getComputedStyle(document.querySelector('.taste-illustration')).transform"),
            'none',
            'reveals preserve the tilted card design',
        );
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
            width: 390,
            height: 844,
            deviceScaleFactor: 1,
            mobile: true,
        });
        await wc.executeJavaScript(
            "document.querySelector('#equalizer').scrollIntoView({behavior:'instant',block:'start'});true;",
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(
            path.join(out, 'equalizer-mobile.png'),
            (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
        );
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
            await wc.executeJavaScript(
                "document.getAnimations().filter(a=>a.playState==='running'&&!a.effect?.target?.classList.contains('vinyl-rotor')).length",
            ),
            0,
            'reduced motion cancels entrance and scroll effects',
        );
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
            width: 1200,
            height: 800,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await wc.executeJavaScript("scrollTo({top:0,behavior:'instant'});true;");
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
        const result = {
            autoStartWithoutClick: true,
            resumeAfterReducedMotion: true,
            explicitMotionOverridesSystem: true,
            motionPreferencePersists: true,
            reducedMotionOverride: true,
            viewportChecks: 24,
            languageSwitch: true,
            offscreenAndUnfocusedRecordPauses: true,
            spinsWithSystemReducedMotion: true,
            decorativeRecordOnly: true,
            schema: true,
            consoleErrors: 0,
            socialPreview: true,
            scrollReveals: true,
            equalizerPreviewMatchesApp: true,
            localizedGalleryChecks: 8,
            galleryKeyboard: true,
            imageDialogEscapeAndFocus: true,
            playlistSourceChoices: 4,
            reducedMotionCancelsEffects: true,
            tiltedCardPreserved: true,
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
