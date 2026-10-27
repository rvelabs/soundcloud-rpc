import { describe, expect, it } from 'vitest';
import { TaskPool } from './taskPool';
describe('DOM search page budget', () => {
    it('bounds ten callers to two pages and cancels a waiting job without creating a page', async () => {
        const pool = new TaskPool(() => 2);
        let active = 0,
            maximum = 0;
        const gates: Array<() => void> = [];
        const jobs = Array.from({ length: 10 }, (_, index) =>
            pool.run(async (slot) => {
                expect(slot).toBeLessThan(2);
                active++;
                maximum = Math.max(active, maximum);
                await new Promise<void>((resolve) => gates.push(resolve));
                active--;
                return index;
            }),
        );
        const controller = new AbortController();
        const canceled = pool
            .run(async () => {
                throw new Error('must not start');
            }, controller.signal)
            .catch((error) => error);
        controller.abort();
        expect((await canceled).name).toBe('AbortError');
        for (let index = 0; index < 5; index++) {
            await new Promise((resolve) => setImmediate(resolve));
            for (const resolve of gates.splice(0)) resolve();
        }
        expect(await Promise.all(jobs)).toEqual(Array.from({ length: 10 }, (_, index) => index));
        expect(maximum).toBe(2);
    });
});
