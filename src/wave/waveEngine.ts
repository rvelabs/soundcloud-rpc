import type { DataStore } from '../storage/asyncDataStore';
import type { TrackInfo } from '../types';
import type { SoundFeatures } from './recommendation/types';
export interface WaveCandidate {
    url: string;
    title: string;
    artist: string;
    sourceRank: number;
    language?: string;
    playbackCount?: number;
    genre?: string;
    tags?: string[];
    bpm?: number;
    bpmConfidence?: number;
    liked?: boolean;
    sourceQuery?: string;
    relatedTo?: string[];
    source?: 'related' | 'personal';
    metadataChecked?: boolean;
    catalogCheckedAt?: number;
    playability?: 'available' | 'blocked' | 'preview' | 'protected' | 'unknown';
    recommendationReasons?: string[];
    durationSeconds?: number;
    features?: SoundFeatures;
}
export interface AudioFeatures {
    energy: number;
    bass: number;
    mid: number;
    treble: number;
    bpm?: number;
}
export interface WaveControls {
    mood: 'any' | 'calm' | 'energetic' | 'happy' | 'sad';
    tone: 'any' | 'balanced' | 'bass' | 'bright';
    tempo: 'any' | 'slow' | 'medium' | 'fast';
    genre: string;
    discovery?: 'familiar' | 'favorites' | 'balanced' | 'new' | 'popular';
    language?: 'any' | 'ru' | 'foreign' | 'instrumental';
    activity?: 'any' | 'focus' | 'relax' | 'workout' | 'wake' | 'commute' | 'sleep';
}
export const defaultWaveControls: WaveControls = {
    mood: 'any',
    tone: 'any',
    tempo: 'any',
    genre: '',
    discovery: 'balanced',
    activity: 'any',
    language: 'any',
};
interface Memory {
    url: string;
    title: string;
    artist: string;
    liked: boolean;
    plays: number;
    skips: number;
    features?: AudioFeatures;
    genre?: string;
    tags?: string[];
    bpm?: number;
    updatedAt?: number;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export class WaveEngine {
    private history: Memory[];
    private currentUrl = '';
    private lastElapsed = 0;
    private currentWasManuallySkipped = false;
    private featureSum = { energy: 0, bass: 0, mid: 0, treble: 0 };
    private featureCount = 0;
    private lastSavedBucket = -1;
    constructor(private store: DataStore) {
        const saved = store.get(this.key());
        this.history = Array.isArray(saved)
            ? saved
                  .filter((v): v is Memory => v && typeof v.url === 'string' && typeof v.title === 'string')
                  .slice(-500)
            : [];
    }
    private key(): string {
        return `waveHistory_${this.store.get('currentAccountId', 'default')}`;
    }
    private save(): void {
        this.history = this.history.slice(-500);
        this.store.set(this.key(), this.history);
    }
    private findOrAdd(track: TrackInfo): Memory {
        let item = this.history.find((entry) => entry.url === track.url);
        if (!item) {
            item = { url: track.url, title: track.title, artist: track.author, liked: false, plays: 0, skips: 0 };
            this.history.push(item);
        }
        return item;
    }
    observe(track: TrackInfo): void {
        if (!track.url || !track.title) return;
        if (this.currentUrl && this.currentUrl !== track.url) {
            const previous = this.history.find((entry) => entry.url === this.currentUrl);
            if (previous) {
                if (this.lastElapsed >= 35) previous.plays += 1;
                else if (this.lastElapsed > 0 && !this.currentWasManuallySkipped) previous.skips += 1;
                if (this.featureCount)
                    previous.features = Object.fromEntries(
                        Object.entries(this.featureSum).map(([key, value]) => [key, value / this.featureCount]),
                    ) as unknown as AudioFeatures;
            }
            this.featureSum = { energy: 0, bass: 0, mid: 0, treble: 0 };
            this.featureCount = 0;
            this.lastElapsed = 0;
            this.currentWasManuallySkipped = false;
            this.lastSavedBucket = -1;
        }
        this.currentUrl = track.url;
        this.lastElapsed = Math.max(this.lastElapsed, parseTime(track.elapsed));
        const item = this.findOrAdd(track);
        item.updatedAt = Date.now();
        const changed = item.liked !== track.isLiked;
        item.liked = track.isLiked;
        item.artist = track.author;
        const bucket = Math.floor(this.lastElapsed / 30);
        if (changed || this.lastSavedBucket !== bucket) {
            this.lastSavedBucket = bucket;
            this.save();
        }
    }
    skipCurrent(): void {
        if (!this.currentUrl || this.currentWasManuallySkipped) return;
        const current = this.history.find((item) => item.url === this.currentUrl);
        if (!current) return;
        current.skips += 1;
        current.updatedAt = Date.now();
        this.currentWasManuallySkipped = true;
        this.save();
    }
    setLiked(url: string, liked: boolean, candidate?: WaveCandidate): void {
        let item = this.history.find((entry) => entry.url === url);
        if (!item && candidate) {
            item = {
                url,
                title: candidate.title,
                artist: candidate.artist,
                liked: false,
                plays: 0,
                skips: 0,
                genre: candidate.genre,
                tags: candidate.tags,
                bpm: candidate.bpm,
            };
            this.history.push(item);
        }
        if (!item || item.liked === liked) return;
        item.liked = liked;
        item.updatedAt = Date.now();
        this.save();
    }
    liked(url: string): boolean | undefined {
        return this.history.find((entry) => entry.url === url)?.liked;
    }
    ingestLikes(tracks: WaveCandidate[]): void {
        let changed = false;
        for (const track of tracks) {
            const existing = this.history.find((entry) => entry.url === track.url);
            if (existing) {
                if (!existing.liked) {
                    existing.liked = true;
                    changed = true;
                }
                existing.genre ||= track.genre;
                existing.tags ||= track.tags;
                continue;
            }
            this.history.push({
                url: track.url,
                title: track.title,
                artist: track.artist,
                liked: true,
                plays: 0,
                skips: 0,
                genre: track.genre,
                tags: track.tags,
                bpm: track.bpm,
                updatedAt: Date.now(),
            });
            changed = true;
        }
        if (changed) this.save();
    }
    heard(url: string): boolean {
        const item = this.history.find((entry) => entry.url === url);
        return Boolean(item && (item.plays > 0 || item.skips > 0 || item.liked));
    }
    audio(features: AudioFeatures): void {
        if (!this.currentUrl) return;
        for (const key of ['energy', 'bass', 'mid', 'treble'] as const) {
            if (!Number.isFinite(features[key])) return;
            this.featureSum[key] += clamp(features[key]);
        }
        this.featureCount++;
        if (features.bpm && features.bpm >= 60 && features.bpm <= 200) {
            const item = this.history.find((entry) => entry.url === this.currentUrl);
            if (item) item.bpm = Math.round(features.bpm);
        }
        if (this.featureCount % 25 === 0) {
            const item = this.history.find((entry) => entry.url === this.currentUrl);
            if (item)
                item.features = Object.fromEntries(
                    Object.entries(this.featureSum).map(([key, value]) => [key, value / this.featureCount]),
                ) as unknown as AudioFeatures;
            this.save();
        }
    }
    metadata(
        url: string,
        metadata: {
            genre?: string;
            tags?: string[];
            bpm?: number;
        },
    ): void {
        const item = this.history.find((entry) => entry.url === url);
        if (!item) return;
        if (typeof metadata.genre === 'string') item.genre = metadata.genre.slice(0, 80);
        if (Array.isArray(metadata.tags))
            item.tags = metadata.tags.filter((tag) => typeof tag === 'string').slice(0, 20);
        if (metadata.bpm && metadata.bpm >= 60 && metadata.bpm <= 200) item.bpm = Math.round(metadata.bpm);
        this.save();
    }
    stats(): {
        heard: number;
        liked: number;
    } {
        return {
            heard: this.history.filter((item) => item.plays > 0).length,
            liked: this.history.filter((item) => item.liked).length,
        };
    }
}
export function parseTime(time: string): number {
    const parts = time.split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return 0;
    return parts.reduce((sum, part) => sum * 60 + part, 0);
}
