import type { DataStore } from '../storage/asyncDataStore';
import type { SoundFeatures } from './recommendation/types';
import type { WaveCandidate } from './waveEngine';
import { trackPath } from './nativeQueue';
const lifetime = 30 * 86400000;
type Entry = { at: number; version: number; features: SoundFeatures };
export class AudioAnalysisCache {
    private entries = new Map<string, Entry>();
    private key: string;
    constructor(
        private store: DataStore,
        account: string,
        private now = Date.now,
    ) {
        this.key = `waveAudioAnalysisV1_${account}`;
        const saved = store.get(this.key);
        if (Array.isArray(saved))
            for (const item of saved.slice(-250)) {
                if (!Array.isArray(item) || typeof item[0] !== 'string' || !this.valid(item[1])) continue;
                this.entries.set(item[0], item[1]);
            }
    }
    private valid(entry: Entry): boolean {
        return Boolean(
            entry &&
                entry.version === 1 &&
                Number.isFinite(entry.at) &&
                this.now() >= entry.at &&
                this.now() - entry.at < lifetime &&
                entry.features?.source === 'media-element-v1' &&
                Number.isFinite(entry.features.sampleSeconds) &&
                entry.features.sampleSeconds! >= 30 &&
                entry.features.sampleSeconds! <= 93 &&
                ['energy', 'bass', 'brightness'].every((key) => {
                    const value = entry.features[key as keyof SoundFeatures];
                    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
                }) &&
                entry.features.energy! > 0.00001 &&
                entry.features.bass! + entry.features.brightness! <= 1.02,
        );
    }
    private identity(track: WaveCandidate): string | undefined {
        const path = trackPath(track.url),
            duration = track.durationSeconds;
        if (!path || !duration || !Number.isFinite(duration) || duration <= 0) return;
        return JSON.stringify([path, Math.round(duration), track.audioRevision || '']);
    }
    get(track: WaveCandidate): SoundFeatures | undefined {
        const id = this.identity(track);
        if (!id) return;
        const entry = this.entries.get(id);
        if (!entry || !this.valid(entry)) {
            this.entries.delete(id);
            return;
        }
        return { ...entry.features };
    }
    enrich(track: WaveCandidate): WaveCandidate {
        const features = this.get(track);
        return features ? { ...track, features: { ...track.features, ...features } } : track;
    }
    remember(track: WaveCandidate, features: SoundFeatures): void {
        const id = this.identity(track);
        const entry: Entry = {
            at: this.now(),
            version: 1,
            features: {
                source: features.source,
                sampleSeconds: features.sampleSeconds,
                energy: features.energy,
                bass: features.bass,
                brightness: features.brightness,
            },
        };
        if (!id || !this.valid(entry)) return;
        const existing = this.entries.get(id);
        if (existing && this.valid(existing) && existing.features.sampleSeconds! >= features.sampleSeconds!) return;
        this.entries.delete(id);
        this.entries.set(id, entry);
        for (const [key, value] of this.entries) if (!this.valid(value)) this.entries.delete(key);
        while (this.entries.size > 250) this.entries.delete(this.entries.keys().next().value!);
        this.store.set(this.key, [...this.entries]);
    }
}
