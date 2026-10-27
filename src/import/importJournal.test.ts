import { describe, expect, it } from 'vitest';
import { ImportJournal } from './importJournal';
describe('resumable playlist matching', () => {
    it('restores partial progress and selections per account without hiding failures', () => {
        const values = new Map<string, unknown>();
        const store = {
            get: (key: string) => values.get(key),
            set: (key: string, value: unknown) => {
                values.set(key, structuredClone(value));
            },
        };
        const journal = new ImportJournal(store, 'one');
        const source = {
            platform: 'spotify' as const,
            title: 'Saved',
            partial: true,
            tracks: [
                { title: 'One', artist: 'A' },
                { title: 'Two', artist: 'B' },
            ],
        };
        const job = journal.begin(source);
        job.matches[0].soundcloud = {
            url: 'https://soundcloud.com/a/one',
            title: 'One',
            artist: 'A',
            score: 1,
            sourceQuery: 'A One',
        };
        delete job.matches[0].error;
        job.selected = [0];
        journal.remember(job.matches[0]);
        journal.save(job);
        const restarted = new ImportJournal(store, 'one');
        expect(restarted.begin(source).id).toBe(job.id);
        expect(restarted.current()?.selected).toEqual([0]);
        expect(restarted.current()?.matches[1].error).toBeTruthy();
        expect(new ImportJournal(store, 'two').current()).toBeUndefined();
        expect(new ImportJournal(store, 'two').cached(source.tracks[0])?.url).toBe(job.matches[0].soundcloud.url);
        expect(
            new ImportJournal(store, 'one', () => Date.now() + 8 * 86400000).cached(source.tracks[0]),
        ).toBeUndefined();
    });
});
