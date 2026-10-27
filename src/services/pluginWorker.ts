import { parentPort, workerData } from 'node:worker_threads';
import { Script, createContext } from 'node:vm';
const timers = new Set<ReturnType<typeof setTimeout>>();
const moduleValue = { exports: {} };
const context = createContext(
    {
        module: moduleValue,
        exports: moduleValue.exports,
        console: { log: () => {}, warn: () => {}, error: () => {} },
    },
    { microtaskMode: 'afterEvaluate' },
);
const execute = (code: string, timeout = 100) => new Script(code).runInContext(context, { timeout });
const invokeTimer = (callback: unknown, args: unknown[]) => {
    try {
        context.__callback = callback;
        context.__timerArgs = args;
        execute('__callback(...__timerArgs)');
    } catch (error) {
        parentPort!.postMessage({ fatal: error instanceof Error ? error.message : String(error) });
    } finally {
        delete context.__callback;
        delete context.__timerArgs;
    }
};
context.setTimeout = (callback: unknown, delay = 0, ...args: unknown[]) => {
    if (timers.size >= 64 || typeof callback !== 'function') throw new Error('Plugin timer limit exceeded');
    const timer = setTimeout(
        () => {
            timers.delete(timer);
            invokeTimer(callback, args);
        },
        Math.max(0, Math.min(3600000, Number(delay) || 0)),
    );
    timers.add(timer);
    return timer;
};
context.setInterval = (callback: unknown, delay = 0, ...args: unknown[]) => {
    if (timers.size >= 64 || typeof callback !== 'function') throw new Error('Plugin timer limit exceeded');
    const timer = setInterval(() => invokeTimer(callback, args), Math.max(25, Math.min(3600000, Number(delay) || 0)));
    timers.add(timer);
    return timer;
};
context.clearTimeout = context.clearInterval = (timer: ReturnType<typeof setTimeout>) => {
    clearTimeout(timer);
    timers.delete(timer);
};
let initialized = false;
parentPort!.on('message', ({ id, method, value }: { id: number; method: string; value: unknown }) => {
    try {
        if (!initialized) {
            new Script(workerData.source, { filename: workerData.filename }).runInContext(context, { timeout: 1000 });
            execute('globalThis.__plugin = module.exports');
            initialized = true;
        }
        context.__method = method;
        context.__value = value;
        const result = execute('typeof __plugin[__method] === "function" ? __plugin[__method](__value) : undefined');
        if (
            method === 'contentScript' &&
            result !== undefined &&
            (typeof result !== 'string' || result.length > 256000)
        )
            throw new Error('Invalid plugin content script');
        parentPort!.postMessage({ id, value: method === 'contentScript' ? result : undefined });
    } catch (error) {
        parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    } finally {
        delete context.__method;
        delete context.__value;
    }
});
