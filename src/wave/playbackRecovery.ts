export class EndedPlaybackRecovery {
    private timer?: ReturnType<typeof setTimeout>;
    private epoch = 0;
    constructor(
        private player: {
            current: () => string | undefined;
            ended: (url: string) => Promise<boolean>;
            advance: () => Promise<void>;
            failed: (error: unknown, attempt: number) => void;
        },
        private delays = [2000, 5000, 15000],
    ) {}
    cancel(): void {
        this.epoch++;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    request(): Promise<void> {
        this.cancel();
        const url = this.player.current();
        return url ? this.attempt(url, this.epoch, 0) : Promise.resolve();
    }
    private async attempt(url: string, epoch: number, attempt: number): Promise<void> {
        if (epoch !== this.epoch || this.player.current() !== url) return;
        try {
            await this.player.advance();
        } catch (error) {
            if (epoch !== this.epoch || this.player.current() !== url) return;
            this.player.failed(error, attempt);
            if (attempt >= this.delays.length) return;
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void (async () => {
                    if (epoch !== this.epoch || this.player.current() !== url) return;
                    if (!(await this.player.ended(url))) return;
                    await this.attempt(url, epoch, attempt + 1);
                })().catch((failure) => this.player.failed(failure, attempt + 1));
            }, this.delays[attempt]);
            this.timer.unref?.();
        }
    }
}
