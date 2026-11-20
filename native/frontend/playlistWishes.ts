import { measuredBpm, normalize } from '../../src/wave/recommendation/profile';
import { languageEvidence, moodEvidence } from '../../src/wave/recommendation/preferences';
import { tempoMatches } from '../../src/wave/recommendation/ranker';
import type { Controls, Track } from '../../src/wave/recommendation/types';

export interface PlaylistWishes {
    mood?: Exclude<Controls['mood'], 'any'>;
    tempo?: Exclude<Controls['tempo'], 'any'>;
    tone?: Exclude<Controls['tone'], 'any'>;
    language?: Exclude<NonNullable<Controls['language']>, 'any'>;
    genre?: string;
    likes: 'any' | 'prefer' | 'only';
    exclude: string[];
    recognized: string[];
    unrecognized: string[];
    conflicts: string[];
}

const instrumentalWish = 'без (?:слов|вокала|голоса|голосов|пения)|(?:no|without) (?:vocals?|voices?|singing)';
// A bounded vocabulary, not an LLM: unknown words are shown to the user, never sent to an AI service.
const rules: Array<[keyof Pick<PlaylistWishes, 'mood' | 'tempo' | 'tone' | 'language' | 'genre'>, string, string]> = [
    ['mood', 'calm', 'спокойн[а-я]*|поспокойнее|расслаб[а-я]*|calm|calmer|relaxing|chill'],
    ['mood', 'energetic', 'энергичн[а-я]*|бодр[а-я]*|пободрее|energetic|upbeat'],
    ['mood', 'happy', 'весел[а-я]*|повеселее|радост[а-я]*|happy|happier|cheerful'],
    ['mood', 'sad', 'грустн[а-я]*|погрустнее|меланхол[а-я]*|sad|melancholic'],
    ['tempo', 'slow', 'медлен[а-я]*|помедленнее|slow|slower|downtempo'],
    ['tempo', 'medium', 'средн[а-я]* темп[а-я]*|midtempo|moderate tempo'],
    ['tempo', 'fast', 'быстр[а-я]*|побыстрее|fast|faster|uptempo'],
    ['tone', 'bass', 'бас[а-я]*|bass|bassy'],
    ['tone', 'bright', 'ярк[а-я]*|поярче|bright|brighter'],
    ['tone', 'balanced', 'сбалансирован[а-я]*|balanced'],
    ['language', 'instrumental', instrumentalWish + '|instrumental|инструментал[а-я]*'],
    ['language', 'ru', 'на русском|русск[а-я]*|russian'],
    ['language', 'foreign', 'иностранн[а-я]*|зарубежн[а-я]*|foreign'],
    ['genre', 'drum and bass', 'drum ?(?:and|&|n) ?bass|dnb|драм(?: ?энд)? ?бейс'],
    ['genre', 'hip hop', 'hip[ -]?hop|хип[ -]?хоп|рэп[а-я]*|rap'],
    ['genre', 'lofi', 'lo[ -]?fi|лоу[ -]?фай|ло[ -]?фай'],
    ['genre', 'r&b', 'r[&n]b|rhythm and blues'],
    ['genre', 'techno', 'techno|техно'],
    ['genre', 'house', 'house|хаус(?:а|у|ом|е)?'],
    ['genre', 'ambient', 'ambient|эмбиент'],
    ['genre', 'jungle', 'jungle|джангл'],
    ['genre', 'breakbeat', 'breakbeat|брейкбит'],
    ['genre', 'dubstep', 'dubstep|дабстеп'],
    ['genre', 'phonk', 'phonk|фонк(?:а|у|ом|е)?'],
    ['genre', 'trap', 'trap|трэп(?:а|у|ом|е)?'],
    ['genre', 'rock', 'rock|рок(?:а|у|ом|е)?'],
    ['genre', 'metal', 'metal|метал[а-я]*'],
    ['genre', 'jazz', 'jazz|джаз'],
    ['genre', 'pop', 'pop|поп'],
    ['genre', 'classical', 'classical|классическ[а-я]*'],
    ['genre', 'acoustic', 'acoustic|акустик[а-я]*'],
];
const boundary = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu');
export function parsePlaylistWishes(input: string): PlaylistWishes {
    const result: PlaylistWishes = { likes: 'any', exclude: [], recognized: [], unrecognized: [], conflicts: [] };
    let rest = normalize(input.slice(0, 500));
    // Negations are removed before positive matching, so "без рэпа" never becomes "rap".
    rest = rest.replace(boundary(instrumentalWish), () => {
        result.language = 'instrumental';
        result.recognized.push('instrumental');
        return ' ';
    });
    rest = rest.replace(
        /(?:^|[\s,;])(?:без|кроме|не|no|not|without|except)\s+(?:"([^"]{1,100})"|«([^»]{1,100})»|([^,;.!?\n]{1,100}?)(?=\s+(?:и|and|но|but)\s+|[,;.!?\n]|$))/gu,
        (_all, quoted, angled, phrase) => {
            const excluded = String(quoted || angled || phrase).trim();
            const genreRule =
                !quoted &&
                !angled &&
                rules.find(([key, , pattern]) => key === 'genre' && boundary(pattern).test(excluded));
            const term = genreRule ? genreRule[1] : excluded;
            result.exclude.push(term);
            result.recognized.push(`−${term}`);
            return ' ';
        },
    );
    rest = rest.replace(
        boundary('(?:только|only) (?:из )?(?:моих )?(?:лайк[а-я]*|избранн[а-я]*|(?:my )?(?:likes|favorites))'),
        () => {
            result.likes = 'only';
            result.recognized.push('only likes');
            return ' ';
        },
    );
    rest = rest.replace(boundary('лайк[а-я]*|избранн[а-я]*|likes|favorites'), () => {
        if (result.likes !== 'only') result.likes = 'prefer';
        result.recognized.push('likes');
        return ' ';
    });
    for (const [key, value, pattern] of rules)
        rest = rest.replace(boundary(pattern), () => {
            if (result[key] && result[key] !== value) result.conflicts.push(`${result[key]} / ${value}`);
            else (result as unknown as Record<string, unknown>)[key] = value;
            result.recognized.push(value);
            return ' ';
        });
    rest = rest.replace(
        boundary(
            'хочу|пожалуйста|музык[а-я]*|трек[а-я]*|песн[а-я]*|подбери|плейлист|побольше|больше|более|менее|немного|в основном|в|из|моих|мои|с|и|или|чтобы|звучание|темп|похож[а-я]*|please|more|mostly|less|music|songs?|tracks?|with|and|or|my|from|a|the',
        ),
        ' ',
    );
    result.unrecognized = rest.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (result.genre && result.exclude.includes(result.genre)) result.conflicts.push(result.genre);
    result.conflicts = [...new Set(result.conflicts)];
    return result;
}

