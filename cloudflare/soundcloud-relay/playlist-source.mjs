const limit = 8000000;
export function publicPlaylistResource(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || value.length > 2000)
            return null;
        const params = [...url.searchParams.keys()];
        if (new Set(params).size !== params.length) return null;
        if (
            url.hostname === 'open.spotify.com' &&
            /^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(?:playlist|album)\/[A-Za-z0-9]{22}\/?$/.test(url.pathname) &&
            !params.length
        )
            return url;
        if (
            ['music.youtube.com', 'www.youtube.com'].includes(url.hostname) &&
            ((url.pathname === '/playlist' &&
                params.length === 1 &&
                params[0] === 'list' &&
                /^[\w-]{12,80}$/.test(url.searchParams.get('list') || '')) ||
                (url.pathname === '/youtubei/v1/browse' &&
                    params.every((key) => key === 'key') &&
                    (!params.length || /^[\w-]{20,100}$/.test(url.searchParams.get('key') || ''))))
        )
            return url;
        if (
            url.hostname === 'api.music.yandex.ru' &&
            /^\/playlist\/[\w.-]{2,100}$/.test(url.pathname) &&
            !params.length
        )
            return url;
        if (
            url.hostname === 'music.yandex.ru' &&
            url.pathname === '/handlers/playlist.jsx' &&
            params.length === 2 &&
            params.every((key) => ['owner', 'kinds'].includes(key)) &&
            /^[\w.-]{2,100}$/.test(url.searchParams.get('owner') || '') &&
            /^\d{1,10}$/.test(url.searchParams.get('kinds') || '')
        )
            return url;
    } catch {}
    return null;
}
function reply(body, status = 200, extra = {}) {
    return new Response(body, {
        status,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'X-Content-Type-Options': 'nosniff',
            'X-SoundCloud-Playlist-Relay': '1',
            'X-SoundCloud-Playlist-Relay-Revision': '5',
            ...extra,
        },
    });
}
export function createPublicPlaylistHandler(requester = fetch) {
    return async (request, env) => {
        if (!['GET', 'POST'].includes(request.method)) return reply('Method not allowed', 405);
        if (
            typeof env.RELAY_TOKEN !== 'string' ||
            env.RELAY_TOKEN.length < 32 ||
            request.headers.get('Authorization') !== 'Bearer ' + env.RELAY_TOKEN
        )
            return reply('Unauthorized', 401);
        const input = new URL(request.url);
        if (input.pathname !== '/playlist-source' || [...input.searchParams.keys()].join(',') !== 'url')
            return reply('Invalid source request', 400);
        let target = publicPlaylistResource(input.searchParams.get('url') || '');
        if (!target) return reply('Unsupported public playlist resource', 403);
        let body;
        if (request.method === 'POST') {
            if (target.pathname !== '/youtubei/v1/browse') return reply('Unsupported continuation', 403);
            const reader = request.body?.getReader();
            if (!reader) return reply('Missing continuation', 400);
            const bodyDeadline = setTimeout(() => {
                void reader.cancel().catch(() => {});
            }, 5000);
            try {
                const chunks = [];
                let bytes = 0;
                for (;;) {
                    const part = await reader.read();
                    if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > 16384) return reply('Continuation too large', 413);
                    chunks.push(part.value);
                }
                const joined = new Uint8Array(bytes);
                let offset = 0;
                for (const chunk of chunks) {
                    joined.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                const data = JSON.parse(new TextDecoder().decode(joined));
                const client = data?.context?.client;
                if (
                    !data ||
                    Object.keys(data).some((key) => !['context', 'continuation'].includes(key)) ||
                    !data.context ||
                    Object.keys(data.context).join(',') !== 'client' ||
                    !client ||
                    Object.keys(client).some((key) => !['clientName', 'clientVersion', 'hl', 'gl'].includes(key)) ||
                    !['WEB', 'WEB_REMIX'].includes(client.clientName) ||
                    !/^[\d.]{5,40}$/.test(client.clientVersion || '') ||
                    !/^[a-z-]{2,10}$/i.test(client.hl || '') ||
                    !/^[A-Z]{2}$/.test(client.gl || '') ||
                    typeof data.continuation !== 'string' ||
                    !/^[\x21-\x7e]{1,12000}$/.test(data.continuation)
                )
                    return reply('Invalid continuation', 400);
                body = JSON.stringify(data);
            } catch {
                return reply('Invalid continuation', 400);
            } finally {
                clearTimeout(bodyDeadline);
                void reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        } else if (target.pathname === '/youtubei/v1/browse') return reply('Continuation requires POST', 405);
        const controller = new AbortController(),
            timer = setTimeout(() => controller.abort(), 15000);
        const cancel = () => controller.abort();
        request.signal?.addEventListener('abort', cancel, { once: true });
        if (request.signal?.aborted) cancel();
        let reader;
        try {
            for (let redirects = 0; redirects < 4; redirects++) {
                const headers = {
                    Accept: 'text/html,application/json;q=0.9',
                    'Accept-Language': 'en-US,en;q=0.8',
                    'User-Agent': 'Mozilla/5.0 SoundCloudDesktopPlaylistImport/1.0',
                };
                if (target.hostname === 'music.yandex.ru')
                    Object.assign(headers, {
                        Referer: 'https://music.yandex.ru/',
                        'X-Requested-With': 'XMLHttpRequest',
                    });
                const response = await requester(target.href, {
                    method: body ? 'POST' : 'GET',
                    body,
                    redirect: 'manual',
                    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location');
                    void response.body?.cancel().catch(() => {});
                    if (body) return reply('Continuation redirect rejected', 502);
                    const next = location && publicPlaylistResource(new URL(location, target).href);
                    if (!next)
                        return reply('Unsupported redirect from source', 502, {
                            'X-Playlist-Source-Error': 'redirect',
                        });
                    target = next;
                    continue;
                }
                if (!response.ok) {
                    void response.body?.cancel().catch(() => {});
                    return reply('Source unavailable', 502, { 'X-Playlist-Source-Status': String(response.status) });
                }
                if (Number(response.headers.get('content-length')) > limit) {
                    void response.body?.cancel().catch(() => {});
                    return reply('Source response too large', 413);
                }
                const type = response.headers.get('content-type') || 'text/plain; charset=utf-8';
                if (!/text\/(?:html|plain)|application\/json/i.test(type)) {
                    void response.body?.cancel().catch(() => {});
                    return reply('Unsupported source document', 415);
                }
                reader = response.body?.getReader();
                const parts = [],
                    decoder = new TextDecoder();
                let bytes = 0;
                if (!reader) return reply('', 502);
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    bytes += value.byteLength;
                    if (bytes > limit) return reply('Source response too large', 413);
                    parts.push(decoder.decode(value, { stream: true }));
                }
                parts.push(decoder.decode());
                return reply(parts.join(''), 200, { 'Content-Type': type });
            }
            return reply('Too many redirects', 502, { 'X-Playlist-Source-Error': 'redirect' });
        } catch {
            return reply(controller.signal.aborted ? 'Source timed out' : 'Source connection failed', 504);
        } finally {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', cancel);
            if (reader) {
                void reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        }
    };
}
