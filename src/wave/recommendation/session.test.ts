import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ranker from './ranker';
import { RecommendationSession } from './session';
import type { Track } from './types';
afterEach(() => vi.restoreAllMocks());
const track = (id: string): Track => ({ id, artist: id, title: id, genre: 'ambient' });
describe('recommendation session caching and sequential balance', () => {
    it('caches stable ranks but invalidates feedback, reservations, controls and time', () => {
        let now = 1000000;
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.addCandidates([track('one'), track('two')]);
        const recommend = vi.spyOn(ranker, 'recommend');
        const first = session.rank(2);
        first.pop();
        expect(session.rank(2)).toHaveLength(2);
        expect(recommend).toHaveBeenCalledTimes(1);
        session.reserve('one');
        expect(session.rank(2).map((item) => item.track.id)).toEqual(['two']);
        session.feedback({ track: track('two'), kind: 'dislike' });
        expect(session.rank(2)).toHaveLength(0);
        session.release('one');
        expect(session.rank(2).map((item) => item.track.id)).toEqual(['one']);
        session.setControls({ mood: 'sad' });
        session.rank(2);
        expect(recommend).toHaveBeenCalledTimes(5);
        now += 60000;
        session.rank(2);
        expect(recommend).toHaveBeenCalledTimes(6);
    });
    it('keeps a two-new-one-known mixture across repeated single-track selections', () => {
        const now = 1000000000;
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        const known = Array.from({ length: 3 }, (_, id) => track('known-' + id));
        session.loadFeedback(known.map((track) => ({ track, kind: 'like', at: now - 7 * 86400000 })));
        session.addCandidates([...known, ...Array.from({ length: 6 }, (_, id) => track('new-' + id))]);
        const selected: boolean[] = [];
        for (let index = 0; index < 9; index++) {
            const next = session.rank(1)[0].track;
            selected.push(next.id.startsWith('known-'));
            session.reserve(next.id);
            session.accept(next.id);
        }
        expect(selected).toEqual([false, false, true, false, false, true, false, false, true]);
    });
});
