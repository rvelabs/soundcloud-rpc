import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
export class IpcRegistry {
    private handles = new Set<string>();
    private listeners: Array<{ channel: string; listener: (event: IpcMainEvent, ...args: unknown[]) => void }> = [];
    constructor(
        private ipc: IpcMain,
        private allowed: (event: IpcMainEvent | IpcMainInvokeEvent, channel: string) => boolean = () => true,
        private failed: (channel: string, error: unknown) => void = (channel, error) =>
            console.error('IPC action failed:', channel, error instanceof Error ? error.name : 'Error'),
    ) {}
    handle(channel: string, handler: Parameters<IpcMain['handle']>[1]): void {
        this.ipc.handle(channel, (event, ...args) => {
            if (!this.allowed(event, channel)) throw new Error('Untrusted IPC sender');
            return handler(event, ...args);
        });
        this.handles.add(channel);
    }
    on(channel: string, handler: Parameters<IpcMain['on']>[1]): void {
        const listener = (event: IpcMainEvent, ...args: unknown[]) => {
            if (!this.allowed(event, channel)) return;
            try {
                void Promise.resolve(handler(event, ...args)).catch((error: unknown) => this.failed(channel, error));
            } catch (error) {
                this.failed(channel, error);
            }
        };
        this.ipc.on(channel, listener);
        this.listeners.push({ channel, listener });
    }
    dispose(): void {
        for (const channel of this.handles) this.ipc.removeHandler(channel);
        for (const { channel, listener } of this.listeners) this.ipc.removeListener(channel, listener);
        this.handles.clear();
        this.listeners = [];
    }
}
