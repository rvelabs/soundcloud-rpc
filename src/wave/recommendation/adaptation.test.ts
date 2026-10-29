import { describe, expect, it } from 'vitest';
import { RecommendationSession } from './session';
import { recommend } from './ranker';
import { artistIdentity, recentPreference, transitionAffinity } from './sessionSignals';
import { preferenceEvidence } from './evidence';
import { discoverySeeds } from './discovery';
import { buildProfile } from './profile';
import type { Controls, Feedback, Track } from './types';
const now = 10 ** 12;
const controls: Controls = { mood: 'any', tone: 'any', tempo: 'any', discovery: 'new' };
const track = (id: string, artist = id, genre = 'ambient'): Track => ({ id, title: 'Track ' + id, artist, genre });
describe('session adaptation and queue diversity', () => {
    it('withdraws cancelled future slots from the balanced pattern without counting a retry twice', () => {
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.setControls({ ...controls, discovery: 'balanced' });
        const familiar = Array.from({ length: 8 }, (_, index) => track('known-' + index));
        session.loadFeedback(
            familiar.map((item) => ({ track: item, kind: 'complete', at: now - 8 * 86400000, listenedFraction: 1 })),
        );
        session.addCandidates([...familiar, ...Array.from({ length: 20 }, (_, index) => track('new-' + index))]);
        for (let index = 0; index < 2; index++) {
            const next = session.rank(1)[0].track;
            expect(next.id).toMatch(/^new-/);
            session.reserve(next.id);
            session.accept(next.id);
        }
        const cancelled = session.rank(1)[0].track;
        expect(cancelled.id).toMatch(/^known-/);
        session.reserve(cancelled.id);
        session.accept(cancelled.id);
        session.release(cancelled.id);
        const replacement = session.rank(1)[0].track;
        expect(replacement.id).toMatch(/^known-/);
        session.reserve(replacement.id);
        session.accept(replacement.id);
        expect(session.rank(1)[0].track.id).toMatch(/^new-/);
    });
    it('preserves explicit dislike strength across the ensuing skip and makes unlike neutral', () => {
        const seed = track('seed');
        expect(
            recentPreference(
                [
                    { track: seed, kind: 'dislike', at: now - 1000 },
                    { track: seed, kind: 'skip', listenedFraction: 0.01, at: now },
                ],
                now,
            ).get('ambient'),
        ).toBeLessThan(-1.4);
        expect(
            recentPreference(
                [
                    { track: seed, kind: 'like', at: now - 1000 },
                    { track: seed, kind: 'unlike', at: now },
                ],
                now,
            ).get('ambient'),
        ).toBe(0);
    });
    it('keeps a new reaction to an older track among the latest session signals', () => {
        const old = track('old', 'Old artist', 'oldstyle');
        const events: Feedback[] = [{ track: old, kind: 'like', at: now - 30 * 60000 }];
        for (let index = 0; index < 15; index++)
            events.push({ track: track('other-' + index), kind: 'like', at: now - 20 * 60000 + index });
        events.push({ track: old, kind: 'skip', listenedFraction: 0.05, at: now });
        expect(recentPreference(events, now).get('oldstyle')).toBeLessThan(0);
    });
    it('recognizes punctuation variants of an artist when preparing a batch', () => {
        const pool = Array.from({ length: 30 }, (_, index) =>
            track(String(index), index < 20 ? (index % 2 ? 'Same.Artist' : 'Same Artist') : 'Other ' + index),
        );
        const list = recommend(pool, [], controls, { now }, 10);
        expect(
            list.every(
                (item, index) =>
                    index === 0 || artistIdentity(item.track.artist) !== artistIdentity(list[index - 1].track.artist),
            ),
        ).toBe(true);
    });
    it('changes direction after consecutive quick skips while keeping the long-term taste intact', () => {
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.setControls(controls);
        const seed = track('seed');
        session.loadFeedback([{ track: seed, kind: 'like', at: now - 86400000 }]);
        const candidates = Array.from({ length: 40 }, (_, index) => ({
            ...track('next-' + index, 'Artist ' + index, index < 20 ? 'ambient' : 'jungle'),
            source: 'related' as const,
            relatedTo: [seed.id],
        }));
        session.addCandidates(candidates);
        expect(session.rank(1)[0].track.genre).toBe('ambient');
        for (let index = 0; index < 3; index++)
            session.feedback({ track: candidates[index], kind: 'skip', listenedFraction: 0.05, at: now });
        expect(session.rank(1)[0].track.genre).toBe('jungle');
        expect(session.profile().likedIds.has(seed.id)).toBe(true);
    });
    it('does not dilute a long batch into unrelated styles to manufacture diversity', () => {
        const seed = track('seed');
        const feedback: Feedback[] = [{ track: seed, kind: 'like', at: now - 86400000 }];
        const candidates = Array.from({ length: 160 }, (_, index) => ({
            ...track('candidate-' + index, 'Artist ' + (index % 35), index < 100 ? 'ambient' : 'metal'),
            source: 'related' as const,
            relatedTo: [seed.id],
        }));
        const list = recommend(candidates, feedback, controls, { now }, 60);
        expect(list).toHaveLength(60);
        expect(new Set(list.map((item) => item.track.id)).size).toBe(60);
        expect(list.filter((item) => item.track.genre === 'ambient').length).toBeGreaterThanOrEqual(54);
    });
    it('does not reject calm music just because its mastering is loud', () => {
        const loud = { ...track('loud'), features: { energy: 0.99, source: 'legacy' as const } };
        expect(recommend([loud], [], { ...controls, mood: 'calm' }, { now })).toHaveLength(1);
    });
    it('accounts for upcoming selections before playback feedback exists', () => {
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.setControls(controls);
        session.addCandidates(
            Array.from({ length: 60 }, (_, i) => track(String(i), i < 45 ? 'Dominant artist' : 'Other ' + i)),
        );
        const selected: string[] = [];
        for (let i = 0; i < 12; i++) {
            const next = session.rank(1)[0].track;
            selected.push(next.artist);
            session.reserve(next.id);
            session.accept(next.id);
        }
        expect(selected.every((artist, index) => index === 0 || artist !== selected[index - 1])).toBe(true);
        for (let i = 0; i < selected.length - 5; i++)
            expect(
                selected.slice(i, i + 6).filter((artist) => artist === 'Dominant artist').length,
            ).toBeLessThanOrEqual(2);
    });
    it('responds to a pattern of skips without treating one skip as a permanent genre dislike', () => {
        const likes: Feedback[] = [{ track: track('liked', 'Seed'), kind: 'like', at: now - 86400000 }];
        const skip = (id: string): Feedback => ({ track: track(id), kind: 'skip', listenedFraction: 0.05, at: now });
        const one = recentPreference([skip('one')], now).get('ambient')!;
        const many = recentPreference([skip('one'), skip('two'), skip('three')], now).get('ambient')!;
        expect(many).toBeLessThan(one);
        expect(recentPreference([skip('one')], now + 46 * 60000).size).toBe(0);
        const pool = [track('fit'), track('unrelated', 'Other', 'metal')];
        expect(recommend(pool, [...likes, skip('one')], controls, { now }, 1)[0].track.id).toBe('fit');
    });
    it('does not reward missing tags as a new musical direction', () => {
        const seed = track('seed');
        const unknown = { ...track('empty'), genre: undefined };
        expect(
            recommend([unknown, track('related')], [{ track: seed, kind: 'like', at: now }], controls, { now }, 1)[0]
                .track.id,
        ).toBe('related');
    });
    it('keeps the current acceptable recording in discovery alongside independent taste seeds', () => {
        const events: Feedback[] = Array.from({ length: 8 }, (_, i) => ({
            track: track(String(i)),
            kind: 'like',
            at: now,
        }));
        const anchor = track('current', 'Current artist');
        for (let rotation = 0; rotation < 6; rotation++) {
            const seeds = discoverySeeds(buildProfile(events, now), controls, rotation, anchor);
            expect(seeds[0].id).toBe(anchor.id);
            expect(new Set(seeds.map((item) => item.artist)).size).toBe(3);
        }
    });
    it('uses trustworthy tempo continuity softly and labels unknown preference evidence', () => {
        const anchor = { ...track('anchor'), features: { bpm: 120, bpmConfidence: 0.9 } };
        expect(
            transitionAffinity({ ...track('near'), features: { bpm: 122, bpmConfidence: 0.9 } }, anchor),
        ).toBeGreaterThan(transitionAffinity({ ...track('far'), features: { bpm: 190, bpmConfidence: 0.9 } }, anchor));
        expect(transitionAffinity({ ...track('unknown'), features: { bpm: 122, bpmConfidence: 0.1 } }, anchor)).toBe(0);
        expect(
            preferenceEvidence(
                track('no-data'),
                { ...controls, tempo: 'fast', mood: 'happy', tone: 'bass', language: 'ru' },
                { now },
            ).every((item) => item.source === 'unknown'),
        ).toBe(true);
    });
});
