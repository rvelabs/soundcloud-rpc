const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const assets = path.join(__dirname, 'gen/android/app/src/main/assets');
const output = path.join(__dirname, '../build-android-validation/layout');
fs.mkdirSync(output, { recursive: true });
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const results = [];
    try {
        const context = await browser.newContext({ locale: 'ru-RU' });
        const page = await context.newPage();
        const settingsPage = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        settingsPage.on('pageerror', (error) => errors.push(error.message));
        await context.route('https://appassets.androidplatform.net/assets/**', route => {const name=path.basename(new URL(route.request().url()).pathname);route.fulfill({contentType:name.endsWith('.js')?'text/javascript':'text/html',body:fs.readFileSync(path.join(assets,name))});});
        await page.route('https://soundcloud.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(assets, 'android-fixture.html')) }));
        await context.addInitScript(() => {
            const profiles = {};
            window.__SC_ANDROID = {
                postMessage(raw) {
                    const { id, command, args } = JSON.parse(raw);
                    let value = null;
                    if (command === 'client_options') value = { theme: 'dark', zoom: 1, adBlocker: true, navigation: false };
                    if (command === 'profile_load') value = profiles[args.key] || {};
                    if (command === 'profile_save') profiles[args.key] = args.value;
                    if (command === 'listening_status') value = { enabled: false };
                    if (command === 'listening_options') value = { pending: 0, apiKey: '', webhookTrigger: 50, parseTitle: true };
                    if (command === 'connection_load') value = { mode: 'off', endpoint: '', hasKey: false };
                    if (command === 'adblock_action') value = { enabled: true, attached: true, blocked: 0, rules: 10 };
                    if (command === 'native_diagnostics') value = { catalog: { ready: false, authenticated: false, revision: 0 } };
                    if (command === 'android_equalizer') value = { status: 'off' };
                    queueMicrotask(() => window.__SC_ANDROID.onmessage?.({ data: JSON.stringify({ id, value }) }));
                },
            };
        });
        await page.goto('https://soundcloud.com/__android_fixture');
        await page.addScriptTag({ path: path.join(assets, 'android-bootstrap.js') });
        await page.addScriptTag({ path: path.join(assets, 'android-inject.js') });
        await page.waitForSelector('#android-open-settings');
        await page.waitForFunction(() => !!window.waveInline);
        for (const [width, height] of [[320,568],[360,640],[375,812],[393,873],[412,915],[480,800],[600,960],[768,1024],[640,360],[873,393]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(() => window.__androidPlayback({ title: 'Длинное название трека для проверки небольших экранов', author: 'Исполнитель', url: 'https://soundcloud.com/test/track', isPlaying: true, elapsed: '0:20', duration: '3:40' }));
            await settingsPage.setViewportSize({ width, height });
            await settingsPage.goto('https://appassets.androidplatform.net/assets/android-settings.html');
            await settingsPage.waitForSelector('#android-settings select');
            const mainWidth = await page.evaluate(() => document.documentElement.scrollWidth);
            assert(mainWidth <= width + 1, `Main page overflow at ${width}`);
            const metrics = await settingsPage.evaluate(() => {
                const dialog = document.getElementById('android-settings').getBoundingClientRect();
                const player = { left:0, right:innerWidth, bottom:innerHeight };
                return { body: document.documentElement.scrollWidth, width: innerWidth, dialog: { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom }, player: { left: player.left, right: player.right, bottom: player.bottom }, height: innerHeight };
            });
            assert(metrics.body <= width + 1, `Horizontal overflow at ${width}×${height}: ${metrics.body}`);
            assert(metrics.dialog.left >= 0 && metrics.dialog.right <= width + 1 && metrics.dialog.top >= 0 && metrics.dialog.bottom <= height + 1, `Settings escaped viewport: ${width}×${height}`);
            assert(metrics.player.right <= width + 1 && metrics.player.bottom <= height + 1, 'Player escaped viewport');
            await settingsPage.screenshot({ path: path.join(output, `${width}x${height}-settings.png`) });
            await page.screenshot({ path: path.join(output, `${width}x${height}.png`) });
            await settingsPage.locator('.android-close').click();
            results.push({ width, height, success: true });
        }
        assert.deepEqual(errors, [], 'Frontend runtime errors');
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ success: true, results, errors }, null, 2));
        console.log(`Android layout: ${results.length} viewports passed, zero page errors (mocked native bridge).`);
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
