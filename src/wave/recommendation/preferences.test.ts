import { describe, it, expect } from 'vitest';
import { recommend, RecommendationSession, discoverySeeds, buildProfile } from './index';
import { languageEvidence } from './preferences';
import type { Controls, Track, Feedback } from './types';
const now = Date.UTC(2026, 9, 22);
const defaults: Controls = { mood: 'any', tempo: 'any', tone: 'any', discovery: 'balanced' };
const track = (id: string, extra: Partial<Track> = {}): Track => ({
    id,
    title: id,
    artist: id,
    genre: 'electronic',
    ...extra,
});
const react = (item: Track, kind: Feedback['kind']): Feedback => ({ track: item, kind, at: now, listenedFraction: 1 });
describe('reference settings semantics', () => {
    it('distinguishes sad and happy independently of energy', () => {
        const sad = track('sad', { tags: ['melancholic'], features: { energy: 0.9 } }),
            happy = track('happy', { tags: ['joyful'], features: { energy: 0.15 } });
        expect(recommend([sad, happy], [], { ...defaults, mood: 'sad' }, { now }).map((x) => x.track.id)).toEqual([
            'sad',
        ]);
        expect(recommend([sad, happy], [], { ...defaults, mood: 'happy' }, { now }).map((x) => x.track.id)).toEqual([
            'happy',
        ]);
    });
    it('does not mistake an alphabet, uploader, arbitrary language value or search phrase for sung language', () => {
        for (const item of [
            track('Русская надпись'),
            track('English Title'),
            track('かな'),
            track('search', { queryHint: 'russian' }),
            track('bad', { language: 'made-up' }),
        ])
            expect(languageEvidence(item).language).toBe('unknown');
    });
    it('requires explicit language evidence and rejects conflicting vocal markers', () => {
        const ru = track('a', { tags: ['russian rap'] }),
            foreign = track('b', { language: 'en' }),
            instrumental = track('c', { tags: ['instrumental'] }),
            unknown = track('d');
        for (const [language, id] of [
            ['ru', 'a'],
            ['foreign', 'b'],
            ['instrumental', 'c'],
        ] as const)
            expect(
                recommend([ru, foreign, instrumental, unknown], [], { ...defaults, language }, { now }).map(
                    (x) => x.track.id,
                ),
            ).toEqual([id]);
        expect(languageEvidence(track('contradiction', { tags: ['instrumental', 'vocals'] })).language).toBe('unknown');
        expect(languageEvidence(track('contradiction', { language: 'ru', tags: ['instrumental'] })).language).toBe(
            'unknown',
        );
    });
    it('allows unknown language for inspection but rejects it before putting a track in the buffer', () => {
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.setControls({ language: 'ru' });
        session.addCandidates([track('unknown')]);
        expect(session.rank()).toHaveLength(1);
        expect(session.rankBuffered([track('unknown')])).toHaveLength(0);
    });
    it('bases popularity on real counts rather than source relevance or search title', () => {
        const popular = track('popular', { playbackCount: 50000, sourceRank: 99 }),
            less = track('small', { playbackCount: 100 }),
            unknown = track('popular hit', { sourceRank: 0 });
        expect(
            recommend([popular, less, unknown], [], { ...defaults, discovery: 'popular' }, { now }).map(
                (x) => x.track.id,
            ),
        ).toEqual(['popular']);
    });
    it('favorites uses positive personal history and excludes strangers and explicit dislikes', () => {
        const liked = track('liked'),
            completed = track('completed'),
            unknown = track('unknown'),
            bad = track('bad');
        const events = [react(liked, 'like'), react(completed, 'complete'), react(bad, 'dislike')];
        expect(
            recommend([liked, completed, unknown, bad], events, { ...defaults, discovery: 'favorites' }, { now })
                .map((x) => x.track.id)
                .sort(),
        ).toEqual(['completed', 'liked']);
    });
    it('keeps a favorite-only stream going without replaying the immediately previous recording', async () => {
        const tracks = [track('one'), track('two'), track('three')];
        const session = new RecommendationSession({ related: async () => tracks }, () => now);
        session.loadFeedback(tracks.map((item) => react(item, 'like')));
        session.addCandidates(tracks);
        session.setControls({ discovery: 'favorites' });
        const chosen: string[] = [];
        for (let i = 0; i < 8; i++) {
            const next = await session.next();
            expect(next).toBeDefined();
            chosen.push(next!.track.id);
            session.feedback(react(next!.track, 'complete'));
        }
        for (let i = 1; i < chosen.length; i++) expect(chosen[i]).not.toBe(chosen[i - 1]);
    });
    it('distinguishes waking, commuting, working, sport and sleep and honors explicit mood', () => {
        const pool = [
            track('wake', { tags: ['morning', 'upbeat'], features: { energy: 0.8 } }),
            track('commute', { tags: ['road', 'travel'], features: { energy: 0.5 } }),
            track('work', { tags: ['focus', 'study'], features: { energy: 0.2 } }),
            track('gym', { tags: ['workout', 'dance'], features: { energy: 0.9 } }),
            track('sleep', { tags: ['sleep', 'drone'], features: { energy: 0.08 } }),
        ];
        for (const [activity, id] of [
            ['wake', 'wake'],
            ['commute', 'commute'],
            ['focus', 'work'],
            ['workout', 'gym'],
            ['sleep', 'sleep'],
        ] as const)
            expect(recommend(pool, [], defaults, { now, activity }, 1)[0].track.id).toBe(id);
        expect(
            recommend(pool, [], { ...defaults, mood: 'energetic' }, { now, activity: 'sleep' }, 1)[0].track.features!
                .energy,
        ).toBeGreaterThan(0.35);
    });
});
it('does not substitute an unknown emotional label for an explicit happy or sad setting in the ready buffer', () => {
    const unknown = track('untagged', { features: { energy: 0.9 } });
    expect(recommend([unknown], [], { ...defaults, mood: 'happy' }, { now })).toHaveLength(0);
    expect(recommend([unknown], [], { ...defaults, mood: 'sad' }, { now })).toHaveLength(0);
    expect(recommend([unknown], [], { ...defaults, mood: 'happy' }, { now, allowUnverified: true })).toHaveLength(1);
});
it('does not repeatedly inspect already checked candidates with unknown requested evidence', () => {
    const checked = track('checked', { catalogChecked: true });
    for (const chosen of [{ language: 'ru' as const }, { mood: 'happy' as const }, { discovery: 'popular' as const }])
        expect(recommend([checked], [], { ...defaults, ...chosen }, { now, allowUnverified: true })).toHaveLength(0);
});
it('prefers a contextually matching favorite as seed without inventing happy tracks', () => {
    const profile = buildProfile(
        [react(track('sad', { tags: ['sad'] }), 'like'), react(track('happy', { tags: ['happy'] }), 'like')],
        now,
    );
    expect(discoverySeeds(profile, { ...defaults, mood: 'happy' })[0].id).toBe('happy');
});
