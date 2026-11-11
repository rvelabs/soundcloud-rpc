import { RadioSources, type LibrarySignals } from '../../src/soundcloud/radioSources';
import { parseApiTrack, type ApiTrack } from '../../src/soundcloud/trackTypes';
import type { Track } from '../../src/wave/recommendation/types';
import type { WaveCandidate } from '../../src/wave/waveEngine';
import { api } from './bridge';
import { candidate } from './tracks';
import { RelatedDiscovery } from '../../src/wave/relatedDiscovery';

type Request = (operation: string, fields: object, background: boolean) => Promise<any>;
type Enrichment = {
    likes: WaveCandidate[];
    recent: WaveCandidate[];
    tracks: WaveCandidate[];
    signals?: LibrarySignals;
};
const optional = <T>(task: Promise<T>): Promise<T | null> => task.catch(() => null);
const pause = (signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false);
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve(!signal.aborted);
        };
        const timer = setTimeout(finish, 1500);
        signal.addEventListener('abort', finish, { once: true });
    });

export class Discovery {
    private sources: RadioSources;
    private relatedDiscovery: RelatedDiscovery;
    private seedIds = new Map<string, number>();
    private failures = new Map<string, number>();
    private aborted = new AbortController();
    private signals?: LibrarySignals;
    private lastExtras = -Infinity;
    private seeds: Track[] = [];
    private relatedRevision = 0;
    private resolved = new Map<string, WaveCandidate>();
    private resolving = new Map<string, Promise<WaveCandidate | undefined>>();
    private retryAt = new Map<string, number>();
    private librarySync?: Promise<void>;
    private librarySample = '';
    private hydratedLikes = new Set<number>();
    private signalTask?: Promise<LibrarySignals | null>;

    private async readSignals(): Promise<LibrarySignals | null> {
        if (this.signalTask) return this.signalTask;
        const task = this.sources.signals(this.owner, this.aborted.signal);
        this.signalTask = task;
        try {
            return await task;
        } finally {
            if (this.signalTask === task) this.signalTask = undefined;
        }
    }

    async hydrate(seeds: Track[], background = false): Promise<WaveCandidate[]> {
        const revision = this.revision();
        const items = await Promise.all(
            seeds.slice(0, 4).map(async (seed) => {
                if (this.aborted.signal.aborted || !/^https:\/\/soundcloud\.com\/[\w.~-]+\/[\w.~-]+\/?$/.test(seed.id))
                    return;
                const cached = this.resolved.get(seed.id);
                if (cached) return cached;
                const pending = this.resolving.get(seed.id);
                if (pending) return pending;
                if (this.now() < (this.retryAt.get(seed.id) ?? -Infinity)) return;
                const task = (async () => {
                    try {
                        const raw = await this.request('resolve', { url: seed.id }, background);
                        if (this.aborted.signal.aborted || revision !== this.revision()) return;
                        const item = candidate(raw, 'personal');
                        if (
                            !item ||
                            item.url !== seed.id.replace(/\/$/, '') ||
                            (seed.apiId && seed.apiId !== item.apiId)
                        )
                            throw new Error('Unverified seed');
                        this.resolved.set(seed.id, item);
                        this.retryAt.delete(seed.id);
                        while (this.resolved.size > 200) this.resolved.delete(this.resolved.keys().next().value!);
                        return item;
                    } catch {
                        this.failed('/resolve');
                        this.retryAt.set(seed.id, this.now() + 60000);
                        while (this.retryAt.size > 200) this.retryAt.delete(this.retryAt.keys().next().value!);
                        return undefined;
                    }
                })();
                this.resolving.set(seed.id, task);
                try {
                    return await task;
                } finally {
                    this.resolving.delete(seed.id);
                }
            }),
        );
        if (this.aborted.signal.aborted || revision !== this.revision()) return [];
        return items.filter((item): item is WaveCandidate => Boolean(item));
    }

