import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { installWaveMediaEndCapture } from './mediaEndCapture';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
    class Media extends EventTarget {
        duration = 180;
        currentTime = 178;
        currentSrc = 'stream';
        src = 'stream';
        paused = true;
        ended = false;
        seeking = false;
        loop = false;
        error: { code: number } | null = null;
        playbackRate = 1;
        play() {
            this.paused = false;
            this.dispatchEvent(new Event('playing'));
            return Promise.resolve();
        }
        pause() {
            this.paused = true;
            this.dispatchEvent(new Event('pause'));
        }
    }
    const page = new EventTarget() as EventTarget & {
        __waveMediaEndState: { active: boolean; queueReady: boolean; currentPath: string };
        __waveMediaEndSnapshot: () => { terminalPauseEvents: number; media: { terminal: boolean }[] };
    };
    const handlers = new Map<string, ((data: object) => void) | null>();
    const mediaSession = {
        setActionHandler: (action: string, handler: ((data: object) => void) | null) => {
            handlers.set(action, handler);
        },
    };
    runInNewContext(`(${installWaveMediaEndCapture.toString()})()`, {
        window: page,
        Event,
        CustomEvent,
        Date,
        HTMLMediaElement: Media,
        setTimeout,
        clearTimeout,
        navigator: { mediaSession },
        document: { querySelectorAll: () => [], querySelector: () => ({ pathname: '/artist/track' }) },
    });
    page.__waveMediaEndState = { active: true, queueReady: false, currentPath: '/artist/track' };
    const media = new Media();
    const completions: string[] = [];
    page.addEventListener('__soundcloudWaveMediaEnded', (event) => completions.push((event as CustomEvent).detail));
    const advance = (position: number) => {
        media.currentTime = position;
        media.dispatchEvent(new Event('timeupdate'));
    };
    const manual = (key?: string) => {
        const input = new Event(key ? 'keydown' : 'click');
        Object.defineProperty(input, 'target', {
            value: { closest: (selector: string) => (selector === '.playControls__play' ? {} : null) },
        });
        if (key) Object.defineProperty(input, 'key', { value: key });
        page.dispatchEvent(input);
    };
    return { page, media, completions, advance, manual, handlers, mediaSession };
}
describe('SoundCloud terminal pause without ended', () => {
    it('does not interpret blur or visibility changes as a pause command', async () => {
        const f = fixture();
        await f.media.play();
        f.advance(179.8);
        f.page.dispatchEvent(new Event('blur'));
        f.page.dispatchEvent(new Event('visibilitychange'));
        f.advance(180);
        f.media.pause();
        await vi.advanceTimersByTimeAsync(500);
        expect(f.completions).toEqual(['/artist/track']);
    });
    it('preserves a system pause when a delayed native ended event follows it', async () => {
        const f = fixture();
        await f.media.play();
        f.advance(179.99);
        f.mediaSession.setActionHandler('pause', () => f.media.pause());
        f.handlers.get('pause')!({ action: 'pause' });
        f.advance(180);
        f.media.ended = true;
        f.media.dispatchEvent(new Event('ended'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.completions).toEqual([]);
        expect(f.page.__waveMediaEndSnapshot().media[0].terminal).toBe(false);
    });
    it('recognizes completion after a long delay in background renderer callbacks', async () => {
        const f = fixture();
        await f.media.play();
        f.advance(179.8);
        vi.setSystemTime(Date.now() + 30000);
        f.media.currentTime = 180;
        f.media.pause();
        await vi.advanceTimersByTimeAsync(500);
        expect(f.completions).toEqual(['/artist/track']);
    });
    it('does not mistake a key which did not pause playback for a pause command', async () => {
        const f = fixture();
        await f.media.play();
        f.advance(179.8);
        f.manual('k');
        await Promise.resolve();
        f.advance(180);
        f.media.pause();
        await vi.advanceTimersByTimeAsync(500);
        expect(f.completions).toHaveLength(1);
    });
    it('honours an explicit media-session pause during the terminal recovery grace', async () => {
        const f = fixture();
        await f.media.play();
        f.advance(179.8);
        f.advance(180);
        f.media.pause();
        f.mediaSession.setActionHandler('pause', () => f.media.pause());
        f.handlers.get('pause')!({ action: 'pause' });
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.completions).toEqual([]);
    });
    it('recovers a completed stream once and retains terminal evidence for later recovery retries', async () => {
        const f = fixture();
        await f.media.play();
        f.advance(179.8);
        f.advance(180);
        f.media.pause();
        await vi.advanceTimersByTimeAsync(500);
        expect(f.media.ended).toBe(false);
        expect(f.completions).toEqual(['/artist/track']);
        await vi.advanceTimersByTimeAsync(16000);
        expect(f.page.__waveMediaEndSnapshot().media[0].terminal).toBe(true);
        expect(f.page.__waveMediaEndSnapshot().terminalPauseEvents).toBe(1);
        f.media.dispatchEvent(new Event('timeupdate'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.completions).toHaveLength(1);
    });
    it.each([undefined, ' ', 'MediaPause'])('preserves an explicit pause at the exact end through %s', async (key) => {
        const f = fixture();
        await f.media.play();
        f.advance(179.99);
        f.manual(key);
        f.advance(180);
        f.media.pause();
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.completions).toEqual([]);
        expect(f.page.__waveMediaEndSnapshot().media[0].terminal).toBe(false);
    });
    it('preserves OS media-session pause and recovers after an intentional resume', async () => {
        const f = fixture();
        await f.media.play();
        f.advance(179.99);
        f.mediaSession.setActionHandler('pause', () => f.media.pause());
        f.handlers.get('pause')!({ action: 'pause' });
        f.advance(180);
        await vi.advanceTimersByTimeAsync(2000);
        expect(f.completions).toEqual([]);
        f.media.currentTime = 178;
        await f.media.play();
        f.advance(179.8);
        f.advance(180);
        f.media.pause();
        await vi.advanceTimersByTimeAsync(500);
        expect(f.completions).toHaveLength(1);
    });
    it.each(['midpoint', 'seeking', 'loop', 'error', 'inactive', 'source-change'])(
        'does not advance %s',
        async (reason) => {
            const f = fixture();
            await f.media.play();
            f.advance(179.8);
            f.advance(reason === 'midpoint' ? 179 : 180);
            if (reason === 'seeking') f.media.seeking = true;
            if (reason === 'loop') f.media.loop = true;
            if (reason === 'error') f.media.error = { code: 3 };
            if (reason === 'inactive') f.page.__waveMediaEndState.active = false;
            if (reason === 'source-change') f.media.src = f.media.currentSrc = 'new-stream';
            f.media.pause();
            await vi.advanceTimersByTimeAsync(5000);
            expect(f.completions).toEqual([]);
        },
    );
});
