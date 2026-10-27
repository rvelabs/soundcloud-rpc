import { workerEndpoint } from '../network/relayTargets';
import { readTextLimited } from '../utils/readText';
export class SourceRelayError extends Error {
    constructor(
        public readonly code: 'upgrade' | 'key' | 'source' | 'network',
        message: string,
    ) {
        super(message);
    }
}
export async function fetchSourceRelay(
    endpoint: string,
    secret: string,
    url: string,
    fetcher: typeof fetch,
    signal?: AbortSignal,
): Promise<string> {
    const target = new URL(workerEndpoint(endpoint));
    target.protocol = 'https:';
    target.pathname = '/playlist-source';
    target.searchParams.set('url', url);
    const timeout = AbortSignal.timeout(25000);
    let response: Response;
    try {
        response = await fetcher(target.href, {
            headers: { Authorization: 'Bearer ' + secret },
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
    } catch {
        signal?.throwIfAborted();
        throw new SourceRelayError(
            'network',
            'Worker не ответил при загрузке плейлиста. Повторите попытку или импортируйте CSV/TXT.',
        );
    }
    const supported = response.headers.get('x-soundcloud-playlist-relay') === '1';
    if (!supported) {
        void response.body?.cancel().catch(() => {});
        if (response.status !== 404)
            throw new SourceRelayError(
                'network',
                'Cloudflare не подтвердил резервную загрузку плейлиста. Проверьте Worker или импортируйте CSV/TXT.',
            );
        throw new SourceRelayError(
            'upgrade',
            'Для импорта без VPN обновите Worker: F1 → создайте Worker через мастер или разверните новые файлы Worker. Клиент обновился, код старого Worker — нет.',
        );
    }
    if (response.status === 401) {
        void response.body?.cancel().catch(() => {});
        throw new SourceRelayError('key', 'Worker отклонил ключ подключения. Проверьте сохранённый ключ.');
    }
    if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const upstream = response.headers.get('x-playlist-source-status');
        throw new SourceRelayError(
            'source',
            upstream === '404' || upstream === '401'
                ? 'Источник не открыл плейлист. Нужна публичная ссылка; для личного списка используйте CSV/TXT.'
                : 'Источник не ответил через Worker' +
                  (upstream ? ' (HTTP ' + upstream + ')' : '') +
                  '. Повторите позже или импортируйте CSV/TXT.',
        );
    }
    return readTextLimited(response);
}
