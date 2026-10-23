import type { Context, Controls, Track } from './types';
import { normalize } from './profile';
export type Mood = Controls['mood'];
export type Activity = NonNullable<Controls['activity']>;
export const activities: Record<
    Activity,
    {
        query: string;
        mood: Mood;
        tags: string[];
    }
> = {
    focus: {
        query: 'instrumental focus',
        mood: 'calm',
        tags: ['instrumental', 'ambient', 'lofi', 'study', 'focus', 'downtempo'],
    },
    relax: { query: 'relaxing', mood: 'calm', tags: ['chill', 'ambient', 'acoustic', 'dream', 'relax', 'soft'] },
    workout: {
        query: 'workout',
        mood: 'energetic',
        tags: ['dance', 'rave', 'techno', 'hardstyle', 'workout', 'energetic'],
    },
    wake: {
        query: 'morning uplifting',
        mood: 'energetic',
        tags: ['morning', 'sunrise', 'uplifting', 'upbeat', 'wake'],
    },
    commute: { query: 'road travel', mood: 'any', tags: ['road', 'travel', 'driving', 'drive', 'cruising'] },
    sleep: {
        query: 'sleep soft instrumental',
        mood: 'calm',
        tags: ['sleep', 'sleeping', 'drone', 'soft', 'night', 'ambient'],
    },
};
const moods: Record<
    Exclude<Mood, 'any'>,
    {
        terms: string[];
        opposite: string[];
    }
> = {
    calm: {
        terms: ['ambient', 'chill', 'lofi', 'acoustic', 'downtempo', 'dream', 'soft', 'calm', 'эмбиент', 'спокойное'],
        opposite: ['rave', 'hardstyle', 'hardcore', 'energetic', 'aggressive'],
    },
    energetic: {
        terms: [
            'rave',
            'techno',
            'hardstyle',
            'jungle',
            'hardcore',
            'dance',
            'breakcore',
            'energetic',
            'upbeat',
            'бодрое',
        ],
        opposite: ['sleep', 'sleeping', 'drone', 'calm', 'downtempo'],
    },
    happy: {
        terms: [
            'happy',
            'joyful',
            'cheerful',
            'uplifting',
            'sunshine',
            'веселое',
            'весёлое',
            'радостное',
            'веселый',
            'весёлый',
        ],
        opposite: ['sad', 'melancholic', 'melancholy', 'sorrow', 'depressing', 'грустное', 'грустный'],
    },
    sad: {
        terms: [
            'sad',
            'melancholic',
            'melancholy',
            'sorrow',
            'heartbreak',
            'depressing',
            'грустное',
            'грустный',
            'печаль',
        ],
        opposite: ['happy', 'joyful', 'cheerful', 'sunshine', 'весёлое', 'радостное'],
    },
};
export const words = (track: Track): Set<string> =>
    new Set(normalize([track.title, track.genre || '', ...(track.tags || [])].join(' ')).split(/[^\p{L}\p{N}]+/u));
export function effectiveMood(controls: Controls, context: Context): Mood {
    return controls.mood !== 'any' ? controls.mood : context.activity ? activities[context.activity].mood : 'any';
}
export function moodEvidence(
    track: Track,
    mood: Mood,
): {
    score: number;
    conflict: boolean;
    reason?: string;
} {
    if (mood === 'any') return { score: 0, conflict: false };
    const terms = words(track),
        info = moods[mood];
    const match = info.terms.some((term) => terms.has(term)),
        opposite = info.opposite.some((term) => terms.has(term));
    const energy = track.features?.energy;
    if ((mood === 'calm' || mood === 'energetic') && energy !== undefined && Number.isFinite(energy)) {
        const value = Math.max(0, Math.min(1, energy));
        return {
            score: (mood === 'calm' ? 0.5 - value : value - 0.5) * 7,
            conflict: mood === 'calm' ? value > 0.65 : value < 0.35,
            reason: 'измеренная энергия',
        };
    }
    return {
        score: match ? 2.5 : opposite ? -2.5 : 0,
        conflict: opposite && !match,
        reason: match ? 'настроение по тегам' : undefined,
    };
}
export function languageEvidence(track: Track): {
    language: 'ru' | 'foreign' | 'instrumental' | 'unknown';
    reason: string;
} {
    const text = normalize([track.title, track.genre || '', ...(track.tags || [])].join(' '));
    const languageTags = normalize([track.genre || '', ...(track.tags || [])].join(' '));
    const declared = normalize(track.language || '');
    const terms = words(track);
    const instrumental =
        ['zxx', 'instrumental'].includes(declared) ||
        /instrumental|без слов|без вокала|no vocals|no vocal|в инструментале/iu.test(text);
    const vocal = terms.has('vocal') || terms.has('vocals') || terms.has('вокал');
    const russian =
        /^(ru(?:-ru)?|rus|russian|русский)$/.test(declared) ||
        /russian|русский|русская|русское|русский рэп|на русском|русрэп/iu.test(languageTags);
    const foreign =
        /^(?:en|eng|es|spa|fr|fra|de|deu|it|ita|ja|jpn|ko|kor|pt|por|zh|zho|ar|ara|uk|ukr|tr|tur)(?:-[a-z]{2})?$/.test(
            declared,
        ) ||
        /english|japanese|spanish|french|german|korean|italian|portuguese|английский|японский|испанский|французский|немецкий|корейский/iu.test(
            languageTags,
        );
    if (instrumental && !vocal && !russian && !foreign)
        return { language: 'instrumental', reason: 'пометка «без слов»' };
    if (!instrumental && russian && !foreign) return { language: 'ru', reason: 'пометка русского языка' };
    if (!instrumental && foreign && !russian) return { language: 'foreign', reason: 'пометка иностранного языка' };
    return { language: 'unknown', reason: 'язык не подтверждён' };
}
export function matchesLanguage(track: Track, controls: Controls, allowUnknown = false): boolean {
    if (!controls.language || controls.language === 'any') return true;
    const evidence = languageEvidence(track);
    return evidence.language === controls.language || (allowUnknown && evidence.language === 'unknown');
}
export function languageQuery(controls: Controls, rotation: number): string {
    return controls.language === 'ru'
        ? 'russian'
        : controls.language === 'instrumental'
          ? 'instrumental no vocals'
          : controls.language === 'foreign'
            ? ['english', 'japanese', 'spanish', 'french'][rotation % 4]
            : '';
}
export const MIN_POPULAR_PLAYS = 1000;
export const popularEnough = (track: Track): boolean =>
    typeof track.playbackCount === 'number' &&
    Number.isFinite(track.playbackCount) &&
    track.playbackCount >= MIN_POPULAR_PLAYS;
