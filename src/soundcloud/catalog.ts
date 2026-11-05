import { hasCatalogMetadata } from '../wave/trackHydration';
import { trackPath } from '../wave/nativeQueue';
import { readTextLimited } from '../utils/readText';
import type { WorkPriority, WorkScheduler } from '../utils/workScheduler';
import {
    apiObject as object,
    apiId,
    parsePage,
    parsePlaylist,
    parseTrackPage,
    ApiWriteError,
    type ApiAccount,
    type ApiPage,
    type ApiPlaylist,
} from './accountTypes';

export { parseApiTrack } from './trackTypes';
import { parseApiTrack, type ApiTrack } from './trackTypes';
import { RadioSources, type LibrarySignals } from './radioSources';
export type { ApiTrack } from './trackTypes';
const base = 'https://api-v2.soundcloud.com';
function collection(value: unknown): ApiTrack[] | null {
    const items = object(value)?.collection;
    if (!Array.isArray(items)) return null;
    const tracks = items
        .slice(0, 50)
        .map(parseApiTrack)
        .filter((item): item is ApiTrack => item !== null);
    return items.length && !tracks.length ? null : tracks;
}
export class SoundCloudCatalog {
    private clientId = '';
    private authorization = '';
    private generation = 0;
    private route = '';
    private abort = new AbortController();
    private cache = new Map<string, { until: number; value: unknown }>();
    private tracks = new Map<string, { until: number; track: ApiTrack }>();
    private index = new Map<string, { until: number; track: ApiTrack }>();
    private pending = new Map<string, Promise<unknown | null>>();
    private cacheVersion = 0;
    private sequence = 0;
    private blockedUntil = 0;
    private rateLimitedUntil = 0;
    private closed = false;
    private requests = 0;
    private hits = 0;
    private failures = 0;
    private lastStatus = 0;
    private likeSnapshot?: { revision: number; at: number; ids: Set<number>; complete: boolean };
    private account?: { until: number; value: ApiAccount };
    private radio: RadioSources;
    constructor(
        private request: typeof fetch,
        private scheduler?: WorkScheduler,
        private getRoute = () => '',
        private now = Date.now,
    ) {
        this.radio = new RadioSources(
            (path, params, decode, signal, auth = false) =>
                this.load(path, params, decode, 'prefetch', signal, { auth, optional: true }),
            (ids) => this.batch(ids),
            () => this.generation,
            this.now,
        );
    }
    observe(address: string, headers: Record<string, string>): void {
        if (this.closed) return;
        let url: URL;
        try {
            url = new URL(address);
        } catch {
            return;
        }
        if (url.origin !== base) return;
        const id = url.searchParams.get('client_id');
        if (!id || !/^[a-zA-Z0-9]{32}$/.test(id)) return;
        const auth = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
        const authorization = auth && /^(OAuth|Bearer) [a-zA-Z0-9._~-]{8,2048}$/i.test(auth) ? auth : '';
        if (id !== this.clientId || (authorization && authorization !== this.authorization)) {
            const rateLimit = this.limited ? this.blockedUntil : 0;
            this.clear();
            this.clientId = id;
            this.authorization = authorization;
            this.blockedUntil = rateLimit;
        }
    }
    reset(): void {
        this.clear();
        this.clientId = '';
        this.authorization = '';
        this.blockedUntil = 0;
        this.rateLimitedUntil = 0;
    }
    get limited(): boolean {
        return this.rateLimitedUntil > this.now();
    }
    get available(): boolean {
        return !this.closed && Boolean(this.clientId);
    }
    get revision(): number {
        return this.generation;
    }
    get retryAfterMs(): number {
        return Math.max(0, this.blockedUntil - this.now());
    }
    private clear(): void {
        this.generation++;
        this.abort.abort();
        this.abort = new AbortController();
        this.cache.clear();
        this.tracks.clear();
        this.index.clear();
        this.pending.clear();
        this.cacheVersion++;
        this.likeSnapshot = undefined;
        this.account = undefined;
        this.radio.clear();
    }
    private ready(): boolean {
        const route = this.getRoute();
        if (route !== this.route) {
            this.route = route;
            this.clear();
        }
        return !this.closed && Boolean(this.clientId);
    }
    private async wait<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
        if (!signal) return task;
        signal.throwIfAborted();
        return new Promise<T>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }
    private remember(value: unknown): void {
        const list = Array.isArray(value) ? value : object(value)?.items;
        if (!Array.isArray(list)) return;
        for (const item of list) {
            if (!item || typeof item !== 'object' || !apiId(item.id) || !trackPath(item.permalink_url || '')) continue;
            const track = item as ApiTrack,
                until = this.now() + 120000;
            this.index.set(track.permalink_url, { until, track });
            if (hasCatalogMetadata(track)) this.tracks.set(track.permalink_url, { until, track });
        }
        for (const map of [this.index, this.tracks]) while (map.size > 600) map.delete(map.keys().next().value!);
    }
    private async load<T>(
        path: string,
        params: Record<string, string>,
        decode: (value: unknown) => T | null,
        priority: WorkPriority,
        signal?: AbortSignal,
        options: { fresh?: boolean; auth?: boolean; ttl?: number; optional?: boolean } = {},
    ): Promise<T | null> {
        signal?.throwIfAborted();
        if (!this.ready() || (options.auth && !this.authorization)) return null;
        const url = new URL(path, base);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const key = url.href + ':' + this.cacheVersion;
        const cached = this.cache.get(key);
        if (!options.fresh && cached && cached.until > this.now()) {
            this.hits++;
            return structuredClone(cached.value) as T;
        }
        if (this.now() < this.blockedUntil) return null;
        const pendingKey = options.fresh ? key + ':fresh-' + this.sequence++ : key;
        let task = this.pending.get(pendingKey) as Promise<T | null> | undefined;
        if (!task) {
            const generation = this.generation,
                lifecycle = this.abort.signal;
            const cacheVersion = this.cacheVersion;
            url.searchParams.set('client_id', this.clientId);
            const authorization = this.authorization;
            const request = async (): Promise<T | null> => {
                if (this.closed || generation !== this.generation || this.now() < this.blockedUntil) return null;
                this.requests++;
                try {
                    const response = await this.request(url.href, {
                        method: 'GET',
                        redirect: 'error',
                        credentials: options.auth ? 'include' : 'omit',
                        headers: {
                            Accept: 'application/json',
                            ...(authorization ? { Authorization: authorization } : {}),
                        },
                        signal: AbortSignal.any([lifecycle, AbortSignal.timeout(3500)]),
                    });
                    if (generation !== this.generation) {
                        void response.body?.cancel().catch(() => {});
                        return null;
                    }
                    this.lastStatus = response.status;
                    if (!response.ok) {
                        void response.body?.cancel().catch(() => {});
                        if (response.status === 401 || (response.status === 403 && !options.optional)) {
                            this.clear();
                            this.blockedUntil = Math.max(this.now() + 60000, this.rateLimitedUntil);
                        } else if (response.status === 429) {
                            const retry = response.headers.get('retry-after'),
                                seconds = Number(retry);
                            const delay =
                                Number.isFinite(seconds) && seconds > 0
                                    ? seconds * 1000
                                    : Date.parse(retry || '') - this.now();
                            this.rateLimitedUntil = Math.max(
                                this.rateLimitedUntil,
                                this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 30000),
                            );
                            this.blockedUntil = Math.max(this.blockedUntil, this.rateLimitedUntil);
                        } else if (response.status >= 500 && !options.optional)
                            this.blockedUntil = Math.max(this.blockedUntil, this.now() + 10000);
                        this.failures++;
                        return null;
                    }
                    const value = decode(
                        JSON.parse(await readTextLimited(response, path.startsWith('/playlists/') ? 8000000 : 3000000)),
                    );
                    if (generation !== this.generation) return null;
                    if (value === null) {
                        this.failures++;
                        if (!options.optional) this.blockedUntil = Math.max(this.blockedUntil, this.now() + 30000);
                        return null;
                    }
                    const until = this.now() + (options.ttl ?? 120000);
                    if (cacheVersion === this.cacheVersion) {
                        if (!options.fresh) this.cache.set(key, { until, value });
                        this.remember(value);
                    }
                    if (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value!);
                    while (this.tracks.size > 600) this.tracks.delete(this.tracks.keys().next().value!);
                    return value;
                } catch {
                    if (generation === this.generation) {
                        this.failures++;
                        if (!options.optional) this.blockedUntil = Math.max(this.blockedUntil, this.now() + 10000);
                    }
                    return null;
                }
            };
            task = this.scheduler
                ? this.scheduler.run('network', priority, request, lifecycle).catch(() => null)
                : request();
            this.pending.set(pendingKey, task);
            void task.finally(() => {
                if (this.pending.get(pendingKey) === task) this.pending.delete(pendingKey);
            });
        } else this.hits++;
        const value = await this.wait(task, signal);
        return value === null ? null : structuredClone(value);
    }
    search(query: string, signal?: AbortSignal): Promise<ApiTrack[] | null> {
        if (!query.trim() || query.length > 500) return Promise.resolve(null);
        return this.load(
            '/search/tracks',
            { q: query, limit: '30', linked_partitioning: '1' },
            collection,
            'import',
            signal,
        );
    }
    async resolve(url: string, priority: WorkPriority = 'prefetch', signal?: AbortSignal): Promise<ApiTrack | null> {
        signal?.throwIfAborted();
        const path = trackPath(url);
        if (!path || !this.ready()) return null;
        const address = 'https://soundcloud.com' + path,
            cached = this.tracks.get(address);
        if (cached && cached.until > this.now()) {
            this.hits++;
            return structuredClone(cached.track);
        }
        const tracks = await this.load(
            '/resolve',
            { url: address },
            (value) => {
                const track = parseApiTrack(value);
                return track?.permalink_url === address ? [track] : null;
            },
            priority,
            signal,
        );
        return tracks?.[0] || null;
    }
    async related(url: string, advance = false): Promise<ApiTrack[] | null> {
        const track = await this.resolve(url);
        return track ? this.radio.related(track.id, advance) : null;
    }
    homeCandidates(): Promise<ApiTrack[] | null> {
        return this.radio.home();
    }
    async collectionCandidates(url: string): Promise<ApiTrack[] | null> {
        const seed = await this.resolve(url);
        return seed ? this.radio.collection(seed.id) : null;
    }
    async followingCandidates(): Promise<ApiTrack[] | null> {
        const me = await this.profile();
        return me ? this.radio.following(me.id) : null;
    }
    async librarySignals(signal?: AbortSignal): Promise<LibrarySignals | null> {
        const me = await this.profile(signal);
        return me ? this.radio.signals(me.id, signal) : null;
    }
    observeLike(owner: number, id: number, desired: boolean): void {
        if (this.account?.value.id !== owner || this.account.value.revision !== this.generation) return;
        this.radio.liked(id, desired);
        if (this.likeSnapshot) {
            if (desired) this.likeSnapshot.ids.add(id);
            else this.likeSnapshot.ids.delete(id);
        }
    }
    async batch(
        ids: readonly number[],
        priority: WorkPriority = 'prefetch',
        signal?: AbortSignal,
    ): Promise<ApiTrack[] | null> {
        signal?.throwIfAborted();
        if (!this.ready()) return null;
        const unique = [...new Set(ids.filter(apiId))].slice(0, 500);
        const found = new Map<number, ApiTrack>();
        for (const { until, track } of this.tracks.values())
            if (until > this.now() && unique.includes(track.id)) found.set(track.id, track);
        const missing = unique.filter((id) => !found.has(id));
        for (let index = 0; index < missing.length; index += 20) {
            const tracks = await this.load(
                '/tracks',
                { ids: missing.slice(index, index + 20).join(',') },
                (value) => {
                    if (!Array.isArray(value)) return null;
                    return value.map(parseApiTrack).filter((item): item is ApiTrack => item !== null);
                },
                priority,
                signal,
            );
            if (tracks === null) return found.size ? [...found.values()] : null;
            for (const track of tracks) if (unique.includes(track.id)) found.set(track.id, track);
        }
        return unique.flatMap((id) => (found.has(id) ? [structuredClone(found.get(id)!)] : []));
    }
    async prime(ids: readonly number[], signal?: AbortSignal): Promise<void> {
        if (ids.length > 1) await this.batch(ids, 'import', signal);
    }
    async profile(signal?: AbortSignal): Promise<ApiAccount | null> {
        signal?.throwIfAborted();
        if (!this.ready() || !this.authorization) return null;
        if (this.account && this.account.until > this.now() && this.account.value.revision === this.generation)
            return { ...this.account.value };
        const result = await this.load(
            '/me',
            {},
            (value) => {
                const item = object(value);
                return item && apiId(item.id) && typeof item.username === 'string'
                    ? {
                          id: item.id,
                          username: item.username.slice(0, 200),
                          permalink: typeof item.permalink === 'string' ? item.permalink.slice(0, 100) : '',
                          revision: this.generation,
                      }
                    : null;
            },
            'prefetch',
            signal,
            { auth: true, ttl: 30000 },
        );
        if (result && result.revision === this.generation) this.account = { until: this.now() + 30000, value: result };
        return result;
    }
    private continuation(path: string, next: string): Record<string, string> | null {
        try {
            const url = new URL(next);
            if (url.origin !== base || url.pathname !== path || url.username || url.password || next.length > 6000)
                return null;
            url.searchParams.delete('client_id');
            url.searchParams.delete('access_token');
            return Object.fromEntries(url.searchParams);
        } catch {
            return null;
        }
    }
    private async pages<T>(
        path: string,
        decode: (value: unknown) => ApiPage<T> | null,
        max: number,
        signal?: AbortSignal,
        fresh = false,
    ): Promise<{ items: T[]; complete: boolean } | null> {
        const items: T[] = [],
            seen = new Set<string>();
        let query: Record<string, string> = { limit: '100', linked_partitioning: '1' };
        for (let n = 0; n < Math.min(500, Math.ceil(max / 100) + 2); n++) {
            const page: ApiPage<T> | null = await this.load(path, query, decode, 'prefetch', signal, {
                auth: true,
                fresh,
            });
            if (!page) return null;
            items.push(...page.items);
            if (!page.next) return { items: items.slice(0, max), complete: items.length <= max };
            if (items.length >= max) return { items: items.slice(0, max), complete: false };
            if (seen.has(page.next)) return null;
            seen.add(page.next);
            const next = this.continuation(path, page.next);
            if (!next) return null;
            query = next;
        }
        return null;
    }
    async personalHistory(
        signal?: AbortSignal,
    ): Promise<{ likes: ApiTrack[] | null; recent: ApiTrack[] | null } | null> {
        const me = await this.profile(signal);
        if (!me) return null;
        const [likes, recent] = await Promise.all([
            this.pages(`/users/${me.id}/track_likes`, parseTrackPage, 120, signal),
            this.pages('/me/play-history/tracks', parseTrackPage, 60, signal),
        ]);
        if (me.revision !== this.generation) return null;
        return { likes: likes?.items || null, recent: recent?.items || null };
    }
    async ownPlaylists(scope: ApiAccount, signal?: AbortSignal): Promise<ApiPlaylist[] | null> {
        if (scope.revision !== this.generation) return null;
        const result = await this.pages(
            `/users/${scope.id}/playlists`,
            (value) => parsePage(value, parsePlaylist),
            1000,
            signal,
            true,
        );
        return scope.revision === this.generation && result?.complete
            ? result.items.filter((item) => item.ownerId === scope.id)
            : null;
    }
    async playlist(id: number, scope: ApiAccount, signal?: AbortSignal): Promise<ApiPlaylist | null> {
        if (!apiId(id) || scope.revision !== this.generation) return null;
        const result = await this.load(
            `/playlists/${id}`,
            { representation: 'full' },
            parsePlaylist,
            'import',
            signal,
            { auth: true, fresh: true },
        );
        return scope.revision === this.generation && result?.id === id && result.ownerId === scope.id ? result : null;
    }
    private invalidateReads(): void {
        this.cacheVersion++;
        this.cache.clear();
    }
    private async mutate<T>(
        scope: ApiAccount,
        method: 'PUT' | 'POST' | 'DELETE',
        path: string,
        body: unknown,
        decode: (value: unknown) => T | null,
        signal?: AbortSignal,
        priority: WorkPriority = 'import',
    ): Promise<T> {
        signal?.throwIfAborted();
        if (!this.ready() || !this.authorization || scope.revision !== this.generation) throw new ApiWriteError(0);
        if (this.limited) throw new ApiWriteError(429);
        const lifecycle = this.abort.signal;
        const perform = async () => {
            signal?.throwIfAborted();
            if (!this.ready() || !this.authorization || scope.revision !== this.generation) throw new ApiWriteError(0);
            if (this.limited) throw new ApiWriteError(429);
            const url = new URL(path, base);
            url.searchParams.set('client_id', this.clientId);
            this.requests++;
            let response: Response;
            try {
                response = await this.request(url.href, {
                    method,
                    redirect: 'error',
                    credentials: 'include',
                    headers: {
                        Accept: 'application/json',
                        Authorization: this.authorization,
                        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: AbortSignal.any([lifecycle, AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
                });
            } catch {
                throw new ApiWriteError(0, true);
            }
            this.lastStatus = response.status;
            if (scope.revision !== this.generation) {
                void response.body?.cancel().catch(() => {});
                throw new ApiWriteError(0, true);
            }
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                if (response.status === 429) {
                    const retry = Number(response.headers.get('retry-after'));
                    this.rateLimitedUntil = this.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 30000);
                    this.blockedUntil = Math.max(this.blockedUntil, this.rateLimitedUntil);
                }
                if (response.status === 401 || response.status === 403) {
                    this.clear();
                    this.blockedUntil = Math.max(this.now() + 60000, this.rateLimitedUntil);
                }
                this.failures++;
                throw new ApiWriteError(response.status, response.status >= 500);
            }
            this.invalidateReads();
            try {
                const bodyText = response.status === 204 ? '' : await readTextLimited(response, 8000000);
                const value = bodyText.trim() ? JSON.parse(bodyText) : null;
                const parsed = decode(value);
                if (parsed === null) throw new Error('Invalid response');
                if (scope.revision !== this.generation) throw new Error('Session changed');
                return parsed;
            } catch {
                throw new ApiWriteError(response.status, true);
            }
        };
        return this.scheduler ? this.scheduler.run('network', priority, perform, lifecycle) : perform();
    }
    async createPlaylist(
        scope: ApiAccount,
        title: string,
        ids: readonly number[],
        signal?: AbortSignal,
    ): Promise<ApiPlaylist> {
        if (!title.trim() || title.length > 100 || ids.length > 500 || !ids.every(apiId)) throw new ApiWriteError(400);
        return this.mutate(
            scope,
            'POST',
            '/playlists',
            { playlist: { title, sharing: 'private', tracks: [...ids] } },
            parsePlaylist,
            signal,
        );
    }
    async updatePlaylist(
        scope: ApiAccount,
        id: number,
        ids: readonly number[],
        signal?: AbortSignal,
    ): Promise<ApiPlaylist> {
        if (!apiId(id) || ids.length > 500 || !ids.every(apiId)) throw new ApiWriteError(400);
        return this.mutate(scope, 'PUT', `/playlists/${id}`, { playlist: { tracks: [...ids] } }, parsePlaylist, signal);
    }
    async likeState(id: number, fresh = false, signal?: AbortSignal): Promise<boolean | null> {
        if (!apiId(id)) return null;
        const scope = await this.profile(signal);
        if (!scope) return null;
        let snapshot = this.likeSnapshot;
        if (fresh || !snapshot || snapshot.revision !== this.generation || this.now() - snapshot.at > 30000) {
            const result = await this.pages(
                '/me/track_likes/ids',
                (value) =>
                    parsePage(value, (item) => {
                        if (apiId(item)) return item;
                        if (typeof item === 'string' && /^\d+$/.test(item) && apiId(Number(item))) return Number(item);
                        return null;
                    }),
                10000,
                signal,
                fresh,
            );
            if (!result || scope.revision !== this.generation) return null;
            snapshot = {
                revision: this.generation,
                at: this.now(),
                ids: new Set(result.items),
                complete: result.complete,
            };
            this.likeSnapshot = snapshot;
        }
        return snapshot.ids.has(id) ? true : snapshot.complete ? false : null;
    }
    async setLiked(
        url: string,
        desired: boolean,
        signal?: AbortSignal,
    ): Promise<{ id: number; liked: boolean; accountId: number } | null> {
        const scope = await this.profile(signal);
        if (!scope) return null;
        const track = await this.resolve(url, 'playback', signal);
        if (!track) return null;
        try {
            await this.mutate(
                scope,
                desired ? 'PUT' : 'DELETE',
                `/users/${scope.id}/track_likes/${track.id}`,
                undefined,
                () => true,
                signal,
                'playback',
            );
        } catch (error) {
            if (
                !(error instanceof ApiWriteError) ||
                !error.uncertain ||
                (await this.likeState(track.id, true, signal)) !== desired
            )
                throw error;
        }
        if (scope.revision !== this.generation) throw new ApiWriteError(0, true);
        this.radio.liked(track.id, desired);
        if (this.likeSnapshot?.revision === this.generation) {
            if (desired) this.likeSnapshot.ids.add(track.id);
            else this.likeSnapshot.ids.delete(track.id);
            this.likeSnapshot.at = this.now();
        }
        return { id: track.id, liked: desired, accountId: scope.id };
    }
    knownTrackId(url: string): number | undefined {
        if (!this.ready()) return;
        const value = this.index.get(url);
        return value && value.until > this.now() ? value.track.id : undefined;
    }
    async discover(url: string, advance = false): Promise<ApiTrack[] | null> {
        const seed = await this.resolve(url);
        if (!seed) return null;
        const revision = this.generation;
        const [related, station] = await Promise.all([
            this.related(url, advance),
            this.load(
                `/stations/${encodeURIComponent('soundcloud:track-stations:' + seed.id)}/tracks`,
                { limit: '12' },
                collection,
                'prefetch',
            ),
        ]);
        if (revision !== this.generation || (!related && !station)) return null;
        const known = new Set((related || []).map((track) => track.id));
        const extra = await this.batch(
            (station || [])
                .filter((track) => !known.has(track.id) && track.id !== seed.id)
                .slice(0, 12)
                .map((track) => track.id),
        );
        if (revision !== this.generation) return null;
        const merged: ApiTrack[] = [],
            seen = new Set<number>();
        const a = related || [],
            b = (extra || []).filter(hasCatalogMetadata);
        for (let i = 0; i < Math.max(a.length, b.length) && merged.length < 24; i++)
            for (const track of [a[i], b[i]]) {
                if (track && track.id !== seed.id && !seen.has(track.id)) {
                    merged.push(track);
                    seen.add(track.id);
                }
                if (merged.length === 24) break;
            }
        return !merged.length && (related === null || station === null || extra === null) ? null : merged;
    }
    diagnostics(): object {
        return {
            ready: !this.closed && Boolean(this.clientId),
            requests: this.requests,
            cacheHits: this.hits,
            failures: this.failures,
            lastStatus: this.lastStatus,
            cachedRequests: this.cache.size,
            cachedTracks: this.tracks.size,
            radio: this.radio.diagnostics(),
            pending: this.pending.size,
            cooldownMs: Math.max(0, this.blockedUntil - this.now()),
        };
    }
    dispose(): void {
        this.closed = true;
        this.reset();
    }
}
