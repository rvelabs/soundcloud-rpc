import type { Feedback, SoundFeatures, Track } from './types';
export interface TasteProfile {
    tokens: Map<string, number>;
    styles: Map<string, number>;
    likedIds: Set<string>;
    dislikedIds: Set<string>;
    heardIds: Set<string>;
    positiveSeeds: Track[];
    negativeSeeds: Track[];
    recordingsById: Map<string, Set<string>>;
    knownRecordings: Set<string>;
    dislikedRecordings: Set<string>;
    sound: {
        energy?: number;
        bass?: number;
        brightness?: number;
    };
}
const stop = new Set(['the', 'and', 'feat', 'with', 'music', 'track', 'official', 'original', 'remix']);
const titleStyles = new Set([
    'ambient',
    'chill',
    'lofi',
    'techno',
    'house',
    'jungle',
    'dnb',
    'rock',
    'metal',
    'shoegaze',
    'dream',
    'pop',
    'rap',
    'phonk',
    'trance',
    'dubstep',
    'hardstyle',
    'breakcore',
    'acoustic',
    'jazz',
    'эмбиент',
    'техно',
    'хаус',
    'рок',
    'метал',
    'фонк',
    'транс',
    'джаз',
    'instrumental',
    'slow',
    'slowed',
    'fast',
    'sped',
    'midtempo',
    'workout',
    'focus',
    'study',
    'vocal',
    '808',
    'trap',
    'drill',
    'synth',
    'bright',
    'bass',
    'dance',
    'soft',
    'groove',
    'organic',
    'underground',
]);
const normalized = new Map<string, string>();
const tokenized = new Map<string, string[]>();
const recordings = new Map<string, string>();
function memo<T>(cache: Map<string, T>, key: string, compute: () => T): T {
    if (key.length > 1024) return compute();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const value = compute();
    cache.set(key, value);
    if (cache.size > 2048) cache.delete(cache.keys().next().value!);
    return value;
}
export const normalize = (value: string): string =>
    memo(normalized, value, () => value.toLowerCase().normalize('NFKC').trim().replace(/\s+/g, ' '));
