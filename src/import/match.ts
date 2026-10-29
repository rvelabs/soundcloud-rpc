import type { WebContents } from 'electron';
import { extractWaveLinks } from '../wave/nativeWave';
import type { SourceTrack } from './source';
import type { TrackAvailability } from './availability';
import { matchIdentity, matchQueries } from './matchIdentity';
export { matchScore } from './matchIdentity';
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
        requiresReview?: boolean;
        reviewReason?: 'artist' | 'duration';
        publisherArtist?: string;
    };
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function findSoundCloudMatch(
    view: WebContents,
    source: SourceTrack,
    signal?: AbortSignal,
    check?: (url: string) => Promise<TrackAvailability>,
): Promise<ImportMatch> {
    const queries = matchQueries(source);
    const rejected = new Set<string>();
    let unavailable: TrackAvailability | undefined;
    let review: ImportMatch | undefined;
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
            .map((track) => ({ ...track, ...matchIdentity(source, track), title: track.title, artist: track.artist }))
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
            const found = { source, soundcloud: { ...candidate, sourceQuery: query, availability } };
            if (!candidate.requiresReview && candidate.score >= 0.85) return found;
            if (!review || review.soundcloud!.score < candidate.score) review = found;
        }
    }
    return (
        review || { source, ...(unavailable ? { error: `Подходящие версии недоступны. ${unavailable.reason}` } : {}) }
    );
}
