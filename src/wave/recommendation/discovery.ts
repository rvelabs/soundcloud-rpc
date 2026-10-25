import { normalize } from './profile';
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
    const artists = new Set<string>();
    const distinct = sorted
        .filter(({ track }) => {
            const key = normalize(track.artist);
            if (artists.has(key)) return false;
            artists.add(key);
            return true;
        })
        .map(({ track }) => track);
    if (!distinct.length) return [];
    const start = (Math.max(0, rotation) * 2) % distinct.length;
    return [...distinct.slice(start), ...distinct.slice(0, start)].slice(0, 3);
}
