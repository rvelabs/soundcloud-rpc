const { app, BrowserWindow } = require('electron');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-updater-check');
const profile = path.join(out, 'updates-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    let server, window;
    const controllers = [];
    try {
        const { UpdateController } = require(path.join(repo, 'tsc/updates/updateController'));
        const { presentUpdate } = require(path.join(repo, 'tsc/updates/presentation'));
        const payloadPath = process.env.WAVE_UPDATE_INSTALLER;
        const payload = payloadPath
            ? fs.readFileSync(payloadPath)
            : Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(256 * 1024)]);
        const hash = crypto.createHash('sha512').update(payload).digest('base64');
        const version = '0.28.3',
            name = 'soundcloud-0.28.3-installer-win.exe';
        let corrupt = false,
            assets = 0;
        server = createServer((request, response) => {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            if (pathname === '/latest.yml') {
                response.setHeader('Content-Type', 'text/yaml');
                response.end(
                    yaml.dump({
                        version,
                        files: [
                            {
                                url: name,
                                sha512: corrupt ? Buffer.alloc(64).toString('base64') : hash,
                                size: payload.length,
                            },
                        ],
                        path: name,
                        sha512: corrupt ? Buffer.alloc(64).toString('base64') : hash,
                        releaseDate: new Date().toISOString(),
                        workerProtocolRevision: 2,
                    }),
                );
            } else if (pathname === '/' + name) {
                assets++;
                response.setHeader('Content-Length', payload.length);
                response.end(payload);
            } else response.writeHead(404).end();
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + server.address().port;
        const make = (key, publicFeed = false) => {
            const directory = path.join(profile, key);
            fs.mkdirSync(directory, { recursive: true });
            const config = path.join(directory, 'app-update.yml');
            fs.writeFileSync(config, yaml.dump({ provider: 'generic', url, updaterCacheDirName: key }));
            const adapter = {
                version: '0.28.2',
                name: 'SoundCloud test',
                isPackaged: true,
                appUpdateConfigPath: config,
                userDataPath: directory,
                baseCachePath: directory,
                whenReady: async () => {},
                relaunch: () => {
                    throw Error('No actual relaunch in tests');
                },
                quit: () => {
                    throw Error('No actual quit in tests');
                },
                onQuit: () => {},
            };
            const backend = new NsisUpdater(undefined, adapter);
            backend.httpExecutor = new ElectronHttpExecutor();
            backend.setFeedURL(
                publicFeed
                    ? { provider: 'github', owner: 'rvelabs', repo: 'soundcloud-rpc', releaseType: 'release' }
                    : { provider: 'generic', url },
            );
            backend.disableDifferentialDownload = true;
            backend.logger = { info() {}, warn() {}, error() {}, debug() {} };
            const failures = [];
            backend.on('error', (error) => failures.push(error.stack || error.message));
            let installs = 0;
            backend.quitAndInstall = () => {
                installs++;
            };
            const controller = new UpdateController(backend, {
                currentVersion: '0.28.2',
                mode: publicFeed ? 'notify' : 'patch',
                installSupported: true,
                canCheck: true,
                workerRevision: 2,
                usesWorker: () => false,
                pendingWorker: () => 0,
                setPendingWorker: () => {},
                changed: () => {},
                notify: () => {},
                beforeInstall: () => {},
            });
            controllers.push(controller);
            return { controller, backend, failures, installs: () => installs };
        };
        if (process.env.WAVE_UPDATE_PUBLIC === '1') {
            const published = make('github', true);
            let info;
            published.backend.on('update-available', (value) => {
                info = value;
            });
            await published.controller.check();
            assert.equal(published.controller.snapshot().phase, 'available', JSON.stringify(published.failures));
            assert.equal(info.version, require(path.join(repo, 'package.json')).version);
            assert.equal(info.workerProtocolRevision, 2);
            assert.equal(published.installs(), 0);
            console.log(
                JSON.stringify({
                    githubProvider: true,
                    publicFeed: true,
                    version: info.version,
                    workerProtocolRevision: info.workerProtocolRevision,
                    noInstallerExecuted: true,
                }),
            );
            app.exit(0);
            return;
        }
        const good = make('verified');
        await good.controller.check();
        await good.controller.download();
        assert.equal(good.controller.snapshot().phase, 'ready', JSON.stringify(good.failures));
        assert.equal(good.installs(), 0);
        assert.equal(good.backend.autoInstallOnAppQuit, true);
        const downloaded = fs.readFileSync(good.backend.installerPath);
        assert.equal(crypto.createHash('sha512').update(downloaded).digest('base64'), hash);
        good.controller.systemShutdown();
        assert.equal(good.backend.autoInstallOnAppQuit, false);
        const cached = make('cached', true);
        cached.backend.setFeedURL({ provider: 'generic', url });
        await cached.controller.check();
        await cached.controller.download();
        assert.equal(cached.backend.autoInstallOnAppQuit, false);
        assert.equal(cached.backend.quitHandlerAdded, false);
        const beforeCache = assets;
        cached.controller.setMode('patch');
        await Promise.resolve();
        await cached.controller.download();
        assert.equal(cached.controller.snapshot().phase, 'ready', JSON.stringify(cached.failures));
        assert.equal(cached.backend.autoInstallOnAppQuit, true);
        assert.equal(cached.backend.quitHandlerAdded, true);
        assert.equal(assets, beforeCache);
        cached.controller.systemShutdown();
        corrupt = true;
        const bad = make('corrupt');
        await bad.controller.check();
        await bad.controller.download();
        assert.equal(bad.controller.snapshot().phase, 'error');
        assert.throws(() => bad.controller.install());
        assert.equal(bad.installs(), 0);
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        for (const russian of [true, false]) {
            const view = presentUpdate(good.controller.snapshot(), russian);
            assert(view.labels.install.includes(russian ? 'Перезапустить' : 'Restart'));
            assert(view.releaseUrl.startsWith('https://github.com/rvelabs/soundcloud-rpc/releases/'));
        }
        const report = {
            actualElectronUpdater: true,
            verifiedBytes: payload.length,
            hashVerified: true,
            corruptHashRejected: true,
            cachedModeChangeArmsQuit: true,
            noInstallerExecuted: true,
            assetsRequested: assets,
        };
        fs.writeFileSync(path.join(out, 'updater-results.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        app.exit(1);
    } finally {
        for (const controller of controllers) controller.dispose();
        server?.close();
        if (window && !window.isDestroyed()) window.destroy();
    }
});
setTimeout(() => {
    console.error('updater test deadline');
    app.exit(1);
}, 45000).unref();
