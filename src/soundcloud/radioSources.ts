import { apiId, apiObject, parsePage, parseTrackPage } from './accountTypes';
import { parseApiTrack, type ApiTrack } from './trackTypes';
export type RadioReader = <T>(
    path: string,
    params: Record<string, string>,
    decode: (value: unknown) => T | null,
    signal?: AbortSignal,
    auth?: boolean,
    background?: boolean,
) => Promise<T | null>;
type Reference = { id?: number; urn?: string; owner?: number; count?: number; track?: number };
const reference = (value: unknown): Reference | null => {
    const item = apiObject(value);
    if (!item) return null;
    if (item.kind === 'track') return apiId(item.id) ? { track: item.id } : null;
    if (item.kind && !['playlist', 'system-playlist'].includes(String(item.kind))) return null;
    const owner = apiObject(item.user)?.id ?? item.user_id;
    if (apiId(item.id))
        return {
            id: item.id,
            owner: apiId(owner) ? owner : undefined,
            count: typeof item.track_count === 'number' ? item.track_count : undefined,
        };
    return typeof item.urn === 'string' && /^soundcloud:system-playlists:[\w:-]{1,160}$/.test(item.urn)
        ? { urn: item.urn }
        : null;
};
function trackIds(value: unknown): number[] | null {
    const list = apiObject(value)?.tracks;
    if (!Array.isArray(list)) return null;
    return list.slice(0, 500).flatMap((value) => {
        const id = typeof value === 'number' ? value : apiObject(value)?.id;
        return apiId(id) ? [id] : [];
    });
}
function sample(ids: number[], count: number): number[] {
    if (ids.length <= count) return ids;
    return Array.from({ length: count }, (_, i) => ids[Math.floor((i * (ids.length - 1)) / (count - 1))]);
}
export class RadioSources {
    private cursors = new Map<
        number,
        { at: number; next: string | null; seen: Set<string>; pages: number; advanced: number }
    >();
    private collections = new Map<number, { at: number; tracks: ApiTrack[] }>();
    private library?: { owner: number; at: number; likes: IdProgress; blocked: IdProgress };
    private reactions = new Map<number, boolean>();
    private personalState?: { owner: number; at: number; cursor?: string | null; pages: number; offset: number };
    private extras = new Map<string, { at: number; tracks: ApiTrack[] }>();
    constructor(
        private read: RadioReader,
        private batch: (ids: number[], background?: boolean) => Promise<ApiTrack[] | null>,
        private revision: () => number,
        private now: () => number,
    ) {}
    clear(): void {
        this.cursors.clear();
        this.collections.clear();
        this.library = undefined;
        this.reactions.clear();
        this.personalState = undefined;
        this.extras.clear();
    }
    diagnostics(): object {
        return {
            relatedCursors: this.cursors.size,
            collectionSeeds: this.collections.size,
            likedIds: this.library?.likes.ids.size || 0,
            blockedUploaders: this.library?.blocked.ids.size || 0,
            likesComplete: this.library?.likes.next === null,
            blocksComplete: this.library?.blocked.next === null,
            extraSources: this.extras.size,
            historyPages: this.personalState?.pages || 0,
        };
    }
    liked(id: number, desired: boolean): void {
        this.reactions.set(id, desired);
        while (this.reactions.size > 2000) this.reactions.delete(this.reactions.keys().next().value!);
        if (this.library) {
            if (desired) this.library.likes.ids.add(id);
            else this.library.likes.ids.delete(id);
        }
    }
    async signals(owner: number, signal?: AbortSignal): Promise<LibrarySignals | null> {
        if (!this.library || this.library.owner !== owner || this.now() - this.library.at > 10 * 60000)
            this.library = {
                owner,
                at: this.now(),
                likes: { ids: new Set(), seen: new Set() },
                blocked: { ids: new Set(), seen: new Set() },
            };
        const state = this.library,
            revision = this.revision();
        const update = async (progress: IdProgress, path: string) => {
            if (progress.next === null || progress.failed || progress.ids.size >= 50000) return;
            if (progress.retryAt && this.now() < progress.retryAt) return;
            let params: Record<string, string> = { limit: '200', linked_partitioning: '1' };
            if (progress.next) {
                try {
                    const url = new URL(progress.next);
                    if (
                        url.origin !== 'https://api-v2.soundcloud.com' ||
                        url.pathname !== path ||
                        url.username ||
                        url.password ||
                        url.href.length > 6000
                    )
                        throw Error('Invalid continuation');
                    url.searchParams.delete('client_id');
                    url.searchParams.delete('access_token');
                    params = Object.fromEntries(url.searchParams);
                } catch {
                    progress.failed = true;
                    return;
                }
            }
            const page = await this.read(
                path,
                params,
                (value) =>
                    parsePage(value, (item) => {
                        const raw = apiObject(item)?.id ?? item;
                        if (apiId(raw)) return raw;
                        if (typeof raw === 'string' && /^(?:soundcloud:users:)?\d+$/.test(raw)) {
                            const id = Number(raw.split(':').pop());
                            return apiId(id) ? id : null;
                        }
                        return null;
                    }),
                signal,
                true,
            );
            if (revision !== this.revision()) return;
            if (!page) {
                progress.failures = (progress.failures || 0) + 1;
                progress.retryAt = this.now() + 3000 * 2 ** (progress.failures - 1);
                progress.failed = progress.failures >= 3;
                return;
            }
            progress.failures = 0;
            progress.retryAt = undefined;
            for (const id of page.items) if (progress.ids.size < 50000) progress.ids.add(id);
            if (page.next && progress.seen.has(page.next)) {
                progress.failed = true;
                return;
            }
            if (page.next) progress.seen.add(page.next);
            progress.next = page.next;
        };
        await Promise.all([update(state.likes, '/me/track_likes/ids'), update(state.blocked, '/me/mutings/users/ids')]);
        if (revision !== this.revision()) return null;
        for (const [id, liked] of this.reactions) {
            if (liked) state.likes.ids.add(id);
            else state.likes.ids.delete(id);
        }
        const more = (p: IdProgress) => !p.failed && p.next !== null && p.ids.size < 50000;
        return {
            likedIds: [...state.likes.ids],
            blockedIds: [...state.blocked.ids],
            likesComplete: state.likes.next === null && !state.likes.failed,
            blocksComplete: state.blocked.next === null && !state.blocked.failed,
            more: more(state.likes) || more(state.blocked),
        };
    }
    async related(id: number, advance = false): Promise<ApiTrack[] | null> {
        const path = `/tracks/${id}/related`,
            revision = this.revision();
        let state = this.cursors.get(id),
            params: Record<string, string> = { limit: '24', linked_partitioning: '1' };
        if (state && this.now() - state.at >= 30 * 60000) {
            this.cursors.delete(id);
            state = undefined;
        }
        if (advance && state) {
            if (!state.next || state.pages >= 4 || this.now() - state.advanced < 60000) return [];
            try {
                const next = new URL(state.next);
                if (
                    next.origin !== 'https://api-v2.soundcloud.com' ||
                    next.pathname !== path ||
                    next.username ||
                    next.password ||
                    next.href.length > 6000
                )
                    return null;
                next.searchParams.delete('client_id');
                next.searchParams.delete('access_token');
                params = Object.fromEntries(next.searchParams);
            } catch {
                return null;
            }
        }
        const page = await this.read(path, params, parseTrackPage);
        if (!page || revision !== this.revision()) return null;
        if (!advance && state) return page.items.slice(0, 24);
        const next = page.next;
        const seen = state?.seen || new Set<string>();
        if (next && seen.has(next)) {
            if (state) state.next = null;
            return page.items.slice(0, 24);
        }
        if (next) seen.add(next);
        this.cursors.set(id, {
            at: state?.at ?? this.now(),
            next,
            seen,
            pages: (advance ? state?.pages || 0 : 0) + 1,
            advanced: advance ? this.now() : (state?.advanced ?? -Infinity),
        });
        while (this.cursors.size > 80) this.cursors.delete(this.cursors.keys().next().value!);
        return page.items.slice(0, 24);
    }
    private async playlist(ref: Reference): Promise<number[] | null> {
        return this.read(
            ref.id ? `/playlists/${ref.id}` : `/system-playlists/${encodeURIComponent(ref.urn!)}`,
            {},
            trackIds,
        );
    }
    async home(): Promise<ApiTrack[] | null> {
        const revision = this.revision();
        const refs = await this.read('/mixed-selections', { limit: '3' }, (value) => {
            const groups = apiObject(value)?.collection;
            if (!Array.isArray(groups)) return null;
            return groups.slice(0, 8).flatMap((group) => {
                const items = apiObject(group)?.items;
                const list = Array.isArray(items) ? items : apiObject(items)?.collection;
                return Array.isArray(list)
                    ? list.slice(0, 10).flatMap((item) => {
                          const ref = reference(item);
                          return ref ? [ref] : [];
                      })
                    : [];
            });
        });
        if (!refs || revision !== this.revision()) return null;
        const direct = refs.flatMap((ref) => (ref.track ? [ref.track] : [])).slice(0, 12);
        const selected = [
            ...new Map(refs.filter((ref) => ref.id || ref.urn).map((ref) => [ref.urn || String(ref.id), ref])).values(),
        ].slice(0, 3);
        const lists = await Promise.all(selected.map((ref) => this.playlist(ref)));
        const ids = [...new Set([...direct, ...lists.flatMap((list) => sample(list || [], 8))])].slice(0, 24);
        const tracks = await this.batch(ids);
        return revision === this.revision()
            ? (tracks?.map((track) => ({ ...track, radioSource: 'home' as const })) ?? null)
            : null;
    }
    async collection(id: number): Promise<ApiTrack[] | null> {
        const cached = this.collections.get(id);
        if (cached && this.now() - cached.at < 10 * 60000) return structuredClone(cached.tracks);
        const revision = this.revision();
        const page = await this.read(
            `/tracks/${id}/playlists_without_albums`,
            { limit: '4', representation: 'mini' },
            (value) => parsePage(value, reference),
        );
        if (!page || revision !== this.revision()) return null;
        const owners = new Set<number>();
        const chosen = page.items
            .filter((ref) => {
                if (!ref.id || !ref.owner || owners.has(ref.owner) || (ref.count !== undefined && ref.count < 5))
                    return false;
                owners.add(ref.owner);
                return true;
            })
            .slice(0, 2);
        const lists = await Promise.all(chosen.map((ref) => this.playlist(ref)));
        const votes = new Map<number, number>();
        for (const list of lists)
            for (const candidate of new Set(list || []))
                if (candidate !== id) votes.set(candidate, (votes.get(candidate) || 0) + 1);
        const repeated = [...votes].filter(([, count]) => count > 1).map(([id]) => id);
        const ids = [
            ...new Set([
                ...repeated,
                ...lists.flatMap((list) =>
                    sample(
                        (list || []).filter((value) => value !== id),
                        8,
                    ),
                ),
            ]),
        ].slice(0, 12);
        const tracks = await this.batch(ids);
        if (!tracks || revision !== this.revision()) return null;
        const result = tracks.map((track) => ({ ...track, radioSource: 'collection' as const }));
        this.collections.set(id, { at: this.now(), tracks: result });
        while (this.collections.size > 40) this.collections.delete(this.collections.keys().next().value!);
        return structuredClone(result);
    }
    async following(id: number): Promise<ApiTrack[] | null> {
        const page = await this.read(
            '/stream',
            { limit: '20' },
            (value) =>
                parsePage(value, (item) => {
                    const entry = apiObject(item);
                    return parseApiTrack(entry?.origin || entry?.track || entry?.sound || item);
                }),
            undefined,
            true,
        );
        const tracks = page?.items;
        return tracks
            ? tracks
                  .filter((track) => track.user?.id !== id)
                  .slice(0, 12)
                  .map((track) => ({ ...track, radioSource: 'following' as const }))
            : null;
    }
    async personal(
        owner: number,
        signal?: AbortSignal,
    ): Promise<{ likes: ApiTrack[]; recent: ApiTrack[]; playlists: ApiTrack[] } | null> {
        const revision = this.revision();
        if (!this.personalState || this.personalState.owner !== owner)
            this.personalState = { owner, at: -Infinity, pages: 0, offset: 0 };
        const state = this.personalState;
        if (this.now() - state.at < 5 * 60000) return null;
        state.at = this.now();
        const historyPath = '/me/play-history/tracks';
        let query: Record<string, string> = { limit: '100', linked_partitioning: '1' };
        if (state.cursor) {
            try {
                const next = new URL(state.cursor);
                if (
                    next.origin !== 'https://api-v2.soundcloud.com' ||
                    next.pathname !== historyPath ||
                    next.username ||
                    next.password ||
                    next.href.length > 6000
                )
                    throw Error('Invalid history continuation');
                next.searchParams.delete('client_id');
                next.searchParams.delete('access_token');
                query = Object.fromEntries(next.searchParams);
            } catch {
                state.cursor = null;
            }
        }
        const [own, saved, history] = await Promise.all([
            this.read(
                `/users/${owner}/playlists`,
                { limit: '4', representation: 'mini' },
                (value) => parsePage(value, reference),
                signal,
                true,
                true,
            ),
            this.read(
                '/me/playlist_likes/ids',
                { limit: '20' },
                (value) => parsePage(value, (item) => (apiId(item) ? item : null)),
                signal,
                true,
                true,
            ),
            state.cursor !== null && state.pages < 4
                ? this.read(historyPath, query, parseTrackPage, signal, true, true)
                : null,
        ]);
        signal?.throwIfAborted();
        if (revision !== this.revision()) return null;
        if (history) {
            state.pages++;
            state.cursor = history.next === state.cursor ? null : history.next;
        }
        const refs = [...(own?.items || []), ...(saved?.items || []).map((id) => ({ id }))];
        const selected = [...new Map(refs.filter((ref) => ref.id).map((ref) => [ref.id, ref])).values()];
        const chosen = selected.length
            ? Array.from(
                  { length: Math.min(3, selected.length) },
                  (_, i) => selected[(state.offset + i) % selected.length],
              )
            : [];
        const lists = await Promise.all(
            chosen.map((ref) => this.read(`/playlists/${ref.id}`, {}, trackIds, signal, true, true)),
        );
        const library = this.library?.owner === owner ? this.library : undefined;
        const likedIds = library ? [...library.likes.ids].filter((id) => this.reactions.get(id) !== false) : [];
        const likedSample =
            likedIds.length <= 12
                ? likedIds
                : Array.from(
                      { length: 12 },
                      (_, i) => likedIds[(Math.floor((i * likedIds.length) / 12) + state.offset) % likedIds.length],
                  );
        const ids = [...new Set([...likedSample, ...lists.flatMap((list) => sample(list || [], 6))])].slice(0, 30);
        const tracks = await this.batch(ids, true);
        signal?.throwIfAborted();
        if (revision !== this.revision()) return null;
        state.offset += 3;
        const liked = new Set(likedSample.filter((id) => this.reactions.get(id) !== false));
        return {
            likes: (tracks || []).filter((track) => liked.has(track.id)),
            recent: history?.items || [],
            playlists: (tracks || [])
                .filter((track) => !liked.has(track.id))
                .map((track) => ({ ...track, radioSource: 'collection' as const })),
        };
    }
    private async extra(
        key: string,
        path: string,
        params: Record<string, string>,
        source: ApiTrack['radioSource'],
    ): Promise<ApiTrack[] | null> {
        const hit = this.extras.get(key);
        if (hit && this.now() - hit.at < 10 * 60000) return structuredClone(hit.tracks);
        const revision = this.revision();
        const page = await this.read(path, params, parseTrackPage, undefined, false, true);
        if (revision !== this.revision()) return null;
        if (!page) {
            this.extras.set(key, { at: this.now(), tracks: [] });
            while (this.extras.size > 40) this.extras.delete(this.extras.keys().next().value!);
            return null;
        }
        const tracks = await this.batch(
            page.items.slice(0, Math.min(12, Number(params.limit) || 12)).map((track) => track.id),
            true,
        );
        if (!tracks || revision !== this.revision()) return null;
        const result = tracks.map((track) => ({ ...track, radioSource: source }));
        this.extras.set(key, { at: this.now(), tracks: result });
        while (this.extras.size > 40) this.extras.delete(this.extras.keys().next().value!);
        return structuredClone(result);
    }
    artist(owner: number): Promise<ApiTrack[] | null> {
        return this.extra('artist:' + owner, `/users/${owner}/toptracks`, { limit: '4' }, 'artist');
    }
}
type IdProgress = {
    ids: Set<number>;
    next?: string | null;
    seen: Set<string>;
    failed?: boolean;
    failures?: number;
    retryAt?: number;
};
export interface LibrarySignals {
    likedIds: number[];
    blockedIds: number[];
    likesComplete: boolean;
    blocksComplete: boolean;
    more: boolean;
}
