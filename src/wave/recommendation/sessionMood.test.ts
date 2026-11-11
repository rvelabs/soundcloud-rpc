import { describe, expect, it } from 'vitest';
import { RecommendationSession } from './session';
import { inferSessionMood, sessionMoodScore } from './sessionMood';
import { defaultControls, type Feedback, type Track } from './types';

const now = 10000000;
const track = (id: string, tags: string[] = []): Track => ({ id, title: id, artist: id, genre: 'electronic', tags });
const react = (track: Track, kind: Feedback['kind'] = 'complete', at = now): Feedback => ({
    track,
    kind,
    at,
    listenedFraction: kind === 'skip' ? 0.05 : 1,
    origin: 'wave',
});
const calm = [react(track('calm-1', ['chill']), 'complete', now - 60000), react(track('calm-2', ['lofi']))];

describe('session mood', () => {
    it('waits for independent positive evidence and ignores library imports, start events and titles', () => {
        const first = { ...calm[0], track: { ...calm[0].track, apiId: 42 } };
        const renamed = { ...first, track: { ...first.track, id: 'other-link' } };
        expect(inferSessionMood(defaultControls, { now, sessionReactions: [first, renamed] })).toBeUndefined();
        expect(
            inferSessionMood(defaultControls, {
                now,
                sessionReactions: [
                    ...calm.map((item): Feedback => ({ ...item, kind: 'like', origin: 'library' })),
                    { ...calm[0], kind: 'play', listenedFraction: 0 },
                    react(track('sad')),
                    react(track('energetic')),
                ],
            }),
        ).toBeUndefined();
        expect(inferSessionMood(defaultControls, { now, sessionReactions: calm })).toMatchObject({
            mood: 'calm',
            supportingTracks: 2,
        });
    });
    it('returns to neutral after similar fast skips or stale evidence and abstains on mixed feedback', () => {
        const skips = [react(track('skip1', ['chill']), 'skip'), react(track('skip2', ['ambient']), 'skip')];
        expect(inferSessionMood(defaultControls, { now, sessionReactions: [...calm, skips[0]] })?.mood).toBe('calm');
        expect(inferSessionMood(defaultControls, { now, sessionReactions: [...calm, ...skips] })).toBeUndefined();
        expect(inferSessionMood(defaultControls, { now: now + 13 * 60000, sessionReactions: calm })).toBeUndefined();
        const energetic = [react(track('rave-1', ['rave'])), react(track('rave-2', ['dance']))];
        expect(inferSessionMood(defaultControls, { now, sessionReactions: [...calm, ...energetic] })).toBeUndefined();
        expect(
            inferSessionMood(defaultControls, { now, sessionReactions: [...calm, ...skips, ...energetic] })?.mood,
        ).toBe('energetic');
    });
    it('requires emotion evidence for happy or sad and uses measured tempo only as a weak energy cue', () => {
        const veryFast = { ...track('fast'), features: { bpm: 170, bpmConfidence: 0.9, energy: 0.95 } };
        const sad = [react(track('sad-1', ['melancholic'])), react(track('sad-2', ['грустный']))];
        const inferred = inferSessionMood(defaultControls, { now, sessionReactions: sad });
        expect(inferred?.mood).toBe('sad');
        expect(sessionMoodScore(veryFast, inferred)).toBe(0);
        expect(
            inferSessionMood(defaultControls, {
                now,
                sessionReactions: [react(veryFast), react({ ...veryFast, id: 'another-fast' })],
            }),
        ).toBeUndefined();
        expect(
            sessionMoodScore(veryFast, inferSessionMood(defaultControls, { now, sessionReactions: calm })),
        ).toBeLessThan(0);
    });
    it('reranks a prepared slot and directs discovery, while a manual choice has priority', async () => {
        let roots: Track[] = [];
        const session = new RecommendationSession(
            {
                related: async (seeds) => {
                    roots = seeds;
                    return [];
                },
            },
            () => now,
        );
        const ready = track('ready', ['rave']);
        const calmer = track('calmer', ['ambient']);
        const old = track('old-favorite', ['energetic']);
        session.loadFeedback([{ ...react(old, 'like', now - 86400000), origin: 'library' }, ...calm]);
        session.setAnchor(old);
        session.addCandidates([ready, calmer]);
        session.reserve(ready.id);
        session.accept(ready.id);
        expect(session.rank(1, [ready.id])[0]).toMatchObject({
            track: { id: calmer.id },
            reasons: expect.arrayContaining(['спокойное настроение по прослушиваниям']),
        });
        await session.refresh();
        expect(roots[0].id).not.toBe(old.id);
        session.setControls({ mood: 'energetic' });
        expect(session.listeningMood()).toBeUndefined();
        expect(session.rank(1, [ready.id])[0].track.id).toBe(ready.id);
        expect(
            inferSessionMood({ ...defaultControls, activity: 'workout' }, { now, sessionReactions: calm }),
        ).toBeUndefined();
    });
});
