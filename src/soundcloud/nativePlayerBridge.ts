import type { WebContents } from 'electron';
import { nativeRuntimeExports } from './nativeRuntime';

export function installNativePlayerMonitor(
    getExports: () => unknown[],
    update: (track: unknown, cause: string) => void,
    progress: (track: unknown) => void,
): (() => void) | null {
    type Events = {
        on: (events: string, callback: (...args: unknown[]) => void) => void;
        off: (events: string, callback: (...args: unknown[]) => void) => void;
    };
    type Sound = Events & {
        get: (key: string) => unknown;
        currentTime: () => number;
        getMediaDuration: () => number;
        isPlaying: () => boolean;
        isAd: () => boolean;
        getDisplayArtist?: () => string;
    };
    type Manager = Events & { getCurrentSound: () => Sound | undefined; getQueue: () => unknown };
    const values = getExports();
    const manager = values.find(
        (value) =>
            value &&
            ['getCurrentSound', 'getQueue', 'on', 'off'].every(
                (key) => typeof (value as Record<string, unknown>)[key] === 'function',
            ),
    ) as Manager | undefined;
    if (!manager) return null;
    const compatible = (value: unknown) =>
        value &&
        ['get', 'on', 'off', 'currentTime', 'getMediaDuration', 'isPlaying', 'isAd'].every(
            (key) => typeof (value as Record<string, unknown>)[key] === 'function',
        );
    const initial = manager.getCurrentSound();
    if (
        initial
            ? !compatible(initial)
            : !values.some((value) => compatible((value as { prototype?: unknown })?.prototype))
    )
        return null;
    type Likes = Events & { get: (id: unknown) => unknown };
    const likesClass = values.find(
        (value) => (value as { prototype?: { readEndpoint?: string } })?.prototype?.readEndpoint === 'soundLikesIds',
    ) as { instances?: { find: (predicate: () => boolean) => Likes | undefined } } | undefined;
    const likes = likesClass?.instances?.find(() => true);
    let sound: Sound | undefined,
        last = '',
        lastProgress = 0,
        lastCheck = -Infinity,
        closed = false;
    const format = (value: number) => {
        const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value / 1000 : 0));
        return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    };
    const emit = (seek = false) => {
        if (closed || !sound) return;
        try {
            if (sound.isAd()) return;
            const url = new URL(String(sound.get('permalink_url')));
            if (url.origin !== 'https://soundcloud.com' || !/^\/[\w.~-]+\/[\w.~-]+\/?$/.test(url.pathname)) return;
            const user = sound.get('user') as { username?: string } | undefined;
            const position = sound.currentTime(),
                duration = sound.getMediaDuration();
            const next = {
                title: String(sound.get('title') || '').slice(0, 200),
                author: String(sound.getDisplayArtist?.() || user?.username || '').slice(0, 200),
                artwork: String(sound.get('artwork_url') || ''),
                url: url.origin + url.pathname.replace(/\/$/, ''),
                elapsed: format(position),
                duration: format(duration),
                isPlaying: sound.isPlaying(),
                isLiked: likes ? likes.get(sound.get('id')) === true : sound.get('user_favorite') === true,
            };
            const signature = JSON.stringify([
                next.url,
                next.title,
                next.author,
                next.artwork,
                next.duration,
                next.isPlaying,
                next.isLiked,
            ]);
            const now = Date.now(),
                nearEnd = duration > 0 && position >= duration - 5000;
            if (seek || signature !== last || (nearEnd && now - lastProgress >= 1000)) {
                update(next, seek ? 'seek-change' : 'playback-state-change');
                last = signature;
                lastProgress = now;
            } else if (next.isPlaying && now - lastProgress >= 5000) {
                progress(next);
                lastProgress = now;
            }
        } catch {}
    };
    const changed = () => emit();
    const seeked = () => emit(true);
    const time = () => {
        if (Date.now() - lastCheck < 250) return;
        lastCheck = Date.now();
        emit();
    };
    const events =
        'play pause playStart playEnd buffering:start buffering:end finish change:title change:user change:artwork_url change:user_favorite change:publisher_metadata';
    const unbind = () => {
        sound?.off(events, changed);
        sound?.off('time', time);
        sound?.off('seeked', seeked);
    };
    const bind = () => {
        const current = manager.getCurrentSound();
        if (current !== sound) {
            unbind();
            sound = undefined;
            if (!current && last) {
                last = '';
                update(
                    {
                        title: '',
                        author: '',
                        artwork: '',
                        url: '',
                        elapsed: '0:00',
                        duration: '0:00',
                        isPlaying: false,
                        isLiked: false,
                    },
                    'playback-state-change',
                );
            }
            if (
                current &&
                ['get', 'on', 'off', 'currentTime', 'getMediaDuration', 'isPlaying', 'isAd'].every(
                    (key) => typeof (current as unknown as Record<string, unknown>)[key] === 'function',
                )
            ) {
                sound = current;
                sound.on(events, changed);
                sound.on('time', time);
                sound.on('seeked', seeked);
            }
        }
        emit();
    };
    try {
        manager.on('all', bind);
        likes?.on('change', changed);
        bind();
    } catch {
        unbind();
        manager.off('all', bind);
        likes?.off('change', changed);
        return null;
    }
    return () => {
        closed = true;
        manager.off('all', bind);
        likes?.off('change', changed);
        unbind();
        sound = undefined;
    };
}

