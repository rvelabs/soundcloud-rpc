import { artistIdentity, sessionWeight } from './sessionSignals';
import type { Context, Controls } from './types';
import type { TasteProfile } from './profile';
import { tokensOf, hasMusicalMetadata } from './profile';
import { moodEvidence } from './preferences';
import type { Track } from './types';
import { catalogSimilarity } from './similarity';
export function discoverySeeds(
    profile: TasteProfile,
    controls: Controls,
    rotation = 0,
    anchor?: Track,
    context?: Context,
): Track[] {
    const reactions = context?.sessionReactions || [];
    const references = profile.trustedSeeds.length ? profile.trustedSeeds : profile.positiveSeeds;
    const established = profile.trustedSeeds.filter(hasMusicalMetadata).length >= 3;
    const seedCompare = catalogSimilarity([...references, ...(anchor ? [anchor] : [])]);
    const compatible = (track: Track) =>
        !established ||
        references.some((seed) => seed.id === track.id || seedCompare(track, seed) >= 0.12) ||
        !hasMusicalMetadata(track);
    const rejected = new Set(reactions.filter((event) => sessionWeight(event) < 0).map((event) => event.track.id));
    const sessionAffinity = (track: Track) => {
        const tokens = tokensOf(track);
        return (
            tokens.reduce((sum, token) => sum + (context?.preferenceSignals?.get(token) || 0), 0) /
            Math.sqrt(Math.max(1, tokens.length))
        );
    };
    const recentPositive = reactions
        .filter(
            (event) =>
                sessionWeight(event) > 0 &&
                (!profile.trustedSeeds.length || event.origin !== 'wave' || profile.likedIds.has(event.track.id)),
        )
        .slice()
        .reverse();
    const confirmed = new Set([
        ...profile.likedIds,
        ...profile.trustedSeeds.map((track) => track.id),
        ...recentPositive.map((event) => event.track.id),
    ]);
    const currentAnchor =
        anchor && (!context || !profile.trustedSeeds.length || confirmed.has(anchor.id)) ? anchor : undefined;
    const unique = new Map<string, Track>();
    for (const track of [currentAnchor, ...recentPositive.map((event) => event.track), ...references].filter(
        (item): item is Track => Boolean(item),
    )) {
        if (
            rejected.has(track.id) ||
            profile.dislikedIds.has(track.id) ||
            profile.negativeSeeds.some((seed) => seed.id === track.id) ||
            !compatible(track) ||
            moodEvidence(track, controls.mood).conflict
        )
            continue;
        unique.set(track.id, { ...unique.get(track.id), ...track });
    }
    const preferred = [...unique.values()].filter((track) => sessionAffinity(track) >= -0.8);
    const sources = preferred.length ? preferred : [...unique.values()];
    let scale = 1;
    for (const weight of profile.tokens.values()) scale = Math.max(scale, Math.abs(weight));
    const support = (track: Track) => {
        const tokens = tokensOf(track);
        return (
            tokens.reduce((sum, token) => sum + Math.max(0, profile.tokens.get(token) || 0), 0) /
            (scale * Math.max(1, tokens.length))
        );
    };
    const sorted = sources
        .map((track, order) => ({
            track,
            score:
                (profile.likedIds.has(track.id) ? 2 : 0) +
                support(track) * 1.5 +
                moodEvidence(track, controls.mood).score +
                Math.max(-1, Math.min(1.5, sessionAffinity(track))) -
                order / 1000,
        }))
        .sort((a, b) => b.score - a.score);
    const artists = new Map<string, Track[]>();
    for (const { track } of sorted) {
        const key = artistIdentity(track.artist);
        const group = artists.get(key) || [];
        group.push(track);
        artists.set(key, group);
    }
    const strongest = sorted[0]?.score ?? 0;
    const primaryIds = new Set(sorted.filter((item) => item.score >= strongest - 0.6).map((item) => item.track.id));
    const distinct = [...artists.values()].map((group) => {
        const preferred = group.filter((track) => primaryIds.has(track.id));
        const pool = preferred.length ? preferred : group;
        return pool[Math.max(0, Math.floor(rotation)) % pool.length];
    });
    if (!distinct.length) return [];
    const primary = distinct.filter((track) => primaryIds.has(track.id));
    const start = (Math.max(0, rotation) * 2) % Math.max(1, primary.length);
    const rotated = [
        ...primary.slice(start),
        ...primary.slice(0, start),
        ...distinct.filter((track) => !primaryIds.has(track.id)),
    ];
    const eligible = new Map(sources.map((track) => [track.id, track]));
    const current = currentAnchor && eligible.get(currentAnchor.id);
    const selected: Track[] = current ? [current] : [];
    const add = (track: Track) => {
        if (!selected.some((item) => artistIdentity(item.artist) === artistIdentity(track.artist)))
            selected.push(track);
    };
    const recent = recentPositive
        .map((event) => eligible.get(event.track.id))
        .find(
            (track) => track && !selected.some((item) => artistIdentity(item.artist) === artistIdentity(track.artist)),
        );
    if (recent) add(recent);
    const compare = catalogSimilarity([...unique.values()]);
    while (selected.length < 3) {
        const available = rotated.filter(
            (track) => !selected.some((item) => artistIdentity(item.artist) === artistIdentity(track.artist)),
        );
        if (!available.length) break;
        const continuation = selected.length
            ? available
                  .map((track, order) => ({ track, score: compare(track, selected[0]) - order / 10000 }))
                  .filter((item) => item.score >= 0.12)
                  .sort((left, right) => right.score - left.score)[0]?.track
            : undefined;
        const alternative =
            controls.discovery === 'new' && selected.length >= 2
                ? available.find(
                      (track) => hasMusicalMetadata(track) && selected.every((item) => compare(track, item) < 0.5),
                  )
                : undefined;
        add(alternative || continuation || available[0]);
    }
    return selected;
}
