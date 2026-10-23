import { describe, expect, it } from 'vitest';
import { parsePublicTrackMetadata } from './trackMetadata';
describe('public SoundCloud track metadata', () => {
    it('recognizes a long DJ set that a search card may present as a normal track', () => {
        const html =
            '<meta itemprop="duration" content="PT01H55M23S" />' + '<meta itemprop="genre" content="Avantgarde" />';
        expect(parsePublicTrackMetadata(html)).toEqual({ durationSeconds: 6923, genre: 'Avantgarde' });
    });
    it('reads catalog tags, declared BPM and availability from the exact track hydration', () => {
        const url = 'https://soundcloud.com/artist/song';
        const html = `window.__sc_hydration = ${JSON.stringify([
            {
                data: {
                    permalink_url: url,
                    duration: 180000,
                    genre: 'DnB',
                    tag_list: '"drum and bass" fast instrumental',
                    bpm: 174,
                    streamable: true,
                    state: 'finished',
                    policy: 'ALLOW',
                    media: { transcodings: [{ snipped: false, format: { protocol: 'hls' } }] },
                },
            },
        ])};`;
        expect(parsePublicTrackMetadata(html, url)).toMatchObject({
            durationSeconds: 180,
            genre: 'DnB',
            tags: ['drum and bass', 'fast', 'instrumental'],
            bpm: 174,
            bpmConfidence: 0.75,
            playability: 'available',
        });
        expect(parsePublicTrackMetadata(html, 'https://soundcloud.com/other/song').bpm).toBeUndefined();
    });
});
