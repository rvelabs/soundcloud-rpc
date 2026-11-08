import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ invoke: vi.fn(), player: vi.fn() }));
vi.mock('../../src/soundcloud/nativePlayerBridge', () => ({
    nativeAutoplay: () => null,
    installNativePlayerMonitor: () => () => {},
    nativePlayerCommand: host.player,
}));
import { Wave } from './wave';
import { recentReactions } from '../../src/wave/recommendation/sessionSignals';
import { SoundCloudRecommender } from '../../src/wave/recommendation/soundcloudAdapter';
import type { Feedback } from '../../src/wave/recommendation/types';
import type { WaveCandidate } from '../../src/wave/waveEngine';
import type { LibrarySignals } from '../../src/soundcloud/radioSources';

const raw = (id: number) => ({
    id,
    title: 'Recording ' + id,
    genre: 'jungle',
    permalink_url: 'https://soundcloud.com/artist/track-' + id,
    user: { id: id + 100, username: 'Artist ' + id },
    duration: 120000,
    streamable: true,
    state: 'finished',
    policy: 'ALLOW',
});
let saved: Record<string, unknown>;
let owner: number;
let revision: number;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    saved = {};
    owner = 7;
    revision = 1;
    host.invoke.mockReset();
    host.player.mockReset();
    host.invoke.mockImplementation(async (command, args) => {
        if (command === 'native_diagnostics') return { catalog: { ready: true, revision } };
        if (command === 'profile_load') return structuredClone(saved);
        if (command === 'profile_save') {
            saved = structuredClone(args.value);
            return;
        }
        if (command === 'catalog_request') {
            const request = args.request;
            if (request.operation === 'me') return { id: owner };
            if (request.operation === 'resolve') return raw(Number(request.url.match(/track-(\d+)/)[1]));
            if (request.path?.endsWith('/related')) return { collection: [raw(4)] };
            return { collection: [] };
        }
        return null;
    });
    const page = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: { invoke: host.invoke } });
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', new EventTarget());
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
const settle = async () => {
    for (let index = 0; index < 60; index++) await Promise.resolve();
};
type Internals = {
    observe(frame: object): void;
    recommender: SoundCloudRecommender;
    canAdvance(): boolean;
    current?: object;
    candidates: Map<string, WaveCandidate>;
    queued: Set<string>;
    queue(operation: string, urls: string[]): Promise<unknown>;
    refill(): Promise<void>;
    applyLibrarySignals(signals: LibrarySignals): void;
};
const frame = (id: number, elapsed = '0:00') => ({
    url: raw(id).permalink_url,
    title: raw(id).title,
    author: raw(id).user.username,
    duration: '2:00',
    elapsed,
    isPlaying: true,
    isLiked: false,
});

it('imports a positive heart from the first hydrated snapshot once, without inventing a live reaction', async () => {
    const wave = new Wave(),
        state = wave as unknown as Internals;
    await wave.tick();
    state.observe({ ...frame(20), isLiked: true });
    await settle();
    state.observe({ ...frame(20), isLiked: true });
    await settle();
    const events = saved.waveFeedbackV1_7 as Feedback[];
    const likes = events.filter((event) => event.kind === 'like' && event.track.apiId === 20);
    expect(likes).toHaveLength(1);
    expect(likes[0].origin).toBe('library');
    expect(recentReactions(events, Date.now()).some((event) => event.kind === 'like')).toBe(false);
    expect(state.recommender.liked(frame(20).url)).toBe(true);
    state.observe(frame(21));
    await settle();
    expect(
        (saved.waveFeedbackV1_7 as Feedback[]).some((event) => event.kind === 'unlike' && event.track.apiId === 21),
    ).toBe(false);
});

