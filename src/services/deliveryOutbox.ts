import type { DataStore } from '../storage/asyncDataStore';
interface Delivery<T> {
    id: string;
    payload: T;
    at: number;
    attempts: number;
    nextAt: number;
}
export type DeliveryOutcome = 'sent' | 'retry' | 'drop';
export class DeliveryOutbox<T> {
    private entries: Delivery<T>[];
    private task?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private stopped = false;
    private generation = 0;
    constructor(
        private store: DataStore,
        private key: string,
        private deliver: (payload: T) => Promise<DeliveryOutcome>,
        private enabled: () => boolean,
        private now = Date.now,
    ) {
        const saved = store.get(key);
        this.entries = Array.isArray(saved)
            ? saved
                  .filter(
                      (item) =>
                          item &&
                          typeof item.id === 'string' &&
                          Number.isFinite(item.at) &&
                          Number.isFinite(item.attempts) &&
                          Number.isFinite(item.nextAt) &&
                          item.payload &&
                          typeof item.payload === 'object',
                  )
                  .slice(-100)
            : [];
        queueMicrotask(() => {
            if (!this.stopped) this.start();
        });
    }
    enqueue(id: string, payload: T): void {
        if (this.entries.some((item) => item.id === id)) return;
        this.entries.push({ id, payload, at: this.now(), attempts: 0, nextAt: this.now() });
        if (this.entries.length > 100) this.entries.shift();
        this.save();
        this.start();
    }
    private save(): void {
        this.store.set(this.key, this.entries.slice());
    }
    start(): void {
        this.stopped = false;
        if (this.task || !this.enabled() || !this.entries.length) return;
        clearTimeout(this.timer);
        const generation = this.generation;
        const task = this.drain(generation);
        this.task = task;
        void task
            .catch((error) => console.error('Delivery queue failed:', error.message))
            .finally(() => {
                if (this.task === task) this.task = undefined;
                if (this.stopped || !this.enabled() || !this.entries.length) return;
                const delay = Math.max(1000, Math.min(...this.entries.map((item) => item.nextAt)) - this.now());
                this.timer = setTimeout(() => this.start(), delay);
                this.timer.unref?.();
            });
    }
    private async drain(generation: number): Promise<void> {
        while (!this.stopped && this.enabled() && generation === this.generation) {
            const entry = this.entries.find((item) => item.nextAt <= this.now());
            if (!entry) return;
            let outcome: DeliveryOutcome = 'drop';
            if (this.now() - entry.at < 7 * 86400000 && entry.attempts < 6) {
                try {
                    outcome = await this.deliver(entry.payload);
                } catch {
                    outcome = 'retry';
                }
            }
            if (this.stopped || generation !== this.generation) return;
            if (outcome !== 'retry') this.entries = this.entries.filter((item) => item !== entry);
            else {
                entry.attempts++;
                entry.nextAt = this.now() + Math.min(3600000, 5000 * 2 ** entry.attempts);
            }
            this.save();
        }
    }
    stop(): void {
        this.stopped = true;
        this.generation++;
        clearTimeout(this.timer);
    }
    clear(): void {
        this.stop();
        this.entries = [];
        this.save();
    }
}
