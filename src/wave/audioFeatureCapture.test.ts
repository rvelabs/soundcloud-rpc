import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { installAudioFeatureCapture } from './audioFeatureCapture';
afterEach(() => vi.useRealTimers());
describe('audio analysis lifecycle', () => {
    it('reads the existing player graph without a DOM badge or a second capture stream, and releases only its tap', async () => {
        vi.useFakeTimers();
        class Media extends EventTarget {
            paused = false;
            ended = false;
            mediaKeys = null;
            readyState = 4;
            currentTime = 0;
            currentSrc = 'blob:https://soundcloud.com/test-audio';
            src = this.currentSrc;
            crossOrigin = 'anonymous';
            play() {
                return Promise.resolve();
            }
        }
        const media = new Media(),
            release = vi.fn(),
            send = vi.fn();
        const analyser = {
            fftSize: 1024,
            frequencyBinCount: 512,
            context: { sampleRate: 48000 },
            getFloatTimeDomainData: (data: Float32Array) => data.fill(0.25),
            getFloatFrequencyData: (data: Float32Array) => {
                data.fill(-Infinity);
                data[1] = 0;
            },
        };
        const tap = vi.fn(() => ({ analyser, release }));
        const page = Object.assign(new EventTarget(), {
            __waveMediaEndState: { active: true, currentPath: '/test/tone', analysisReadyPath: '' },
            __soundcloudEqualizer: { analysisTap: tap },
            soundcloudAPI: { sendAudioFeatures: send },
        });
        runInNewContext(`(${installAudioFeatureCapture.toString()})()`, {
            window: page,
            Event,
            HTMLMediaElement: Media,
            setInterval,
            clearInterval,
            URL,
            location: { origin: 'https://soundcloud.com', href: 'https://soundcloud.com/' },
            document: { querySelector: () => null, querySelectorAll: () => [media] },
        });
        await media.play();
        for (let second = 1; second <= 32; second++) {
            media.currentTime = second;
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(tap).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalled();
        expect(send.mock.calls[send.mock.calls.length - 1][0]).toMatchObject({
            path: '/test/tone',
            source: 'media-element-v1',
            energy: 0.25,
            bass: 1,
            treble: 0,
        });
        page.__waveMediaEndState.analysisReadyPath = '/test/tone';
        page.dispatchEvent(new Event('__soundcloudWaveMediaState'));
        await Promise.resolve();
        expect(release).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
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
