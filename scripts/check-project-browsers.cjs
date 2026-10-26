const { webkit, chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-project-browsers');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.ico': 'image/x-icon' };
const server = http.createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!['index.html', 'animations.js', 'language.js', 'favicon.ico'].includes(name)) {
        response.writeHead(404).end();
        return;
    }
    response.setHeader('Content-Type', types[path.extname(name)] + ';charset=utf-8');
    response.end(await fs.readFile(path.join(repo, 'docs', name)));
});
(async () => {
    await fs.mkdir(out, { recursive: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
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
                    await page.goto(url);
                    for (const language of ['ru', 'en']) {
                        await page.locator(`[data-site-language="${language}"]`).click();
                        await page.waitForTimeout(850);
                        const layout = await page.evaluate(() => {
                            const controls = [...document.querySelectorAll('nav a,nav button,.button,summary')];
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
                    results.push({ engine: engine.name(), preset, languages: ['ru', 'en'], passed: true });
                    await context.close();
                }
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
