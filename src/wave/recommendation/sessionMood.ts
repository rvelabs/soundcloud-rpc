import { effectiveMood, moodTags } from './preferences';
import { measuredBpm, normalize } from './profile';
import type { Context, Controls, Feedback, Track } from './types';

type Mood = Exclude<Controls['mood'], 'any'>;
export interface SessionMood {
    mood: Mood;
    confidence: number;
    supportingTracks: number;
}

const oppositeMood: Record<Mood, Mood> = {
    calm: 'energetic',
    energetic: 'calm',
    happy: 'sad',
    sad: 'happy',
};
export const sessionMoodReason: Record<Mood, string> = {
    calm: 'спокойное настроение по прослушиваниям',
    energetic: 'энергичное настроение по прослушиваниям',
    happy: 'весёлое настроение по прослушиваниям',
    sad: 'грустное настроение по прослушиваниям',
};
const metadataTerms = (track: Track) =>
    new Set(normalize([track.genre || '', ...(track.tags || [])].join(' ')).split(/[^\p{L}\p{N}]+/u));

function moodFit(terms: ReadonlySet<string>, mood: Mood): number {
    const { match, opposite } = moodTags(terms, mood);
    const conflicting = opposite || moodTags(terms, oppositeMood[mood]).match;
    return Number(match) - Number(conflicting);
}

function label(track: Track): Mood | undefined {
    const terms = metadataTerms(track);
    return (['happy', 'sad', 'calm', 'energetic'] as const).find((mood) => moodFit(terms, mood) > 0);
}

export function inferSessionMood(controls: Controls, context: Context): SessionMood | undefined {
    if (effectiveMood(controls, context) !== 'any') return;
    const latest = new Map<string | number, Feedback>();
    for (const event of context.sessionReactions || []) {
        if (event.origin === 'library' || event.at > context.now || context.now - event.at >= 12 * 60000) continue;
        const key = event.track.apiId || event.track.id;
        if (!latest.has(key) || latest.get(key)!.at <= event.at) latest.set(key, event);
    }
    const totals = new Map<
        Mood,
        { support: number; tracks: number; dislikes: number; skips: number; skipWeight: number }
    >();
    for (const event of latest.values()) {
        const mood = label(event.track);
        if (!mood) continue;
        const tally = totals.get(mood) || { support: 0, tracks: 0, dislikes: 0, skips: 0, skipWeight: 0 };
        const decay = 2 ** (-(context.now - event.at) / (5 * 60000));
        if (
            event.kind === 'like' ||
            event.kind === 'complete' ||
            (event.kind === 'play' && (event.listenedFraction || 0) >= 0.7)
        ) {
            tally.support += (event.kind === 'like' ? 1.5 : 0.9) * decay;
            tally.tracks++;
        } else if (event.kind === 'dislike') {
            tally.dislikes += decay;
        } else if (event.kind === 'skip' && event.listenedFraction !== undefined && event.listenedFraction < 0.2) {
            tally.skips++;
            tally.skipWeight += 0.65 * decay;
        }
        totals.set(mood, tally);
    }
    const ranked = [...totals]
        .map(([mood, tally]) => ({
            mood,
            tracks: tally.tracks,
            score: Math.max(0, tally.support - tally.dislikes - (tally.skips >= 2 ? tally.skipWeight : 0)),
        }))
        .sort((a, b) => b.score - a.score);
    const first = ranked[0];
    if (!first || first.tracks < 2 || first.score < 1.05) return;
    const share = first.score / ranked.reduce((sum, item) => sum + item.score, 0);
    if (share < 0.62 || first.score - (ranked[1]?.score || 0) < 0.45) return;
    return { mood: first.mood, confidence: share * Math.min(1, first.score / 1.8), supportingTracks: first.tracks };
}

export function sessionMoodScore(track: Track, mood: SessionMood | undefined): number {
    if (!mood) return 0;
    const fit = moodFit(metadataTerms(track), mood.mood);
    if (fit) return 3.2 * mood.confidence * fit;
    if (mood.mood !== 'calm' && mood.mood !== 'energetic') return 0;
    const bpm = measuredBpm(track.features);
    if (!bpm || (bpm > 95 && bpm < 135)) return 0;
    const tempoFit = bpm >= 135 === (mood.mood === 'energetic') ? 1 : -1;
    return 0.55 * mood.confidence * tempoFit;
}
