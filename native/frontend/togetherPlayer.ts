import { nativeRuntimeExports } from '../../src/soundcloud/nativeRuntime';
import { nativeAutoplay } from '../../src/soundcloud/nativePlayerBridge';
import { nativeQueueModel } from '../../src/soundcloud/nativeQueueBridge';

export type RemotePlayback = {
    trackUrl: string;
    title: string;
    author: string;
    positionMs: number;
    durationMs: number;
    playing: boolean;
};
export interface LocalPlayback {
    url: string;
    positionMs: number;
    durationMs: number;
    playing: boolean;
    ad: boolean;
}
export interface TogetherBackend {
    current(): LocalPlayback | undefined;
    load(url: string): Promise<boolean>;
    cancel(): void;
    seek(positionMs: number): boolean;
    playing(value: boolean): boolean;
    autoplay(value: boolean): boolean | undefined;
}
type Sound = {
    get(key: string): unknown;
    currentTime(): number;
    getMediaDuration(): number;
    isPlaying(): boolean;
    isAd(): boolean;
};
type Manager = {
    getCurrentSound(): Sound | undefined;
    playCurrent(options: object): void;
    pauseCurrent(options: object): void;
};

export function nativeTogetherBackend(runtime = nativeRuntimeExports): TogetherBackend {
    let ticket = '';
    let cachedManager: Manager | undefined;
    const manager = () =>
        (cachedManager ||= runtime().find(
            (value) =>
                value &&
                typeof (value as Manager).getCurrentSound === 'function' &&
                typeof (value as Manager).playCurrent === 'function',
        ) as Manager | undefined);
    const cancel = () => {
        const page = window as typeof window & { __scRpcQueueTickets?: Map<string, { cancelled: boolean }> };
        const pending = page.__scRpcQueueTickets?.get(ticket);
        if (pending) pending.cancelled = true;
    };
    return {
        current() {
            const sound = manager()?.getCurrentSound();
            if (!sound) return;
            return {
                url: String(sound.get('permalink_url') || '').replace(/\/$/, ''),
                positionMs: sound.currentTime(),
                durationMs: sound.getMediaDuration(),
                playing: sound.isPlaying(),
                ad: sound.isAd(),
            };
        },
        async load(url) {
            cancel();
            ticket = 'together-' + crypto.randomUUID();
            const result = await nativeQueueModel(
                { operation: 'play', urls: [url], ticket, expires: Date.now() + 8000 },
                runtime,
            );
            return result.state === 'done';
        },
        cancel,
        seek(positionMs) {
            const current = manager();
            const sound = current?.getCurrentSound();
            if (!sound || sound.isAd()) return false;
            try {
                const page = window as typeof window & { __soundcloudEqualizer?: { media?: () => HTMLMediaElement[] } };
                const elements = [
                    ...new Set([
                        ...(page.__soundcloudEqualizer?.media?.() || []),
                        ...document.querySelectorAll<HTMLMediaElement>('audio,video'),
                    ]),
                ];
                const matches = elements.filter(
                    (media) =>
                        media.readyState > 0 &&
                        Number.isFinite(media.duration) &&
                        Math.abs(media.duration * 1000 - sound.getMediaDuration()) < 2500,
                );
                const media =
                    matches.find((item) => !item.paused && !item.ended) ||
                    (matches.length === 1 ? matches[0] : undefined);
                if (!media) return false;
                media.currentTime = Math.min(positionMs / 1000, Math.max(0, media.duration - 0.1));
                return true;
            } catch {
                return false;
            }
        },
        playing(value) {
            const current = manager(),
                sound = current?.getCurrentSound();
            if (!current || !sound || sound.isAd()) return false;
            if (sound.isPlaying() !== value) {
                if (value) current.playCurrent({ userInitiated: true });
                else current.pauseCurrent({ userInitiated: false });
            }
            return true;
        },
        autoplay: (value) => nativeAutoplay(value, runtime)?.previous,
    };
}

/** Only one scoped load may commit. Heartbeats never override a manual exit/pause. */
export class TogetherPlayer {
    private generation = 0;
    private wanted?: { playback: RemotePlayback; at: number };
    private loading?: Promise<void>;
    private suspended?: Promise<void>;
    private previousAutoplay?: boolean;
    private on = false;
    private session = 0;
    private failedUrl = '';
    private retryAfter = 0;
    error = '';
    constructor(
        private backend: TogetherBackend,
        private suspend: () => Promise<void>,
        private now = Date.now,
    ) {}
    async update(playback: RemotePlayback | null): Promise<void> {
        if (!this.on) {
            this.on = true;
            const session = ++this.session;
            this.suspended = this.suspend().then(() => {
                if (this.on && this.session === session) this.previousAutoplay = this.backend.autoplay(false);
            });
        }
        if (this.wanted?.playback.trackUrl !== playback?.trackUrl) {
            this.generation++;
            this.backend.cancel();
        }
        this.wanted = playback ? { playback: { ...playback }, at: this.now() } : undefined;
        if (!playback) {
            this.backend.playing(false);
            return;
        }
        if (this.loading) return;
        const task = this.apply().finally(() => {
            if (this.loading === task) this.loading = undefined;
        });
        this.loading = task;
        await task;
    }
    private async apply(): Promise<void> {
        while (this.on && this.wanted) {
            await this.suspended;
            if (!this.on || !this.wanted) return;
            if (this.previousAutoplay === undefined) this.previousAutoplay = this.backend.autoplay(false);
            const generation = this.generation,
                desired = this.wanted.playback;
            let current = this.backend.current();
            if (current?.ad) {
                this.error = 'ad';
                return;
            }
            if (current?.url !== desired.trackUrl) {
                if (this.failedUrl === desired.trackUrl && this.now() < this.retryAfter) return;
                this.backend.playing(false);
                const loaded = await this.backend.load(desired.trackUrl).catch(() => false);
                if (!this.on) return;
                if (generation !== this.generation) continue;
                if (!loaded) {
                    this.error = 'unavailable';
                    this.failedUrl = desired.trackUrl;
                    this.retryAfter = this.now() + 60000;
                    return;
                }
                this.failedUrl = '';
                current = this.backend.current();
            }
            if (generation !== this.generation || !this.wanted) continue;
            const latest = this.wanted;
            const target = Math.min(
                latest.playback.durationMs,
                latest.playback.positionMs + (latest.playback.playing ? Math.max(0, this.now() - latest.at) : 0),
            );
            if (current?.url !== latest.playback.trackUrl || current.ad) {
                this.error = 'waiting';
                return;
            }
            if (!latest.playback.playing) this.backend.playing(false);
            if (Math.abs(current.positionMs - target) > 1600 && !this.backend.seek(target)) {
                this.backend.playing(false);
                this.error = 'sync-unavailable';
                return;
            }
            this.backend.playing(latest.playback.playing);
            this.error = '';
            return;
        }
    }
    leave(pause = false): void {
        if (pause && this.on) this.backend.playing(false);
        this.on = false;
        this.session++;
        this.generation++;
        this.wanted = undefined;
        this.backend.cancel();
        if (this.previousAutoplay !== undefined) this.backend.autoplay(this.previousAutoplay);
        this.previousAutoplay = undefined;
        this.error = '';
        this.failedUrl = '';
        this.retryAfter = 0;
    }
}
