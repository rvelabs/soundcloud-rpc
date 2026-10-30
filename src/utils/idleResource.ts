export class IdleResource<T> {
    private value?: T;
    private users = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private clearTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private created = 0;
    private reused = 0;
    private released = 0;
    private tail: Promise<void> = Promise.resolve();
    constructor(
        private create: () => T,
        private destroy: (value: T) => void,
        private idleMs: number | (() => number) = 30000,
        private quiesce?: (value: T) => Promise<void>,
        private quiesceDelay = 0,
    ) {}
    async use<R>(run: (value: T) => Promise<R>): Promise<R> {
        if (this.disposed) throw new Error('Resource disposed');
        if (!this.users && typeof this.idleMs === 'function' && this.idleMs() <= 0) this.release();
        clearTimeout(this.timer);
        clearTimeout(this.clearTimer);
        this.users++;
        const task = this.tail.then(() => {
            if (this.disposed) throw new Error('Resource disposed');
            if (this.value === undefined) {
                this.value = this.create();
                this.created++;
            } else this.reused++;
            return run(this.value);
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
                    const clear = () => {
                        const idle = this.tail.then(async () => {
                            if (!this.disposed && !this.users && this.value === value) await this.quiesce!(value);
                        });
                        this.tail = idle.catch(() => {});
                    };
                    if (this.quiesceDelay) {
                        this.clearTimer = setTimeout(clear, this.quiesceDelay);
                        this.clearTimer.unref?.();
                    } else clear();
                }
                this.timer = setTimeout(
                    () => this.release(),
                    typeof this.idleMs === 'function' ? this.idleMs() : this.idleMs,
                );
                this.timer.unref?.();
            }
        }
    }
    release(): void {
        if (this.users) return;
        clearTimeout(this.timer);
        clearTimeout(this.clearTimer);
        const value = this.value;
        this.value = undefined;
        if (value !== undefined) {
            this.released++;
            this.destroy(value);
        }
    }
    diagnostics(): object {
        return {
            created: this.created,
            reused: this.reused,
            released: this.released,
            busy: this.users,
            retained: this.value !== undefined,
        };
    }
    dispose(): void {
        this.disposed = true;
        clearTimeout(this.timer);
        clearTimeout(this.clearTimer);
        const value = this.value;
        this.value = undefined;
        if (value !== undefined) this.destroy(value);
    }
}
