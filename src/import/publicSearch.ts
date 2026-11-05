import { readTextLimited } from '../utils/readText';
import type { WorkScheduler } from '../utils/workScheduler';
import { readTrackHydration, type CatalogTrack } from '../wave/trackHydration';
import { trackPath } from '../wave/nativeQueue';
import { classifyTrackAvailability, type TrackAvailability } from './availability';
import type { ImportMatch } from './match';
import { matchIdentity, matchQueries, type MatchCandidate } from './matchIdentity';
import type { SourceTrack } from './source';
import { TaskPool } from './taskPool';
import { cancelImportOperation } from './parallel';
import type { SoundCloudCatalog } from '../soundcloud/catalog';
interface SearchHit extends MatchCandidate {
    url: string;
}
interface InspectedHit extends SearchHit {
    apiId?: number;
    availability: TrackAvailability;
}
type SearchResult = ReturnType<typeof parsePublicSearch> & { api?: boolean };
function decode(value: string): string {
    return value
        .replace(/<[^>]*>/g, '')
        .replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|ndash|mdash);/gi, (all, entity: string) => {
            const named: Record<string, string> = {
                amp: '&',
                quot: '"',
                apos: "'",
                lt: '<',
                gt: '>',
                nbsp: ' ',
                ndash: '–',
                mdash: '—',
            };
            if (!entity.startsWith('#')) return named[entity.toLowerCase()] || all;
            const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
            return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
        })
        .replace(/\s+/g, ' ')
        .trim();
}
export function parsePublicSearch(html: string): { supported: boolean; tracks: SearchHit[] } {
    const tracks = new Map<string, SearchHit>();
    const add = (url: string, title: string, artist: string) => {
        const path = trackPath(url);
        if (!path || !title || /\/(?:search|you|tags|settings)\//.test(path)) return;
        const address = 'https://soundcloud.com' + path;
        tracks.set(address, { url: address, title: title.slice(0, 200), artist: artist.slice(0, 200) });
    };
    for (const item of readTrackHydration(html) || [])
        if (item.permalink_url && item.title) add(item.permalink_url, item.title, item.user?.username || '');
    for (const block of html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi))
        for (const hit of block[1].matchAll(/<h2\b[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
            const href = decode(hit[1]);
            if (!/^\/[\w.~-]+\/[\w.~-]+\/?$/.test(href)) continue;
            add('https://soundcloud.com' + href, decode(hit[2]), decodeURIComponent(href.split('/')[1]));
        }
    return {
        supported: tracks.size > 0 || /<noscript[\s\S]*?href=["']\/search\/sounds["']/i.test(html),
        tracks: [...tracks.values()].slice(0, 30),
    };
}
class SearchRequestError extends Error {
    constructor(readonly limited: boolean) {
        super(
            limited
                ? 'SoundCloud ограничил частоту запросов. Повторите проверку.'
                : 'Не удалось прочитать результаты поиска.',
        );
    }
}
export class PublicSoundCloudSearch {
    private pool: TaskPool;
    private searches = new Map<string, { until: number; task: Promise<SearchResult> }>();
    private details = new Map<string, { until: number; task: Promise<InspectedHit | undefined> }>();
    private unsupported = false;
    private limitedUntil = 0;
    private catalogRevision = -1;
    constructor(
        private request: typeof fetch,
        private fallback: (source: SourceTrack) => Promise<ImportMatch>,
        private signal: AbortSignal,
        concurrency: () => number = () => 10,
        private now = Date.now,
        private scheduler?: WorkScheduler,
        private catalog?: SoundCloudCatalog,
    ) {
        this.pool = new TaskPool(concurrency);
    }
    private async page(url: string): Promise<string> {
        const load = async () => {
            const signal = AbortSignal.any([this.signal, AbortSignal.timeout(6500)]);
            signal.throwIfAborted();
            const response = await this.request(url, { redirect: 'error', signal, headers: { Accept: 'text/html' } });
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                if (response.status === 429) {
                    const seconds = Number(response.headers.get('retry-after'));
                    const delay = Number.isFinite(seconds) && seconds > 0 ? Math.min(30000, seconds * 1000) : 10000;
                    this.limitedUntil = this.now() + delay;
                    this.pool.backoff(delay);
                }
                throw new SearchRequestError(response.status === 429);
            }
            return readTextLimited(response, 3000000);
        };
        return this.pool.run(
            () => (this.scheduler ? this.scheduler.run('network', 'import', load, this.signal) : load()),
            this.signal,
        );
    }
    private search(query: string): Promise<SearchResult> {
        const cached = this.searches.get(query);
        if (cached && cached.until > this.now()) return cached.task;
        const task = (async () => {
            const tracks = await this.catalog?.search(query, this.signal);
            if (tracks)
                return {
                    supported: true,
                    api: true,
                    tracks: tracks.map((track) => ({
                        url: track.permalink_url,
                        title: track.title,
                        artist: track.user?.username || '',
                        publisherArtist: track.publisher_metadata?.artist,
                        description: track.description,
                        durationSeconds: track.duration ? track.duration / 1000 : undefined,
                    })),
                };
            if (this.catalog?.limited) {
                this.limitedUntil = this.now() + this.catalog.retryAfterMs;
                throw new SearchRequestError(true);
            }
            return parsePublicSearch(
                await this.page('https://soundcloud.com/search/sounds?q=' + encodeURIComponent(query)),
            );
        })().catch((error) => {
            if (this.searches.get(query)?.task === task) this.searches.delete(query);
            throw error;
        });
        this.searches.set(query, { until: this.now() + 2 * 60000, task });
        if (this.searches.size > 600) this.searches.delete(this.searches.keys().next().value!);
        return task;
    }
    private inspect(hit: SearchHit): Promise<InspectedHit | undefined> {
        const cached = this.details.get(hit.url);
        if (cached && cached.until > this.now()) return cached.task;
        const task = (async () => {
            let data: CatalogTrack | null | undefined = await this.catalog?.resolve(hit.url, 'import', this.signal);
            if ((!data || classifyTrackAvailability(data).status === 'unknown') && this.catalog?.limited) {
                this.limitedUntil = this.now() + this.catalog.retryAfterMs;
                throw new SearchRequestError(true);
            }
            if (!data || classifyTrackAvailability(data).status === 'unknown') {
                const html = await this.page(hit.url);
                data = readTrackHydration(html)?.find(
                    (track) => track.permalink_url && trackPath(track.permalink_url) === trackPath(hit.url),
                );
            }
            if (!data?.title) return undefined;
            return {
                apiId: Number.isSafeInteger(data.id) && Number(data.id) > 0 ? data.id : undefined,
                url: hit.url,
                title: data.title.slice(0, 200),
                artist: data.user?.username?.slice(0, 200) || hit.artist,
                publisherArtist: data.publisher_metadata?.artist?.slice(0, 200),
                description: data.description?.slice(0, 4000),
                durationSeconds: data.duration && Number.isFinite(data.duration) ? data.duration / 1000 : undefined,
                availability: classifyTrackAvailability(data),
            };
        })().catch((error) => {
            if (this.details.get(hit.url)?.task === task) this.details.delete(hit.url);
            throw error;
        });
        this.details.set(hit.url, { until: this.now() + 2 * 60000, task });
        if (this.details.size > 700) this.details.delete(this.details.keys().next().value!);
        return task;
    }
    async match(source: SourceTrack): Promise<ImportMatch> {
        this.signal.throwIfAborted();
        if (this.catalog && this.catalogRevision !== this.catalog.revision) {
            this.catalogRevision = this.catalog.revision;
            this.searches.clear();
            this.details.clear();
            this.unsupported = false;
        }
        if (this.limitedUntil > this.now()) return { source, error: new SearchRequestError(true).message };
        if (this.unsupported && !this.catalog?.available) return this.fallback(source);
        const deadline = AbortSignal.any([this.signal, AbortSignal.timeout(10000)]);
        const inspected = new Set<string>();
        let review: ImportMatch | undefined;
        try {
            let allApi = true;
            for (const query of matchQueries(source)) {
                const results = await cancelImportOperation(this.search(query), deadline);
                if (!results.api) allApi = false;
                if (!results.supported) {
                    this.unsupported = true;
                    break;
                }
                const ranked = results.tracks
                    .map((track) => ({ track, identity: matchIdentity(source, track) }))
                    .filter(({ identity }) => identity.title >= 0.6)
                    .sort((a, b) => b.identity.score - a.identity.score)
                    .slice(0, 4);
                for (const { track } of ranked) {
                    if (inspected.has(track.url)) continue;
                    inspected.add(track.url);
                    const candidate = await cancelImportOperation(this.inspect(track), deadline);
                    if (!candidate || candidate.availability.status !== 'available') continue;
                    const identity = matchIdentity(source, candidate);
                    if (identity.score < 0.78) continue;
                    const found: ImportMatch = {
                        source,
                        soundcloud: {
                            apiId: candidate.apiId,
                            url: candidate.url,
                            title: candidate.title,
                            artist: candidate.artist,
                            durationSeconds: candidate.durationSeconds,
                            publisherArtist: candidate.publisherArtist,
                            score: identity.score,
                            requiresReview: identity.requiresReview,
                            reviewReason: identity.reviewReason,
                            sourceQuery: query,
                            availability: candidate.availability,
                        },
                    };
                    if (!identity.requiresReview && identity.score >= 0.85) return found;
                    if (!review || review.soundcloud!.score < identity.score) review = found;
                }
            }
            if (allApi) return review || { source };
        } catch (error) {
            this.signal.throwIfAborted();
            if (this.limitedUntil > this.now() || (error instanceof SearchRequestError && error.limited))
                return review || { source, error: new SearchRequestError(true).message };
        }
        this.signal.throwIfAborted();
        return review || this.fallback(source);
    }
}
