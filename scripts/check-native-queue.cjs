const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-native-queue');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile-' + Date.now()));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
        const { removeNativeNextUp, listNativeNextUp, addToNativeNextUp, playInNativePlayer } = require(
            path.join(root, 'tsc/wave/nativeQueue.js'),
        );
        await window.loadURL(
            'data:text/html,' +
                encodeURIComponent(
                    '<a class="playbackSoundBadge__titleLink" href="https://soundcloud.com/a/current"></a><ul class="queue__itemsContainer">' +
                        ['current', 'wave-one', 'wave-two', 'user-track']
                            .map(
                                (id) =>
                                    `<li class="queueItemView"><a href="https://soundcloud.com/a/${id}">${id}</a><button class="queueItemView__remove" onclick="this.parentElement.remove()">Remove</button></li>`,
                            )
                            .join('') +
                        '</ul>',
                ),
        );
        assert(
            await removeNativeNextUp(
                window.webContents,
                ['current', 'wave-one', 'wave-two'].map((id) => 'https://soundcloud.com/a/' + id),
            ),
        );
        assert.deepEqual(await listNativeNextUp(window.webContents), [
            'https://soundcloud.com/a/current',
            'https://soundcloud.com/a/user-track',
        ]);
        await window.webContents.executeJavaScript("document.querySelector('li:last-child button').remove()");
        assert.equal(await removeNativeNextUp(window.webContents, ['https://soundcloud.com/a/user-track']), false);
        await window.webContents.executeJavaScript(
            `document.body.insertAdjacentHTML('beforeend', '<div class="playControls__play"></div><div class="sound"><a class="soundTitle__title" href="https://soundcloud.com/a/pending">Pending</a><button class="sc-button-more">More</button></div><div class="sound"><a class="soundTitle__title" href="https://soundcloud.com/a/priority">Priority</a><div class="soundTitle__playButton"><button class="playButton">Play</button></div></div>');document.querySelector('.playButton').onclick=()=>{document.querySelector('.playbackSoundBadge__titleLink').href='https://soundcloud.com/a/priority';document.querySelector('.playControls__play').classList.add('playing')};true;`,
        );
        let active = true;
        const pending = addToNativeNextUp(
            window.webContents,
            'https://soundcloud.com/a/pending',
            'Pending',
            undefined,
            () => active,
        ).catch((error) => error);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const began = Date.now();
        active = false;
        await playInNativePlayer(window.webContents, 'https://soundcloud.com/a/priority');
        const priorityMs = Date.now() - began;
        assert.equal((await pending).constructor.name, 'NativeActionCanceledError');
        assert(priorityMs < 1000, 'canceled prefetch does not block an explicit playback request');
        await window.webContents.executeJavaScript(
            `document.querySelector('.playButton').onclick=()=>{document.querySelector('.playControls__play').classList.remove('playing');window.doublePlay=true};true;`,
        );
        await playInNativePlayer(window.webContents, 'https://soundcloud.com/a/priority');
        assert.equal(
            await window.webContents.executeJavaScript('window.doublePlay===true'),
            false,
            'already playing track is not toggled to pause',
        );
        await window.webContents.executeJavaScript(
            `document.body.insertAdjacentHTML('beforeend','<div class="sound"><a class="soundTitle__title" href="https://soundcloud.com/a/virtual">Virtualized</a><button class="sc-button-more" id="virtualMore">More</button></div>');window.virtualQueued=false;document.querySelector('#virtualMore').onclick=()=>{document.querySelector('.dropdownMenu')?.remove();const menu=document.createElement('div');menu.className='dropdownMenu';menu.innerHTML='<button class="addToNextUp '+(virtualQueued?'sc-button-selected':'')+'">Add</button>';menu.firstChild.onclick=()=>{virtualQueued=!virtualQueued;menu.remove()};document.body.append(menu)};true;`,
        );
        await addToNativeNextUp(window.webContents, 'https://soundcloud.com/a/virtual');
        assert.equal(
            await window.webContents.executeJavaScript('virtualQueued'),
            true,
            'selected queue action confirms a virtualized entry without toggling it back',
        );
        const report = {
            ownedQueueOnly: true,
            currentPreserved: true,
            userQueuePreserved: true,
            missingControlReported: true,
            priorityPlaybackMs: priorityMs,
            alreadyPlayingPreserved: true,
            virtualizedQueueConfirmed: true,
        };
        fs.writeFileSync(path.join(out, 'native-queue.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        window.destroy();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        window.destroy();
        app.exit(1);
    }
});
setTimeout(() => app.exit(2), 15000).unref();
