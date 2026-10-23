import { describe, expect, it } from 'vitest';
import { mergeMetadata } from './nativeMetadata';
describe('pre-play widget metadata', () => {
    it('adds published BPM and genre before ranking without replacing missing fields', () => {
        const candidate = {
            url: 'https://soundcloud.com/artist/track',
            title: 'Track',
            artist: 'Artist',
            sourceRank: 0,
            genre: 'Rock',
        };
        expect(mergeMetadata(candidate, { genre: 'Electronic', bpm: 142, tags: ['drum', 'bass'] })).toMatchObject({
            genre: 'Electronic',
            bpm: 142,
            tags: ['drum', 'bass'],
            metadataChecked: true,
        });
        expect(mergeMetadata(candidate, { genre: '', bpm: 0 })).toMatchObject({ genre: 'Rock', metadataChecked: true });
    });
});
