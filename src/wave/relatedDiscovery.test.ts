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
    it('keeps an unskipped favorite as a discovery source when repeated skips suppress its whole style', () => {
        const favorite = { ...seed('favorite'), genre: 'ambient' };
        const skipped = [0, 1, 2, 3].map((i) => ({ ...seed('skip' + i), genre: 'ambient' }));
        const events = [
            { track: favorite, kind: 'like' as const, at: 0, origin: 'library' as const },
            ...skipped.map((track, i) => ({ track, kind: 'skip' as const, at: 100 + i, listenedFraction: 0.01 })),
        ];
        const profile = buildProfile(events, 1000);
        const selected = discoverySeeds(profile, defaultControls, 0, skipped[3], {
            now: 1000,
            sessionReactions: events.filter((event) => event.kind === 'skip'),
            preferenceSignals: new Map([['ambient', -2]]),
        });
        expect(selected.map((track) => track.id)).toEqual([favorite.id]);
    });
    it('prefers an independent direction and never revives a disliked or mood-conflicting source', () => {
        const suppressed = { ...seed('suppressed'), genre: 'ambient' };
        const independent = { ...seed('independent'), genre: 'jungle' };
        const events = [suppressed, independent].map((track) => ({ track, kind: 'like' as const, at: 0 }));
        const context = { now: 1000, preferenceSignals: new Map([['ambient', -2]]) };
        const profile = buildProfile(events, 1000);
        expect(discoverySeeds(profile, defaultControls, 0, suppressed, context).map((track) => track.id)).toEqual([
            independent.id,
        ]);
        profile.dislikedIds.add(independent.id);
        profile.dislikedIds.add(suppressed.id);
        expect(discoverySeeds(profile, defaultControls, 0, suppressed, context)).toEqual([]);
        const sad = { ...seed('sad'), tags: ['sad'] };
        expect(
            discoverySeeds(
                buildProfile([{ track: sad, kind: 'like', at: 0 }], 1000),
                { ...defaultControls, mood: 'happy' },
                0,
                sad,
                context,
            ),
        ).toEqual([]);
    });
    it('uses the fallback source to discover unheard music instead of replaying the favorite', async () => {
        const favorite = { ...seed('favorite'), genre: 'ambient' };
        const fresh = { ...seed('fresh'), genre: 'ambient', source: 'related' as const, relatedTo: [favorite.id] };
        const related = vi.fn(async (sources: Track[]) => (sources.length ? [fresh] : []));
        const session = new RecommendationSession({ related }, () => 1000);
        session.setControls({ discovery: 'new' });
        session.feedback({ track: favorite, kind: 'like', at: 0, origin: 'library' });
        for (let i = 0; i < 4; i++)
            session.feedback({
                track: { ...seed('skip' + i), genre: 'ambient' },
                kind: 'skip',
                at: 100 + i,
                listenedFraction: 0.01,
            });
        expect((await session.refresh()).map((item) => item.track.id)).toEqual([fresh.id]);
        expect(related).toHaveBeenCalledWith([expect.objectContaining(favorite)]);
    });
    it('rotates recordings within one artist instead of exhausting the same related page forever', () => {
        const profile = buildProfile(
            [0, 1, 2].map((i) => ({ track: seed('song' + i, 'same artist'), kind: 'like' as const, at: i })),
            1000,
        );
        const picked = [0, 1, 2].map((rotation) => discoverySeeds(profile, defaultControls, rotation)[0].id);
        expect(new Set(picked).size).toBe(3);
    });
    it('backs off a failing source before retrying instead of hammering it on every refill', async () => {
        let time = 0;
        const load = vi.fn(async () => {
            throw Error('offline');
        });
        const discovery = new RelatedDiscovery(load, () => time);
        await discovery.discover([seed('one')]);
        await discovery.discover([seed('one')]);
        expect(load).toHaveBeenCalledTimes(1);
        time = 16000;
        await discovery.discover([seed('one')]);
        expect(load).toHaveBeenCalledTimes(2);
    });
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
