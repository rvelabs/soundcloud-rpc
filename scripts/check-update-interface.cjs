const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-update-interface');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'updates-ui-' + Date.now()));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    let window, untrusted, controller;
    try {
        const { SettingsManager } = require(path.join(repo, 'tsc/settings/settingsManager'));
        const { TranslationService } = require(path.join(repo, 'tsc/services/translationService'));
        const { UpdateController } = require(path.join(repo, 'tsc/updates/updateController'));
        const { presentUpdate } = require(path.join(repo, 'tsc/updates/presentation'));
        window = new BrowserWindow({ show: false, width: 1100, height: 850 });
        const header = new BrowserView({
            webPreferences: { preload: path.join(repo, 'tsc/header/headerPreload.js'), sandbox: true },
        });
        window.addBrowserView(header);
        header.setBounds({ x: 0, y: 0, width: 1100, height: 32 });
        const values = new Map();
        let settings,
            view,
            finishDownload,
            installs = 0,
            opened = 0;
        const backend = new EventEmitter();
        backend.on('error', () => {});
        backend.checkForUpdates = async () => {
            backend.emit('update-available', { version: '0.28.3', workerProtocolRevision: 2 });
        };
        backend.downloadUpdate = (token) =>
            token.createPromise((resolve) => {
                finishDownload = () => {
                    backend.emit('update-downloaded');
                    resolve([]);
                };
            });
        backend.quitAndInstall = () => {
            installs++;
        };
        const present = () => presentUpdate(controller.snapshot(), true);
        controller = new UpdateController(backend, {
            currentVersion: '0.28.2',
            mode: 'notify',
            installSupported: true,
            canCheck: true,
            workerRevision: 2,
            usesWorker: () => false,
            pendingWorker: () => 0,
            setPendingWorker: () => {},
            changed: () => {
                for (const contents of [view?.webContents, header.webContents])
                    if (contents && !contents.isDestroyed()) contents.send('updates:state', present());
            },
            notify: () => {},
            beforeInstall: () => {},
        });
        for (const channel of [
            'updates:status',
            'updates:check',
            'updates:download',
            'updates:install',
            'updates:mode',
            'updates:release-notes',
            'updates:worker-ack',
        ])
            ipcMain.handle(channel, async (event, value) => {
                if (
                    !settings?.owns(event.sender) &&
                    !(channel === 'updates:status' && event.sender === header.webContents)
                )
                    throw Error('Untrusted update action');
                if (channel === 'updates:check') await controller.check();
                if (channel === 'updates:download') void controller.download();
                if (channel === 'updates:install') controller.install();
                if (channel === 'updates:mode') controller.setMode(value);
                return present();
            });
        ipcMain.on('updates:open', (event) => {
            assert.equal(event.sender, header.webContents);
            opened++;
            settings.showUpdates();
        });
        for (const [channel, value] of Object.entries({
            'get-current-track': null,
            'get-custom-themes': [],
            'get-current-custom-theme': null,
            'get-plugins': [],
            'get-accounts': { accounts: [], currentAccountId: 'default' },
            'get-translations': {},
            'get-navigation-controls-enabled': false,
            'get-theme-colors': null,
            'is-maximized': false,
        }))
            ipcMain.handle(channel, () => value);
        settings = new SettingsManager(
            window,
            {
                get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
                set: (key, value) => values.set(key, value),
            },
            new TranslationService(),
        );
        assert.equal(settings.getView(), null);
        settings.toggle();
        view = settings.getView();
        const errors = [];
        view.webContents.on('console-message', (_event, level, message) => {
            if (level >= 3 && /Uncaught|SyntaxError/.test(message)) errors.push(message);
        });
        if (view.webContents.isLoadingMainFrame())
            await new Promise((resolve) => view.webContents.once('did-finish-load', resolve));
        await header.webContents.loadFile(path.join(repo, 'tsc/header/header.html'));
        await wait(100);
        assert.equal(await view.webContents.executeJavaScript("document.getElementById('updateMode').value"), 'notify');
        await view.webContents.executeJavaScript("document.getElementById('updates-check').click()");
        await wait(80);
        assert.equal(controller.snapshot().phase, 'available');
        assert.equal(installs, 0);
        assert.equal(
            await header.webContents.executeJavaScript("document.getElementById('update-badge').hidden"),
            false,
        );
        await header.webContents.executeJavaScript("document.getElementById('update-badge').click()");
        await wait(80);
        assert.equal(opened, 1);
        assert.equal(view.getBounds().y, 32);
        await view.webContents.executeJavaScript("document.getElementById('updates-download').click()");
        await wait(50);
        backend.emit('download-progress', { percent: 55 });
        await wait(50);
        assert.equal(await view.webContents.executeJavaScript("document.getElementById('updates-progress').value"), 55);
        finishDownload();
        await wait(80);
        assert.equal(controller.snapshot().phase, 'ready');
        assert.equal(installs, 0);
        assert.equal(
            await view.webContents.executeJavaScript("document.getElementById('updates-install').hidden"),
            false,
        );
        untrusted = new BrowserWindow({
            show: false,
            webPreferences: { preload: path.join(repo, 'tsc/settings/settingsPreload.js'), sandbox: true },
        });
        await untrusted.loadURL('data:text/html,<body>Untrusted fixture</body>');
        await assert.rejects(untrusted.webContents.executeJavaScript("window.settingsAPI.invoke('updates:install')"));
        assert.equal(installs, 0);
        await view.webContents.executeJavaScript("document.getElementById('updates-install').click()");
        await wait(50);
        assert.equal(installs, 1);
        await view.webContents.executeJavaScript(
            "const mode=document.getElementById('updateMode');mode.value='off';mode.dispatchEvent(new Event('change'))",
        );
        await wait(50);
        assert.equal(controller.snapshot().mode, 'off');
        assert.deepEqual(errors, []);
        const result = {
            settingsBridge: true,
            headerBadge: true,
            progress: true,
            explicitRestart: true,
            untrustedInstallRejected: true,
            modeSelection: true,
        };
        fs.writeFileSync(path.join(out, 'update-interface.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        controller?.dispose();
        if (untrusted && !untrusted.isDestroyed()) untrusted.destroy();
        if (window && !window.isDestroyed()) window.destroy();
    }
});
setTimeout(() => {
    console.error('update interface deadline');
    app.exit(1);
}, 30000).unref();
