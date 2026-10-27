import { net } from 'electron';
import { readTextLimited } from '../utils/readText';
import { SourceRelayError } from './sourceRelay';
import {
    classifyPlaylistUrl,
    parseSpotifyEmbed,
    parseYandexPlaylist,
    parseYouTubePlaylist,
    type SourcePlaylist,
} from './source';
const allowedHosts = new Set([
    'open.spotify.com',
    'music.yandex.ru',
    'api.music.yandex.ru',
    'music.youtube.com',
    'www.youtube.com',
]);
async function fetchPublic(url: string, signal?: AbortSignal): Promise<string> {
    let current = url;
    for (let redirect = 0; redirect < 3; redirect++) {
        signal?.throwIfAborted();
        const address = new URL(current);
        if (
            address.protocol !== 'https:' ||
            !allowedHosts.has(address.hostname) ||
            address.username ||
            address.password ||
            address.port ||
            address.hash
        )
            throw new Error('Источник перенаправил запрос на неподдерживаемый адрес.');
        const timeout = AbortSignal.timeout(6500);
        const response = await net.fetch(current, {
            redirect: 'manual',
            credentials: 'omit',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: {
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
                ...(address.hostname === 'music.yandex.ru' && address.pathname.startsWith('/handlers/')
                    ? { Referer: 'https://music.yandex.ru/', 'X-Requested-With': 'XMLHttpRequest' }
                    : {}),
            },
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) throw new Error('Источник перенаправил запрос без адреса.');
            current = new URL(location, current).href;
            continue;
        }
        if (response.status === 451) throw new Error('Источник недоступен в текущем регионе.');
        if (!response.ok) throw new Error(`Источник ответил кодом ${response.status}.`);
        return readTextLimited(response);
    }
    throw new Error('Слишком много перенаправлений от источника.');
}
export async function loadSourcePlaylist(
    link: string,
    signal?: AbortSignal,
    options: {
        relay?: (url: string, signal?: AbortSignal) => Promise<string>;
        preferRelay?: boolean;
        onRoute?: (route: 'direct' | 'relay') => void;
    } = {},
): Promise<SourcePlaylist> {
    const source = classifyPlaylistUrl(link);
    const routes: ('direct' | 'relay')[] = options.relay
        ? options.preferRelay
            ? ['relay', 'direct']
            : ['direct', 'relay']
        : ['direct'];
    const failures: unknown[] = [];
    for (const route of routes) {
        signal?.throwIfAborted();
        options.onRoute?.(route);
        try {
            return await loadSource(source, route === 'relay' ? options.relay! : fetchPublic, signal);
        } catch (error) {
            signal?.throwIfAborted();
            failures.push(error);
        }
    }
    const relayError = failures.find((error) => error instanceof SourceRelayError);
    if (relayError) throw relayError;
    const last = failures[failures.length - 1];
    if (last instanceof Error && !/timeout|aborted|net::|fetch failed|network/i.test(last.message)) throw last;
    throw new Error(
        'Не удалось загрузить список треков из источника. Настройте резервное подключение Worker в F1 или импортируйте CSV/TXT.',
    );
}
async function loadSource(
    source: ReturnType<typeof classifyPlaylistUrl>,
    request: (url: string, signal?: AbortSignal) => Promise<string>,
    signal?: AbortSignal,
): Promise<SourcePlaylist> {
    const url =
        source.platform === 'yandex' && source.url.includes('/playlists/')
            ? `https://api.music.yandex.ru/playlist/${encodeURIComponent(source.id)}`
            : source.url;
    const body = await request(url, signal);
    if (source.platform === 'spotify') return parseSpotifyEmbed(body);
    if (source.platform === 'youtube') {
        try {
            return parseYouTubePlaylist(body);
        } catch {
            signal?.throwIfAborted();
            const fallback = await request(
                `https://www.youtube.com/playlist?list=${encodeURIComponent(source.id)}`,
                signal,
            );
            return parseYouTubePlaylist(fallback);
        }
    }
    try {
        return parseYandexPlaylist(JSON.parse(body) as unknown);
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error('Яндекс Музыка не вернула данные плейлиста.');
        throw error;
    }
}
