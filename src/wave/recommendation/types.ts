export interface SoundFeatures {
    energy?: number;
    bass?: number;
    brightness?: number;
    bpm?: number;
    bpmConfidence?: number;
}
export interface Track {
    id: string;
    title: string;
    artist: string;
    genre?: string;
    tags?: string[];
    features?: SoundFeatures;
    language?: string;
    playbackCount?: number;
    catalogChecked?: boolean;
    sourceRank?: number;
    queryHint?: string;
    relatedTo?: string[];
    source?: 'related' | 'personal';
}
export type FeedbackKind = 'like' | 'unlike' | 'dislike' | 'play' | 'skip' | 'complete';
export interface Feedback {
    track: Track;
    kind: FeedbackKind;
    at: number;
    listenedFraction?: number;
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
    reasons: string[];
    measuredTempoMatch: boolean;
}
export interface Context {
    now: number;
    activity?: 'focus' | 'relax' | 'workout' | 'wake' | 'commute' | 'sleep';
    recentTrackIds?: string[];
    reservedTrackIds?: string[];
    allowUnverified?: boolean;
    recentArtists?: string[];
    seed?: number;
}
