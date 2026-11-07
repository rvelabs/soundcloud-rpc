export class ListeningEvidence {
    private previous?: { url: string; position: number; playing: boolean; at: number; rate: number };
    private seconds = new Map<string, number>();
    constructor(private now = Date.now) {}
    observe(url: string, position: number, playing: boolean, rate = 1): void {
        if (!url || !Number.isFinite(position) || position < 0) return;
        if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) rate = 1;
        const at = this.now();
        const old = this.previous;
        if (old?.url === url && old.playing) {
            const elapsed = (at - old.at) / 1000;
            const moved = position - old.position;
            if (elapsed > 0 && elapsed <= 15 && moved > 0 && moved <= elapsed * Math.max(old.rate, rate) + 1.5)
                this.seconds.set(url, (this.seconds.get(url) || 0) + Math.min(elapsed * old.rate, moved));
        }
        this.previous = { url, position, playing, at, rate };
        if (this.seconds.size > 100) this.seconds.delete(this.seconds.keys().next().value!);
    }
    fraction(url: string, duration: number): number {
        return Number.isFinite(duration) && duration > 0 ? Math.min(1, this.played(url) / duration) : 0;
    }
    played(url: string): number {
        return this.seconds.get(url) || 0;
    }
    reset(): void {
        this.previous = undefined;
        this.seconds.clear();
    }
}
