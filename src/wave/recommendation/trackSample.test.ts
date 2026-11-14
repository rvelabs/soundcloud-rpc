import { expect, it } from 'vitest';
import { describeEnvelope, describePcm, trackSampleSimilarity } from './trackSample';
import { RecommendationSession } from './session';
import type { Track } from './types';

const pcm = (hz: number, beat: number) =>
    Float32Array.from({ length: 12000 * 12 }, (_, sample) => {
        const t = sample / 12000;
        return Math.sin(2 * Math.PI * hz * t) * Math.exp((-t % beat) * 12);
    });
const track = (id: string, sample?: Track['sample']): Track => ({ id, artist: id, title: id, sample });

it('admits untagged candidates by measured rhythm and spectrum while rejecting a different timbre', async () => {
    const seed = track('seed', describePcm(pcm(100, 0.45), 12000));
    const close = track('close', describePcm(pcm(108, 0.45), 12000));
    const distant = track('distant', describePcm(pcm(2200, 0.45), 12000));
    expect(trackSampleSimilarity(close, seed)).toBeGreaterThan(0.7);
    expect(trackSampleSimilarity(distant, seed)).toBeUndefined();
    const session = new RecommendationSession({ related: async () => [distant, close] });
    session.setTrackSeed(seed);
    await session.refresh();
    expect(session.rank().map((entry) => entry.track.id)).toEqual(['close']);
});

it('requires independent discovery evidence for rhythm from a public waveform', () => {
    const waveform = describeEnvelope(Array.from({ length: 1200 }, (_, i) => (i % 20 < 3 ? 12 : 2)), 30);
    const seed = track('seed', waveform);
    const candidate = track('candidate', waveform);
    expect(trackSampleSimilarity(candidate, seed)).toBeUndefined();
    candidate.stationSeed = seed.id;
    candidate.relatedTo = [seed.id];
    expect(trackSampleSimilarity(candidate, seed)).toBeCloseTo(0.8);
});