export type NativePlayerCommand = 'toggle' | 'previous' | 'next' | 'like';
export function nativePlayerCommand(
    command: NativePlayerCommand,
    getExports: (gate?: boolean) => unknown[],
): 'done' | 'unsupported' | 'uncertain' {
    const values = getExports(command === 'toggle');
    const manager = values.find(
        (value) =>
            value &&
            ['getCurrentSound', 'getQueue', 'toggleCurrent', 'playNext', 'playPrev'].every(
                (key) => typeof (value as Record<string, unknown>)[key] === 'function',
            ),
    ) as
        | {
              getCurrentSound: () => { isPlaying: () => boolean; get: (key: string) => unknown } | undefined;
              playCurrent: (options: object) => void;
              pauseCurrent: (options: object) => void;
              toggleCurrent: (options: object) => void;
              getState?: (key: string) => unknown;
              playNext: (options: object) => void;
              playPrev: (options: object) => void;
          }
        | undefined;
    if (!manager) return 'unsupported';
    const sound = manager.getCurrentSound();
    if (!sound || typeof sound.isPlaying !== 'function') return 'unsupported';
    const options = { userInitiated: true };
    let acted = false;
    try {
        if (command === 'toggle' && sound.isPlaying()) {
            if (manager.getState?.('globalPlayLock') === true) return 'done';
            if (typeof window !== 'undefined') window.dispatchEvent(new Event('__soundcloudWaveManualPause'));
            acted = true;
            manager.toggleCurrent(options);
        } else if (command === 'toggle') {
            const signup = values.find(
                (v) => typeof (v as { playWithSignupWall?: unknown })?.playWithSignupWall === 'function',
            ) as { playWithSignupWall: (play: () => void) => unknown } | undefined;
            if (!signup) return 'unsupported';
            acted = true;
            void Promise.resolve(
                signup.playWithSignupWall(() => {
                    if (manager.getCurrentSound() === sound && !sound.isPlaying()) manager.toggleCurrent(options);
                }),
            ).catch(() => {});
        } else if (command === 'next') {
            acted = true;
            manager.playNext(options);
        } else if (command === 'previous') {
            acted = true;
            manager.playPrev(options);
        } else {
            const actions = values.find((v) =>
                ['like', 'follow', 'repost'].every(
                    (key) => typeof (v as Record<string, unknown>)?.[key] === 'function',
                ),
            ) as { like: (sound: unknown) => unknown } | undefined;
            if (!actions || typeof sound.get !== 'function') return 'unsupported';
            acted = true;
            void Promise.resolve(actions.like(sound)).catch(() => {});
        }
        return 'done';
    } catch {
        return acted ? 'uncertain' : 'unsupported';
    }
}

export function nativeAutoplay(enabled: boolean, getExports: () => unknown[]): { previous: boolean } | null {
    const manager = getExports().find(
        (value) =>
            value &&
            ['getCurrentSound', 'getQueue', 'getState', 'toggleState'].every(
                (key) => typeof (value as Record<string, unknown>)[key] === 'function',
            ),
    ) as { getState: (key: string) => unknown; toggleState: (key: string, value: boolean) => void } | undefined;
    if (!manager) return null;
    const previous = manager.getState('fallbackEnabled');
    if (typeof previous !== 'boolean') return null;
    if (previous !== enabled) manager.toggleState('fallbackEnabled', enabled);
    return manager.getState('fallbackEnabled') === enabled ? { previous } : null;
}

export async function controlNativePlayer(contents: WebContents, command: NativePlayerCommand): Promise<boolean> {
    if (contents.isDestroyed()) return false;
    const selector = {
        toggle: '.playControls__play',
        previous: '.skipControl__previous',
        next: '.skipControl__next',
        like: '.playbackSoundBadge__like',
    }[command];
    try {
        return await contents.executeJavaScript(
            `(() => { const state = (${nativePlayerCommand.toString()})(${JSON.stringify(command)}, ${nativeRuntimeExports.toString()}); if (state !== 'unsupported') return true; const button = document.querySelector(${JSON.stringify(selector)}); if (!button) return false; button.click(); return true; })()`,
            true,
        );
    } catch {
        return false;
    }
}
