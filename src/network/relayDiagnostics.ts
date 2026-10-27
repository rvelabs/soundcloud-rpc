export interface TunnelDiagnostic {
    id: number;
    host: string;
    opened: boolean;
    windowSize?: number;
    sentBytes: number;
    receivedBytes: number;
    elapsedMs: number;
    httpStatus?: number;
    failure?: 'http' | 'network' | 'handshake-timeout' | 'ack-timeout' | 'protocol' | 'closed-before-open';
    networkCode?: string;
}
export interface ProbeStage {
    stage: 'website' | 'assets' | 'api' | 'auth';
    outcome: 'ok' | 'http' | 'unexpected-page' | 'network' | 'timeout' | 'cancelled';
    elapsedMs: number;
    bytesRead: number;
    httpStatus?: number;
    networkCode?: string;
    host?: string;
}
export interface RelayDiagnostic {
    checkedAt: string;
    endpointHost: string;
    success: boolean;
    elapsedMs: number;
    stages: ProbeStage[];
    tunnels: TunnelDiagnostic[];
    setupFailure?: 'missing-endpoint' | 'invalid-endpoint' | 'missing-key' | 'gateway';
}
export function networkErrorCode(error: unknown): string | undefined {
    const value = error as { code?: unknown; message?: unknown } | null;
    const text =
        typeof error === 'string'
            ? error
            : typeof value?.code === 'string'
              ? value.code
              : typeof value?.message === 'string'
                ? value.message
                : '';
    return /\b(?:ERR_[A-Z0-9_]+|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|CERT_[A-Z0-9_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/.exec(
        text,
    )?.[0];
}
export async function probeSoundCloud(
    fetcher: typeof fetch,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeStage[]> {
    const stages: ProbeStage[] = [];
    let assets: string[] = [];
    for (const stage of ['website', 'assets', 'api', 'auth'] as const) {
        const began = Date.now(),
            controller = new AbortController();
        const result: ProbeStage = { stage, outcome: 'network', elapsedMs: 0, bytesRead: 0 };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: () => void = () => {};
        const stopped = new Promise<ProbeStage>((resolve) => {
            const finish = (outcome: 'timeout' | 'cancelled') => {
                result.outcome = outcome;
                controller.abort();
                resolve(result);
            };
            cancel = () => finish('cancelled');
            options.signal?.addEventListener('abort', cancel, { once: true });
            timer = setTimeout(() => finish('timeout'), options.timeoutMs ?? 15000);
            if (options.signal?.aborted) cancel();
        });
        const work = (async (): Promise<ProbeStage> => {
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            try {
                if (controller.signal.aborted) return result;
                const urls =
                    stage === 'assets'
                        ? assets
                        : [
                              stage === 'website'
                                  ? 'https://soundcloud.com/discover'
                                  : stage === 'auth'
                                    ? 'https://api-auth.soundcloud.com/'
                                    : 'https://api-v2.soundcloud.com/',
                          ];
                if (!urls.length) {
                    result.outcome = 'unexpected-page';
                    return result;
                }
                for (const url of urls) {
                    result.host = new URL(url).hostname;
                    const response = await fetcher(url, {
                        signal: controller.signal,
                        credentials: 'omit',
                        cache: 'no-store',
                    });
                    if (controller.signal.aborted) {
                        void response.body?.cancel().catch(() => {});
                        return result;
                    }
                    result.httpStatus = response.status;
                    const endpoint = stage === 'api' || stage === 'auth';
                    const valid = endpoint
                        ? [200, 401, 404, ...(stage === 'auth' ? [405] : [])].includes(response.status)
                        : response.ok;
                    if (!valid || endpoint) {
                        result.outcome = valid ? 'ok' : 'http';
                        void response.body?.cancel().catch(() => {});
                        return result;
                    }
                    reader = response.body?.getReader();
                    const decoder = new TextDecoder();
                    let text = '',
                        bytes = 0;
                    const limit = stage === 'assets' ? 64 * 1024 : 512 * 1024;
                    while (reader && bytes < limit) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        result.bytesRead += value.byteLength;
                        bytes += value.byteLength;
                        text += decoder.decode(value, { stream: true });
                    }
                    text += decoder.decode();
                    if (controller.signal.aborted) return result;
                    if (stage === 'website') {
                        assets = bootstrapAssets(text);
                        result.outcome = assets.length ? 'ok' : 'unexpected-page';
                    } else {
                        const contentType = response.headers.get('content-type') || '';
                        result.outcome =
                            bytes > 0 &&
                            !/text\/html/i.test(contentType) &&
                            !/^\s*(?:<!doctype|<html|<head|<body)/i.test(text)
                                ? 'ok'
                                : 'unexpected-page';
                    }
                    if (reader) {
                        void reader.cancel().catch(() => {});
                        reader.releaseLock();
                        reader = undefined;
                    }
                    if (result.outcome !== 'ok') return result;
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    result.outcome = 'network';
                    result.networkCode = networkErrorCode(error);
                }
            } finally {
                if (reader) {
                    void reader.cancel().catch(() => {});
                    reader.releaseLock();
                }
            }
            return result;
        })();
        try {
            await Promise.race([work, stopped]);
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', cancel);
        }
        result.elapsedMs = Date.now() - began;
        stages.push({ ...result });
        if (result.outcome !== 'ok') break;
    }
    return stages;
}
function bootstrapAssets(html: string): string[] {
    const urls = new Set<string>();
    for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
        try {
            const url = new URL(match[1], 'https://soundcloud.com/');
            if (
                url.protocol === 'https:' &&
                !url.username &&
                !url.password &&
                !url.port &&
                /(?:^|\.)sndcdn\.com$/.test(url.hostname) &&
                /\/assets\/[^?#]+\.js$/.test(url.pathname)
            )
                urls.add(url.href);
        } catch {}
    }
    const all = [...urls];
    if (!all.length) return [];
    const selected = all.length > 1 ? [all[0], all[all.length - 1]] : all;
    for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
        if (!/\brel\s*=\s*["'][^"']*\bstylesheet\b[^"']*["']/i.test(tag[0])) continue;
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
        if (!href) continue;
        try {
            const url = new URL(href.replace(/&amp;/g, '&'), 'https://soundcloud.com/');
            if (
                url.protocol === 'https:' &&
                !url.username &&
                !url.password &&
                !url.port &&
                /(?:^|\.)sndcdn\.com$/.test(url.hostname) &&
                url.pathname.endsWith('.css')
            ) {
                selected.push(url.href);
                break;
            }
        } catch {}
    }
    return selected;
}
export function describeRelayDiagnostic(report?: RelayDiagnostic): string {
    if (!report) return 'Проверка Worker ещё не выполнялась.';
    if (report.success)
        return 'Worker доступен: HTML, ресурсы интерфейса, API и узел авторизации SoundCloud отвечают. Это проверка подключения, а не входа в аккаунт или состояния открытой страницы.';
    const setup = report.setupFailure;
    if (setup === 'missing-endpoint') return 'Сначала сохраните HTTPS-адрес Worker.';
    if (setup === 'invalid-endpoint')
        return 'Адрес Worker некорректен. Нужен HTTPS-адрес без ключа и параметров в ссылке.';
    if (setup === 'missing-key')
        return 'Ключ Worker отсутствует или не расшифровывается. Введите RELAY_TOKEN и сохраните подключение.';
    if (setup === 'gateway') return 'Не удалось запустить локальное подключение к Worker. Скопируйте диагностику.';
    const tunnel = [...report.tunnels].reverse().find((item) => item.failure);
    if (tunnel?.httpStatus === 401)
        return 'Worker доступен, но отклонил ключ (HTTP 401). Сохранённый ключ должен совпадать с RELAY_TOKEN этого Worker.';
    if (tunnel?.httpStatus === 404)
        return 'Адрес отвечает, но туннель Worker не найден (HTTP 404). Проверьте адрес и загруженный код Worker.';
    if (tunnel?.httpStatus === 403)
        return 'Соединение с Worker отклонено (HTTP 403). Проверьте Cloudflare Access, правила доступа и состояние Worker.';
    if (tunnel?.httpStatus === 429)
        return 'Cloudflare ограничил число запросов (HTTP 429). Проверьте лимиты аккаунта и повторите позже.';
    if (tunnel?.httpStatus && tunnel.httpStatus >= 500)
        return (
            'Worker вернул HTTP ' +
            tunnel.httpStatus +
            ' при открытии туннеля. Возможен отказ исходящего соединения или ошибка Cloudflare; скопируйте диагностику.'
        );
    if (tunnel?.networkCode === 'ENOTFOUND' || tunnel?.networkCode === 'EAI_AGAIN')
        return 'Не удалось найти адрес Worker через DNS. Проверьте адрес; после первого развёртывания DNS может обновиться не сразу.';
    if (tunnel?.failure === 'handshake-timeout')
        return 'Истекло время ожидания соединения с Worker. Его адрес может быть недоступен через эту сеть; скопируйте диагностику.';
    const failed = report.stages.find((item) => item.outcome !== 'ok');
    if (failed?.outcome === 'cancelled') return 'Проверка отменена: настройки подключения изменились или окно закрыто.';
    if (failed?.outcome === 'http')
        return (
            'Через туннель получен HTTP ' +
            failed.httpStatus +
            ' от ' +
            (failed.stage === 'api'
                ? 'API SoundCloud'
                : failed.stage === 'auth'
                  ? 'узла авторизации SoundCloud'
                  : failed.stage === 'assets'
                    ? 'CDN интерфейса SoundCloud'
                    : 'сайта SoundCloud') +
            '. Проверьте доступность сервиса из региона Worker.'
        );
    if (failed?.outcome === 'unexpected-page')
        return 'Туннель отвечает, но вместо страницы SoundCloud получен другой документ. Возможна страница проверки доступа.';
    if (failed?.networkCode?.includes('CERT_') || failed?.networkCode?.includes('VERIFY'))
        return 'Не прошла защищённая проверка соединения с SoundCloud. Сертификаты не отключаются; подробности есть в диагностике.';
    const opened = report.tunnels.some((item) => item.opened);
    if (opened)
        return (
            'Worker открыл туннель, но загрузка ' +
            (failed?.stage === 'api'
                ? 'API'
                : failed?.stage === 'auth'
                  ? 'узла авторизации'
                  : failed?.stage === 'assets'
                    ? 'ресурсов интерфейса'
                    : 'страницы') +
            ' SoundCloud прервалась. Возможен тайм-аут или ограничение сети; скопируйте диагностику.'
        );
    return (
        'Не удалось установить соединение с Worker' +
        (tunnel?.networkCode ? ' (' + tunnel.networkCode + ')' : '') +
        '. Проверьте доступность его адреса в этой сети. Новый Worker на той же сети Cloudflare может не помочь; скопируйте диагностику.'
    );
}
