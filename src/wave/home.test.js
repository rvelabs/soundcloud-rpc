import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
function makeElement() {
    const listeners = new Map();
    return {
        listeners,
        dataset: {},
        style: { setProperty() {} },
        value: '100',
        hidden: false,
        classList: { toggle() {}, remove() {}, add() {} },
        addEventListener(type, callback) {
            listeners.set(type, callback);
        },
        setAttribute() {},
        removeAttribute() {},
    };
}
describe('wave player controls', () => {
    it('releases a capture that resolves after the wave was stopped', async () => {
        const elements = new Map();
        const channels = new Map();
        const document = {
            body: makeElement(),
            hidden: false,
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeElement());
                return elements.get(id);
            },
            querySelectorAll: () => [],
            addEventListener() {},
        };
        let resolveCapture;
        const pendingCapture = new Promise((resolve) => {
            resolveCapture = resolve;
        });
        const track = {
            stopped: false,
            stop() {
                this.stopped = true;
            },
        };
        const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
        const window = {
            waveHome: {
                on: (name, callback) => channels.set(name, callback),
                track() {},
                audio() {},
                next() {},
                previous() {},
                shuffle() {},
                openTrack() {},
            },
        };
        runInNewContext(readFileSync(new URL('./home.js', import.meta.url), 'utf8'), {
            window,
            document,
            navigator: { mediaDevices: { getDisplayMedia: () => pendingCapture } },
            AudioContext: class {},
            setTimeout: () => 1,
            clearTimeout() {},
        });
        const starting = window.startWaveAudio();
        channels.get('wave-home:stop-audio')();
        resolveCapture(stream);
        await starting;
        expect(track.stopped).toBe(true);
    });
    it('pauses the second track during and after widget reload', () => {
        const elements = new Map();
        const get = (id) => {
            if (!elements.has(id)) elements.set(id, makeElement());
            return elements.get(id);
        };
        const channels = new Map();
        const widget = {
            handlers: new Map(),
            paused: true,
            playCount: 0,
            pauseCount: 0,
            bind(name, callback) {
                this.handlers.set(name, callback);
            },
            load(_url, options) {
                this.loadCallback = options.callback;
            },
            play() {
                this.paused = false;
                this.playCount++;
            },
            pause() {
                this.paused = true;
                this.pauseCount++;
            },
            setVolume() {},
            seekTo() {},
            isPaused(callback) {
                callback(this.paused);
            },
            getCurrentSound(callback) {
                callback({ title: 'Track', duration: 120000, user: { username: 'Artist' } });
            },
        };
        const Widget = () => widget;
        Widget.Events = Object.fromEntries(
            ['READY', 'PLAY', 'PAUSE', 'PLAY_PROGRESS', 'FINISH', 'ERROR'].map((name) => [name, name]),
        );
        const document = {
            body: makeElement(),
            hidden: false,
            getElementById: get,
            querySelectorAll: () => [],
            addEventListener() {},
        };
        const window = {
            SC: { Widget },
            waveHome: {
                on: (name, callback) => channels.set(name, callback),
                track() {},
                audio() {},
                next() {},
                previous() {},
                shuffle() {},
                openTrack() {},
            },
        };
        runInNewContext(readFileSync(new URL('./home.js', import.meta.url), 'utf8'), {
            window,
            document,
            navigator: {},
            AudioContext: class {},
            setTimeout: () => 1,
            clearTimeout() {},
        });
        const first = { url: 'https://soundcloud.com/artist/first', title: 'First', artist: 'Artist' };
        const second = { url: 'https://soundcloud.com/artist/second', title: 'Second', artist: 'Artist' };
        channels.get('wave-home:play-track')(first);
        widget.handlers.get('READY')();
        widget.handlers.get('PLAY')();
        channels.get('wave-home:play-track')(second);
        elements.get('play-toggle').listeners.get('click')();
        const pausesDuringLoad = widget.pauseCount;
        expect(pausesDuringLoad).toBeGreaterThan(0);
        const playsBeforeReady = widget.playCount;
        widget.loadCallback();
        expect(widget.playCount).toBe(playsBeforeReady);
        expect(widget.paused).toBe(true);
        elements.get('play-toggle').listeners.get('click')();
        expect(widget.paused).toBe(false);
        elements.get('play-toggle').listeners.get('click')();
        expect(widget.paused).toBe(true);
        expect(widget.pauseCount).toBeGreaterThan(pausesDuringLoad);
    });
    it('advances exactly once when PAUSE, FINISH and the end watchdog overlap', () => {
        const elements = new Map();
        const get = (id) => {
            if (!elements.has(id)) elements.set(id, makeElement());
            return elements.get(id);
        };
        const channels = new Map();
        const next = [];
        let watchdog;
        let pauseFallback;
        let now = 0;
        const widget = {
            handlers: new Map(),
            bind(name, callback) {
                this.handlers.set(name, callback);
            },
            load(_url, options) {
                this.loadCallback = options.callback;
            },
            play() {},
            pause() {},
            setVolume() {},
            seekTo() {},
            isPaused(callback) {
                callback(false);
            },
            getCurrentSound(callback) {
                callback({ title: 'Track', duration: 120000, user: { username: 'Artist' } });
            },
        };
        const Widget = () => widget;
        Widget.Events = Object.fromEntries(
            ['READY', 'PLAY', 'PAUSE', 'PLAY_PROGRESS', 'FINISH', 'ERROR'].map((name) => [name, name]),
        );
        const window = {
            SC: { Widget },
            waveHome: {
                on: (name, callback) => channels.set(name, callback),
                track() {},
                audio() {},
                next: (reason) => next.push(reason),
                previous() {},
                shuffle() {},
                openTrack() {},
            },
        };
        runInNewContext(readFileSync(new URL('./home.js', import.meta.url), 'utf8'), {
            window,
            document: {
                body: makeElement(),
                hidden: false,
                getElementById: get,
                querySelectorAll: () => [],
                addEventListener() {},
            },
            navigator: {},
            AudioContext: class {},
            Date: { now: () => now },
            setTimeout: (callback, delay) => {
                if (delay === 1700) watchdog = callback;
                if (delay === 700) pauseFallback = callback;
                return 1;
            },
            clearTimeout() {},
        });
        channels.get('wave-home:play-track')({ url: 'https://soundcloud.com/a/one', title: 'One', artist: 'A' });
        widget.handlers.get('READY')();
        widget.handlers.get('PLAY')();
        widget.handlers.get('PLAY_PROGRESS')({ currentPosition: 119000 });
        now = 1000;
        widget.handlers.get('PAUSE')();
        pauseFallback?.();
        widget.handlers.get('FINISH')();
        watchdog?.();
        expect(next).toEqual(['finish']);
    });
});
