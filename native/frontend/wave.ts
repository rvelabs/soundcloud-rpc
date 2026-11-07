import { SoundCloudRecommender } from '../../src/wave/recommendation/soundcloudAdapter';
import { nativeRuntimeExports } from '../../src/soundcloud/nativeRuntime';
import {
    installNativePlayerMonitor,
    nativePlayerCommand,
    nativeAutoplay,
} from '../../src/soundcloud/nativePlayerBridge';
import { nativeQueueModel, type QueueRequest, type QueueResult } from '../../src/soundcloud/nativeQueueBridge';
import { candidate } from './tracks';
import { Discovery } from './discovery';
import type { WaveCandidate, WaveControls } from '../../src/wave/waveEngine';
import type { Feedback, Track } from '../../src/wave/recommendation/types';
import { Events, Profile, api, invoke } from './bridge';
import { AudioAnalysisCache } from '../../src/wave/audioAnalysisCache';
import { ListeningEvidence } from '../../src/wave/listeningEvidence';
import { playbackRate } from './playbackRate';

export const defaultControls: WaveControls = {
    mood: 'any',
    tone: 'any',
    tempo: 'any',
    genre: '',
    discovery: 'balanced',
    language: 'any',
    activity: 'any',
};

type Snapshot = {
    url: string;
    title: string;
    author: string;
    isPlaying: boolean;
    isLiked: boolean;
    elapsed: string;
    duration: string;
};
const seconds = (value: string) => value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);

export class Wave {
    readonly events = new Events();
    active = false;
    controls: WaveControls = { ...defaultControls };
    private owner = 0;
    private profile?: Profile;
    private recommender?: SoundCloudRecommender;
    private discovery?: Discovery;
    private enriching?: Promise<void>;
    private lastEnrichment = -Infinity;
    private analysis?: AudioAnalysisCache;
    private sample = { path: '', seconds: 0, count: 0, energy: 0, bass: 0, brightness: 0 };
    private current?: Snapshot;
    private currentOrigin?: Feedback['origin'];
    private candidates = new Map<string, WaveCandidate>();
    private queued = new Set<string>();
    private sessionGeneration = 0;
    private queueTail: Promise<unknown> = Promise.resolve();
    private tickets = new Map<string, { operation: QueueRequest['operation']; cancel: () => void }>();
    private starting?: Promise<void>;
    private initializing?: Promise<void>;
    private initializeRetryAt = 0;
    private filling?: Promise<void>;
    private disposeMonitor?: () => void;
    private attempts = 0;
    private manualPause = false;
    private terminalAttempt?: { url: string; attempts: number; retryAt: number; reported?: boolean };
    private lastRefresh = 0;
    private lastFailure = 0;
    private catalogRevision = -1;
    private excluded: string[] = [];
    private controlsSelected = false;
    private listening = new ListeningEvidence();
    private qualified?: string;
    private statsSignature = '';
    private hydratingCurrent?: string;
    private analysisStatus = { phase: 'idle', reason: '', path: '', sampleSeconds: 0, analysed: 0 };
    private autoplayPrevious?: boolean;
    private failures: Array<{ at: number; message: string }> = [];
    private decisions: object[] = [];

    private describeDecision(phase: 'start' | 'next', track: WaveCandidate): object {
        return {
            at: Date.now(),
            phase,
            selected: {
                url: track.url,
                title: track.title,
                artist: track.artist,
                genre: track.genre,
                source: track.source,
                relatedTo: track.relatedTo,
                score: track.recommendationScore,
                evidence: track.selectionEvidence,
                reasons: track.recommendationReasons,
            },
            roots: this.recommender
                ?.discoveryRoots()
                .map(({ id, title, artist, genre }) => ({ id, title, artist, genre })),
        };
    }
    private rememberDecision(decision: object): void {
        this.decisions = [...this.decisions, decision].slice(-40);
        this.profile?.set('waveDecisionTraceV1_' + this.owner, this.decisions);
    }

