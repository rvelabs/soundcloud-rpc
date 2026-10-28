import { extractObject, parseYouTubeData, playlistResult, type SourcePlaylist, type SourceTrack } from './source';
export interface SourceRequestInit {
    method: 'POST';
    body: string;
}
export type SourceRequest = (url: string, signal?: AbortSignal, init?: SourceRequestInit) => Promise<string>;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
function visit(value: unknown, callback: (node: ObjectValue) => void, depth = 0): void {
    if (!value || typeof value !== 'object' || depth > 35) return;
    if (Array.isArray(value)) {
        for (const child of value) visit(child, callback, depth + 1);
        return;
    }
    const node = value as ObjectValue;
    callback(node);
    for (const [key, child] of Object.entries(node))
        if (!['secondaryContents', 'secondaryResults', 'relatedChipCloudRenderer'].includes(key))
            visit(child, callback, depth + 1);
}
const text = (value: unknown): string => {
    const node = object(value);
    return typeof node.simpleText === 'string'
        ? node.simpleText
        : typeof node.content === 'string'
          ? node.content
          : Array.isArray(node.runs)
            ? node.runs.map((run) => String(object(run).text || '')).join('')
            : '';
};
function row(value: unknown, depth = 0): boolean {
    if (depth > 4) return false;
    const node = object(value);
    if (
        node.playlistVideoRenderer ||
        node.musicResponsiveListItemRenderer ||
        object(node.lockupViewModel).contentType === 'LOCKUP_CONTENT_TYPE_VIDEO'
    )
        return true;
    return Object.values(node).some((child) => row(child, depth + 1));
}
export function readYouTubePage(
    body: string,
    fallbackTitle = '',
): {
    tracks: SourceTrack[];
    title: string;
    continuation?: string;
    expected?: number;
    context?: { client: { clientName: string; clientVersion: string; hl: string; gl: string } };
    key?: string;
} {
    const marker = /(?:var\s+|window\["|window\[')?ytInitialData(?:["']\])?\s*=\s*/.exec(body);
    const start = marker ? body.indexOf('{', marker.index + marker[0].length) : -1;
    const serialized = body.trimStart().startsWith('{') ? body : start >= 0 ? extractObject(body, start) : null;
    if (!serialized) throw new Error('YouTube не показал список треков.');
    const data = JSON.parse(serialized) as unknown;
    let title = fallbackTitle,
        expected: number | undefined,
        scope: unknown[] | undefined,
        weight = -1;
    visit(data, (node) => {
        const metadata = object(node.playlistMetadataRenderer);
        if (typeof metadata.title === 'string') title = metadata.title.slice(0, 100);
        for (const name of [
            'playlistHeaderRenderer',
            'musicDetailHeaderRenderer',
            'playlistSidebarPrimaryInfoRenderer',
        ]) {
            const header = object(node[name]);
            title ||= text(header.title).slice(0, 100);
            const count = text(
                header.numVideosText ||
                    header.numTracksText ||
                    (Array.isArray(header.stats) ? header.stats[0] : undefined),
            );
            const number = count.match(/^[\s]*([\d\s,.]+)/)?.[1].replace(/\D/g, '');
            if (number && Number(number) > 0) expected = Number(number);
        }
        for (const name of ['contents', 'continuationItems']) {
            const entries = node[name];
            if (!Array.isArray(entries)) continue;
            const count = entries.reduce((sum, item) => sum + Number(row(item)), 0);
            if (count > weight) {
                scope = entries;
                weight = count;
            }
        }
    });
    const chosen = scope || data;
    let continuation: string | undefined;
    visit(chosen, (node) => {
        const command = object(node.continuationCommand);
        const next = object(node.nextContinuationData);
        const token = command.token || next.continuation;
        if (!continuation && typeof token === 'string' && token.length <= 12000) continuation = token;
    });
    if (!continuation)
        visit(data, (node) => {
            const list = object(
                node.musicPlaylistShelfContinuation ||
                    node.playlistVideoListRenderer ||
                    node.musicPlaylistShelfRenderer,
            );
            const next = Array.isArray(list.continuations)
                ? object(object(list.continuations[0]).nextContinuationData).continuation
                : undefined;
            if (typeof next === 'string' && next.length <= 12000) continuation ||= next;
        });
    const tracks =
        weight > 0
            ? parseYouTubeData({ metadata: { playlistMetadataRenderer: { title } }, contents: chosen }, title).tracks
            : [];
    let context: ReturnType<typeof readYouTubePage>['context'];
    let key: string | undefined;
    const settings = /ytcfg\.set\(\s*/g;
    for (const match of body.matchAll(settings)) {
        const position = body.indexOf('{', match.index! + match[0].length);
        if (position < 0 || position - match.index! > 30) continue;
        const json = extractObject(body, position);
        if (!json) continue;
        try {
            const config = object(JSON.parse(json));
            const client = object(object(config.INNERTUBE_CONTEXT).client);
            if (
                ['WEB', 'WEB_REMIX'].includes(String(client.clientName)) &&
                typeof client.clientVersion === 'string' &&
                /^[\d.]{5,40}$/.test(client.clientVersion)
            )
                context = {
                    client: {
                        clientName: String(client.clientName),
                        clientVersion: client.clientVersion,
                        hl: /^[a-z-]{2,10}$/i.test(String(client.hl)) ? String(client.hl) : 'en',
                        gl: /^[A-Z]{2}$/.test(String(client.gl)) ? String(client.gl) : 'US',
                    },
                };
            if (typeof config.INNERTUBE_API_KEY === 'string' && /^[\w-]{20,100}$/.test(config.INNERTUBE_API_KEY))
                key = config.INNERTUBE_API_KEY;
        } catch {}
    }
    return { tracks, title, continuation, expected, context, key };
}
export async function loadYouTubePages(
    body: string,
    url: string,
    request: SourceRequest,
    signal?: AbortSignal,
    progress?: (playlist: SourcePlaylist) => void,
): Promise<SourcePlaylist> {
    const first = readYouTubePage(body);
    if (!first.title || !first.tracks.length) throw new Error('YouTube не показал список треков.');
    let tracks = first.tracks,
        token = first.continuation,
        pages = 1,
        reason: SourcePlaylist['partialReason'];
    const seen = new Set<string>();
    const endpoint = new URL('/youtubei/v1/browse', url);
    if (first.key) endpoint.searchParams.set('key', first.key);
    const snapshot = (): SourcePlaylist => ({
        ...playlistResult(
            'youtube',
            first.title,
            tracks,
            Boolean(token || reason || (first.expected && tracks.length < first.expected)),
        ),
        readTracks: tracks.length,
        expectedTracks: first.expected,
        pagesRead: pages,
        ...(reason ? { partialReason: reason } : {}),
    });
    progress?.(snapshot());
    while (token && tracks.length < 500 && pages < 20) {
        signal?.throwIfAborted();
        if (!first.context) {
            reason = 'source';
            break;
        }
        if (seen.has(token)) {
            reason = 'repeated';
            break;
        }
        seen.add(token);
        try {
            const next = readYouTubePage(
                await request(endpoint.href, signal, {
                    method: 'POST',
                    body: JSON.stringify({ context: first.context, continuation: token }),
                }),
                first.title,
            );
            const merged = playlistResult('youtube', first.title, [...tracks, ...next.tracks]);
            tracks = merged.tracks;
            if (merged.partial) reason = 'limit';
            pages++;
            token = next.continuation;
            progress?.(snapshot());
        } catch (error) {
            signal?.throwIfAborted();
            reason = (error as { code?: string }).code === 'upgrade' ? 'upgrade' : 'network';
            break;
        }
    }
    if (!reason && (token || (tracks.length >= 500 && first.expected && first.expected > tracks.length)))
        reason = 'limit';
    return snapshot();
}
