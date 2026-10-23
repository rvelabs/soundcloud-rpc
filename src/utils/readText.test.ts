import { describe, expect, it } from 'vitest';
import { readTextLimited } from './readText';
describe('bounded HTML downloads', () => {
    it('decodes Unicode across byte boundaries', async () => {
        const bytes = new TextEncoder().encode('Музыка 🎵');
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (i < bytes.length) controller.enqueue(bytes.subarray(i, ++i));
                else controller.close();
            },
        });
        expect(await readTextLimited(new Response(body), 100)).toBe('Музыка 🎵');
    });
    it('cancels oversized chunked responses before consuming the whole body', async () => {
        let canceled = false,
            chunks = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                chunks++;
                controller.enqueue(new Uint8Array(16));
            },
            cancel() {
                canceled = true;
            },
        });
        await expect(readTextLimited(new Response(body), 32)).rejects.toThrow('слишком велик');
        expect(canceled).toBe(true);
        expect(chunks).toBeLessThan(6);
    });
});
