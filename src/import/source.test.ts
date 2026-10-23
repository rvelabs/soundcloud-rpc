import { describe, expect, it } from 'vitest';
import {
    classifyPlaylistUrl,
    parseSpotifyEmbed,
    parseYandexPlaylist,
    parseYouTubePlaylist,
    resolveYandexPlaylist,
} from './source';
import { matchScore } from './match';
describe('playlist source URLs', () => {
    it('accepts only supported HTTPS playlist links', () => {
        expect(classifyPlaylistUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x').url).toBe(
            'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
        );
        expect(
            classifyPlaylistUrl('https://music.youtube.com/playlist?list=PL-zl0Qa3WDZ-XYzFHodllO2vHmE7kGODR').platform,
        ).toBe('youtube');
        expect(
            classifyPlaylistUrl('https://music.yandex.ru/playlists/49ef1682-5961-459f-b6e2-000000000000').platform,
        ).toBe('yandex');
        expect(() => classifyPlaylistUrl('http://127.0.0.1/playlist/37i9dQZF1DXcBWIGoYBM5M')).toThrow();
        expect(() =>
            classifyPlaylistUrl('https://open.spotify.com.evil.test/playlist/37i9dQZF1DXcBWIGoYBM5M'),
        ).toThrow();
    });
});
describe('public playlist parsers', () => {
    it('reads Spotify embed data including artists', () => {
        const data = {
            props: {
                pageProps: {
                    state: {
                        data: {
                            entity: {
                                name: 'My List',
                                trackList: [{ title: 'Song', subtitle: 'Artist', uri: 'spotify:track:abc' }],
                            },
                        },
                    },
                },
            },
        };
        const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
        expect(parseSpotifyEmbed(html)).toEqual({
            platform: 'spotify',
            title: 'My List',
            partial: false,
            tracks: [{ title: 'Song', artist: 'Artist', sourceId: 'spotify:track:abc' }],
        });
    });
    it('reads Yandex tracks and notices truncated data', () => {
        const playlist = parseYandexPlaylist({
            playlist: {
                title: 'Мой плейлист',
                trackCount: 2,
                tracks: [{ track: { title: 'Трек', artists: [{ name: 'Автор' }], id: 12 } }],
            },
        });
        expect(playlist.tracks[0]).toMatchObject({ title: 'Трек', artist: 'Автор' });
        expect(playlist.partial).toBe(true);
        expect(resolveYandexPlaylist('<iframe src="https://music.yandex.ru/iframe/playlist/music-blog/2581">')).toEqual(
            { owner: 'music-blog', kind: '2581' },
        );
    });
    it('reads YouTube playlist rows without treating consent page as playlist', () => {
        const data = {
            header: { playlistHeaderRenderer: { title: { simpleText: 'Mix' } } },
            contents: [
                {
                    playlistVideoRenderer: {
                        videoId: 'abc',
                        title: { runs: [{ text: 'Song' }] },
                        shortBylineText: { runs: [{ text: 'Artist' }] },
                    },
                },
            ],
        };
        expect(
            parseYouTubePlaylist(`<script>var ytInitialData = ${JSON.stringify(data)};</script>`).tracks[0],
        ).toMatchObject({ title: 'Song', artist: 'Artist' });
        expect(() => parseYouTubePlaylist('<title>Before you continue</title>')).toThrow();
    });
    it('reads the current public YouTube playlist layout', () => {
        const data = {
            metadata: { playlistMetadataRenderer: { title: 'Mix' } },
            contents: [
                {
                    lockupViewModel: {
                        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                        contentId: 'abc',
                        metadata: {
                            lockupMetadataViewModel: {
                                title: { content: 'Song' },
                                metadata: {
                                    contentMetadataViewModel: {
                                        metadataRows: [
                                            {
                                                metadataParts: [{ text: { content: 'Artist' } }],
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                    },
                },
            ],
        };
        expect(parseYouTubePlaylist(`<script>var ytInitialData = ${JSON.stringify(data)};</script>`)).toMatchObject({
            title: 'Mix',
            tracks: [{ title: 'Song', artist: 'Artist', sourceId: 'abc' }],
        });
    });
});
it('requires artist and title agreement for a SoundCloud match', () => {
    const source = { title: 'My Song', artist: 'Some Artist' };
    expect(matchScore(source, { title: 'Some Artist - My Song', artist: 'Uploader' })).toBeGreaterThan(0.85);
    expect(matchScore(source, { title: 'My Song (Live)', artist: 'Other Artist' })).toBeLessThan(0.78);
    expect(
        matchScore({ title: 'Beanie', artist: 'Chezile' }, { title: 'Beanie - Best Part - Looped', artist: 'Chezile' }),
    ).toBeLessThan(0.78);
    expect(
        matchScore(
            { title: 'expectations (feat. Chappell Roan)', artist: 'Olivia Rodrigo, Chappell Roan' },
            { title: 'expectations', artist: 'Olivia Rodrigo, Chappell Roan' },
        ),
    ).toBeGreaterThan(0.85);
});
