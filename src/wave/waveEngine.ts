import type ElectronStore from 'electron-store';
import type { TrackInfo } from '../types';
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
export function matchesTempo(bpm: number, tempo: WaveControls['tempo']): boolean {
    if (tempo === 'any') return true;
    if (!Number.isFinite(bpm) || bpm < 60 || bpm > 200) return false;
    return tempo === 'slow' ? bpm < 105 : tempo === 'medium' ? bpm < 140 && bpm >= 105 : bpm >= 140;
}
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
const genreWords = [
    'ambient',
    'techno',
    'house',
    'drum',
    'bass',
    'dnb',
    'jungle',
    'trance',
    'rock',
    'metal',
    'pop',
    'hip',
    'hop',
    'rap',
    'jazz',
    'soul',
    'folk',
    'indie',
    'phonk',
    'lofi',
    'hardstyle',
    'breakcore',
    'electronic',
    'remix',
    'acoustic',
    'experimental',
    'garage',
    'dubstep',
    'rave',
    'slowed',
    'reverb',
    'nightcore',
    'vaporwave',
    'hyperpop',
    'trap',
    'pluggnb',
    'shoegaze',
    'drift',
    'dreamcore',
    'ambient',
    'industrial',
    'punk',
    'emo',
    'speedcore',
    'breaks',
    'эмбиент',
    'техно',
    'хаус',
    'рок',
    'метал',
    'рэп',
    'хип',
    'хоп',
    'фонк',
    'джаз',
    'поп',
    'транс',
];
const words = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((part) => part.length > 2 && genreWords.includes(part));
const explicitWords = (text: string): string[] =>
    text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(
            (part) =>
                part.length > 2 &&
                part.length < 25 &&
                !/^(music|track|official|original|soundcloud|the|and)$/i.test(part),
        );
