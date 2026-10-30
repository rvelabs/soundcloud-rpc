import { freemem } from 'node:os';
export type WorkPriority = 'playback' | 'prefetch' | 'import' | 'catalog';
type Lane = 'network' | 'page' | 'playback';
type Job = {
    lane: Lane;
    priority: WorkPriority;
    start: () => void;
    cancel: () => void;
};
const order: WorkPriority[] = ['playback', 'prefetch', 'import', 'catalog'];
export class WorkScheduler {
    private queue: Job[] = [];
    private active = { network: 0, page: 0, playback: 0 };
    private background = { network: 0, page: 0, playback: 0 };
    private closed = false;
    private completed = 0;
    constructor(
        private limits = () => (freemem() < 2 * 1024 ** 3 ? { network: 4, page: 2 } : { network: 12, page: 3 }),
    ) {}
    run<T>(lane: Lane, priority: WorkPriority, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (this.closed) return Promise.reject(new Error('Scheduler disposed'));
        if (signal?.aborted) return Promise.reject(signal.reason);
        return new Promise<T>((resolve, reject) => {
            const remove = () => {
                signal?.removeEventListener('abort', abort);
                const index = this.queue.indexOf(job);
                if (index >= 0) this.queue.splice(index, 1);
            };
            const abort = () => {
                remove();
                reject(signal?.reason || new Error('Task cancelled'));
                this.drain();
            };
            const job: Job = {
                lane,
                priority,
                cancel: () => {
                    remove();
                    reject(new Error('Scheduler disposed'));
                },
                start: () => {
                    remove();
                    const background = order.indexOf(priority) > 1;
                    this.active[lane]++;
                    if (background) this.background[lane]++;
                    void Promise.resolve()
                        .then(() => {
                            signal?.throwIfAborted();
                            return task();
                        })
                        .then(resolve, reject)
                        .finally(() => {
                            this.active[lane]--;
                            if (background) this.background[lane]--;
                            this.completed++;
                            this.drain();
                        });
                },
            };
            this.queue.push(job);
            signal?.addEventListener('abort', abort, { once: true });
            this.drain();
        });
    }
    private drain(): void {
        if (this.closed) return;
        const limits = this.limits();
        this.queue.sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority));
        for (const job of [...this.queue]) {
            const limit = job.lane === 'playback' ? 1 : Math.max(1, limits[job.lane]);
            if (this.active[job.lane] >= limit) continue;
            if (order.indexOf(job.priority) > 1 && this.background[job.lane] >= Math.max(1, limit - 1)) continue;
            job.start();
        }
    }
    diagnostics(): object {
        return { active: { ...this.active }, queued: this.queue.length, completed: this.completed };
    }
    dispose(): void {
        this.closed = true;
        for (const job of [...this.queue]) job.cancel();
    }
}
