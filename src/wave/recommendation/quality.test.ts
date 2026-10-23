import { describe, expect, it, vi } from 'vitest';
import { buildProfile, discoveryQueries, recommend, RecommendationSession } from './index';
import type { Controls, Feedback, Track } from './types';
import { SoundCloudRecommender } from './soundcloudAdapter';
import type ElectronStore from 'electron-store';
import type { WaveCandidate } from '../waveEngine';
const now = Date.UTC(2026, 9, 22);
const settings: Controls = { mood: 'any', tone: 'any', tempo: 'any', discovery: 'balanced' };
const track = (id: string, genre = 'ambient', extra: Partial<Track> = {}): Track => ({
    id,
    title: id,
    artist: id,
    genre,
    ...extra,
});
const vote = (track: Track, kind: Feedback['kind'], at = now): Feedback => ({ track, kind, at, listenedFraction: 1 });
describe('recommendation quality regressions', () => {
    it('removing a heart is neutral and toggling it repeatedly does not poison the profile', () => {
        const seed = track('seed');
        const events = [vote(seed, 'like'), vote(seed, 'unlike')];
        expect(buildProfile(events, now).tokens.get('ambient') || 0).toBe(0);
        expect(buildProfile(events, now).negativeSeeds).toHaveLength(0);
        events.push(vote(seed, 'like'));
        expect(buildProfile(events, now).tokens.get('ambient')).toBe(4);
        expect(buildProfile(events, now).positiveSeeds).toHaveLength(1);
    });
    it('cancels an old explicit dislike after a new like and bounds repeated listening weight', () => {
        const seed = track('seed');
        const profile = buildProfile(
            [vote(seed, 'dislike'), vote(seed, 'like'), ...Array.from({ length: 50 }, () => vote(seed, 'complete'))],
            now,
        );
        expect(profile.negativeSeeds).toHaveLength(0);
        expect(profile.tokens.get('ambient')).toBe(6);
    });
    it('preserves compound genres and puts requested mood, tempo and activity in the first search', () => {
        const profile = buildProfile([vote(track('seed', 'drum and bass'), 'like')], now);
        const queries = discoveryQueries(profile, {
            ...settings,
            mood: 'energetic',
            tempo: 'fast',
            activity: 'workout',
        });
        expect(queries[0]).toContain('drum and bass');
        expect(queries[0]).toContain('energetic fast');
        expect(queries[0]).toContain('workout');
        const pool = [track('dnb', 'DnB'), track('house', 'house')];
        expect(recommend(pool, [], { ...settings, genre: 'drum and bass' }, { now }).map((x) => x.track.id)).toEqual([
            'dnb',
        ]);
    });
    it('rejects a strongly conflicting mood and an explicitly fast unknown-BPM track in slow mode', () => {
        const pool = [
            track('calm', 'ambient'),
            track('rave', 'hardstyle'),
            track('fast', 'electronic', { tags: ['fast'] }),
        ];
        expect(
            recommend(pool, [], { ...settings, mood: 'calm', tempo: 'slow' }, { now }).map((x) => x.track.id),
        ).toEqual(['calm']);
    });
    it('familiar mode may replay an old favorite, but never recent or disliked recordings', () => {
        const favorite = track('favorite'),
            bad = track('bad');
        const events = [vote(favorite, 'like', now - 7 * 86400000), vote(bad, 'dislike')];
        expect(
            recommend([favorite, bad], events, { ...settings, discovery: 'familiar' }, { now }).map((x) => x.track.id),
        ).toEqual(['favorite']);
        expect(
            recommend(
                [favorite],
                events,
                { ...settings, discovery: 'familiar' },
                { now, recentTrackIds: ['favorite'] },
            ),
        ).toHaveLength(0);
        expect(recommend([favorite], events, settings, { now })).toHaveLength(0);
    });
    it('does not replay the same recording under a different URL', () => {
        const one = track('url-1', 'rock', { artist: 'Artist', title: 'Song' });
        const duplicate = { ...one, id: 'url-2', title: 'Song (Official Audio)' };
        expect(recommend([one, duplicate], [], settings, { now })).toHaveLength(1);
        expect(recommend([duplicate], [vote(one, 'complete')], settings, { now })).toHaveLength(0);
        expect(
            recommend([duplicate], [vote(one, 'dislike')], { ...settings, discovery: 'familiar' }, { now }),
        ).toHaveLength(0);
    });
    it('reranks an already reserved buffer after feedback without allowing a repeated finished track', () => {
        const quiet = track('quiet', 'ambient'),
            dance = track('dance', 'house');
        const session = new RecommendationSession({ search: async () => [] }, () => now);
        session.addCandidates([quiet, dance]);
        session.reserve(quiet.id);
        session.reserve(dance.id);
        session.feedback(vote(track('seed', 'house'), 'like'));
        expect(session.rank()).toHaveLength(0);
        expect(session.rankBuffered([quiet, dance])[0].track.id).toBe('dance');
        session.feedback(vote(dance, 'complete'));
        expect(session.rankBuffered([quiet, dance]).map((x) => x.track.id)).toEqual(['quiet']);
    });
    it('shares an in-flight discovery call and invalidates the profile cache on feedback', async () => {
        let resolve!: (tracks: Track[]) => void;
        const search = vi.fn(
            () =>
                new Promise<Track[]>((done) => {
                    resolve = done;
                }),
        );
        const session = new RecommendationSession({ search }, () => now);
        const empty = session.profile();
        const first = session.refresh(),
            second = session.refresh();
        expect(search).toHaveBeenCalledTimes(1);
        resolve([track('result')]);
        await Promise.all([first, second]);
        session.feedback(vote(track('seed'), 'like'));
        expect(session.profile()).not.toBe(empty);
    });
    it('retains enriched BPM across catalog refreshes and rejects new metadata that contradicts settings', () => {
        const values = new Map<string, unknown>();
        const store = {
            get: (k: string) => values.get(k),
            set: (k: string, v: unknown) => values.set(k, v),
        } as unknown as ElectronStore;
        const model = new SoundCloudRecommender(store, 'qa', async () => []);
        const candidate: WaveCandidate = {
            url: 'https://soundcloud.com/artist/track',
            title: 'Track',
            artist: 'Artist',
            sourceRank: 0,
            genre: 'ambient',
            bpm: 80,
            bpmConfidence: 0.75,
        };
        model.addCandidates([candidate]);
        model.addCandidates([{ ...candidate, bpm: undefined, bpmConfidence: undefined }]);
        model.setControls({ ...settings, genre: 'ambient', tempo: 'slow' });
        expect(model.rank()[0].bpm).toBe(80);
        expect(model.rankBuffered([{ ...candidate, bpm: 160 }])).toHaveLength(0);
        expect(model.rankBuffered([{ ...candidate, playability: 'protected' }])).toHaveLength(0);
        model.record(candidate, 'like');
        model.record(candidate, 'unlike');
        model.addCandidates([{ ...candidate, liked: true }]);
        expect(buildProfile(values.get('waveFeedbackV1_qa') as Feedback[], now).likedIds.has(candidate.url)).toBe(
            false,
        );
    });
});
it('rotates a single chosen genre instead of refetching the same first page forever', () => {
    const profile = buildProfile([], now);
    const selected = { ...settings, genre: 'ambient', mood: 'calm' as const };
    const first = discoveryQueries(profile, selected, 0).slice(0, 3),
        second = discoveryQueries(profile, selected, 1).slice(0, 3);
    expect(new Set(first).size).toBe(3);
    expect(second).not.toEqual(first);
    expect(second.every((query) => query.includes('ambient') && query.includes('chill'))).toBe(true);
});
it('an explicit dislike outweighs old repeat listening', () => {
    const seed = track('seed');
    const profile = buildProfile(
        [...Array.from({ length: 40 }, () => vote(seed, 'complete')), vote(seed, 'dislike')],
        now,
    );
    expect(profile.tokens.get('ambient')).toBe(-5);
    expect(profile.negativeSeeds).toHaveLength(1);
});
