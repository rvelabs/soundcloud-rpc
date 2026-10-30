const { app, BrowserWindow, WebContentsView, nativeImage } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-presentation-background');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile-' + Date.now()));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = async (promise, name, milliseconds = 1800) => {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(Error(name + ' blocked playback')), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 1000, height: 800 });
    const content = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } });
    window.contentView.addChildView(content);
    content.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
    let visible = true,
        freezePaint = false,
        freezeLoad = false,
        freezeScroll = false,
        paintRequests = 0;
    const screenshot = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 });
    window.isVisible = () => visible;
    window.isMinimized = () => !visible;
    content.webContents.capturePage = async () => screenshot;
    const execute = content.webContents.executeJavaScript.bind(content.webContents);
    content.webContents.executeJavaScript = (code, ...args) =>
        freezeScroll && code.startsWith('scrollTo(') ? new Promise(() => {}) : execute(code, ...args);
    app.on('web-contents-created', (_event, contents) => {
        contents.capturePage = async () => screenshot;
        const load = contents.loadURL.bind(contents);
        contents.loadURL = (...args) => (freezeLoad ? new Promise(() => {}) : load(...args));
        const run = contents.executeJavaScript.bind(contents);
        contents.executeJavaScript = (code, ...args) => {
            if (code.includes("const image=document.querySelector('img')")) {
                paintRequests++;
                if (freezePaint) return new Promise(() => {});
            }
            return run(code, ...args);
        };
    });
    try {
        await content.webContents.loadURL(
            'data:text/html,<style>body{margin:0}.playControls{position:fixed;bottom:0;height:50px;width:100%}</style><div>SoundCloud</div><div class="playControls"></div>',
        );
        const { installNativePageCover } = require(path.join(root, 'tsc/wave/nativePageCover.js'));
        const { beginNativePageCover } = require(path.join(root, 'tsc/wave/nativePresentation.js'));
        installNativePageCover(window, content);
        const finishWarm = await within(beginNativePageCover(content.webContents), 'warm visible cover');
        await within(finishWarm(), 'warm cover cleanup');
        assert(paintRequests > 0, 'cover has a cached screenshot before minimizing');
        const paintsBeforeBackground = paintRequests;
        visible = false;
        freezePaint = true;
        const finishHidden = await within(beginNativePageCover(content.webContents), 'warm-to-background cover');
        await within(finishHidden(), 'background cover cleanup');
        assert.equal(paintRequests, paintsBeforeBackground, 'hidden playback does not await decorative painting');
        visible = true;
        freezeLoad = true;
        await within(
            (async () => {
                const finish = await beginNativePageCover(content.webContents);
                await finish();
            })(),
            'suspended cover loading',
        );
        freezeLoad = false;
        await within(
            (async () => {
                const finish = await beginNativePageCover(content.webContents);
                await finish();
            })(),
            'suspended cover paint',
        );
        freezePaint = false;
        const finishScroll = await within(beginNativePageCover(content.webContents), 'visible cover after recovery');
        freezeScroll = true;
        await within(finishScroll(), 'suspended scroll restoration');
        const result = {
            warmToBackground: true,
            backgroundHasNoPaintWait: true,
            suspendedLoadBounded: true,
            suspendedPaintBounded: true,
            suspendedCleanupBounded: true,
        };
        fs.writeFileSync(path.join(out, 'presentation-background.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        window.destroy();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        window.destroy();
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 20000).unref();
