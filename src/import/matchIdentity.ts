import type { SourceTrack } from './source';
export interface MatchCandidate {
    title: string;
    artist: string;
    durationSeconds?: number;
    publisherArtist?: string;
    description?: string;
}
export const matchText = (value: string): string =>
    value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ё/g, 'е')
        .replace(/\$/g, 's')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
const latin = [
    'a',
    'b',
    'v',
    'g',
    'd',
    'e',
    'zh',
    'z',
    'i',
    'y',
    'k',
    'l',
    'm',
    'n',
    'o',
    'p',
    'r',
    's',
    't',
    'u',
    'f',
    'h',
    'ts',
    'ch',
    'sh',
    'sch',
    '',
    'y',
    '',
    'e',
    'yu',
    'ya',
];
const transliterate = (value: string) =>
    [...value]
        .map((char) => {
            const index = 'абвгдежзийклмнопрстуфхцчшщъыьэюя'.indexOf(char);
            return index < 0 ? char : latin[index];
        })
        .join('');
function similarity(left: string, right: string): number {
    const a = matchText(left),
        b = matchText(right);
    if (!a || !b) return 0;
    if (a === b || transliterate(a) === transliterate(b)) return 1;
    const x = new Set(transliterate(a).split(' ')),
        y = new Set(transliterate(b).split(' '));
    return (2 * [...x].filter((word) => y.has(word)).length) / (x.size + y.size);
}
function artistSimilarity(wanted: string, value: string): number {
    const a = transliterate(matchText(wanted)).replace(/ /g, ''),
        b = transliterate(matchText(value)).replace(/ /g, '');
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length >= 5 && b.includes(a)) return 0.82;
    if (Math.min(a.length, b.length) >= 5 && Math.abs(a.length - b.length) <= 2) {
        let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
        for (let i = 1; i <= a.length; i++) {
            const row = [i];
            for (let j = 1; j <= b.length; j++)
                row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
            previous = row;
        }
        if (previous[b.length] <= 1) return 0.8;
    }
    return similarity(wanted, value);
}
const coreTitle = (value: string) =>
    matchText(
        value
            .replace(/\s*[([(]\s*(?:feat\.?|ft\.?|featuring)\b[^\])]*[\])]/gi, '')
            .replace(/\b(?:official|audio|video|lyrics|hd|hq|\d{3}\s?kbps)\b/gi, ''),
    );
const versions = [
    /remix|ремикс/iu,
    /cover|кавер/iu,
    /\blive\b|лайв/iu,
    /sped[ -]?up/iu,
    /slowed|замедлен/iu,
    /\bloop(?:ed)?\b/iu,
    /karaoke|караоке/iu,
    /instrumental|инструментал/iu,
    /nightcore|acoustic|acapella|a cappella|\bedit\b|mashup/iu,
];
export function matchIdentity(
    source: SourceTrack,
    candidate: MatchCandidate,
): { score: number; title: number; artist: number; requiresReview: boolean; reviewReason?: 'artist' | 'duration' } {
    const wanted = coreTitle(source.title);
    const names = [source.artist, ...source.artist.split(/,|\s+[&×]\s+|\s+and\s+/i)].filter(Boolean);
    const parts = candidate.title.split(/\s*[-–—|:]\s*/);
    const titles = [candidate.title, ...parts];
    let credited = Math.max(
        0,
        ...parts
            .filter((part) => coreTitle(part) !== wanted)
            .flatMap((part) => names.map((name) => artistSimilarity(name, part))),
    );
    const full = transliterate(coreTitle(candidate.title));
    const target = transliterate(wanted);
    for (const credit of [
        full.endsWith(' ' + target) ? full.slice(0, -target.length).trim() : '',
        full.startsWith(target + ' ') ? full.slice(target.length).trim() : '',
    ]) {
        const agreement = Math.max(0, ...names.map((name) => artistSimilarity(name, credit)));
        if (agreement >= 0.75) {
            titles.push(source.title);
            credited = Math.max(credited, agreement);
        }
    }
    const title = Math.max(0, ...titles.map((value) => similarity(wanted, coreTitle(value))));
    const artist = Math.max(
        credited,
        ...names.flatMap((name) => [
            artistSimilarity(name, candidate.artist),
            artistSimilarity(name, candidate.publisherArtist || ''),
        ]),
    );
    const description = Math.max(
        0,
        ...names.map((name) => {
            const alias = transliterate(matchText(name)).replace(/ /g, '');
            return alias.length >= 5 &&
                transliterate(matchText((candidate.description || '').slice(0, 4000)))
                    .replace(/ /g, '')
                    .includes(alias)
                ? 0.55
                : 0;
        }),
    );
    const versionPenalty = versions.some((pattern) => pattern.test(source.title) !== pattern.test(candidate.title))
        ? 0.24
        : 0;
    const difference =
        source.durationSeconds && candidate.durationSeconds
            ? Math.abs(source.durationSeconds - candidate.durationSeconds)
            : 0;
    const durationPenalty = difference > Math.max(8, (source.durationSeconds || 0) * 0.12) ? 0.2 : 0;
    let score = title * 0.76 + Math.max(artist, description) * 0.24 - versionPenalty - durationPenalty;
    const informative =
        wanted.length >= 5 && !/^(?:intro|outro|untitled|интро|аутро|трек|track(?: \d+)?)$/.test(wanted);
    if (title >= 0.99 && informative && !versionPenalty && !durationPenalty && artist < 0.75)
        score = Math.max(score, 0.81 + description * 0.04);
    const requiresReview = artist < 0.75 || durationPenalty > 0;
    return {
        score: Math.max(0, Math.round(Math.min(requiresReview ? 0.84 : 1, score) * 1000) / 1000),
        title,
        artist,
        requiresReview,
        reviewReason: durationPenalty ? 'duration' : artist < 0.75 ? 'artist' : undefined,
    };
}
export function matchScore(source: SourceTrack, candidate: MatchCandidate): number {
    return matchIdentity(source, candidate).score;
}
export function matchQueries(source: SourceTrack): string[] {
    return [...new Set([`${source.artist} ${source.title}`, source.title].map((query) => query.trim().slice(0, 120)))];
}
