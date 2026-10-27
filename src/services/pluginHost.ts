import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
export class PluginHost {
    readonly ready: Promise<unknown>;
    private worker: Worker;
    private nextId = 0;
    private closed = false;
    private pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    private notifications = new Map<string, unknown>();
    private notifying = false;
    constructor(
        source: string,
        filename: string,
        private failed: (error: Error) => void,
    ) {
        if (Buffer.byteLength(source) > 512000) throw new Error('Plugin file too large');
        this.worker = new Worker(join(__dirname, 'pluginWorker.js'), {
            workerData: { source, filename },
            resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
        });
        this.worker.on('message', (message) => {
            if (message.fatal) {
                this.fail(new Error(message.fatal));
                return;
            }
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.value);
        });
        this.worker.on('error', (error) => this.fail(error));
        this.worker.on('exit', () => {
            if (!this.closed) this.fail(new Error('Plugin host stopped'));
        });
        this.worker.unref();
        this.ready = this.call('onEnable');
    }
    call(method: string, value?: unknown): Promise<unknown> {
        if (this.closed) return Promise.reject(new Error('Plugin host closed'));
        if (this.pending.size >= 8) return Promise.reject(new Error('Plugin request limit exceeded'));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new Error('Plugin response timed out')), 1500);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({ id, method, value });
        });
    }
    notify(method: string, value: unknown): void {
        if (this.closed) return;
        this.notifications.set(method, value);
        if (this.notifying) return;
        this.notifying = true;
        void this.ready
            .then(async () => {
                while (!this.closed && this.notifications.size) {
                    const [method, value] = this.notifications.entries().next().value!;
                    this.notifications.delete(method);
                    await this.call(method, value);
                }
            })
            .catch((error) => this.fail(error))
            .finally(() => {
                this.notifying = false;
            });
    }
    private fail(error: Error): void {
        if (this.closed) return;
        this.dispose();
        this.failed(error);
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Plugin host closed'));
        }
        this.pending.clear();
        this.notifications.clear();
        void this.worker.terminate();
    }
}
