import { trackPath } from './nativeQueue';
import type { Track } from './recommendation/types';
import type { WaveCandidate } from './waveEngine';

export class RelatedDiscovery {
    private cache = new Map<string, { at: number; tracks: WaveCandidate[] }>();
    private pending = new Map<string, Promise<WaveCandidate[]>>();
    private loads = 0;
    private hits = 0;
    private failures = 0;
    private lastSeeds: string[] = [];
    private lastDurationMs = 0;
    diagnostics(): object {
        return {
            loads: this.loads,
            cacheHits: this.hits,
            failures: this.failures,
            cachedSeeds: this.cache.size,
            pending: this.pending.size,
            lastSeeds: this.lastSeeds,
            lastDurationMs: this.lastDurationMs,
        };
    }
    constructor(
        private load: (url: string) => Promise<WaveCandidate[]>,
        private now = Date.now,
    ) {}
    async discover(seeds: Track[], isActive = () => true): Promise<WaveCandidate[]> {
        const merged = new Map<string, WaveCandidate>();
        const started = this.now();
        this.lastSeeds = seeds.slice(0, 3).map((seed) => seed.id);
        const seedIds = new Set(seeds.map((seed) => seed.id));
        for (const seed of seeds.slice(0, 3)) {
            if (!isActive()) return [];
            if (!trackPath(seed.id)) continue;
            const cached = this.cache.get(seed.id);
            let tracks =
                cached &&
                this.now() >= cached.at &&
                this.now() - cached.at < (cached.tracks.length ? 30 * 60000 : 15000)
                    ? cached.tracks
                    : undefined;
            if (!tracks) {
                let task = this.pending.get(seed.id);
                if (!task) {
                    this.loads++;
                    task = this.load(seed.id);
                    this.pending.set(seed.id, task);
                }
                try {
                    tracks = (await task).slice(0, 24);
                    if (isActive()) this.cache.set(seed.id, { at: this.now(), tracks });
                } catch {
                    this.failures++;
                    tracks = [];
                    if (isActive()) this.cache.set(seed.id, { at: this.now(), tracks });
                } finally {
                    if (this.pending.get(seed.id) === task) this.pending.delete(seed.id);
                }
                if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value!);
            } else this.hits++;
            if (!isActive()) return [];
            for (const track of tracks) {
                if (!trackPath(track.url) || seedIds.has(track.url)) continue;
                const old = merged.get(track.url);
                merged.set(track.url, {
                    ...track,
                    source: 'related',
                    sourceQuery: undefined,
                    sourceRank: Math.min(old?.sourceRank ?? Infinity, track.sourceRank),
                    relatedTo: [...new Set([...(old?.relatedTo || []), seed.id])],
                });
            }
        }
        this.lastDurationMs = this.now() - started;
        return [...merged.values()];
    }
}
