const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const output = process.env.WAVE_TEST_OUTPUT || path.join(root, 'build-native-player');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile-' + Date.now()));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup() {
    class Events {
        callbacks = new Map();
        on(names, fn) {
            for (const name of names.split(' ')) {
                if (!this.callbacks.has(name)) this.callbacks.set(name, new Set());
                this.callbacks.get(name).add(fn);
            }
        }
        off(names, fn) {
            for (const name of names.split(' ')) this.callbacks.get(name)?.delete(fn);
        }
        emit(name) {
            for (const fn of this.callbacks.get(name) || []) fn();
            for (const fn of this.callbacks.get('all') || []) fn(name);
        }
        count() {
            return [...this.callbacks.values()].reduce((sum, set) => sum + set.size, 0);
        }
    }
    const bytes = new Uint8Array(44 + 16000 * 2 * 2),
        view = new DataView(bytes.buffer);
    const text = (offset, value) => [...value].forEach((char, index) => (bytes[offset + index] = char.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, bytes.length - 44, true);
    const media = document.createElement('audio');
    media.muted = true;
    document.body.append(media);
    const source = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    class Sound extends Events {
        constructor(id) {
            super();
            this.id = id;
        }
        get(key) {
            return {
                id: this.id,
                title: 'Native ' + this.id,
                permalink_url: 'https://soundcloud.com/test/native-' + this.id,
                user: { username: 'Test' },
                artwork_url: '',
            }[key];
        }
        currentTime() {
            return media.currentTime * 1000;
        }
        getMediaDuration() {
            return 2000;
        }
        isPlaying() {
            return !media.paused && !media.ended;
        }
        isAd() {
            return false;
        }
    }
    const tracks = [1, 2, 3, 4].map((id) => new Sound(id));
    const liked = new Set([1]);
    const likes = Object.assign(new Events(), { get: (id) => liked.has(id) });
    function Likes() {}
    Likes.prototype.readEndpoint = 'soundLikesIds';
    Likes.instances = { find: () => likes };
    let index = 0,
        fallback = true;
    const manager = Object.assign(new Events(), {
        getCurrentSound: () => tracks[index],
        getQueue: () => ({}),
        playCurrent: () => media.play(),
        pauseCurrent: () => media.pause(),
        toggleCurrent: () => (media.paused ? media.play() : media.pause()),
        playNext() {
            if (index < 3) {
                index++;
                manager.emit('current-sound');
                media.src = source;
                void media.play();
            }
        },
        playPrev() {
            if (index > 0) {
                index--;
                manager.emit('current-sound');
                media.src = source;
                void media.play();
            }
        },
        getState: (key) => (key === 'fallbackEnabled' ? fallback : false),
        toggleState: (_key, value) => {
            fallback = value;
        },
    });
    const actions = {
        like(sound) {
            if (liked.has(sound.id)) liked.delete(sound.id);
            else liked.add(sound.id);
            likes.emit('change');
        },
        follow() {},
        repost() {},
    };
    const gate = { playWithSignupWall: (play) => play() };
    for (const name of ['play', 'pause', 'timeupdate', 'seeked'])
        media.addEventListener(name, () => tracks[index].emit(name === 'timeupdate' ? 'time' : name));
    media.addEventListener('ended', () => {
        window.finished++;
        tracks[index].emit('finish');
        manager.playNext();
    });
    window.finished = 0;
    window.snapshots = [];
    window.progress = [];
    window.soundcloudAPI = {
        sendTrackUpdate: (data, cause) => snapshots.push({ data, cause }),
        sendTrackProgress: (data) => progress.push(data),
    };
    window.__scRpcModules = [
        {
            c: {
                manager: { exports: manager },
                likes: { exports: Likes },
                actions: { exports: actions },
                gate: { exports: gate },
            },
            m: {},
        },
    ];
    window.listenerCount = () =>
        manager.count() + likes.count() + tracks.reduce((sum, track) => sum + track.count(), 0);
    const Observer = MutationObserver;
    window.observerAttachments = 0;
    window.domReads = 0;
    window.MutationObserver = class extends Observer {
        observe(...args) {
            observerAttachments++;
            super.observe(...args);
        }
    };
    const query = document.querySelector.bind(document);
    document.querySelector = (...args) => {
        domReads++;
        return query(...args);
    };
    media.src = source;
}
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
    const wc = window.webContents;
    try {
        await wc.loadURL('data:text/html,<main>Native player fixture</main>');
        await wc.executeJavaScript(`(${setup.toString()})()`);
        const { audioMonitorScript } = require(path.join(root, 'tsc/services/audioMonitorService'));
        const { controlNativePlayer } = require(path.join(root, 'tsc/soundcloud/nativePlayerBridge'));
        const { setStationAutoplay } = require(path.join(root, 'tsc/wave/nativeAutoplay'));
        await wc.executeJavaScript(audioMonitorScript);
        assert.equal(await wc.executeJavaScript('snapshots.at(-1).data.isLiked'), true);
        assert.equal(await setStationAutoplay(wc, false), true);
        assert.equal(await setStationAutoplay(wc, true), false);
        await controlNativePlayer(wc, 'toggle');
        await wait(150);
        await controlNativePlayer(wc, 'toggle');
        await wait(150);
        assert.equal(await wc.executeJavaScript('snapshots.at(-1).data.isPlaying'), false);
        const before = await wc.executeJavaScript('finished');
        await wait(400);
        assert.equal(await wc.executeJavaScript('finished'), before);
        window.minimize();
        await controlNativePlayer(wc, 'toggle');
        for (let n = 0; n < 100 && (await wc.executeJavaScript('finished < 4')); n++) await wait(150);
        const report = await wc.executeJavaScript(
            `({finished,tracks:[...new Set(snapshots.map(x=>x.data.title))],likes:snapshots.filter(x=>x.data.title==='Native 2').map(x=>x.data.isLiked),observerAttachments,domReads,listeners:listenerCount()})`,
        );
        report.minimized = window.isMinimized();
        assert.equal(report.minimized, true);
        assert.equal(report.finished, 4);
        assert.deepEqual(report.tracks, ['Native 1', 'Native 2', 'Native 3', 'Native 4']);
        assert.ok(report.likes.every((value) => value === false));
        assert.equal(report.observerAttachments, 0);
        assert.equal(report.domReads, 0);
        await wc.executeJavaScript(`window.dispatchEvent(Object.assign(new Event('pagehide'),{persisted:false}))`);
        report.listenersAfterDispose = await wc.executeJavaScript('listenerCount()');
        assert.equal(report.listenersAfterDispose, 0);
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        window.destroy();
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        window.destroy();
        app.exit(1);
    }
});
