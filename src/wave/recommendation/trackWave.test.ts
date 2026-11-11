import { expect, it, vi } from 'vitest';
import { RecommendationSession } from './session';
import type { Track } from './types';

const track = (id: string, tags: string[], extra: Partial<Track> = {}): Track => ({
    id,
    title: id,
    artist: id,
    genre: 'Electronic',
    tags,
    ...extra,
});
const features = (bass: number, bpm: number) => ({
    source: 'media-element-v1' as const,
    sampleSeconds: 35,
    bass,
    brightness: 1 - bass,
    bpm,
    bpmConfidence: 0.95,
});

it('keeps discovery and ranking tied to the selected track through playback and user feedback', async () => {
    const seed = track('seed', ['jungle', 'breakbeat'], { apiId: 10, features: features(0.8, 168) });
    const sameSound = track('same-sound', seed.tags!, { relatedTo: [seed.id], features: features(0.79, 169) });
    const differentSound = track('different-sound', seed.tags!, { relatedTo: [seed.id], features: features(0.1, 75) });
    const backup = track('backup', seed.tags!, { relatedTo: [seed.id] });
    const unrelated = track('unrelated', ['ambient'], { title: 'jungle breakbeat', genre: 'ambient' });
    const duplicate = { ...seed, id: 'old-url' };
    const related = vi.fn(async () => [differentSound, sameSound, backup, unrelated, duplicate]);
    const session = new RecommendationSession({ related });
    session.setControls({ discovery: 'favorites', mood: 'calm', tempo: 'slow' });
    session.feedback({ kind: 'like', track: unrelated });
    session.setTrackSeed(seed);
    await session.refresh();
    expect(related).toHaveBeenLastCalledWith([seed]);
    expect(session.rank().map((entry) => entry.track.id)).toEqual([sameSound.id, backup.id]);
    expect(session.rank()[0].reasons).toContain('похожее звучание по аудиоанализу');
    session.setAnchor(sameSound);
    session.feedback({ kind: 'dislike', track: sameSound });
    await session.refresh();
    expect(related).toHaveBeenLastCalledWith([seed]);
    expect(session.rank().map((entry) => entry.track.id)).toEqual([backup.id]);
    session.setTrackSeed();
    expect(session.rank().map((entry) => entry.track.id)).toEqual([unrelated.id]);
});

it('does not fill the third slot with broad Hip-hop & Rap matches after the close tracks are reserved', async () => {
    const genre = 'Hip-hop & Rap';
    const seed = track('seed', ['collective', 'album'], { genre });
    const liked = track('liked', ['boom bap', 'sampled'], { genre });
    const relatedTo = [seed.id];
    const good = [
        track('a', ['boom bap', 'sampled'], { genre, relatedTo }),
        track('b', ['collective'], { genre, relatedTo }),
    ];
    const weak = [
        track('wrong', ['cloud', 'rage', 'sigilkore'], { genre, relatedTo }),
        track('genre-only', [], { genre, relatedTo }),
        track('genre-only-library', [], { genre }),
    ];
    const third = track('c', ['boom bap', 'sampled'], { genre, relatedTo });
    const related = vi.fn(async (...args: [Track[], boolean?]) => (args[1] ? [third] : [...good, ...weak]));
    const session = new RecommendationSession({ related });
    session.feedback({ kind: 'like', track: liked });
    session.setTrackSeed(seed);
    await session.refresh();
    expect(
        session
            .rank()
            .map(({ track }) => track.id)
            .sort(),
    ).toEqual(['a', 'b']);
    for (const item of good) session.reserve(item.id);
    expect(session.rank()).toEqual([]);
    await session.refresh(true);
    expect(related).toHaveBeenLastCalledWith([seed], true);
    expect(session.rank().map(({ track }) => track.id)).toEqual(['c']);
});

it('uses measured energy when BPM is unavailable and bass balance alone is ambiguous', async () => {
    const measured = (bass: number, energy: number) => ({
        source: 'media-element-v1' as const,
        sampleSeconds: 31,
        bass,
        brightness: 0.04,
        energy,
    });
    const genre = 'Hip-hop & Rap';
    const seed = track('seed', ['collective'], { genre, features: measured(0.69, 0.112) });
    const relatedTo = [seed.id];
    const compatible = track('compatible', [], { genre, relatedTo, features: measured(0.7, 0.155) });
    const muted = track('muted', ['ambient'], { genre, relatedTo, features: measured(0.7, 0.002) });
    const session = new RecommendationSession({ related: async () => [compatible, muted] });
    session.setTrackSeed(seed);
    await session.refresh();
    expect(session.rank().map((item) => item.track.id)).toEqual([compatible.id]);
});

it('keeps a sparse track wave playing, prefers stronger evidence and excludes distant or disliked tracks', async () => {
    const genre = 'Hip-hop & Rap';
    const seed = track('seed', ['collective'], { genre });
    const strong = track('strong', ['collective'], { genre });
    const station = track('station', ['boombap'], { genre, stationSeed: seed.id, stationRank: 1 });
    const sparse = track('sparse', [], { genre, relatedTo: [seed.id], sourceRank: 3 });
    const distant = track('distant', ['rage'], { genre, relatedTo: [seed.id], sourceRank: 2 });
    const incompatible = track('incompatible', ['folk'], { genre: 'folk', stationSeed: seed.id, stationRank: 0 });
    const oldStation = track('old-station', [], { genre, stationSeed: 'previous-seed', stationRank: 0 });
    const rejected = track('rejected', [], { genre, stationSeed: seed.id, stationRank: 0 });
    const session = new RecommendationSession({
        related: async () => [strong, station, sparse, distant, incompatible, oldStation, rejected],
    });
    session.setTrackSeed(seed);
    session.feedback({ kind: 'dislike', track: rejected });
    await session.refresh();
    expect(session.rank().map((item) => item.track.id)).toEqual([strong.id, station.id, sparse.id]);
    session.reserve(strong.id);
    expect(session.rank(1)[0]?.track.id).toBe(station.id);
    session.reserve(station.id);
    expect(session.rank(1)[0]?.track.id).toBe(sparse.id);
});

it('switches discovery immediately and ignores a response from the previous seed', async () => {
    const first = track('first', ['jungle']);
    const second = track('second', ['ambient']);
    const next = track('next', ['ambient']);
    let finishFirst!: (result: Track[]) => void;
    const related = vi.fn(([seed]: Track[]) =>
        seed.id === first.id
            ? new Promise<Track[]>((resolve) => {
                  finishFirst = resolve;
              })
            : Promise.resolve([next]),
    );
    const session = new RecommendationSession({ related });
    session.setTrackSeed(first);
    const previous = session.refresh();
    session.setTrackSeed(second);
    await expect(session.refresh()).resolves.toMatchObject([{ track: { id: next.id } }]);
    finishFirst([track('stale', ['ambient'], { relatedTo: [second.id] })]);
    await expect(previous).resolves.toEqual([]);
    expect(session.rank().map((entry) => entry.track.id)).toEqual([next.id]);
});
