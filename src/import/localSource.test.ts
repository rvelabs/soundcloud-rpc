import { describe, it, expect } from 'vitest';
import { parseLocalPlaylist } from './localSource';
describe('offline source lists', () => {
    it('reads Spotify-style CSV with BOM, escaped quotes, commas and multiline fields', () => {
        const value = parseLocalPlaylist(
            '\uFEFFTrack Name,Artist Name(s),Playlist Name\r\n"A, B","Artist ""One""",My List\r\n"Next\nsong",Other,My List',
            'export.csv',
        );
        expect(value.title).toBe('My List');
        expect(value.tracks).toEqual([
            { title: 'A, B', artist: 'Artist "One"' },
            { title: 'Next song', artist: 'Other' },
        ]);
    });
    it('accepts localized semicolon CSV, tab-separated data and a plain artist-title list', () => {
        expect(parseLocalPlaylist('Название;Исполнитель\nТрек;Автор', 'List.csv').tracks).toEqual([
            { title: 'Трек', artist: 'Автор' },
        ]);
        expect(parseLocalPlaylist('title\tartist\nTrack\tBand', 'List.tsv').tracks).toHaveLength(1);
        expect(parseLocalPlaylist('Band — Track\nBand — Track\nOther - Next', 'List.txt').tracks).toHaveLength(2);
    });
    it('does not mistake Spotify URIs alone for usable track metadata', () => {
        expect(() => parseLocalPlaylist('spotify:track:abc\nspotify:track:def', 'List.txt')).toThrow('названия');
        expect(() => parseLocalPlaylist('Track Name,Artist Name\n"Unclosed,Band', 'List.csv')).toThrow('кавычки');
    });
    it('caps playlist size explicitly rather than silently promising the whole source', () => {
        const list = parseLocalPlaylist(
            Array.from({ length: 503 }, (_, i) => 'Band — Track ' + i).join('\n'),
            'List.txt',
        );
        expect(list.tracks).toHaveLength(500);
        expect(list.partial).toBe(true);
        expect(() => parseLocalPlaylist('x'.repeat(4000001), 'List.txt')).toThrow('велик');
    });
});
