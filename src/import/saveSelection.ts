import type { ImportMatch } from './match';
import type { TrackAvailability } from './availability';
import { mapImportTracks } from './parallel';
import { writePartialPlaylist } from './partialPlaylist';
export async function saveImportSelection(
    matches: readonly ImportMatch[],
    options: {
        check: (url: string) => Promise<TrackAvailability>;
        create: (item: ImportMatch) => Promise<'added' | 'already'>;
        add: (item: ImportMatch) => Promise<'added' | 'already'>;
        concurrency: number;
        signal?: AbortSignal;
        stopOnError?: (error: unknown) => boolean;
        progress: (phase: 'checking' | 'creating' | 'adding', completed: number, total: number, title: string) => void;
    },
) {
    const chosen = matches.filter((item) => item.soundcloud);
    options.progress('checking', 0, chosen.length, '');
    const checks = await mapImportTracks(chosen, {
        concurrency: options.concurrency,
        signal: options.signal,
        run: async (item) => {
            let current: TrackAvailability;
            try {
                current = await options.check(item.soundcloud!.url);
            } catch {
                options.signal?.throwIfAborted();
                current = {
                    status: 'unknown',
                    reason: 'SoundCloud не ответил при проверке доступности.',
                    checkedAt: Date.now(),
                };
            }
            const previous = item.soundcloud!.availability,
                age = previous ? Date.now() - previous.checkedAt : Infinity;
            const effective =
                current.status === 'unknown' && previous?.status === 'available' && age >= 0 && age <= 5 * 60 * 1000
                    ? previous
                    : current;
            return { item, availability: effective };
        },
        onComplete: (_result, _index, completed) => options.progress('checking', completed, chosen.length, ''),
    });
    const available = checks
        .filter((result) => result.availability.status === 'available')
        .map((result) => result.item);
    const failures = checks
        .filter((result) => result.availability.status !== 'available')
        .map((result) => ({ title: result.item.source.title, reason: result.availability.reason }));
    if (!available.length)
        throw new Error(
            checks.some((result) => result.availability.status === 'unknown')
                ? 'SoundCloud не подтвердил доступность. Найденные совпадения сохранены — повторите добавление.'
                : 'Доступные полные версии не найдены. Плейлист не создан. Повторите поиск.',
        );
    options.progress('creating', 0, available.length, '');
    const result = await writePartialPlaylist(available, {
        title: (item) => item.source.title,
        create: options.create,
        add: options.add,
        signal: options.signal,
        stopOnError: options.stopOnError,
        progress: (completed, item) => options.progress('adding', completed, available.length, item.source.title),
    });
    return { ...result, failures: [...failures, ...result.failures] };
}
