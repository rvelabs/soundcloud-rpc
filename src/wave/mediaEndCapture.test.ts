import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { installWaveMediaEndCapture } from './mediaEndCapture';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('media end preparation', () => {
    it('recovers a swallowed end once without advancing a manual pause or an inactive wave', async () => {
        class Media extends EventTarget {
            duration = 180;
            currentTime = 0;
            currentSrc = 'one';
            src = 'one';
            paused = true;
            ended = false;
            seeking = false;
            playbackRate = 1;
            play() {
                this.paused = false;
                return Promise.resolve();
            }
        }
        const window = new EventTarget() as EventTarget & {
            __waveMediaEndState: { active: boolean; queueReady: boolean; currentPath: string };
            __waveMediaEndSnapshot: () => { endedEvents: number; recoveredEvents: number };
        };
        let badge = '/artist/one';
        const completions: string[] = [];
        window.addEventListener('__soundcloudWaveMediaEnded', (event) =>
            completions.push((event as CustomEvent).detail),
        );
        runInNewContext(`(${installWaveMediaEndCapture.toString()})()`, {
            window,
            Event,
            CustomEvent,
            HTMLMediaElement: Media,
            setTimeout,
            clearTimeout,
            document: { querySelectorAll: () => [], querySelector: () => ({ pathname: badge }) },
        });
        window.__waveMediaEndState = { active: true, queueReady: false, currentPath: badge };
        const media = new Media();
        media.addEventListener('ended', (event) => event.stopImmediatePropagation(), true);
        await media.play();
        media.currentTime = 179;
        media.dispatchEvent(new Event('timeupdate'));
        media.currentTime = 180;
        media.ended = media.paused = true;
        media.dispatchEvent(new Event('pause'));
        media.dispatchEvent(new Event('ended'));
        await vi.advanceTimersByTimeAsync(500);
        expect(completions).toEqual(['/artist/one']);
        expect(window.__waveMediaEndSnapshot()).toMatchObject({ endedEvents: 0, recoveredEvents: 1 });
        media.dispatchEvent(new Event('timeupdate'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(completions).toHaveLength(1);
        media.src = media.currentSrc = 'two';
        media.currentTime = 0;
        media.ended = false;
        await media.play();
        media.currentTime = 10;
        badge = window.__waveMediaEndState.currentPath = '/artist/two';
        window.dispatchEvent(new Event('__soundcloudWaveMediaState'));
        media.currentTime = 179.9;
        media.dispatchEvent(new Event('timeupdate'));
        media.paused = true;
        media.dispatchEvent(new Event('pause'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(completions).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        await media.play();
        media.dispatchEvent(new Event('playing'));
        media.currentTime = 180;
        media.ended = media.paused = true;
        media.dispatchEvent(new Event('pause'));
        media.dispatchEvent(new Event('ended'));
        await vi.advanceTimersByTimeAsync(500);
        expect(completions).toEqual(['/artist/one', '/artist/two']);
        window.__waveMediaEndState.active = false;
        window.dispatchEvent(new Event('__soundcloudWaveMediaState'));
        expect(vi.getTimerCount()).toBe(0);
    });
    it('corrects a delayed badge at the beginning, preserving old end events and pause resumes', () => {
        class Media extends EventTarget {
            duration = 180;
            currentTime = 0;
            currentSrc = 'one';
            src = 'one';
            play() {
                return Promise.resolve();
            }
        }
        const window = new EventTarget() as EventTarget & {
            __waveMediaEndState: { active: boolean; queueReady: boolean; currentPath: string };
        };
        let badge = '/artist/one';
        const ended: string[] = [];
        window.addEventListener('__soundcloudWaveMediaEnded', (event) => ended.push((event as CustomEvent).detail));
        runInNewContext(`(${installWaveMediaEndCapture.toString()})()`, {
            window,
            Event,
            CustomEvent,
            HTMLMediaElement: Media,
            setTimeout,
            clearTimeout,
            document: { querySelectorAll: () => [], querySelector: () => ({ pathname: badge }) },
        });
        window.__waveMediaEndState = { active: true, queueReady: true, currentPath: badge };
        const first = new Media();
        void first.play();
        first.currentTime = 180;
        first.dispatchEvent(new Event('timeupdate'));
        const second = new Media();
        second.src = second.currentSrc = 'two';
        void second.play();
        second.dispatchEvent(new Event('playing'));
        badge = window.__waveMediaEndState.currentPath = '/artist/two';
        second.currentTime = 0.4;
        second.dispatchEvent(new Event('timeupdate'));
        first.dispatchEvent(new Event('ended'));
        second.currentTime = 179.8;
        second.dispatchEvent(new Event('timeupdate'));
        badge = '/artist/three';
        void second.play();
        second.dispatchEvent(new Event('playing'));
        second.dispatchEvent(new Event('timeupdate'));
        second.dispatchEvent(new Event('ended'));
        expect(ended).toEqual(['/artist/one', '/artist/two']);
        second.currentTime = 0;
        second.src = second.currentSrc = 'three';
        void second.play();
        second.currentTime = 0.5;
        window.__waveMediaEndState.currentPath = badge;
        second.dispatchEvent(new Event('timeupdate'));
        second.currentTime = 180;
        second.dispatchEvent(new Event('ended'));
        expect(ended[2]).toBe('/artist/three');
    });
    it('prepares detached media without cutting off the end and preserves real play results', async () => {
        class Media extends EventTarget {
            duration = 180;
            currentTime = 179.4;
            currentSrc = 'song-1';
            src = 'song-1';
            paused = false;
            promise = Promise.resolve('actual playback');
            calls = 0;
            play() {
                this.calls++;
                this.paused = false;
                return this.promise;
            }
            pause() {
                this.paused = true;
            }
        }
        const window = new EventTarget() as EventTarget & {
            __waveMediaEndState?: { active: boolean; queueReady: boolean; handoffPending?: boolean };
        };
        const media = new Media();
        let currentPath = '/artist/track';
        const endedPaths: string[] = [];
        let errors = 0;
        window.addEventListener('__soundcloudWaveMediaError', () => errors++);
        let prepared = 0,
            ended = 0;
        window.addEventListener('__soundcloudWavePrepareNext', () => prepared++);
        window.addEventListener('__soundcloudWaveMediaEnded', (event) => {
            ended++;
            endedPaths.push((event as CustomEvent).detail);
        });
        runInNewContext(`(${installWaveMediaEndCapture.toString()})()`, {
            window,
            Event,
            CustomEvent,
            HTMLMediaElement: Media,
            setTimeout,
            clearTimeout,
            document: { querySelectorAll: () => [], querySelector: () => ({ pathname: currentPath }) },
        });
        window.__waveMediaEndState = { active: true, queueReady: false, handoffPending: true };
        const result = media.play();
        expect(result).toBe(media.promise);
        expect(await result).toBe('actual playback');
        expect(media.calls).toBe(1);
        for (let index = 0; index < 5; index++) media.dispatchEvent(new Event('timeupdate'));
        expect(media.paused).toBe(false);
        expect(ended).toBe(0);
        expect(prepared).toBe(1);
        currentPath = '/artist/next';
        media.dispatchEvent(new Event('timeupdate'));
        media.dispatchEvent(new Event('ended'));
        expect(ended).toBe(1);
        window.__waveMediaEndState.queueReady = true;
        media.dispatchEvent(new Event('ended'));
        expect(ended).toBe(2);
        expect(endedPaths).toEqual(['/artist/track', '/artist/track']);
        Object.assign(media, { error: { code: 4 } });
        media.dispatchEvent(new Event('error'));
        expect(errors).toBe(1);
        Object.assign(media, { error: { code: 1 } });
        media.dispatchEvent(new Event('error'));
        expect(errors).toBe(1);
    });
});
