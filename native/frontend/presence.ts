import { invoke } from './bridge';

type Snapshot = {
    title: string;
    author: string;
    url: string;
    artwork?: string;
    isPlaying: boolean;
    elapsed: string;
    duration: string;
};
const seconds = (value: string) => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);

export class PresenceBridge {
    private signature = '';
    private started = 0;
    constructor(
        private send = (track: object | null) => invoke('presence_update', { track }),
        private now = Date.now,
    ) {}
    observe(snapshot: Snapshot): void {
        const elapsed = seconds(snapshot.elapsed),
            duration = seconds(snapshot.duration);
        const signature = JSON.stringify([
            snapshot.title,
            snapshot.author,
            snapshot.url,
            snapshot.artwork,
            snapshot.isPlaying,
            duration,
        ]);
        const started = this.now() - elapsed * 1000;
        if (signature === this.signature && (!snapshot.isPlaying || Math.abs(started - this.started) < 2500)) return;
        this.signature = signature;
        this.started = started;
        void this.send({
            title: snapshot.title,
            author: snapshot.author,
            url: snapshot.url,
            artwork: snapshot.artwork || '',
            playing: snapshot.isPlaying,
            elapsed,
            duration,
        }).catch(() => {
            this.signature = '';
        });
    }
    clear(): Promise<unknown> {
        this.signature = '';
        return this.send(null);
    }
}
