import { measuredBpm, tokensOf } from './profile';
import { effectiveMood, languageEvidence, moodEvidence } from './preferences';
import type { Context, Controls, Track } from './types';
export interface PreferenceEvidence {
    filter: string;
    source: 'metadata' | 'audio' | 'tags' | 'unknown';
    text: string;
}
export function preferenceEvidence(track: Track, controls: Controls, context: Context): PreferenceEvidence[] {
    const evidence: PreferenceEvidence[] = [];
    if (controls.tempo !== 'any') {
        const bpm = measuredBpm(track.features);
        evidence.push(
            bpm
                ? { filter: 'tempo', source: 'metadata', text: 'Темп подтверждён BPM' }
                : { filter: 'tempo', source: 'unknown', text: 'Точный темп не подтверждён' },
        );
    }
    const mood = effectiveMood(controls, context);
    if (mood !== 'any') {
        const item = moodEvidence(track, mood);
        const tags = item.reason === 'настроение по тегам';
        evidence.push({
            filter: 'mood',
            source: tags ? 'tags' : 'unknown',
            text: tags ? 'Настроение по тегам' : 'Настроение не распознано по аудио',
        });
    }
    if (controls.tone !== 'any') {
        const audio =
            track.features?.source === 'media-element-v1' &&
            (track.features.sampleSeconds || 0) >= 8 &&
            track.features.bass !== undefined &&
            track.features.brightness !== undefined;
        const tags = tokensOf(track).some((token) =>
            ['bass', 'bright', '808', 'acoustic', 'synth', 'balanced'].includes(token),
        );
        evidence.push({
            filter: 'tone',
            source: audio ? 'audio' : tags ? 'tags' : 'unknown',
            text: audio
                ? 'Звучание по локальному аудиоанализу'
                : tags
                  ? 'Звучание по тегам'
                  : 'Звучание пока не измерено',
        });
    }
    if (controls.language && controls.language !== 'any') {
        const item = languageEvidence(track);
        evidence.push({
            filter: 'language',
            source: item.language === 'unknown' ? 'unknown' : 'metadata',
            text: item.language === 'unknown' ? 'Язык не подтверждён' : 'Язык по метаданным и тегам',
        });
    }
    return evidence;
}
