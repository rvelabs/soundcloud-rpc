export function installAudioFeatureCapture(): void {
    const page = window as typeof window & {
        __waveAudioInstalled?: boolean;
        __waveMediaEndState?: { active: boolean; currentPath?: string; analysisReadyPath?: string };
        soundcloudAPI?: { sendAudioFeatures: (features: unknown) => void };
    };
    if (page.__waveAudioInstalled) return;
    page.__waveAudioInstalled = true;
    const seen: WeakRef<HTMLMediaElement>[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    const cached = () =>
        Boolean(
            page.__waveMediaEndState?.currentPath &&
                page.__waveMediaEndState.analysisReadyPath === page.__waveMediaEndState.currentPath,
        );
    const wake = () => {
        if (!timer && page.__waveMediaEndState?.active && !cached())
            timer = setInterval(() => {
                void sample().catch(() => {});
            }, 1000);
    };
    const stop = () => {
        clearInterval(timer);
        timer = undefined;
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        const result = originalPlay.call(this);
        if (!seen.some((reference) => reference.deref() === this)) {
            seen.push(new WeakRef(this));
            if (seen.length > 8) seen.shift();
            this.addEventListener('playing', wake);
        }
        wake();
        return result;
    };
    const connected = new WeakMap<
        HTMLMediaElement,
        {
            source: MediaStreamAudioSourceNode;
            stream: MediaStream;
            url: string;
            analyser: AnalyserNode;
            bytes: Float32Array<ArrayBuffer>;
            spectrum: Float32Array<ArrayBuffer>;
        }
    >();
    const release = (media: HTMLMediaElement) => {
        const nodes = connected.get(media);
        if (!nodes) return;
        nodes.source.disconnect();
        for (const track of nodes.stream.getTracks()) track.stop();
        connected.delete(media);
    };
    let context: AudioContext | undefined;
    let connecting = false;
    let path = '';
    let sampledSeconds = 0;
    let previousPosition = 0;
    const sample = async () => {
        for (const reference of seen) {
            const media = reference.deref();
            if (
                media &&
                (!page.__waveMediaEndState?.active || cached() || media.paused || media.ended || media.mediaKeys)
            )
                release(media);
        }
        if (!page.__waveMediaEndState?.active || cached()) {
            stop();
            if (context?.state === 'running') void context.suspend().catch(() => {});
            return;
        }
        if (connecting) return;
        const media = [
            ...seen.map((reference) => reference.deref()),
            ...Array.from(document.querySelectorAll('audio,video')),
        ].find(
            (item): item is HTMLMediaElement =>
                item instanceof HTMLMediaElement && !item.paused && item.readyState >= 3 && !item.mediaKeys,
        );
        if (!media) {
            stop();
            if (context?.state === 'running') void context.suspend().catch(() => {});
            return;
        }
        if (!seen.some((reference) => reference.deref() === media)) {
            seen.push(new WeakRef(media));
            if (seen.length > 8) seen.shift();
            media.addEventListener('playing', wake);
        }
        const badge = document.querySelector<HTMLAnchorElement>('.playbackSoundBadge__titleLink');
        if (!badge) return;
        let currentPath: string;
        try {
            currentPath = new URL(badge.href).pathname;
            const source = new URL(media.currentSrc || media.src, location.href);
            if (source.origin !== location.origin && media.crossOrigin !== 'anonymous') return;
            if (!['https:', 'blob:'].includes(source.protocol)) return;
        } catch {
            return;
        }
        if (path !== currentPath) {
            path = currentPath;
            sampledSeconds = 0;
            previousPosition = media.currentTime;
        }
        if (sampledSeconds >= 90) {
            stop();
            release(media);
            if (context?.state === 'running') void context.suspend().catch(() => {});
            return;
        }
        let nodes = connected.get(media);
        if (
            nodes &&
            (nodes.url !== media.currentSrc ||
                nodes.stream.getAudioTracks().every((track) => track.readyState === 'ended'))
        ) {
            release(media);
            nodes = undefined;
        }
        if (!nodes) {
            const capture = (media as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
            if (!capture) return;
            connecting = true;
            try {
                context ??= new AudioContext();
                if (context.state !== 'running') await context.resume();
                if (
                    context.state !== 'running' ||
                    media.paused ||
                    media.mediaKeys ||
                    cached() ||
                    !page.__waveMediaEndState?.active
                )
                    return;
                const analyser = context.createAnalyser();
                analyser.fftSize = 1024;
                analyser.smoothingTimeConstant = 0.6;
                const stream = capture.call(media);
                if (!stream.getAudioTracks().length) {
                    for (const track of stream.getTracks()) track.stop();
                    return;
                }
                let source: MediaStreamAudioSourceNode;
                try {
                    source = context.createMediaStreamSource(stream);
                } catch (error) {
                    for (const track of stream.getTracks()) track.stop();
                    throw error;
                }
                source.connect(analyser);
                nodes = {
                    source,
                    stream,
                    url: media.currentSrc,
                    analyser,
                    bytes: new Float32Array(analyser.fftSize),
                    spectrum: new Float32Array(analyser.frequencyBinCount),
                };
                connected.set(media, nodes);
            } catch {
                return;
            } finally {
                connecting = false;
            }
        }
        const delta = media.currentTime - previousPosition;
        previousPosition = media.currentTime;
        if (delta <= 0 || delta > 3) return;
        sampledSeconds += delta;
        nodes.analyser.getFloatTimeDomainData(nodes.bytes);
        nodes.analyser.getFloatFrequencyData(nodes.spectrum);
        let squares = 0,
            bass = 0,
            mid = 0,
            treble = 0;
        for (const value of nodes.bytes) squares += value * value;
        const binHz = nodes.analyser.context.sampleRate / nodes.analyser.fftSize;
        for (let index = 1; index < nodes.spectrum.length; index++) {
            const power = 10 ** (nodes.spectrum[index] / 10);
            const hz = index * binHz;
            if (hz < 250) bass += power;
            else if (hz < 4000) mid += power;
            else treble += power;
        }
        const total = bass + mid + treble;
        if (!total || !Number.isFinite(total)) return;
        page.soundcloudAPI?.sendAudioFeatures({
            path,
            energy: Math.min(1, Math.sqrt(squares / nodes.bytes.length)),
            bass: bass / total,
            mid: mid / total,
            treble: treble / total,
            source: 'media-element-v1',
            sampleSeconds: sampledSeconds,
        });
    };
    const onState = () => {
        if (page.__waveMediaEndState?.active && !cached()) wake();
        else {
            stop();
            void sample().catch(() => {});
        }
    };
    page.addEventListener('__soundcloudWaveMediaState', onState);
    page.addEventListener('pageshow', wake);
    wake();
    window.addEventListener('pagehide', (event) => {
        stop();
        for (const reference of seen) {
            const media = reference.deref();
            if (media) release(media);
        }
        if (event.persisted) void context?.suspend().catch(() => {});
        else {
            page.removeEventListener('__soundcloudWaveMediaState', onState);
            page.removeEventListener('pageshow', wake);
            void context?.close().catch(() => {});
        }
    });
}
