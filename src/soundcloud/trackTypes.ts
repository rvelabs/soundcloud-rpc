import type { CatalogTrack } from '../wave/trackHydration';
import { trackPath } from '../wave/nativeQueue';

export interface ApiTrack extends CatalogTrack {
    id: number;
    title: string;
    permalink_url: string;
    radioSource?: 'collection' | 'home' | 'following' | 'artist';
}
const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
const text = (value: unknown, limit = 200): string | undefined =>
    typeof value === 'string' ? value.slice(0, limit) : undefined;
export function parseApiTrack(value: unknown): ApiTrack | null {
    const item = object(value);
    if (!item || (item.kind && item.kind !== 'track') || !Number.isSafeInteger(item.id) || Number(item.id) <= 0)
        return null;
    const path = trackPath(String(item.permalink_url || ''));
    const title = text(item.title);
    if (!path || !title) return null;
    const user = object(item.user),
        publisher = object(item.publisher_metadata),
        media = object(item.media);
    const finite = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    const transcodings = Array.isArray(media?.transcodings)
        ? media.transcodings.slice(0, 12).flatMap((entry) => {
              const transcoding = object(entry),
                  format = object(transcoding?.format);
              return transcoding
                  ? [{ snipped: transcoding.snipped === true, format: { protocol: text(format?.protocol, 50) } }]
                  : [];
          })
        : undefined;
    return {
        id: Number(item.id),
        title,
        permalink_url: 'https://soundcloud.com' + path,
        user: {
            username: text(user?.username),
            id: Number.isSafeInteger(user?.id) && Number(user?.id) > 0 ? Number(user?.id) : undefined,
        },
        publisher_metadata: { artist: text(publisher?.artist) },
        description: text(item.description, 4000),
        duration: finite(item.duration),
        last_modified: text(item.last_modified, 100),
        language: text(item.language, 40),
        playback_count: finite(item.playback_count),
        genre: text(item.genre, 100),
        tag_list: text(item.tag_list, 2000),
        bpm: finite(item.bpm),
        streamable: typeof item.streamable === 'boolean' ? item.streamable : undefined,
        state: text(item.state, 40),
        policy: text(item.policy, 40),
        media: transcodings ? { transcodings } : undefined,
    };
}
