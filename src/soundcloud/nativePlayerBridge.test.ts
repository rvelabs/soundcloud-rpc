import { afterEach, describe, expect, it, vi } from 'vitest';
import { installNativePlayerMonitor, nativePlayerCommand, nativeAutoplay } from './nativePlayerBridge';

class Bus {
    listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    on(events: string, callback: (...args: unknown[]) => void) {
        for (const event of events.split(' ')) {
            if (!this.listeners.has(event)) this.listeners.set(event, new Set());
            this.listeners.get(event)!.add(callback);
        }
    }
    off(events: string, callback: (...args: unknown[]) => void) {
        for (const event of events.split(' ')) this.listeners.get(event)?.delete(callback);
    }
    emit(event: string) {
        for (const callback of [...(this.listeners.get(event) || [])]) callback();
        for (const callback of [...(this.listeners.get('all') || [])]) callback(event);
    }
    count() {
        return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
    }
}
function fixture() {
    const liked = new Set([1]);
    const likes = Object.assign(new Bus(), { get: (id: unknown) => liked.has(Number(id)) });
    function Likes() {}
    Likes.prototype.readEndpoint = 'soundLikesIds';
    Likes.instances = { find: () => likes };
    const makeSound = (id: number) =>
        Object.assign(new Bus(), {
            id,
            position: 0,
            playing: true,
            get(key: string): unknown {
                return {
                    id,
                    title: 'Track ' + id,
                    permalink_url: 'https://soundcloud.com/artist/t' + id,
                    artwork_url: '',
                    user: { username: 'Artist' },
                }[key];
            },
            currentTime() {
                return this.position;
            },
            getMediaDuration: () => 180000,
            isPlaying() {
                return this.playing;
            },
            isAd: () => false,
        });
    const first = makeSound(1),
        second = makeSound(2);
    let current = first,
        fallback = true;
    const manager = Object.assign(new Bus(), {
        getCurrentSound: () => current,
        getQueue: () => ({}),
        pauseCurrent: vi.fn(() => {
            current.playing = false;
            current.emit('pause');
        }),
        playCurrent: vi.fn(() => {
            current.playing = true;
            current.emit('play');
        }),
        playNext: vi.fn(),
        playPrev: vi.fn(),
        toggleCurrent: () => {
            if (current.playing) manager.pauseCurrent();
            else manager.playCurrent();
        },
        getState: (key: string) => (key === 'fallbackEnabled' ? fallback : false),
        toggleState: vi.fn((_key: string, value: boolean) => {
            fallback = value;
        }),
    });
    const actions = { like: vi.fn(), follow() {}, repost() {} };
    const gate = { playWithSignupWall: vi.fn((play: () => void) => play()) };
    const exports = () => [manager, Likes, actions, gate];
    const updates = vi.fn(),
        progress = vi.fn();
    return {
        manager,
        first,
        second,
        liked,
        likes,
        actions,
        gate,
        exports,
        updates,
        progress,
        next: () => {
            current = second;
            manager.emit('change-current-sound');
        },
    };
}
describe('native playback events and controls', () => {
    afterEach(() => vi.useRealTimers());
    it('switches model subscriptions and clears the previous track like without reading the DOM', () => {
        const f = fixture();
        const stop = installNativePlayerMonitor(f.exports, f.updates, f.progress)!;
        expect(f.updates.mock.lastCall?.[0]).toMatchObject({ title: 'Track 1', isLiked: true, duration: '3:00' });
        f.next();
        expect(f.first.count()).toBe(0);
        expect(f.updates.mock.lastCall?.[0]).toMatchObject({ title: 'Track 2', isLiked: false });
        f.liked.add(2);
        f.likes.emit('change');
        expect(f.updates.mock.lastCall?.[0]).toMatchObject({ isLiked: true });
        stop();
        expect(f.second.count() + f.likes.count() + f.manager.count()).toBe(0);
    });
    it('throttles frequent audio events, distinguishes seeking and preserves a real pause', () => {
        vi.useFakeTimers();
        vi.setSystemTime(100000);
        const f = fixture();
        const stop = installNativePlayerMonitor(f.exports, f.updates, f.progress)!;
        for (let n = 1; n <= 600; n++) {
            vi.setSystemTime(100000 + n * 10);
            f.first.position = n * 10;
            f.first.emit('time');
        }
        expect(f.updates).toHaveBeenCalledTimes(1);
        expect(f.progress).toHaveBeenCalledTimes(1);
        f.first.position = 120000;
        f.first.emit('seeked');
        expect(f.updates.mock.lastCall?.[1]).toBe('seek-change');
        f.first.playing = false;
        f.first.emit('pause');
        expect(f.updates.mock.lastCall?.[0]).toMatchObject({ isPlaying: false, elapsed: '2:00' });
        stop();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('reports the final seconds with bounded notifications', () => {
        vi.useFakeTimers();
        vi.setSystemTime(100000);
        const f = fixture();
        const stop = installNativePlayerMonitor(f.exports, f.updates, f.progress)!;
        for (let n = 1; n <= 40; n++) {
            vi.setSystemTime(100000 + n * 250);
            f.first.position = 170000 + n * 250;
            f.first.emit('time');
        }
        expect(f.updates.mock.calls.length).toBeGreaterThanOrEqual(5);
        expect(f.updates.mock.calls.length).toBeLessThanOrEqual(7);
        stop();
    });
    it('uses native pause, signup-gated resume, previous, next and canonical like toggling', () => {
        const f = fixture();
        expect(nativePlayerCommand('toggle', f.exports)).toBe('done');
        expect(f.manager.pauseCurrent).toHaveBeenCalledOnce();
        expect(nativePlayerCommand('toggle', f.exports)).toBe('done');
        expect(f.gate.playWithSignupWall).toHaveBeenCalledOnce();
        expect(f.manager.playCurrent).toHaveBeenCalledOnce();
        nativePlayerCommand('next', f.exports);
        nativePlayerCommand('previous', f.exports);
        nativePlayerCommand('like', f.exports);
        expect(f.manager.playNext).toHaveBeenCalledWith({ userInitiated: true });
        expect(f.manager.playPrev).toHaveBeenCalledOnce();
        expect(f.actions.like).toHaveBeenCalledWith(f.first);
    });
    it('never asks a fallback to repeat an action after an uncertain mutation', () => {
        const f = fixture();
        f.manager.playNext.mockImplementation(() => {
            throw Error('Lost acknowledgment');
        });
        expect(nativePlayerCommand('next', f.exports)).toBe('uncertain');
        expect(nativePlayerCommand('toggle', () => [])).toBe('unsupported');
    });
    it('restores the exact autoplay setting without opening the queue', () => {
        const f = fixture();
        expect(nativeAutoplay(false, f.exports)).toEqual({ previous: true });
        expect(nativeAutoplay(false, f.exports)).toEqual({ previous: false });
        expect(f.manager.toggleState).toHaveBeenCalledTimes(1);
        expect(nativeAutoplay(true, f.exports)).toEqual({ previous: false });
        expect(nativeAutoplay(true, () => [])).toBeNull();
    });
});
