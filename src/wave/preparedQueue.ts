export class PreparedQueue<
    T extends {
        url: string;
    },
> {
    private items: T[] = [];
    private pending: Promise<void> | null = null;
    private generation = 0;
    private waiters = new Set<() => void>();
    private wake(): void {
        for (const wake of [...this.waiters]) wake();
    }
    clear(): void {
        this.generation++;
        this.items = [];
        this.pending = null;
        this.wake();
    }
    get length(): number {
        return this.items.length;
    }
    prepare(load: (publish: (items: T[]) => void) => Promise<T[]>, excluded: string[] = []): Promise<void> {
        if (this.pending || this.items.length >= 3) return this.pending || Promise.resolve();
        const generation = this.generation;
        const existing = new Set([...this.items.map((item) => item.url), ...excluded]);
        const publish = (candidates: T[]) => {
            if (this.items.length >= 3) return;
            if (generation !== this.generation) return;
            for (const candidate of candidates) {
                if (!candidate.url || existing.has(candidate.url)) continue;
                this.items.push(candidate);
                existing.add(candidate.url);
                if (this.items.length >= 3) break;
            }
            this.wake();
        };
        const task = load(publish)
            .then(publish)
            .finally(() => {
                if (this.pending === task) this.pending = null;
                this.wake();
            });
        this.pending = task;
        return task;
    }
    async take(shuffle = false): Promise<T | undefined> {
        if (this.items.length)
            return this.items.splice(shuffle ? Math.floor(Math.random() * this.items.length) : 0, 1)[0];
        const generation = this.generation;
        while (!this.items.length && this.pending && generation === this.generation) {
            await new Promise<void>((resolve) => {
                const wake = () => {
                    this.waiters.delete(wake);
                    resolve();
                };
                this.waiters.add(wake);
            });
        }
        if (generation !== this.generation) return undefined;
        return this.items.splice(shuffle ? Math.floor(Math.random() * this.items.length) : 0, 1)[0];
    }
}
