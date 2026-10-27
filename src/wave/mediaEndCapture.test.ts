import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { installWaveMediaEndCapture } from './mediaEndCapture';
describe('media end preparation', () => {
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
        let prepared = 0,
            ended = 0;
        window.addEventListener('__soundcloudWavePrepareNext', () => prepared++);
        window.addEventListener('__soundcloudWaveMediaEnded', () => ended++);
        runInNewContext(`(${installWaveMediaEndCapture.toString()})()`, {
            window,
            Event,
            HTMLMediaElement: Media,
            document: { querySelectorAll: () => [] },
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
        media.dispatchEvent(new Event('ended'));
        expect(ended).toBe(1);
        window.__waveMediaEndState.queueReady = true;
        media.dispatchEvent(new Event('ended'));
        expect(ended).toBe(1);
    });
});
