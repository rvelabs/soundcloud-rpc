import { expect, it } from 'vitest';
import { buildProfile } from './profile';
import { discoverySeeds } from './discovery';
import { recommend } from './ranker';
import type { Controls, Feedback, Track } from './types';

const now = Date.UTC(2026, 10, 8);
const controls: Controls = { mood: 'any', tone: 'any', tempo: 'any', discovery: 'balanced' };
const track = (id: string, genre: string, extra: Partial<Track> = {}): Track => ({
    id,
    title: id,
    artist: id,
    genre,
    ...extra,
});
const like = (track: Track): Feedback => ({ track, kind: 'like', origin: 'library', at: now - 86400000 });

it('does not let a stale recommendation graph outrank the active direction', () => {
    const metal = track('metal-root', 'metal');
    const rap = track('rap-root', 'hiphop');
    const history = [like(metal), ...Array.from({ length: 30 }, (_, i) => like(track('rap-' + i, 'hiphop')))];
    const stale = track('stale-rap', 'hiphop', { source: 'related', relatedTo: [rap.id] });
    const fresh = track('fresh-metal', 'metal', { source: 'related', relatedTo: [metal.id] });
    const ranked = recommend([stale, fresh], history, controls, { now, discoverySeeds: [metal] });
    expect(ranked.map((item) => item.track.id)).toEqual([fresh.id, stale.id]);
    expect(ranked[0].selection).toMatchObject({ activeLinks: 1, staleLinks: 0, directionSimilarity: 1 });
});

it('rotates confirmed interests instead of limiting every seed slot to the strongest token cluster', () => {
    const events = [
        ...Array.from({ length: 30 }, (_, i) => like(track('rap-' + i, 'hiphop'))),
        ...Array.from({ length: 6 }, (_, i) => like(track('jungle-' + i, 'jungle'))),
        ...Array.from({ length: 6 }, (_, i) => like(track('rock-' + i, 'rock'))),
    ];
    const profile = buildProfile(events, now);
    const selected = Array.from({ length: 24 }, (_, turn) => discoverySeeds(profile, controls, turn)).flat();
    expect(new Set(selected.map((track) => track.id)).size).toBeGreaterThan(20);
    expect(new Set(selected.map((track) => track.genre))).toEqual(new Set(['hiphop', 'jungle', 'rock']));
    expect(selected.every((track) => profile.likedIds.has(track.id))).toBe(true);
});

it('allows another confirmed taste neighbourhood without admitting unrelated material', () => {
    const root = track('root', 'ambient');
    const other = track('other', 'jungle');
    const events = [like(root), like(other), like(track('third', 'ambient'))];
    const results = recommend(
        [
            track('next-ambient', 'ambient', { source: 'related', relatedTo: [root.id] }),
            track('next-jungle', 'jungle', { source: 'collection' }),
            track('unrelated', 'country', { source: 'home' }),
        ],
        events,
        controls,
        { now, discoverySeeds: [root] },
    );
    expect(new Set(results.map((item) => item.track.id))).toEqual(new Set(['next-ambient', 'next-jungle']));
    expect(results[0].track.id).toBe('next-ambient');
});

it('accepts direct SoundCloud evidence when uploader genre labels conflict', () => {
    const root = track('root', 'hiphop');
    const events = Array.from({ length: 5 }, (_, i) => like(track('favorite-' + i, 'hiphop')));
    const mislabeled = track('mislabeled', 'country', { source: 'related', relatedTo: [root.id] });
    const result = recommend([mislabeled], events, controls, { now, discoverySeeds: [root] });
    expect(result).toHaveLength(1);
    expect(result[0].selection?.activeLinks).toBe(1);
});