    constructor() {
        window.addEventListener('__soundcloudWaveManualPause', () => {
            this.manualPause = true;
            this.cancelQueue('play');
        });
        document.addEventListener(
            'click',
            (event) => {
                if (!(event.target instanceof Element)) return;
                if (event.target.closest('.playControls__play')) this.manualPause = Boolean(this.current?.isPlaying);
                if (event.target.closest('.skipControl__next')) this.manualPause = false;
            },
            true,
        );
        document.addEventListener(
            'keydown',
            (event) => {
                if (event.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test((event.target as Element)?.tagName || ''))
                    this.manualPause = Boolean(this.current?.isPlaying);
            },
            true,
        );
    }

    private error(error: unknown, visible = true): void {
        const message = error instanceof Error ? error.message : String(error);
        this.failures.push({ at: Date.now(), message: message.slice(0, 300) });
        this.failures = this.failures.slice(-30);
        if (visible) this.events.emit('state', 'error', message);
    }

    private remember(items: WaveCandidate[]): void {
        items = items.map((item) => this.analysis?.enrich(item) || item);
        for (const item of items) this.candidates.set(item.url, item);
        while (this.candidates.size > 600) this.candidates.delete(this.candidates.keys().next().value!);
        this.recommender?.addCandidates(items);
    }

    private async discover(seeds: Track[]): Promise<WaveCandidate[]> {
        const discovery = this.discovery;
        if (!discovery) return [];
        const found = await discovery.related(
            seeds.map((seed) => ({ ...seed, apiId: seed.apiId || this.candidates.get(seed.id)?.apiId })),
            (items) => {
                if (discovery === this.discovery) this.remember(items);
            },
        );
        if (discovery !== this.discovery) return [];
        this.remember(found);
        return found;
    }

    private enrich(): void {
        if (!this.active || !this.discovery || this.enriching || Date.now() - this.lastEnrichment < 60000) return;
        this.lastEnrichment = Date.now();
        const discovery = this.discovery,
            recommender = this.recommender;
        this.enriching = discovery
            .enrich()
            .then((result) => {
                if (discovery !== this.discovery || !recommender) return;
                if (result.signals) recommender.setLibrarySignals(result.signals.likedIds, result.signals.blockedIds);
                recommender.seedLikes(result.likes);
                recommender.seedRecent(result.recent);
                this.remember([...result.likes, ...result.recent, ...result.tracks]);
                this.events.emit('stats', recommender.stats());
            })
            .catch((error) => this.error(error))
            .finally(() => {
                this.enriching = undefined;
            });
    }

    private async initialize(): Promise<void> {
        if (this.initializing) return this.initializing;
        const task = this.initializeOnce();
        this.initializing = task;
        try {
            await task;
        } finally {
            if (this.initializing === task) this.initializing = undefined;
        }
    }

    private async initializeOnce(): Promise<void> {
        const user = await api('me');
        if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Sign in to SoundCloud first');
        if (this.recommender && this.owner === user.id) return;
        this.discovery?.dispose();
        this.candidates.clear();
        this.queued.clear();
        this.listening.reset();
        this.attempts = 0;
        this.owner = user.id;
        this.catalogRevision = Number((await invoke<any>('native_diagnostics')).catalog?.revision);
        this.discovery = new Discovery(user.id, () => this.catalogRevision);
        this.lastEnrichment = -Infinity;
        this.profile = new Profile('wave-' + user.id);
        await this.profile.load();
        const journal = this.profile.get('waveDecisionTraceV1_' + user.id);
        this.decisions = Array.isArray(journal) ? journal.slice(-40) : [];
        this.analysis = new AudioAnalysisCache(this.profile, String(user.id));
        if (!this.controlsSelected)
            this.controls = { ...defaultControls, ...((this.profile.get('controls') as object) || {}) };
        else this.profile.set('controls', this.controls);
        this.recommender = new SoundCloudRecommender(this.profile, String(user.id), (seeds) => this.discover(seeds));
        this.recommender.setControls(this.controls);
        this.events.emit('controls', this.controls);
        this.excluded = this.recommender.getExcludedArtists();
        const initial = await this.discovery.initial().catch((error) => {
            this.recommender = undefined;
            this.discovery?.dispose();
            this.discovery = undefined;
            throw error;
        });
        this.recommender.setLibrarySignals(initial.signals?.likedIds || [], initial.signals?.blockedIds || []);
        this.recommender.seedLikes(initial.likes);
        this.remember(initial.likes);
        this.events.emit('stats', this.recommender.stats());
    }

