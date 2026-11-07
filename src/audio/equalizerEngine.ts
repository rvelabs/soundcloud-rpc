import type { EqualizerSettings } from './equalizerSettings';

export function installEqualizerEngine(): void {
    const page = window as typeof window & {
        __soundcloudEqualizer?: {
            set: (value: EqualizerSettings) => void;
            snapshot: () => object;
            analysisTap: (media: HTMLMediaElement) => { analyser: AnalyserNode; release: () => void } | undefined;
        };
    };
    if (page.__soundcloudEqualizer) return;
    const shieldKeys = (event: KeyboardEvent) => {
        if (
            event.key !== 'Escape' &&
            event.composedPath().some((node) => node instanceof Element && node.id === 'sc-equalizer')
        )
            event.stopImmediatePropagation();
    };
    const keyEvents = ['keydown', 'keypress', 'keyup'] as const;
    for (const type of keyEvents) page.addEventListener(type, shieldKeys, true);
    const frequencies = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    let settings: EqualizerSettings = { enabled: false, preset: 'flat', gains: frequencies.map(() => 0), preamp: 0 };
    let context: AudioContext | undefined;
    let input: GainNode;
    let preamp: GainNode;
    let filters: BiquadFilterNode[] = [];
    let probe: BiquadFilterNode;
    let bypass = true;
    let headroom = 0;
    let status = 'off';
    let reason = '';
    let disposed = false;
    let frozen = false;
    let bypassTimer: ReturnType<typeof setTimeout> | undefined;
    const sources = new WeakMap<HTMLMediaElement, { node: MediaElementAudioSourceNode; connected: boolean }>();
    const attached = new WeakSet<HTMLMediaElement>();
    const connecting = new WeakSet<HTMLMediaElement>();
    const seen = new Set<WeakRef<HTMLMediaElement>>();
    type Graph = {
        context: AudioContext;
        preamp: GainNode;
        probe: BiquadFilterNode;
        filters: BiquadFilterNode[];
        headroom: number;
    };
    type Edge = { target: AudioNode; output: number; input: number; processed: boolean };
    type NativeSource = {
        node: MediaElementAudioSourceNode;
        media: WeakRef<HTMLMediaElement>;
        edges: Edge[];
        graph?: Graph;
        timer?: ReturnType<typeof setTimeout>;
    };
    const nativeMedia = new WeakMap<HTMLMediaElement, NativeSource>();
    const nativeNodes = new WeakMap<AudioNode, NativeSource>();
    const nativeRefs = new Set<WeakRef<NativeSource>>();
    const nativeContexts = new WeakSet<AudioContext>();
    const connectNode = AudioNode.prototype.connect as unknown as (
        this: AudioNode,
        target: AudioNode | AudioParam,
        output?: number,
        input?: number,
    ) => AudioNode | undefined;
    const disconnectNode = AudioNode.prototype.disconnect as unknown as (
        this: AudioNode,
        ...args: (AudioNode | AudioParam | number)[]
    ) => void;
    const createSource = AudioContext.prototype.createMediaElementSource;
    let creatingOwned = false;
    const wire = (source: AudioNode, target: AudioNode | AudioParam, output = 0, input = 0) =>
        target instanceof AudioParam
            ? connectNode.call(source, target, output)
            : connectNode.call(source, target, output, input);
    const responseHz = new Float32Array(256);
    const magnitudes = new Float32Array(256);
    const phases = new Float32Array(256);
    const totals = new Float32Array(256);
    const currentNative = () =>
        [...seen]
            .map((ref) => ref.deref())
            .flatMap((media) => (media && nativeMedia.has(media) ? [nativeMedia.get(media)!] : []))[0];
    const snapshot = () => {
        const native = currentNative();
        const contextState = native?.node.context.state || context?.state || 'none';
        return {
            revision: 2,
            enabled: settings.enabled,
            status: status === 'active' && contextState !== 'running' ? 'waiting' : status,
            reason: status === 'active' && contextState === 'suspended' ? 'context-suspended' : reason,
            mode: native ? 'native' : context ? 'direct' : 'none',
            headroomDb: native?.graph?.headroom ?? headroom,
            contextState,
            attached: [...seen].filter((ref) => {
                const media = ref.deref();
                return media && (sources.has(media) || nativeMedia.has(media));
            }).length,
        };
    };
    const notify = () => page.dispatchEvent(new CustomEvent('soundcloud-equalizer-status', { detail: snapshot() }));
    const live = () => {
        const media: HTMLMediaElement[] = [];
        for (const ref of seen) {
            const item = ref.deref();
            if (item) media.push(item);
            else seen.delete(ref);
        }
        return media;
    };
    const active = () => live().some((media) => sources.get(media)?.connected && !media.paused && !media.ended);
    const settle = () => {
        if (!active() && context?.state === 'running')
            void context
                .suspend()
                .then(notify)
                .catch(() => {});
    };
    const makeGraph = (audioContext: AudioContext): Graph => {
        const graph: Graph = {
            context: audioContext,
            preamp: audioContext.createGain(),
            probe: audioContext.createBiquadFilter(),
            filters: [],
            headroom: 0,
        };
        graph.filters = frequencies.map((frequency, index) => {
            const filter = audioContext.createBiquadFilter();
            filter.type = index === 0 ? 'lowshelf' : index === 9 ? 'highshelf' : 'peaking';
            filter.frequency.value = Math.min(frequency, audioContext.sampleRate * 0.49);
            filter.Q.value = 1.4;
            return filter;
        });
        wire(graph.preamp, graph.filters[0]);
        graph.filters.forEach((filter, index) => {
            if (graph.filters[index + 1]) wire(filter, graph.filters[index + 1]);
        });
        return graph;
    };
    const configure = (graph: Graph, wet: boolean) => {
        const audioContext = graph.context;
        for (let index = 0; index < responseHz.length; index++)
            responseHz[index] =
                20 * (Math.min(22000, audioContext.sampleRate * 0.49) / 20) ** (index / (responseHz.length - 1));
        totals.fill(0);
        const ramp = (parameter: AudioParam, value: number) => {
            parameter.cancelScheduledValues(audioContext.currentTime);
            parameter.setTargetAtTime(value, audioContext.currentTime, 0.015);
        };
        graph.filters.forEach((filter, index) => {
            const gain = wet ? settings.gains[index] : 0;
            graph.probe.type = filter.type;
            graph.probe.frequency.value = filter.frequency.value;
            graph.probe.Q.value = filter.Q.value;
            graph.probe.gain.value = gain;
            graph.probe.getFrequencyResponse(responseHz, magnitudes, phases);
            for (let bin = 0; bin < totals.length; bin++)
                totals[bin] += 20 * Math.log10(Math.max(1e-8, magnitudes[bin]));
            ramp(filter.gain, gain);
        });
        graph.headroom = wet ? Math.max(0, ...totals) : 0;
        ramp(graph.preamp.gain, wet ? 10 ** ((settings.preamp - graph.headroom) / 20) : 1);
        return graph.headroom;
    };
    const moveNativeEdges = (source: NativeSource, wet: boolean) => {
        if (wet) source.graph ??= makeGraph(source.node.context as AudioContext);
        const graph = source.graph;
        if (!graph) return;
        for (const edge of source.edges) {
            if (edge.processed === wet) continue;
            if (wet) {
                disconnectNode.call(source.node, edge.target, edge.output, edge.input);
                wire(source.node, graph.preamp, edge.output);
                wire(graph.filters[9], edge.target, 0, edge.input);
            } else {
                disconnectNode.call(graph.filters[9], edge.target, 0, edge.input);
                wire(source.node, edge.target, edge.output, edge.input);
            }
            edge.processed = wet;
        }
        if (!wet) {
            try {
                disconnectNode.call(source.node, graph.preamp);
            } catch {}
        }
    };
    const updateNative = (source: NativeSource, immediate = false) => {
        clearTimeout(source.timer);
        const media = source.media.deref();
        const wet =
            (settings.enabled && settings.gains.some((gain) => gain !== 0)) ||
            (settings.enabled && settings.preamp !== 0);
        const processing = Boolean(wet && media && !media.paused && !media.ended && !frozen);
        if (processing && source.edges.length) source.graph ??= makeGraph(source.node.context as AudioContext);
        if (source.graph) configure(source.graph, processing);
        if (processing || immediate || !source.edges.some((edge) => edge.processed))
            moveNativeEdges(source, processing);
        else source.timer = setTimeout(() => moveNativeEdges(source, false), 180);
    };
    const protectNative = (source: NativeSource, immediate = false) => {
        try {
            updateNative(source, immediate);
            return true;
        } catch (error) {
            clearTimeout(source.timer);
            for (const edge of source.edges) {
                if (source.graph) {
                    try {
                        disconnectNode.call(source.graph.filters[9], edge.target, 0, edge.input);
                    } catch {}
                }
                try {
                    wire(source.node, edge.target, edge.output, edge.input);
                } catch {}
                edge.processed = false;
            }
            if (source.graph) {
                try {
                    disconnectNode.call(source.node, source.graph.preamp);
                } catch {}
            }
            status = 'unavailable';
            reason = error instanceof Error ? error.name : 'native-audio-error';
            notify();
            return false;
        }
    };
    const initialize = () => {
        if (context) return;
        context = new AudioContext({ latencyHint: 'playback' });
        context.addEventListener('statechange', () => {
            if (!disposed && !frozen && context?.state === 'suspended' && active())
                void context
                    .resume()
                    .then(notify)
                    .catch(() => {});
        });
        input = context.createGain();
        const graph = makeGraph(context);
        preamp = graph.preamp;
        probe = graph.probe;
        filters = graph.filters;
        input.connect(context.destination);
    };
    const update = () => {
        for (const ref of nativeRefs) {
            const source = ref.deref();
            if (source) protectNative(source);
            else nativeRefs.delete(ref);
        }
        if (!context) return;
        clearTimeout(bypassTimer);
        const wet = settings.enabled && (settings.preamp !== 0 || settings.gains.some((gain) => gain !== 0));
        if (wet && bypass) {
            input.disconnect();
            input.connect(preamp);
            filters[9].connect(context.destination);
            bypass = false;
        }
        headroom = configure({ context, preamp, probe, filters, headroom }, wet);
        if (!wet && !bypass)
            bypassTimer = setTimeout(() => {
                if (disposed || !context) return;
                input.disconnect();
                filters[9].disconnect();
                input.connect(context.destination);
                bypass = true;
            }, 180);
    };
    const safe = (media: HTMLMediaElement) => {
        if (media.mediaKeys) return false;
        try {
            const url = new URL(media.currentSrc || media.src, location.href);
            return (
                (url.protocol === 'blob:' && url.origin === location.origin) ||
                (['https:', 'http:'].includes(url.protocol) &&
                    (url.origin === location.origin ||
                        ['anonymous', 'use-credentials'].includes(media.crossOrigin || '')))
            );
        } catch {
            return false;
        }
    };
    const route = async (media: HTMLMediaElement) => {
        if (disposed || frozen || connecting.has(media)) return;
        const native = nativeMedia.get(media);
        if (native) {
            if (!protectNative(native)) return;
            status = settings.enabled
                ? native.edges.length && native.node.context.state === 'running'
                    ? 'active'
                    : 'waiting'
                : 'off';
            reason = !native.edges.length
                ? 'native-connecting'
                : native.node.context.state !== 'running'
                  ? 'native-suspended'
                  : '';
            notify();
            return;
        }
        if (!settings.enabled && !sources.has(media)) return;
        if (!sources.has(media) && (!safe(media) || media.readyState < 2)) {
            status = settings.enabled ? (media.readyState < 2 ? 'waiting' : 'unavailable') : 'off';
            reason = media.readyState < 2 ? 'loading' : media.mediaKeys ? 'protected' : 'cors';
            notify();
            return;
        }
        connecting.add(media);
        try {
            const fresh = !context;
            initialize();
            if (context!.state !== 'running') await context!.resume();
            if (disposed || (!settings.enabled && !sources.has(media))) return;
            if (fresh) update();
            if (!sources.has(media)) {
                if (!safe(media)) return;
                let source: MediaElementAudioSourceNode;
                creatingOwned = true;
                try {
                    source = context!.createMediaElementSource(media);
                } finally {
                    creatingOwned = false;
                }
                sources.set(media, { node: source, connected: false });
            }
            const source = sources.get(media)!;
            if (!source.connected) {
                source.node.connect(input);
                source.connected = true;
            }
            status = settings.enabled ? 'active' : 'off';
            reason = '';
            notify();
        } catch (error) {
            status = 'unavailable';
            reason = error instanceof Error ? error.name : 'audio-error';
            notify();
        } finally {
            connecting.delete(media);
            settle();
        }
    };
    const release = (media: HTMLMediaElement) => {
        const native = nativeMedia.get(media);
        if (native) protectNative(native, true);
        const source = sources.get(media);
        if (source?.connected) {
            source.node.disconnect();
            source.connected = false;
        }
        for (const ref of seen) if (ref.deref() === media) seen.delete(ref);
        settle();
    };
    AudioContext.prototype.createMediaElementSource = function (media) {
        const node = createSource.call(this, media);
        if (!creatingOwned && media instanceof HTMLAudioElement) {
            const binding: NativeSource = { node, media: new WeakRef(media), edges: [] };
            nativeMedia.set(media, binding);
            nativeNodes.set(node, binding);
            for (const ref of nativeRefs) if (!ref.deref()) nativeRefs.delete(ref);
            nativeRefs.add(new WeakRef(binding));
            remember(media);
            if (!nativeContexts.has(this)) {
                nativeContexts.add(this);
                this.addEventListener('statechange', () => {
                    const current = currentNative();
                    const currentMedia = current?.media.deref();
                    if (!disposed && !frozen && current?.node.context === this && currentMedia && !currentMedia.paused)
                        void route(currentMedia);
                });
            }
        }
        return node;
    };
    AudioNode.prototype.connect = function (
        this: AudioNode,
        target: AudioNode | AudioParam,
        output: number = 0,
        inputIndex: number = 0,
    ) {
        const source = nativeNodes.get(this);
        if (!source || !(target instanceof AudioNode)) return wire(this, target, output, inputIndex);
        if (source.edges.some((edge) => edge.target === target && edge.output === output && edge.input === inputIndex))
            return target;
        const result = wire(this, target, output, inputIndex);
        source.edges.push({ target, output, input: inputIndex, processed: false });
        protectNative(source);
        return result;
    } as typeof AudioNode.prototype.connect;
    AudioNode.prototype.disconnect = function (this: AudioNode, ...args: (AudioNode | AudioParam | number)[]) {
        const source = nativeNodes.get(this);
        if (!source || args[0] instanceof AudioParam) return disconnectNode.apply(this, args);
        const matches = source.edges.filter(
            (edge) =>
                !args.length ||
                args[0] === undefined ||
                (typeof args[0] === 'number' && edge.output === args[0]) ||
                (edge.target === args[0] &&
                    (args.length < 2 || edge.output === args[1]) &&
                    (args.length < 3 || edge.input === args[2])),
        );
        if (!matches.length) return disconnectNode.apply(this, args);
        if (!args.length || args[0] === undefined || typeof args[0] === 'number') disconnectNode.apply(this, args);
        for (const edge of matches) {
            if (edge.processed && source.graph)
                disconnectNode.call(source.graph.filters[9], edge.target, 0, edge.input);
            else if (args[0] instanceof AudioNode) disconnectNode.call(this, edge.target, edge.output, edge.input);
        }
        source.edges = source.edges.filter((edge) => !matches.includes(edge));
        if (!source.edges.some((edge) => edge.processed) && source.graph) {
            try {
                disconnectNode.call(this, source.graph.preamp);
            } catch {}
        }
    } as typeof AudioNode.prototype.disconnect;
    const remember = (media: HTMLMediaElement) => {
        if ([...seen].some((ref) => ref.deref() === media)) return;
        live();
        seen.add(new WeakRef(media));
        if (attached.has(media)) return;
        attached.add(media);
        media.addEventListener('playing', () => {
            remember(media);
            void route(media);
        });
        media.addEventListener('loadeddata', () => {
            if (!media.paused) void route(media);
        });
        for (const type of ['pause', 'ended', 'emptied', 'error'])
            media.addEventListener(type, () => {
                if (type === 'pause' && !media.paused) return;
                if (type === 'ended' && !media.ended && !media.paused) return;
                if (type === 'emptied' && media.readyState !== 0) return;
                if (type === 'error' && !media.error) return;
                release(media);
            });
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        if (this instanceof HTMLAudioElement) {
            remember(this);
            if (sources.has(this)) void route(this);
        }
        return originalPlay.call(this);
    };
    for (const media of document.querySelectorAll('audio')) {
        remember(media);
        if (!media.paused) void route(media);
    }
    page.__soundcloudEqualizer = {
        set(value) {
            settings = {
                enabled: value?.enabled === true,
                preset: typeof value?.preset === 'string' ? value.preset : 'custom',
                gains: frequencies.map((_, index) =>
                    Number.isFinite(value?.gains?.[index]) ? Math.max(-12, Math.min(12, value.gains[index])) : 0,
                ),
                preamp: Number.isFinite(value?.preamp) ? Math.max(-18, Math.min(0, value.preamp)) : 0,
            };
            status = settings.enabled ? 'waiting' : 'off';
            reason = '';
            update();
            for (const media of live()) if (!media.paused && !media.ended) void route(media);
            notify();
        },
        snapshot,
        analysisTap(media) {
            const node = nativeMedia.get(media)?.node || sources.get(media)?.node;
            if (!node || media.mediaKeys) return;
            const analyser = node.context.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.6;
            wire(node, analyser);
            let released = false;
            return {
                analyser,
                release: () => {
                    if (released) return;
                    released = true;
                    try {
                        disconnectNode.call(node, analyser);
                    } catch {}
                    analyser.disconnect();
                },
            };
        },
    };
    page.addEventListener('pageshow', () => {
        frozen = false;
        for (const media of live()) if (!media.paused) void route(media);
    });
    page.addEventListener('pagehide', (event) => {
        frozen = true;
        clearTimeout(bypassTimer);
        if ((event as PageTransitionEvent).persisted) void context?.suspend().catch(() => {});
        else {
            disposed = true;
            for (const type of keyEvents) page.removeEventListener(type, shieldKeys, true);
            void context?.close().catch(() => {});
        }
    });
}
