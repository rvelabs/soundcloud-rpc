export async function readTextLimited(
    response: Pick<Response, 'headers' | 'body' | 'text'>,
    maxBytes = 8000000,
): Promise<string> {
    if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Ответ сервера слишком велик.');
    }
    if (!response.body) {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Ответ сервера слишком велик.');
        return text;
    }
    const reader = response.body.getReader(),
        decoder = new TextDecoder();
    let bytes = 0;
    const parts: string[] = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new Error('Ответ сервера слишком велик.');
            }
            parts.push(decoder.decode(value, { stream: true }));
        }
        parts.push(decoder.decode());
        return parts.join('');
    } finally {
        reader.releaseLock();
    }
}
