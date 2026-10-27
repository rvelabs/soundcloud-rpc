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
    const prepared = new WeakMap<HTMLMediaElement, string>();
    const attached = new WeakSet<HTMLMediaElement>();
    const prepare = (media: HTMLMediaElement) => {
        if (!page.__waveMediaEndState?.active || !Number.isFinite(media.duration) || media.duration < 30) return;
        const source = media.currentSrc || media.src;
        if (media.duration - media.currentTime > 15) {
            prepared.delete(media);
            return;
        }
        if (prepared.get(media) === source) return;
        prepared.set(media, source);
        page.dispatchEvent(new Event('__soundcloudWavePrepareNext'));
    };
    const attach = (media: HTMLMediaElement) => {
        if (attached.has(media)) return;
        attached.add(media);
        media.addEventListener('timeupdate', () => prepare(media), true);
        media.addEventListener(
            'ended',
            (event) => {
                if (!page.__waveMediaEndState?.active || page.__waveMediaEndState.queueReady) return;
                event.stopImmediatePropagation();
                page.dispatchEvent(new Event('__soundcloudWaveMediaEnded'));
            },
            true,
        );
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        attach(this);
        return originalPlay.call(this);
    };
    for (const element of document.querySelectorAll('audio,video'))
        if (element instanceof HTMLMediaElement) attach(element);
}
