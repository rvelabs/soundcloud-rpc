import { describe, expect, it } from 'vitest';
import { catalogSimilarity, CatalogSimilarityCache } from './similarity';
import { recommend } from './ranker';
import { defaultControls } from './types';
import type { Track } from './types';
import { RecommendationSession } from './session';
const track = (id: string, tags: string[]): Track => ({ id, title: id, artist: id, tags });
describe('catalog tag relevance', () => {
    it('reuses corpus statistics across metadata clones and detects changed tags and corpus size', () => {
        const cache = new CatalogSimilarityCache();
        const corpus = [track('one', ['ambient', 'chill']), track('two', ['ambient']), track('three', ['rock'])];
        const first = cache.get(corpus)(corpus[0], corpus[1]);
        const cloned = corpus.map((item) => ({ ...item, tags: [...item.tags!] }));
        expect(cache.get(cloned)(cloned[0], cloned[1])).toBe(first);
        expect(cache.diagnostics()).toMatchObject({ builds: 1, hits: 1 });
        cloned[0].tags.push('jazz');
        expect(cache.get(cloned)(cloned[0], cloned[1])).toBe(catalogSimilarity(cloned)(cloned[0], cloned[1]));
        expect(cache.get([...cloned, track('four', ['jazz'])])(cloned[0], cloned[1])).toBe(
            catalogSimilarity([...cloned, track('four', ['jazz'])])(cloned[0], cloned[1]),
        );
        expect(cache.diagnostics()).toMatchObject({ builds: 3 });
        for (let i = 0; i < 20; i++) cache.get([track('new-' + i, ['jazz'])]);
        expect(cache.diagnostics()).toMatchObject({ entries: 4 });
        cache.clear();
        expect(cache.diagnostics()).toMatchObject({ entries: 0 });
    });
    it('preserves complete ranking results through settings and feedback changes', () => {
        const now = Date.now();
        const corpus = Array.from({ length: 60 }, (_, i) => ({
            ...track('id-' + i, [i % 2 ? 'ambient' : 'techno', i % 3 ? 'chill' : 'bright']),
            features: { bpm: 80 + i * 2, bpmConfidence: 0.8 },
        }));
        const events = [{ track: corpus[0], kind: 'like' as const, at: now - 100000 }];
        const cache = new CatalogSimilarityCache();
        for (const tone of ['any', 'bass', 'bright', 'balanced'] as const) {
            const controls = { ...defaultControls, tone };
            const context = { now, similarityCorpus: corpus, seed: 4 };
            expect(recommend(corpus, events, controls, context, 10, undefined, (items) => cache.get(items))).toEqual(
                recommend(corpus, events, controls, context, 10),
            );
        }
        events.push({ track: corpus[1], kind: 'like', at: now });
        corpus[2].tags!.push('jazz');
        expect(
            recommend(corpus, events, defaultControls, { now, seed: 2 }, 10, undefined, (items) => cache.get(items)),
        ).toEqual(recommend(corpus, events, defaultControls, { now, seed: 2 }, 10));
    });
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
