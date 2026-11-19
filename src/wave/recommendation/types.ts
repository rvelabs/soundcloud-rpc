export interface SoundFeatures {
    source?: 'android-pcm-v1' | 'media-element-v1' | 'metadata' | 'legacy';
    sampleSeconds?: number;
    energy?: number;
    bass?: number;
    brightness?: number;
    bpm?: number;
    bpmConfidence?: number;
}
export interface Track {
    id: string;
    apiId?: number;
    uploaderId?: number;
    title: string;
    artist: string;
    genre?: string;
    tags?: string[];
    features?: SoundFeatures;
    sample?: TrackSample;
    language?: string;
    playbackCount?: number;
    catalogChecked?: boolean;
    sourceRank?: number;
    queryHint?: string;
    relatedTo?: string[];
    stationSeed?: string;
    stationRank?: number;
    source?: 'related' | 'personal' | 'collection' | 'home' | 'following' | 'artist';
}
export type FeedbackKind = 'like' | 'unlike' | 'dislike' | 'play' | 'skip' | 'complete';
export interface Feedback {
    track: Track;
    kind: FeedbackKind;
    at: number;
    listenedFraction?: number;
    origin?: 'library' | 'wave';
}
export interface Controls {
    mood: 'any' | 'calm' | 'energetic' | 'happy' | 'sad';
    tempo: 'any' | 'slow' | 'medium' | 'fast';
    tone: 'any' | 'balanced' | 'bass' | 'bright';
    genre?: string;
    language?: 'any' | 'ru' | 'foreign' | 'instrumental';
    discovery: 'familiar' | 'favorites' | 'balanced' | 'new' | 'popular';
    activity?: 'focus' | 'relax' | 'workout' | 'wake' | 'commute' | 'sleep';
}
export const defaultControls: Controls = {
    mood: 'any',
    tempo: 'any',
    tone: 'any',
    genre: '',
    discovery: 'balanced',
};
export interface Recommendation {
    track: Track;
    score: number;
    quality?: number;
    trackWaveTier?: number;
    selection?: { profileSimilarity: number; directionSimilarity: number; activeLinks: number; staleLinks: number };
    reasons: string[];
    measuredTempoMatch: boolean;
    evidence?: import('./evidence').PreferenceEvidence[];
}
export interface Context {
    now: number;
    discoverySeeds?: Track[];
    activity?: 'focus' | 'relax' | 'workout' | 'wake' | 'commute' | 'sleep';
    recentTrackIds?: string[];
    knownLikedApiIds?: ReadonlySet<number>;
    reservedTrackIds?: string[];
    allowUnverified?: boolean;
    recentArtists?: string[];
    seed?: number;
    sequenceOffset?: number;
    anchor?: Track;
    trackSeed?: Track;
    preferenceSignals?: Map<string, number>;
    similarityCorpus?: Track[];
    sessionReactions?: Feedback[];
    sessionMood?: import('./sessionMood').SessionMood;
    recentTracks?: Track[];
}
export interface TrackSample {
    rhythm: number[];
    dynamics: number[];
    spectrum?: number[];
    envelope?: Omit<TrackSample, 'envelope' | 'spectrum'>;
}

export function measuredAudio(features: SoundFeatures | undefined): features is SoundFeatures & { source: 'media-element-v1' | 'android-pcm-v1' } {
    return features?.source === 'media-element-v1' || features?.source === 'android-pcm-v1';
}
