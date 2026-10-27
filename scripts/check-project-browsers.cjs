const { webkit, chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-site-redesign');
const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};
const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    const file = path.resolve(root, 'docs', name);
    if (!file.startsWith(path.join(root, 'docs') + path.sep) || !types[path.extname(file)])
        return res.writeHead(404).end();
    try {
        const body = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
});
(async () => {
    await fs.mkdir(out, { recursive: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = process.env.WAVE_SITE_URL || `http://127.0.0.1:${server.address().port}`;
    const results = [];
    try {
        for (const [engine, presets] of [
            [webkit, ['iPhone SE', 'iPhone 13', 'iPhone 13 landscape', 'iPad Mini']],
            [chromium, ['Pixel 7', 'Galaxy S9+', 'Desktop Chrome']],
        ]) {
            const browser = await engine.launch({ headless: true });
            try {
                for (const preset of presets) {
                    const context = await browser.newContext({
                        ...devices[preset],
                        locale: 'ru-RU',
                        reducedMotion: 'no-preference',
                    });
                    const page = await context.newPage();
                    const errors = [];
                    page.on('pageerror', (error) => errors.push(error.message));
                    page.on('response', (res) => {
                        if (res.status() >= 400) errors.push(res.status() + ': ' + res.url());
                    });
                    await page.goto(url);
                    await page.evaluate(() => document.fonts.ready);
                    await page.locator('.record-disc').scrollIntoViewIfNeeded();
                    await page.waitForFunction(() =>
                        document
                            .querySelector('.vinyl')
                            .getAnimations()
                            .some(
                                (a) =>
                                    a.animationName === 'record-spin' &&
                                    a.playState === 'running' &&
                                    a.currentTime > 40,
                            ),
                    );
                    assert.equal(
                        await page
                            .locator('.record-art button,.record-art [role="button"],.record-art [tabindex]')
                            .count(),
                        0,
                    );
                    await page.waitForFunction(() =>
                        document
                            .querySelector('.record-disc')
                            .getAnimations()
                            .every((a) => a.playState !== 'running'),
                    );
                    for (const language of ['ru', 'en']) {
                        await page.locator(`[data-site-language="${language}"]`).click();
                        const layout = await page.evaluate(() => ({
                            width: innerWidth,
                            scroll: document.documentElement.scrollWidth,
                            lang: document.documentElement.lang,
                            h1: document.querySelectorAll('h1').length,
                            bad: [
                                ...document.querySelectorAll(
                                    'nav a,nav button,.button,.text-link,summary,[data-source]',
                                ),
                            ]
                                .filter((el) => el.getClientRects().length)
                                .filter((el) => {
                                    const r = el.getBoundingClientRect();
                                    return r.left < -1 || r.right > innerWidth + 1 || r.height < 43;
                                })
                                .map((el) => el.textContent.trim()),
                        }));
                        assert.equal(layout.h1, 1);
                        assert.equal(layout.lang, language);
                        if (layout.scroll > layout.width) {
                            const debug = await page.evaluate(() =>
                                [...document.querySelectorAll('body *')]
                                    .filter((el) => {
                                        const r = el.getBoundingClientRect();
                                        return r.right > innerWidth + 1;
                                    })
                                    .map((el) => ({
                                        tag: el.tagName,
                                        cls: typeof el.className === 'string' ? el.className : 'svg',
                                        text: el.textContent.slice(0, 50),
                                        r: el.getBoundingClientRect().right,
                                        font: getComputedStyle(el).fontSize,
                                    })),
                            );
                            await fs.writeFile(
                                path.join(out, 'overflow.json'),
                                JSON.stringify({ layout, debug }, null, 2),
                            );
                        }
                        assert(layout.scroll <= layout.width, preset + '/' + language + ': horizontal overflow');
                        assert.deepEqual(layout.bad, [], preset + '/' + language + ': clipped or small controls');
                        assert((await page.locator('h1').textContent()).includes(language === 'ru' ? 'Хватит' : 'Off'));
                        await page.screenshot({
                            path: path.join(out, `${engine.name()}-${preset.replaceAll(' ', '-')}-${language}.png`),
                        });
                    }
                    const links = await page.locator('a.button').evaluateAll((els) => els.map((el) => el.href));
                    assert(links.every((link) => link === 'https://github.com/rvelabs/soundcloud-rpc/releases/latest'));
                    await page.locator('.record-art').click();
                    await page.waitForFunction(
                        () => getComputedStyle(document.querySelector('.vinyl')).animationPlayState === 'running',
                    );
                    for (const source of ['yandex', 'youtube', 'file', 'spotify']) {
                        await page.locator(`[data-source="${source}"]`).click();
                        assert.equal(
                            await page.locator(`[data-source="${source}"]`).getAttribute('aria-pressed'),
                            'true',
                        );
                        assert.equal(await page.locator('[data-source][aria-pressed="true"]').count(), 1);
                        assert((await page.locator('[data-source-copy]').textContent()).length > 40);
                    }
                    await page.locator('summary').first().press('Enter');
                    assert(
                        await page
                            .locator('details')
                            .first()
                            .evaluate((el) => el.open),
                        'keyboard FAQ',
                    );
                    await page.locator('summary').first().press('Enter');
                    assert(
                        !(await page
                            .locator('details')
                            .first()
                            .evaluate((el) => el.open)),
                    );
                    await page.emulateMedia({ reducedMotion: 'reduce' });
                    await page.locator('.record-art').scrollIntoViewIfNeeded();
                    await page.waitForFunction(
                        () =>
                            document
                                .getAnimations()
                                .filter((a) => a.effect?.target?.classList.contains('vinyl'))
                                .some((a) => a.playState === 'running') &&
                            document
                                .getAnimations()
                                .filter((a) => !a.effect?.target?.classList.contains('vinyl'))
                                .every((a) => a.playState !== 'running'),
                    );
                    await page.emulateMedia({ reducedMotion: 'no-preference' });
                    await page.locator('.footer').scrollIntoViewIfNeeded();
                    await page.waitForFunction(
                        () => getComputedStyle(document.querySelector('.vinyl')).animationPlayState === 'paused',
                    );
                    await page.locator('#wave').scrollIntoViewIfNeeded();
                    await page.locator('#wave img').evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode())));
                    for (const selector of ['#wave', '#collection', '#faq', '.download-section']) {
                        if (!['Desktop Chrome', 'iPhone 13'].includes(preset)) break;
                        await page.locator(selector).scrollIntoViewIfNeeded();
                        await page.waitForTimeout(700);
                        await page.locator(selector).screenshot({
                            path: path.join(
                                out,
                                `${engine.name()}-${preset.replaceAll(' ', '-')}-${selector.replace(/[.#]/g, '')}.png`,
                            ),
                            animations: 'disabled',
                        });
                    }
                    assert.deepEqual(errors, [], preset + ': browser errors');
                    results.push({
                        engine: engine.name(),
                        preset,
                        languages: ['ru', 'en'],
                        layout: true,
                        decorativeRecordOnly: true,
                        spinsWithSystemReducedMotion: true,
                        autoStartWithoutClick: true,
                        platformGuide: true,
                        keyboardFAQ: true,
                        reducedMotion: true,
                        offscreenPause: true,
                        errors: 0,
                    });
                    await context.close();
                }
                const fallback = await browser.newContext({
                    ...devices['iPhone SE'],
                    javaScriptEnabled: false,
                    reducedMotion: 'reduce',
                });
                const page = await fallback.newPage();
                await page.goto(url);
                assert(await page.locator('h1').isVisible());
                assert(await page.locator('a.button').first().isVisible());
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                await page.locator('.record-disc').scrollIntoViewIfNeeded();
                await page.waitForFunction(() =>
                    document
                        .querySelector('.vinyl')
                        .getAnimations()
                        .some(
                            (a) => a.animationName === 'record-spin' && a.playState === 'running' && a.currentTime > 40,
                        ),
                );
                await page.locator('summary').first().click();
                assert(
                    await page
                        .locator('details')
                        .first()
                        .evaluate((el) => el.open),
                );
                await fallback.close();
            } finally {
                await browser.close();
            }
        }
        await fs.writeFile(path.join(out, 'browser-results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(results));
    } finally {
        server.close();
    }
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
