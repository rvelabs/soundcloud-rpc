import { describe, expect, it, vi } from 'vitest';
import { RelatedDiscovery } from './relatedDiscovery';
import { discoverySeeds } from './recommendation/discovery';
import { buildProfile } from './recommendation/profile';
import { RecommendationSession } from './recommendation/session';
import { defaultControls, type Track } from './recommendation/types';
import type { WaveCandidate } from './waveEngine';

const seed = (id: string, artist = id): Track => ({ id: `https://soundcloud.com/${id}/song`, title: id, artist });
const candidate = (id: string): WaveCandidate => ({ url: seed(id).id, title: id, artist: id, sourceRank: 0 });
describe('track-based discovery', () => {
    it('uses related recordings instead of generating genre searches, even without any tags', async () => {
        const related = vi.fn(async () => [
            { ...seed('new'), source: 'related' as const, relatedTo: [seed('favorite').id] },
        ]);
        const session = new RecommendationSession({ related }, () => 1000);
        session.feedback({ track: seed('favorite'), kind: 'like', at: 1000 });
        await session.refresh();
        expect(related).toHaveBeenCalledWith([expect.objectContaining(seed('favorite'))]);
        expect(session.rank()[0].track.id).toBe(seed('new').id);
    });
    it('does not invent default genres for a brand new account', async () => {
        const related = vi.fn(async () => []);
        const session = new RecommendationSession({ related });
        await session.refresh();
        expect(related).toHaveBeenCalledWith([]);
    });
    it('rotates actual favorites across artists and never uses an explicitly disliked anchor', () => {
        const profile = buildProfile(
            Array.from({ length: 8 }, (_, i) => ({
                track: seed('a' + i, i < 3 ? 'same' : 'artist' + i),
                kind: 'like' as const,
                at: i,
            })),
            1000,
        );
        const first = discoverySeeds(profile, defaultControls, 0);
        const second = discoverySeeds(profile, defaultControls, 1);
        expect(new Set(first.map((t) => t.artist)).size).toBe(first.length);
        expect(second.some((t) => !first.some((one) => one.id === t.id))).toBe(true);
        const bad = seed('bad');
        profile.dislikedIds.add(bad.id);
        expect(discoverySeeds(profile, defaultControls, 0, bad)).not.toContainEqual(bad);
    });
    it('merges independent related lists, excludes seeds, and avoids loading cached pages twice', async () => {
        const a = seed('one'),
            b = seed('two');
        const load = vi.fn(async () => [candidate('shared'), { ...candidate('one'), sourceRank: 2 }]);
        const discovery = new RelatedDiscovery(load);
        const tracks = await discovery.discover([a, b]);
        expect(tracks).toHaveLength(1);
        expect(tracks[0].relatedTo).toEqual([a.id, b.id]);
        expect(tracks[0].sourceQuery).toBeUndefined();
        await discovery.discover([a, b]);
        expect(load).toHaveBeenCalledTimes(2);
    });
    it('does not let one broken seed or a temporary empty page poison the discovery session', async () => {
        let time = 1000;
        const load = vi
            .fn()
            .mockRejectedValueOnce(Error('unavailable'))
            .mockResolvedValueOnce([candidate('result')])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([candidate('later')]);
        const discovery = new RelatedDiscovery(load, () => time);
        expect(await discovery.discover([seed('broken'), seed('ok')])).toHaveLength(1);
        expect(await discovery.discover([seed('empty')])).toHaveLength(0);
        time += 16000;
        expect(await discovery.discover([seed('empty')])).toHaveLength(1);
    });
    it('stopping discovery discards late responses and does not navigate to the remaining seeds', async () => {
        let active = true,
            resolve!: (value: WaveCandidate[]) => void;
        const load = vi.fn(
            () =>
                new Promise<WaveCandidate[]>((done) => {
                    resolve = done;
                }),
        );
        const discovery = new RelatedDiscovery(load);
        const task = discovery.discover([seed('one'), seed('two')], () => active);
        active = false;
        resolve([candidate('late')]);
        expect(await task).toEqual([]);
        expect(load).toHaveBeenCalledTimes(1);
    });
});
