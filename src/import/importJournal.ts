import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/asyncDataStore';
import type { ImportMatch } from './match';
import type { SourcePlaylist, SourceTrack } from './source';

export interface ImportJob {
    id: string;
    source: SourcePlaylist;
    matches: ImportMatch[];
    updatedAt: number;
    selected?: number[];
    title?: string;
    savedUrls?: string[];
    writtenTitle?: string;
}
const trackKey = (track: SourceTrack) =>
    createHash('sha256')
        .update(
            JSON.stringify([
                track.artist.normalize('NFKC').toLowerCase().trim(),
                track.title.normalize('NFKC').toLowerCase().trim(),
                Number.isFinite(track.durationSeconds) && track.durationSeconds! > 0
                    ? Math.round(track.durationSeconds!)
                    : null,
            ]),
        )
        .digest('hex');
export class ImportJournal {
    private key: string;
    private cache: Record<string, { at: number; match: NonNullable<ImportMatch['soundcloud']> }>;
    constructor(
        private store: DataStore,
        accountId: string,
        private now = Date.now,
    ) {
        this.key = `importJobV1_${accountId}`;
        const saved = store.get('importMatchCacheV1');
        this.cache = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as typeof this.cache) : {};
    }
    current(): ImportJob | undefined {
        const job = this.store.get(this.key) as ImportJob | undefined;
        if (
            !job?.id ||
            !Array.isArray(job.source?.tracks) ||
            !Array.isArray(job.matches) ||
            job.source.tracks.length > 500 ||
            job.matches.length !== job.source.tracks.length ||
            !Number.isFinite(job.updatedAt)
        )
            return;
        if (this.now() - job.updatedAt < 30 * 86400000) return job;
        return undefined;
    }
    begin(source: SourcePlaylist): ImportJob {
        const id = createHash('sha256')
            .update(JSON.stringify([source.platform, source.title, source.tracks]))
            .digest('hex');
        const previous = this.current();
        const job =
            previous?.id === id
                ? previous
                : {
                      id,
                      source,
                      updatedAt: this.now(),
                      matches: source.tracks.map((track) => ({ source: track, error: 'Проверка ещё не завершена.' })),
                  };
        this.save(job);
        return job;
    }
    save(job: ImportJob): void {
        job.updatedAt = this.now();
        this.store.set(this.key, job);
    }
    cached(track: SourceTrack): ImportMatch['soundcloud'] {
        const cached = this.cache[trackKey(track)];
        return cached && this.now() - cached.at < 7 * 86400000 ? cached.match : undefined;
    }
    remember(match: ImportMatch): void {
        if (!match.soundcloud) return;
        this.cache[trackKey(match.source)] = { at: this.now(), match: match.soundcloud };
        const entries = Object.entries(this.cache)
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, 2000);
        this.cache = Object.fromEntries(entries);
        this.store.set('importMatchCacheV1', this.cache);
    }
}
