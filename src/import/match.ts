import type { WebContents } from 'electron';
import { extractWaveLinks } from '../wave/nativeWave';
import type { SourceTrack } from './source';
import type { TrackAvailability } from './availability';
export interface ImportMatch {
    source: SourceTrack;
    error?: string;
    soundcloud?: {
        url: string;
        title: string;
        artist: string;
        durationSeconds?: number;
        score: number;
        sourceQuery: string;
        availability?: TrackAvailability;
    };
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const normalize = (value: string): string =>
    value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(feat|ft|featuring)\b/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
function similarity(left: string, right: string): number {
    const a = normalize(left),
        b = normalize(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const x = new Set(a.split(' ')),
        y = new Set(b.split(' '));
    const common = [...x].filter((word) => y.has(word)).length;
    return ((2 * common) / (x.size + y.size)) * 0.78 + (a.includes(b) || b.includes(a) ? 0.22 : 0);
}
export function matchScore(
    source: SourceTrack,
    candidate: {
        title: string;
        artist: string;
        durationSeconds?: number;
    },
): number {
    const sourceTitle = normalize(source.title),
        candidateTitle = normalize(candidate.title);
    const coreTitle = normalize(source.title.replace(/\s*[([(]\s*(?:feat\.?|ft\.?|featuring)\b[^\])]*[\])]/gi, ''));
    const artists = source.artist
        .split(/,|\s+[&×]\s+|\s+and\s+/i)
        .map(normalize)
        .filter(Boolean);
    const title = Math.max(
        similarity(source.title, candidate.title),
        similarity(coreTitle, candidate.title),
        candidateTitle.includes(coreTitle) && coreTitle.length >= 5 ? 0.96 : 0,
        candidateTitle.includes(sourceTitle) && sourceTitle.length >= 5 ? 0.96 : 0,
    );
    const artist = Math.max(
        ...artists.map((name) =>
            Math.max(similarity(name, candidate.artist), candidateTitle.includes(name) && name.length >= 5 ? 0.92 : 0),
        ),
        0,
    );
    const versions = [
        /\bremix\b/i,
        /\bcover\b/i,
        /\blive\b/i,
        /\bsped[ -]?up\b/i,
        /\bslowed\b/i,
        /\bloop(?:ed)?\b/i,
        /\bkaraoke\b/i,
        /\binstrumental\b/i,
        /\b(?:nightcore|acoustic|acapella|a cappella|edit|mashup)\b/i,
    ];
    const penalty = versions.some((pattern) => pattern.test(source.title) !== pattern.test(candidate.title)) ? 0.24 : 0;
    const durationDifference =
        source.durationSeconds && candidate.durationSeconds
            ? Math.abs(source.durationSeconds - candidate.durationSeconds)
            : 0;
    const durationPenalty = durationDifference > Math.max(8, (source.durationSeconds || 0) * 0.12) ? 0.2 : 0;
    return Math.max(0, Math.round((title * 0.72 + artist * 0.28 - penalty - durationPenalty) * 1000) / 1000);
}
export async function findSoundCloudMatch(
    view: WebContents,
    source: SourceTrack,
    signal?: AbortSignal,
    check?: (url: string) => Promise<TrackAvailability>,
): Promise<ImportMatch> {
    const queries = [`${source.artist} ${source.title}`, source.title].map((query) => query.trim().slice(0, 120));
    const rejected = new Set<string>();
    let unavailable: TrackAvailability | undefined;
    for (const query of queries) {
        signal?.throwIfAborted();
        const address = `https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}`;
        let ready: (() => void) | undefined;
        const domReady = new Promise<void>((resolve) => {
            ready = resolve;
            view.once('dom-ready', resolve);
        });
        try {
            await Promise.race([view.loadURL(address), domReady]);
        } finally {
            if (ready) view.removeListener('dom-ready', ready);
        }
        let list: {
            url: string;
            title: string;
            artist: string;
            durationSeconds?: number;
        }[] = [];
        for (let attempt = 0; attempt < 24; attempt++) {
            signal?.throwIfAborted();
            list = (await view.executeJavaScript(`(${extractWaveLinks.toString()})()`, true)) as typeof list;
            if (list.length) break;
            await wait(150);
        }
        signal?.throwIfAborted();
        const ranked = list
            .map((track) => ({ ...track, score: matchScore(source, track) }))
            .filter(
                (track) =>
                    track.score >= 0.78 &&
                    !rejected.has(track.url) &&
                    /^https:\/\/soundcloud\.com\/[\w.~-]+\/[\w.~-]+$/.test(track.url),
            )
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
        for (const candidate of ranked) {
            signal?.throwIfAborted();
            const availability = check ? await check(candidate.url) : undefined;
            signal?.throwIfAborted();
            if (availability && availability.status !== 'available') {
                rejected.add(candidate.url);
                unavailable = availability;
                continue;
            }
            return { source, soundcloud: { ...candidate, sourceQuery: query, availability } };
        }
    }
    return { source, ...(unavailable ? { error: `Подходящие версии недоступны. ${unavailable.reason}` } : {}) };
}