it('does not promote stale relationship evidence to current-session evidence', () => {
    const root = track('root', 'jungle');
    const stale = track('stale', 'jungle', { source: 'related', relatedTo: ['previous-session-root'] });
    const fresh = track('fresh', 'jungle', { source: 'related', relatedTo: [root.id] });
    const result = recommend([stale, fresh], [like(root)], controls, { now, discoverySeeds: [root] });
    expect(result[0].track.id).toBe(fresh.id);
    const old = result.find((item) => item.track.id === stale.id)!;
    expect(old.selection).toMatchObject({ activeLinks: 0, staleLinks: 1 });
    expect(old.reasons).not.toContain('похожие треки к музыке текущей сессии');
});

it('does not let imported rare genre labels dominate a sustained preference on rotation', () => {
    const events = [
        like(track('rare', 'country')),
        ...Array.from({ length: 20 }, (_, i) => like(track('regular-' + i, 'jungle'))),
    ];
    const profile = buildProfile(events, now);
    for (let rotation = 0; rotation < 12; rotation++)
        expect(discoverySeeds(profile, controls, rotation)[0].genre).toBe('jungle');
    expect(profile.trustedSeeds.some((item) => item.id === 'rare')).toBe(true);
});

it('does not bootstrap a recommendation rabbit hole from an automatically completed unliked track', () => {
    const good = track('favorite', 'jungle'),
        automatic = track('automatic', 'jungle');
    const completion: Feedback = { track: automatic, kind: 'complete', origin: 'wave', listenedFraction: 1, at: now };
    const profile = buildProfile([like(good), completion], now);
    const seeds = discoverySeeds(profile, controls, 0, automatic, { now, sessionReactions: [completion] });
    expect(seeds.map((item) => item.id)).toEqual([good.id]);
    const manual = { ...completion, origin: undefined };
    expect(
        discoverySeeds(buildProfile([like(good), manual], now), controls, 0, automatic, {
            now,
            sessionReactions: [manual],
        })[0].id,
    ).toBe(automatic.id);
});

it('does not mistake reuploads by different accounts for different favourite artists', () => {
    const root = track('root', 'hiphop', { artist: 'Kunteynir' });
    const other = track('other', 'hiphop', { artist: 'Galafo' });
    const reupload = track('reupload', 'hiphop', {
        title: 'KUNTEYNIR — Another recording',
        artist: 'Uploader',
        source: 'related',
        relatedTo: [root.id],
    });
    const candidates = [
        track('original', 'hiphop', { artist: 'Kunteynir', source: 'related', relatedTo: [root.id] }),
        reupload,
        track('alternative', 'hiphop', { artist: 'Galafo', source: 'related', relatedTo: [other.id] }),
    ];
    const context = { now, discoverySeeds: [root, other] };
    const ranked = recommend(candidates, [like(root), like(other)], controls, context);
    expect(ranked.slice(0, 2).some((item) => item.track.id === 'alternative')).toBe(true);
    const next = recommend([reupload, candidates[2]], [like(root), like(other)], controls, {
        ...context,
        recentArtists: ['Another uploader'],
        recentTracks: [
            track('previous', 'hiphop', { title: 'Kunteynir - Previous recording', artist: 'Another uploader' }),
        ],
    });
    expect(next[0].track.id).toBe('alternative');
});

it('keeps a relevant familiar recording eligible when new neighbours link to multiple roots', () => {
    const first = track('first-root', 'ambient');
    const familiar = track('familiar', 'ambient', { source: 'related', relatedTo: [first.id] });
    const events: Feedback[] = [
        like(first),
        { track: familiar, kind: 'complete', listenedFraction: 1, at: now - 8 * 86400000 },
    ];
    const fresh = Array.from({ length: 4 }, (_, i) =>
        track('fresh-' + i, 'ambient', { source: 'related', relatedTo: [first.id, familiar.id] }),
    );
    const ranked = recommend([familiar, ...fresh], events, controls, {
        now,
        discoverySeeds: [first, familiar],
        sequenceOffset: 5,
    });
    expect(ranked[0].track.id).toBe(familiar.id);
});
