import { effectiveMood } from './preferences';
import { isDeepStrictEqual } from 'node:util';
import { buildProfile, tokensOf, explicitlyRejected, retainFeedback } from './profile';
import { rejectedSource } from './rejections';
import type { TasteProfile } from './profile';
import { discoverySeeds } from './discovery';
import { recommend } from './ranker';
import { CatalogSimilarityCache } from './similarity';
import { defaultControls } from './types';
import type { Context, Controls, Feedback, Recommendation, Track } from './types';
import { artistIdentity, recentPreference, recentReactions, sessionWeight } from './sessionSignals';
import { inferSessionMood } from './sessionMood';
export interface CandidateProvider {
    related(seeds: Track[], advance?: boolean): Promise<Track[]>;
}
export class RecommendationSession {
    private similarity = new CatalogSimilarityCache();
    private corpusRevision = 0;
    similarityDiagnostics(): object {
        return this.similarity.diagnostics();
    }
    private events: Feedback[] = [];
    private candidates = new Map<string, Track>();
    private recentIds: string[] = [];
    private recentArtists: string[] = [];
    private reservedIds = new Set<string>();
    private rotation = 0;
    private acceptedIds = new Set<string>();
    private selectionTrail: Array<{ id: string; artist: string }> = [];
    private selectionPosition = 0;
    accept(id: string): void {
        if (this.acceptedIds.has(id)) return;
        this.acceptedIds.add(id);
        const track = this.candidates.get(id);
        if (track)
            this.selectionTrail = [
                { id, artist: track.artist },
                ...this.selectionTrail.filter((item) => item.id !== id),
            ].slice(0, 12);
        if (this.acceptedIds.size > 500) this.acceptedIds.delete(this.acceptedIds.values().next().value!);
        this.selectionPosition++;
        this.invalidateRanking();
    }
    private rankingRevision = 0;
    private rankingCache = new Map<number, { revision: number; minute: number; value: Recommendation[] }>();
    private invalidateRanking(): void {
        this.rankingRevision++;
        this.rankingCache.clear();
    }
    private excludedArtists = new Set<string>();
    private knownApiIds = new Set<number>();
    private blockedUploaders = new Set<number>();
    setLibrarySignals(liked: readonly number[], blocked: readonly number[]): void {
        this.knownApiIds = new Set(liked.filter((id) => Number.isSafeInteger(id) && id > 0));
        this.blockedUploaders = new Set(blocked.filter((id) => Number.isSafeInteger(id) && id > 0));
        this.invalidateRanking();
    }
    setExcludedArtists(artists: string[]): void {
        this.excludedArtists = new Set(artists.map(artistIdentity));
        this.invalidateRanking();
    }
    private allowedSource(track: Track): boolean {
        return (
            !this.excludedArtists.has(artistIdentity(track.artist)) && !this.blockedUploaders.has(track.uploaderId || 0)
        );
    }
    private allowed(track: Track): boolean {
        return (
            this.allowedSource(track) &&
            (!['new', 'popular'].includes(this.controls.discovery) || !this.knownApiIds.has(track.apiId || 0))
        );
    }
    accepts(track: Track): boolean {
        const profile = this.profile();
        return (
            this.allowed(track) &&
            !explicitlyRejected(track, profile) &&
            !rejectedSource(track, profile, this.trackSeed?.id)
        );
    }
    private savedControls: Controls = { ...defaultControls };
    private get controls(): Controls {
        return this.trackSeed ? defaultControls : this.savedControls;
    }
    private activity?: Context['activity'];
    private profileCache?: {
        minute: number;
        value: TasteProfile;
    };
    private refreshTask?: Promise<Recommendation[]>;
    private refreshedAt?: number;
    private refreshedDirection = '';
    private candidateEpoch = 0;
    private anchor?: Track;
    private trackSeed?: Track;
    private activeSeeds: Track[] = [];
    discoveryRoots(): Track[] {
        return this.activeSeeds.map((track) => ({ ...track }));
    }
    listeningMood() {
        if (this.trackSeed) return undefined;
        const now = this.now();
        return inferSessionMood(this.controls, {
            now,
            activity: this.activity,
            sessionReactions: recentReactions(this.events, now),
        });
    }
    setAnchor(track?: Track): void {
        this.anchor = track;
        this.invalidateRanking();
    }
    setTrackSeed(track?: Track): void {
        if (!this.trackSeed && !track) return;
        this.trackSeed = track;
        this.anchor = track;
        this.activeSeeds = [];
        this.candidateEpoch++;
        this.refreshTask = undefined;
        this.refreshedAt = undefined;
        this.invalidateRanking();
    }
    profile(): TasteProfile {
        const minute = Math.floor(this.now() / 60000);
        if (!this.profileCache || this.profileCache.minute !== minute)
            this.profileCache = { minute, value: buildProfile(this.events, this.now()) };
        return this.profileCache.value;
    }
    constructor(
        private provider: CandidateProvider,
        private now: () => number = Date.now,
    ) {}
    setControls(controls: Partial<Controls>): void {
        if (!this.trackSeed && controls.mood !== undefined && controls.mood !== this.savedControls.mood)
            this.activeSeeds = [];
        this.savedControls = { ...this.savedControls, ...controls };
        this.invalidateRanking();
    }
    setActivity(activity?: Context['activity']): void {
        if (!this.trackSeed && activity !== this.activity) this.activeSeeds = [];
        this.activity = activity;
        this.invalidateRanking();
    }
    loadFeedback(events: Feedback[]): void {
        this.invalidateRanking();
        this.events = retainFeedback(events).slice();
        this.profileCache = undefined;
        const seen = new Set<string>();
        const seenApiIds = new Set<number>();
        const cutoff = this.now() - 86400000;
        this.recentIds = [];
        this.recentArtists = [];
        for (let index = this.events.length - 1; index >= 0 && this.recentIds.length < 100; index--) {
            const { kind, at, track } = this.events[index];
            if (
                !['play', 'skip', 'complete'].includes(kind) ||
                seen.has(track.id) ||
                (track.apiId && seenApiIds.has(track.apiId))
            )
                continue;
            seen.add(track.id);
            if (track.apiId) seenApiIds.add(track.apiId);
            if (this.recentArtists.length < 20) this.recentArtists.push(track.artist);
            if (at > cutoff) this.recentIds.push(track.id);
        }
    }
    clearCandidates(): void {
        this.activeSeeds = [];
        this.corpusRevision++;
        this.similarity.clear();
        for (const item of [...this.selectionTrail]) if (!this.recentIds.includes(item.id)) this.release(item.id);
        this.invalidateRanking();
        this.candidateEpoch++;
        this.candidates.clear();
        this.reservedIds.clear();
        this.selectionTrail = this.selectionTrail.filter((item) => this.recentIds.includes(item.id));
    }
    removeCandidates(ids: string[]): void {
        this.corpusRevision++;
        this.invalidateRanking();
        for (const id of ids) {
            this.release(id);
            this.candidates.delete(id);
            this.reservedIds.delete(id);
        }
    }
    reserve(id: string): void {
        if (this.reservedIds.has(id)) return;
        this.invalidateRanking();
        this.reservedIds.add(id);
        if (this.reservedIds.size > 1000) this.reservedIds.delete(this.reservedIds.values().next().value!);
    }
    release(id: string): void {
        const withdrawn = !this.recentIds.includes(id) && this.acceptedIds.delete(id);
        if (withdrawn) this.selectionPosition = Math.max(0, this.selectionPosition - 1);
        const previous = this.selectionTrail.length;
        this.selectionTrail = this.selectionTrail.filter((item) => item.id !== id || this.recentIds.includes(id));
        if (this.reservedIds.delete(id) || previous !== this.selectionTrail.length || withdrawn)
            this.invalidateRanking();
    }
    addCandidates(tracks: Track[]): void {
        let changed = false;
        let corpusChanged = false;
        for (const track of tracks) {
            const previous = this.candidates.get(track.id);
            if (!track.id || !track.artist || isDeepStrictEqual(previous, track)) continue;
            if (!previous || JSON.stringify(tokensOf(previous)) !== JSON.stringify(tokensOf(track)))
                corpusChanged = true;
            const snapshot = { ...track };
            if (track.tags) snapshot.tags = [...track.tags];
            if (track.relatedTo) snapshot.relatedTo = [...track.relatedTo];
            if (track.features) snapshot.features = { ...track.features };
            if (this.trackSeed?.id === snapshot.id) this.trackSeed = snapshot;
            this.candidates.set(track.id, snapshot);
            changed = true;
        }
        if (corpusChanged) this.corpusRevision++;
        if (changed) this.invalidateRanking();
    }
    feedback(
        item: Omit<Feedback, 'at'> & {
            at?: number;
        },
    ): void {
        const event = { ...item, at: item.at ?? this.now() };
        this.invalidateRanking();
        this.events.push(event);
        this.profileCache = undefined;
        this.events = retainFeedback(this.events);
        if (event.kind === 'dislike') {
            this.activeSeeds = this.activeSeeds.filter((track) => !explicitlyRejected(track, this.profile()));
            if (this.anchor && explicitlyRejected(this.anchor, this.profile())) this.anchor = undefined;
        }
        if (event.kind === 'play' || event.kind === 'skip' || event.kind === 'complete') {
            const previousId = this.recentIds[0];
            this.reservedIds.delete(event.track.id);
            this.recentIds = this.recentIds.filter((id) => id !== event.track.id);
            this.recentIds.unshift(event.track.id);
            if (previousId !== event.track.id) this.recentArtists.unshift(event.track.artist);
            this.recentIds = this.recentIds.slice(0, 100);
            this.recentArtists = this.recentArtists.slice(0, 20);
        }
    }
    private context(includeReserved = true, reconsider?: ReadonlySet<string>): Context {
        const now = this.now();
        const reactions = recentReactions(this.events, now);
        const rejected = new Set(reactions.filter((event) => sessionWeight(event) < 0).map((event) => event.track.id));
        const pending = this.selectionTrail.filter((item) => !this.recentIds.includes(item.id));
        const kept = pending.filter((item) => !reconsider?.has(item.id));
        const planned = kept.flatMap((item) => (this.candidates.get(item.id) ? [this.candidates.get(item.id)!] : []));
        const played = new Map<string, Track>();
        for (const event of this.events.slice(-80).sort((a, b) => b.at - a.at)) {
            if (
                event.origin === 'library' ||
                event.at > now ||
                now - event.at >= 45 * 60000 ||
                !['play', 'skip', 'complete'].includes(event.kind)
            )
                continue;
            if (!played.has(event.track.id)) played.set(event.track.id, event.track);
            if (played.size >= 6) break;
        }
        return {
            now,
            discoverySeeds: this.activeSeeds,
            activity: this.trackSeed ? undefined : this.activity,
            trackSeed: this.trackSeed,
            recentTrackIds: this.recentIds,
            knownLikedApiIds: this.knownApiIds,
            reservedTrackIds: includeReserved ? [...this.reservedIds].filter((id) => !reconsider?.has(id)) : [],
            allowUnverified: includeReserved,
            recentArtists: [...kept.map((item) => item.artist), ...this.recentArtists],
            seed: this.rotation + 1,
            sequenceOffset: Math.max(0, this.selectionPosition - (pending.length - kept.length)),
            anchor: planned[0] || (this.anchor && !rejected.has(this.anchor.id) ? this.anchor : undefined),
            preferenceSignals: recentPreference(reactions, now),
            sessionReactions: reactions,
            recentTracks: [...planned, ...played.values()].slice(0, 6),
        };
    }
    rank(limit = 10, reconsider: readonly string[] = []): Recommendation[] {
        const minute = Math.floor(this.now() / 60000);
        const cached = reconsider.length ? undefined : this.rankingCache.get(limit);
        if (cached?.revision === this.rankingRevision && cached.minute === minute)
            return this.copyRecommendations(cached.value);
        const value = recommend(
            [...this.candidates.values()].filter((track) => this.allowed(track)),
            this.events,
            this.controls,
            this.context(true, reconsider.length ? new Set(reconsider) : undefined),
            limit,
            this.profile(),
            (corpus) => this.similarity.get(corpus),
        );
        if (!reconsider.length) {
            if (this.rankingCache.size >= 8) this.rankingCache.clear();
            this.rankingCache.set(limit, { revision: this.rankingRevision, minute, value });
        }
        return this.copyRecommendations(value);
    }
    private copyRecommendations(items: Recommendation[]): Recommendation[] {
        return items.map((item) => ({
            ...item,
            ...(item.selection ? { selection: { ...item.selection } } : {}),
            reasons: [...item.reasons],
            track: {
                ...item.track,
                ...(item.track.tags ? { tags: [...item.track.tags] } : {}),
                ...(item.track.features ? { features: { ...item.track.features } } : {}),
                ...(item.track.relatedTo ? { relatedTo: [...item.track.relatedTo] } : {}),
            },
        }));
    }
    rankBuffered(tracks: Track[], limit = 10, recentArtists: string[] = []): Recommendation[] {
        const context = this.context(false);
        context.similarityCorpus = [...this.candidates.values()];
        context.recentArtists = [...recentArtists, ...(context.recentArtists || [])];
        const profile = this.profile();
        const metadata = (track: Track) => [track.id, track.title, track.genre, track.tags];
        const revision = JSON.stringify([
            this.corpusRevision,
            Math.floor(this.now() / 60000),
            profile.positiveSeeds.map(metadata),
            profile.trustedSeeds.map(metadata),
            profile.negativeSeeds.map(metadata),
            context.sessionReactions?.map((event) => metadata(event.track)),
            context.recentTracks?.map(metadata),
            context.trackSeed && metadata(context.trackSeed),
        ]);
        return recommend(
            tracks.filter((track) => this.allowed(track)),
            this.events,
            this.controls,
            context,
            limit,
            profile,
            (corpus) => this.similarity.get(corpus, revision),
        );
    }
    async refresh(advance = false): Promise<Recommendation[]> {
        if (this.refreshTask) return this.refreshTask;
        const task = this.refreshOnce(advance);
        this.refreshTask = task;
        try {
            return await task;
        } finally {
            if (this.refreshTask === task) this.refreshTask = undefined;
        }
    }
    private direction(): string {
        return JSON.stringify([
            this.trackSeed?.id,
            this.anchor?.id,
            this.controls,
            this.activity,
            this.listeningMood()?.mood,
            recentReactions(this.events, this.now()).map((event) => [event.track.id, event.kind, sessionWeight(event)]),
        ]);
    }
    async refreshIfNeeded(): Promise<boolean> {
        if (this.refreshTask || ['favorites', 'familiar'].includes(this.controls.discovery)) return false;
        if (!this.trackSeed && !this.anchor && !this.profile().positiveSeeds.length) return false;
        const now = this.now();
        const rejections = recentReactions(this.events, now).filter(
            (event) => sessionWeight(event) < 0 && now - event.at < 10 * 60000,
        ).length;
        const cooldown = rejections >= 2 ? 15000 : 60000;
        if (this.refreshedAt !== undefined && now >= this.refreshedAt && now - this.refreshedAt < cooldown)
            return false;
        if (this.refreshedAt !== undefined && this.refreshedDirection === this.direction()) return false;
        const epoch = this.candidateEpoch;
        await this.refresh();
        return epoch === this.candidateEpoch;
    }
    private async refreshOnce(advance: boolean): Promise<Recommendation[]> {
        const epoch = this.candidateEpoch;
        this.refreshedAt = this.now();
        this.refreshedDirection = this.direction();
        const context = this.context();
        const mood = effectiveMood(this.controls, context);
        const controls = { ...this.controls, mood, activity: this.activity };
        const rotation = this.rotation++;
        this.invalidateRanking();
        const seeds = this.trackSeed
            ? [this.trackSeed]
            : discoverySeeds(
                  {
                      ...this.profile(),
                      positiveSeeds: this.profile().positiveSeeds.filter((track) => this.allowedSource(track)),
                      trustedSeeds: this.profile().trustedSeeds.filter((track) => this.allowedSource(track)),
                  },
                  controls,
                  rotation,
                  this.anchor && this.allowedSource(this.anchor) ? this.anchor : undefined,
                  {
                      ...context,
                      sessionMood: inferSessionMood(this.controls, context),
                      sessionReactions: recentReactions(this.events, this.now()).filter((event) =>
                          this.allowedSource(event.track),
                      ),
                  },
              );
        this.activeSeeds = seeds;
        this.invalidateRanking();
        const found =
            advance && this.trackSeed ? await this.provider.related(seeds, true) : await this.provider.related(seeds);
        if (epoch !== this.candidateEpoch) return [];
        this.addCandidates(found);
        return this.rank();
    }
    async next(): Promise<Recommendation | undefined> {
        const ranked = this.rank(1);
        const selected = ranked[0] || (await this.refresh())[0];
        if (selected) this.reserve(selected.track.id);
        return selected;
    }
}
