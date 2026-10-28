const { app, BrowserWindow, webContents } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-client-startup');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'client-empty-profile'));
let finished = false;
app.on('before-quit', (event) => {
    if (!finished) event.preventDefault();
});
require(path.join(repo, 'tsc/main.js'));
app.whenReady().then(async () => {
    try {
        let window;
        for (let i = 0; i < 300; i++) {
            window = BrowserWindow.getAllWindows().find(
                (win) => win.contentView.children.filter((view) => view.webContents).length >= 2,
            );
            if (window) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert(window, 'client window created');
        let page;
        for (let i = 0; i < 300; i++) {
            page = window.contentView.children
                .filter((view) => view.webContents)
                .find((view) => view.webContents.getURL().startsWith('https://soundcloud.com/'));
            if (
                page &&
                (await page.webContents
                    .executeJavaScript("Boolean(document.querySelector('#codex-wave-inline'))")
                    .catch(() => false))
            )
                break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert(page, 'SoundCloud view loaded');
        const state = await page.webContents.executeJavaScript(
            `({inline:document.querySelectorAll('#codex-wave-inline').length,genre:!!document.querySelector('.cw-genre'),diagnostics:!!document.querySelector('[data-command="copy-diagnostics"]'),native:!!document.querySelector('.playControls')})`,
        );
        assert.equal(state.inline, 1);
        assert.equal(state.genre, false);
        assert.equal(state.diagnostics, true);
        await assert.rejects(page.webContents.executeJavaScript(`window.waveInline.setLanguage('unsupported')`));
        await page.webContents.executeJavaScript(`window.waveInline.setLanguage('en')`);
        page.webContents.reload();
        let translated = false;
        for (let attempt = 0; attempt < 200; attempt++) {
            translated = await page.webContents
                .executeJavaScript(
                    `document.querySelector('#codex-wave-inline h2')?.textContent==='My Wave' && document.querySelector('.cw-interface-language select')?.value==='en'`,
                )
                .catch(() => false);
            if (translated) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(translated, 'interface language survives a full page reload');
        const attached = new Set([
            window.webContents.id,
            ...window.contentView.children.filter((view) => view.webContents).map((view) => view.webContents.id),
        ]);
        const background = webContents.getAllWebContents().filter((wc) => !attached.has(wc.id));
        window.destroy();
        await new Promise((r) => setTimeout(r, 500));
        assert(
            background.every((wc) => wc.isDestroyed()),
            'background pages released on window close',
        );
        const result = { state, backgroundPages: background.length, backgroundReleased: true };
        fs.writeFileSync(path.join(out, 'client-startup.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        finished = true;
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        finished = true;
        app.exit(1);
    }
});
