const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..'),
    out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-import-interface');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'import-interface-' + Date.now()));
protocol.registerSchemesAsPrivileged([
    { scheme: 'import-qa', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
    let win;
    try {
        protocol.handle(
            'import-qa',
            () =>
                new Response(
                    '<!doctype html><meta charset="utf-8"><style>body{background:#111;color:#fff;font:14px Arial;margin:0;padding:60px}.l-main{width:850px}.mixedSelectionModule{height:300px}</style><div id="content"><main class="l-main"><div class="l-content"><section class="mixedSelectionModule">SoundCloud</section></div></main></div><div class="playControls"></div>',
                    { headers: { 'content-type': 'text/html' } },
                ),
        );
        win = new BrowserWindow({
            show: false,
            width: 1200,
            height: 950,
            webPreferences: { sandbox: true, backgroundThrottling: false },
        });
        await win.webContents.loadURL('import-qa://app/discover');
        const { waveEnglish, translateWaveText } = require(path.join(repo, 'tsc/wave/i18n'));
        await win.webContents.executeJavaScript(
            `window.__waveEnglish=${JSON.stringify(waveEnglish)};window.__waveTranslate=(${translateWaveText.toString()});window.__waveInitialLanguage='en';window.__waveSystemLocale='en-US';window.waveInline={ready:async()=>({active:false,visible:true,controls:{},stats:{heard:0,liked:0}}),on(){}};window.fileCalls=0;window.commits=[];window.matches=[{source:{title:'Found',artist:'Artist'},soundcloud:{url:'https://soundcloud.com/a/found',title:'Found',artist:'Artist',score:1}},{source:{title:'Missing',artist:'Artist'}}];window.playlistImporter={onProgress(){},scan:async link=>{if(link==='error')throw Error('ONLY_NETWORK_ERROR');return {title:'Subset',matches:window.matches}},scanFile:async()=>++window.fileCalls===1?{cancelled:true}:{title:'CSV list',matches:window.matches},commit:async value=>{commits.push(value);return {title:value.title,added:1,already:0,successfulUrls:['https://soundcloud.com/a/found'],failures:[],unmatched:1,duplicates:0}}};true;`,
        );
        await win.webContents.insertCSS(fs.readFileSync(path.join(repo, 'src/wave/inline.css'), 'utf8'));
        await win.webContents.executeJavaScript(fs.readFileSync(path.join(repo, 'src/wave/inline.js'), 'utf8'));
        await wait(250);
        const run = (script) => win.webContents.executeJavaScript(script, true);
        if (process.env.WAVE_TEST_VIRTUAL_IMPORT === '1') {
            await run(
                `window.matches=Array.from({length:500},(_,i)=>({source:{title:'Track '+i,artist:'Artist '+i},soundcloud:{url:'https://soundcloud.com/artist/track-'+i,title:'Track '+i,artist:'Artist '+i,score:1}}));document.querySelector('.cw-import-open').click();document.querySelector('.cw-import-source input').value='source';document.querySelector('[data-command="import-scan"]').click()`,
            );
            await wait(250);
            assert(
                (await run("document.querySelectorAll('.cw-import-row').length")) < 50,
                '500 tracks render only a viewport',
            );
            await run(
                `const first=document.querySelector('.cw-import-results input');first.click();const list=document.querySelector('.cw-import-results');list.focus();list.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));`,
            );
            await wait(150);
            assert.equal(await run('document.activeElement.dataset.index'), '499');
            await run('document.activeElement.click()');
            await run(
                `document.querySelector('.cw-import-results').scrollTop=16000;document.querySelector('.cw-import-results').dispatchEvent(new Event('scroll'))`,
            );
            await wait(150);
            const middle = await run(
                "(()=>{const list=document.querySelector('.cw-import-results');return {count:document.querySelectorAll('.cw-import-row').length,index:Number(document.querySelector('.cw-import-row').dataset.index),top:list.scrollTop,height:list.scrollHeight,client:list.clientHeight,overflow:getComputedStyle(list).overflow,active:document.activeElement.dataset.index}})()",
            );
            assert(middle.count < 50 && middle.index > 20 && middle.index < 480, JSON.stringify(middle));
            await run(
                `document.querySelector('.cw-import-results').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));`,
            );
            await wait(100);
            assert.equal(await run('document.activeElement.dataset.index'), '0');
            assert.equal(await run('document.activeElement.checked'), false, 'offscreen selection survives recycling');
            await run(
                `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))`,
            );
            assert.equal(await run('document.activeElement.dataset.index'), '1');
            await run(`document.querySelector('.cw-import-commit').click()`);
            await wait(100);
            const chosen = await run('commits[0].indexes');
            assert.equal(chosen.length, 498, 'commit includes selected tracks that were never rendered');
            assert(!chosen.includes(0) && !chosen.includes(499));
            fs.writeFileSync(
                path.join(out, 'virtual-import.json'),
                JSON.stringify({ tracks: 500, selected: chosen.length, middle, keyboard: true }, null, 2),
            );
            app.exit(0);
            return;
        }
        await run(
            `document.querySelector('.cw-import-open').click();document.querySelector('.cw-import-source input').value='source';document.querySelector('[data-command="import-scan"]').click();`,
        );
        await wait(150);
        assert.equal(await run(`document.querySelectorAll('.cw-import-results input:checked').length`), 1);
        assert.equal(await run(`document.querySelector('.cw-import-commit').disabled`), false);
        assert.equal(await run(`document.querySelector('.cw-import-original').textContent`), 'Artist — Found');
        await run(
            `window.matches.push({source:{title:'Original title',artist:'1.klas$'},soundcloud:{url:'https://soundcloud.com/archive/title',title:'Original title',artist:'Archive uploader',score:.99,requiresReview:true}});document.querySelector('[data-command="import-scan"]').click()`,
        );
        await wait(100);
        assert.equal(
            await run(`document.querySelectorAll('.cw-import-results input:checked').length`),
            1,
            'uncertain artist is not auto-selected even with a high incoming score',
        );
        assert.equal(
            await run(`[...document.querySelectorAll('.cw-import-original')].at(-1).textContent`),
            '1.klas$ — Original title',
        );
        assert.ok(
            (await run(`[...document.querySelectorAll('.cw-import-row small')].at(-1).textContent`)).includes(
                'Check the original artist',
            ),
        );
        await run(`document.querySelector('[data-command="import-file"]').click()`);
        await wait(100);
        assert.equal(await run(`document.querySelector('.cw-import-title input').value`), 'Subset');
        assert.equal(await run(`document.querySelectorAll('.cw-import-results input:checked').length`), 1);
        await run(`document.querySelector('[data-command="import-file"]').click()`);
        await wait(100);
        assert.equal(await run(`document.querySelector('.cw-import-title input').value`), 'CSV list');
        assert.equal(await run(`document.querySelector('[data-command="import-file"]').textContent`), 'Import CSV/TXT');
        fs.writeFileSync(path.join(out, 'import-interface.png'), (await win.webContents.capturePage()).toPNG());
        await run(`document.querySelector('.cw-import-commit').click()`);
        await wait(100);
        assert.deepEqual(await run(`commits[0]`), { indexes: [0], title: 'CSV list' });
        assert.equal(await run(`document.querySelector('.cw-import-results input').disabled`), true);
        await run(
            `document.querySelector('.cw-import-source input').value='error';document.querySelector('[data-command="import-scan"]').click();`,
        );
        await wait(100);
        assert.equal(await run(`document.querySelector('.cw-import-message').textContent`), 'ONLY_NETWORK_ERROR');
        assert.equal(
            await run(`document.querySelector('.cw-import-caption').textContent`),
            'Could not read the source',
        );
        assert.equal(await run(`document.querySelector('.cw-import-commit').disabled`), true);
        const report = {
            realElectronInterface: true,
            fileCancelPreservesMatches: true,
            englishFileButton: true,
            partialSelectionCanBeSaved: true,
            noFalseFoundTracksMessage: true,
        };
        fs.writeFileSync(path.join(out, 'import-interface.json'), JSON.stringify(report, null, 2));
        fs.writeSync(1, JSON.stringify(report) + '\n');
        app.exit(0);
    } catch (error) {
        fs.writeSync(2, error.stack + '\n');
        app.exit(1);
    } finally {
        if (win && !win.isDestroyed()) win.destroy();
    }
});
setTimeout(() => app.exit(2), 20000).unref();
