import { loadSourcePlaylist, fetchPublic } from '../../src/import/loadSource';
import { matchIdentity, matchQueries } from '../../src/import/matchIdentity';
import { classifyTrackAvailability } from '../../src/import/availability';
import type { SourcePlaylist, SourceTrack } from '../../src/import/source';
import type { ImportJob } from '../../src/import/importJournal';
import type { ImportMatch } from '../../src/import/match';
import { Events, Profile, api } from './bridge';
import { createPlaylist, updatePlaylist } from './playlists';
import { net } from './platform';
import { completeSpotify } from './spotify';
import { PlaylistRequestError } from './playlistErrors';

type Draft = Omit<ImportJob, 'matches' | 'title' | 'savedUrls'> & {
    matches: (ImportMatch & { pending?: boolean })[];
    title: string;
    savedUrls: string[];
    partial: boolean;
    partialReason?: SourcePlaylist['partialReason'];
    selectedIndexes?: number[];
};

export class Importer {
    private events = new Events();
    private abort?: AbortController;
    private result?: Draft;
    private running = false;
    private profile?: Profile;
    private owner = 0;
    private committing?: Promise<unknown>;
    private phase = 'idle';
    private failure?: { phase: string; status: number; transport?: string; message: string };
    diagnostics() {
        return {
            phase: this.phase,
            running: this.running,
            saving: Boolean(this.committing),
            tracks: this.result?.matches.length || 0,
            matches: this.result?.matches.filter((match) => match.soundcloud).length || 0,
            saved: this.result?.savedUrls.length || 0,
            playlistId: this.result?.writtenPlaylistId,
            pendingCreation: Boolean(this.result?.writeIntent),
            failure: this.failure,
        };
    }
    private progress(state: { phase: string; [key: string]: unknown }): void {
        this.phase = state.phase;
        this.events.emit('progress', state);
    }
    onProgress = (callback: (state: any) => void) => this.events.on('progress', callback);
    private async journal(checkAccount = false): Promise<Profile> {
        if (!this.profile || checkAccount) {
            const user = await api('me');
            if (!Number.isSafeInteger(user.id) || user.id <= 0) throw Error('Sign in to SoundCloud first');
            if (!this.profile || this.owner !== user.id) {
                this.cancel();
                const profile = new Profile('import-' + user.id);
                await profile.load();
                this.profile = profile;
                this.owner = user.id;
                this.result = profile.get('draft') as typeof this.result;
                if (this.result) {
                    this.result.id ||= crypto.randomUUID();
                    this.result.updatedAt ||= Date.now();
                    this.result.selected ??= this.result.selectedIndexes;
                    this.result.savedUrls ||= [];
                }
            }
        }
        return this.profile;
    }
    private async checkpoint(durable = false): Promise<void> {
        const profile = await this.journal();
        profile.set('draft', this.result);
        await profile.flush(durable);
    }
    draft = async () => {
        await this.journal(true);
        return this.result;
    };
    selection = (selection: { indexes: number[]; title: string }) => {
        if (this.result) {
            this.result.selected = [...new Set(selection.indexes)].filter(
                (index) => Number.isInteger(index) && index >= 0 && index < this.result!.matches.length,
            );
            this.result.title = selection.title;
            void this.checkpoint().catch(console.error);
        }
    };
    cancel = () => this.abort?.abort();
    useCreatedPlaylist = async ({ title }: { title: string }) => {
        if (this.running || this.committing) throw Error('Import already running');
        await this.journal(true);
        const result = this.result,
            owner = this.owner;
        if (!result) throw Error('Find tracks first');
        const name = title.trim();
        if (!name || [...name].length > 100) throw Error('Playlist title must contain 1–100 characters');
        const path = `/users/${owner}/playlists`;
        let params: Record<string, string> = { limit: '200', linked_partitioning: '1' };
        const ids = new Set<number>(),
            seen = new Set<string>();
        for (let page = 0; ; page++) {
            if (page >= 20) throw Error('Could not read the complete playlist list');
            const value = await api('radio', { path, params }, true);
            if (!Array.isArray(value.collection)) throw Error('Could not read your SoundCloud playlists');
            for (const item of value.collection)
                if (item.title === name && Number.isSafeInteger(item.id) && item.id > 0) ids.add(item.id);
            if (!value.next_href) break;
            const next = new URL(value.next_href);
            if (
                next.origin !== 'https://api-v2.soundcloud.com' ||
                next.pathname !== path ||
                next.username ||
                next.password ||
                seen.has(next.href)
            )
                throw Error('Could not read the complete playlist list');
            seen.add(next.href);
            params = Object.fromEntries(
                [...next.searchParams].filter(([key]) =>
                    ['limit', 'linked_partitioning', 'representation', 'offset', 'cursor'].includes(key),
                ),
            );
            if (!params.offset && !params.cursor) throw Error('Could not read the complete playlist list');
        }
        if (ids.size !== 1)
            throw Error(
                ids.size
                    ? 'В SoundCloud несколько плейлистов с таким названием. Уточните название перед импортом.'
                    : 'Создайте плейлист в SoundCloud с указанным названием и повторите выбор.',
            );
        const id = [...ids][0],
            playlist = await this.readTarget(id, owner);
        await this.assertOwner(owner);
        if (this.result !== result) throw Error('Import changed');
        result.writtenPlaylistId = id;
        result.writtenAccountId = owner;
        result.writtenTitle = result.title = name;
        result.writeIntent = undefined;
        const have = new Set(playlist.tracks.map((track: any) => track.id));
        result.savedUrls = result.matches.flatMap((match) =>
            match.soundcloud && have.has(match.soundcloud.apiId) ? [match.soundcloud.url] : [],
        );
        await this.checkpoint(true);
        this.failure = undefined;
        return result;
    };
    resume = async () => {
        if (this.running || this.committing) throw Error('Import already running');
        await this.journal(true);
        return this.result
            ? this.scanSource(this.result.source, this.result)
            : Promise.reject(new Error('No unfinished import'));
    };
    scanFile = async () => {
        const file = await new Promise<File | undefined>((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.csv,.tsv,.txt';
            input.onchange = () => resolve(input.files?.[0]);
            input.addEventListener('cancel', () => resolve(undefined));
            input.click();
        });
        if (!file) return { cancelled: true };
        if (file.size > 4_000_000) throw new Error('CSV/TXT file exceeds 4 MB');
        const { parseLocalPlaylist } = await import('../../src/import/localSourceParsing');
        return this.scanSource(parseLocalPlaylist(await file.text(), file.name));
    };
    scan = async (link: string) => {
        if (this.running || this.committing) throw new Error('Import already running');
        await this.journal(true);
        const owner = this.owner;
        this.running = true;
        this.abort = new AbortController();
        try {
            let source = await loadSourcePlaylist(link, this.abort.signal, {
                direct: (url, signal, init) => fetchPublic(url, signal, init, net.fetch as typeof fetch, 15000),
                onPage: (page) =>
                    this.progress({
                        phase: 'source',
                        completed: page.tracks.length,
                        total: page.expectedTracks || 0,
                    }),
            });
            source = await completeSpotify(source, link, owner, this.abort.signal, (page) =>
                this.progress({
                    phase: 'source',
                    completed: page.tracks.length,
                    total: page.expectedTracks || 0,
                }),
            );
            if (this.abort.signal.aborted) throw this.abort.signal.reason;
            await this.assertOwner(owner);
            this.running = false;
            return await this.scanSource(source);
        } finally {
            this.running = false;
        }
    };
    private async find(source: SourceTrack, signal: AbortSignal): Promise<any> {
        for (const query of matchQueries(source)) {
            signal.throwIfAborted();
            const result = await api('search', { query }, true);
            const ranked = (result.collection || [])
                .map((track: any) => ({
                    raw: track,
                    ...matchIdentity(source, {
                        title: track.title || '',
                        artist: track.user?.username || '',
                        publisherArtist: track.publisher_metadata?.artist,
                        description: track.description,
                        durationSeconds: Number(track.duration) / 1000 || undefined,
                    }),
                }))
                .sort((a: any, b: any) => b.score - a.score);
            for (const item of ranked) {
                if (item.score < 0.78 || classifyTrackAvailability(item.raw).status !== 'available') continue;
                return {
                    source,
                    selected: !item.requiresReview,
                    soundcloud: {
                        apiId: item.raw.id,
                        url: item.raw.permalink_url,
                        title: item.raw.title,
                        artist: item.raw.user?.username || '',
                        score: item.score,
                        sourceQuery: query,
                        requiresReview: item.requiresReview,
                        reviewReason: item.reviewReason,
                    },
                };
            }
        }
        return { source, error: 'В SoundCloud не найдено' };
    }
    private async scanSource(source: SourcePlaylist, previous?: Draft) {
        if (this.running || this.committing) throw new Error('Import already running');
        await this.journal(true);
        const identity = (value: SourcePlaylist) =>
            JSON.stringify([
                value.platform,
                value.title,
                value.tracks.map((track) => track.sourceId || [track.artist, track.title, track.durationSeconds]),
            ]);
        if (!previous && this.result && identity(this.result.source) === identity(source)) previous = this.result;
        this.running = true;
        this.abort ||= new AbortController();
        if (this.abort.signal.aborted) this.abort = new AbortController();
        const signal = this.abort.signal;
        const matches = source.tracks
            .slice(0, 500)
            .map((track, index) =>
                previous?.matches[index]?.soundcloud ? previous.matches[index] : { source: track, pending: true },
            );
        const result: Draft = (this.result = {
            ...previous,
            id: previous?.id || crypto.randomUUID(),
            updatedAt: Date.now(),
            source,
            matches,
            title: previous?.title || source.title,
            partial: source.partial,
            partialReason: source.partialReason,
            savedUrls: previous?.savedUrls || [],
        });
        this.progress({
            phase: 'matching',
            tracks: source.tracks,
            title: result.title,
            completed: 0,
            total: matches.length,
        });
        let cursor = 0,
            completed = matches.filter((match) => match.soundcloud).length;
        try {
            await Promise.all(
                Array.from({ length: Math.min(10, matches.length) }, async () => {
                    for (;;) {
                        const index = cursor++;
                        if (index >= matches.length || signal.aborted || this.result !== result) return;
                        if (matches[index].soundcloud) continue;
                        try {
                            matches[index] = await this.find(source.tracks[index], signal);
                        } catch (error) {
                            matches[index] = {
                                source: source.tracks[index],
                                error: error instanceof Error ? error.message : String(error),
                            };
                        }
                        completed++;
                        if (this.result !== result) return;
                        if (completed % 10 === 0) await this.checkpoint();
                        this.progress({
                            phase: 'matching',
                            index,
                            match: matches[index],
                            completed,
                            total: matches.length,
                        });
                    }
                }),
            );
            for (const match of matches)
                if (match.pending) {
                    match.pending = false;
                    match.error = 'Проверка остановлена.';
                }
            return result;
        } finally {
            this.running = false;
            if (this.result === result) await this.checkpoint();
        }
    }
    private async assertOwner(owner: number): Promise<void> {
        if (!owner || (await api('me')).id !== owner)
            throw Error('SoundCloud account changed; reopen the import for this account');
    }

