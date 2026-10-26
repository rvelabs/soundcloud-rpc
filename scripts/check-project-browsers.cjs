const { webkit, chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-project-browsers');
const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.ico': 'image/x-icon',
    '.css': 'text/css',
    '.webp': 'image/webp',
};
const server = http.createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    const file = path.resolve(repo, 'docs', name);
    if (!file.startsWith(path.resolve(repo, 'docs') + path.sep) || !types[path.extname(file)]) {
        response.writeHead(404).end();
        return;
    }
    response.setHeader('Content-Type', types[path.extname(name)] + ';charset=utf-8');
    try {
        response.end(await fs.readFile(file));
    } catch {
        response.writeHead(404).end();
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
                    const context = await browser.newContext({ ...devices[preset], locale: 'ru-RU' });
                    const page = await context.newPage();
                    const errors = [];
                    page.on('pageerror', (error) => errors.push(error.message));
                    page.on('response', (response) => {
                        if (response.status() >= 400) errors.push(response.status() + ': ' + response.url());
                    });
                    await page.goto(url);
                    for (const language of ['ru', 'en']) {
                        await page.locator(`[data-site-language="${language}"]`).click();
                        await page.waitForTimeout(850);
                        const layout = await page.evaluate(() => {
                            const controls = [...document.querySelectorAll('nav a,button,.button,summary')].filter(
                                (element) => element.getClientRects().length,
                            );
                            return {
                                width: innerWidth,
                                scrollWidth: document.documentElement.scrollWidth,
                                bad: controls
                                    .filter((element) => {
                                        const rect = element.getBoundingClientRect();
                                        return rect.left < -1 || rect.right > innerWidth + 1 || rect.height < 43;
                                    })
                                    .map((element) => element.textContent.trim()),
                            };
                        });
                        assert(layout.scrollWidth <= layout.width, preset + '/' + language + ': overflow');
                        assert.deepEqual(layout.bad, [], preset + '/' + language + ': touch targets');
                        await page.screenshot({
                            path: path.join(out, `${engine.name()}-${preset.replaceAll(' ', '-')}-${language}.png`),
                        });
                    }
                    assert(
                        await page
                            .locator('[data-en]')
                            .evaluateAll((elements) =>
                                elements.every((element) => element.textContent === element.dataset.en),
                            ),
                        preset + ': all new content is translated',
                    );
                    await page.locator('[data-mood="energy"]').click();
                    assert.equal(await page.locator('.wave-preview').getAttribute('data-preview-mood'), 'energy');
                    assert.equal(await page.locator('[data-mood="energy"]').getAttribute('aria-pressed'), 'true');
                    await page.locator('.preview-toggle').click();
                    await page.waitForFunction(() =>
                        document
                            .getAnimations()
                            .some(
                                (animation) =>
                                    animation.playState === 'running' &&
                                    animation.effect.target.closest('.preview-bars'),
                            ),
                    );
                    for (const key of ['settings', 'import', 'wave']) {
                        await page.locator(`[data-gallery="${key}"]`).click();
                        await page.waitForSelector(`[data-gallery-panel="${key}"]:not([hidden])`);
                        assert(
                            await page
                                .locator(`[data-gallery-panel="${key}"] img`)
                                .evaluate((image) => image.complete && image.naturalWidth > 0),
                            preset + ': screenshot loaded',
                        );
                    }
                    await page.evaluate(() =>
                        ['settings', 'import', 'wave'].forEach((key) =>
                            document.querySelector(`[data-gallery="${key}"]`).click(),
                        ),
                    );
                    await page.waitForFunction(
                        () =>
                            document.querySelector('.gallery-stage').getAttribute('aria-busy') === 'false' &&
                            !document.querySelector('[data-gallery-panel="wave"]').hidden,
                    );
                    const zoom = page.locator('[data-gallery-panel="wave"] [data-zoom]');
                    await zoom.click();
                    await page.waitForSelector('.lightbox[open]');
                    assert(await page.locator('.lightbox img').evaluate((image) => image.naturalWidth > 0));
                    await page.keyboard.press('Escape');
                    await page.waitForSelector('.lightbox', { state: 'hidden' });
                    assert(
                        await zoom.evaluate((element) => element === document.activeElement),
                        preset + ': dialog restores keyboard focus',
                    );
                    await page.evaluate(() => {
                        document.documentElement.style.fontSize = '200%';
                    });
                    const oversized = await page.evaluate(() => ({
                        width: innerWidth,
                        scroll: document.documentElement.scrollWidth,
                        items: [...document.querySelectorAll('body *')]
                            .map((element) => ({
                                tag: element.tagName,
                                cls: element.className,
                                right: element.getBoundingClientRect().right,
                                width: element.getBoundingClientRect().width,
                            }))
                            .filter((item) => item.right > innerWidth + 1)
                            .slice(0, 30),
                    }));
                    assert(oversized.scroll <= oversized.width, preset + ': 200% text: ' + JSON.stringify(oversized));
                    await page.evaluate(() => {
                        document.documentElement.style.fontSize = '';
                    });
                    await page.locator('summary').first().click();
                    assert(
                        await page
                            .locator('details')
                            .first()
                            .evaluate((element) => element.open),
                    );
                    await page.emulateMedia({ reducedMotion: 'reduce' });
                    await page.waitForFunction(
                        () =>
                            matchMedia('(prefers-reduced-motion: reduce)').matches &&
                            document.getAnimations().every((animation) => animation.playState !== 'running'),
                    );
                    assert.equal(
                        await page.evaluate(
                            () =>
                                document.getAnimations().filter((animation) => animation.playState === 'running')
                                    .length,
                        ),
                        0,
                    );
                    assert.deepEqual(errors, [], preset + ': browser errors');
                    await page.emulateMedia({ reducedMotion: 'no-preference' });
                    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
                    await page.waitForTimeout(900);
                    assert.equal(
                        await page.evaluate(
                            () =>
                                document.getAnimations().filter((animation) => animation.playState === 'running')
                                    .length,
                        ),
                        0,
                        preset + ': offscreen loops pause',
                    );
                    results.push({
                        engine: engine.name(),
                        preset,
                        languages: ['ru', 'en'],
                        preview: true,
                        gallery: true,
                        dialogKeyboard: true,
                        enlargedText: true,
                        offscreenPause: true,
                        passed: true,
                    });
                    if (['iPhone 13', 'Desktop Chrome'].includes(preset)) {
                        for (const selector of ['.story-section', '#gallery', '.import-story']) {
                            await page
                                .locator(selector)
                                .evaluate((element) =>
                                    element.scrollIntoView({ behavior: 'instant', block: 'center' }),
                                );
                            await page.waitForTimeout(800);
                            await page
                                .locator(selector)
                                .locator('img')
                                .evaluateAll((images) =>
                                    Promise.all(images.map((image) => image.decode().catch(() => {}))),
                                );
                            assert(
                                await page
                                    .locator(selector)
                                    .evaluate((element) =>
                                        [element, ...element.querySelectorAll('[data-reveal]')].every(
                                            (item) => Number(getComputedStyle(item).opacity) > 0.99,
                                        ),
                                    ),
                                selector + ': section is readable after reveal',
                            );
                            await page.locator(selector).screenshot({
                                path: path.join(
                                    out,
                                    `${engine.name()}-${preset.replaceAll(' ', '-')}-${selector.replace(/[.#]/g, '')}.png`,
                                ),
                                animations: 'disabled',
                            });
                        }
                    }
                    await context.close();
                }
                const fallback = await browser.newContext({ ...devices['iPhone SE'], javaScriptEnabled: false });
                const page = await fallback.newPage();
                await page.goto(url);
                assert(await page.locator('h1').isVisible(), 'no-JavaScript heading');
                assert(
                    await page.locator('.hero-photo img').evaluate((image) => image.complete && image.naturalWidth > 0),
                    'no-JavaScript photograph',
                );
                assert(
                    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                    'no-JavaScript layout',
                );
                await fallback.close();
            } finally {
                await browser.close();
            }
        }
        await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(results));
    } finally {
        server.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
