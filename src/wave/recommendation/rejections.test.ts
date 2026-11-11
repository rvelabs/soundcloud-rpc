import { describe, expect, it } from 'vitest';
import { buildProfile, explicitlyRejected, retainFeedback } from './profile';
import { recommend } from './ranker';
import { RecommendationSession } from './session';
import { defaultControls, type Feedback, type Track } from './types';
import { SoundCloudRecommender } from './soundcloudAdapter';
import type { DataStore } from '../../storage/asyncDataStore';

const now = 1000000000;
const track = (id: string, extra: Partial<Track> = {}): Track => ({
    id,
    title: id,
    artist: id,
    genre: 'house',
    ...extra,
});
const react = (track: Track, kind: Feedback['kind'], at = now): Feedback => ({ track, kind, at });
const sound = (bass: number, brightness: number) => ({
    source: 'media-element-v1' as const,
    sampleSeconds: 30,
    bass,
    brightness,
});

describe('explicit music rejection', () => {
    it('blocks a changed permalink by API identity and permits a deliberate later like', () => {
        const original = track('old-url', { apiId: 42 });
        const renamed = track('new-url', { apiId: 42, title: 'Different metadata' });
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.feedback(react(original, 'dislike'));
        expect(session.accepts(renamed)).toBe(false);
        expect(recommend([renamed], [react(original, 'dislike')], defaultControls, { now })).toEqual([]);
        session.feedback(react(renamed, 'like', now + 1));
        expect(session.accepts(renamed)).toBe(true);
    });
    it('blocks reuploads credited in the title without merging a distinct remix', () => {
        const rejected = track('original', { title: 'The Song', artist: 'Real Artist' });
        const copy = track('upload', { title: 'Real Artist — The Song (Official Audio)', artist: 'Uploader' });
        const remix = track('remix', { title: 'Real Artist — The Song (Different Remix)', artist: 'Uploader' });
        const profile = buildProfile([react(rejected, 'dislike')], now);
        expect(explicitlyRejected(copy, profile)).toBe(true);
        expect(explicitlyRejected(remix, profile)).toBe(false);
    });
    it('does not use listening through an older permalink to keep a rejected recording as a positive root', () => {
        const old = track('old-url', { apiId: 42 });
        const changed = track('new-url', { apiId: 42 });
        const profile = buildProfile([react(old, 'complete', now - 1), react(changed, 'dislike')], now);
        expect(profile.positiveSeeds).toEqual([]);
        expect(profile.trustedSeeds).toEqual([]);
        expect(profile.dislikedIds.has(old.id)).toBe(true);
    });
    it('withdraws a rejected discovery root and refuses candidates linked only to it', async () => {
        const seed = track('seed');
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.feedback(react(seed, 'like', now - 1));
        await session.refresh();
        expect(session.discoveryRoots().map((item) => item.id)).toContain(seed.id);
        session.feedback(react(seed, 'dislike'));
        expect(session.discoveryRoots()).toEqual([]);
        const neighbor = track('neighbor', { relatedTo: [seed.id], source: 'related' });
        expect(session.accepts(neighbor)).toBe(false);
        expect(recommend([neighbor], [react(seed, 'dislike')], defaultControls, { now })).toEqual([]);
    });
    it('learns repeated measured sound rejection inside a genre and keeps its other sound available after restart', () => {
        const favorite = track('favorite', { features: sound(0.1, 0.8) });
        const bad = [track('bad1', { features: sound(0.8, 0.1) }), track('bad2', { features: sound(0.82, 0.12) })];
        const candidates = [
            track('more-bass', { features: sound(0.8, 0.1) }),
            track('bright', { features: sound(0.1, 0.8) }),
        ];
        const events = [
            react(favorite, 'like', now - 7 * 86400000),
            ...bad.map((item) => react(item, 'dislike', now - 86400000)),
        ];
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.loadFeedback(JSON.parse(JSON.stringify(events)));
        session.addCandidates(candidates);
        expect(session.rank().map((item) => item.track.id)).toEqual(['bright']);
    });
    it('does not blacklist an entire genre after one dislike or turn ordinary skips into permanent bans', () => {
        const candidate = track('candidate');
        for (const events of [
            [react(track('one'), 'dislike')],
            [react(track('one'), 'skip'), react(track('two'), 'skip')],
        ])
            expect(recommend([candidate], events, defaultControls, { now })).toHaveLength(1);
    });
    it('retains a positively endorsed sound despite conflicting dislikes and does not invent analysis for unknown audio', () => {
        const favorite = track('favorite', { features: sound(0.8, 0.1) });
        const events = [
            react(favorite, 'like'),
            react(track('bad1', { features: sound(0.8, 0.1) }), 'dislike'),
            react(track('bad2', { features: sound(0.8, 0.1) }), 'dislike'),
        ];
        const pool = [track('endorsed-sound', { features: sound(0.8, 0.1) }), track('unknown')];
        expect(new Set(recommend(pool, events, defaultControls, { now }).map((item) => item.track.id))).toEqual(
            new Set(pool.map((item) => item.id)),
        );
    });
    it('does not count repeated clicks on the same API recording as multiple rejected examples', () => {
        const events = [1, 2, 3].map((n) =>
            react(track('alias-' + n, { apiId: 42, features: sound(0.8, 0.1) }), 'dislike'),
        );
        expect(recommend([track('new', { features: sound(0.8, 0.1) })], events, defaultControls, { now })).toHaveLength(
            1,
        );
    });
    it('keeps older explicit dislikes through history compaction and adapter reload', () => {
        const rejected = track('old-rejected');
        const events = [
            react(rejected, 'dislike', 0),
            ...Array.from({ length: 5000 }, (_, i) => react(track('play-' + i), 'play', i + 1)),
        ];
        const kept = retainFeedback(events);
        expect(kept).toHaveLength(5000);
        expect(kept[0].kind).toBe('dislike');
        const values = new Map<string, unknown>([['waveFeedbackV1_user', events]]);
        const store = {
            get: (key: string) => values.get(key),
            set: (key: string, value: unknown) => values.set(key, value),
        } as unknown as DataStore;
        const model = new SoundCloudRecommender(
            store,
            'user',
            async () => [],
            () => now,
        );
        expect(model.accepts({ url: rejected.id, title: rejected.title, artist: rejected.artist, sourceRank: 0 })).toBe(
            false,
        );
        expect(buildProfile(kept, now).dislikedIds.has(rejected.id)).toBe(true);
    });
    it('repeated creator rejection lowers that creator without a blanket artist ban', () => {
        const candidate = track('third', { artist: 'Unwanted creator', uploaderId: 10 });
        const bad = [
            track('first', { artist: candidate.artist, uploaderId: 10 }),
            track('second', { artist: candidate.artist, uploaderId: 10 }),
        ];
        const before = recommend([candidate], [], defaultControls, { now })[0].score;
        const after = recommend(
            [candidate],
            bad.map((item) => react(item, 'dislike')),
            defaultControls,
            { now },
        )[0];
        expect(after.score).toBeLessThan(before - 2);
        expect(after.reasons).toContain('учтены повторные «не подходит»');
    });
});
