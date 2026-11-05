import type { ImportMatch } from '../import/match';
import type { PartialPlaylistResult } from '../import/partialPlaylist';
import { mapImportTracks } from '../import/parallel';
import { classifyTrackAvailability } from '../import/availability';
import { SoundCloudCatalog } from './catalog';
import { ApiWriteError, apiId, type ApiPlaylist } from './accountTypes';

export async function saveApiPlaylist(
    catalog: SoundCloudCatalog,
    items: readonly ImportMatch[],
    options: {
        title: string;
        playlistId?: number;
        accountId?: number;
        signal?: AbortSignal;
        concurrency: number;
        target: (id: number, accountId: number) => void;
        saved?: (item: ImportMatch, outcome: 'added' | 'already') => void;
        progress: (completed: number, total: number, title: string) => void;
    },
): Promise<PartialPlaylistResult<ImportMatch> | null> {
    options.signal?.throwIfAborted();
    const scope = await catalog.profile(options.signal);
    if (!scope) return null;
    let target: ApiPlaylist | null = null;
    if (options.playlistId) {
        if (options.accountId !== scope.id)
            throw new Error('Целевой плейлист относится к другому аккаунту SoundCloud.');
        target = await catalog.playlist(options.playlistId, scope, options.signal);
        if (!target?.complete)
            throw new Error('Не удалось полностью прочитать целевой плейлист. Повторите добавление.');
    } else {
        const existing = await catalog.ownPlaylists(scope, options.signal);
        if (!existing) return null;
        const same = existing.filter(
            (item) => item.title.trim().toLocaleLowerCase() === options.title.trim().toLocaleLowerCase(),
        );
        if (same.length > 1)
            throw new Error('В SoundCloud несколько плейлистов с таким названием. Уточните название перед импортом.');
        if (same.length) {
            target = await catalog.playlist(same[0].id, scope, options.signal);
            if (!target?.complete) return null;
        }
    }
    await catalog.prime(
        items.flatMap((item) => (apiId(item.soundcloud?.apiId) ? [item.soundcloud.apiId] : [])),
        options.signal,
    );
    const resolved = await mapImportTracks(items, {
        concurrency: options.concurrency,
        signal: options.signal,
        run: async (item) => ({ item, track: await catalog.resolve(item.soundcloud!.url, 'import', options.signal) }),
    });
    if (resolved.some((item) => !item.track)) return null;
    const result: PartialPlaylistResult<ImportMatch> = { added: 0, already: 0, successful: [], failures: [] };
    const finished = new Set<ImportMatch>();
    const failure = (item: ImportMatch, reason: string) => {
        if (finished.has(item)) return;
        finished.add(item);
        result.failures.push({ title: item.source.title, reason });
        options.progress(finished.size, items.length, item.source.title);
    };
    const success = (item: ImportMatch, outcome: 'added' | 'already') => {
        if (finished.has(item)) return;
        finished.add(item);
        result[outcome]++;
        result.successful.push(item);
        options.saved?.(item, outcome);
        options.progress(finished.size, items.length, item.source.title);
    };
    const available = resolved.filter((entry) => {
        const state = classifyTrackAvailability(entry.track!);
        if (state.status !== 'available') {
            failure(entry.item, state.reason);
            return false;
        }
        return true;
    }) as { item: ImportMatch; track: NonNullable<(typeof resolved)[number]['track']> }[];
    const publishTarget = () => {
        if (target) options.target(target.id, scope.id);
    };
    if (target) publishTarget();
    const readBack = async () => {
        if (!target) return null;
        const value = await catalog.playlist(target.id, scope, options.signal);
        if (value?.complete) target = value;
        return value?.complete ? value : null;
    };
    let first = 0;
    while (!target && first < available.length) {
        const entry = available[first++];
        try {
            target = await catalog.createPlaylist(scope, options.title, [entry.track.id], options.signal);
            if (target.ownerId !== scope.id) throw new ApiWriteError(0, true);
            publishTarget();
            const confirmed = target.complete ? target : await readBack();
            if (!confirmed?.trackIds.includes(entry.track.id)) throw new ApiWriteError(0, true);
            success(entry.item, 'added');
        } catch (error) {
            options.signal?.throwIfAborted();
            if (error instanceof ApiWriteError && error.uncertain && !target) {
                const candidates = await catalog.ownPlaylists(scope, options.signal);
                const same = candidates?.filter((item) => item.title === options.title);
                if (same?.length === 1) {
                    target = await catalog.playlist(same[0].id, scope, options.signal);
                    if (target) publishTarget();
                }
                if (target?.complete && target.trackIds.includes(entry.track.id)) {
                    success(entry.item, 'added');
                    break;
                }
            }
            if (!target && error instanceof ApiWriteError && !error.uncertain && [401, 403].includes(error.status))
                return null;
            if (target || !(error instanceof ApiWriteError) || error.fatal) throw error;
            failure(entry.item, error.message);
        }
    }
    if (!target) return result;
    const append = async (entries: typeof available): Promise<void> => {
        options.signal?.throwIfAborted();
        const current = await readBack();
        if (!current) throw new ApiWriteError(0, true);
        const have = new Set(current.trackIds),
            pending = entries.filter((entry) => !have.has(entry.track.id));
        for (const entry of entries) if (have.has(entry.track.id)) success(entry.item, 'already');
        if (!pending.length) return;
        if (current.trackIds.length + pending.length > 500) {
            const room = Math.max(0, 500 - current.trackIds.length);
            if (room) await append(pending.slice(0, room));
            for (const entry of pending.slice(room)) failure(entry.item, 'Плейлист SoundCloud ограничен 500 треками.');
            return;
        }
        try {
            await catalog.updatePlaylist(
                scope,
                current.id,
                [...current.trackIds, ...pending.map((entry) => entry.track.id)],
                options.signal,
            );
            const confirmed = await readBack();
            if (!confirmed || pending.some((entry) => !confirmed.trackIds.includes(entry.track.id)))
                throw new ApiWriteError(0, true);
            for (const entry of pending) success(entry.item, 'added');
        } catch (error) {
            options.signal?.throwIfAborted();
            const confirmed = await readBack();
            if (confirmed && pending.every((entry) => confirmed.trackIds.includes(entry.track.id))) {
                for (const entry of pending) success(entry.item, 'added');
                return;
            }
            if (error instanceof ApiWriteError && !error.fatal && confirmed) {
                if (pending.length === 1) {
                    failure(pending[0].item, error.message);
                    return;
                }
                const split = Math.ceil(pending.length / 2);
                await append(pending.slice(0, split));
                await append(pending.slice(split));
                return;
            }
            if (confirmed)
                for (const entry of pending)
                    if (confirmed.trackIds.includes(entry.track.id)) success(entry.item, 'added');
            throw error;
        }
    };
    try {
        for (let index = first; index < available.length; index += 20) await append(available.slice(index, index + 20));
    } catch (error) {
        options.signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : 'SoundCloud не подтвердил сохранение плейлиста.';
        for (const entry of available) failure(entry.item, message);
        if (!result.successful.length) throw error;
    }
    return result;
}
