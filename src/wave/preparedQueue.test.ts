import { describe, expect, it } from 'vitest';
import { PreparedQueue } from './preparedQueue';
describe('prepared wave queue', () => {
    it('keeps an awaiting transition attached to the replacement discovery buffer', async () => {
        const queue = new PreparedQueue<{ url: string }>();
        let finish!: (items: { url: string }[]) => void;
        const old = queue.prepare(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const waiting = queue.take();
        queue.clear(true);
        const fresh = queue.prepare(async () => [{ url: 'replacement' }]);
        finish([{ url: 'stale' }]);
        await Promise.all([old, fresh]);
        expect((await waiting)?.url).toBe('replacement');
        expect(queue.length).toBe(0);
    });
    it('cancels awaiting transitions on an explicit reset even if a new producer publishes', async () => {
        const queue = new PreparedQueue<{ url: string }>();
        let finish!: (items: { url: string }[]) => void;
        const old = queue.prepare(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const waiting = queue.take();
        queue.clear();
        await queue.prepare(async () => [{ url: 'new-settings' }]);
        finish([{ url: 'old-settings' }]);
        await old;
        expect(await waiting).toBeUndefined();
        expect((await queue.take())?.url).toBe('new-settings');
    });
    it('returns unchosen alternatives for the next selection without duplicating or cycling the committed buffer', async () => {
        const queue = new PreparedQueue<{ url: string }>();
        await queue.prepare(async () => [{ url: 'first' }, { url: 'second' }, { url: 'third' }]);
        const first = await queue.take(),
            second = await queue.take();
        queue.putBack([second!, second!]);
        expect((await queue.take())?.url).toBe('second');
        expect((await queue.take())?.url).toBe('third');
        expect(await queue.take()).toBeUndefined();
        expect(first?.url).toBe('first');
    });
    it('publishes a ready track before a slower refill completes and caps repeated batches', async () => {
        const queue = new PreparedQueue<{ url: string }>();
        let publish!: (items: { url: string }[]) => void;
        let finish!: (items: { url: string }[]) => void;
        const filling = queue.prepare((send) => {
            publish = send;
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        const waiting = queue.take();
        publish([{ url: 'ready' }]);
        expect((await waiting)?.url).toBe('ready');
        publish([{ url: 'two' }, { url: 'three' }, { url: 'four' }]);
        publish([{ url: 'five' }]);
        expect(queue.length).toBe(3);
        finish([{ url: 'ready' }, { url: 'five' }]);
        await filling;
        expect(queue.length).toBe(3);
    });
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
