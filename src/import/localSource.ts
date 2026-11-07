import { open } from 'node:fs/promises';
import type { SourcePlaylist } from './source';
import { parseLocalPlaylist } from './localSourceParsing';
export { parseLocalPlaylist } from './localSourceParsing';
const limit = 4000000;
export async function loadLocalPlaylist(file: string, signal?: AbortSignal): Promise<SourcePlaylist> {
    const handle = await open(file, 'r');
    try {
        signal?.throwIfAborted();
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('Выберите CSV/TXT размером не более 4 МБ.');
        const text = await handle.readFile({ encoding: 'utf8' });
        signal?.throwIfAborted();
        return parseLocalPlaylist(text, file);
    } finally {
        await handle.close();
    }
}
