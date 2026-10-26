export class WindowTasks {
    private timers = new Set<ReturnType<typeof setTimeout>>();
    private disposed = false;
    constructor(private alive: () => boolean) {}
    defer(task: () => void, delay: number): void {
        if (this.disposed) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (!this.disposed && this.alive()) task();
        }, delay);
        this.timers.add(timer);
    }
    dispose(): void {
        this.disposed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }
}