it('withdraws newly recognized library tracks from the upcoming New queue without touching other tracks', async () => {
    const wave = new Wave(),
        state = wave as unknown as Internals;
    await wave.tick();
    state.observe(frame(20));
    await settle();
    const first = state.candidates.get(frame(20).url)!;
    const second = { ...first, url: frame(21).url, apiId: 21 };
    state.candidates.set(second.url, second);
    state.recommender.addCandidates([first, second]);
    state.recommender.setControls({ ...wave.controls, discovery: 'new' });
    state.queued.add(first.url);
    state.queued.add(second.url);
    state.recommender.reserve(first, true);
    state.recommender.reserve(second, true);
    state.queue = vi.fn(async () => ({ state: 'done' }));
    state.refill = vi.fn(async () => {});
    state.applyLibrarySignals({
        likedIds: [20],
        blockedIds: [],
        likesComplete: true,
        blocksComplete: true,
        more: false,
    });
    await settle();
    expect([...state.queued]).toEqual([second.url]);
    expect(state.queue).toHaveBeenCalledWith('remove', [first.url]);
    expect(state.refill).toHaveBeenCalledOnce();
    expect(host.player).not.toHaveBeenCalled();
});

it('learns ordinary playback, measures its audio and changes discovery without ever starting My Wave', async () => {
    const wave = new Wave(),
        state = wave as unknown as Internals;
    state.canAdvance = () => true;
    await wave.tick();
    expect(wave.active).toBe(false);
    expect(host.player).not.toHaveBeenCalled();
    state.observe(frame(2));
    await settle();
    for (let seconds = 5; seconds <= 100; seconds += 5) {
        vi.setSystemTime(100000 + seconds * 1000);
        state.observe(frame(2, Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')));
    }
    await wave.tick();
    expect((window as unknown as { __waveMediaEndState: { active: boolean } }).__waveMediaEndState.active).toBe(true);
    for (let sample = 1; sample <= 30; sample++)
        wave.audio({
            path: '/artist/track-2',
            source: 'media-element-v1',
            sampleSeconds: sample,
            energy: 0.2,
            bass: 0.6,
            treble: 0.1,
        });
    state.observe(frame(3));
    await settle();
    const events = saved.waveFeedbackV1_7 as Feedback[];
    const completed = events.find((event) => event.kind === 'complete' && event.track.apiId === 2)!;
    expect(completed).toBeDefined();
    expect(completed.origin).toBeUndefined();
    expect(completed.listenedFraction).toBeGreaterThan(0.8);
    expect(completed.track.features?.source).toBe('media-element-v1');
    expect(recentReactions(events, Date.now()).some((event) => event.track.apiId === 2)).toBe(true);
    await state.recommender.refresh();
    expect(
        host.invoke.mock.calls.some(
            ([command, args]) => command === 'catalog_request' && args.request.path === '/tracks/2/related',
        ),
    ).toBe(true);
    expect(state.recommender.stats().heard).toBe(1);
    expect(wave.active).toBe(false);
});

it('uses the actually playing track as the anchor after each confirmed change', async () => {
    const wave = new Wave(),
        state = wave as unknown as Internals;
    await wave.tick();
    const anchor = vi.spyOn(state.recommender, 'setAnchor');
    state.observe(frame(2));
    await settle();
    state.observe(frame(3));
    await settle();
    expect(anchor.mock.calls.map(([track]) => track?.apiId)).toEqual([2, 3]);
});

it('wakes and suspends ordinary audio analysis on play and pause without waiting for a host tick', async () => {
    const wave = new Wave(),
        state = wave as unknown as Internals;
    state.canAdvance = () => true;
    await wave.tick();
    state.observe({ ...frame(2), isPlaying: false });
    await settle();
    const enabled = () =>
        (window as unknown as { __waveMediaEndState: { active: boolean } }).__waveMediaEndState.active;
    expect(enabled()).toBe(false);
    state.observe(frame(2));
    expect(enabled()).toBe(true);
    state.observe({ ...frame(2), isPlaying: false });
    expect(enabled()).toBe(false);
});

it('invalidates a listening profile on account change even with My Wave off', async () => {
    const wave = new Wave(),
        state = wave as unknown as Internals;
    await wave.tick();
    state.observe(frame(2));
    await settle();
    owner = 8;
    revision = 2;
    await wave.tick();
    expect(state.current).toBeUndefined();
    expect(state.recommender).toBeUndefined();
});
