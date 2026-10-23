import type { WebContents } from 'electron';
import type { WaveCandidate } from './waveEngine';
const root = 'https://soundcloud.com';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function extractWaveLinks(): WaveCandidate[] {
    const tracks: WaveCandidate[] = [];
    const seen = new Set<string>();
    const anchors = document.querySelectorAll<HTMLAnchorElement>(
        'a.soundTitle__title[href], a.trackItem__trackTitle[href], a.sound__title[href]',
    );
    for (const anchor of anchors) {
        let url: URL;
        try {
            url = new URL(anchor.href, location.href);
        } catch {
            continue;
        }
        url.search = '';
        url.hash = '';
        const parts = url.pathname.split('/').filter(Boolean);
        if (
            url.origin !== 'https://soundcloud.com' ||
            parts.length !== 2 ||
            seen.has(url.href) ||
            ['you', 'discover', 'search', 'charts', 'settings', 'messages'].includes(parts[0])
        )
            continue;
        const item = anchor.closest(
            '.sound, .trackItem, .soundList__item, .trackList__item, .searchList__item, article, li',
        );
        if (!item) continue;
        const title = (anchor.textContent || anchor.title || '').trim().slice(0, 200);
        if (!title) continue;
        const artist = (
            item.querySelector('.soundTitle__username, .trackItem__username, .sound__user')?.textContent || parts[0]
        )
            .trim()
            .slice(0, 100);
        const tags = [...item.querySelectorAll<HTMLAnchorElement>('a[href*="/tags/"]')]
            .map((tag) => (tag.textContent || '').trim().replace(/^#/, '').slice(0, 50))
            .filter(Boolean)
            .slice(0, 12);
        const bpmMatch = (item.textContent || '').match(/\b(6\d|[7-9]\d|1\d\d|200)\s?bpm\b/i);
        const durationText =
            item.querySelector('.sound__duration, .soundTitle__duration, .trackItem__duration')?.textContent ||
            item.textContent ||
            '';
        const durationMatch = durationText.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
        const durationSeconds = durationMatch
            ? Number(durationMatch[1] || 0) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
            : undefined;
        const liked = Boolean(
            item.querySelector('.sc-button-like.sc-button-selected, .sc-button-like[aria-pressed="true"]'),
        );
        seen.add(url.href);
        tracks.push({
            url: url.href,
            title,
            artist,
            sourceRank: tracks.length,
            ...(tags.length ? { tags, genre: tags[0] } : {}),
            ...(bpmMatch ? { bpm: Number(bpmMatch[1]), bpmConfidence: 0.45 } : {}),
            ...(durationSeconds ? { durationSeconds } : {}),
            ...(liked ? { liked } : {}),
        });
    }
    return tracks;
}
async function scan(view: WebContents, scrolls = 1, target = 12): Promise<WaveCandidate[]> {
    await wait(250);
    let result = (await view.executeJavaScript(`(${extractWaveLinks.toString()})()`, true)) as WaveCandidate[];
    for (let i = 0; i < scrolls && result.length < target; i++) {
        await view.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)', true);
        await wait(300);
        const next = (await view.executeJavaScript(`(${extractWaveLinks.toString()})()`, true)) as WaveCandidate[];
        result = [...result, ...next.filter((track) => !result.some((old) => old.url === track.url))];
    }
    return result;
}
export async function discoverPersonalHistory(view: WebContents): Promise<{
    likes: WaveCandidate[];
    recent: WaveCandidate[];
}> {
    const read = async (route: string): Promise<WaveCandidate[]> => {
        try {
            await view.loadURL(`${root}${route}`);
            if (new URL(view.getURL()).pathname !== route) return [];
            return await scan(view, 2, 40);
        } catch {
            return [];
        }
    };
    return { likes: await read('/you/likes'), recent: await read('/you/history') };
}
export async function discoverSearchCandidates(view: WebContents, queries: string[]): Promise<WaveCandidate[]> {
    const result: WaveCandidate[] = [];
    for (const query of [...new Set(queries.map((value) => value.trim().slice(0, 120)).filter(Boolean))].slice(0, 3)) {
        await view.loadURL(`${root}/search/sounds?q=${encodeURIComponent(query)}`);
        for (const track of await scan(view))
            if (!result.some((old) => old.url === track.url))
                result.push({ ...track, sourceRank: result.length, sourceQuery: query });
    }
    return result;
}
export async function discoverWaveCandidates(view: WebContents, queries: string[] = []): Promise<WaveCandidate[]> {
    const result = await discoverSearchCandidates(view, queries);
    if (result.length >= 24) return result;
    await view.loadURL(`${root}/discover`);
    for (const track of await scan(view))
        if (!result.some((old) => old.url === track.url)) result.push({ ...track, sourceRank: result.length });
    return result;
}
export async function discoverRelatedCandidates(view: WebContents, trackUrl: string): Promise<WaveCandidate[]> {
    const url = new URL(trackUrl);
    if (url.origin !== root || url.pathname.split('/').filter(Boolean).length !== 2) return [];
    await view.loadURL(`${root}${url.pathname.replace(/\/$/, '')}/recommended`);
    return (await scan(view)).filter((track) => track.url !== `${root}${url.pathname}`);
}
