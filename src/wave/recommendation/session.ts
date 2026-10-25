import { effectiveMood } from './preferences';
import { buildProfile, normalize } from './profile';
import type { TasteProfile } from './profile';
import { discoverySeeds } from './discovery';
import { recommend } from './ranker';
import { defaultControls } from './types';
import type { Context, Controls, Feedback, Recommendation, Track } from './types';
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
    private excludedArtists = new Set<string>();
    setExcludedArtists(artists: string[]): void {
        this.excludedArtists = new Set(artists.map(normalize));
    }
    private allowed(track: Track): boolean {
        return !this.excludedArtists.has(normalize(track.artist));
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
    }
    setActivity(activity?: Context['activity']): void {
        this.activity = activity;
    }
    loadFeedback(events: Feedback[]): void {
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
        this.candidateEpoch++;
        this.candidates.clear();
        this.reservedIds.clear();
    }
    removeCandidates(ids: string[]): void {
        for (const id of ids) {
            this.candidates.delete(id);
            this.reservedIds.delete(id);
        }
    }
    reserve(id: string): void {
        this.reservedIds.add(id);
        if (this.reservedIds.size > 1000) this.reservedIds.delete(this.reservedIds.values().next().value!);
    }
    release(id: string): void {
        this.reservedIds.delete(id);
    }
    addCandidates(tracks: Track[]): void {
        for (const track of tracks) if (track.id && track.artist) this.candidates.set(track.id, track);
    }
    feedback(
        item: Omit<Feedback, 'at'> & {
            at?: number;
        },
    ): void {
        const event = { ...item, at: item.at ?? this.now() };
        this.events.push(event);
        this.profileCache = undefined;
        if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
        if (event.kind === 'play' || event.kind === 'skip' || event.kind === 'complete') {
            this.reservedIds.delete(event.track.id);
            this.recentIds = this.recentIds.filter((id) => id !== event.track.id);
            this.recentIds.unshift(event.track.id);
            if (this.recentArtists[0] !== event.track.artist) this.recentArtists.unshift(event.track.artist);
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
            recentArtists: this.recentArtists,
            seed: this.rotation + 1,
        };
    }
    rank(limit = 10): Recommendation[] {
        return recommend(
            [...this.candidates.values()].filter((track) => this.allowed(track)),
            this.events,
            this.controls,
            this.context(),
            limit,
            this.profile(),
        );
    }
    rankBuffered(tracks: Track[], limit = 10, recentArtists: string[] = []): Recommendation[] {
        const context = this.context(false);
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
        if (selected) this.reservedIds.add(selected.track.id);
        return selected;
    }
}
