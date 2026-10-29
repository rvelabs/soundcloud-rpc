export interface CatalogTrack {
    title?: string;
    description?: string;
    user?: { username?: string };
    permalink_url?: string;
    streamable?: boolean;
    state?: string;
    policy?: string;
    duration?: number;
    language?: string;
    playback_count?: number;
    genre?: string;
    tag_list?: string;
    bpm?: number;
    publisher_metadata?: {
        artist?: string;
    };
    media?: {
        transcodings?: {
            snipped?: boolean;
            format?: {
                protocol?: string;
            };
        }[];
    };
}
export function readTrackHydration(html: string): CatalogTrack[] | null {
    const marker = /window\.__sc_hydration\s*=\s*/.exec(html);
    if (!marker) return null;
    const start = marker.index + marker[0].length;
    let depth = 0,
        quoted = false,
        escaped = false;
    for (let i = start; i < html.length; i++) {
        const char = html[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '[') depth++;
        else if (char === ']' && --depth === 0) {
            try {
                const items = JSON.parse(html.slice(start, i + 1)) as {
                    data?: CatalogTrack;
                }[];
                return items
                    .map((item) => item.data)
                    .filter((track): track is CatalogTrack => Boolean(track?.permalink_url));
            } catch {
                return null;
            }
        }
    }
    return null;
}
