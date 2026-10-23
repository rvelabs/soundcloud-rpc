import type { Session } from 'electron';
import { trackPath } from '../wave/nativeQueue';
import { readTrackHydration } from '../wave/trackHydration';
import { readTextLimited } from '../utils/readText';
export interface TrackAvailability {
    status: 'available' | 'blocked' | 'preview' | 'protected' | 'unknown';
    reason: string;
    checkedAt: number;
}
type TrackData = {
    permalink_url?: string;
    streamable?: boolean;
    state?: string;
    policy?: string;
    media?: {
        transcodings?: {
            snipped?: boolean;
            format?: {
                protocol?: string;
            };
        }[];
    };
};
const result = (status: TrackAvailability['status'], reason: string): TrackAvailability => ({
    status,
    reason,
    checkedAt: Date.now(),
});
export function classifyTrackAvailability(track: TrackData): TrackAvailability {
    if (track.policy === 'BLOCK' || track.streamable === false || (track.state && track.state !== 'finished'))
        return result('blocked', 'Трек недоступен для воспроизведения.');
    if (track.policy === 'SNIP') return result('preview', 'Доступен только ознакомительный фрагмент.');
    const media = track.media?.transcodings || [];
    if (media.length && media.every((item) => item.snipped === true))
        return result('preview', 'Доступен только ознакомительный фрагмент.');
    const full = media.filter((item) => item.snipped !== true);
    if (full.length && full.every((item) => /encrypted|drm/i.test(item.format?.protocol || '')))
        return result('protected', 'Только защищённый поток: воспроизведение в клиенте не подтверждено.');
    if (
        track.streamable === true &&
        track.state === 'finished' &&
        ['ALLOW', 'MONETIZE'].includes(track.policy || '') &&
        full.some((item) => ['hls', 'progressive'].includes(item.format?.protocol || ''))
    )
        return result('available', 'SoundCloud предоставляет полный поток.');
    return result('unknown', 'Не удалось подтвердить доступность трека.');
}
export function parseTrackAvailability(html: string, url: string): TrackAvailability {
    const target = trackPath(url);
    const tracks = readTrackHydration(html);
    if (!target || !tracks) return result('unknown', 'SoundCloud не показал данные доступности.');
    const track = tracks.find((item) => item.permalink_url && trackPath(item.permalink_url) === target);
    return track ? classifyTrackAvailability(track) : result('blocked', 'Трек удалён или недоступен по этой ссылке.');
}
export function createAvailabilityChecker(
    session: Session,
    signal?: AbortSignal,
): (url: string) => Promise<TrackAvailability> {
    const cache = new Map<string, Promise<TrackAvailability>>();
    return (url) => {
        const path = trackPath(url);
        if (!path) return Promise.resolve(result('blocked', 'Некорректная ссылка SoundCloud.'));
        let task = cache.get(path);
        if (!task) {
            task = (async () => {
                try {
                    signal?.throwIfAborted();
                    const timeout = AbortSignal.timeout(6500);
                    const response = await session.fetch(`https://soundcloud.com${path}`, {
                        redirect: 'error',
                        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                        headers: { Accept: 'text/html' },
                    });
                    if ([403, 404, 410, 451].includes(response.status))
                        return result('blocked', 'Трек недоступен в текущем аккаунте или регионе.');
                    if (!response.ok) return result('unknown', 'SoundCloud временно не подтвердил доступность.');
                    const html = await readTextLimited(response);
                    signal?.throwIfAborted();
                    return parseTrackAvailability(html, url);
                } catch {
                    signal?.throwIfAborted();
                    return result('unknown', 'Не удалось проверить доступность. Повторите поиск.');
                }
            })();
            cache.set(path, task);
        }
        return task;
    };
}
