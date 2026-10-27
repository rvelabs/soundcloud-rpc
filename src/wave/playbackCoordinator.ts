export type TransitionReason = 'start' | 'user' | 'finish' | 'error';
export class PlaybackCoordinator {
    private task?: Promise<void>;
    private epoch = 0;
    constructor(
        private player: {
            active: () => boolean;
            nativeReady: () => boolean;
            advanceNative: () => Promise<void>;
            select: (reason: TransitionReason) => Promise<void>;
        },
    ) {}
    request(reason: TransitionReason): Promise<void> {
        if (!this.player.active()) return Promise.resolve();
        if (this.task) return this.task;
        const epoch = this.epoch;
        const task = Promise.resolve().then(async () => {
            if (epoch !== this.epoch || !this.player.active()) return;
            if (this.player.nativeReady() && (reason === 'user' || reason === 'finish')) {
                if (reason === 'user') await this.player.advanceNative();
                return;
            }
            await this.player.select(reason);
        });
        this.task = task;
        const clear = () => {
            if (this.task === task) this.task = undefined;
        };
        void task.then(clear, clear);
        return task;
    }
    invalidate(): void {
        this.epoch++;
        this.task = undefined;
    }
}
