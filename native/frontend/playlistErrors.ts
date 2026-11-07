type Action = 'create' | 'update';
const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

export class PlaylistRequestError extends Error {
    readonly definite: boolean;
    constructor(
        readonly action: Action,
        readonly status: number,
        readonly transport: 'native' | 'browser',
        readonly detail: string,
    ) {
        const message =
            status === 403
                ? 'SoundCloud отклонил сохранение (HTTP 403). Если появилась капча, пройдите её в SoundCloud и повторите добавление. Найденные треки сохранены.'
                : status === 401
                  ? 'SoundCloud требует повторного входа (HTTP 401).'
                  : status === 429
                    ? 'SoundCloud ограничил добавление треков. Повторите позже (HTTP 429).'
                    : 'SoundCloud не подтвердил результат записи. Найденные треки сохранены — повторите добавление.';
        super(message + (detail ? '\n' + detail : ''));
        this.name = 'PlaylistRequestError';
        this.definite = status >= 400 && status < 500 && status !== 408;
    }
}

export function playlistRequestError(
    error: unknown,
    action: Action,
    transport: 'native' | 'browser',
): PlaylistRequestError {
    if (error instanceof PlaylistRequestError) return error;
    const value = object(error);
    const numeric = Number(value?.status ?? object(value?.response)?.status);
    const status = numeric >= 100 && numeric <= 599 ? numeric : Number(String(error).match(/HTTP (\d{3})\b/)?.[1]) || 0;
    let body = object(value?.responseJSON);
    if (!body && typeof value?.responseText === 'string' && value.responseText.length <= 16000) {
        try {
            body = object(JSON.parse(value.responseText));
        } catch {}
    }
    const first = Array.isArray(body?.errors) ? object(body.errors[0]) : undefined;
    const reason =
        body?.error_message ??
        object(body?.error)?.message ??
        body?.message ??
        (typeof body?.error === 'string' ? body.error : undefined) ??
        first?.error_message ??
        first?.message;
    const text = typeof reason === 'string' ? reason : error instanceof Error ? error.message : '';
    const detail = text
        .replace(/(?:OAuth|Bearer)\s+[^\s,;"'<>]+/gi, '[redacted]')
        .replace(/((?:access_token|client_secret|authorization|cookie)\s*[=:]\s*)[^\s,;"'<>]+/gi, '$1[redacted]')
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
        .replace(/\p{Cc}+/gu, ' ')
        .slice(0, 240);
    return new PlaylistRequestError(action, status, transport, detail);
}
