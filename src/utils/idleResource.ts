export class IdleResource<T> {
    private value?: T;
    private users = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private tail: Promise<void> = Promise.resolve();
    constructor(
        private create: () => T,
        private destroy: (value: T) => void,
        private idleMs = 30000,
        private quiesce?: (value: T) => Promise<void>,
    ) {}
    async use<R>(run: (value: T) => Promise<R>): Promise<R> {
        if (this.disposed) throw new Error('Resource disposed');
        clearTimeout(this.timer);
        this.users++;
        const task = this.tail.then(() => {
            if (this.disposed) throw new Error('Resource disposed');
            return run((this.value ??= this.create()));
        });
        this.tail = task.then(
            () => {},
            () => {},
        );
        try {
            return await task;
        } finally {
            this.users--;
            if (!this.disposed && this.users === 0) {
                const value = this.value;
                if (this.quiesce && value !== undefined) {
                    const idle = this.tail.then(async () => {
                        if (!this.disposed && !this.users && this.value === value) await this.quiesce!(value);
                    });
                    this.tail = idle.catch(() => {});
                }
                this.timer = setTimeout(() => this.release(), this.idleMs);
                this.timer.unref?.();
            }
        }
    }
    release(): void {
        if (this.users) return;
        clearTimeout(this.timer);
        const value = this.value;
        this.value = undefined;
        if (value !== undefined) this.destroy(value);
    }
    dispose(): void {
        this.disposed = true;
        clearTimeout(this.timer);
        const value = this.value;
        this.value = undefined;
        if (value !== undefined) this.destroy(value);
    }
}
