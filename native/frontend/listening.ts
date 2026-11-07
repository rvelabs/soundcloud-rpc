import { invoke } from './bridge';
import { playbackRate } from './playbackRate';
type Frame = {
    title: string;
    author: string;
    url: string;
    artwork?: string;
    isPlaying: boolean;
    elapsed: string;
    duration: string;
};
const seconds = (value: string) => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);

export class ListeningBridge {
    private enabled = false;
    private current?: Frame;
    private signature = '';
    private sentAt = -Infinity;
    private position = 0;
    constructor(
        private send = (track: object | null) => invoke('listening_update', { track, playbackRate: playbackRate() }),
        private now = Date.now,
    ) {}
    configure(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.signature = '';
        this.sentAt = -Infinity;
        if (!enabled) void this.send(null).catch(() => {});
        else if (this.current) this.observe(this.current);
    }
    observe(frame: Frame): void {
        this.current = frame;
        if (!this.enabled) return;
        const now = this.now(),
            elapsed = seconds(frame.elapsed),
            duration = seconds(frame.duration);
        if (!Number.isFinite(elapsed) || !Number.isFinite(duration) || elapsed < 0 || duration < 0) return;
        const signature = JSON.stringify([frame.title, frame.author, frame.url, frame.isPlaying, duration]);
        const moved = elapsed - this.position,
            gap = (now - this.sentAt) / 1000;
        if (signature === this.signature && (!frame.isPlaying || (gap < 5 && Math.abs(moved - gap) < 2.5))) return;
        this.signature = signature;
        this.sentAt = now;
        this.position = elapsed;
        void this.send({
            title: frame.title,
            author: frame.author,
            url: frame.url,
            artwork: frame.artwork || '',
            playing: frame.isPlaying,
            elapsed,
            duration,
        }).catch(() => {
            this.sentAt = -Infinity;
            this.signature = '';
        });
    }
    clear(): Promise<unknown> {
        this.current = undefined;
        this.signature = '';
        return this.enabled ? this.send(null) : Promise.resolve();
    }
}
