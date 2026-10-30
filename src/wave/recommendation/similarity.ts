import { tokensOf } from './profile';
import type { Track } from './types';
export type Similarity = (a: Track, b: Track) => number;
const documentsOf = (corpus: Track[]) =>
    [...new Map(corpus.map((track) => [track.id, track])).values()].map(
        (track) => [track.id, tokensOf(track)] as const,
    );
function createSimilarity(documents: ReturnType<typeof documentsOf>): () => Similarity {
    const counts = new Map<string, number>();
    for (const [, tokens] of documents) for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    const weights = new Map(
        [...counts].map(([token, count]) => [
            token,
            Math.min(2.5, 1 + Math.log((documents.length + 1) / (count + 1))) ** 2,
        ]),
    );
    const weight = (token: string) => weights.get(token) ?? 6.25;
    const vectors = new Map<string, { tokens: Set<string>; norm: number }>();
    return () => {
        const pass = new WeakMap<Track, { tokens: Set<string>; norm: number }>();
        const vector = (track: Track) => {
            const memo = pass.get(track);
            if (memo) return memo;
            const tokens = tokensOf(track);
            const key = JSON.stringify(tokens);
            let value = vectors.get(key);
            if (!value) {
                value = {
                    tokens: new Set(tokens),
                    norm: Math.sqrt(tokens.reduce((sum, token) => sum + weight(token), 0)),
                };
                vectors.set(key, value);
                if (vectors.size > 1024) vectors.delete(vectors.keys().next().value!);
            }
            pass.set(track, value);
            return value;
        };
        return (a, b) => {
            const left = vector(a),
                right = vector(b);
            const denominator = left.norm * right.norm;
            if (!denominator) return 0;
            let overlap = 0;
            for (const token of left.tokens) if (right.tokens.has(token)) overlap += weight(token);
            return Math.min(1, overlap / denominator);
        };
    };
}
export const catalogSimilarity = (corpus: Track[]): Similarity => createSimilarity(documentsOf(corpus))();
export class CatalogSimilarityCache {
    private entries = new Map<string, () => Similarity>();
    private builds = 0;
    private hits = 0;
    get(corpus: Track[], revision?: string): Similarity {
        let documents: ReturnType<typeof documentsOf> | undefined;
        const key = revision === undefined ? JSON.stringify((documents = documentsOf(corpus))) : 'revision:' + revision;
        const cached = this.entries.get(key);
        if (cached) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            this.hits++;
            return cached();
        }
        this.builds++;
        documents ??= documentsOf(corpus);
        const compare = createSimilarity(documents);
        if (documents.length <= 2048 && JSON.stringify(documents).length <= 256000) {
            this.entries.set(key, compare);
            if (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
        }
        return compare();
    }
    clear(): void {
        this.entries.clear();
    }
    diagnostics(): object {
        return { entries: this.entries.size, builds: this.builds, hits: this.hits };
    }
}
