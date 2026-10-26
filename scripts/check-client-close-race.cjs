const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-close-race');
const profile = path.join(out, 'close-race-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(
    path.join(profile, 'config.json'),
    JSON.stringify({ adBlocker: false, discordRichPresence: false, minimizeToTray: false }),
);
app.setPath('userData', profile);
let done = false,
    armed = false;
process.on('uncaughtException', (error) => {
    console.error(error.stack);
    app.exit(1);
});
app.on('before-quit', (event) => {
    if (!done) event.preventDefault();
});
app.on('web-contents-created', (_event, contents) => {
    contents.on('did-finish-load', () => {
        if (armed || !contents.getURL().startsWith('https://soundcloud.com/')) return;
        armed = true;
        setTimeout(() => {
            const window = BrowserWindow.getAllWindows().find((win) =>
                win.getBrowserViews().some((view) => view.webContents === contents),
            );
            contents.close({ waitForBeforeUnload: false });
            window?.destroy();
            setTimeout(() => {
                assert(contents.isDestroyed());
                console.log(JSON.stringify({ closedBeforeWarmup: true, waitedMs: 2300, uncaughtExceptions: 0 }));
                done = true;
                app.exit(0);
            }, 2300);
        }, 30);
    });
});
app.whenReady().then(() =>
    session.defaultSession.protocol.handle(
        'https',
        () =>
            new Response(
                '<!doctype html><main id="content"><div class="l-main"><div class="l-content"></div></div></main>',
                { headers: { 'content-type': 'text/html' } },
            ),
    ),
);
require(path.join(repo, 'tsc/main.js'));
setTimeout(() => {
    console.error('close-race deadline');
    done = true;
    app.exit(1);
}, 20000).unref();
