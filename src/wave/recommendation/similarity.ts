import { tokensOf } from './profile';
import type { Track } from './types';
export function catalogSimilarity(corpus: Track[]): (a: Track, b: Track) => number {
    const sets = new Map<Track, Set<string>>();
    const tokens = (track: Track): Set<string> => {
        let value = sets.get(track);
        if (!value) {
            value = new Set(tokensOf(track));
            sets.set(track, value);
        }
        return value;
    };
    const documents = [...new Map(corpus.map((track) => [track.id, track])).values()];
    const counts = new Map<string, number>();
    for (const track of documents) for (const token of tokens(track)) counts.set(token, (counts.get(token) || 0) + 1);
    const weights = new Map(
        [...counts].map(([token, count]) => [
            token,
            Math.min(2.5, 1 + Math.log((documents.length + 1) / (count + 1))) ** 2,
        ]),
    );
    const weight = (token: string) => weights.get(token) ?? 6.25;
    const norms = new Map<Track, number>();
    const norm = (track: Track) => {
        let value = norms.get(track);
        if (value === undefined) {
            value = Math.sqrt([...tokens(track)].reduce((sum, token) => sum + weight(token), 0));
            norms.set(track, value);
        }
        return value;
    };
    return (a, b) => {
        const left = tokens(a),
            right = tokens(b);
        const denominator = norm(a) * norm(b);
        if (!denominator) return 0;
        let overlap = 0;
        for (const token of left) if (right.has(token)) overlap += weight(token);
        return Math.min(1, overlap / denominator);
    };
}
