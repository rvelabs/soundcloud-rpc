import { measuredBpm, normalize, tokensOf } from './profile';
import type { Feedback, Track } from './types';
export const artistIdentity = (value: string): string =>
    normalize(value)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim() || normalize(value);
export function sessionWeight(event: Feedback): number {
    const fraction = Number.isFinite(event.listenedFraction) ? Math.max(0, Math.min(1, event.listenedFraction!)) : 0;
    switch (event.kind) {
        case 'unlike':
            return 0;
        case 'dislike':
            return -1.5;
        case 'like':
            return 1;
        case 'complete':
            return 0.5;
        case 'play':
            return fraction >= 0.7 ? 0.5 : fraction >= 0.35 ? 0.15 : 0;
        case 'skip':
            return fraction < 0.2 ? -0.6 : fraction < 0.5 ? -0.2 : 0;
    }
}
export function recentReactions(events: Feedback[], now: number): Feedback[] {
    const latest = new Map<string, Feedback>();
    for (const event of events.slice(-80).sort((a, b) => a.at - b.at))
        if (event.origin !== 'library' && event.at <= now && now - event.at < 45 * 60000) {
            const previous = latest.get(event.track.id);
            if (!['like', 'unlike', 'dislike'].includes(event.kind)) {
                if (previous?.kind === 'dislike') continue;
                if (previous?.kind === 'like' && sessionWeight(event) >= 0) {
                    latest.set(event.track.id, {
                        ...previous,
                        at: event.at,
                        track: { ...previous.track, ...event.track },
                    });
                    continue;
                }
                if (sessionWeight(event) === 0) continue;
            }
            latest.set(event.track.id, {
                ...event,
                track: { ...previous?.track, ...event.track },
            });
        }
    return [...latest.values()].sort((a, b) => a.at - b.at).slice(-12);
}
export function recentPreference(events: Feedback[], now: number): Map<string, number> {
    const signals = new Map<string, number>();
    const reactions = recentReactions(events, now);
    const skipCounts = new Map<string, number>();
    for (const event of reactions)
        if (
            event.kind === 'skip' &&
            now - event.at < 10 * 60000 &&
            sessionWeight(event) < 0 &&
            measuredSoundSimilarity(event.track, event.track) === undefined
        )
            for (const token of tokensOf(event.track)) skipCounts.set(token, (skipCounts.get(token) || 0) + 1);
    for (const event of reactions) {
        if (event.kind === 'skip' && measuredSoundSimilarity(event.track, event.track) !== undefined) continue;
        const weight = sessionWeight(event);
        const decay = 2 ** (-(now - event.at) / (20 * 60000));
        for (const token of tokensOf(event.track)) {
            if (event.kind === 'skip' && (now - event.at >= 10 * 60000 || (skipCounts.get(token) || 0) < 3)) continue;
            signals.set(token, Math.max(-2, Math.min(2, (signals.get(token) || 0) + weight * decay)));
        }
    }
    return signals;
}
export function measuredSoundSimilarity(a: Track, b: Track): number | undefined {
    const valid = (track: Track) =>
        track.features?.source === 'media-element-v1' &&
        (track.features.sampleSeconds || 0) >= 30 &&
        ['bass', 'brightness'].every((key) => {
            const value = track.features?.[key as 'bass' | 'brightness'];
            return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
        });
    if (!valid(a) || !valid(b)) return;
    const distance =
        (Math.abs(a.features!.bass! - b.features!.bass!) +
            Math.abs(a.features!.brightness! - b.features!.brightness!)) /
        2;
    return Math.max(0, 1 - distance * 2.5);
}
export function transitionAffinity(track: Track, previous?: Track): number {
    if (!previous) return 0;
    let score = 0;
    const from = measuredBpm(previous.features),
        to = measuredBpm(track.features);
    if (from && to) score += Math.max(-0.35, 0.4 - Math.abs(Math.log2(to / from)) * 0.8);
    if (
        track.features?.source === previous.features?.source &&
        (track.features?.sampleSeconds || 0) >= 8 &&
        (previous.features?.sampleSeconds || 0) >= 8
    ) {
        for (const key of ['bass', 'brightness'] as const) {
            const a = track.features?.[key],
                b = previous.features?.[key];
            if (a !== undefined && b !== undefined) score += (0.5 - Math.abs(a - b)) * 0.2;
        }
    }
    return score;
}
