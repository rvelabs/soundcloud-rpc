const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage } = require('electron');
const fs = require('fs'),
    path = require('path'),
    assert = require('assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..'),
    out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-network-check');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'network-empty-profile'));
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
    let win;
    try {
        const values = new Map(),
            store = {
                get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
                set: (key, value) => values.set(key, value),
            };
        const { SettingsManager } = require(path.join(repo, 'tsc/settings/settingsManager.js'));
        const { TranslationService } = require(path.join(repo, 'tsc/services/translationService.js'));
        const { ConnectionRecovery } = require(path.join(repo, 'tsc/network/connectionRecovery.js'));
        const { ProxyService } = require(path.join(repo, 'tsc/services/proxyService.js'));
        win = new BrowserWindow({ width: 1100, height: 850, show: true });
        const main = new WebContentsView({ webPreferences: { partition: 'network-fixture-account', sandbox: true } });
        win.contentView.addChildView(main);
        main.setBounds({ x: 0, y: 0, width: 1100, height: 850 });
        await main.webContents.loadURL('about:blank');
        const errors = [];
        const service = new ConnectionRecovery(main.webContents, store, () => {});
        const token = 'test_key_'.repeat(8);
        service.save({ mode: 'off', endpoint: 'https://example.workers.dev', secret: token });
        assert(!values.get('cloudflareSecretEncrypted').includes(token));
        assert.equal(safeStorage.decryptString(Buffer.from(values.get('cloudflareSecretEncrypted'), 'base64')), token);
        const before = await win.webContents.session.resolveProxy('https://soundcloud.com');
        store.set('proxyEnabled', true);
        store.set('proxyHost', '127.0.0.1');
        store.set('proxyPort', '54321');
        await new ProxyService(win, store, () => {}, main.webContents.session).apply();
        assert.equal(await main.webContents.session.resolveProxy('https://soundcloud.com'), 'PROXY 127.0.0.1:54321');
        assert.equal(await win.webContents.session.resolveProxy('https://soundcloud.com'), before);
        store.set('proxyEnabled', false);
        await main.webContents.session.setProxy({ mode: 'direct' });
        service.gateway = { start: async () => 54322, close: () => {} };
        service.probe = async (target) => {
            assert.equal(await target.resolveProxy('https://api-v2.soundcloud.com/'), 'PROXY 127.0.0.1:54322');
            assert.equal(await target.resolveProxy('https://cf-media.sndcdn.com/'), 'PROXY 127.0.0.1:54322');
            assert.equal(await target.resolveProxy('https://example.org/'), 'DIRECT');
            return true;
        };
        assert.equal(await service.testRelay(), true);
        const realTest = service.testRelay.bind(service);
        service.testRelay = async () => false;
        store.set('cloudflareMode', 'always');
        await service.configure();
        assert.equal(
            await main.webContents.session.resolveProxy('https://soundcloud.com'),
            'DIRECT',
            'failed Worker must not blackhole direct traffic',
        );
        let finishProbe;
        service.testRelay = () =>
            new Promise((resolve) => {
                finishProbe = resolve;
            });
        const staleConfiguration = service.configure();
        while (!finishProbe) await wait(5);
        store.set('cloudflareMode', 'off');
        await service.configure();
        finishProbe(true);
        await staleConfiguration;
        assert.equal(
            await main.webContents.session.resolveProxy('https://soundcloud.com'),
            'DIRECT',
            'old probe cannot enable a disabled Worker',
        );
        service.testRelay = realTest;
        for (const [name, value] of Object.entries({
            'updates:status': {},
            'get-current-track': null,
            'get-custom-themes': [],
            'get-current-custom-theme': null,
            'get-plugins': [],
            'get-accounts': { accounts: [{ id: 'default', name: 'Test' }], currentAccountId: 'default' },
            'get-translations': {},
        }))
            ipcMain.handle(name, () => value);
        ipcMain.handle('network:save', (_event, input) => {
            service.save(input);
            return 'Настройки сохранены';
        });
        ipcMain.handle('network:test', () => 'Тестовый Worker доступен');
        let copies = 0;
        ipcMain.handle('network:copy-diagnostics', () => {
            const text = JSON.stringify(service.getDiagnostics());
            assert(!text.includes(token));
            copies++;
            return 'Диагностика подключения скопирована';
        });
        ipcMain.handle('network:status', () => service.getStatus());
        const wizardToken = 'wizard_test_token_'.repeat(3);
        ipcMain.handle('network:setup-accounts', (_event, value) => {
            assert.equal(value, wizardToken);
            return [{ id: 'a'.repeat(32), name: 'My Cloudflare' }];
        });
        ipcMain.handle('network:setup-deploy', (event, id) => {
            assert.equal(id, 'a'.repeat(32));
            event.sender.send('network:setup-progress', 'Сохраняем адрес…');
            service.save({
                mode: 'auto',
                endpoint: 'https://created.example.workers.dev',
                secret: 'generated_test_key_'.repeat(3),
            });
            return { endpoint: 'https://created.example.workers.dev', name: 'created', applied: true };
        });
        ipcMain.handle('network:setup-cancel', () => {});
        const settings = new SettingsManager(win, store, new TranslationService());
        assert.equal(settings.getView(), null);
        settings.toggle();
        const view = win.contentView.children.filter((view) => view.webContents).find((v) => v !== main);
        view.webContents.on('console-message', (_e, level, message) => {
            if (level >= 3 && /Uncaught|SyntaxError/.test(message)) errors.push(message);
        });
        await new Promise((resolve) => view.webContents.once('did-finish-load', resolve));
        await wait(150);
        assert(settings.owns(view.webContents));
        assert(!settings.owns(main.webContents));
        const state = await view.webContents.executeJavaScript(
            `(()=>{const mode=document.getElementById('cloudflareMode'),key=document.getElementById('cloudflareSecret');return {mode:mode.value,secret:key.value,saved:key.placeholder,endpoint:document.getElementById('cloudflareEndpoint').value,options:[...mode.options].map(o=>o.value)}})()`,
        );
        assert.equal(state.mode, 'off');
        assert.equal(state.secret, '');
        assert(state.saved.includes('saved'), JSON.stringify(state));
        assert.deepEqual(state.options, ['off', 'auto', 'always']);
        await view.webContents.executeJavaScript('document.getElementById("cloudflareSave").click()');
        await wait(80);
        assert.equal(
            await view.webContents.executeJavaScript('document.getElementById("cloudflareStatus").textContent'),
            'Настройки сохранены',
        );
        await view.webContents.executeJavaScript('document.getElementById("cloudflareTest").click()');
        await wait(80);
        assert.equal(
            await view.webContents.executeJavaScript('document.getElementById("cloudflareStatus").textContent'),
            'Тестовый Worker доступен',
        );
        await view.webContents.executeJavaScript('document.getElementById("cloudflareCopyDiagnostics").click()');
        await wait(80);
        assert.equal(copies, 1);
        assert.equal(
            await view.webContents.executeJavaScript('document.getElementById("cloudflareStatus").textContent'),
            'Диагностика подключения скопирована',
        );
        await view.webContents.executeJavaScript(
            'document.getElementById("cloudflareWizard").open=true;document.getElementById("cloudflareApiToken").value=' +
                JSON.stringify(wizardToken) +
                ';document.getElementById("cloudflareAccounts").click()',
        );
        await wait(80);
        const connected = await view.webContents.executeJavaScript(
            '({token:document.getElementById("cloudflareApiToken").value,hidden:document.getElementById("cloudflareAccountFields").hidden,account:document.getElementById("cloudflareAccount").value})',
        );
        assert.equal(connected.token, '');
        assert.equal(connected.hidden, false);
        assert.equal(connected.account, 'a'.repeat(32));
        await view.webContents.executeJavaScript('document.getElementById("cloudflareDeploy").click()');
        await wait(80);
        const deployed = await view.webContents.executeJavaScript(
            '({endpoint:document.getElementById("cloudflareEndpoint").value,mode:document.getElementById("cloudflareMode").value,key:document.getElementById("cloudflareSecret").value,status:document.getElementById("cloudflareSetupStatus").textContent})',
        );
        assert.equal(deployed.endpoint, 'https://created.example.workers.dev');
        assert.equal(deployed.mode, 'auto');
        assert.equal(deployed.key, '');
        assert(deployed.status.includes('Ready'));
        assert.deepEqual(errors, []);
        await service.configure();
        win.showInactive();
        await wait(400);
        await view.webContents.executeJavaScript(
            'document.getElementById("cloudflareWizard").scrollIntoView({block:"start"})',
        );
        await wait(150);
        try {
            fs.writeFileSync(path.join(out, 'network-wizard.png'), (await view.webContents.capturePage()).toPNG());
        } catch {}
        win.destroy();
        fs.writeFileSync(
            path.join(out, 'network-results.json'),
            JSON.stringify(
                {
                    passed: [
                        'proxy uses active account session',
                        'Chromium PAC routes only SoundCloud/CDN',
                        'failed Worker preserves ordinary connection',
                        'stale probe cannot enable disabled connection',
                        'secret encrypted and never rendered',
                        'settings buttons and JS execute',
                        'diagnostics action works through the settings bridge without including the relay key',
                        'trusted settings sender required',
                        'wizard clears API token field',
                        'wizard automatically fills and saves HTTPS endpoint and generated key',
                        'cleanup without renderer errors',
                    ],
                },
                null,
                2,
            ),
        );
        app.exit(0);
    } catch (error) {
        fs.writeFileSync(path.join(out, 'network-results.json'), JSON.stringify({ error: error.stack }, null, 2));
        if (win && !win.isDestroyed()) win.destroy();
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 30000).unref();