const musicalText = (track: Track) => normalize([track.genre, ...(track.tags || [])].join(' '));
function hasTerm(text: string, term: string): boolean {
    const canonical = (value: string) =>
        normalize(value)
            .replace(/hip[ -]?hop/g, 'hip hop')
            .replace(/drum(?: and| &| n)? bass|dnb/g, 'drum bass')
            .replace(/lo[ -]?fi/g, 'lofi');
    const words = canonical(text).split(/[^\p{L}\p{N}]+/u);
    return canonical(term)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .every((word) => words.includes(word));
}
export function fitsPlaylistWishes(track: Track, wishes: PlaylistWishes, liked: boolean): boolean {
    if (wishes.likes === 'only' && !liked) return false;
    const metadata = musicalText(track);
    if (wishes.genre && !hasTerm(metadata, wishes.genre)) return false;
    if (wishes.exclude.some((term) => hasTerm([metadata, track.artist, track.title].join(' '), term))) return false;
    if (wishes.language && languageEvidence(track).language !== wishes.language) return false;
    if (wishes.mood) {
        const evidence = moodEvidence(track, wishes.mood);
        if (evidence.conflict || (['happy', 'sad'].includes(wishes.mood) && evidence.score <= 0)) return false;
    }
    if (wishes.tempo) {
        const bpm = measuredBpm(track.features);
        if (bpm !== undefined && !tempoMatches(bpm, wishes.tempo)) return false;
        // Unknown tempo is not treated as a proven match.
        if (bpm === undefined) {
            const hints = {
                slow: 'slow|slowed|downtempo|ambient|slowcore',
                medium: 'midtempo|groove|moderate',
                fast: 'fast|sped|uptempo|speedcore|nightcore|jungle',
            };
            if (!boundary(hints[wishes.tempo]).test(metadata)) return false;
        }
    }
    return true;
}
export function playlistWishBonus(track: Track, wishes: PlaylistWishes, liked: boolean): number {
    let score = wishes.likes === 'prefer' && liked ? 1.5 : 0;
    if (wishes.mood) score += Math.max(-1, Math.min(1, moodEvidence(track, wishes.mood).score));
    const features = track.features;
    if (wishes.tone) {
        const hints = {
            bass: 'bass|808|sub|dubstep|басс|бас',
            bright: 'bright|synth|sparkle|яркий',
            balanced: 'acoustic|organic|balanced|акустика',
        };
        if (boundary(hints[wishes.tone]).test(musicalText(track))) score += 0.5;
    }
    if (wishes.tone === 'bass' && features?.bass !== undefined) score += features.bass;
    if (wishes.tone === 'bright' && features?.brightness !== undefined) score += features.brightness;
    if (wishes.tone === 'balanced' && features?.bass !== undefined && features.brightness !== undefined)
        score += 1 - Math.abs(features.bass - features.brightness);
    return score;
}
