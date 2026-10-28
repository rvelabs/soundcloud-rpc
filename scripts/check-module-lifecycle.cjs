const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-module-check');
const profile = path.join(out, 'module-empty-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const passed = [],
    errors = [];
const memory = () => {
    const values = new Map();
    return {
        values,
        get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        set: (key, value) => values.set(key, value),
        delete: (key) => values.delete(key),
    };
};
const load = (module) => require(path.join(repo, 'tsc', module));
app.whenReady().then(async () => {
    let win, plugins, themes;
    try {
        win = new BrowserWindow({
            show: false,
            width: 1100,
            height: 800,
            webPreferences: { sandbox: true, backgroundThrottling: false },
        });
        const wc = win.webContents;
        wc.on('console-message', (_event, level, message) => {
            if (level >= 3 && /Uncaught|SyntaxError/.test(message)) errors.push(message);
        });
        await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<main></main>'));
        await wc.executeJavaScript(`(() => {
   window.updates=[];window.progress=[];window.soundcloudAPI={sendTrackUpdate:(data,reason)=>updates.push({data,reason}),sendTrackProgress:data=>progress.push(data)};
   const Observer=MutationObserver;window.liveObservers=0;
   window.MutationObserver=class {constructor(fn){this.observer=new Observer(fn);this.active=false}observe(...args){if(!this.active){this.active=true;liveObservers++}this.observer.observe(...args)}disconnect(){if(this.active){this.active=false;liveObservers--}this.observer.disconnect()}};
   window.paint=(i,playing=true,liked=false)=>{
     document.querySelector('main').innerHTML='<div class="playControls__play '+(playing?'playing':'')+'"></div><div class="playbackSoundBadge"><a class="playbackSoundBadge__titleLink" href="https://soundcloud.com/artist/track-'+i+'">Track '+i+'</a><a class="playbackSoundBadge__lightLink">Artist '+i+'</a><button class="playbackSoundBadge__like '+(liked?'sc-button-selected':'')+'"></button></div><div class="playbackTimeline__timePassed"><span>0:00</span></div><div class="playbackTimeline__duration"><span>-3:00</span></div><div class="playbackTimeline__progressWrapper" aria-valuemax="180"></div>';
   };
   paint(0);
 })()`);
        const monitor = load('services/audioMonitorService.js').audioMonitorScript;
        await wc.executeJavaScript(monitor);
        await wc.executeJavaScript(monitor);
        await wait(160);
        assert.equal(await wc.executeJavaScript('liveObservers'), 6);
        assert.equal(await wc.executeJavaScript('updates.at(-1).data.duration'), '3:00');
        for (let i = 1; i <= 30; i++) {
            const playing = i % 3 !== 0,
                liked = i % 4 === 0;
            await wc.executeJavaScript(`paint(${i},${playing},${liked})`);
            await wait(165);
            const result = await wc.executeJavaScript('({last:updates.at(-1).data,count:liveObservers})');
            assert.equal(result.last.title, 'Track ' + i);
            assert.equal(result.last.url, 'https://soundcloud.com/artist/track-' + i);
            assert.equal(result.last.isPlaying, playing);
            assert.equal(result.last.isLiked, liked);
            assert.equal(result.count, 6);
        }
        passed.push(
            '30 native-player DOM replacements preserve track, heart and playback state with exactly 6 observers',
        );
        await wc.executeJavaScript(
            `document.querySelector('.playControls__play').classList.add('playing');document.querySelector('.playbackSoundBadge__like').classList.remove('sc-button-selected')`,
        );
        await wait(70);
        assert.equal(await wc.executeJavaScript('updates.at(-1).data.isPlaying'), true);
        await wc.executeJavaScript(
            `document.querySelector('.playbackSoundBadge__like').setAttribute('aria-pressed','true')`,
        );
        await wait(70);
        assert.equal(await wc.executeJavaScript('updates.at(-1).data.isLiked'), true);
        const count = await wc.executeJavaScript('updates.length');
        await wc.executeJavaScript(
            `for(let i=0;i<500;i++){const node=document.createElement('span');document.body.append(node);node.remove()}`,
        );
        await wait(180);
        assert.equal(await wc.executeJavaScript('updates.length'), count);
        passed.push('pause and ARIA-only heart updates work; 1,000 unrelated DOM mutations emit no extra playback IPC');
        await wc.executeJavaScript(`window.dispatchEvent(new Event('beforeunload'))`);
        assert.equal(await wc.executeJavaScript('liveObservers'), 0);
        passed.push('all audio-monitor observers disconnect on unload');
        const pluginDir = path.join(profile, 'plugins'),
            themeDir = path.join(profile, 'themes');
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.mkdirSync(themeDir, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDir, 'qa.js'),
            `globalThis.ticks=0;module.exports={onEnable(){setInterval(()=>globalThis.ticks++,25)},contentScript(){return String(globalThis.ticks)}}`,
        );
        fs.writeFileSync(
            path.join(pluginDir, 'broken.js'),
            `module.exports={onEnable(){setInterval(()=>{},5);throw Error('intentional fixture failure')}}`,
        );
        fs.writeFileSync(path.join(themeDir, 'qa.css'), ':root {--accent-color:#f50;}');
        fs.writeFileSync(path.join(themeDir, 'other.css'), ':root {--accent-color:#fff;}');
        const store = memory();
        plugins = new (load('services/pluginService.js').PluginService)(store);
        for (let i = 0; i < 12; i++) {
            assert(plugins.setPluginEnabled('qa', true));
            const host = plugins.runtimes.get('qa');
            await host.ready;
            await wait(70);
            assert(Number(await host.call('contentScript')) > 0);
            const exit = new Promise((resolve) => host.worker.once('exit', resolve));
            plugins.setPluginEnabled('qa', false);
            await exit;
            assert.equal(plugins.runtimes.size, 0);
        }
        assert.equal(plugins.runtimes.size, 0);
        assert.equal(plugins.setPluginEnabled('broken', true), true);
        const broken = plugins.runtimes.get('broken');
        await broken.ready.catch(() => {});
        await wait(80);
        assert.equal(plugins.getPlugins().find((item) => item.id === 'broken').enabled, false);
        assert.equal(plugins.runtimes.size, 0);
        passed.push(
            '12 plugin enable/disable cycles release timers; failed onEnable rolls back enabled state and runtime',
        );
        themes = new (load('services/themeService.js').ThemeService)(store);
        assert(themes.applyCustomTheme('qa'));
        let changed = 0;
        themes.onCustomThemeUpdated(() => changed++);
        fs.writeFileSync(path.join(themeDir, 'qa.css'), ':root {--accent-color:#abc;}');
        fs.writeFileSync(path.join(themeDir, 'other.css'), ':root {--accent-color:#def;}');
        await wait(450);
        assert(themes.getCurrentCustomThemeCSS().includes('#abc'));
        assert.equal(changed, 1);
        passed.push('burst saves of multiple themes coalesce to one refresh of the active theme');
        const { NotificationManager } = load('notifications/notificationManager.js');
        const notifications = new NotificationManager(win);
        const before = ipcMain.listenerCount('notification-done');
        notifications.show('Музыка <img src=x onerror="window.injected=true">');
        await wait(200);
        const toast = notifications.view.webContents;
        assert((await toast.executeJavaScript('document.body.textContent')).includes('<img'));
        assert.equal(await toast.executeJavaScript('Boolean(window.injected)'), false);
        ipcMain.emit('notification-done', { sender: wc });
        assert.equal(ipcMain.listenerCount('notification-done'), before + 1);
        notifications.dispose();
        assert.equal(ipcMain.listenerCount('notification-done'), before);
        passed.push(
            'notifications render literal Unicode text, reject unrelated completion IPC and clean listeners on disposal',
        );
        const { showHomepageConfirmDialog } = load('settings/confirmPopup.js');
        const first = showHomepageConfirmDialog(win, 'https://example.org/one');
        await wait(100);
        const second = showHomepageConfirmDialog(win, 'https://example.org/two');
        assert.equal(await first, false);
        await wait(200);
        const confirm = win.contentView.children
            .filter((view) => view.webContents)
            .find(
                (view) =>
                    view.webContents &&
                    !view.webContents.isDestroyed() &&
                    view.webContents.getURL().startsWith('data:'),
            );
        assert(confirm);
        await confirm.webContents.executeJavaScript('document.getElementById("cancelBtn").click()');
        assert.equal(await second, false);
        assert.equal(ipcMain.listenerCount('homepage-confirm-result'), 0);
        passed.push('replacing a confirmation resolves the previous request and removes its IPC listener');
        const account = new WebContentsView({ webPreferences: { partition: 'module-proxy-fixture', sandbox: true } });
        await account.webContents.loadURL('about:blank');
        const { ProxyService } = load('services/proxyService.js');
        store.set('proxyEnabled', true);
        store.set('proxyHost', '127.0.0.1');
        store.set('proxyPort', '54321');
        store.set('proxyData', { user: 'fixture-user', password: 'fixture-password' });
        const oldLogins = app.listenerCount('login');
        new ProxyService(win, store, () => {}, account.webContents.session);
        const callback = (...args) => {
            callback.values = args;
        };
        let prevented = false;
        const event = {
                preventDefault() {
                    prevented = true;
                },
            },
            auth = { isProxy: true, host: '127.0.0.1', port: 54321 };
        app.emit('login', event, wc, {}, auth, callback);
        assert.equal(prevented, false);
        app.emit('login', event, account.webContents, {}, auth, callback);
        assert.equal(prevented, true);
        assert.deepEqual(callback.values, ['fixture-user', 'fixture-password']);
        prevented = false;
        app.emit('login', event, account.webContents, {}, { ...auth, isProxy: false }, callback);
        assert.equal(prevented, false);
        account.webContents.close();
        passed.push('manual proxy credentials apply only to the selected session and matching proxy challenge');
        plugins.dispose();
        themes.dispose();
        win.destroy();
        assert.equal(app.listenerCount('login'), oldLogins);
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(out, 'module-lifecycle-results.json'), JSON.stringify({ passed, errors }, null, 2));
        app.exit(0);
    } catch (error) {
        plugins?.dispose();
        themes?.dispose();
        if (win && !win.isDestroyed()) win.destroy();
        fs.writeFileSync(
            path.join(out, 'module-lifecycle-results.json'),
            JSON.stringify({ passed, error: error.stack, errors }, null, 2),
        );
        app.exit(1);
    }
});
setTimeout(() => {
    fs.writeFileSync(
        path.join(out, 'module-lifecycle-results.json'),
        JSON.stringify({ passed, error: 'Harness deadline exceeded', errors }, null, 2),
    );
    app.exit(2);
}, 45000).unref();
