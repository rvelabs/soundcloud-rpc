import { open } from 'node:fs/promises';
import path from 'node:path';
import type { SourcePlaylist, SourceTrack } from './source';
const limit = 4000000;
const normalize = (value: string) => value.toLowerCase().replace(/[^a-zа-яё]/gu, '');
function rows(text: string, delimiter: string): string[][] {
    const result: string[][] = [];
    let row: string[] = [],
        cell = '',
        quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (quoted && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else quoted = !quoted;
        } else if (!quoted && char === delimiter) {
            row.push(cell);
            cell = '';
        } else if (!quoted && (char === '\n' || char === '\r')) {
            if (char === '\r' && text[i + 1] === '\n') i++;
            row.push(cell);
            result.push(row);
            row = [];
            cell = '';
        } else cell += char;
    }
    if (quoted) throw new Error('В CSV не закрыты кавычки. Проверьте файл экспорта.');
    if (cell || row.length) {
        row.push(cell);
        result.push(row);
    }
    return result;
}
export function parseLocalPlaylist(text: string, name: string): SourcePlaylist {
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('Файл плейлиста слишком велик. Максимум 4 МБ.');
    text = text.replace(/^\uFEFF/, '');
    let tracks: SourceTrack[] = [],
        title = path.basename(name, path.extname(name));
    const titleHeaders = ['trackname', 'tracktitle', 'title', 'name', 'название', 'названиетрека', 'трек'];
    const artistHeaders = ['artistnames', 'artistname', 'artist', 'artists', 'исполнитель', 'исполнители', 'автор'];
    let parsed = false;
    for (const delimiter of [',', ';', '\t']) {
        let header: string[];
        try {
            header = rows(text.split(/\r?\n/, 1)[0], delimiter)[0]?.map(normalize) || [];
        } catch {
            continue;
        }
        const ti = header.findIndex((item) => titleHeaders.includes(item)),
            ai = header.findIndex((item) => artistHeaders.includes(item));
        if (ti < 0 || ai < 0) continue;
        const data = rows(text, delimiter);
        const pi = header.findIndex((item) => ['playlistname', 'playlisttitle', 'плейлист'].includes(item));
        for (const row of data.slice(1)) {
            if (pi >= 0 && row[pi]?.trim()) title = row[pi].trim();
            tracks.push({ title: row[ti] || '', artist: row[ai] || '' });
        }
        parsed = true;
        break;
    }
    if (!parsed)
        tracks = text.split(/\r?\n/).flatMap((line) => {
            const match = line.trim().match(/^(.+?)\s+[—–-]\s+(.+)$/u);
            return match ? [{ artist: match[1], title: match[2] }] : [];
        });
    const seen = new Set<string>(),
        unique: SourceTrack[] = [];
    for (const track of tracks) {
        const clean = {
            title: track.title.replace(/\s+/g, ' ').trim().slice(0, 200),
            artist: track.artist.replace(/\s+/g, ' ').trim().slice(0, 200),
        };
        const key = clean.title.toLowerCase() + '\0' + clean.artist.toLowerCase();
        if (!clean.title || !clean.artist || seen.has(key)) continue;
        seen.add(key);
        unique.push(clean);
    }
    if (!unique.length)
        throw new Error(
            'Нужны названия треков и исполнители: CSV с колонками Track Name / Artist Name(s) или TXT «Исполнитель — Название». Одних ссылок недостаточно.',
        );
    return {
        platform: 'file',
        title: title.trim().slice(0, 100) || 'Импортированный плейлист',
        tracks: unique.slice(0, 500),
        partial: unique.length > 500,
    };
}
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
