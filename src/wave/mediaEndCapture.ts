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
    const reported = new WeakMap<HTMLMediaElement, string>();
    const progress = new WeakMap<HTMLMediaElement, { source: string }>();
    const confirmed = new WeakMap<HTMLMediaElement, string>();
    const manualPause = new WeakSet<HTMLMediaElement>();
    let endedEvents = 0;
    let recoveredEvents = 0;
    let terminalPauseEvents = 0;
    let active: WeakRef<HTMLMediaElement> | undefined;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let suspended = false;
    const cancelRecovery = () => {
        clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
    };
    const terminal = (media: HTMLMediaElement) => {
        if (manualPause.has(media)) return false;
        if (media.ended) return true;
        const last = progress.get(media);
        return Boolean(
            media.paused &&
                !media.seeking &&
                !media.error &&
                !media.loop &&
                Number.isFinite(media.duration) &&
                media.duration > 0 &&
                Math.abs(media.duration - media.currentTime) <= 0.05 &&
                (confirmed.get(media) === (media.currentSrc || media.src) ||
                    (last && last.source === (media.currentSrc || media.src))),
        );
    };
    const notePause = (force = false) => {
        if (!page.__waveMediaEndState?.active) return;
        const media = active?.deref();
        if (!media || (!force && (media.paused || media.ended))) return;
        manualPause.add(media);
        confirmed.delete(media);
        cancelRecovery();
        if (!force)
            void Promise.resolve().then(() => {
                if (!media.paused && !media.ended) {
                    manualPause.delete(media);
                    armRecovery(media);
                }
            });
    };
    const onInput = (event: Event) => {
        const target = event.target as Element | null;
        if (event.type === 'keydown') {
            const keyboard = event as KeyboardEvent;
            if (keyboard.ctrlKey || keyboard.altKey || keyboard.metaKey) return;
            if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
            const key = String(keyboard.key).toLowerCase();
            if ([' ', 'spacebar', 'k', 'mediapause', 'mediaplaypause', 'mediastop'].includes(key))
                notePause(key === 'mediapause' || key === 'mediastop');
        } else if (target?.closest?.('.playControls__play')) notePause();
    };
    page.addEventListener('click', onInput, true);
    page.addEventListener('keydown', onInput, true);
    const mediaSession = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (mediaSession) {
        const setHandler = mediaSession.setActionHandler;
        mediaSession.setActionHandler = function (action, handler) {
            return setHandler.call(
                this,
                action,
                (action === 'pause' || action === 'stop') && handler
                    ? (details) => {
                          notePause(true);
                          handler(details);
                      }
                    : handler,
            );
        };
    }
    const armRecovery = (media: HTMLMediaElement) => {
        if (active?.deref() !== media) return;
        cancelRecovery();
        if (
            suspended ||
            !page.__waveMediaEndState?.active ||
            !Number.isFinite(media.duration) ||
            media.duration <= 0 ||
            (media.paused && !terminal(media)) ||
            manualPause.has(media) ||
            media.seeking ||
            media.error ||
            media.duration - media.currentTime > 2
        )
            return;
        const source = media.currentSrc || media.src;
        if (reported.get(media) === source) return;
        const delay = Math.max(0, media.duration - media.currentTime) / Math.max(0.1, media.playbackRate || 1);
        recoveryTimer = setTimeout(
            () => {
                recoveryTimer = undefined;
                const state = page.__waveMediaEndState;
                const path = paths.get(media)?.path;
                if (
                    suspended ||
                    !state?.active ||
                    active?.deref() !== media ||
                    !terminal(media) ||
                    media.seeking ||
                    media.error ||
                    (media.currentSrc || media.src) !== source ||
                    reported.get(media) === source ||
                    !path ||
                    state.currentPath !== path ||
                    (state.expectedPath && state.expectedPath !== path)
                )
                    return;
                reported.set(media, source);
                confirmed.set(media, source);
                recoveredEvents++;
                if (!media.ended) terminalPauseEvents++;
                page.dispatchEvent(new CustomEvent('__soundcloudWaveMediaEnded', { detail: path }));
            },
            delay * 1000 + 500,
        );
    };
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
        media.addEventListener(
            'playing',
            () => {
                manualPause.delete(media);
                confirmed.delete(media);
                if (!media.paused && !media.ended) progress.set(media, { source: media.currentSrc || media.src });
                if (!media.ended) reported.delete(media);
                remember(media);
                armRecovery(media);
            },
            true,
        );
        for (const type of ['pause', 'seeked', 'ratechange', 'durationchange'])
            media.addEventListener(type, () => armRecovery(media), true);
        media.addEventListener(
            'seeking',
            () => {
                confirmed.delete(media);
                if (active?.deref() === media) cancelRecovery();
            },
            true,
        );
        media.addEventListener(
            'timeupdate',
            () => {
                if (!page.__waveMediaEndState?.active) return;
                remember(media);
                const binding = paths.get(media);
                if (binding) {
                    const delta = media.currentTime - binding.position;
                    if (!media.paused && !media.seeking && delta > 0 && delta <= 3)
                        progress.set(media, { source: media.currentSrc || media.src });
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
                armRecovery(media);
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
                if (manualPause.has(media)) {
                    if (active?.deref() === media) cancelRecovery();
                    event.stopImmediatePropagation();
                    return;
                }
                endedEvents++;
                reported.set(media, media.currentSrc || media.src);
                if (active?.deref() === media) cancelRecovery();
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
        manualPause.delete(this);
        confirmed.delete(this);
        if (this.paused || this.ended) progress.delete(this);
        if (!this.ended) reported.delete(this);
        remember(this);
        return originalPlay.call(this);
    };
    for (const element of document.querySelectorAll('audio,video'))
        if (element instanceof HTMLMediaElement) attach(element);
    const sync = () => {
        const media = active?.deref();
        if (!page.__waveMediaEndState?.active) {
            cancelRecovery();
            return;
        }
        if (!media) return;
        const binding = paths.get(media);
        const current = page.__waveMediaEndState.currentPath;
        if (
            binding &&
            current &&
            !terminal(media) &&
            document.querySelector<HTMLAnchorElement>('.playbackSoundBadge__titleLink')?.pathname === current
        )
            binding.path = current;
        armRecovery(media);
    };
    page.addEventListener('__soundcloudWaveMediaState', sync);
    page.addEventListener('pagehide', () => {
        suspended = true;
        cancelRecovery();
    });
    page.addEventListener('pageshow', () => {
        suspended = false;
        sync();
    });
    page.__waveMediaEndSnapshot = () => ({
        endedEvents,
        recoveredEvents,
        terminalPauseEvents,
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
                          terminal: terminal(media),
                          manualPause: manualPause.has(media),
                          seeking: media.seeking,
                          loop: media.loop,
                          readyState: media.readyState,
                          errorCode: media.error?.code,
                      },
                  ]
                : [];
        }),
    });
}
