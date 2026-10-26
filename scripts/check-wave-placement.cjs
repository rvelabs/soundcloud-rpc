const { app, BrowserWindow, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const output = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-placement-check');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'empty-profile'));
app.setName('wave-placement-check');
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'wave-test', privileges: { standard: true, secure: true } }]);
const script = fs.readFileSync(path.join(repo, 'src/wave/inline.js'), 'utf8');
const styles = fs.readFileSync(path.join(repo, 'src/wave/inline.css'), 'utf8');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const errors = [];
let fixture = '';
const moduleHtml = (id, title) =>
    `<div class="mixedSelectionModule" id="${id}"><div class="mixedSelectionModule__title"><h2>${title}</h2></div><div class="cards">Tracks</div></div>`;
const freshModules = moduleHtml('artists', 'Artists to watch out for') + moduleHtml('trending', 'Trending by genre');
const layout = (modules = freshModules) =>
    `<div class="l-fluid-fixed"><div class="l-main"><div class="l-heading"><h1>Home</h1></div><div class="l-content"><div class="modules">${modules}</div></div></div><aside class="l-sidebar-right"><h3>Artists you should follow</h3></aside></div>`;
const html = (body) =>
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:30px;background:#111;color:#eee;font:14px Arial}.l-fluid-fixed{display:flex;gap:30px}.l-main{width:850px;min-width:0}.l-sidebar-right{width:250px}.cards{height:110px;background:#252525}.mixedSelectionModule{margin-bottom:30px}</style></head><body><nav>SoundCloud</nav><div id="content">${body}</div><div id="native-player">0:00</div></body></html>`;
const bridge = `(() => {
    window.__qaChannels = new Map();
    window.waveInline = { on: (key, callback) => window.__qaChannels.set(key, callback),
        ready: async () => ({active:false,visible:true,controls:{},stats:{heard:0,liked:0},candidate:null,like:null,track:null}),
        start: async () => {window.__qaStarts=(window.__qaStarts||0)+1;return 'open'}, control() {}, controls(value) {window.__qaControls=value}, like: async () => ({liked:true}),dislike:async(url)=>{window.__qaDislike=url},excludeArtist:async(artist,excluded)=>{window.__qaExcluded={artist,excluded};return excluded?[artist]:[]} };
    window.playlistImporter = {onProgress(callback) {window.__qaImportProgress=callback},
        scan(_url) {window.__qaImportArgCount=arguments.length;return new Promise((resolve,reject)=>{window.__qaImportResolve=resolve;window.__qaImportReject=reject})},
        cancel() {window.__qaImportReject?.(new Error('Поиск отменён.'))},commit:async()=>({})};
})()`;
const stateScript = `(() => {
    const r=document.getElementById('codex-wave-inline'), side=document.querySelector('.l-sidebar-right');
    return {count:document.querySelectorAll('#codex-wave-inline').length,connected:!!r,home:!!r?.closest('.l-main'),
        detached:!!r?.classList.contains('cw-detached'),width:r?.getBoundingClientRect().width||0,
        rect:r?{top:r.getBoundingClientRect().top,bottom:r.getBoundingClientRect().bottom,height:r.getBoundingClientRect().height}:null,
        firstModuleTop:document.querySelector('.l-main .mixedSelectionModule')?.getBoundingClientRect().top,
        importButton:!!document.querySelector('#codex-playlist-import .cw-import-open'),before:document.querySelector('#codex-playlist-import')?.nextElementSibling?.id||'',
        mood:r?.querySelector('[data-setting=\"mood\"][aria-pressed=\"true\"]')?.dataset.value,sidebarTop:side?.getBoundingClientRect().top};
})()`;
async function createWindow(body, route = '/discover') {
    fixture = html(body);
    const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 1000,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_event, _level, message) => {
        if (/Uncaught|Error/.test(message)) errors.push(message);
    });
    await win.loadURL(`wave-test://app${route}`);
    await win.webContents.executeJavaScript(
        `window.__qaSidebarTop=document.querySelector('.l-sidebar-right')?.getBoundingClientRect().top`,
    );
    await win.webContents.executeJavaScript(bridge);
    await win.webContents.insertCSS(styles);
    await win.webContents.executeJavaScript(script);
    await pause(350);
    return win;
}
async function test(name, body) {
    fs.appendFileSync(path.join(output, 'progress.jsonl'), JSON.stringify({ name, event: 'start' }) + '\n');
    try {
        await body();
        results.push({ name, passed: true });
    } catch (error) {
        results.push({ name, passed: false, error: String(error) });
    }
    fs.appendFileSync(path.join(output, 'progress.jsonl'), JSON.stringify(results.at(-1)) + '\n');
}
function visible(state) {
    assert.equal(state.count, 1);
    assert.equal(state.home, true);
    assert.equal(state.detached, false);
    assert.ok(state.width > 300);
    assert.equal(state.importButton, true);
}
app.whenReady()
    .then(async () => {
        protocol.handle(
            'wave-test',
            () => new Response(fixture, { headers: { 'content-type': 'text/html;charset=utf-8' } }),
        );
        await test('new account: no personalized recommendation heading', async () => {
            const win = await createWindow(layout());
            try {
                const s = await win.webContents.executeJavaScript(stateScript);
                visible(s);
                assert.equal(s.sidebarTop, await win.webContents.executeJavaScript('window.__qaSidebarTop'));
            } finally {
                win.destroy();
            }
        });
        await test('existing account: preserve placement after uploads', async () => {
            const win = await createWindow(
                layout(
                    moduleHtml('uploads', 'Your Latest Upload') + moduleHtml('personalized', 'More of what you like'),
                ),
            );
            try {
                const s = await win.webContents.executeJavaScript(stateScript);
                visible(s);
                assert.equal(s.before, 'personalized');
            } finally {
                win.destroy();
            }
        });
        await test('localized home: placement does not depend on English text', async () => {
            const win = await createWindow(layout(moduleHtml('artists', 'Исполнители, которых стоит послушать')));
            try {
                visible(await win.webContents.executeJavaScript(stateScript));
            } finally {
                win.destroy();
            }
        });
        await test('empty home shell: no likes, tracks or headings required', async () => {
            const win = await createWindow(layout(''));
            try {
                visible(await win.webContents.executeJavaScript(stateScript));
            } finally {
                win.destroy();
            }
        });
        await test('late home content: attach when SoundCloud renders the main column', async () => {
            const win = await createWindow('');
            try {
                await win.webContents.executeJavaScript(
                    `document.querySelector('#content').innerHTML=${JSON.stringify(layout())}`,
                );
                await pause(650);
                visible(await win.webContents.executeJavaScript(stateScript));
            } finally {
                win.destroy();
            }
        });
        await test('late personalized content: move below uploads when it arrives', async () => {
            const win = await createWindow(layout(''));
            try {
                await win.webContents.executeJavaScript(
                    `document.querySelector('.modules').innerHTML=${JSON.stringify(moduleHtml('uploads', 'Your Latest Upload') + moduleHtml('personalized', 'More of what you like'))}`,
                );
                await pause(650);
                const s = await win.webContents.executeJavaScript(stateScript);
                visible(s);
                assert.equal(s.before, 'personalized');
            } finally {
                win.destroy();
            }
        });
        await test('SPA content replacement: retain settings and a single module', async () => {
            const win = await createWindow(layout());
            try {
                await win.webContents.executeJavaScript(
                    `window.__qaRoot=document.getElementById('codex-wave-inline');if(window.__qaRoot)window.__qaRoot.querySelector('[data-setting=\"mood\"][data-value=\"calm\"]').click();document.querySelector('#content').innerHTML=${JSON.stringify(layout())}`,
                );
                await pause(650);
                const s = await win.webContents.executeJavaScript(stateScript);
                visible(s);
                assert.equal(s.mood, 'calm');
                assert.equal(
                    await win.webContents.executeJavaScript(
                        `window.__qaRoot===document.getElementById('codex-wave-inline')`,
                    ),
                    true,
                );
            } finally {
                win.destroy();
            }
        });
        await test('route changes: library stays native; active wave survives and returns home', async () => {
            const win = await createWindow(layout(moduleHtml('personalized', 'More of what you like')));
            try {
                await win.webContents.executeJavaScript(
                    `history.pushState({},'', '/you/library');window.__qaChannels.get('route')()`,
                );
                await pause(400);
                assert.equal((await win.webContents.executeJavaScript(stateScript)).connected, false);
                await win.webContents.executeJavaScript(`window.__qaChannels.get('active')(true)`);
                await pause(400);
                assert.equal((await win.webContents.executeJavaScript(stateScript)).detached, true);
                await win.webContents.executeJavaScript(
                    `history.pushState({},'', '/discover');window.__qaChannels.get('route')()`,
                );
                await pause(400);
                visible(await win.webContents.executeJavaScript(stateScript));
            } finally {
                win.destroy();
            }
        });
        await test('repeat injection and player updates: no duplicate or layout movement', async () => {
            const win = await createWindow(layout());
            try {
                await win.webContents.executeJavaScript(script);
                await win.webContents.executeJavaScript(
                    `window.__qaMoves=0;const r=document.getElementById('codex-wave-inline');new MutationObserver(list=>{for(const m of list)for(const n of m.addedNodes)if(n===r)window.__qaMoves++}).observe(document.body,{childList:true,subtree:true});for(let i=0;i<100;i++)document.getElementById('native-player').replaceChildren(document.createElement('span'))`,
                );
                await pause(650);
                visible(await win.webContents.executeJavaScript(stateScript));
                assert.equal(await win.webContents.executeJavaScript('window.__qaMoves'), 0);
            } finally {
                win.destroy();
            }
        });
        await test('parallel import UI: out-of-order progress, cancellation and a second scan', async () => {
            const win = await createWindow(layout());
            try {
                const partial = await win.webContents.executeJavaScript(`(() => {
                const r=document.getElementById('codex-playlist-import');r.querySelector('.cw-import-open').click();
                r.querySelector('.cw-import-source input').value='https://open.spotify.com/playlist/5l10KpZaBOpWLVSsqhakjI';
                r.querySelector('[data-command="import-scan"]').click();
                const tracks=[0,1,2].map(i=>({title:'Track '+i,artist:'Artist '+i}));window.__qaImportTracks=tracks;
                window.__qaImportProgress({phase:'matching',completed:0,total:3,title:'Test',tracks});
                for(const [index,completed] of [[2,1],[0,2]])window.__qaImportProgress({phase:'matching',completed,total:3,index,match:{source:tracks[index],soundcloud:{title:'Match '+index,artist:'Artist '+index,score:1}}});
                return {argCount:window.__qaImportArgCount,rows:[...r.querySelectorAll('.cw-import-row strong')].map(e=>e.textContent),
                    pending:r.querySelectorAll('.cw-import-row small')[1].textContent,cancel:!r.querySelector('.cw-import-cancel').hidden,
                    commitDisabled:r.querySelector('.cw-import-commit').disabled};
            })()`);
                assert.equal(partial.argCount, 1);
                assert.equal(partial.rows.length, 3);
                assert.ok(partial.rows[0].includes('Track 0'));
                assert.ok(partial.rows[2].includes('Track 2'));
                assert.equal(partial.pending, 'Проверяем…');
                assert.equal(partial.cancel, true);
                assert.equal(partial.commitDisabled, false);
                await win.webContents.executeJavaScript(`document.querySelector('.cw-import-cancel').click()`);
                await pause(50);
                const cancelled = await win.webContents.executeJavaScript(
                    `({hidden:document.querySelector('.cw-import-cancel').hidden,disabled:document.querySelector('.cw-import-source input').disabled,message:document.querySelector('.cw-import-message').textContent})`,
                );
                assert.equal(cancelled.hidden, true);
                assert.equal(cancelled.disabled, false);
                assert.ok(cancelled.message.includes('отменён'));
                await win.webContents.executeJavaScript(
                    `document.querySelector('[data-command="import-scan"]').click();window.__qaImportResolve({title:'Test',matches:window.__qaImportTracks.map((source,index)=>({source,soundcloud:{title:'Match '+index,artist:source.artist,score:1}}))})`,
                );
                await pause(50);
                assert.equal(
                    await win.webContents.executeJavaScript(`document.querySelector('.cw-import-commit').disabled`),
                    false,
                );
            } finally {
                win.destroy();
            }
        });
        await test('partial import: save found tracks during scan and retain unadded results', async () => {
            const win = await createWindow(layout());
            try {
                await win.webContents.executeJavaScript(
                    `(()=>{const r=document.querySelector('#codex-playlist-import');r.querySelector('[data-command="import-open"]').click();r.querySelector('.cw-import-source input').value='https://open.spotify.com/playlist/test';r.querySelector('[data-command="import-scan"]').click();const tracks=[{title:'Found',artist:'A'},{title:'Missing',artist:'B'}];window.__qaImportProgress({phase:'matching',completed:0,total:2,title:'Partial',tracks});window.__qaImportProgress({phase:'matching',completed:1,total:2,index:0,match:{source:tracks[0],soundcloud:{url:'https://soundcloud.com/a/found',title:'Found',artist:'A',score:1}}});window.playlistImporter.commit=async value=>{window.__qaCommit=value;return {title:value.title,added:1,already:0,failures:[],successfulUrls:['https://soundcloud.com/a/found']}};r.querySelector('[data-command="import-commit"]').click()})()`,
                );
                await pause(100);
                const state = await win.webContents.executeJavaScript(
                    `({commit:window.__qaCommit,rows:document.querySelectorAll('.cw-import-row').length,checked:document.querySelectorAll('.cw-import-results input:checked').length,saved:document.querySelector('.cw-import-row small').textContent,message:document.querySelector('.cw-import-message').textContent})`,
                );
                assert.deepEqual(state.commit, { indexes: [0], title: 'Partial' });
                assert.equal(state.rows, 2);
                assert.equal(state.checked, 0);
                assert.equal(state.saved, 'Добавлено в плейлист');
                assert.ok(state.message.includes('добавлено 1'));
            } finally {
                win.destroy();
            }
        });
        await test('wave settings drawer: axes, reset, summary and original player preserved', async () => {
            const win = await createWindow(layout());
            win.setSize(1280, 820);
            try {
                const state = await win.webContents.executeJavaScript(`(()=>{
                const native=document.querySelector('#native-player').outerHTML;
                document.querySelector('.cw-settings-open').click();
                const dialog=document.querySelector('.cw-settings-dialog');
                for(const [key,value] of [['activity','wake'],['mood','happy'],['language','ru'],['discovery','popular']])dialog.querySelector('[data-setting="'+key+'"][data-value="'+value+'"]').click();
                const rect=dialog.getBoundingClientRect();
                return {open:dialog.open,controls:window.__qaControls,summary:document.querySelector('.cw-preset-summary').textContent,
                    right:rect.right,width:document.documentElement.clientWidth,bottom:rect.bottom,height:innerHeight,nativeSame:native===document.querySelector('#native-player').outerHTML,
                    selected:dialog.querySelectorAll('[aria-pressed="true"]').length};
            })()`);
                assert.equal(state.open, true);
                assert.equal(state.controls.activity, 'wake');
                assert.equal(state.controls.mood, 'happy');
                assert.equal(state.controls.language, 'ru');
                assert.equal(state.controls.discovery, 'popular');
                assert.equal(state.nativeSame, true);
                assert.ok(state.summary.includes('Просыпаюсь'));
                assert.ok(state.summary.includes('Весёлое'));
                assert.equal(state.right, state.width);
                assert.equal(state.bottom, state.height);
                await pause(300);
                fs.writeFileSync(path.join(output, 'wave-settings.png'), (await win.webContents.capturePage()).toPNG());
                const reset = await win.webContents.executeJavaScript(
                    `(()=>{document.querySelector('[data-command="settings-reset"]').click();document.querySelector('[data-command="settings-close"]').click();return {controls:window.__qaControls,open:document.querySelector('.cw-settings-dialog').open}})()`,
                );
                assert.equal(reset.controls.mood, 'any');
                assert.equal(reset.controls.language, 'any');
                assert.equal(reset.controls.discovery, 'balanced');
                assert.equal(reset.open, false);
                await win.webContents.executeJavaScript(
                    `window.__qaChannels.get('active')(true);window.__qaChannels.get('state')('error','No matching tracks');document.querySelector('.cw-start').click()`,
                );
                await pause(50);
                assert.equal(await win.webContents.executeJavaScript('window.__qaStarts'), 1);
            } finally {
                win.destroy();
            }
        });
        await test('listening progress: reports seeks immediately and throttles ordinary progress', async () => {
            const win = await createWindow(layout());
            try {
                const monitor = require(path.join(repo, 'tsc/services/audioMonitorService.js')).audioMonitorScript;
                await win.webContents.executeJavaScript(
                    `document.body.innerHTML='<button class="playControls__play playing"></button><a class="playbackSoundBadge__titleLink" href="https://soundcloud.com/artist/track"></a><div class="playbackTimeline__timePassed"><span>0:00</span></div><div class="playbackTimeline__duration"><span>3:00</span></div><div class="playbackTimeline__progressWrapper" aria-valuemax="180"></div>';window.__qaTime=Date.now();Date.now=()=>window.__qaTime;window.__qaUpdates=[];window.__qaProgress=[];window.soundcloudAPI={sendTrackUpdate:data=>window.__qaUpdates.push(data),sendTrackProgress:data=>window.__qaProgress.push(data)};true;`,
                );
                await win.webContents.executeJavaScript(monitor);
                await win.webContents.executeJavaScript(
                    `document.querySelector('.playbackTimeline__timePassed span').textContent='1:20'`,
                );
                await pause(60);
                const state = await win.webContents.executeJavaScript(
                    `({full:window.__qaUpdates.length,progress:window.__qaProgress.map(data=>data.elapsed)})`,
                );
                assert.equal(state.full, 2);
                assert.deepEqual(state.progress, []);
                await win.webContents.executeJavaScript(
                    `window.__qaTime+=5001;document.querySelector('.playbackTimeline__timePassed span').textContent='1:21'`,
                );
                await pause(40);
                assert.equal(await win.webContents.executeJavaScript('window.__qaProgress.length'), 1);
                assert.equal(await win.webContents.executeJavaScript('window.__qaUpdates.length'), 2);
                await win.webContents.executeJavaScript(
                    "window.__qaTime+=1000;document.querySelector('.playbackTimeline__timePassed span').textContent='1:22'",
                );
                await pause(60);
                assert.equal(await win.webContents.executeJavaScript('window.__qaProgress.length'), 1);
            } finally {
                win.destroy();
            }
        });
        await test('recommendation explanation: honest BPM, dislike action and native player untouched', async () => {
            const win = await createWindow(layout());
            try {
                const state = await win.webContents.executeJavaScript(`(async()=>{
                window.__qaChannels.get('active')(true);
                window.__qaChannels.get('candidate')({url:'https://soundcloud.com/test/song',title:'Track',artist:'Artist',genre:'DnB',bpm:174,bpmConfidence:.75,recommendationReasons:['выбранный жанр','BPM соответствует темпу']});
                document.querySelector('.cw-insight details').open=true;
                const initial={visible:!document.querySelector('.cw-insight').hidden,reasons:document.querySelector('.cw-reasons').textContent,evidence:document.querySelector('.cw-evidence').textContent,native:document.querySelector('#native-player').textContent};
                document.querySelector('[data-command="dislike"]').click();await Promise.resolve();
                return {...initial,dislike:window.__qaDislike};
            })()`);
                assert.equal(state.visible, true);
                assert.ok(state.reasons.includes('выбранный жанр'));
                assert.ok(state.evidence.includes('174'));
                assert.equal(state.native, '0:00');
                assert.equal(state.dislike, 'https://soundcloud.com/test/song');
                await pause(250);
                fs.writeFileSync(
                    path.join(output, 'wave-explanation.png'),
                    (await win.webContents.capturePage()).toPNG(),
                );
                await win.webContents.executeJavaScript(
                    `window.__qaChannels.get('candidate')({url:'https://soundcloud.com/test/unknown',title:'Unknown',artist:'Artist'});`,
                );
                assert.ok(
                    await win.webContents.executeJavaScript(
                        `document.querySelector('.cw-evidence').textContent.includes('без подтверждённого BPM')`,
                    ),
                );
            } finally {
                win.destroy();
            }
        });
        await test('artist exclusions: local action, restore and safe text rendering', async () => {
            const win = await createWindow(layout());
            try {
                await win.webContents.executeJavaScript(
                    `window.__qaChannels.get('active')(true);window.__qaChannels.get('candidate')({url:'https://soundcloud.com/test/song',title:'Track',artist:'<Artist & friends>'});document.querySelector('[data-command="exclude-artist"]').click()`,
                );
                await pause(80);
                assert.deepEqual(await win.webContents.executeJavaScript('window.__qaExcluded'), {
                    artist: '<Artist & friends>',
                    excluded: true,
                });
                assert.equal(
                    await win.webContents.executeJavaScript(
                        'document.querySelector(".cw-exclusions>div span").textContent',
                    ),
                    '<Artist & friends>',
                );
                await win.webContents.executeJavaScript(
                    'document.querySelector("[data-command=restore-artist]").click()',
                );
                await pause(80);
                assert.deepEqual(await win.webContents.executeJavaScript('window.__qaExcluded'), {
                    artist: '<Artist & friends>',
                    excluded: false,
                });
                assert.ok(
                    await win.webContents.executeJavaScript(
                        'document.querySelector(".cw-exclusions>div").textContent.includes("никого")',
                    ),
                );
            } finally {
                win.destroy();
            }
        });
        await test('large import: 414 rows, accurate progress and visible footer at 720px', async () => {
            const win = await createWindow(layout());
            win.setSize(1060, 720);
            try {
                const state = await win.webContents.executeJavaScript(`(() => {
                const r=document.getElementById('codex-playlist-import');r.querySelector('.cw-import-open').click();
                r.querySelector('.cw-import-source input').value='https://open.spotify.com/playlist/test';
                r.querySelector('[data-command="import-scan"]').click();
                window.__qaImportProgress({phase:'matching',completed:283,total:414,title:'Large playlist'});
                const before=r.querySelector('.cw-import-summary').textContent;
                const tracks=Array.from({length:414},(_,i)=>({title:'Track '+i,artist:'Artist'}));
                window.__qaImportProgress({phase:'matching',completed:283,total:414,title:'Large playlist',tracks});
                return {before,rows:r.querySelectorAll('.cw-import-row').length,
                    manual:!!r.querySelector('.cw-import-speed'),count:r.querySelector('.cw-import-count').textContent,
                    aria:r.querySelector('.cw-import-meter').getAttribute('aria-valuenow')};
            })()`);
                assert.equal(state.rows, 414);
                assert.equal(state.manual, false);
                assert.equal(state.count, '283 / 414');
                assert.ok(state.before.includes('283'));
                assert.equal(state.aria, '68');
                await pause(150);
                const bounds = await win.webContents.executeJavaScript(`(() => {
                const d=document.querySelector('.cw-import-dialog').getBoundingClientRect(),f=document.querySelector('.cw-import-footer').getBoundingClientRect();
                const r=document.querySelector('.cw-import-results');
                return {top:d.top,bottom:d.bottom,footer:f.bottom,height:innerHeight,scroll:r.scrollHeight>r.clientHeight};
            })()`);
                assert.ok(bounds.top >= 0);
                assert.ok(bounds.bottom <= bounds.height);
                assert.ok(bounds.footer <= bounds.bottom);
                assert.equal(bounds.scroll, true);
                fs.writeFileSync(
                    path.join(output, 'import-progress.png'),
                    (await win.webContents.capturePage()).toPNG(),
                );
            } finally {
                win.destroy();
            }
        });
        await test('playlist creation: direct empty-account form and localized tabs', async () => {
            const helper = require(path.join(repo, 'tsc/import/nativePlaylist.js')).activatePlaylistCreation.toString();
            const win = await createWindow(layout());
            try {
                const probe = (body) =>
                    win.webContents.executeJavaScript(
                        `(() => {document.body.innerHTML=${JSON.stringify(body)};return (${helper})()})()`,
                    );
                assert.equal(await probe('<div class="createPlaylist__title"><input></div>'), 'form');
                for (const title of ['Create a playlist', 'Создать плейлист', 'Neue Playlist']) {
                    assert.equal(
                        await probe(
                            '<div class="addToPlaylistTabs"><button class="tabs__tab">Existing</button><button class="tabs__tab" onclick="this.dataset.clicked=1">' +
                                title +
                                '</button></div>',
                        ),
                        'tab',
                    );
                    assert.equal(
                        await win.webContents.executeJavaScript(
                            'document.querySelectorAll(".tabs__tab")[1].dataset.clicked',
                        ),
                        '1',
                    );
                }
                assert.equal(await probe('<div hidden class="createPlaylist__title"><input></div>'), 'missing');
            } finally {
                win.destroy();
            }
        });
        await test('real SoundCloud metadata: full stream versus restricted release', async () => {
            const { session } = require('electron');
            const { createAvailabilityChecker } = require(path.join(repo, 'tsc/import/availability.js'));
            const check = createAvailabilityChecker(session.defaultSession);
            const clear = await check('https://soundcloud.com/75n/sheets');
            const protectedTrack = await check('https://soundcloud.com/billieeilish/wildflower');
            assert.equal(clear.status, 'available');
            assert.ok(
                ['protected', 'preview', 'blocked'].includes(protectedTrack.status),
                'Restricted release must never be accepted as a full stream: ' + protectedTrack.status,
            );
        });
        if (process.argv.includes('--live') || process.env.WAVE_TEST_LIVE === '1')
            await test('live SoundCloud: empty profile, no account or personalized home', async () => {
                const win = new BrowserWindow({
                    show: false,
                    width: 1366,
                    height: 1000,
                    webPreferences: {
                        offscreen: true,
                        sandbox: true,
                        contextIsolation: true,
                        nodeIntegration: false,
                        backgroundThrottling: false,
                    },
                });
                let latestFrame;
                win.webContents.on('paint', (_event, _dirty, image) => {
                    latestFrame = image.toPNG();
                });
                win.webContents.setFrameRate(20);
                try {
                    win.webContents.setUserAgent(
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    );
                    await win.loadURL('https://soundcloud.com/discover');
                    await pause(3000);
                    const personalized = await win.webContents.executeJavaScript(
                        `document.body.innerText.includes('More of what you like')`,
                    );
                    await win.webContents.executeJavaScript(bridge);
                    await win.webContents.insertCSS(styles);
                    await win.webContents.executeJavaScript(script);
                    await pause(600);
                    const state = await win.webContents.executeJavaScript(stateScript);
                    visible(state);
                    assert.ok(state.rect.top < state.firstModuleTop, 'Wave should appear above editorial modules');
                    assert.ok(state.rect.height > 200, 'Wave controls should have a visible height');
                    win.webContents.invalidate();
                    await pause(200);
                    fs.writeFileSync(
                        path.join(output, 'fresh-home.png'),
                        latestFrame || (await win.webContents.capturePage()).toPNG(),
                    );
                    results.push({ name: 'live page details', personalized, state });
                } finally {
                    win.destroy();
                }
            });
        if (errors.length) results.push({ name: 'renderer has no uncaught errors', passed: false, errors });
        else results.push({ name: 'renderer has no uncaught errors', passed: true });
        const passed = results.filter((r) => r.passed === true).length,
            failed = results.filter((r) => r.passed === false).length;
        const report = { passed, failed, errors, results };
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        app.exit(failed ? 1 : 0);
    })
    .catch((error) => {
        fs.writeFileSync(path.join(output, 'fatal.txt'), String(error.stack || error));
        app.exit(1);
    });
setTimeout(() => {
    fs.writeFileSync(path.join(output, 'timeout.txt'), 'Placement check exceeded 60 seconds');
    app.exit(1);
}, 60000).unref();
