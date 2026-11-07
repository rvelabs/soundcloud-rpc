export function invoke<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const api = (
        window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args: object) => Promise<T> } }
    ).__TAURI_INTERNALS__;
    if (!api) return Promise.reject(new Error('Native host is unavailable'));
    return api.invoke(command, args).catch((error: unknown) => {
        throw new Error(String(error));
    });
}

export class Events {
    private listeners = new Map<string, Set<(...args: any[]) => void>>();
    on(channel: string, callback: (...args: any[]) => void): () => void {
        if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
        this.listeners.get(channel)!.add(callback);
        return () => this.listeners.get(channel)?.delete(callback);
    }
    emit(channel: string, ...args: unknown[]): void {
        for (const callback of this.listeners.get(channel) || []) callback(...args);
    }
}

export const api = <T = any>(operation: string, fields: object = {}, background = false, expectedOwner?: number) =>
    invoke<T>('catalog_request', { request: { operation, ...fields }, background, expectedOwner });

export class Profile {
    private data: Record<string, unknown> = {};
    private revision = 0;
    private savedRevision = 0;
    private saving?: Promise<void>;
    private scheduled = false;
    constructor(private key: string) {}
    async load(): Promise<void> {
        this.data = (await invoke<Record<string, unknown> | null>('profile_load', { key: this.key })) || {};
    }
    get(key: string, fallback?: unknown): unknown {
        return this.data[key] ?? fallback;
    }
    set(key: string, value: unknown): void {
        this.data[key] = value;
        this.revision++;
        if (!this.scheduled) {
            this.scheduled = true;
            queueMicrotask(() => {
                this.scheduled = false;
                void this.flush().catch((error) => console.error('Native profile save failed', error));
            });
        }
    }
    async flush(durable = false): Promise<void> {
        do {
            if (!this.saving && this.savedRevision !== this.revision) {
                this.saving = Promise.resolve()
                    .then(async () => {
                        while (this.savedRevision !== this.revision) {
                            const revision = this.revision;
                            await invoke<void>('profile_save', { key: this.key, value: structuredClone(this.data) });
                            this.savedRevision = revision;
                        }
                    })
                    .finally(() => {
                        this.saving = undefined;
                    });
            }
            await this.saving;
            if (durable) await invoke('profile_flush', { key: this.key });
        } while (this.savedRevision !== this.revision);
    }
}
