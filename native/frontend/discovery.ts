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

export class Discovery {
    private sources: RadioSources;
    private relatedDiscovery: RelatedDiscovery;
    private seedIds = new Map<string, number>();
    private failures = new Map<string, number>();
    private aborted = new AbortController();
    private signals?: LibrarySignals;
    private lastExtras = -Infinity;
    private seeds: Track[] = [];
    private resolved = new Map<string, WaveCandidate>();
    private resolving = new Map<string, Promise<WaveCandidate | undefined>>();
    private retryAt = new Map<string, number>();

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
            this.sources.signals(this.owner),
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

    async related(seeds: Track[], onHydrated?: (items: WaveCandidate[]) => void): Promise<WaveCandidate[]> {
        if (this.aborted.signal.aborted) return [];
        const revision = this.revision();
        const hydrated = await this.hydrate(seeds.filter((seed) => !seed.apiId || (!seed.genre && !seed.tags?.length)));
        if (this.aborted.signal.aborted || revision !== this.revision()) return [];
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
            return !this.aborted.signal.aborted && revision === this.revision() ? this.convert(home || [], 'home') : [];
        }
        return this.relatedDiscovery.discover(
            this.seeds,
            () => !this.aborted.signal.aborted && revision === this.revision(),
        );
    }

    async enrich(): Promise<Enrichment> {
        const revision = this.revision();
        const extras = this.now() - this.lastExtras >= 5 * 60000;
        if (extras) this.lastExtras = this.now();
        const [signals, personal, home, following, collections, artists] = await Promise.all([
            optional(this.sources.signals(this.owner)),
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
