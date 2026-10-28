import { artistIdentity } from './sessionSignals';
import type { Controls } from './types';
import type { TasteProfile } from './profile';
import { moodEvidence } from './preferences';
import type { Track } from './types';
export function discoverySeeds(profile: TasteProfile, controls: Controls, rotation = 0, anchor?: Track): Track[] {
    const unique = new Map<string, Track>();
    for (const track of [anchor, ...profile.positiveSeeds].filter((item): item is Track => Boolean(item))) {
        if (profile.dislikedIds.has(track.id) || profile.negativeSeeds.some((seed) => seed.id === track.id)) continue;
        unique.set(track.id, { ...unique.get(track.id), ...track });
    }
    const sorted = [...unique.values()]
        .map((track, order) => ({
            track,
            score: (profile.likedIds.has(track.id) ? 2 : 0) + moodEvidence(track, controls.mood).score - order / 1000,
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
    return current && !moodEvidence(current, controls.mood).conflict
        ? [
              current,
              ...rotated.filter((track) => artistIdentity(track.artist) !== artistIdentity(current.artist)),
          ].slice(0, 3)
        : rotated.slice(0, 3);
}