    async start(): Promise<void> {
        if (this.starting) return this.starting;
        const task = this.startOnce();
        this.starting = task;
        try {
            await task;
        } catch (error) {
            this.stop();
            this.error(error);
            throw error;
        } finally {
            this.starting = undefined;
        }
    }
    private async startOnce(): Promise<void> {
        const generation = ++this.sessionGeneration;
        this.attempts = 0;
        await this.initialize();
        if (generation !== this.sessionGeneration) return;
        this.active = true;
        const autoplay = nativeAutoplay(false, nativeRuntimeExports);
        if (this.autoplayPrevious === undefined && autoplay) this.autoplayPrevious = autoplay.previous;
        this.analysisState();
        this.manualPause = false;
        this.queued.clear();
        this.terminalAttempt = undefined;
        await invoke('wave_active', { active: true });
        this.events.emit('active', true);
        this.events.emit('state', 'loading');
        if (this.current?.url) {
            const raw = await api('resolve', { url: this.current.url }).catch(() => null);
            const track = raw && candidate(raw, 'personal');
            if (track) {
                this.remember([track]);
                this.recommender!.setAnchor(track);
            }
        }
        await this.recommender!.refresh();
        if (generation !== this.sessionGeneration) return;
        for (const track of this.recommender!.rank(8)) {
            if (this.manualPause || generation !== this.sessionGeneration) return;
            this.candidates.set(track.url, track);
            const decision = this.describeDecision('start', track);
            const result = await this.queue('play', [track.url], generation);
            if (this.manualPause || generation !== this.sessionGeneration) return;
            if (result.state === 'done') {
                this.rememberDecision(decision);
                this.recommender!.reserve(track, true);
                this.events.emit('candidate', track);
                this.enrich();
                await this.refill();
                return;
            }
            if (result.state === 'uncertain')
                throw new Error('SoundCloud did not confirm playback; retry after checking its player');
        }
        throw new Error('No playable tracks match these settings. Try fewer filters or like a few tracks first.');
    }

    stop(): void {
        this.active = false;
        if (this.autoplayPrevious !== undefined) {
            nativeAutoplay(this.autoplayPrevious, nativeRuntimeExports);
            this.autoplayPrevious = undefined;
        }
        this.analysisState();
        this.sessionGeneration++;
        this.cancelQueue();
        this.events.emit('active', false);
        void invoke('wave_active', { active: false }).catch(() => {});
        if (this.queued.size) void this.queue('remove', [...this.queued], this.sessionGeneration).catch(() => {});
        this.queued.clear();
    }