const calmWords = /\b(ambient|chill|lofi|downtempo|soft|acoustic|спокойн|эмбиент)\b/i;
const energeticWords = /\b(techno|hardstyle|rave|breakcore|uptempo|hardcore|drum|jungle|танцевальн)\b/i;
const slowWords = /\b(slow|slowed|downtempo|ambient|chill|lofi|slowcore|медленн)\b/i;
const fastWords = /\b(fast|speed|sped|uptempo|nightcore|hardcore|hardstyle|dnb|jungle|быстр)\b/i;
const mediumWords = /\b(midtempo|moderate|groove|средн)\b/i;
const tagsFor = (item: Pick<WaveCandidate, 'title' | 'genre' | 'tags'>): string[] =>
    [...new Set([...words(item.title), ...explicitWords([item.genre || '', ...(item.tags || [])].join(' '))])].slice(
        0,
        30,
    );
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const signed = (value: number) => Math.max(-1, Math.min(1, value));
export function rankCandidates(
    candidates: WaveCandidate[],
    history: Memory[],
    controls: WaveControls = defaultWaveControls,
    recentArtists: string[] = [],
): WaveCandidate[] {
    const recentHistory = [...history].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const recentRank = new Map(recentHistory.map((item, index) => [item.url, index]));
    const positiveSeeds = recentHistory
        .filter((item) => item.liked)
        .slice(0, 8)
        .map(tagsFor)
        .filter((tags) => tags.length);
    const negativeSeeds = recentHistory
        .filter((item) => item.skips > item.plays && !item.liked)
        .slice(0, 8)
        .map(tagsFor)
        .filter((tags) => tags.length);
    const similarity = (a: string[], b: string[]) => {
        if (!a.length || !b.length) return 0;
        const overlap = a.filter((token) => b.includes(token)).length;
        return overlap / Math.sqrt(a.length * b.length);
    };
    const tokenWeights = new Map<string, number>();
    const artistWeights = new Map<string, number>();
    const soundProfiles = new Map<
        string,
        {
            features: AudioFeatures;
            count: number;
        }
    >();
    const tempoProfiles = new Map<
        string,
        {
            sum: number;
            count: number;
        }
    >();
    const preferred = { energy: 0, bass: 0, mid: 0, treble: 0 };
    let preferredCount = 0;
    const played = new Set<string>();
    for (const item of history) {
        const recency = 0.55 + 0.45 / (1 + (recentRank.get(item.url) || 0) / 12);
        const weight = ((item.liked ? 3 : 0) + Math.min(item.plays, 3) * 0.5 - item.skips * 1.5) * recency;
        for (const token of tagsFor(item)) {
            tokenWeights.set(token, (tokenWeights.get(token) || 0) + weight);
            if (item.bpm && item.bpm >= 60 && item.bpm <= 200) {
                const tempo = tempoProfiles.get(token) || { sum: 0, count: 0 };
                tempo.sum += item.bpm;
                tempo.count++;
                tempoProfiles.set(token, tempo);
            }
        }
        const artist = item.artist.toLowerCase();
        if (artist) artistWeights.set(artist, (artistWeights.get(artist) || 0) + weight);
        if (item.features) {
            const tokens = tagsFor(item);
            for (const token of tokens) {
                const profile = soundProfiles.get(token) || {
                    features: { energy: 0, bass: 0, mid: 0, treble: 0 },
                    count: 0,
                };
                for (const key of ['energy', 'bass', 'mid', 'treble'] as const)
                    profile.features[key] += item.features[key];
                profile.count++;
                soundProfiles.set(token, profile);
            }
            if (item.liked || item.plays > item.skips) {
                for (const key of ['energy', 'bass', 'mid', 'treble'] as const) preferred[key] += item.features[key];
                preferredCount++;
            }
        }
        if (item.plays || item.skips) played.add(item.url);
    }
    const scored = candidates.map((candidate) => {
        const tokens = tagsFor(candidate);
        const base = 1.25 / Math.sqrt(candidate.sourceRank + 1);
        const artist = signed((artistWeights.get(candidate.artist.toLowerCase()) || 0) / 8) * 0.25;
        const genre = Math.max(
            -1.4,
            Math.min(
                1.8,
                tokens.reduce((sum, token) => sum + (tokenWeights.get(token) || 0) / 3, 0),
            ),
        );
        const novelty = played.has(candidate.url) || candidate.liked ? -4 : 1.15;
        const style =
            Math.max(0, ...positiveSeeds.map((seed) => similarity(tokens, seed))) * 1.35 -
            Math.max(0, ...negativeSeeds.map((seed) => similarity(tokens, seed))) * 1.1;
        const recentIndex = recentArtists.findIndex((name) => name.toLowerCase() === candidate.artist.toLowerCase());
        const repetition = recentIndex < 0 ? 0 : -Math.max(1.3, 4.2 - recentIndex * 0.65);
        const profiles = tokens
            .map((token) => soundProfiles.get(token))
            .filter(
                (
                    profile,
                ): profile is {
                    features: AudioFeatures;
                    count: number;
                } => Boolean(profile),
            );
        let sound = 0;
        if (profiles.length && preferredCount) {
            const similarity =
                profiles.reduce((sum, profile) => {
                    const difference =
                        (['energy', 'bass', 'mid', 'treble'] as const).reduce(
                            (total, key) =>
                                total +
                                Math.abs(profile.features[key] / profile.count - preferred[key] / preferredCount),
                            0,
                        ) / 4;
                    return sum + (1 - difference);
                }, 0) / profiles.length;
            sound = similarity * 0.8;
        }
        const candidateProfile = history.find((item) => item.url === candidate.url)?.features;
        const profile =
            candidateProfile ||
            (profiles.length
                ? (Object.fromEntries(
                      (['energy', 'bass', 'mid', 'treble'] as const).map((key) => [
                          key,
                          profiles.reduce((sum, item) => sum + item.features[key] / item.count, 0) / profiles.length,
                      ]),
                  ) as unknown as AudioFeatures)
                : undefined);
        let preference = 0;
        if (controls.genre) {
            const chosenGenre = explicitWords(controls.genre);
            const matched = chosenGenre.filter((token) => tokens.includes(token)).length;
            if (matched) preference += (2.4 * matched) / chosenGenre.length;
            else if (tokens.length) preference -= 0.65;
        }
        if (profile && controls.mood !== 'any') {
            preference += controls.mood === 'calm' ? 2.2 - profile.energy * 3.6 : profile.energy * 3.6 - 1.2;
        } else if (controls.mood !== 'any') {
            const description = [
                candidate.title,
                candidate.genre,
                ...(candidate.tags || []),
                candidate.sourceQuery,
            ].join(' ');
            if (controls.mood === 'calm')
                preference += calmWords.test(description) ? 2.4 : energeticWords.test(description) ? -2 : 0;
            if (controls.mood === 'energetic')
                preference += energeticWords.test(description) ? 2.4 : calmWords.test(description) ? -2 : 0;
        }
        if (profile && controls.tone !== 'any') {
            const difference = profile.bass - profile.treble;
            preference +=
                controls.tone === 'bass'
                    ? difference * 1.6
                    : controls.tone === 'bright'
                      ? -difference * 1.6
                      : 1.2 - Math.abs(difference) * 2;
        }
        const bpm = candidate.bpm || history.find((item) => item.url === candidate.url)?.bpm;
        if (bpm && controls.tempo !== 'any') {
            preference +=
                controls.tempo === 'slow'
                    ? bpm < 105
                        ? 3
                        : -2.5
                    : controls.tempo === 'medium'
                      ? bpm >= 105 && bpm < 140
                          ? 3
                          : -2.5
                      : bpm >= 140
                        ? 3
                        : -2.5;
        } else if (controls.tempo !== 'any') {
            const learned = tokens
                .map((token) => tempoProfiles.get(token))
                .filter(
                    (
                        entry,
                    ): entry is {
                        sum: number;
                        count: number;
                    } => Boolean(entry && entry.count >= 2),
                );
            if (learned.length) {
                const estimate = learned.reduce((sum, entry) => sum + entry.sum / entry.count, 0) / learned.length;
                preference += matchesTempo(estimate, controls.tempo) ? 1.7 : -1.1;
            }
            const description = [
                candidate.title,
                candidate.genre,
                ...(candidate.tags || []),
                candidate.sourceQuery,
            ].join(' ');
            const matches =
                controls.tempo === 'slow'
                    ? slowWords.test(description)
                    : controls.tempo === 'medium'
                      ? mediumWords.test(description)
                      : fastWords.test(description);
            const conflicts =
                controls.tempo === 'slow'
                    ? fastWords.test(description)
                    : controls.tempo === 'fast'
                      ? slowWords.test(description)
                      : false;
            preference += matches ? 1.7 : conflicts ? -1.5 : 0;
        }
        const score = base + artist + genre + style + novelty + sound + repetition + preference;
        return { candidate, score };
    });
    scored.sort((a, b) => b.score - a.score || a.candidate.sourceRank - b.candidate.sourceRank);
    return scored.map(({ candidate }) => candidate);
}
export function playableCandidates(
    ranked: WaveCandidate[],
    controls: WaveControls,
    currentArtist: string | undefined,
    heard: (url: string) => boolean,
): WaveCandidate[] {
    const novel = ranked.filter((track) => !track.liked && !heard(track.url));
    const measuredMatch =
        controls.tempo === 'any' ? [] : novel.filter((track) => track.bpm && matchesTempo(track.bpm, controls.tempo));
    const tempoPool = measuredMatch.length
        ? measuredMatch
        : controls.tempo === 'any'
          ? novel
          : novel.filter((track) => !track.bpm);
    const otherArtists = tempoPool.filter((track) => track.artist.toLowerCase() !== currentArtist?.toLowerCase());
    return otherArtists.length ? otherArtists : tempoPool;
}
export class WaveEngine {
    private history: Memory[];
    private currentUrl = '';
    private lastElapsed = 0;
    private currentWasManuallySkipped = false;
    private featureSum = { energy: 0, bass: 0, mid: 0, treble: 0 };
    private featureCount = 0;
    private lastSavedBucket = -1;
    constructor(private store: ElectronStore) {
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
        this.store.set(this.key(), this.history.slice(-500));
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
    searchQueries(controls: WaveControls = defaultWaveControls, rotation = 0): string[] {
        const seeds: string[] = [];
        if (controls.genre.trim()) seeds.push(controls.genre.trim().slice(0, 40));
        for (const item of [...this.history].reverse().filter((entry) => entry.liked || entry.plays > entry.skips)) {
            const genre = item.genre?.trim();
            if (genre && genre.length <= 40 && !seeds.some((seed) => seed.toLowerCase() === genre.toLowerCase()))
                seeds.push(genre);
            for (const tag of (item.tags || []).slice(0, 3))
                if (
                    tag.length > 2 &&
                    tag.length <= 35 &&
                    !seeds.some((seed) => seed.toLowerCase() === tag.toLowerCase())
                )
                    seeds.push(tag);
            if (seeds.length >= 8) break;
        }
        if (!seeds.length) seeds.push('indie electronic', 'ambient', 'rock');
        const primary = controls.genre.trim() ? seeds[0] : seeds[rotation % seeds.length];
        const mood = controls.mood === 'calm' ? 'chill' : controls.mood === 'energetic' ? 'energetic' : '';
        const tempo =
            controls.tempo === 'slow'
                ? 'slow'
                : controls.tempo === 'fast'
                  ? 'fast'
                  : controls.tempo === 'medium'
                    ? 'midtempo'
                    : '';
        return [
            ...new Set([
                [primary, mood, tempo].filter(Boolean).join(' '),
                primary,
                seeds[(rotation + 1) % seeds.length],
            ]),
        ].slice(0, 3);
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
    rank(
        candidates: WaveCandidate[],
        controls: WaveControls = defaultWaveControls,
        recentArtists: string[] = [],
    ): WaveCandidate[] {
        return rankCandidates(candidates, this.history, controls, recentArtists);
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
