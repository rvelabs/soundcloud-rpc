import { effectiveMood } from './preferences';
import { buildProfile } from './profile';
import type { TasteProfile } from './profile';
import { discoverySeeds } from './discovery';
import { recommend } from './ranker';
import { defaultControls } from './types';
import type { Context, Controls, Feedback, Recommendation, Track } from './types';
import { artistIdentity, recentPreference } from './sessionSignals';
export interface CandidateProvider {
    related(seeds: Track[]): Promise<Track[]>;
}
export class RecommendationSession {
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
    setExcludedArtists(artists: string[]): void {
        this.excludedArtists = new Set(artists.map(artistIdentity));
        this.invalidateRanking();
    }
    private allowed(track: Track): boolean {
        return !this.excludedArtists.has(artistIdentity(track.artist));
    }
    private controls: Controls = { ...defaultControls };
    private activity?: Context['activity'];
    private profileCache?: {
        minute: number;
        value: TasteProfile;
    };
    private refreshTask?: Promise<Recommendation[]>;
    private candidateEpoch = 0;
    private anchor?: Track;
    setAnchor(track?: Track): void {
        this.anchor = track;
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
        this.controls = { ...this.controls, ...controls };
        this.invalidateRanking();
    }
    setActivity(activity?: Context['activity']): void {
        this.activity = activity;
        this.invalidateRanking();
    }
    loadFeedback(events: Feedback[]): void {
        this.invalidateRanking();
        this.events = events.slice(-5000);
        this.profileCache = undefined;
        this.recentIds = this.events
            .filter((item) => item.kind === 'play' || item.kind === 'skip' || item.kind === 'complete')
            .filter((item) => this.now() - item.at < 86400000)
            .slice(-100)
            .reverse()
            .map((item) => item.track.id);
        this.recentArtists = this.events
            .filter((item) => item.kind === 'play' || item.kind === 'skip' || item.kind === 'complete')
            .slice(-20)
            .reverse()
            .map((item) => item.track.artist);
    }
    clearCandidates(): void {
        this.invalidateRanking();
        this.candidateEpoch++;
        this.candidates.clear();
        this.reservedIds.clear();
        this.selectionTrail = this.selectionTrail.filter((item) => this.recentIds.includes(item.id));
    }
    removeCandidates(ids: string[]): void {
        this.invalidateRanking();
        for (const id of ids) {
            this.selectionTrail = this.selectionTrail.filter((item) => item.id !== id || this.recentIds.includes(id));
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
        const previous = this.selectionTrail.length;
        this.selectionTrail = this.selectionTrail.filter((item) => item.id !== id || this.recentIds.includes(id));
        if (this.reservedIds.delete(id) || previous !== this.selectionTrail.length) this.invalidateRanking();
    }
    addCandidates(tracks: Track[]): void {
        if (tracks.length) this.invalidateRanking();
        for (const track of tracks) if (track.id && track.artist) this.candidates.set(track.id, track);
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
        if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
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
    private context(includeReserved = true): Context {
        return {
            now: this.now(),
            activity: this.activity,
            recentTrackIds: this.recentIds,
            reservedTrackIds: includeReserved ? [...this.reservedIds] : [],
            allowUnverified: includeReserved,
            recentArtists: [
                ...this.selectionTrail.filter((item) => !this.recentIds.includes(item.id)).map((item) => item.artist),
                ...this.recentArtists,
            ],
            seed: this.rotation + 1,
            sequenceOffset: this.selectionPosition,
            anchor: this.anchor,
            preferenceSignals: recentPreference(this.events, this.now()),
        };
    }
    rank(limit = 10): Recommendation[] {
        const minute = Math.floor(this.now() / 60000);
        const cached = this.rankingCache.get(limit);
        if (cached?.revision === this.rankingRevision && cached.minute === minute) return cached.value.slice();
        const value = recommend(
            [...this.candidates.values()].filter((track) => this.allowed(track)),
            this.events,
            this.controls,
            this.context(),
            limit,
            this.profile(),
        );
        if (this.rankingCache.size >= 8) this.rankingCache.clear();
        this.rankingCache.set(limit, { revision: this.rankingRevision, minute, value });
        return value.slice();
    }
    rankBuffered(tracks: Track[], limit = 10, recentArtists: string[] = []): Recommendation[] {
        const context = this.context(false);
        context.similarityCorpus = [...this.candidates.values()];
        context.recentArtists = [...recentArtists, ...(context.recentArtists || [])];
        return recommend(
            tracks.filter((track) => this.allowed(track)),
            this.events,
            this.controls,
            context,
            limit,
            this.profile(),
        );
    }
    async refresh(): Promise<Recommendation[]> {
        if (this.refreshTask) return this.refreshTask;
        const task = this.refreshOnce();
        this.refreshTask = task;
        try {
            return await task;
        } finally {
            if (this.refreshTask === task) this.refreshTask = undefined;
        }
    }
    private async refreshOnce(): Promise<Recommendation[]> {
        const epoch = this.candidateEpoch;
        const mood = effectiveMood(this.controls, this.context());
        const controls = { ...this.controls, mood, activity: this.activity };
        const rotation = this.rotation++;
        this.invalidateRanking();
        const found = await this.provider.related(
            discoverySeeds(
                {
                    ...this.profile(),
                    positiveSeeds: this.profile().positiveSeeds.filter((track) => this.allowed(track)),
                },
                controls,
                rotation,
                this.anchor && this.allowed(this.anchor) ? this.anchor : undefined,
            ),
        );
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
