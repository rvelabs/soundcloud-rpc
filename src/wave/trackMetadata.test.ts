import { describe, expect, it, vi } from 'vitest';
import { enrichPublicTrack, parsePublicTrackMetadata, setPublicMetadataFetch } from './trackMetadata';
describe('public SoundCloud track metadata', () => {
    it('releases a window-owned fetch without resetting a newer controller', async () => {
        const first = vi.fn(async () => new Response('<meta itemprop="duration" content="PT60S">'));
        const second = vi.fn(async () => new Response('<meta itemprop="duration" content="PT90S">'));
        const releaseFirst = setPublicMetadataFetch(first as typeof fetch);
        const releaseSecond = setPublicMetadataFetch(second as typeof fetch);
        try {
            releaseFirst();
            const track = await enrichPublicTrack({
                url: 'https://soundcloud.com/artist/fetch-owner',
                title: 'Track',
                artist: 'Artist',
                sourceRank: 0,
            });
            expect(track.durationSeconds).toBe(90);
            expect(first).not.toHaveBeenCalled();
            expect(second).toHaveBeenCalledTimes(1);
        } finally {
            releaseSecond();
        }
    });
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
