import { describe, expect, it } from 'vitest';
import { recommend } from './ranker';
import { buildProfile, tokensOf } from './profile';
import { discoverySeeds } from './discovery';
import type { Controls, Feedback, Track } from './types';

const now = Date.UTC(2026, 10, 6);
const controls: Controls = { mood: 'any', tone: 'any', tempo: 'any', discovery: 'balanced' };
const track = (id: string, genre: string, extra: Partial<Track> = {}): Track => ({
    id,
    title: id,
    artist: id,
    genre,
    ...extra,
});
const like = (item: Track): Feedback => ({ track: item, kind: 'like', at: now - 86400000, origin: 'library' });
const favorites = Array.from({ length: 4 }, (_, i) =>
    track('favorite-' + i, 'breakcore', { tags: ['jungle', 'breakbeats'] }),
);

describe('relevance before novelty and artist diversity', () => {
    it('does not replace a relevant artist with an unrelated one merely to avoid repeating the artist', () => {
        const seed = track('seed', 'shoegaze', { artist: 'A' });
        const good = track('good', 'shoegaze', { artist: 'A' });
        const bad = track('bad', 'country', { artist: 'B' });
        expect(recommend([bad, good], [like(seed)], controls, { now, recentArtists: ['A'] }, 1)[0].track.id).toBe(
            'good',
        );
    });
    it('does not let a single SoundCloud related link outweigh actual musical relevance in New mode', () => {
        const seed = track('seed', 'shoegaze');
        const good = track('good', 'shoegaze');
        const bad = track('bad', 'country', { source: 'related', relatedTo: [seed.id] });
        expect(recommend([bad, good], [like(seed)], { ...controls, discovery: 'new' }, { now }, 1)[0].track.id).toBe(
            'good',
        );
    });
    it('uses a relevant familiar recording instead of forcing a weak novelty slot', () => {
        const feedback = favorites.map(like);
        const bad = track('bad', 'country', { source: 'home', playbackCount: 100000000 });
        const ranked = recommend([bad, ...favorites], feedback, controls, { now }, 3);
        expect(ranked).toHaveLength(3);
        expect(ranked.every((entry) => entry.track.genre === 'breakcore')).toBe(true);
    });
    it('screens well-labelled off-topic candidates across all sources when the taste profile is established', () => {
        const pool = ['related', 'artist', 'collection', 'following', 'home'].map((source, index) =>
            track('bad-' + index, 'country', {
                source: source as Track['source'],
                relatedTo: [favorites[0].id],
                playbackCount: 1e8,
            }),
        );
        const good = track('good', 'breakcore', { tags: ['jungle', 'breakbeats'] });
        expect(
            recommend([...pool, good], favorites.map(like), controls, { now }, 20).map((entry) => entry.track.id),
        ).toEqual(['good']);
    });
    it('does not drift toward unrelated styles over repeated one-track selections', () => {
        const pool = Array.from({ length: 90 }, (_, index) =>
            track('good-' + index, 'breakcore', {
                artist: 'Good artist ' + (index % 12),
                tags: ['jungle', 'breakbeats'],
            }),
        );
        pool.push(
            ...Array.from({ length: 60 }, (_, index) =>
                track('bad-' + index, 'country', {
                    source: 'related',
                    relatedTo: [favorites[0].id],
                    artist: 'Unrelated ' + index,
                }),
            ),
        );
        const recent: string[] = [],
            artists: string[] = [];
        for (let index = 0; index < 30; index++) {
            const next = recommend(
                pool,
                favorites.map(like),
                { ...controls, discovery: 'new' },
                { now, recentTrackIds: recent, recentArtists: artists, sequenceOffset: index },
                1,
            )[0];
            expect(next).toBeDefined();
            expect(next.track.genre).toBe('breakcore');
            recent.unshift(next.track.id);
            artists.unshift(next.track.artist);
        }
    });
    it('keeps cold starts and sparse metadata usable without requiring invented genre labels', () => {
        const unknown = {
            id: 'unknown',
            title: 'Unknown',
            artist: 'Unknown',
            source: 'related' as const,
            relatedTo: [favorites[0].id],
        };
        expect(recommend([unknown], [], controls, { now })).toHaveLength(1);
        expect(recommend([unknown], favorites.map(like), controls, { now })).toHaveLength(1);
    });
    it('does not turn a plainly incompatible unconfirmed current track into a discovery seed', () => {
        const wrong = track('accidental', 'country');
        const selected = discoverySeeds(buildProfile(favorites.map(like), now), controls, 0, wrong);
        expect(selected).toHaveLength(3);
        expect(selected.every((seed) => seed.genre === 'breakcore')).toBe(true);
    });
    it('does not let automatic completion validate its own unrelated direction, but follows an explicit new like', () => {
        const accidental = track('accidental', 'country');
        const events: Feedback[] = [
            ...favorites.map(like),
            { track: accidental, kind: 'complete', origin: 'wave', at: now, listenedFraction: 1 },
        ];
        const profile = buildProfile(events, now);
        expect(profile.positiveSeeds.some((seed) => seed.id === accidental.id)).toBe(true);
        expect(profile.trustedSeeds.some((seed) => seed.id === accidental.id)).toBe(false);
        expect(discoverySeeds(profile, controls, 0, accidental).some((seed) => seed.id === accidental.id)).toBe(false);
        events.push({ track: accidental, kind: 'like', at: now + 1 });
        expect(discoverySeeds(buildProfile(events, now + 1), controls, 0, accidental)[0].id).toBe(accidental.id);
    });
    it('preserves smaller genuine interests in a large library instead of letting the last large import erase them', () => {
        const rare = track('rare-favorite', 'jazz');
        const events = [like(rare), ...Array.from({ length: 140 }, (_, i) => like(track('many-' + i, 'breakcore')))];
        const profile = buildProfile(events, now);
        expect(profile.trustedSeeds).toHaveLength(80);
        expect(profile.trustedSeeds.some((seed) => seed.id === rare.id)).toBe(true);
        const fresh = track('new-jazz', 'jazz', { source: 'home' });
        expect(recommend([fresh], events, controls, { now })).toHaveLength(1);
    });
    it('does not promote old recommendation-linked plays into strong taste evidence, preserving the stored feedback', () => {
        const old = track('old-auto', 'country', { source: 'related', relatedTo: [favorites[0].id] });
        const events: Feedback[] = [
            ...favorites.map(like),
            { track: old, kind: 'complete', at: now - 1000, listenedFraction: 1 },
        ];
        const original = structuredClone(events);
        const profile = buildProfile(events, now);
        expect(profile.heardIds.has(old.id)).toBe(true);
        expect(profile.trustedSeeds.some((seed) => seed.id === old.id)).toBe(false);
        expect(discoverySeeds(profile, controls, 0, old).some((seed) => seed.id === old.id)).toBe(false);
        expect(events).toEqual(original);
    });
    it('recognizes ordinary spelling variants without relying on promotional tags', () => {
        expect(tokensOf(track('dnb', 'D&B'))).toEqual(tokensOf(track('drums', 'Drum and Bass')));
        expect(tokensOf(track('hip', 'hip-hop'))).toEqual(tokensOf(track('hop', 'hiphop')));
        expect(tokensOf(track('lo', 'lo-fi'))).toEqual(tokensOf(track('fi', 'lofi')));
        expect(tokensOf(track('ru', 'Фонк'))).toEqual(tokensOf(track('en', 'phonk')));
        expect(tokensOf(track('rus', 'эмбиент'))).toEqual(tokensOf(track('eng', 'ambient')));
        const seed = track('seed', 'Drum and Bass');
        const good = track('good', 'DnB');
        const spam = track('spam', 'country', {
            tags: ['free', 'download', 'newrelease', 'official', '2026', 'electronic'],
        });
        expect(recommend([spam, good], [like(seed)], { ...controls, discovery: 'new' }, { now }, 1)[0].track.id).toBe(
            good.id,
        );
    });
    it('treats unspecified catalog genre as uncertainty rather than evidence of an incompatible style', () => {
        const unknown = track('unknown', 'All genres', { source: 'related', relatedTo: [favorites[0].id] });
        expect(recommend([unknown], favorites.map(like), controls, { now })).toHaveLength(1);
    });
});
