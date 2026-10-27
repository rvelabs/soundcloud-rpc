import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { AsyncDataStore } from './asyncDataStore';

const directories: string[] = [];
const stores: AsyncDataStore[] = [];
const protection = {
    available: () => false,
    encrypt: (value: string) => Buffer.from(value),
    decrypt: (value: Buffer) => value.toString(),
};
let worker: string;
beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sc-writer-'));
    directories.push(directory);
    worker = join(directory, 'worker.cjs');
    const source = await readFile(join(process.cwd(), 'src/storage/snapshotWorker.ts'), 'utf8');
    await writeFile(
        worker,
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
        }).outputText,
    );
});
afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
});
const legacy = () => ({
    store: {} as Record<string, unknown>,
    get(key: string, fallback?: unknown) {
        return this.store[key] ?? fallback;
    },
    set(key: string, value: unknown) {
        this.store[key] = value;
    },
});
async function open(directory?: string, fallback = legacy()) {
    directory ??= await mkdtemp(join(tmpdir(), 'sc-library-'));
    directories.push(directory);
    const store = await AsyncDataStore.open(directory, fallback, protection, worker);
    stores.push(store);
    return { store, directory, fallback };
}
describe('asynchronous library persistence', () => {
    it('checkpoints continuous updates instead of postponing every save until the stream stops', async () => {
        const { store } = await open();
        vi.useFakeTimers();
        const flush = vi.spyOn(store, 'flush').mockResolvedValue();
        try {
            for (let index = 0; index < 20; index++) {
                store.set('progress', index);
                await vi.advanceTimersByTimeAsync(100);
            }
            expect(flush).toHaveBeenCalledTimes(2);
        } finally {
            flush.mockRestore();
            vi.useRealTimers();
        }
        await store.flush();
    });
    it('migrates history durably before deleting legacy keys and leaves settings small', async () => {
        const fallback = legacy();
        fallback.store = { theme: 'dark', waveHistory_default: [{ title: 'Old song' }] };
        const { store, directory } = await open(undefined, fallback);
        await store.migrate(fallback);
        expect(fallback.store).toEqual({ theme: 'dark' });
        await store.close();
        const reopened = await open(directory, fallback);
        expect(reopened.store.get('waveHistory_default')).toEqual([{ title: 'Old song' }]);
        expect(reopened.store.get('theme')).toBe('dark');
        expect((await readFile(join(directory, 'library.data'))).includes(Buffer.from('Old song'))).toBe(false);
    });
    it('flushes the last update made during a pending write and isolates accounts', async () => {
        const { store, directory } = await open();
        store.set(
            'waveFeedbackV1_one',
            Array.from({ length: 5000 }, (_, id) => ({ id, at: id })),
        );
        const pending = store.flush();
        store.set('waveFeedbackV1_two', ['latest']);
        await pending;
        await store.close();
        const reopened = await open(directory);
        expect(reopened.store.get('waveFeedbackV1_two')).toEqual(['latest']);
        expect((reopened.store.get('waveFeedbackV1_one') as unknown[]).length).toBe(5000);
    });
    it('refuses corrupted snapshots without overwriting them or deleting old history', async () => {
        const { store, directory } = await open();
        await store.close();
        await writeFile(join(directory, 'library.data'), 'broken data');
        const fallback = legacy();
        fallback.store.waveHistory_default = ['original'];
        await expect(AsyncDataStore.open(directory, fallback, protection, worker)).rejects.toThrow();
        expect(fallback.store.waveHistory_default).toEqual(['original']);
        expect(await readFile(join(directory, 'library.data'), 'utf8')).toBe('broken data');
    });
});
afterEach(async () => {
    for (const directory of [...new Set(directories)].filter((value) => value !== join(worker, '..')))
        await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
    await rm(join(worker, '..'), { recursive: true, force: true });
});
