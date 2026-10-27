import { describe, it, expect, vi } from 'vitest';
import { writePartialPlaylist } from './partialPlaylist';
describe('partial playlist writes', () => {
    it('tries another first track and keeps later successes despite individual failures', async () => {
        const create = vi.fn(async (n: number): Promise<'added'> => {
            if (n === 1) throw Error('Track disappeared');
            return 'added';
        });
        const add = vi.fn(async (n: number): Promise<'added' | 'already'> => {
            if (n === 3) throw Error('Unavailable');
            return n === 4 ? 'already' : 'added';
        });
        const progress = vi.fn();
        const result = await writePartialPlaylist([1, 2, 3, 4, 5], { title: String, create, add, progress });
        expect(create.mock.calls.map((args) => args[0])).toEqual([1, 2]);
        expect(add.mock.calls.map((args) => args[0])).toEqual([3, 4, 5]);
        expect(result.successful).toEqual([2, 4, 5]);
        expect(result.added).toBe(2);
        expect(result.already).toBe(1);
        expect(result.failures.map((item) => item.title)).toEqual(['1', '3']);
        expect(progress).toHaveBeenCalledTimes(5);
    });
    it('returns failures without claiming any playlist was saved when all writes fail', async () => {
        const create = vi.fn(async () => {
                throw Error('Not signed in');
            }),
            add = vi.fn();
        const result = await writePartialPlaylist([1, 2], { title: String, create, add, progress: () => {} });
        expect(result.successful).toEqual([]);
        expect(result.failures).toHaveLength(2);
        expect(result.added).toBe(0);
        expect(add).not.toHaveBeenCalled();
    });
    it('keeps saved tracks when a global write limit stops the remaining operations', async () => {
        const add = vi.fn(async () => {
            throw Error('rate limited');
        });
        const result = await writePartialPlaylist([1, 2, 3, 4], {
            title: String,
            create: async () => 'added' as const,
            add,
            progress: () => {},
            stopOnError: () => true,
        });
        expect(result.successful).toEqual([1]);
        expect(add).toHaveBeenCalledTimes(1);
        expect(result.failures).toHaveLength(3);
    });
});
