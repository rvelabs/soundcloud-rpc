import { describe, expect, it } from 'vitest';
import { matchesTempo, parseTime, playableCandidates, rankCandidates } from './waveEngine';
import { WaveEngine } from './waveEngine';
import type ElectronStore from 'electron-store';
import type { TrackInfo } from '../types';
describe('local wave ranking', () => {
    it('keeps SoundCloud order for a new listener, then adapts to likes and skips', () => {
        const candidates = [
            { url: 'https://soundcloud.com/a/ambient-one', title: 'ambient sound', artist: 'A', sourceRank: 0 },
            { url: 'https://soundcloud.com/b/techno-one', title: 'techno pulse', artist: 'B', sourceRank: 1 },
        ];
        expect(rankCandidates(candidates, [])[0].url).toBe(candidates[0].url);
        const history = [
            {
                url: 'liked',
                title: 'techno night',
                artist: 'B',
                liked: true,
                plays: 3,
                skips: 0,
                features: { energy: 0.8, bass: 0.7, mid: 0.5, treble: 0.3 },
            },
            { url: 'skipped', title: 'ambient sky', artist: 'A', liked: false, plays: 0, skips: 2 },
        ];
        expect(rankCandidates(candidates, history)[0].url).toBe(candidates[1].url);
    });
    it('parses playback time without accepting malformed data', () => {
        expect(parseTime('1:02:03')).toBe(3723);
        expect(parseTime('bad')).toBe(0);
    });
    it('prefers matching genre and avoids repeating the current artist', () => {
        const candidates = [
            { url: 'same', title: 'techno one', artist: 'Same Artist', sourceRank: 0, tags: ['techno'], bpm: 155 },
            { url: 'other', title: 'techno two', artist: 'Other Artist', sourceRank: 1, tags: ['techno'], bpm: 150 },
        ];
        expect(
            rankCandidates(candidates, [], { mood: 'energetic', tone: 'any', tempo: 'fast', genre: 'techno' }, [
                'Same Artist',
            ])[0].url,
        ).toBe('other');
    });
    it('uses tempo and calm metadata before a candidate has been played', () => {
        const candidates = [
            { url: 'fast', title: 'techno pulse', artist: 'A', sourceRank: 0, bpm: 155 },
            { url: 'slow', title: 'ambient sky', artist: 'B', sourceRank: 1, bpm: 85 },
        ];
        expect(rankCandidates(candidates, [], { mood: 'calm', tone: 'any', tempo: 'slow', genre: '' })[0].url).toBe(
            'slow',
        );
    });
    it('learns genre tags outside its built-in style vocabulary', () => {
        const candidates = [
            { url: 'other', title: 'A', artist: 'A', sourceRank: 0, tags: ['noise'] },
            { url: 'match', title: 'B', artist: 'B', sourceRank: 1, tags: ['driftwave'] },
        ];
        const history = [
            { url: 'liked', title: 'C', artist: 'C', liked: true, plays: 2, skips: 0, tags: ['driftwave'] },
        ];
        expect(rankCandidates(candidates, history)[0].url).toBe('match');
    });
    it('counts an immediate manual skip once when playback moves to the next track', () => {
        const saved = new Map<string, unknown>();
        const store = {
            get: (key: string, fallback: unknown) => saved.get(key) ?? fallback,
            set: (key: string, value: unknown) => {
                saved.set(key, value);
            },
        } as unknown as ElectronStore;
        const engine = new WaveEngine(store);
        const track = (url: string): TrackInfo => ({
            url,
            title: url,
            author: 'Artist',
            artwork: '',
            elapsed: '0:00',
            duration: '3:00',
            isPlaying: true,
            isLiked: false,
        });
        engine.observe(track('one'));
        engine.skipCurrent();
        engine.skipCurrent();
        engine.observe(track('two'));
        const history = saved.get('waveHistory_default') as Array<{
            url: string;
            skips: number;
        }>;
        expect(history.find((item) => item.url === 'one')?.skips).toBe(1);
    });
    it('lets an explicit like immediately influence the next recommendation', () => {
        const saved = new Map<string, unknown>();
        const store = {
            get: (key: string, fallback: unknown) => saved.get(key) ?? fallback,
            set: (key: string, value: unknown) => {
                saved.set(key, value);
            },
        } as unknown as ElectronStore;
        const engine = new WaveEngine(store);
        engine.setLiked('liked', true, {
            url: 'liked',
            title: 'Rock favorite',
            artist: 'First',
            tags: ['shoegaze'],
            sourceRank: 0,
        });
        const ranked = engine.rank([
            { url: 'unrelated', title: 'House beat', artist: 'Second', sourceRank: 0 },
            { url: 'related', title: 'Shoegaze dream', artist: 'Third', tags: ['shoegaze'], sourceRank: 1 },
        ]);
        expect(ranked[0].url).toBe('related');
        expect(engine.liked('liked')).toBe(true);
    });
    it('matches a multiword genre from the listener controls', () => {
        const candidates = [
            { url: 'unmatched', title: 'A', artist: 'A', tags: ['house'], sourceRank: 0 },
            { url: 'matched', title: 'B', artist: 'B', tags: ['drum', 'bass'], sourceRank: 1 },
        ];
        expect(
            rankCandidates(candidates, [], { mood: 'any', tone: 'any', tempo: 'any', genre: 'drum and bass' })[0].url,
        ).toBe('matched');
    });
    it('moves calm slow tracks ahead of fast energetic tracks', () => {
        const candidates = [
            { url: 'fast', title: 'Rave sprint', artist: 'A', genre: 'techno', bpm: 158, sourceRank: 0 },
            { url: 'slow', title: 'Quiet drift', artist: 'B', genre: 'ambient', bpm: 84, sourceRank: 1 },
        ];
        expect(rankCandidates(candidates, [], { mood: 'calm', tone: 'any', tempo: 'slow', genre: '' })[0].url).toBe(
            'slow',
        );
        expect(
            rankCandidates(candidates, [], { mood: 'energetic', tone: 'any', tempo: 'fast', genre: '' })[0].url,
        ).toBe('fast');
        expect(matchesTempo(84, 'slow')).toBe(true);
        expect(matchesTempo(158, 'slow')).toBe(false);
    });
    it('uses liked genres to search for unfamiliar tracks and applies controls to the query', () => {
        const saved = new Map<string, unknown>();
        const store = {
            get: (key: string, fallback: unknown) => saved.get(key) ?? fallback,
            set: (key: string, value: unknown) => {
                saved.set(key, value);
            },
        } as unknown as ElectronStore;
        const engine = new WaveEngine(store);
        engine.setLiked('liked', true, {
            url: 'liked',
            title: 'Favorite',
            artist: 'A',
            genre: 'Shoegaze',
            sourceRank: 0,
        });
        const queries = engine.searchQueries({ mood: 'calm', tone: 'any', tempo: 'slow', genre: '' });
        expect(queries[0]).toContain('Shoegaze');
        expect(queries[0]).toContain('chill');
        expect(queries[0]).toContain('slow');
        expect(engine.heard('liked')).toBe(true);
        expect(engine.heard('unseen')).toBe(false);
    });
    it('selects unheard tracks, excludes existing likes, and honors measured tempo', () => {
        const ranked = [
            { url: 'old', title: 'Old', artist: 'A', sourceRank: 0, bpm: 90 },
            { url: 'liked', title: 'Liked', artist: 'B', sourceRank: 1, bpm: 150, liked: true },
            { url: 'wrong-tempo', title: 'Fast', artist: 'C', sourceRank: 2, bpm: 160 },
            { url: 'new', title: 'New', artist: 'D', sourceRank: 3, bpm: 88 },
        ];
        const result = playableCandidates(
            ranked,
            { mood: 'calm', tone: 'any', tempo: 'slow', genre: '' },
            'A',
            (url) => url === 'old',
        );
        expect(result.map((item) => item.url)).toEqual(['new']);
    });
    it('learns liked genres from the account without putting those tracks into the queue', () => {
        const saved = new Map<string, unknown>();
        const store = {
            get: (key: string, fallback: unknown) => saved.get(key) ?? fallback,
            set: (key: string, value: unknown) => {
                saved.set(key, value);
            },
        } as unknown as ElectronStore;
        const engine = new WaveEngine(store);
        engine.ingestLikes([{ url: 'liked', title: 'Favorite', artist: 'A', genre: 'Shoegaze', sourceRank: 0 }]);
        expect(engine.searchQueries()[0]).toBe('Shoegaze');
        expect(engine.heard('liked')).toBe(true);
        expect(engine.heard('new')).toBe(false);
    });
    it('uses measured tempo from matching styles when a new track has no published BPM', () => {
        const history = [
            { url: 'seed1', title: 'A', artist: 'A', liked: false, plays: 1, skips: 0, tags: ['driftwave'], bpm: 82 },
            { url: 'seed2', title: 'B', artist: 'B', liked: false, plays: 1, skips: 0, tags: ['driftwave'], bpm: 88 },
        ];
        const candidates = [
            { url: 'other', title: 'C', artist: 'C', sourceRank: 0, tags: ['cosmic'] },
            { url: 'match', title: 'D', artist: 'D', sourceRank: 1, tags: ['driftwave'] },
        ];
        expect(rankCandidates(candidates, history, { mood: 'any', tone: 'any', tempo: 'slow', genre: '' })[0].url).toBe(
            'match',
        );
    });
});
