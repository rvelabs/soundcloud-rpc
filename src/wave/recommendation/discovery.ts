import { artistIdentity, sessionWeight } from './sessionSignals';
import type { Context, Controls } from './types';
import type { TasteProfile } from './profile';
import { tokensOf } from './profile';
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
    const rejected = new Set(reactions.filter((event) => sessionWeight(event) < 0).map((event) => event.track.id));
    const sessionAffinity = (track: Track) => {
        const tokens = tokensOf(track);
        return (
            tokens.reduce((sum, token) => sum + (context?.preferenceSignals?.get(token) || 0), 0) /
            Math.sqrt(Math.max(1, tokens.length))
        );
    };
    const recentPositive = reactions
        .filter((event) => sessionWeight(event) > 0)
        .slice()
        .reverse();
    const unique = new Map<string, Track>();
    for (const track of [anchor, ...recentPositive.map((event) => event.track), ...profile.positiveSeeds].filter(
        (item): item is Track => Boolean(item),
    )) {
        if (
            rejected.has(track.id) ||
            sessionAffinity(track) < -0.8 ||
            profile.dislikedIds.has(track.id) ||
            profile.negativeSeeds.some((seed) => seed.id === track.id) ||
            moodEvidence(track, controls.mood).conflict
        )
            continue;
        unique.set(track.id, { ...unique.get(track.id), ...track });
    }
    const sorted = [...unique.values()]
        .map((track, order) => ({
            track,
            score:
                (profile.likedIds.has(track.id) ? 2 : 0) +
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
    const distinct = [...artists.values()].map((group) => group[Math.max(0, Math.floor(rotation)) % group.length]);
    if (!distinct.length) return [];
    const start = (Math.max(0, rotation) * 2) % distinct.length;
    const rotated = [...distinct.slice(start), ...distinct.slice(0, start)];
    const current = anchor && unique.get(anchor.id);
    const selected: Track[] = current ? [current] : [];
    const add = (track: Track) => {
        if (!selected.some((item) => artistIdentity(item.artist) === artistIdentity(track.artist)))
            selected.push(track);
    };
    const recent = recentPositive
        .map((event) => unique.get(event.track.id))
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
        const independent = selected.length
            ? available.find(
                  (track) =>
                      tokensOf(track).length &&
                      selected.every((item) => tokensOf(item).length && compare(track, item) < 0.5),
              )
            : undefined;
        add(independent || available[0]);
    }
    return selected;
}
