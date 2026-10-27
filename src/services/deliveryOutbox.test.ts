import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryOutbox } from './deliveryOutbox';
afterEach(() => vi.useRealTimers());
const memory = () => {
    const values = new Map<string, unknown>();
    return {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
    };
};
describe('bounded delivery outbox', () => {
    it('persists a retry with the same event identity and resumes it after restart', async () => {
        vi.useFakeTimers();
        const store = memory();
        const delivery = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('sent');
        const first = new DeliveryOutbox(store, 'jobs', delivery, () => true);
        first.enqueue('event-1', { title: 'A', timestamp: 123 });
        first.enqueue('event-1', { title: 'A', timestamp: 123 });
        await vi.advanceTimersByTimeAsync(1);
        expect(delivery).toHaveBeenCalledTimes(1);
        first.stop();
        const second = new DeliveryOutbox(store, 'jobs', delivery, () => true);
        await vi.advanceTimersByTimeAsync(10001);
        expect(delivery).toHaveBeenCalledTimes(2);
        expect(delivery.mock.calls[1][0]).toEqual({ title: 'A', timestamp: 123 });
        expect(store.get('jobs')).toEqual([]);
        second.stop();
    });
    it('does not restart after disposal or record a late request as delivered', async () => {
        vi.useFakeTimers();
        const store = memory();
        let finish!: (value: 'sent') => void;
        const deliver = vi.fn(
            () =>
                new Promise<'sent'>((resolve) => {
                    finish = resolve;
                }),
        );
        const queue = new DeliveryOutbox(store, 'jobs', deliver, () => true);
        queue.enqueue('one', { title: 'One' });
        queue.stop();
        finish('sent');
        await vi.advanceTimersByTimeAsync(20000);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect((store.get('jobs') as unknown[]).length).toBe(1);
    });
    it('caps retained jobs when disabled and does not retry permanent failures', async () => {
        vi.useFakeTimers();
        const store = memory();
        let enabled = false;
        const deliver = vi.fn(async () => 'drop' as const);
        const queue = new DeliveryOutbox(store, 'jobs', deliver, () => enabled);
        for (let index = 0; index < 150; index++) queue.enqueue(String(index), { index });
        expect((store.get('jobs') as unknown[]).length).toBe(100);
        enabled = true;
        queue.start();
        await vi.advanceTimersByTimeAsync(1000);
        expect(deliver).toHaveBeenCalledTimes(100);
        expect(store.get('jobs')).toEqual([]);
        queue.stop();
    });
});
