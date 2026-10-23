import { describe, expect, it } from 'vitest';
import { buildProfile, measuredBpm } from './profile';
describe('feedback metadata merging', () => {
    it('retains measured metadata when a later playback event omits it', () => {
        const track = {
            id: 'one',
            title: 'Music',
            artist: 'Artist',
            genre: 'ambient',
            features: { bpm: 90, bpmConfidence: 0.8, energy: 0 },
        };
        const profile = buildProfile(
            [
                { track, kind: 'play', at: 1, listenedFraction: 1 },
                {
                    track: { ...track, genre: undefined, features: { bpm: undefined, bpmConfidence: undefined } },
                    kind: 'complete',
                    at: 2,
                },
            ],
            3,
        );
        expect(profile.positiveSeeds[0].genre).toBe('ambient');
        expect(measuredBpm(profile.positiveSeeds[0].features)).toBe(90);
        expect(profile.sound.energy).toBe(0);
    });
});
