import { describe, expect, it } from 'vitest';
import { normalize, tokensOf, recordingKey } from './profile';
describe('bounded derived metadata caches', () => {
    it('preserves normalization for Unicode and arbitrarily long input', () => {
        for (const value of ['  ＡＢＣ\tДом  ', '', 'Ambient '.repeat(300)])
            expect(normalize(value)).toBe(value.toLowerCase().normalize('NFKC').trim().replace(/\s+/g, ' '));
    });
    it('tracks mutable inputs and does not expose cached token arrays', () => {
        const track = { id: 'one', title: 'Ambient night', artist: 'Artist', genre: 'ambient', tags: ['soft'] };
        const original = tokensOf(track);
        original.push('corruption');
        expect(tokensOf(track)).not.toContain('corruption');
        track.tags.push('bass');
        expect(tokensOf(track)).toContain('bass');
        const key = recordingKey(track);
        track.artist = 'Another';
        expect(recordingKey(track)).not.toBe(key);
        track.title = 'Other title';
        expect(recordingKey(track)).toBe('another|other title');
    });
});
