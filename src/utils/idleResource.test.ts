import { describe, expect, it, vi, afterEach } from 'vitest';
import { IdleResource } from './idleResource';
afterEach(() => vi.useRealTimers());
describe('exclusive idle resource', () => {
    it('reuses a page through short bursts and releases it when memory retention is disabled', async () => {
        vi.useFakeTimers();
        const create = vi.fn(() => ({})),
            destroy = vi.fn(),
            clear = vi.fn(async () => {});
        let pressure = false;
        const resource = new IdleResource(create, destroy, () => (pressure ? 0 : 120000), clear, 1500);
        await resource.use(async () => {});
        await vi.advanceTimersByTimeAsync(1000);
        await resource.use(async () => {});
        expect(create).toHaveBeenCalledTimes(1);
        expect(clear).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1500);
        expect(clear).toHaveBeenCalledTimes(1);
        pressure = true;
        await resource.use(async () => {});
        expect(destroy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(destroy).toHaveBeenCalledTimes(2);
        resource.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('serializes navigation and quiesces only after all consumers finish', async () => {
        const calls: string[] = [];
        let release!: () => void;
        const resource = new IdleResource(
            () => ({}),
            () => {},
            30000,
            async () => {
                calls.push('idle');
            },
        );
        const first = resource.use(async () => {
            calls.push('first');
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        });
        const second = resource.use(async () => {
            calls.push('second');
        });
        await Promise.resolve();
        expect(calls).toEqual(['first']);
        release();
        await Promise.all([first, second]);
        await resource.use(async () => {
            calls.push('third');
        });
        expect(calls.indexOf('second')).toBeGreaterThan(calls.indexOf('first'));
        expect(calls.indexOf('third')).toBeGreaterThan(calls.indexOf('second'));
        resource.dispose();
    });
    it('preserves exclusivity while a page is being cleared and cancels queued use on dispose', async () => {
        let clear!: () => void;
        const destroy = vi.fn();
        const resource = new IdleResource(
            () => ({}),
            destroy,
            30000,
            () =>
                new Promise((resolve) => {
                    clear = resolve;
                }),
        );
        await resource.use(async () => {});
        await Promise.resolve();
        const run = vi.fn(async () => {});
        const next = resource.use(run);
        await Promise.resolve();
        expect(run).not.toHaveBeenCalled();
        resource.dispose();
        clear();
        await expect(next).rejects.toThrow('disposed');
        expect(destroy).toHaveBeenCalledTimes(1);
    });
    it('releases after inactivity and survives task failure', async () => {
        vi.useFakeTimers();
        const destroy = vi.fn(),
            create = vi.fn(() => ({}));
        const resource = new IdleResource(create, destroy, 100);
        await expect(
            resource.use(async () => {
                throw Error('offline');
            }),
        ).rejects.toThrow('offline');
        await resource.use(async () => 1);
        expect(create).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(destroy).toHaveBeenCalledTimes(1);
        await resource.use(async () => 2);
        expect(create).toHaveBeenCalledTimes(2);
        resource.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });
});
