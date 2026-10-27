import { describe, it, expect, vi } from 'vitest';
import { saveImportSelection } from './saveSelection';
import type { ImportMatch } from './match';
const match = (title: string, age = 0): ImportMatch => ({
    source: { title, artist: 'Artist' },
    soundcloud: {
        url: 'https://soundcloud.com/artist/' + title,
        title,
        artist: 'Artist',
        score: 1,
        sourceQuery: title,
        availability: { status: 'available', reason: 'checked', checkedAt: Date.now() - age },
    },
});
const state = (status: 'available' | 'unknown' | 'blocked') => ({ status, reason: status, checkedAt: Date.now() });
describe('saving a found subset', () => {
    it('creates from any successful match even when most sources have no match, writes fail, or a track is blocked', async () => {
        const create = vi.fn(async (item: ImportMatch): Promise<'added'> => {
                if (item.source.title === 'gone') throw Error('Gone');
                return 'added';
            }),
            add = vi.fn(async (): Promise<'added'> => 'added');
        const result = await saveImportSelection(
            [
                { source: { title: 'missing', artist: 'Artist' } },
                match('gone'),
                match('good'),
                match('blocked'),
                match('last'),
            ],
            {
                check: async (url) => state(url.endsWith('blocked') ? 'blocked' : 'available'),
                create,
                add,
                concurrency: 3,
                progress: () => {},
            },
        );
        expect(result.successful.map((item) => item.source.title)).toEqual(['good', 'last']);
        expect(result.added).toBe(2);
        expect(create.mock.calls.map((args) => args[0].source.title)).toEqual(['gone', 'good']);
        expect(result.failures).toHaveLength(2);
    });
    it('retains a recent successful scan if a recheck times out, while honoring explicit blocks', async () => {
        const create = vi.fn(async (): Promise<'added'> => 'added');
        const result = await saveImportSelection([match('fresh'), match('old', 600000), match('blocked')], {
            check: async (url) => state(url.endsWith('blocked') ? 'blocked' : 'unknown'),
            create,
            add: create,
            concurrency: 2,
            progress: () => {},
        });
        expect(result.successful.map((item) => item.source.title)).toEqual(['fresh']);
        expect(create).toHaveBeenCalledTimes(1);
    });
    it('does not report a saved playlist if no candidate was ever confirmed or cancellation occurs', async () => {
        const create = vi.fn(async (): Promise<'added'> => 'added'),
            item = match('old', 600000),
            controller = new AbortController();
        const options = {
            check: async () => state('unknown'),
            create,
            add: create,
            concurrency: 2,
            progress: () => {},
        };
        await expect(saveImportSelection([item], options)).rejects.toThrow('подтвердил');
        expect(create).not.toHaveBeenCalled();
        controller.abort();
        await expect(
            saveImportSelection([match('fresh')], { ...options, signal: controller.signal }),
        ).rejects.toThrow();
        expect(create).not.toHaveBeenCalled();
    });
});
