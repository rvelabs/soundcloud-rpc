export async function writePartialPlaylist<T>(
    items: readonly T[],
    options: {
        title: (item: T) => string;
        create: (item: T) => Promise<'added' | 'already'>;
        add: (item: T) => Promise<'added' | 'already'>;
        progress: (completed: number, item: T) => void;
    },
): Promise<{
    added: number;
    already: number;
    successful: T[];
    failures: {
        title: string;
        reason: string;
    }[];
}> {
    let created = false,
        added = 0,
        already = 0;
    const successful: T[] = [],
        failures: {
            title: string;
            reason: string;
        }[] = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        try {
            const outcome = await (created ? options.add(item) : options.create(item));
            created = true;
            if (outcome === 'added') added++;
            else already++;
            successful.push(item);
        } catch (error) {
            failures.push({
                title: options.title(item),
                reason: error instanceof Error ? error.message : 'Не удалось добавить трек.',
            });
        }
        options.progress(index + 1, item);
    }
    return { added, already, successful, failures };
}