    constructor(
        private owner: number,
        private revision: () => number,
        private request: Request = (operation, fields, background) => api(operation, fields, background, owner),
        private now: () => number = Date.now,
    ) {
        this.relatedDiscovery = new RelatedDiscovery(
            async (url, advance) => {
                const id = this.seedIds.get(url);
                if (!id) return [];
                const tracks = await this.sources.related(id, advance);
                return this.convert(tracks || [], 'related');
            },
            now,
            true,
        );
        this.sources = new RadioSources(
            async (path, params, decode, signal, _auth, background) => {
                if (this.aborted.signal.aborted || signal?.aborted) return null;
                const current = revision();
                try {
                    const raw = await this.request(
                        'radio',
                        { path, params },
                        background ?? !/^\/tracks\/\d+\/related$/.test(path),
                    );
                    if (this.aborted.signal.aborted || signal?.aborted || current !== revision()) return null;
                    const value = decode(raw);
                    if (value === null) this.failed(path);
                    return value;
                } catch {
                    this.failed(path);
                    return null;
                }
            },
            async (ids, background) => {
                if (!ids.length) return [];
                if (this.aborted.signal.aborted) return null;
                const current = revision();
                try {
                    const raw = await this.request('tracks', { ids: ids.slice(0, 50) }, background ?? true);
                    if (this.aborted.signal.aborted || current !== revision() || !Array.isArray(raw)) return null;
                    return raw.flatMap((value) => {
                        const track = parseApiTrack(value);
                        return track ? [track] : [];
                    });
                } catch {
                    this.failed('/tracks');
                    return null;
                }
            },
            revision,
            now,
        );
    }

    private failed(path: string): void {
        this.failures.set(path, (this.failures.get(path) || 0) + 1);
        while (this.failures.size > 30) this.failures.delete(this.failures.keys().next().value!);
    }

    private convert(tracks: ApiTrack[], source: WaveCandidate['source']): WaveCandidate[] {
        return tracks.flatMap((raw, index) => {
            const track = candidate(raw, raw.radioSource || source);
            return track ? [{ ...track, sourceRank: index }] : [];
        });
    }

    async initial(): Promise<Enrichment> {
        if (this.aborted.signal.aborted) throw new Error('SoundCloud account changed');
        const revision = this.revision();
        const [signals, pages] = await Promise.all([
            this.readSignals(),
            Promise.allSettled([0, 50].map((offset) => this.request('likes', { owner: this.owner, offset }, true))),
        ]);
        if (this.aborted.signal.aborted || revision !== this.revision()) throw new Error('SoundCloud account changed');
        const likes = pages.flatMap((result) =>
            result.status === 'fulfilled' && Array.isArray(result.value?.collection)
                ? result.value.collection.flatMap((value: any) => {
                      const track = candidate(value.track || value, 'collection');
                      return track ? [{ ...track, liked: true }] : [];
                  })
                : [],
        );
        for (const track of likes) this.hydratedLikes.add(track.apiId!);
        if (signals) {
            this.signals = {
                ...signals,
                likedIds: [...new Set([...signals.likedIds, ...likes.map((track: WaveCandidate) => track.apiId!)])],
            };
        } else
            this.signals = {
                likedIds: likes.map((track: WaveCandidate) => track.apiId!),
                blockedIds: [],
                likesComplete: false,
                blocksComplete: false,
                more: true,
            };
        return { likes, recent: [], tracks: [], signals: this.signals };
    }

    async syncLibrary(update: (signals: LibrarySignals, likes: WaveCandidate[]) => void): Promise<void> {
        if (this.librarySync) return this.librarySync;
        const task = this.syncLibraryOnce(update);
        this.librarySync = task;
        try {
            await task;
        } finally {
            if (this.librarySync === task) this.librarySync = undefined;
        }
    }

    private async syncLibraryOnce(update: (signals: LibrarySignals, likes: WaveCandidate[]) => void): Promise<void> {
        const revision = this.revision();
        const current = () => !this.aborted.signal.aborted && revision === this.revision();
        while (this.signals?.more && current()) {
            if (!(await pause(this.aborted.signal)) || !current()) return;
            const signals = await this.readSignals();
            if (!signals || !current()) return;
            this.signals = signals;
            update(signals, []);
        }
        if (!current() || !this.signals?.likesComplete) return;
        const ids = this.signals.likedIds;
        const signature = ids.join(',');
        if (signature === this.librarySample) return;
        const sample = [
            ...new Set(
                Array.from(
                    { length: Math.min(80, ids.length) },
                    (_, index) => ids[Math.floor((index * ids.length) / Math.min(80, ids.length))],
                ),
            ),
        ].filter((id) => !this.hydratedLikes.has(id));
        for (let offset = 0; offset < sample.length; offset += 40) {
            if (!current()) return;
            const batch = sample.slice(offset, offset + 40);
            try {
                const raw = await this.request('tracks', { ids: batch }, true);
                if (!current()) return;
                if (!Array.isArray(raw)) {
                    this.failed('/tracks');
                    return;
                }
                const liked = new Set(this.signals.likedIds);
                const requested = new Set(batch);
                const tracks = this.convert(
                    raw.filter((track) => requested.has(track?.id) && liked.has(track.id)),
                    'collection',
                ).map((track) => ({ ...track, liked: true }));
                for (const track of tracks) this.hydratedLikes.add(track.apiId!);
                update(this.signals, tracks);
            } catch {
                this.failed('/tracks');
                return;
            }
        }
        this.librarySample = signature;
    }

