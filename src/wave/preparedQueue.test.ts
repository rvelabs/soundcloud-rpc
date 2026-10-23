import { describe, expect, it } from 'vitest';
import { PreparedQueue } from './preparedQueue';
describe('prepared wave queue', () => {
    it('hands off a prepared track without waiting for another search', async () => {
        const queue = new PreparedQueue<{
            url: string;
        }>();
        await queue.prepare(async () => [{ url: 'second' }, { url: 'third' }]);
        let searched = false;
        const first = await queue.take();
        void queue.prepare(async () => {
            searched = true;
            return [{ url: 'fourth' }];
        });
        const second = await queue.take();
        expect([first?.url, second?.url]).toEqual(['second', 'third']);
        expect(searched).toBe(true);
    });
    it('drops results from a canceled search after controls change', async () => {
        const queue = new PreparedQueue<{
            url: string;
        }>();
        let finish!: (
            items: {
                url: string;
            }[],
        ) => void;
        const pending = queue.prepare(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        queue.clear();
        finish([{ url: 'old-setting' }]);
        await pending;
        expect(await queue.take()).toBeUndefined();
        await queue.prepare(async () => [{ url: 'new-setting' }]);
        expect((await queue.take())?.url).toBe('new-setting');
    });
});
