import { afterEach, expect, it, vi } from 'vitest';
import { Wave } from './wave';
import { AudioAnalysisCache } from '../../src/wave/audioAnalysisCache';
import { SoundCloudRecommender } from '../../src/wave/recommendation/soundcloudAdapter';
import type { Feedback } from '../../src/wave/recommendation/types';
import type { WaveCandidate } from '../../src/wave/waveEngine';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
it('gates audio analysis during adverts without resetting an unchanged measurement', () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    const wave = new Wave();
    let allowed = true;
    Object.assign(wave, {
        active: false,
        recommender: { stats: () => ({ heard: 0, liked: 0 }) },
        current: { url: 'https://soundcloud.com/test/tone', isPlaying: true },
        candidates: new Map([['https://soundcloud.com/test/tone', { url: 'https://soundcloud.com/test/tone' }]]),
        canAdvance: () => allowed,
    });
    const state = wave as unknown as { analysisState: () => void };
    const visible = vi.fn();
    wave.events.on('analysis', visible);
    state.analysisState();
    wave.audioStatus({ phase: 'analysing', sampleSeconds: 12 });
    state.analysisState();
    expect(wave.ready().analysis).toMatchObject({ phase: 'analysing', sampleSeconds: 12 });
    expect(visible).not.toHaveBeenCalled();
    allowed = false;
    state.analysisState();
    expect((window as unknown as { __waveMediaEndState: { active: boolean } }).__waveMediaEndState.active).toBe(false);
    allowed = true;
    state.analysisState();
    expect((window as unknown as { __waveMediaEndState: { active: boolean } }).__waveMediaEndState.active).toBe(true);
});
it('updates the heard count while playing and applies measured audio to persisted taste feedback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    const data = new Map<string, unknown>();
    const store = {
        get: (key: string) => data.get(key),
        set: (key: string, value: unknown) => {
            data.set(key, value);
        },
    };
    const recommender = new SoundCloudRecommender(store, '7', async () => []);
    const wave = new Wave(),
        candidate: WaveCandidate = {
            url: 'https://soundcloud.com/test/tone',
            title: 'Tone',
            artist: 'Test',
            durationSeconds: 120,
            source: 'personal',
            sourceRank: 0,
            genre: 'house',
            metadataChecked: true,
            playability: 'available',
        };
    Object.assign(wave, {
        active: true,
        recommender,
        analysis: new AudioAnalysisCache(store, '7'),
        candidates: new Map([[candidate.url, candidate]]),
        refill: async () => {},
    });
    const observe = (wave as unknown as { observe: (frame: object) => void }).observe.bind(wave);
    const stats: object[] = [];
    wave.events.on('stats', (value) => stats.push(value));
    const frame = {
        url: candidate.url,
        title: 'Tone',
        author: 'Test',
        isPlaying: true,
        isLiked: false,
        duration: '2:00',
    };
    for (let second = 0; second <= 65; second += 5) {
        vi.setSystemTime(100000 + second * 1000);
        observe({ ...frame, elapsed: `${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}` });
    }
    expect(recommender.stats().heard).toBe(1);
    expect(stats[stats.length - 1]).toMatchObject({ heard: 1 });
    for (let second = 1; second <= 30; second++)
        wave.audio({
            path: '/test/tone',
            source: 'media-element-v1',
            sampleSeconds: second,
            energy: 0.2,
            bass: 0.6,
            treble: 0.1,
        });
    expect(wave.ready().analysis).toMatchObject({ phase: 'ready', analysed: 1, sampleSeconds: 30 });
    const events = [...data.values()].find(
        (value) => Array.isArray(value) && value.some((event) => event?.kind === 'play'),
    ) as Feedback[];
    expect(
        events
            .filter((event) => event.track.id === candidate.url)
            .every((event) => event.track.features?.source === 'media-element-v1'),
    ).toBe(true);
    expect(new SoundCloudRecommender(store, '7', async () => []).stats().heard).toBe(1);
});
