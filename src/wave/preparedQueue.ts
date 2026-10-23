export class PreparedQueue<
    T extends {
        url: string;
    },
> {
    private items: T[] = [];
    private pending: Promise<void> | null = null;
    private generation = 0;
    clear(): void {
        this.generation++;
        this.items = [];
        this.pending = null;
    }
    get length(): number {
        return this.items.length;
    }
    prepare(load: () => Promise<T[]>, excluded: string[] = []): Promise<void> {
        if (this.pending || this.items.length >= 3) return this.pending || Promise.resolve();
        const generation = this.generation;
        const existing = new Set([...this.items.map((item) => item.url), ...excluded]);
        const task = load()
            .then((candidates) => {
                if (generation !== this.generation) return;
                for (const candidate of candidates) {
                    if (!candidate.url || existing.has(candidate.url)) continue;
                    this.items.push(candidate);
                    existing.add(candidate.url);
                    if (this.items.length >= 3) break;
                }
            })
            .finally(() => {
                if (this.pending === task) this.pending = null;
            });
        this.pending = task;
        return task;
    }
    async take(shuffle = false): Promise<T | undefined> {
        if (this.items.length)
            return this.items.splice(shuffle ? Math.floor(Math.random() * this.items.length) : 0, 1)[0];
        if (this.pending) await this.pending;
        return this.items.splice(shuffle ? Math.floor(Math.random() * this.items.length) : 0, 1)[0];
    }
}
