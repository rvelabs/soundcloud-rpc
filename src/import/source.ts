export type SourcePlatform = 'spotify' | 'youtube' | 'yandex' | 'file';
export interface SourceTrack {
    title: string;
    artist: string;
    sourceId?: string;
    durationSeconds?: number;
}
export interface SourcePlaylist {
    platform: SourcePlatform;
    title: string;
    tracks: SourceTrack[];
    partial: boolean;
    expectedTracks?: number;
    readTracks?: number;
    pagesRead?: number;
    partialReason?: 'limit' | 'network' | 'repeated' | 'authorization' | 'source' | 'upgrade';
}
export function classifyPlaylistUrl(input: string): {
    platform: SourcePlatform;
    url: string;
    id: string;
} {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        throw new Error('Вставьте ссылку на плейлист.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
        throw new Error('Нужна обычная HTTPS-ссылка на плейлист.');
    const host = url.hostname.toLowerCase();
    if (host === 'open.spotify.com') {
        const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})\/?$/);
        if (match)
            return { platform: 'spotify', id: match[2], url: `https://open.spotify.com/embed/${match[1]}/${match[2]}` };
    }
    if (host === 'music.youtube.com' || host === 'www.youtube.com' || host === 'youtube.com') {
        const id = url.searchParams.get('list');
        if ((url.pathname === '/playlist' || url.pathname === '/watch') && id && /^[\w-]{12,80}$/.test(id))
            return {
                platform: 'youtube',
                id,
                url: `https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`,
            };
    }
    if (host === 'music.yandex.ru' || host === 'music.yandex.com') {
        const modern = url.pathname.match(/^\/playlists\/([\w.-]{2,100})\/?$/);
        const legacy = url.pathname.match(/^\/users\/([\w.-]{2,100})\/playlists\/(\d{1,10})\/?$/);
        if (modern)
            return {
                platform: 'yandex',
                id: modern[1],
                url: `https://music.yandex.ru/playlists/${encodeURIComponent(modern[1])}`,
            };
        if (legacy)
            return {
                platform: 'yandex',
                id: `${legacy[1]}/${legacy[2]}`,
                url: `https://music.yandex.ru/handlers/playlist.jsx?owner=${encodeURIComponent(legacy[1])}&kinds=${legacy[2]}`,
            };
    }
    throw new Error('Поддерживаются плейлисты Яндекс Музыки, Spotify и YouTube Music, а также альбомы Spotify.');
}
function clean(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}
function textRuns(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const item = value as {
        simpleText?: string;
        content?: string;
        runs?: {
            text?: string;
        }[];
    };
    return clean(item.simpleText || item.content || item.runs?.map((part) => part.text || '').join(''));
}
export function playlistResult(
    platform: SourcePlatform,
    title: string,
    tracks: SourceTrack[],
    partial = false,
): SourcePlaylist {
    const unique: SourceTrack[] = [];
    const seen = new Set<string>();
    for (const track of tracks) {
        const name = clean(track.title),
            artist = clean(track.artist);
        if (!name || !artist) continue;
        const key =
            track.sourceId ||
            `${name.toLowerCase()}\u0000${artist.toLowerCase()}\u0000${Math.round(track.durationSeconds || 0)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({
            title: name,
            artist,
            ...(track.sourceId ? { sourceId: track.sourceId } : {}),
            ...(Number.isFinite(track.durationSeconds) && track.durationSeconds! > 0
                ? { durationSeconds: track.durationSeconds }
                : {}),
        });
    }
    if (!clean(title) || !unique.length)
        throw new Error(
            'Не удалось прочитать треки плейлиста. Проверьте, что он публичный и доступен в вашем регионе.',
        );
    return {
        platform,
        title: clean(title).slice(0, 100),
        tracks: unique.slice(0, 500),
        partial: partial || unique.length > 500,
    };
}
export function parseSpotifyEmbed(html: string): SourcePlaylist {
    const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!match) throw new Error('Spotify не показал список треков. Нужен доступный публичный плейлист или альбом.');
    const json = JSON.parse(match[1]) as {
        props?: {
            pageProps?: {
                state?: {
                    data?: {
                        entity?: {
                            name?: string;
                            title?: string;
                            trackList?: {
                                title?: string;
                                subtitle?: string;
                                uri?: string;
                                duration?: number;
                            }[];
                        };
                    };
                };
            };
        };
    };
    const entity = json.props?.pageProps?.state?.data?.entity;
    if (!entity?.trackList?.length)
        throw new Error('Spotify не показал список треков. Нужен доступный публичный плейлист или альбом.');
    return playlistResult(
        'spotify',
        entity?.name || entity?.title || '',
        (entity?.trackList || []).map((item) => ({
            title: item.title || '',
            artist: item.subtitle || '',
            sourceId: item.uri,
            durationSeconds: item.duration ? item.duration / 1000 : undefined,
        })),
        (entity?.trackList?.length || 0) >= 100,
    );
}
export function parseYandexPlaylist(value: unknown): SourcePlaylist {
    const root = value as {
        result?: unknown;
        playlist?: unknown;
    };
    const playlist = (root?.playlist || root?.result || value) as {
        title?: string;
        name?: string;
        tracks?: unknown[];
        trackCount?: number;
    };
    const tracks = (playlist?.tracks || []).map((entry) => {
        const item =
            (
                entry as {
                    track?: unknown;
                }
            )?.track || entry;
        const track = item as {
            title?: string;
            artists?: {
                name?: string;
            }[];
            id?: string | number;
            durationMs?: number;
        };
        return {
            title: track?.title || '',
            artist:
                track?.artists
                    ?.map((artist) => artist.name)
                    .filter(Boolean)
                    .join(', ') || '',
            sourceId: String(track?.id || ''),
            durationSeconds: track?.durationMs ? track.durationMs / 1000 : undefined,
        };
    });
    const available = tracks.filter((track) => track.title && track.artist);
    return {
        ...playlistResult(
            'yandex',
            playlist?.title || playlist?.name || '',
            tracks,
            typeof playlist?.trackCount === 'number' && playlist.trackCount > available.length,
        ),
        readTracks: available.length,
        expectedTracks: playlist.trackCount,
    };
}
export function resolveYandexPlaylist(html: string): {
    owner: string;
    kind: string;
} {
    const iframe = html.match(/\/iframe\/playlist\/([\w.-]+)\/(\d{1,10})/i);
    if (iframe) return { owner: iframe[1], kind: iframe[2] };
    const owner = html.match(/"owner":\s*\{[^{}]{0,500}"login":"([\w.-]+)"/);
    const kind = html.match(/"kind":\s*(\d{1,10})/);
    if (owner && kind) return { owner: owner[1], kind: kind[1] };
    throw new Error('Яндекс Музыка не показала данные публичного плейлиста.');
}
export function extractObject(source: string, start: number): string | null {
    let depth = 0,
        inString = false,
        escaped = false;
    for (let i = start; i < source.length; i++) {
        const char = source[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    return null;
}
export function parseYouTubePlaylist(html: string): SourcePlaylist {
    const marker = /(?:var\s+)?ytInitialData\s*=\s*/.exec(html);
    const start = marker ? html.indexOf('{', marker.index + marker[0].length) : -1;
    const serialized = start >= 0 ? extractObject(html, start) : null;
    if (!serialized)
        throw new Error('YouTube Music не открыл список треков. Возможно, требуется вход или подтверждение cookie.');
    return parseYouTubeData(
        JSON.parse(serialized),
        clean(html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]),
    );
}
export function parseYouTubeData(data: unknown, fallbackTitle = ''): SourcePlaylist {
    const tracks: SourceTrack[] = [];
    let title = '';
    const visit = (value: unknown, depth = 0): void => {
        if (!value || typeof value !== 'object' || depth > 35) return;
        const node = value as Record<string, unknown>;
        if (node.playlistHeaderRenderer || node.musicDetailHeaderRenderer) {
            const header = (node.playlistHeaderRenderer || node.musicDetailHeaderRenderer) as Record<string, unknown>;
            title ||= textRuns(header.title);
        }
        if (node.playlistMetadataRenderer) {
            const header = node.playlistMetadataRenderer as {
                title?: string;
            };
            title ||= clean(header.title);
        }
        if (node.playlistVideoRenderer) {
            const row = node.playlistVideoRenderer as {
                title?: unknown;
                shortBylineText?: unknown;
                longBylineText?: unknown;
                videoId?: string;
                lengthSeconds?: string;
            };
            tracks.push({
                title: textRuns(row.title),
                artist: textRuns(row.shortBylineText || row.longBylineText),
                sourceId: row.videoId,
                durationSeconds: Number(row.lengthSeconds) || undefined,
            });
        }
        if (node.musicResponsiveListItemRenderer) {
            const row = node.musicResponsiveListItemRenderer as {
                flexColumns?: {
                    musicResponsiveListItemFlexColumnRenderer?: {
                        text?: unknown;
                    };
                }[];
            };
            const columns =
                row.flexColumns?.map((column) => textRuns(column.musicResponsiveListItemFlexColumnRenderer?.text)) ||
                [];
            if (columns.length > 1) tracks.push({ title: columns[0], artist: columns[1] });
        }
        if (node.lockupViewModel) {
            const row = node.lockupViewModel as {
                contentId?: string;
                contentType?: string;
                metadata?: {
                    lockupMetadataViewModel?: {
                        title?: {
                            content?: string;
                        };
                        metadata?: {
                            contentMetadataViewModel?: {
                                metadataRows?: {
                                    metadataParts?: {
                                        text?: {
                                            content?: string;
                                        };
                                    }[];
                                }[];
                            };
                        };
                    };
                };
            };
            if (row.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
                const metadata = row.metadata?.lockupMetadataViewModel;
                tracks.push({
                    title: clean(metadata?.title?.content),
                    artist: clean(
                        metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text
                            ?.content,
                    ),
                    sourceId: row.contentId,
                });
            }
        }
        for (const child of Object.values(node)) {
            if (Array.isArray(child)) child.forEach((item) => visit(item, depth + 1));
            else if (child && typeof child === 'object') visit(child, depth + 1);
        }
    };
    visit(data);
    if (!title) title = fallbackTitle;
    return playlistResult('youtube', title, tracks, true);
}