export function tokensOf(track: Track): string[] {
    return memo(tokenized, JSON.stringify([track.title, track.genre, track.tags]), () => {
        const title = normalize(track.title)
            .split(/[^\p{L}\p{N}]+/u)
            .filter((token) => titleStyles.has(token));
        const metadata = [track.genre || '', ...(track.tags || []), ...title];
        return [
            ...new Set(
                metadata
                    .flatMap((item) => normalize(item).split(/[^\p{L}\p{N}]+/u))
                    .filter((token) => token.length >= 3 && token.length <= 30 && !stop.has(token)),
            ),
        ];
    }).slice();
}
export function recordingKey(track: Track): string {
    return memo(recordings, JSON.stringify([track.artist, track.title]), () => {
        const clean = (text: string) =>
            normalize(text)
                .replace(/\b(?:official|audio|video|lyrics)\b/g, '')
                .replace(/[^\p{L}\p{N}]+/gu, ' ')
                .trim()
                .replace(/\s+/g, ' ');
        return `${clean(track.artist)}|${clean(track.title)}`;
    });
}
export function measuredBpm(features?: SoundFeatures): number | undefined {
    const bpm = features?.bpm,
        confidence = features?.bpmConfidence;
    return bpm &&
        Number.isFinite(bpm) &&
        bpm >= 50 &&
        bpm <= 220 &&
        confidence !== undefined &&
        Number.isFinite(confidence) &&
        confidence >= 0.65
        ? bpm
        : undefined;
}
export function feedbackWeight(item: Feedback): number {
    const fraction = Math.max(0, Math.min(1, item.listenedFraction ?? 0));
    switch (item.kind) {
        case 'like':
            return 4;
        case 'unlike':
            return 0;
        case 'dislike':
            return -5;
        case 'skip':
            return fraction < 0.2 ? -0.75 : fraction < 0.5 ? -0.3 : 0;
        case 'complete':
            return 2;
        case 'play':
            return fraction >= 0.7 ? 1.5 : fraction >= 0.35 ? 0.4 : 0;
    }
}
export function buildProfile(events: Feedback[], now: number): TasteProfile {
    const profile: TasteProfile = {
        tokens: new Map(),
        styles: new Map(),
        likedIds: new Set(),
        dislikedIds: new Set(),
        heardIds: new Set(),
        positiveSeeds: [],
        negativeSeeds: [],
        recordingsById: new Map(),
        knownRecordings: new Set(),
        dislikedRecordings: new Set(),
        sound: {},
    };
    const explicit = new Map<string, Feedback>();
    const tracks = new Map<
        string,
        {
            track: Track;
            weight: number;
        }
    >();
    const sorted = [...events].sort((a, b) => a.at - b.at);
    const add = (item: Feedback) => {
        const weight = feedbackWeight(item) * 2 ** (-Math.max(0, now - item.at) / 86400000 / 90);
        const old = tracks.get(item.track.id);
        tracks.set(item.track.id, {
            track: {
                ...old?.track,
                ...Object.fromEntries(Object.entries(item.track).filter(([, value]) => value !== undefined)),
                features: {
                    ...old?.track.features,
                    ...Object.fromEntries(
                        Object.entries(item.track.features || {}).filter(([, value]) => value !== undefined),
                    ),
                },
            } as Track,
            weight: (old?.weight || 0) + weight,
        });
    };
    for (const item of sorted) {
        let recordings = profile.recordingsById.get(item.track.id);
        if (!recordings) {
            recordings = new Set();
            profile.recordingsById.set(item.track.id, recordings);
        }
        recordings.add(recordingKey(item.track));
        if (['like', 'unlike', 'dislike'].includes(item.kind)) explicit.set(item.track.id, item);
        else {
            profile.heardIds.add(item.track.id);
            add(item);
        }
    }
    for (const item of explicit.values()) {
        if (item.kind === 'like') profile.likedIds.add(item.track.id);
        if (item.kind === 'dislike') profile.dislikedIds.add(item.track.id);
        add(item);
        const entry = tracks.get(item.track.id)!;
        const explicitWeight = feedbackWeight(item) * 2 ** (-Math.max(0, now - item.at) / 86400000 / 90);
        if (item.kind === 'dislike') entry.weight = explicitWeight;
        if (item.kind === 'like') entry.weight = Math.max(explicitWeight, entry.weight);
    }
    for (const [id, recordings] of profile.recordingsById) {
        if (profile.heardIds.has(id) || profile.likedIds.has(id) || profile.dislikedIds.has(id))
            for (const key of recordings) profile.knownRecordings.add(key);
        if (profile.dislikedIds.has(id)) for (const key of recordings) profile.dislikedRecordings.add(key);
    }
    const sums = { energy: 0, bass: 0, brightness: 0 },
        counts = { energy: 0, bass: 0, brightness: 0 };
    for (const { track, weight: raw } of tracks.values()) {
        const weight = Math.max(-5, Math.min(6, raw));
        if (!weight) continue;
        for (const token of tokensOf(track)) profile.tokens.set(token, (profile.tokens.get(token) || 0) + weight);
        const style = normalize(track.genre || '');
        if (style && style.length <= 60) profile.styles.set(style, (profile.styles.get(style) || 0) + weight);
        (weight > 0 ? profile.positiveSeeds : profile.negativeSeeds).push(track);
        if (weight > 0)
            for (const key of ['energy', 'bass', 'brightness'] as const) {
                const value = track.features?.[key];
                if (value !== undefined && Number.isFinite(value)) {
                    sums[key] += Math.max(0, Math.min(1, value)) * weight;
                    counts[key] += weight;
                }
            }
    }
    for (const key of ['energy', 'bass', 'brightness'] as const)
        if (counts[key]) profile.sound[key] = sums[key] / counts[key];
    profile.positiveSeeds = profile.positiveSeeds.slice(-80);
    profile.negativeSeeds = profile.negativeSeeds.slice(-80);
    return profile;
}