    private queue(operation: QueueRequest['operation'], urls: string[], generation = this.sessionGeneration) {
        const task = this.queueTail
            .catch(() => {})
            .then(async () => {
                if (generation !== this.sessionGeneration) return { state: 'cancelled' as const };
                const ticket = crypto.randomUUID();
                let cancel = () => {};
                let timer: ReturnType<typeof setTimeout> | undefined;
                const cancelled = new Promise<QueueResult>((resolve) => {
                    cancel = () => resolve({ state: 'cancelled' });
                });
                this.tickets.set(ticket, { operation, cancel });
                try {
                    return await Promise.race([
                        nativeQueueModel(
                            { operation, urls, ticket, expires: Date.now() + 4500 },
                            nativeRuntimeExports,
                        ).catch((): QueueResult => ({ state: 'uncertain' })),
                        cancelled,
                        new Promise<QueueResult>((resolve) => {
                            timer = setTimeout(() => resolve({ state: 'uncertain' }), 5000);
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                    const entry = (window as any).__scRpcQueueTickets?.get(ticket);
                    if (entry) entry.cancelled = true;
                    (window as any).__scRpcQueueTickets?.delete(ticket);
                    this.tickets.delete(ticket);
                }
            });
        this.queueTail = task;
        return task;
    }
    private cancelQueue(operation?: QueueRequest['operation']): void {
        for (const [ticket, item] of this.tickets) {
            if (operation && operation !== item.operation) continue;
            const entry = (window as any).__scRpcQueueTickets?.get(ticket);
            if (entry) entry.cancelled = true;
            item.cancel();
        }
    }

    private async refill(): Promise<void> {
        if (this.filling) return this.filling;
        const task = this.fillOnce();
        this.filling = task;
        try {
            await task;
        } finally {
            this.filling = undefined;
        }
    }

    private async fillOnce(): Promise<void> {
        const generation = this.sessionGeneration;
        if (!this.active || !this.recommender || Date.now() - this.lastFailure < 15000) return;
        const next = await this.queue('list', [], generation);
        if (next.state !== 'done') return;
        const future = new Set(next.urls || []);
        for (const url of this.queued)
            if (!future.has(url)) {
                const track = this.candidates.get(url);
                if (track) this.recommender.release(track);
                this.queued.delete(url);
            }
        if (this.queued.size >= 2) return;
        if (this.recommender.rank(4).length < 2 || Date.now() - this.lastRefresh > 60000) {
            await this.recommender.refresh();
            this.lastRefresh = Date.now();
        }
        for (const track of this.recommender.rank(10)) {
            if (generation !== this.sessionGeneration || !this.active || this.queued.size >= 2) break;
            if (future.has(track.url) || track.url === this.current?.url) continue;
            this.candidates.set(track.url, track);
            const decision = this.describeDecision('next', track);
            const result = await this.queue('add', [track.url], generation);
            if (result.state === 'done') {
                this.rememberDecision(decision);
                this.queued.add(track.url);
                this.recommender.reserve(track, true);
            } else if (result.state === 'uncertain') {
                this.lastFailure = Date.now();
                this.events.emit(
                    'state',
                    'error',
                    'SoundCloud не подтвердил действие очереди. Повторите после проверки плеера.',
                );
                return;
            }
        }
        this.events.emit('state', 'playing');
    }

    private loadCurrent(snapshot: Snapshot): void {
        const discovery = this.discovery;
        if (!discovery || this.hydratingCurrent === snapshot.url) return;
        this.hydratingCurrent = snapshot.url;
        void discovery
            .hydrate([{ id: snapshot.url, title: snapshot.title, artist: snapshot.author }], true)
            .then((items) => {
                if (discovery !== this.discovery || this.current?.url !== snapshot.url || !items.length) return;
                this.remember(items);
                this.recommender?.record(items[0], 'play', 0, undefined, this.currentOrigin);
                this.recommender?.setAnchor(items[0]);
                this.observe(this.current);
            })
            .catch((error) => this.error(error))
            .finally(() => {
                if (this.hydratingCurrent === snapshot.url) this.hydratingCurrent = undefined;
            });
    }

    private observe(raw: unknown): void {
        const next = raw as Snapshot;
        if (!next?.url) return;
        const previous = this.current;
        const previousOrigin = this.currentOrigin;
        this.listening.observe(next.url, seconds(next.elapsed), next.isPlaying, playbackRate());
        this.current = next;
        if (next.isPlaying || previous?.url !== next.url) this.terminalAttempt = undefined;
        if (next.isPlaying) this.manualPause = false;
        if (previous && previous.url !== next.url && this.recommender) {
            const track = this.candidates.get(previous.url);
            if (track) {
                const duration = seconds(previous.duration);
                const fraction = this.listening.fraction(previous.url, duration);
                const ended = duration > 0 && seconds(previous.elapsed) >= duration - 2;
                this.recommender.record(
                    track,
                    fraction >= 0.7 ? 'complete' : fraction >= 0.5 ? 'play' : ended ? 'play' : 'skip',
                    Math.min(1, fraction),
                    undefined,
                    previousOrigin,
                );
            }
        }
        const track = this.candidates.get(next.url);
        if (!track) this.loadCurrent(next);
        if (previous?.url !== next.url) {
            this.currentOrigin = this.active ? 'wave' : undefined;
            this.qualified = undefined;
            this.analysisState();
            this.queued.delete(next.url);
            if (track) {
                this.recommender?.record(track, 'play', 0, undefined, this.currentOrigin);
                this.recommender?.setAnchor(track);
                this.events.emit('candidate', track);
            }
            void this.refill().catch((error) => this.error(error));
        } else if (previous && previous.isLiked !== next.isLiked && track) {
            if (track.apiId) this.discovery?.reacted(track.apiId, next.isLiked);
            this.recommender?.record(track, next.isLiked ? 'like' : 'unlike');
        }
        if (track && this.recommender && this.qualified !== next.url) {
            const fraction = this.listening.fraction(next.url, seconds(next.duration));
            if (fraction >= 0.5) {
                this.qualified = next.url;
                this.recommender.record(track, 'play', fraction, track.features, this.currentOrigin);
            }
        }
        if (this.recommender) {
            const stats = this.recommender.stats();
            const signature = JSON.stringify(stats);
            if (signature !== this.statsSignature) {
                this.statsSignature = signature;
                this.events.emit('stats', stats);
            }
        }
        this.analysisState();
        this.events.emit('track', next);
    }

    private forgetAccount(): void {
        this.decisions = [];
        this.recommender = undefined;
        this.discovery?.dispose();
        this.discovery = undefined;
        this.stop();
        this.owner = 0;
        this.catalogRevision = -1;
        this.initializeRetryAt = 0;
        this.profile = undefined;
        this.analysis = undefined;
        this.current = undefined;
        this.currentOrigin = undefined;
        this.candidates.clear();
        this.listening.reset();
        this.analysisState();
    }

    async tick(): Promise<void> {
        if (!this.disposeMonitor && this.attempts++ < 30)
            this.disposeMonitor =
                installNativePlayerMonitor(
                    nativeRuntimeExports,
                    (track) => this.observe(track),
                    (track) => this.observe(track),
                ) || undefined;
        try {
            const diagnostics = await invoke<any>('native_diagnostics');
            const revision = Number(diagnostics.catalog?.revision);
            if (diagnostics.catalog?.ready === false || diagnostics.catalog?.authenticated === false) {
                if (this.owner) this.forgetAccount();
                return;
            }
            if (!this.recommender) {
                if (diagnostics.catalog?.ready !== true || Date.now() < this.initializeRetryAt) return;
                this.initializeRetryAt = Date.now() + 30000;
                await this.initialize();
                if (this.current) this.observe(this.current);
            }
            if (!Number.isSafeInteger(revision) || revision < 0)
                throw new Error('SoundCloud account context is not ready');
            if (this.catalogRevision < 0) this.catalogRevision = revision;
            else if (revision !== this.catalogRevision) {
                const user = await api('me');
                if (Number((await invoke<any>('native_diagnostics')).catalog?.revision) !== revision) return;
                if (user.id !== this.owner) {
                    this.forgetAccount();
                    throw new Error('SoundCloud account changed. Start My Wave again.');
                }
                this.catalogRevision = revision;
            }
            this.analysisState();
            if (!this.active) return;
            this.enrich();
            const current = this.current;
            if (
                current &&
                !current.isPlaying &&
                !this.manualPause &&
                this.queued.size &&
                seconds(current.duration) > 1 &&
                seconds(current.elapsed) >= seconds(current.duration) - 1 &&
                this.canAdvance()
            ) {
                const attempt =
                    this.terminalAttempt?.url === current.url
                        ? this.terminalAttempt
                        : { url: current.url, attempts: 0, retryAt: 0 };
                if (attempt.attempts < 3 && Date.now() >= attempt.retryAt) {
                    attempt.attempts++;
                    attempt.retryAt = Date.now() + 4000 * attempt.attempts;
                    this.terminalAttempt = attempt;
                    nativePlayerCommand('next', nativeRuntimeExports);
                } else if (attempt.attempts === 3 && Date.now() >= attempt.retryAt && !attempt.reported) {
                    attempt.reported = true;
                    this.events.emit(
                        'state',
                        'error',
                        'SoundCloud has not confirmed the next track. Retry after checking its player.',
                    );
                }
            }
            await this.refill();
        } catch (error) {
            this.lastFailure = Date.now();
            this.error(error, this.active);
        }
    }

    async settings(controls: WaveControls): Promise<void> {
        this.controlsSelected = true;
        this.controls = { ...defaultControls, ...controls, genre: '' };
        this.recommender?.setControls(this.controls);
        this.profile?.set('controls', this.controls);
        if (this.active) {
            const old = [...this.queued];
            ++this.sessionGeneration;
            this.cancelQueue();
            this.queued.clear();
            await this.queue('remove', old);
            for (const url of old) {
                const item = this.candidates.get(url);
                if (item) this.recommender?.release(item);
            }
            await this.refill();
        }
        await this.profile?.flush();
    }
    private canAdvance(): boolean {
        try {
            const manager = nativeRuntimeExports().find(
                (value: any) => typeof value?.getCurrentSound === 'function' && typeof value?.getQueue === 'function',
            ) as any;
            const sound = manager?.getCurrentSound();
            return typeof sound?.isAd === 'function' && !sound.isAd() && manager.getState?.('globalPlayLock') !== true;
        } catch {
            return false;
        }
    }
    async exclude(artist: string, excluded: boolean): Promise<string[]> {
        this.recommender?.excludeArtist(artist, excluded);
        this.excluded = this.recommender?.getExcludedArtists() || [];
        await this.settings(this.controls);
        return this.excluded;
    }
    async dislike(url: string): Promise<void> {
        const track = this.candidates.get(url);
        if (!track) return;
        this.recommender?.record(track, 'dislike');
        await this.settings(this.controls);
        nativePlayerCommand('next', nativeRuntimeExports);
    }
    control(command: string): void {
        if (command === 'stop') this.stop();
        else if (['toggle', 'previous', 'next', 'like'].includes(command))
            nativePlayerCommand(command as any, nativeRuntimeExports);
    }
    ready() {
        return {
            active: this.active,
            controls: this.controls,
            track: this.current,
            candidate: this.current && this.candidates.get(this.current.url),
            stats: this.recommender?.stats(),
            analysis: this.analysisStatus,
            excludedArtists: this.excluded,
        };
    }
    diagnostics() {
        return {
            decisions: this.decisions.slice(-12),
            learning: {
                ready: Boolean(this.recommender),
                initializing: Boolean(this.initializing),
                currentOrigin: this.current ? this.currentOrigin || 'manual' : undefined,
                currentKnown: Boolean(this.current && this.candidates.has(this.current.url)),
                confirmedSeconds: this.current ? this.listening.played(this.current.url) : 0,
            },
            active: this.active,
            monitor: Boolean(this.disposeMonitor),
            queued: this.queued.size,
            current: this.current,
            failures: this.failures,
            recommendations: this.recommender?.diagnostics(),
            discovery: this.discovery?.diagnostics(),
            analysis: this.analysisStatus,
        };
    }
    get monitorReady(): boolean {
        return Boolean(this.disposeMonitor);
    }
    private analysisState(): void {
        const track = this.current && this.candidates.get(this.current.url);
        const path = this.current?.url ? new URL(this.current.url).pathname : '';
        const state = {
            active: Boolean(this.recommender && track && this.current?.isPlaying && this.canAdvance()),
            currentPath: path,
            analysisReadyPath: track && this.analysis?.get(track) ? path : undefined,
        };
        if (JSON.stringify((window as any).__waveMediaEndState) === JSON.stringify(state)) return;
        (window as any).__waveMediaEndState = state;
        window.dispatchEvent(new Event('__soundcloudWaveMediaState'));
        this.audioStatus({
            phase: track && this.analysis?.get(track) ? 'cached' : state.active ? 'waiting' : 'idle',
            path,
        });
    }
    audioStatus(value: unknown): void {
        const input = value as { phase?: string; reason?: string; path?: string; sampleSeconds?: number };
        if (
            !input ||
            !['idle', 'waiting', 'cached', 'ready', 'analysing', 'silent', 'unavailable'].includes(input.phase || '')
        )
            return;
        if (input.path && this.current?.url && input.path !== new URL(this.current.url).pathname) return;
        const previousCount = this.analysisStatus.analysed;
        this.analysisStatus = {
            phase: input.phase!,
            reason: String(input.reason || '').slice(0, 80),
            path: input.path || '',
            sampleSeconds: Number.isFinite(input.sampleSeconds) ? Math.max(0, Math.min(93, input.sampleSeconds!)) : 0,
            analysed: this.analysis?.size() || 0,
        };
        if (this.analysisStatus.analysed !== previousCount) this.events.emit('analysis', this.analysisStatus);
    }
    audio(value: unknown): void {
        const input = value as {
            path?: string;
            sampleSeconds?: number;
            source?: string;
            energy?: number;
            bass?: number;
            treble?: number;
        };
        const track = this.current && this.candidates.get(this.current.url);
        if (
            !this.recommender ||
            !track ||
            input?.source !== 'media-element-v1' ||
            input.path !== new URL(track.url).pathname ||
            typeof input.sampleSeconds !== 'number' ||
            input.sampleSeconds < 0 ||
            input.sampleSeconds > 93 ||
            ![input.energy, input.bass, input.treble].every(
                (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
            )
        )
            return;
        if (this.sample.path !== input.path)
            this.sample = { path: input.path, seconds: 0, count: 0, energy: 0, bass: 0, brightness: 0 };
        if (input.sampleSeconds <= this.sample.seconds) return;
        this.sample.seconds = input.sampleSeconds;
        this.sample.count++;
        this.sample.energy += input.energy!;
        this.sample.bass += input.bass!;
        this.sample.brightness += input.treble!;
        if (input.sampleSeconds < 30 || this.sample.count < 30) return;
        const features = {
            source: 'media-element-v1' as const,
            sampleSeconds: Math.min(input.sampleSeconds, this.sample.count),
            energy: this.sample.energy / this.sample.count,
            bass: this.sample.bass / this.sample.count,
            brightness: this.sample.brightness / this.sample.count,
        };
        this.analysis?.remember(track, features);
        const saved = this.analysis?.get(track);
        if (!saved) {
            this.audioStatus({ phase: 'silent', path: input.path, sampleSeconds: input.sampleSeconds });
            return;
        }
        this.remember([{ ...track, features: saved }]);
        this.recommender?.applyAudioFeatures(track, saved);
        this.events.emit('candidate', this.candidates.get(track.url));
        this.analysisState();
        this.audioStatus({ phase: 'ready', path: input.path, sampleSeconds: features.sampleSeconds });
    }
    async dispose(): Promise<void> {
        this.discovery?.dispose();
        this.disposeMonitor?.();
        await this.profile?.flush();
    }
}
