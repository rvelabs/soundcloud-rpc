import { parseApiTrack, type ApiTrack } from './trackTypes';

export interface ApiAccount {
    id: number;
    username: string;
    permalink: string;
    revision: number;
}
export interface ApiPlaylist {
    id: number;
    title: string;
    ownerId: number;
    trackIds: number[];
    complete: boolean;
    modified?: string;
}
export interface ApiPage<T> {
    items: T[];
    next: string | null;
}
export class ApiWriteError extends Error {
    constructor(
        public readonly status: number,
        public readonly uncertain = false,
    ) {
        super(
            uncertain
                ? 'SoundCloud не подтвердил результат записи. Найденные треки сохранены — повторите добавление.'
                : status === 429
                  ? 'SoundCloud ограничил добавление треков. Повторите позже (HTTP 429).'
                  : status === 401 || status === 403
                    ? 'SoundCloud требует повторного входа или подтверждения аккаунта.'
                    : 'SoundCloud не сохранил изменение.',
        );
    }
    get fatal(): boolean {
        return this.uncertain || [0, 401, 403, 429].includes(this.status) || this.status >= 500;
    }
}
export const apiObject = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
export const apiId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export function parsePlaylist(value: unknown): ApiPlaylist | null {
    const outer = apiObject(value),
        item = apiObject(outer?.playlist) || outer;
    const owner = item?.user_id ?? apiObject(item?.user)?.id;
    if (!item || !apiId(item.id) || !apiId(owner) || typeof item.title !== 'string') return null;
    const list = Array.isArray(item.tracks) ? item.tracks : [];
    const trackIds = list.flatMap((track) => {
        const id = typeof track === 'number' ? track : apiObject(track)?.id;
        return apiId(id) ? [id] : [];
    });
    const count = typeof item.track_count === 'number' ? item.track_count : list.length;
    return {
        id: item.id,
        title: item.title.slice(0, 200),
        ownerId: owner,
        trackIds,
        complete:
            Array.isArray(item.tracks) &&
            trackIds.length === list.length &&
            count === list.length &&
            list.length <= 500,
        modified: typeof item.last_modified === 'string' ? item.last_modified.slice(0, 100) : undefined,
    };
}
export function parsePage<T>(value: unknown, decode: (item: unknown) => T | null): ApiPage<T> | null {
    const object = apiObject(value);
    if (!Array.isArray(object?.collection) || object.collection.length > 500) return null;
    const items = object.collection.slice(0, 500).flatMap((item) => {
        const parsed = decode(item);
        return parsed === null ? [] : [parsed];
    });
    if (object.collection.length && !items.length) return null;
    if (object.next_href !== undefined && object.next_href !== null && typeof object.next_href !== 'string')
        return null;
    return { items, next: typeof object.next_href === 'string' && object.next_href ? object.next_href : null };
}
export function parseTrackPage(value: unknown): ApiPage<ApiTrack> | null {
    return parsePage(value, (item) => {
        const entry = apiObject(item);
        return parseApiTrack(entry?.track || entry?.sound || item);
    });
}
