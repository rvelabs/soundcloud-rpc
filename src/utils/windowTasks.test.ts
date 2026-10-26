import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowTasks } from './windowTasks';
afterEach(() => vi.useRealTimers());
describe('window-bound deferred work', () => {
    it('cancels all pending warmups when their window closes', () => {
        vi.useFakeTimers();
        const task = vi.fn();
        const scope = new WindowTasks(() => true);
        scope.defer(task, 400);
        scope.defer(task, 1800);
        scope.dispose();
        vi.advanceTimersByTime(3000);
        expect(task).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('never calls a task whose captured renderer is destroyed', () => {
        vi.useFakeTimers();
        let alive = true;
        const task = vi.fn();
        const scope = new WindowTasks(() => alive);
        scope.defer(task, 400);
        alive = false;
        vi.advanceTimersByTime(500);
        expect(task).not.toHaveBeenCalled();
    });
});
