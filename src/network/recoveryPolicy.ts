export type RecoveryResult = 'direct' | 'relay' | 'unavailable' | 'deferred' | 'cooldown';
export class RecoveryPolicy {
    private task?: Promise<RecoveryResult>;
    private nextAttempt = 0;
    constructor(
        private actions: {
            direct: () => Promise<boolean>;
            relay: () => Promise<boolean>;
            activate: () => Promise<void>;
            playing: () => Promise<boolean>;
        },
        private now = Date.now,
    ) {}
    retryDelay(): number {
        return Math.max(0, this.nextAttempt - this.now());
    }
    recover(): Promise<RecoveryResult> {
        if (this.task) return this.task;
        if (this.now() < this.nextAttempt) return Promise.resolve('cooldown');
        const task = this.run();
        this.task = task;
        void task
            .finally(() => {
                if (this.task === task) this.task = undefined;
            })
            .catch(() => {});
        return task;
    }
    private async run(): Promise<RecoveryResult> {
        if (await this.actions.playing()) return 'deferred';
        this.nextAttempt = this.now() + 120000;
        if (await this.actions.direct()) return 'direct';
        if (!(await this.actions.relay())) return 'unavailable';
        if (await this.actions.playing()) return 'deferred';
        await this.actions.activate();
        return 'relay';
    }
}
