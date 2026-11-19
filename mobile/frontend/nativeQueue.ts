import { invoke } from '../../native/frontend/bridge';
import type { QueueRequest, QueueResult } from '../../src/soundcloud/nativeQueueBridge.ts';
export type { QueueRequest, QueueResult };

export async function nativeQueueBridge(_contents: unknown, operation: QueueRequest['operation'], urls: string[]): Promise<QueueResult> {
    return nativeQueueModel({ operation, urls, ticket: crypto.randomUUID(), expires: Date.now() + 20000 });
}

export async function nativeQueueModel(request: QueueRequest, _exports?: () => unknown[]): Promise<QueueResult> {
    const page = window as any;
    const tickets = page.__scRpcQueueTickets ||= new Map();
    const ticket = {};
    Object.defineProperty(ticket, 'cancelled', {
        set(value: boolean) {
            if (value) void invoke('android_queue_cancel', { ticket: request.ticket }).catch(console.error);
        },
    });
    tickets.set(request.ticket, ticket);
    try {
        return await invoke<QueueResult>('android_queue', { request });
    } finally {
        tickets.delete(request.ticket);
    }
}
