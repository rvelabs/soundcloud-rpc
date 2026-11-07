import { invoke } from './bridge';

export const net = {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        init?.signal?.throwIfAborted();
        const id = crypto.randomUUID();
        let cancel!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            cancel = () => {
                void invoke('source_cancel', { id }).catch(() => {});
                reject(init?.signal?.reason || new DOMException('Request cancelled', 'AbortError'));
            };
        });
        init?.signal?.addEventListener('abort', cancel, { once: true });
        try {
            const value = await Promise.race([
                invoke<{ status: number; text: string; location?: string }>('source_request', {
                    id,
                    url: input instanceof Request ? input.url : String(input),
                    method: init?.method || 'GET',
                    body: typeof init?.body === 'string' ? init.body : null,
                }),
                cancelled,
            ]);
            init?.signal?.throwIfAborted();
            return new Response(value.text, {
                status: value.status,
                headers: value.location ? { location: value.location } : {},
            });
        } finally {
            init?.signal?.removeEventListener('abort', cancel);
        }
    },
};
