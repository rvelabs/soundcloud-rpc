import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export interface DataStore {
    get(key: string, fallback?: unknown): unknown;
    set(key: string, value: unknown): void;
}
export class AsyncDataStore implements DataStore {
    private values: Record<string, unknown> = {};
    private revision = 0;
    private savedRevision = 0;
    private dirty = new Map<string, number>();
    private nextId = 0;
    private pending = new Map<
        number,
        { resolve: (values?: Record<string, unknown>) => void; reject: (error: Error) => void }
    >();
    private timer?: ReturnType<typeof setTimeout>;
    private task?: Promise<void>;
    private failure?: Error;
    private closed = false;
    private constructor(
        private worker: Worker,
        private fallback: DataStore,
    ) {
        worker.on('message', (message) => {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (!this.pending.size) this.worker.unref();
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.values);
        });
        const failed = (error: Error) => {
            this.failure = error;
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
        };
        worker.on('error', failed);
        worker.on('exit', () => {
            if (!this.closed) failed(new Error('Data writer stopped'));
        });
    }
    static async open(
        directory: string,
        fallback: DataStore,
        protection: {
            available: () => boolean;
            encrypt: (value: string) => Buffer;
            decrypt: (value: Buffer) => string;
        },
        workerFile = join(__dirname, 'snapshotWorker.js'),
    ): Promise<AsyncDataStore> {
        await mkdir(directory, { recursive: true });
        const keyFile = join(directory, 'library.key');
        let key: Buffer;
        try {
            const saved = JSON.parse(await readFile(keyFile, 'utf8'));
            key = Buffer.from(
                saved.protected ? protection.decrypt(Buffer.from(saved.value, 'base64')) : saved.value,
                'base64',
            );
            if (key.length !== 32) throw new Error('Invalid library key');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            key = randomBytes(32);
            const protectedKey = protection.available();
            const value = protectedKey
                ? protection.encrypt(key.toString('base64')).toString('base64')
                : key.toString('base64');
            await writeFile(keyFile, JSON.stringify({ protected: protectedKey, value }), { mode: 0o600, flag: 'wx' });
        }
        const worker = new Worker(workerFile, {
            workerData: { file: join(directory, 'library.data'), key },
        });
        const store = new AsyncDataStore(worker, fallback);
        try {
            store.values = (await store.request()) || {};
            worker.unref();
            return store;
        } catch (error) {
            store.closed = true;
            await worker.terminate();
            throw error;
        }
    }
    private request(values?: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.closed) return Promise.reject(new Error('Data store closed'));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.ref();
            try {
                this.worker.postMessage({ id, values });
            } catch (error) {
                this.pending.delete(id);
                if (!this.pending.size) this.worker.unref();
                reject(error as Error);
            }
        });
    }
    get(key: string, fallback?: unknown): unknown {
        return Object.prototype.hasOwnProperty.call(this.values, key)
            ? this.values[key]
            : this.fallback.get(key, fallback);
    }
    set(key: string, value: unknown): void {
        if (this.closed) throw new Error('Data store closed');
        this.values[key] = value;
        this.revision++;
        this.dirty.set(key, this.revision);
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.flush().catch((error) => console.error('Library save failed:', error.message));
            }, 750);
            this.timer.unref();
        }
    }
    async migrate(legacy: { store: Record<string, unknown> }): Promise<void> {
        const previous = legacy.store;
        const keys = Object.keys(previous).filter((key) =>
            /^(waveFeedbackV1_|waveCandidatesV2_|waveHistory_|waveExcludedArtistsV1_)/.test(key),
        );
        if (!keys.length) return;
        for (const key of keys)
            if (!Object.prototype.hasOwnProperty.call(this.values, key)) this.set(key, previous[key]);
        await this.flush();
        const remaining = { ...legacy.store };
        for (const key of keys) delete remaining[key];
        legacy.store = remaining;
    }
    async flush(): Promise<void> {
        clearTimeout(this.timer);
        this.timer = undefined;
        while (this.task) await this.task;
        if (this.savedRevision === this.revision) return;
        const task = (async () => {
            while (this.savedRevision !== this.revision) {
                const revision = this.revision;
                const changes = Object.fromEntries([...this.dirty.keys()].map((key) => [key, this.values[key]]));
                await this.request(changes);
                this.savedRevision = revision;
                for (const [key, changedAt] of this.dirty) if (changedAt <= revision) this.dirty.delete(key);
            }
        })();
        this.task = task;
        try {
            await task;
        } finally {
            if (this.task === task) this.task = undefined;
        }
    }
    async close(): Promise<void> {
        if (this.closed) return;
        await this.flush();
        clearTimeout(this.timer);
        this.timer = undefined;
        this.closed = true;
        this.worker.ref();
        await this.worker.terminate();
    }
}
