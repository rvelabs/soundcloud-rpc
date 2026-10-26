import { describe, expect, it } from 'vitest';
import { parseTime } from './waveEngine';
import { WaveEngine } from './waveEngine';
import type ElectronStore from 'electron-store';
import type { TrackInfo } from '../types';
describe('local listening history', () => {
    it('bounds both the stored and in-memory history during a long session', () => {
        const saved = new Map<string, unknown>();
        const store = {
            get: (key: string, fallback: unknown) => saved.get(key) ?? fallback,
            set: (key: string, value: unknown) => saved.set(key, value),
        } as unknown as ElectronStore;
        const engine = new WaveEngine(store);
        for (let i = 0; i < 650; i++)
            engine.setLiked('track' + i, true, {
                url: 'track' + i,
                title: 'Track ' + i,
                artist: 'Artist',
                sourceRank: 0,
            });
        expect((saved.get('waveHistory_default') as unknown[]).length).toBe(500);
        expect(engine.stats().liked).toBe(500);
        expect(engine.liked('track0')).toBeUndefined();
        expect(engine.liked('track649')).toBe(true);
    });
    it('parses playback time without accepting malformed data', () => {
        expect(parseTime('1:02:03')).toBe(3723);
        expect(parseTime('bad')).toBe(0);
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
        expect(engine.heard('liked')).toBe(true);
        expect(engine.heard('new')).toBe(false);
    });
});
