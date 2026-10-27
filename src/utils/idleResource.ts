export class IdleResource<T> {
    private value?: T;
    private users = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    constructor(
        private create: () => T,
        private destroy: (value: T) => void,
        private idleMs = 30000,
    ) {}
    async use<R>(run: (value: T) => Promise<R>): Promise<R> {
        if (this.disposed) throw new Error('Resource disposed');
        clearTimeout(this.timer);
        const value = (this.value ??= this.create());
        this.users++;
        try {
            return await run(value);
        } finally {
            this.users--;
            if (!this.disposed && this.users === 0) {
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
