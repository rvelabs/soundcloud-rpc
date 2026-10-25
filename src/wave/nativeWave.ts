import type { WebContents } from 'electron';
import type { WaveCandidate } from './waveEngine';
import { trackPath } from './nativeQueue';
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
    for (let attempt = 0; !result.length && attempt < 20; attempt++) {
        if (view.isDestroyed()) return [];
        await wait(100);
        result = (await view.executeJavaScript(`(${extractWaveLinks.toString()})()`, true)) as WaveCandidate[];
    }
    for (let i = 0; i < scrolls && result.length < target; i++) {
        await view.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)', true);
        await wait(300);
        const next = (await view.executeJavaScript(`(${extractWaveLinks.toString()})()`, true)) as WaveCandidate[];
        result = [...result, ...next.filter((track) => !result.some((old) => old.url === track.url))];
    }
    return result;
}
async function loadDiscoveryPage(view: WebContents, url: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            view.loadURL(url),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    if (!view.isDestroyed()) view.stop();
                    reject(new Error('SoundCloud не ответил на фоновый запрос.'));
                }, 10000);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}
export async function discoverPersonalHistory(view: WebContents): Promise<{
    likes: WaveCandidate[];
    recent: WaveCandidate[];
}> {
    const read = async (route: string): Promise<WaveCandidate[]> => {
        try {
            await loadDiscoveryPage(view, `${root}${route}`);
            if (new URL(view.getURL()).pathname !== route) return [];
            return await scan(view, 2, 40);
        } catch {
            return [];
        }
    };
    return { likes: await read('/you/likes'), recent: await read('/you/history') };
}
export async function discoverRelatedCandidates(view: WebContents, trackUrl: string): Promise<WaveCandidate[]> {
    const path = trackPath(trackUrl);
    if (!path) return [];
    await loadDiscoveryPage(view, `${root}${path}/recommended`);
    if (new URL(view.getURL()).pathname.replace(/\/$/, '') !== `${path}/recommended`) return [];
    return (await scan(view, 2, 24)).filter((track) => trackPath(track.url) !== path);
}
