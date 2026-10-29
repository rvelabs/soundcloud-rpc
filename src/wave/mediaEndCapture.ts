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
    const paths = new WeakMap<HTMLMediaElement, string>();
    const remember = (media: HTMLMediaElement) => {
        const path = document.querySelector<HTMLAnchorElement>('.playbackSoundBadge__titleLink')?.pathname;
        if (path) paths.set(media, path);
    };
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
        media.addEventListener('playing', () => remember(media), true);
        media.addEventListener(
            'timeupdate',
            () => {
                if (!paths.has(media)) remember(media);
                prepare(media);
            },
            true,
        );
        media.addEventListener(
            'error',
            () => {
                if (page.__waveMediaEndState?.active && media.error && media.error.code !== 1)
                    page.dispatchEvent(new CustomEvent('__soundcloudWaveMediaError', { detail: paths.get(media) }));
            },
            true,
        );
        media.addEventListener(
            'ended',
            (event) => {
                if (!page.__waveMediaEndState?.active) return;
                if (!page.__waveMediaEndState.queueReady) event.stopImmediatePropagation();
                page.dispatchEvent(new CustomEvent('__soundcloudWaveMediaEnded', { detail: paths.get(media) }));
            },
            true,
        );
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        attach(this);
        remember(this);
        return originalPlay.call(this);
    };
    for (const element of document.querySelectorAll('audio,video'))
        if (element instanceof HTMLMediaElement) attach(element);
}
