import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { installAudioFeatureCapture } from './audioFeatureCapture';
afterEach(() => vi.useRealTimers());
describe('audio analysis lifecycle', () => {
    it('does not sample cached tracks and wakes for an uncached recording', async () => {
        vi.useFakeTimers();
        class Media extends EventTarget {
            paused = false;
            readyState = 0;
            play() {
                return Promise.resolve();
            }
        }
        const window = new EventTarget() as EventTarget & {
            __waveMediaEndState: { active: boolean; currentPath: string; analysisReadyPath?: string };
        };
        window.__waveMediaEndState = { active: true, currentPath: '/one', analysisReadyPath: '/one' };
        runInNewContext(`(${installAudioFeatureCapture.toString()})()`, {
            window,
            Event,
            HTMLMediaElement: Media,
            setInterval,
            clearInterval,
            document: { querySelectorAll: () => [] },
        });
        const audio = new Media();
        await audio.play();
        expect(vi.getTimerCount()).toBe(0);
        window.__waveMediaEndState.currentPath = '/two';
        window.dispatchEvent(new Event('__soundcloudWaveMediaState'));
        expect(vi.getTimerCount()).toBe(1);
        window.__waveMediaEndState.analysisReadyPath = '/two';
        window.dispatchEvent(new Event('__soundcloudWaveMediaState'));
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('has no idle timer, wakes on playback/state and survives a cached-page roundtrip', async () => {
        vi.useFakeTimers();
        class Media extends EventTarget {
            paused = true;
            readyState = 0;
            promise = Promise.resolve();
            play() {
                this.paused = false;
                return this.promise;
            }
        }
        const window = new EventTarget() as EventTarget & { __waveMediaEndState: { active: boolean } };
        window.__waveMediaEndState = { active: false };
        runInNewContext(`(${installAudioFeatureCapture.toString()})()`, {
            window,
            Event,
            HTMLMediaElement: Media,
            document: { querySelectorAll: () => [] },
            setInterval,
            clearInterval,
        });
        expect(vi.getTimerCount()).toBe(0);
        window.__waveMediaEndState.active = true;
        window.dispatchEvent(new Event('__soundcloudWaveMediaState'));
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(vi.getTimerCount()).toBe(0);
        const media = new Media();
        expect(media.play()).toBe(media.promise);
        expect(vi.getTimerCount()).toBe(1);
        window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
        expect(vi.getTimerCount()).toBe(0);
        window.dispatchEvent(new Event('pageshow'));
        expect(vi.getTimerCount()).toBe(1);
        window.__waveMediaEndState.active = false;
        window.dispatchEvent(new Event('__soundcloudWaveMediaState'));
        expect(vi.getTimerCount()).toBe(0);
        window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    });
});