    commit = async (selection: { indexes: number[]; title: string }): Promise<any> => {
        if (this.committing) return this.committing;
        if (this.running) throw Error('Wait for track matching to finish');
        this.failure = undefined;
        const task = this.commitOnce(selection);
        this.committing = task;
        try {
            return await task;
        } catch (error) {
            this.failure = {
                phase: this.phase,
                status:
                    error instanceof PlaylistRequestError
                        ? error.status
                        : Number(String(error).match(/HTTP (\d{3})\b/)?.[1]) || 0,
                transport: error instanceof PlaylistRequestError ? error.transport : undefined,
                message: error instanceof Error ? error.message.slice(0, 600) : 'Playlist saving failed',
            };
            throw error;
        } finally {
            this.committing = undefined;
        }
    };

    private async readTarget(id: number, owner: number): Promise<any> {
        const value = await api('playlist', { id });
        const playlist = value.playlist || value;
        if (playlist.id !== id) throw Error('SoundCloud returned a different playlist');
        if (playlist.user?.id !== owner && playlist.user_id !== owner)
            throw Error('Playlist belongs to another SoundCloud account');
        if (
            !Array.isArray(playlist.tracks) ||
            (playlist.track_count ?? playlist.tracks.length) !== playlist.tracks.length
        )
            throw Error('SoundCloud has not returned the full target playlist. Retry after it finishes loading.');
        if (playlist.tracks.some((track: any) => !Number.isSafeInteger(track.id) || track.id <= 0))
            throw Error('Incomplete playlist track IDs');
        return playlist;
    }

