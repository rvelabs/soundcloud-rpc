import type { WebContents } from 'electron';
interface LikeButtonState {
    found: boolean;
    liked: boolean;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function inspectLikeButton(click: boolean, trackUrl = '', searchResults = false): LikeButtonState {
    let button: HTMLButtonElement | null = null;
    if (searchResults) {
        const target = new URL(trackUrl).pathname.replace(/\/$/, '');
        const cards = document.querySelectorAll('.searchList__item, .soundList__item, .trackList__item');
        for (const card of cards) {
            const title = card.querySelector<HTMLAnchorElement>(
                'a.soundTitle__title[href], a.trackItem__trackTitle[href]',
            );
            if (!title) continue;
            const url = new URL(title.href);
            const path = url.pathname.replace(/\/$/, '');
            if (url.origin === 'https://soundcloud.com' && path === target) {
                button = card.querySelector<HTMLButtonElement>('.sc-button-like');
                break;
            }
        }
    } else {
        button = document.querySelector<HTMLButtonElement>(
            '.listenEngagement__actions .sc-button-like, .soundActions__main .sc-button-like, ' +
                '.listenDetails__actions .sc-button-like, .sound__header .sc-button-like',
        );
    }
    if (!button || button.disabled) return { found: false, liked: false };
    const liked =
        button.classList.contains('sc-button-selected') ||
        button.getAttribute('aria-pressed') === 'true' ||
        /unlike|remove from likes|убрать из понравившихся/i.test(
            [button.getAttribute('aria-label'), button.getAttribute('title')].join(' '),
        );
    if (click) button.click();
    return { found: true, liked };
}
async function probe(
    view: WebContents,
    trackUrl: string,
    searchResults: boolean,
    click = false,
): Promise<LikeButtonState> {
    return view.executeJavaScript(
        `(${inspectLikeButton.toString()})(${click},${JSON.stringify(trackUrl)},${searchResults})`,
        true,
    );
}
export function isSoundCloudTrackUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        return (
            url.origin === 'https://soundcloud.com' &&
            parts.length === 2 &&
            !['you', 'discover', 'search', 'charts', 'settings', 'messages'].includes(parts[0])
        );
    } catch {
        return false;
    }
}
function isExpectedPage(view: WebContents, pageUrl: string, searchResults: boolean): boolean {
    try {
        const current = new URL(view.getURL());
        const requested = new URL(pageUrl);
        return (
            current.origin === requested.origin &&
            (searchResults
                ? current.pathname === '/search/sounds'
                : current.pathname.replace(/\/$/, '') === requested.pathname.replace(/\/$/, ''))
        );
    } catch {
        return false;
    }
}
async function actOnPage(
    view: WebContents,
    trackUrl: string,
    pageUrl: string,
    searchResults: boolean,
    desired: boolean,
    pollMs: number,
): Promise<boolean | null> {
    if (view.getURL() !== pageUrl) await view.loadURL(pageUrl);
    let state: LikeButtonState = { found: false, liked: false };
    for (let attempt = 0; attempt < 10; attempt++) {
        if (!isExpectedPage(view, pageUrl, searchResults)) throw new Error('SoundCloud перенаправил страницу трека.');
        state = await probe(view, trackUrl, searchResults);
        if (state.found) break;
        await wait(pollMs);
    }
    if (!state.found) return null;
    if (state.liked === desired) return desired;
    await probe(view, trackUrl, searchResults, true);
    for (let attempt = 0; attempt < 12; attempt++) {
        await wait(pollMs);
        state = await probe(view, trackUrl, searchResults);
        if (state.found && state.liked === desired) {
            await view.loadURL(pageUrl);
            for (let verify = 0; verify < 16; verify++) {
                if (!isExpectedPage(view, pageUrl, searchResults)) throw new Error('Не удалось проверить лайк.');
                const persisted = await probe(view, trackUrl, searchResults);
                if (persisted.found && persisted.liked === desired) return desired;
                await wait(pollMs);
            }
            break;
        }
    }
    throw new Error('SoundCloud не подтвердил изменение лайка.');
}
export async function setTrackLiked(
    view: WebContents,
    trackUrl: string,
    desired: boolean,
    title = '',
    pollMs = 450,
): Promise<boolean> {
    if (!isSoundCloudTrackUrl(trackUrl)) throw new Error('Некорректная ссылка на трек.');
    const direct = await actOnPage(view, trackUrl, trackUrl, false, desired, pollMs);
    if (direct !== null) return direct;
    if (title.trim()) {
        const searchUrl = `https://soundcloud.com/search/sounds?q=${encodeURIComponent(title.trim().slice(0, 80))}`;
        const fallback = await actOnPage(view, trackUrl, searchUrl, true, desired, pollMs);
        if (fallback !== null) return fallback;
    }
    throw new Error('Не удалось найти кнопку лайка именно этого трека в SoundCloud.');
}
