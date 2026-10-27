export class TaskPool {
    private busy = new Set<number>();
    private waiting = new Set<() => void>();
    private pausedUntil = 0;
    private pressure = 0;
    private successes = 0;
    constructor(private limit: () => number) {}
    backoff(milliseconds = 10000): void {
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + Math.min(30000, Math.max(1000, milliseconds)));
        this.pressure = Math.min(2, this.pressure + 1);
        this.successes = 0;
    }
    async run<T>(task: (slot: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
        for (;;) {
            signal?.throwIfAborted();
            const limit = Math.max(1, Math.min(10, this.limit()) - this.pressure);
            let slot = 0;
            while (this.busy.has(slot)) slot++;
            if (slot < limit && Date.now() >= this.pausedUntil) {
                this.busy.add(slot);
                const began = Date.now();
                try {
                    return await task(slot);
                } finally {
                    if (Date.now() - began > 20000) this.pressure = Math.min(2, this.pressure + 1);
                    else if (++this.successes >= 10) {
                        this.pressure = Math.max(0, this.pressure - 1);
                        this.successes = 0;
                    }
                    this.busy.delete(slot);
                    for (const wake of this.waiting) wake();
                }
            }
            await new Promise<void>((resolve) => {
                const wake = () => {
                    clearTimeout(timer);
                    this.waiting.delete(wake);
                    signal?.removeEventListener('abort', wake);
                    resolve();
                };
                const timer = setTimeout(wake, 500);
                this.waiting.add(wake);
                signal?.addEventListener('abort', wake, { once: true });
                if (signal?.aborted) wake();
            });
        }
    }
}
