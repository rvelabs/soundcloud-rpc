import { describe, expect, it } from 'vitest';
import { catalogSimilarity } from './similarity';
import type { Track } from './types';
import { RecommendationSession } from './session';
const track = (id: string, tags: string[]): Track => ({ id, title: id, artist: id, tags });
describe('catalog tag relevance', () => {
    it('prioritizes distinctive shared style over ubiquitous promotional tags', () => {
        const seed = track('seed', ['electronic', 'underground', 'newrelease', 'breakcore']);
        const niche = track('niche', ['breakcore']);
        const generic = track('generic', ['electronic', 'underground', 'newrelease']);
        const corpus = Array.from({ length: 80 }, (_, index) => track('other-' + index, generic.tags!));
        const compare = catalogSimilarity([seed, niche, generic, ...corpus]);
        expect(compare(seed, niche)).toBeGreaterThan(compare(seed, generic));
        expect(compare(seed, seed)).toBeCloseTo(1);
        expect(compare(seed, track('empty', []))).toBe(0);
        const now = Date.now();
        const session = new RecommendationSession({ related: async () => [] }, () => now);
        session.setControls({ mood: 'any', tone: 'any', tempo: 'any', discovery: 'balanced' });
        session.loadFeedback([{ track: seed, kind: 'like', at: now - 86400000 }]);
        session.addCandidates([niche, generic, ...corpus]);
        expect(session.rankBuffered([niche, generic], 1)[0].track.id).toBe('niche');
    });
});
