export const DEFAULT_IMPORT_CONCURRENCY = 6;
export function importConcurrency(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(2, Math.min(10, Math.trunc(value)))
        : DEFAULT_IMPORT_CONCURRENCY;
}
export function automaticImportConcurrency(cores: number, freeBytes: number, tracks: number): number {
    const cpuBudget = Math.max(2, Math.floor(Math.max(1, cores) * 1.5));
    const memoryBudget = Math.max(2, Math.floor((freeBytes / 1024 ** 3 - 0.75) / 0.18));
    return Math.min(Math.max(1, tracks), importConcurrency(Math.min(cpuBudget, memoryBudget)));
}
export function cancelImportOperation<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        task.then(
            (value) => {
                signal.removeEventListener('abort', abort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            },
        );
    });
}
export async function mapImportTracks<T, R>(
    items: readonly T[],
    options: {
        concurrency: number;
        signal?: AbortSignal;
        run: (item: T, index: number, slot: number) => Promise<R>;
        onComplete?: (result: R, index: number, completed: number) => void;
    },
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0,
        completed = 0,
        stopped = false;
    const worker = async (slot: number) => {
        try {
            while (!stopped) {
                options.signal?.throwIfAborted();
                const index = next++;
                if (index >= items.length) return;
                const result = await options.run(items[index], index, slot);
                options.signal?.throwIfAborted();
                if (stopped) return;
                results[index] = result;
                options.onComplete?.(result, index, ++completed);
            }
        } catch (error) {
            stopped = true;
            throw error;
        }
    };
    const outcomes = await Promise.allSettled(
        Array.from(
            {
                length: Math.min(items.length, importConcurrency(options.concurrency)),
            },
            (_, slot) => worker(slot),
        ),
    );
    options.signal?.throwIfAborted();
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    return results;
}
