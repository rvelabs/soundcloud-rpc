import { trackPath } from './nativeQueue';
import { readTrackHydration } from './trackHydration';
import { classifyTrackAvailability, type TrackAvailability } from '../import/availability';
import type { WaveCandidate } from './waveEngine';
import { readTextLimited } from '../utils/readText';
type PublicMetadata = {
    durationSeconds?: number;
    audioRevision?: string;
    genre?: string;
    tags?: string[];
    bpm?: number;
    bpmConfidence?: number;
    artist?: string;
    language?: string;
    playbackCount?: number;
    playability?: TrackAvailability['status'];
};
const cache = new Map<
    string,
    {
        expires: number;
        value: PublicMetadata;
    }
>();
const inFlight = new Map<
    string,
    Promise<{
        expires: number;
        value: PublicMetadata;
    }>
>();
let fetchGeneration = 0;
export function parsePublicTrackMetadata(html: string, url?: string): PublicMetadata {
    const hydrated = url
        ? readTrackHydration(html)?.find(
              (track) => track.permalink_url && trackPath(track.permalink_url) === trackPath(url),
          )
        : undefined;
    if (hydrated) {
        const tags = [...(hydrated.tag_list || '').matchAll(/"([^"\n]+)"|(\S+)/g)]
            .map((match) => (match[1] || match[2]).slice(0, 60))
            .slice(0, 24);
        const bpm = Number(hydrated.bpm);
        return {
            durationSeconds: hydrated.duration ? hydrated.duration / 1000 : undefined,
            audioRevision:
                typeof hydrated.last_modified === 'string' ? hydrated.last_modified.slice(0, 100) : undefined,
            genre: hydrated.genre || undefined,
            tags,
            language: hydrated.language,
            playbackCount:
                typeof hydrated.playback_count === 'number' && Number.isFinite(hydrated.playback_count)
                    ? Math.max(0, hydrated.playback_count)
                    : undefined,
            artist: hydrated.publisher_metadata?.artist,
            ...(bpm >= 50 && bpm <= 220 ? { bpm, bpmConfidence: 0.75 } : {}),
            playability: classifyTrackAvailability(hydrated).status,
        };
    }
    const meta = (key: string): string => {
        const tag = html.match(new RegExp(`<meta\\s+[^>]*itemprop=["']${key}["'][^>]*>`, 'i'))?.[0] || '';
        return tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] || '';
    };
    const duration = meta('duration').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    const durationSeconds = duration
        ? Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0)
        : undefined;
    const genre = meta('genre').replace(/&amp;/g, '&').trim().slice(0, 60);
    return { ...(durationSeconds ? { durationSeconds } : {}), ...(genre ? { genre } : {}) };
}
let metadataFetch: typeof fetch = (...args) => fetch(...args);
export function setPublicMetadataFetch(value: typeof fetch): () => void {
    fetchGeneration++;
    const generation = fetchGeneration;
    metadataFetch = value;
    cache.clear();
    inFlight.clear();
    return () => {
        if (generation !== fetchGeneration) return;
        fetchGeneration++;
        metadataFetch = (...args) => fetch(...args);
        cache.clear();
        inFlight.clear();
    };
}
export async function enrichPublicTrack(candidate: WaveCandidate): Promise<WaveCandidate> {
    const generation = fetchGeneration;
    if (candidate.catalogCheckedAt && Date.now() - candidate.catalogCheckedAt < 30 * 60000) return candidate;
    const path = trackPath(candidate.url);
    if (!path) return candidate;
    let hit = cache.get(path);
    if (!hit || hit.expires < Date.now()) {
        let task = inFlight.get(path);
        if (!task) {
            task = (async () => {
                try {
                    const response = await metadataFetch(`https://soundcloud.com${path}`, {
                        signal: AbortSignal.timeout(5000),
                        redirect: 'error',
                        headers: { Accept: 'text/html' },
                    });
                    if ([403, 404, 410, 451].includes(response.status))
                        return { value: { playability: 'blocked' as const }, expires: Date.now() + 5 * 60000 };
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const value = parsePublicTrackMetadata(await readTextLimited(response), candidate.url);
                    return { value, expires: Date.now() + (value.durationSeconds ? 30 : 5) * 60000 };
                } catch {
                    return { value: {}, expires: Date.now() + 5 * 60000 };
                }
            })();
            inFlight.set(path, task);
        }
        try {
            hit = await task;
        } finally {
            if (inFlight.get(path) === task) inFlight.delete(path);
        }
        if (generation !== fetchGeneration) return candidate;
        cache.set(path, hit);
        if (cache.size > 200) cache.delete(cache.keys().next().value!);
    }
    return {
        ...candidate,
        ...Object.fromEntries(Object.entries(hit.value).filter(([, value]) => value !== undefined)),
        artist: hit.value.artist || candidate.artist,
        tags: hit.value.tags?.length ? hit.value.tags : candidate.tags,
        catalogCheckedAt: hit.expires - 30 * 60000,
        durationSeconds: hit.value.durationSeconds || candidate.durationSeconds,
        genre: hit.value.genre || candidate.genre,
    };
}
