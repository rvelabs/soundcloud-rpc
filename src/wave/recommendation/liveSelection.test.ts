import { describe, expect, it } from 'vitest';
import { RecommendationSession } from './session';
import { buildProfile } from './profile';
import { discoverySeeds } from './discovery';
import { recommend } from './ranker';
import { recentPreference, recentReactions } from './sessionSignals';
import type { Controls, Feedback, Track } from './types';

const now = Date.UTC(2026, 9, 29);
const controls: Controls = { mood: 'any', tone: 'any', tempo: 'any', discovery: 'new' };
const track = (id: string, genre = 'ambient', bpm?: number): Track => ({
    id,
    title: id,
    artist: id,
    genre,
    features: bpm ? { bpm, bpmConfidence: 0.9 } : undefined,
});
const feedback = (track: Track, kind: Feedback['kind'], at = now, listenedFraction?: number): Feedback => ({
    track,
    kind,
    at,
    listenedFraction,
});

describe('live listening direction', () => {
    it('uses imported library hearts for long-term taste without treating them as current listening', () => {
        const events: Feedback[] = [
            { ...feedback(track('library-1'), 'like'), origin: 'library' },
            { ...feedback(track('library-2'), 'like'), origin: 'library' },
            feedback(track('today', 'jungle'), 'complete', now, 1),
        ];
        expect(buildProfile(events, now).likedIds.size).toBe(2);
        expect(recentPreference(events, now).has('ambient')).toBe(false);
        expect(recentPreference(events, now).get('jungle')).toBe(0.5);
    });
    it('retains a heart after completion without multiplying repeated playback notifications', () => {
        const seed = track('heart');
        const events = [feedback(seed, 'like', now - 60000), feedback(seed, 'complete', now, 1)];
        expect(recentPreference(events, now).get('ambient')).toBe(1);
        expect(
            recentPreference(
                [...events, ...Array.from({ length: 20 }, () => feedback(seed, 'play', now, 0.9))],
                now,
            ).get('ambient'),
        ).toBe(1);
        expect(recentPreference([...events, feedback(seed, 'unlike')], now).get('ambient')).toBe(0);
    });

    it('uses substantial listening as a current interest but leaves autoplay starts neutral', () => {
        const seed = track('listened');
        expect(recentPreference([feedback(seed, 'play', now, 0.02)], now).size).toBe(0);
        expect(recentPreference([feedback(seed, 'play', now, 0.8)], now).get('ambient')).toBe(0.5);
    });

    it('does not discover more music from a favorite that was just quickly skipped', async () => {
        const old = track('old-favorite');
        const alternate = track('other-interest', 'jungle');
        let seeds: Track[] = [];
        const session = new RecommendationSession(
            {
                related: async (value) => {
                    seeds = value;
                    return [];
                },
            },
            () => now,
        );
        session.loadFeedback([feedback(old, 'like', now - 86400000), feedback(alternate, 'like', now - 86400000)]);
        session.setAnchor(old);
        session.feedback(feedback(old, 'skip', now, 0.03));
        await session.refresh();
        expect(seeds.map((item) => item.id)).toEqual([alternate.id]);
        expect(session.profile().likedIds.has(old.id)).toBe(true);
    });

    it('moves discovery away from a rejected pattern temporarily without deleting taste history', async () => {
        let clock = now;
        let seeds: Track[] = [];
        const session = new RecommendationSession(
            {
                related: async (value) => {
                    seeds = value;
                    return [];
                },
            },
            () => clock,
        );
        const favorites = [track('ambient-favorite'), track('jungle-favorite', 'jungle')];
        session.loadFeedback(favorites.map((seed) => feedback(seed, 'like', now - 86400000)));
        for (let index = 0; index < 3; index++) session.feedback(feedback(track('skip-' + index), 'skip', now, 0.04));
        await session.refresh();
        expect(seeds.every((seed) => seed.genre === 'jungle')).toBe(true);
        expect(session.profile().likedIds.size).toBe(2);
        clock += 46 * 60000;
        await session.refresh();
        expect(seeds.some((seed) => seed.genre === 'ambient')).toBe(true);
    });

    it('does not interpret one skip as rejecting every other recording in a style', () => {
        const old = track('favorite');
        const events = [feedback(old, 'like', now - 86400000), feedback(track('skip'), 'skip', now, 0.05)];
        expect(
            discoverySeeds(buildProfile(events, now), controls, 0, undefined, {
                now,
                sessionReactions: recentReactions(events, now),
                preferenceSignals: recentPreference(events, now),
            }).map((seed) => seed.id),
        ).toContain(old.id);
    });

    it('looks beyond different artists in the same style when the listener likes several styles', () => {
        const seeds = [track('ambient-1'), track('ambient-2'), track('ambient-3'), track('jungle', 'jungle')];
        const result = discoverySeeds(
            buildProfile(
                seeds.map((seed) => feedback(seed, 'like')),
                now,
            ),
            controls,
            0,
            seeds[0],
        );
        expect(result).toHaveLength(3);
        expect(result[0].id).toBe(seeds[0].id);
        expect(result.some((seed) => seed.genre === 'jungle')).toBe(true);
    });

    it('never reintroduces an excluded artist through recent positive feedback', async () => {
        let seeds: Track[] = [];
        const session = new RecommendationSession(
            {
                related: async (value) => {
                    seeds = value;
                    return [];
                },
            },
            () => now,
        );
        session.feedback(feedback(track('excluded'), 'like'));
        session.setExcludedArtists(['excluded']);
        await session.refresh();
        expect(seeds).toEqual([]);
    });

    it('stops rewarding a recommendation sourced only from a rejected seed', () => {
        const rejected = track('rejected', 'electronic');
        const accepted = track('accepted', 'electronic');
        const candidates = [
            { ...track('bad-neighbor', 'electronic'), source: 'related' as const, relatedTo: [rejected.id] },
            { ...track('good-neighbor', 'electronic'), source: 'related' as const, relatedTo: [accepted.id] },
        ];
        const events = [
            feedback(rejected, 'like', now - 86400000),
            feedback(accepted, 'like', now - 86400000),
            feedback(rejected, 'skip', now, 0.05),
        ];
        const ranked = recommend(candidates, events, controls, { now });
        expect(ranked[0].track.id).toBe('good-neighbor');
        expect(ranked.find((item) => item.track.id === 'bad-neighbor')?.reasons).toContain(
            'ослаблена связь с недавно отвергнутой музыкой',
        );
    });

    it('prepares a transition from the last accepted future track rather than from the currently playing one', () => {
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.setControls(controls);
        session.setAnchor(track('current', 'ambient', 70));
        const pending = track('pending', 'ambient', 180);
        session.addCandidates([pending, track('slow-option', 'ambient', 72), track('fast-option', 'ambient', 182)]);
        session.reserve(pending.id);
        session.accept(pending.id);
        expect(session.rank(1)[0].track.id).toBe('fast-option');
    });

    it('evaluates transitions between tracks of a batch rather than against a fixed original anchor', () => {
        const first = { ...track('first', 'ambient', 80), source: 'related' as const, relatedTo: ['seed'] };
        const result = recommend(
            [first, track('next-slow', 'ambient', 82), track('next-fast', 'ambient', 180)],
            [],
            controls,
            { now, anchor: track('anchor', 'ambient', 190) },
        );
        expect(result.map((item) => item.track.id)).toEqual(['first', 'next-slow', 'next-fast']);
    });

    it('refreshes changed directions with bounded requests and a shorter cooldown after repeated rejection', async () => {
        let clock = now;
        let calls = 0;
        const session = new RecommendationSession(
            {
                related: async () => {
                    calls++;
                    return [];
                },
            },
            () => clock,
        );
        session.feedback(feedback(track('favorite'), 'like', clock));
        expect(await session.refreshIfNeeded()).toBe(true);
        expect(await session.refreshIfNeeded()).toBe(false);
        clock += 10000;
        session.feedback(feedback(track('skip-1'), 'skip', clock, 0.02));
        expect(await session.refreshIfNeeded()).toBe(false);
        clock += 6000;
        session.feedback(feedback(track('skip-2'), 'skip', clock, 0.03));
        expect(await session.refreshIfNeeded()).toBe(true);
        clock += 61000;
        expect(await session.refreshIfNeeded()).toBe(false);
        session.feedback(feedback(track('new-interest', 'jungle'), 'like', clock));
        expect(await session.refreshIfNeeded()).toBe(true);
        expect(calls).toBe(3);
        session.setControls({ discovery: 'favorites' });
        clock += 61000;
        session.feedback(feedback(track('another-interest', 'house'), 'like', clock));
        expect(await session.refreshIfNeeded()).toBe(false);
        expect(calls).toBe(3);
    });

    it('shares background discovery and keeps ready ranks usable while the provider is slow', async () => {
        let finish!: (tracks: Track[]) => void;
        let calls = 0;
        const session = new RecommendationSession(
            {
                related: () => {
                    calls++;
                    return new Promise((resolve) => {
                        finish = resolve;
                    });
                },
            },
            () => now,
        );
        session.feedback(feedback(track('seed'), 'like'));
        session.addCandidates([track('ready')]);
        const refresh = session.refreshIfNeeded();
        expect(await session.refreshIfNeeded()).toBe(false);
        expect(session.rank(1)[0].track.id).toBe('ready');
        session.clearCandidates();
        finish([track('obsolete')]);
        expect(await refresh).toBe(false);
        expect(session.rank()).toHaveLength(0);
        expect(calls).toBe(1);
    });
});