    async related(
        seeds: Track[],
        onHydrated?: (items: WaveCandidate[]) => void,
        advance = false,
    ): Promise<WaveCandidate[]> {
        if (this.aborted.signal.aborted) return [];
        const revision = this.revision();
        const selection = ++this.relatedRevision;
        const current = () =>
            !this.aborted.signal.aborted && revision === this.revision() && selection === this.relatedRevision;
        const hydrated = await this.hydrate(seeds.filter((seed) => !seed.apiId || (!seed.genre && !seed.tags?.length)));
        if (!current()) return [];
        onHydrated?.(hydrated);
        seeds = seeds.map((seed) => {
            const item = hydrated.find((item) => item.url === seed.id.replace(/\/$/, ''));
            return item
                ? { ...seed, apiId: item.apiId, uploaderId: item.uploaderId, genre: item.genre, tags: item.tags }
                : seed;
        });
        this.seeds = seeds.slice(0, 3);
        for (const seed of this.seeds) if (seed.apiId) this.seedIds.set(seed.id, seed.apiId);
        while (this.seedIds.size > 200) this.seedIds.delete(this.seedIds.keys().next().value!);
        if (!this.seeds.length) {
            const home = await this.sources.home();
            return current() ? this.convert(home || [], 'home') : [];
        }
        const root = this.seeds[0];
        const [related, station] = await Promise.all([
            this.relatedDiscovery.discover(this.seeds, current, advance),
            advance && root?.apiId ? this.sources.station(root.apiId) : [],
        ]);
        if (!current()) return [];
        const candidates = new Map(related.map((track) => [track.url, track]));
        for (const track of this.convert(station, 'related')) {
            if (track.url === root.id || track.apiId === root.apiId) continue;
            const previous = candidates.get(track.url);
            candidates.set(track.url, { ...(previous || track), stationSeed: root.id, stationRank: track.sourceRank });
        }
        return [...candidates.values()];
    }

    async enrich(): Promise<Enrichment> {
        const revision = this.revision();
        const extras = this.now() - this.lastExtras >= 5 * 60000;
        if (extras) this.lastExtras = this.now();
        const [signals, personal, home, following, collections, artists] = await Promise.all([
            optional(this.readSignals()),
            extras ? optional(this.sources.personal(this.owner, this.aborted.signal)) : null,
            extras && !this.seeds.length ? optional(this.sources.home()) : null,
            extras ? optional(this.sources.following(this.owner)) : null,
            Promise.all(
                this.seeds
                    .slice(0, 2)
                    .flatMap((seed) => (seed.apiId ? [optional(this.sources.collection(seed.apiId))] : [])),
            ),
            extras
                ? Promise.all(
                      [
                          ...new Set(
                              this.seeds
                                  .map((seed) => seed.uploaderId)
                                  .filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0),
                          ),
                      ]
                          .slice(0, 2)
                          .map((id) => optional(this.sources.artist(id))),
                  )
                : [],
        ]);
        if (this.aborted.signal.aborted || revision !== this.revision()) return { likes: [], recent: [], tracks: [] };
        if (signals) this.signals = signals;
        return {
            signals: this.signals,
            likes: this.convert(personal?.likes || [], 'collection').map((track) => ({ ...track, liked: true })),
            recent: this.convert(personal?.recent || [], 'personal'),
            tracks: this.convert(
                [
                    ...(personal?.playlists || []),
                    ...(home || []),
                    ...(following || []),
                    ...artists.flatMap((items) => items || []),
                    ...collections.flatMap((items) => items || []),
                ],
                'collection',
            ),
        };
    }

    reacted(id: number, liked: boolean): void {
        this.sources.liked(id, liked);
        if (this.signals)
            this.signals.likedIds = liked
                ? [...new Set([...this.signals.likedIds, id])]
                : this.signals.likedIds.filter((known) => known !== id);
    }

    diagnostics() {
        return {
            ...this.sources.diagnostics(),
            related: this.relatedDiscovery.diagnostics(),
            failures: Object.fromEntries(this.failures),
        };
    }

    dispose(): void {
        this.aborted.abort();
        this.sources.clear();
        this.resolved.clear();
        this.retryAt.clear();
    }
}
