export type TransitionReason = 'start' | 'user' | 'native-user' | 'finish' | 'error';
export class PlaybackCoordinator {
    private task?: Promise<void>;
    private epoch = 0;
    get pending(): boolean {
        return Boolean(this.task);
    }
    constructor(
        private player: {
            active: () => boolean;
            nativeReady: () => boolean;
            advanceNative: (reason: TransitionReason) => Promise<boolean>;
            select: (reason: TransitionReason) => Promise<void>;
        },
    ) {}
    request(reason: TransitionReason): Promise<void> {
        if (!this.player.active()) return Promise.resolve();
        if (this.task) return this.task;
        const epoch = this.epoch;
        const task = Promise.resolve().then(async () => {
            if (epoch !== this.epoch || !this.player.active()) return;
            if (this.player.nativeReady() && ['user', 'native-user', 'finish', 'error'].includes(reason)) {
                if (await this.player.advanceNative(reason)) return;
                if (epoch !== this.epoch || !this.player.active()) return;
            }
            await this.player.select(reason === 'native-user' ? 'user' : reason);
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
