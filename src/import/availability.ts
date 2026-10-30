import type { Session } from 'electron';
import { trackPath } from '../wave/nativeQueue';
import { readTrackHydration } from '../wave/trackHydration';
import { readTextLimited } from '../utils/readText';
import { TaskPool } from './taskPool';
export interface TrackAvailability {
    status: 'available' | 'blocked' | 'preview' | 'protected' | 'unknown';
    reason: string;
    checkedAt: number;
    evidence?: 'metadata' | 'playback';
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
    ...(status === 'available' ? { evidence: 'metadata' as const } : {}),
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
const sessionCache = new WeakMap<Session, Map<string, { until: number; value: TrackAvailability }>>();
const sessionPools = new WeakMap<Session, TaskPool>();
function remember(session: Session, key: string, value: TrackAvailability): void {
    let cache = sessionCache.get(session);
    if (!cache) {
        cache = new Map();
        sessionCache.set(session, cache);
    }
    const ttl = value.evidence === 'playback' ? 15 * 60000 : value.status === 'unknown' ? 5000 : 2 * 60000;
    cache.set(key, { until: Date.now() + ttl, value });
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
}
export function confirmTrackPlayback(session: Session, url: string, route = ''): void {
    const path = trackPath(url);
    if (!path) return;
    const key = route + ':' + path;
    const old = sessionCache.get(session)?.get(key);
    if (old?.value.evidence === 'playback' && old.until > Date.now()) return;
    remember(session, key, {
        status: 'available',
        evidence: 'playback',
        checkedAt: Date.now(),
        reason: 'Воспроизведение подтверждено штатным плеером.',
    });
}
export function cacheTrackAvailability(session: Session, url: string, route: string, value: TrackAvailability): void {
    const path = trackPath(url);
    if (
        !path ||
        !Number.isFinite(value.checkedAt) ||
        Date.now() - value.checkedAt < 0 ||
        Date.now() - value.checkedAt > 2 * 60000
    )
        return;
    const key = route + ':' + path;
    const old = sessionCache.get(session)?.get(key);
    if (old && old.until > Date.now() && old.value.evidence === 'playback') return;
    remember(session, key, value);
}
export function createAvailabilityChecker(
    session: Session,
    signal?: AbortSignal,
    route = '',
    schedule: <T>(task: () => Promise<T>) => Promise<T> = (task) => task(),
): (url: string) => Promise<TrackAvailability> {
    const inFlight = new Map<string, Promise<TrackAvailability>>();
    let pool = sessionPools.get(session);
    if (!pool) {
        pool = new TaskPool(() => 10);
        sessionPools.set(session, pool);
    }
    return (url) => {
        if (signal?.aborted) return Promise.reject(signal.reason);
        const path = trackPath(url);
        if (!path) return Promise.resolve(result('blocked', 'Некорректная ссылка SoundCloud.'));
        const key = route + ':' + path;
        const cached = sessionCache.get(session)?.get(key);
        if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
        let task = inFlight.get(path);
        if (!task) {
            task = pool
                .run(
                    () =>
                        schedule(async () => {
                            try {
                                signal?.throwIfAborted();
                                const timeout = AbortSignal.timeout(6500);
                                const response = await session.fetch(`https://soundcloud.com${path}`, {
                                    redirect: 'error',
                                    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                                    headers: { Accept: 'text/html' },
                                });
                                if (!response.ok) void response.body?.cancel().catch(() => {});
                                if (response.status === 429) {
                                    const retry = Number(response.headers.get('retry-after'));
                                    pool!.backoff(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 10000);
                                    return result('unknown', 'SoundCloud ограничил частоту проверок. Повторим позже.');
                                }
                                if ([403, 404, 410, 451].includes(response.status))
                                    return result('blocked', 'Трек недоступен в текущем аккаунте или регионе.');
                                if (!response.ok)
                                    return result('unknown', 'SoundCloud временно не подтвердил доступность.');
                                const html = await readTextLimited(response);
                                signal?.throwIfAborted();
                                return parseTrackAvailability(html, url);
                            } catch {
                                signal?.throwIfAborted();
                                return result('unknown', 'Не удалось проверить доступность. Повторите поиск.');
                            }
                        }),
                    signal,
                )
                .then((value) => {
                    remember(session, key, value);
                    return value;
                })
                .finally(() => inFlight.delete(path));
            inFlight.set(path, task);
        }
        return task;
    };
}
