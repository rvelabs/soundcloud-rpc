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
        private load: (url: string, advance?: boolean) => Promise<WaveCandidate[]>,
        private now = Date.now,
        private parallel = false,
    ) {}
    private async loadSeed(seed: Track, isActive: () => boolean): Promise<WaveCandidate[]> {
        if (!isActive() || !trackPath(seed.id)) return [];
        const cached = this.cache.get(seed.id);
        let tracks =
            cached && this.now() >= cached.at && this.now() - cached.at < (cached.tracks.length ? 60000 : 15000)
                ? cached.tracks
                : undefined;
        if (tracks) {
            this.hits++;
            return tracks;
        }
        let task = this.pending.get(seed.id);
        if (!task) {
            this.loads++;
            task = this.load(seed.id, Boolean(cached?.tracks.length));
            this.pending.set(seed.id, task);
        }
        try {
            tracks = (await task).slice(0, 24);
        } catch {
            this.failures++;
            tracks = [];
        } finally {
            if (this.pending.get(seed.id) === task) this.pending.delete(seed.id);
        }
        if (isActive()) this.cache.set(seed.id, { at: this.now(), tracks });
        if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value!);
        return tracks;
    }
    async discover(seeds: Track[], isActive = () => true): Promise<WaveCandidate[]> {
        const merged = new Map<string, WaveCandidate>();
        const started = this.now();
        this.lastSeeds = seeds.slice(0, 3).map((seed) => seed.id);
        const seedIds = new Set(seeds.map((seed) => seed.id));
        const selected = seeds.slice(0, 3);
        const parallel = this.parallel
            ? await Promise.all(selected.map((seed) => this.loadSeed(seed, isActive)))
            : undefined;
        for (const [index, seed] of selected.entries()) {
            if (!isActive()) return [];
            const tracks = parallel ? parallel[index] : await this.loadSeed(seed, isActive);
            if (!isActive()) return [];
            for (const track of tracks) {
                if (!trackPath(track.url) || seedIds.has(track.url)) continue;
                const old = merged.get(track.url);
                merged.set(track.url, {
                    ...track,
                    source: track.source || 'related',
                    sourceQuery: undefined,
                    sourceRank: Math.min(old?.sourceRank ?? Infinity, track.sourceRank),
                    relatedTo:
                        track.source && track.source !== 'related'
                            ? track.relatedTo
                            : [...new Set([...(old?.relatedTo || []), seed.id])],
                });
            }
        }
        this.lastDurationMs = this.now() - started;
        return [...merged.values()];
    }
}
