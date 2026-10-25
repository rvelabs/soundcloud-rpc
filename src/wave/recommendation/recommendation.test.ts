import { describe, expect, it } from 'vitest';
import { buildProfile, discoverySeeds, recommend, RecommendationSession } from './index';
import type { Controls, Feedback, Track } from './index';
const now = Date.UTC(2026, 9, 17);
const controls: Controls = { mood: 'any', tempo: 'any', tone: 'any', genre: '', discovery: 'balanced' };
const track = (id: string, artist: string, genre: string, bpm?: number, energy?: number): Track => ({
    id,
    title: id,
    artist,
    genre,
    features: { bpm, bpmConfidence: bpm ? 0.9 : undefined, energy },
});
const event = (item: Track, kind: Feedback['kind'], listenedFraction?: number): Feedback => ({
    track: item,
    kind,
    listenedFraction,
    at: now,
});
describe('standalone recommendation modules', () => {
    it('learns from a liked genre but never replays the liked track', () => {
        const seed = track('liked', 'A', 'shoegaze');
        const candidates = [seed, track('new-shoegaze', 'B', 'shoegaze'), track('other', 'C', 'house')];
        const result = recommend(candidates, [event(seed, 'like')], controls, { now });
        expect(result[0].track.id).toBe('new-shoegaze');
        expect(result.map((item) => item.track.id)).not.toContain('liked');
    });
    it('moves away from immediate skips and reinforces completed tracks', () => {
        const skipped = track('skipped', 'A', 'ambient');
        const completed = track('completed', 'B', 'jungle');
        const candidates = [track('new-ambient', 'C', 'ambient'), track('new-jungle', 'D', 'jungle')];
        const result = recommend(
            candidates,
            [event(skipped, 'skip', 0.05), event(completed, 'complete', 1)],
            controls,
            { now },
        );
        expect(result[0].track.id).toBe('new-jungle');
    });
    it('treats an early play as neutral instead of a positive vote', () => {
        expect(buildProfile([event(track('a', 'A', 'metal'), 'play', 0.05)], now).tokens.size).toBe(0);
    });
    it('changes mood and tempo using measured features; rejects measured BPM outside the range', () => {
        const candidates = [
            track('quiet', 'A', 'electronic', 82, 0.16),
            track('drive', 'B', 'electronic', 158, 0.91),
            track('unknown', 'C', 'electronic'),
        ];
        const calm = recommend(candidates, [], { ...controls, mood: 'calm', tempo: 'slow' }, { now });
        const energetic = recommend(candidates, [], { ...controls, mood: 'energetic', tempo: 'fast' }, { now });
        expect(calm.map((entry) => entry.track.id)).toEqual(['quiet']);
        expect(energetic.map((entry) => entry.track.id)).toEqual(['drive']);
        expect(calm[0].measuredTempoMatch).toBe(true);
    });
    it('labels missing BPM as uncertain when no measured match exists', () => {
        const result = recommend(
            [track('wrong', 'A', 'techno', 165), track('unknown', 'B', 'ambient')],
            [],
            { ...controls, tempo: 'slow' },
            { now },
        );
        expect(result.map((entry) => entry.track.id)).toEqual(['unknown']);
        expect(result[0].measuredTempoMatch).toBe(false);
    });
    it('uses explicit listening context without overriding a chosen mood', () => {
        const candidates = [
            track('quiet', 'A', 'electronic', undefined, 0.1),
            track('drive', 'B', 'electronic', undefined, 0.9),
        ];
        expect(recommend(candidates, [], controls, { now, activity: 'workout' }, 1)[0].track.id).toBe('drive');
        expect(
            recommend(candidates, [], { ...controls, mood: 'calm' }, { now, activity: 'workout' }, 1)[0].track.id,
        ).toBe('quiet');
    });
    it('does not treat an uncertain BPM estimate as a verified tempo', () => {
        const uncertain = {
            ...track('uncertain', 'A', 'ambient', 90),
            features: { bpm: 90, bpmConfidence: 0.3, energy: 0.2 },
        };
        const result = recommend([uncertain], [], { ...controls, tempo: 'slow' }, { now });
        expect(result[0].track.id).toBe('uncertain');
        expect(result[0].measuredTempoMatch).toBe(false);
    });
    it('avoids an artist already in the session when comparable alternatives exist', () => {
        const seed = track('seed', 'A', 'rock');
        const result = recommend(
            [track('same', 'A', 'rock'), track('different', 'B', 'rock')],
            [event(seed, 'like')],
            controls,
            { now, recentArtists: ['A'] },
            1,
        );
        expect(result[0].track.artist).toBe('B');
    });
    it('uses a liked recording as discovery seed without turning metadata into search words', () => {
        const seed = track('favorite', 'Specific Artist', 'dream pop');
        expect(discoverySeeds(buildProfile([event(seed, 'like')], now), controls)).toEqual([
            expect.objectContaining({ id: seed.id, artist: seed.artist }),
        ]);
    });
    it('changes the selection when the listener asks for a specific genre', () => {
        const candidates = [track('rock', 'A', 'rock'), track('ambient', 'B', 'ambient')];
        const result = recommend(candidates, [], { ...controls, genre: 'ambient' }, { now }, 1);
        expect(result[0].track.id).toBe('ambient');
        expect(result.every((item) => item.track.genre === 'ambient')).toBe(true);
    });
    it('uses tags for tone and tempo when audio features are not available', () => {
        const catalog = [
            { ...track('sub-bass', 'A', 'electronic'), tags: ['bass', 'slow'] },
            { ...track('bright-synth', 'B', 'electronic'), tags: ['bright', 'fast'] },
        ];
        expect(recommend(catalog, [], { ...controls, tone: 'bass', tempo: 'slow' }, { now }, 1)[0].track.id).toBe(
            'sub-bass',
        );
        expect(recommend(catalog, [], { ...controls, tone: 'bright', tempo: 'fast' }, { now }, 1)[0].track.id).toBe(
            'bright-synth',
        );
    });
    it('distinguishes work, rest and sport with the same mood setting', () => {
        const catalog = [
            { ...track('study', 'A', 'electronic'), tags: ['instrumental', 'focus'] },
            { ...track('rest', 'B', 'electronic'), tags: ['relax', 'chill'] },
            { ...track('gym', 'C', 'electronic'), tags: ['workout', 'dance'] },
        ];
        expect(recommend(catalog, [], controls, { now, activity: 'focus' }, 1)[0].track.id).toBe('study');
        expect(recommend(catalog, [], controls, { now, activity: 'relax' }, 1)[0].track.id).toBe('rest');
        expect(recommend(catalog, [], controls, { now, activity: 'workout' }, 1)[0].track.id).toBe('gym');
    });
    it('does not invent a seed from a requested genre or activity', () => {
        expect(discoverySeeds(buildProfile([], now), { ...controls, genre: 'shoegaze', activity: 'focus' })).toEqual(
            [],
        );
    });
    it('uses a matching search phrase when SoundCloud omits genre metadata', () => {
        const found = { ...track('result', 'A', ''), queryHint: 'shoegaze chill' };
        const unrelated = { ...track('wrong', 'B', 'house'), queryHint: 'shoegaze' };
        expect(
            recommend([found, unrelated], [], { ...controls, genre: 'shoegaze' }, { now }).map((item) => item.track.id),
        ).toEqual(['result']);
    });
    it('gives new directions room while familiar mode follows known taste', () => {
        const liked = track('liked', 'A', 'shoegaze');
        const catalog = [track('similar', 'B', 'shoegaze'), track('explore', 'C', 'house')];
        const events = [event(liked, 'like')];
        expect(recommend(catalog, events, { ...controls, discovery: 'familiar' }, { now }, 1)[0].track.id).toBe(
            'similar',
        );
        expect(recommend(catalog, events, { ...controls, discovery: 'new' }, { now }, 1)[0].track.id).toBe('explore');
    });
    it('re-ranks immediately after controls change and does not repeat reserved tracks', async () => {
        const catalog = [track('slow', 'A', 'ambient', 80, 0.1), track('fast', 'B', 'techno', 160, 0.9)];
        const session = new RecommendationSession({ related: async () => catalog }, () => now);
        session.addCandidates(catalog);
        session.setControls({ tempo: 'slow', mood: 'calm' });
        expect((await session.next())?.track.id).toBe('slow');
        session.setControls({ tempo: 'fast', mood: 'energetic' });
        expect((await session.next())?.track.id).toBe('fast');
        expect(await session.next()).toBeUndefined();
    });
    it('is deterministic for the same seed and input', () => {
        const candidates = [track('a', 'A', 'indie'), track('b', 'B', 'indie'), track('c', 'C', 'indie')];
        const once = recommend(candidates, [], controls, { now, seed: 123 }).map((entry) => entry.track.id);
        const twice = recommend(candidates, [], controls, { now, seed: 123 }).map((entry) => entry.track.id);
        expect(twice).toEqual(once);
    });
    it('keeps late feedback more relevant than old feedback', () => {
        const old = track('old', 'A', 'house');
        const fresh = track('fresh', 'B', 'ambient');
        const result = recommend(
            [track('new-house', 'C', 'house'), track('new-ambient', 'D', 'ambient')],
            [{ ...event(old, 'like'), at: now - 365 * 86400000 }, event(fresh, 'like')],
            controls,
            { now },
        );
        expect(result[0].track.id).toBe('new-ambient');
    });
});
