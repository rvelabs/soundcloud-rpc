import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { audioMonitorScript } from './audioMonitorService';

describe('native player monitor lifecycle', () => {
    afterEach(() => vi.useRealTimers());
    it('survives canceled navigation and cached-page restoration, disposing only on actual exit', async () => {
        vi.useFakeTimers();
        const window = new EventTarget();
        const updates: unknown[] = [];
        let playing = false;
        const observers: Observer[] = [];
        class Observer {
            active = false;
            constructor(readonly callback: () => void) {
                observers.push(this);
            }
            observe() {
                this.active = true;
            }
            disconnect() {
                this.active = false;
            }
        }
        const title = { href: 'https://soundcloud.com/artist/one', textContent: 'one', getAttribute: () => '' };
        const play = { classList: { contains: () => playing } };
        const document = {
            body: {},
            readyState: 'complete',
            addEventListener() {},
            removeEventListener() {},
            querySelector: (selector: string) =>
                selector === '.playControls__play'
                    ? play
                    : selector === '.playbackSoundBadge__titleLink'
                      ? title
                      : undefined,
        };
        Object.assign(window, { soundcloudAPI: { sendTrackUpdate: (track: unknown) => updates.push(track) } });
        runInNewContext(audioMonitorScript, { window, document, MutationObserver: Observer, setTimeout, clearTimeout });
        await vi.advanceTimersByTimeAsync(150);
        const mutate = async () => {
            for (const observer of observers) if (observer.active) observer.callback();
            await vi.advanceTimersByTimeAsync(150);
        };
        const before = new Event('beforeunload', { cancelable: true });
        before.preventDefault();
        window.dispatchEvent(before);
        playing = true;
        title.href = 'https://soundcloud.com/artist/two';
        await mutate();
        expect(updates[updates.length - 1]).toMatchObject({ url: title.href, isPlaying: true });
        window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        title.href = 'https://soundcloud.com/artist/three';
        await mutate();
        expect(updates[updates.length - 1]).toMatchObject({ url: title.href });
        window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
        const count = updates.length;
        playing = false;
        await mutate();
        expect(updates).toHaveLength(count);
        expect(observers.every((observer) => !observer.active)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
