export function installWaveMediaEndCapture(): void {
    const page = window as typeof window & {
        __waveMediaEndInstalled?: boolean;
        __waveMediaEndState?: {
            active: boolean;
            queueReady: boolean;
            expectedPath?: string;
            handoffPending?: boolean;
            protectedUntil?: number;
        };
    };
    if (page.__waveMediaEndInstalled) return;
    page.__waveMediaEndInstalled = true;
    page.__waveMediaEndState = { active: false, queueReady: false };
    const attached = new WeakSet<HTMLMediaElement>();
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        const state = page.__waveMediaEndState;
        if (state?.active && !state.queueReady && (state.handoffPending || Date.now() < (state.protectedUntil || 0))) {
            let badgePath = '';
            try {
                badgePath = new URL(
                    (document.querySelector('.playbackSoundBadge__titleLink') as HTMLAnchorElement)?.href,
                ).pathname;
            } catch {}
            if (!state.expectedPath || badgePath !== state.expectedPath) return Promise.resolve();
            state.handoffPending = false;
            state.protectedUntil = Date.now() + 3000;
        }
        if (!attached.has(this)) {
            attached.add(this);
            let handoffRequested = false;
            this.addEventListener(
                'timeupdate',
                (event) => {
                    const duration = this.duration;
                    if (!Number.isFinite(duration) || duration < 30) return;
                    const remaining = duration - this.currentTime;
                    if (remaining > 2) handoffRequested = false;
                    if (
                        handoffRequested ||
                        remaining > 1 ||
                        !page.__waveMediaEndState?.active ||
                        page.__waveMediaEndState.queueReady
                    )
                        return;
                    handoffRequested = true;
                    page.__waveMediaEndState.handoffPending = true;
                    event.stopImmediatePropagation();
                    this.pause();
                    page.dispatchEvent(new Event('__soundcloudWaveMediaEnded'));
                },
                true,
            );
            this.addEventListener(
                'ended',
                (event) => {
                    if (!page.__waveMediaEndState?.active || page.__waveMediaEndState.queueReady) return;
                    page.__waveMediaEndState.handoffPending = true;
                    event.stopImmediatePropagation();
                    page.dispatchEvent(new Event('__soundcloudWaveMediaEnded'));
                },
                true,
            );
        }
        return originalPlay.call(this);
    };
}
