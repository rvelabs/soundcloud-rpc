import { describe, expect, it } from 'vitest';
import { AudioAnalysisCache } from './audioAnalysisCache';
import type { SoundFeatures } from './recommendation/types';
const track = {
    url: 'https://soundcloud.com/artist/one',
    title: 'One',
    artist: 'Artist',
    sourceRank: 0,
    durationSeconds: 180,
    audioRevision: 'v1',
};
const good: SoundFeatures = { source: 'media-element-v1', sampleSeconds: 60, energy: 0.25, bass: 0.6, brightness: 0.2 };
function memory() {
    const values = new Map<string, unknown>();
    let writes = 0;
    return {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => {
            writes++;
            values.set(key, structuredClone(value));
        },
        writes: () => writes,
    };
}
describe('reusable audio analysis', () => {
    it('restores measured features per account and preserves BPM when enriching', () => {
        const store = memory();
        const cache = new AudioAnalysisCache(store, 'one');
        cache.remember(track, good);
        const restored = new AudioAnalysisCache(store, 'one');
        expect(restored.get(track)).toEqual(good);
        expect(restored.enrich({ ...track, features: { bpm: 130, bpmConfidence: 0.8 } }).features).toEqual({
            ...good,
            bpm: 130,
            bpmConfidence: 0.8,
        });
        const returned = restored.get(track)!;
        returned.bass = 0;
        expect(restored.get(track)?.bass).toBe(0.6);
        expect(new AudioAnalysisCache(store, 'other').get(track)).toBeUndefined();
        cache.remember(track, { ...good, sampleSeconds: 30 });
        expect(store.writes()).toBe(1);
    });
    it('requires a sufficiently measured non-silent signal and invalidates changed recordings', () => {
        const store = memory();
        const cache = new AudioAnalysisCache(store, 'one');
        for (const invalid of [
            { ...good, sampleSeconds: 29 },
            { ...good, energy: 0 },
            { ...good, bass: NaN },
            { ...good, source: 'metadata' as const },
            { ...good, brightness: 0.8 },
        ])
            cache.remember(track, invalid);
        expect(cache.get(track)).toBeUndefined();
        expect(store.writes()).toBe(0);
        cache.remember(track, good);
        expect(cache.get({ ...track, durationSeconds: 185 })).toBeUndefined();
        expect(cache.get({ ...track, audioRevision: 'v2' })).toBeUndefined();
        expect(cache.get({ ...track, durationSeconds: undefined })).toBeUndefined();
    });
    it('expires results, rejects incompatible versions and caps retained records', () => {
        let now = 100000000;
        const store = memory();
        const cache = new AudioAnalysisCache(store, 'one', () => now);
        cache.remember(track, good);
        now += 31 * 86400000;
        expect(cache.get(track)).toBeUndefined();
        const key = JSON.stringify(['/artist/one', 180, 'v1']);
        store.set('waveAudioAnalysisV1_one', [[key, { at: now, version: 2, features: good }]]);
        expect(new AudioAnalysisCache(store, 'one', () => now).get(track)).toBeUndefined();
        for (let i = 0; i < 260; i++)
            cache.remember({ ...track, url: `https://soundcloud.com/artist/song-${i}` }, good);
        expect((store.get('waveAudioAnalysisV1_one') as unknown[]).length).toBe(250);
    });
});
