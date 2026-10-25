import type ElectronStore from 'electron-store';
import type { WaveCandidate, WaveControls } from '../waveEngine';
import { RecommendationSession } from './session';
import { buildProfile, normalize } from './profile';
import type { Controls, Feedback, FeedbackKind, SoundFeatures, Track } from './types';
type Store = Pick<ElectronStore, 'get' | 'set'>;
type Discovery = (seeds: Track[]) => Promise<WaveCandidate[]>;
const kinds = new Set<FeedbackKind>(['like', 'unlike', 'dislike', 'play', 'skip', 'complete']);
export function toTrack(candidate: WaveCandidate, features?: SoundFeatures): Track {
    return {
        id: candidate.url,
        title: candidate.title,
        artist: candidate.artist,
        genre: candidate.genre,
        tags: candidate.tags,
        sourceRank: candidate.sourceRank,
        language: candidate.language,
        playbackCount: candidate.playbackCount,
        catalogChecked: Boolean(candidate.catalogCheckedAt && Date.now() - candidate.catalogCheckedAt < 30 * 60000),
        queryHint: candidate.sourceQuery,
        relatedTo: candidate.relatedTo,
        source: candidate.source,
        features: {
            ...features,
            bpm: candidate.bpm || features?.bpm,
            bpmConfidence: candidate.bpm ? candidate.bpmConfidence : features?.bpmConfidence,
        },
    };
}
function validFeedback(value: unknown): value is Feedback {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<Feedback>;
    return Boolean(
        item.track &&
            typeof item.track.id === 'string' &&
            typeof item.track.title === 'string' &&
            typeof item.track.artist === 'string' &&
            (!item.track.tags ||
                (Array.isArray(item.track.tags) && item.track.tags.every((tag) => typeof tag === 'string'))) &&
            kinds.has(item.kind as FeedbackKind) &&
            typeof item.at === 'number' &&
            Number.isFinite(item.at),
    );
}
export class SoundCloudRecommender {
    private session: RecommendationSession;
    private feedbackEvents: Feedback[];
    private candidates = new Map<string, WaveCandidate>();
    private key: string;
    private cacheKey: string;
    private excludedKey: string;
    private excludedArtists: string[] = [];
    private candidateEpoch = 0;
    getExcludedArtists(): string[] {
        return [...this.excludedArtists];
    }
    excludeArtist(artist: string, excluded: boolean): void {
        const name = artist.trim().slice(0, 200);
        if (!name) return;
        this.excludedArtists = this.excludedArtists.filter((value) => normalize(value) !== normalize(name));
        if (excluded) this.excludedArtists.push(name);
        this.excludedArtists = this.excludedArtists.slice(-500);
        this.store.set(this.excludedKey, this.excludedArtists);
        this.session.setExcludedArtists(this.excludedArtists);
    }
    constructor(
        private store: Store,
        accountId: string,
        discover: Discovery,
        private now: () => number = Date.now,
    ) {
        this.key = `waveFeedbackV1_${accountId}`;
        this.cacheKey = `waveCandidatesV2_${accountId}`;
        const saved = store.get(this.key);
        this.feedbackEvents = Array.isArray(saved) ? saved.filter(validFeedback).slice(-5000) : [];
        if (!Array.isArray(saved)) this.migrateLegacy(accountId);
        this.session = new RecommendationSession(
            {
                related: async (seeds) => {
                    const epoch = this.candidateEpoch;
                    const found = await discover(seeds);
                    if (epoch !== this.candidateEpoch) return [];
                    this.addCandidates(found);
                    return found.flatMap((candidate) => {
                        const accepted = this.candidates.get(candidate.url);
                        return accepted ? [toTrack(accepted)] : [];
                    });
                },
            },
            now,
        );
        this.excludedKey = 'waveExcludedArtistsV1_' + accountId;
        const excluded = store.get(this.excludedKey);
        this.excludedArtists = Array.isArray(excluded)
            ? excluded.filter((value): value is string => typeof value === 'string' && value.length <= 200).slice(-500)
            : [];
        this.session.setExcludedArtists(this.excludedArtists);
        this.session.loadFeedback(this.feedbackEvents);
        this.addCandidates(
            buildProfile(this.feedbackEvents, this.now()).positiveSeeds.map((track) => ({
                url: track.id,
                title: track.title,
                artist: track.artist,
                genre: track.genre,
                tags: track.tags,
                bpm: track.features?.bpm,
                bpmConfidence: track.features?.bpmConfidence,
                sourceRank: 0,
                language: track.language,
                playbackCount: track.playbackCount,
            })),
            false,
        );
        const cached = store.get(this.cacheKey) as
            | {
                  at?: number;
                  tracks?: WaveCandidate[];
              }
            | undefined;
        if (
            cached &&
            typeof cached.at === 'number' &&
            this.now() - cached.at < 7 * 86400000 &&
            Array.isArray(cached.tracks)
        )
            this.addCandidates(cached.tracks, false);
    }
    private migrateLegacy(accountId: string): void {
        const history = this.store.get(`waveHistory_${accountId}`);
        if (!Array.isArray(history)) return;
        for (const item of history.slice(-500) as Array<Record<string, unknown>>) {
            if (
                !item ||
                typeof item.url !== 'string' ||
                typeof item.title !== 'string' ||
                typeof item.artist !== 'string'
            )
                continue;
            const track: Track = {
                id: item.url,
                title: item.title,
                artist: item.artist,
                genre: typeof item.genre === 'string' ? item.genre : undefined,
                tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
                features:
                    item.features && typeof item.features === 'object'
                        ? {
                              energy: Number((item.features as Record<string, unknown>).energy) || undefined,
                              bass: Number((item.features as Record<string, unknown>).bass) || undefined,
                              brightness: Number((item.features as Record<string, unknown>).treble) || undefined,
                              bpm: Number(item.bpm) || undefined,
                              bpmConfidence: item.bpm ? 0.45 : undefined,
                          }
                        : undefined,
            };
            const at = typeof item.updatedAt === 'number' ? item.updatedAt : this.now();
            if (Number(item.plays) > 0) this.feedbackEvents.push({ track, kind: 'play', at, listenedFraction: 0.6 });
            if (Number(item.skips) > 0) this.feedbackEvents.push({ track, kind: 'skip', at, listenedFraction: 0.1 });
            if (item.liked === true) this.feedbackEvents.push({ track, kind: 'like', at });
        }
        this.feedbackEvents = this.feedbackEvents.slice(-5000);
        this.save();
    }
    private save(): void {
        this.store.set(this.key, this.feedbackEvents.slice(-5000));
    }
    setControls(value: WaveControls): void {
        const controls: Controls = {
            mood: value.mood,
            tone: value.tone,
            tempo: value.tempo,
            genre: '',
            discovery: value.discovery || 'balanced',
            language: value.language || 'any',
        };
        this.session.setControls(controls);
        this.session.setActivity(value.activity && value.activity !== 'any' ? value.activity : undefined);
    }
    clearCandidates(): void {
        this.candidateEpoch++;
        this.candidates.clear();
        this.session.clearCandidates();
    }
    setAnchor(candidate?: WaveCandidate): void {
        this.session.setAnchor(candidate ? toTrack(candidate) : undefined);
    }
    addCandidates(tracks: WaveCandidate[], persist = true): void {
        if (persist) this.seedLikes(tracks.filter((track) => track.liked === true));
        const musicTracks = tracks.filter(
            (track) =>
                !['blocked', 'preview', 'protected'].includes(track.playability || '') &&
                (!track.durationSeconds || (track.durationSeconds >= 45 && track.durationSeconds <= 1200)),
        );
        for (const track of tracks)
            if (
                (track.durationSeconds && (track.durationSeconds < 45 || track.durationSeconds > 1200)) ||
                ['blocked', 'preview', 'protected'].includes(track.playability || '')
            ) {
                this.candidates.delete(track.url);
                this.session.removeCandidates([track.url]);
            }
        const merged = musicTracks
            .filter((track) => track.url && track.artist)
            .map((track) => {
                const previous = this.candidates.get(track.url);
                const next = {
                    ...previous,
                    ...Object.fromEntries(Object.entries(track).filter(([, value]) => value !== undefined)),
                } as WaveCandidate;
                if (!track.tags?.length && previous?.tags?.length) next.tags = previous.tags;
                this.candidates.set(track.url, next);
                return next;
            });
        this.session.addCandidates(merged.map((candidate) => toTrack(candidate)));
        if (this.candidates.size > 500) {
            const oldest = [...this.candidates.keys()].slice(0, this.candidates.size - 500);
            for (const id of oldest) this.candidates.delete(id);
            this.session.removeCandidates(oldest);
        }
        if (persist && tracks.length)
            this.store.set(this.cacheKey, {
                at: this.now(),
                tracks: [...this.candidates.values()].slice(-250),
            });
    }
    seedLikes(tracks: WaveCandidate[]): void {
        const liked = new Set(buildProfile(this.feedbackEvents, this.now()).likedIds);
        const explicit = new Set(
            this.feedbackEvents
                .filter((event) => ['like', 'unlike', 'dislike'].includes(event.kind))
                .map((event) => event.track.id),
        );
        const additions: Feedback[] = [];
        for (const candidate of tracks)
            if (!liked.has(candidate.url) && !explicit.has(candidate.url)) {
                additions.push({ track: toTrack(candidate), kind: 'like', at: this.now() });
                liked.add(candidate.url);
            }
        this.recordBatch(additions);
        this.addCandidates(tracks, false);
    }
    seedRecent(tracks: WaveCandidate[]): void {
        const heard = new Set(buildProfile(this.feedbackEvents, this.now()).heardIds);
        const additions: Feedback[] = [];
        for (const candidate of [...tracks].reverse())
            if (!heard.has(candidate.url)) {
                additions.push({ track: toTrack(candidate), kind: 'play', at: this.now(), listenedFraction: 0 });
                heard.add(candidate.url);
            }
        this.recordBatch(additions);
    }
    private recordBatch(events: Feedback[]): void {
        if (!events.length) return;
        this.feedbackEvents.push(...events);
        this.feedbackEvents = this.feedbackEvents.slice(-5000);
        for (const event of events) this.session.feedback(event);
        this.save();
    }
    record(candidate: WaveCandidate, kind: FeedbackKind, listenedFraction?: number, features?: SoundFeatures): void {
        const event: Feedback = { track: toTrack(candidate, features), kind, at: this.now(), listenedFraction };
        this.feedbackEvents.push(event);
        if (this.feedbackEvents.length > 5000) this.feedbackEvents.splice(0, this.feedbackEvents.length - 5000);
        this.session.feedback(event);
        this.save();
    }
    rank(limit = 10): WaveCandidate[] {
        return this.session
            .rank(limit)
            .map(({ track, reasons }): WaveCandidate | undefined => {
                const candidate = this.candidates.get(track.id);
                return candidate ? { ...candidate, recommendationReasons: reasons } : undefined;
            })
            .filter((candidate): candidate is WaveCandidate => Boolean(candidate));
    }
    rankBuffered(tracks: WaveCandidate[], limit = tracks.length, recentArtists: string[] = []): WaveCandidate[] {
        const byId = new Map(
            tracks
                .filter(
                    (track) =>
                        !['blocked', 'preview', 'protected'].includes(track.playability || '') &&
                        (!track.durationSeconds || (track.durationSeconds >= 45 && track.durationSeconds <= 1200)),
                )
                .map((track) => [track.url, track]),
        );
        return this.session
            .rankBuffered(
                [...byId.values()].map((track) => toTrack(track)),
                limit,
                recentArtists,
            )
            .map(({ track, reasons }) => ({ ...byId.get(track.id)!, recommendationReasons: reasons }));
    }
    reserve(candidate: WaveCandidate): void {
        this.session.reserve(candidate.url);
    }
    release(candidate: WaveCandidate): void {
        this.session.release(candidate.url);
    }
    async refresh(): Promise<WaveCandidate[]> {
        await this.session.refresh();
        return this.rank();
    }
    feedbackCount(): number {
        return this.feedbackEvents.length;
    }
    diagnostics(): object {
        return {
            candidates: this.candidates.size,
            feedback: this.feedbackEvents.length,
            styles: [...this.session.profile().styles]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([style]) => style),
            ranked: this.session.rank(5).map((item) => ({
                url: item.track.id,
                score: Math.round(item.score * 100) / 100,
                reasons: item.reasons,
                bpm: item.track.features?.bpm,
                tempoConfirmed: item.measuredTempoMatch,
            })),
        };
    }
}
