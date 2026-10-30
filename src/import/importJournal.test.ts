import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportJournal } from './importJournal';
afterEach(() => vi.useRealTimers());
describe('resumable playlist matching', () => {
    it('batches a 320-track import and flushes partial results on cancel or close', async () => {
        vi.useFakeTimers();
        const values = new Map<string, unknown>();
        const set = vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value)));
        const store = { get: (key: string) => values.get(key), set };
        const journal = new ImportJournal(store, 'one');
        const tracks = Array.from({ length: 320 }, (_, i) => ({ artist: 'A', title: 'Title ' + i }));
        const job = journal.begin({ platform: 'spotify', title: 'Import', tracks, partial: false });
        for (let i = 0; i < tracks.length; i++) {
            const match = {
                source: tracks[i],
                soundcloud: {
                    url: `https://soundcloud.com/a/song-${i}`,
                    title: tracks[i].title,
                    artist: 'A',
                    score: 1,
                    sourceQuery: tracks[i].title,
                },
            };
            job.matches[i] = match;
            journal.remember(match);
            journal.save(job, true);
            expect(journal.cached(tracks[i])?.url).toBe(match.soundcloud.url);
        }
        journal.flush();
        expect(set.mock.calls.length).toBeLessThan(60);
        expect(new ImportJournal(store, 'one').current()?.matches.every((item) => item.soundcloud)).toBe(true);
        job.title = 'Partial selection';
        journal.save(job, true);
        journal.dispose();
        expect(vi.getTimerCount()).toBe(0);
        expect(new ImportJournal(store, 'one').current()?.title).toBe('Partial selection');
    });
    it('saves pending cache results by deadline even without subsequent progress', async () => {
        vi.useFakeTimers();
        const values = new Map<string, unknown>();
        const journal = new ImportJournal(
            { get: (key) => values.get(key), set: (key, value) => values.set(key, structuredClone(value)) },
            'one',
        );
        journal.remember({
            source: { artist: 'A', title: 'One' },
            soundcloud: {
                url: 'https://soundcloud.com/a/one',
                artist: 'A',
                title: 'One',
                score: 1,
                sourceQuery: 'One',
            },
        });
        expect(values.has('importMatchCacheV1')).toBe(false);
        await vi.advanceTimersByTimeAsync(250);
        expect(values.has('importMatchCacheV1')).toBe(true);
        journal.dispose();
    });
    it('does not reuse a cached recording for a different source duration', () => {
        const values = new Map<string, unknown>();
        const journal = new ImportJournal(
            {
                get: (key) => values.get(key),
                set: (key, value) => {
                    values.set(key, value);
                },
            },
            'one',
        );
        const source = { artist: 'Artist', title: 'Title', durationSeconds: 180 };
        const soundcloud = {
            url: 'https://soundcloud.com/artist/title',
            artist: 'Artist',
            title: 'Title',
            score: 1,
            sourceQuery: 'Artist Title',
        };
        journal.remember({ source, soundcloud });
        expect(journal.cached({ ...source, durationSeconds: 180.2 })).toEqual(soundcloud);
        expect(journal.cached({ ...source, durationSeconds: 360 })).toBeUndefined();
        expect(journal.cached({ artist: source.artist, title: source.title })).toBeUndefined();
    });
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
