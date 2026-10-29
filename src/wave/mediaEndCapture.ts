export function installWaveMediaEndCapture(): void {
    const page = window as typeof window & {
        __waveMediaEndInstalled?: boolean;
        __waveMediaEndSnapshot?: () => unknown;
        __waveMediaEndState?: {
            active: boolean;
            queueReady: boolean;
            currentPath?: string;
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
    const paths = new WeakMap<HTMLMediaElement, { path: string; source: string; position: number }>();
    const tracked: WeakRef<HTMLMediaElement>[] = [];
    let endedEvents = 0;
    let active: WeakRef<HTMLMediaElement> | undefined;
    const remember = (media: HTMLMediaElement) => {
        const source = media.currentSrc || media.src;
        const previous = paths.get(media);
        if (previous && previous.source === source && media.currentTime + 0.25 >= previous.position) return;
        const path = document.querySelector<HTMLAnchorElement>('.playbackSoundBadge__titleLink')?.pathname;
        if (path) paths.set(media, { path, source, position: media.currentTime });
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
        tracked.push(new WeakRef(media));
        if (tracked.length > 8) tracked.shift();
        media.addEventListener('playing', () => remember(media), true);
        media.addEventListener(
            'timeupdate',
            () => {
                if (!page.__waveMediaEndState?.active) return;
                remember(media);
                const binding = paths.get(media);
                if (binding) {
                    if (
                        active?.deref() === media &&
                        media.currentTime > 0 &&
                        media.currentTime < Math.min(5, media.duration / 2)
                    ) {
                        const path = document.querySelector<HTMLAnchorElement>(
                            '.playbackSoundBadge__titleLink',
                        )?.pathname;
                        if (path && path === page.__waveMediaEndState.currentPath) binding.path = path;
                    }
                    binding.position = media.currentTime;
                }
                prepare(media);
            },
            true,
        );
        media.addEventListener(
            'error',
            () => {
                if (page.__waveMediaEndState?.active && media.error && media.error.code !== 1)
                    page.dispatchEvent(
                        new CustomEvent('__soundcloudWaveMediaError', { detail: paths.get(media)?.path }),
                    );
            },
            true,
        );
        media.addEventListener(
            'ended',
            (event) => {
                if (!page.__waveMediaEndState?.active) return;
                endedEvents++;
                if (!page.__waveMediaEndState.queueReady) event.stopImmediatePropagation();
                page.dispatchEvent(new CustomEvent('__soundcloudWaveMediaEnded', { detail: paths.get(media)?.path }));
            },
            true,
        );
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        attach(this);
        active = new WeakRef(this);
        remember(this);
        return originalPlay.call(this);
    };
    for (const element of document.querySelectorAll('audio,video'))
        if (element instanceof HTMLMediaElement) attach(element);
    page.__waveMediaEndSnapshot = () => ({
        endedEvents,
        media: tracked.flatMap((reference) => {
            const media = reference.deref();
            return media
                ? [
                      {
                          path: paths.get(media)?.path,
                          active: active?.deref() === media,
                          position: media.currentTime,
                          duration: media.duration,
                          paused: media.paused,
                          ended: media.ended,
                          readyState: media.readyState,
                          errorCode: media.error?.code,
                      },
                  ]
                : [];
        }),
    });
}
