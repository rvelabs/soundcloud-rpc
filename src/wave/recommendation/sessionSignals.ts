import { measuredBpm, normalize, tokensOf } from './profile';
import type { Feedback, Track } from './types';
export const artistIdentity = (value: string): string =>
    normalize(value)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim() || normalize(value);
export function recentPreference(events: Feedback[], now: number): Map<string, number> {
    const latest = new Map<string, Feedback>();
    for (const event of events.slice(-80))
        if (
            event.at <= now &&
            now - event.at < 45 * 60000 &&
            ['skip', 'complete', 'like', 'dislike'].includes(event.kind)
        )
            latest.set(event.track.id, event);
    const signals = new Map<string, number>();
    for (const event of [...latest.values()].sort((a, b) => a.at - b.at).slice(-12)) {
        const fraction = event.listenedFraction ?? 0;
        const weight =
            event.kind === 'dislike'
                ? -1.5
                : event.kind === 'like'
                  ? 1
                  : event.kind === 'complete'
                    ? 0.5
                    : fraction < 0.2
                      ? -0.6
                      : fraction < 0.5
                        ? -0.2
                        : 0;
        const decay = 2 ** (-(now - event.at) / (20 * 60000));
        for (const token of tokensOf(event.track))
            signals.set(token, Math.max(-2, Math.min(2, (signals.get(token) || 0) + weight * decay)));
    }
    return signals;
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