    private async commitOnce({ indexes, title }: { indexes: number[]; title: string }) {
        if (!this.result) throw new Error('Find tracks first');
        const result = this.result,
            owner = this.owner;
        await this.assertOwner(owner);
        const selected = [...new Set(indexes)]
            .filter((index) => Number.isInteger(index) && index >= 0 && index < this.result!.matches.length)
            .flatMap((index) =>
                this.result!.matches[index].soundcloud ? [this.result!.matches[index].soundcloud] : [],
            );
        const unique = [
            ...new Map(
                selected
                    .filter((track) => Number.isSafeInteger(track.apiId) && track.apiId! > 0)
                    .map((track) => [track.apiId, track]),
            ).values(),
        ];
        if (!unique.length) throw new Error('Select at least one available track');
        const verified: any[] = [];
        const verifiedIds = new Set<number>();
        this.progress({ phase: 'checking', completed: 0, total: unique.length });
        for (let offset = 0; offset < unique.length; offset += 50) {
            const data = await api<any[]>(
                'tracks',
                { ids: unique.slice(offset, offset + 50).map((track) => track.apiId) },
                true,
            );
            const requested = new Set(unique.slice(offset, offset + 50).map((track) => track.apiId));
            if (!Array.isArray(data)) throw Error('SoundCloud returned invalid track metadata');
            for (const track of data) {
                if (
                    requested.has(track?.id) &&
                    !verifiedIds.has(track.id) &&
                    classifyTrackAvailability(track).status === 'available'
                ) {
                    verifiedIds.add(track.id);
                    verified.push(track);
                }
            }
            this.progress({ phase: 'checking', completed: Math.min(offset + 50, unique.length), total: unique.length });
        }
        if (!verified.length) throw new Error('SoundCloud cannot play any selected tracks');
        await this.assertOwner(owner);
        if (this.result !== result) throw Error('Import changed');
        const targetTitle = title.trim() || result.title;
        if (!targetTitle.trim() || [...targetTitle].length > 100)
            throw Error('Playlist title must contain 1–100 characters');
        if (result.writtenAccountId && result.writtenAccountId !== owner)
            throw Error('Playlist belongs to another SoundCloud account');
        if (!result.writtenPlaylistId && result.writeIntent) {
            const listed = await api('radio', { path: `/users/${owner}/playlists`, params: { limit: '200' } }, true);
            const same = (listed.collection || []).filter((item: any) => item.title === result.writeIntent!.title);
            const found = [];
            for (const item of same.slice(0, 10)) {
                const candidate = await this.readTarget(item.id, owner);
                const have = new Set(candidate.tracks.map((track: any) => track.id));
                const created = Date.parse(candidate.created_at);
                if (
                    candidate.sharing === 'private' &&
                    Number.isFinite(created) &&
                    created >= result.writeIntent.startedAt - 10000 &&
                    have.size === result.writeIntent.trackIds.length &&
                    result.writeIntent.trackIds.every((id) => have.has(id))
                )
                    found.push(candidate);
            }
            if (found.length !== 1)
                throw Error(
                    'Previous playlist creation is not yet confirmed. Retry after checking your SoundCloud playlists; a duplicate was not created.',
                );
            result.writtenPlaylistId = found[0].id;
            result.writtenAccountId = owner;
            await this.checkpoint(true);
        }
        let playlist = result.writtenPlaylistId ? await this.readTarget(result.writtenPlaylistId, owner) : undefined;
        const initialIds = new Set<number>(playlist?.tracks.map((track: any) => track.id) || []);
        const rememberSaved = async () => {
            result.writeIntent = undefined;
            result.title = targetTitle;
            result.writtenTitle = targetTitle;
            const confirmed = new Set(playlist.tracks.map((track: any) => track.id));
            result.savedUrls = [
                ...new Set([
                    ...result.savedUrls,
                    ...verified.filter((track) => confirmed.has(track.id)).map((track) => track.permalink_url),
                ]),
            ];
            await this.checkpoint(true);
            this.progress({
                phase: 'adding',
                completed: verified.filter((track) => confirmed.has(track.id)).length,
                total: verified.length,
                title: targetTitle,
            });
        };
        if (!playlist) {
            this.progress({ phase: 'creating', completed: 0, total: verified.length });
            result.writeIntent = { title: targetTitle, trackIds: [verified[0].id], startedAt: Date.now() };
            await this.checkpoint(true);
            let created;
            try {
                created = await createPlaylist(targetTitle, result.writeIntent.trackIds, api, undefined, owner);
            } catch (error) {
                if (
                    (error instanceof PlaylistRequestError && error.definite && error.action === 'create') ||
                    /HTTP (400|401|403|404|409|422|429) \(POST \/playlists\)/.test(String(error))
                ) {
                    result.writeIntent = undefined;
                    await this.checkpoint(true);
                }
                throw error;
            }
            result.writtenPlaylistId = (created.playlist || created).id;
            if (!Number.isSafeInteger(result.writtenPlaylistId) || result.writtenPlaylistId! <= 0)
                throw Error('SoundCloud did not confirm the playlist ID');
            result.writtenAccountId = owner;
            await this.checkpoint(true);
            playlist = await this.readTarget(result.writtenPlaylistId!, owner);
            if (!playlist.tracks.some((track: any) => track.id === verified[0].id))
                throw Error('SoundCloud has not confirmed the first track. Retry to continue.');
            await rememberSaved();
        }
        for (let offset = 0; offset < verified.length; offset += 50) {
            await this.assertOwner(owner);
            const have = new Set<number>(playlist?.tracks.map((track: any) => track.id) || []);
            const chunk = verified.slice(offset, offset + 50).filter((track) => !have.has(track.id));
            if (chunk.length || playlist?.title !== targetTitle) {
                const ids = [...have, ...chunk.map((track) => track.id)];
                if (ids.length > 500)
                    throw Error('SoundCloud playlist limit is 500 tracks; the saved part was preserved');
                await updatePlaylist(playlist.id, targetTitle, ids, owner);
                playlist = await this.readTarget(result.writtenPlaylistId!, owner);
                if (!chunk.every((track) => playlist.tracks.some((saved: any) => saved.id === track.id)))
                    throw Error(
                        'SoundCloud has not confirmed every added track. The saved part was preserved; retry to continue.',
                    );
            }
            await rememberSaved();
        }
        const urls = verified.map((track) => track.permalink_url);
        return {
            playlistId: playlist.id,
            title: playlist.title,
            added: verified.filter((track) => !initialIds.has(track.id)).length,
            already: verified.filter((track) => initialIds.has(track.id)).length,
            failures: unique.length > verified.length ? ['unavailable'] : [],
            unmatched: this.result.matches.length - selected.length,
            duplicates: selected.length - unique.length,
            successfulUrls: urls,
        };
    }
}
