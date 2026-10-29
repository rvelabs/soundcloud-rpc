import { beginNativePageCover } from './nativePresentation';
import type { WebContents } from 'electron';
export function trackPath(value: string): string | null {
    try {
        const url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        if (
            url.origin !== 'https://soundcloud.com' ||
            parts.length !== 2 ||
            parts.some((part) => !/^[\w.~-]+$/.test(part))
        )
            return null;
        return url.pathname.replace(/\/$/, '');
    } catch {
        return null;
    }
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class NativeTrackNotFoundError extends Error {
    constructor() {
        super('SoundCloud не нашёл выбранный трек в собственном поиске.');
    }
}
export class NativeActionCanceledError extends Error {
    constructor() {
        super('Действие Моей волны отменено.');
    }
}
export async function listNativeNextUp(contents: WebContents): Promise<string[]> {
    const links = (await contents.executeJavaScript(
        `[...document.querySelectorAll('.queue__itemsContainer a[href]')].map((a) => a.href.split('?')[0])`,
        true,
    )) as string[];
    return links.filter((url) => trackPath(url) !== null);
}
export async function removeNativeNextUp(contents: WebContents, urls: string[]): Promise<boolean> {
    const paths = [...new Set(urls.map(trackPath).filter((value): value is string => Boolean(value)))];
    if (!paths.length) return true;
    if (contents.isDestroyed()) return false;
    await contents.executeJavaScript(
        `(() => {
        const paths = new Set(${JSON.stringify(paths)});
        const current = document.querySelector('.playbackSoundBadge__titleLink')?.pathname;
        for (const link of document.querySelectorAll('.queue__itemsContainer a[href]')) {
            if (!paths.has(link.pathname) || link.pathname === current) continue;
            const row = link.closest('.queueItemView,li');
            const button = row?.querySelector('.queueItemView__remove,.queueItemView__removeFromQueue,button[title*="Remove"],button[aria-label*="Remove"],button[title*="Удалить"],button[aria-label*="Удалить"]');
            if (button) button.click();
        }
    })()`,
        true,
    );
    for (let attempt = 0; attempt < 10; attempt++) {
        if (contents.isDestroyed()) return false;
        const remaining = await listNativeNextUp(contents);
        const current = await contents.executeJavaScript(
            "document.querySelector('.playbackSoundBadge__titleLink')?.pathname || ''",
        );
        if (!remaining.some((url) => paths.includes(trackPath(url) || '') && trackPath(url) !== current)) return true;
        await wait(100);
    }
    return false;
}
async function cardAvailable(contents: WebContents, target: string): Promise<boolean> {
    return contents.executeJavaScript(
        `(() => [...document.querySelectorAll('.sound a.soundTitle__title[href]')]
        .some(a => a.closest('.sound') && new URL(a.href).pathname.replace(/\\/$/, '') === ${JSON.stringify(target)}))()`,
        true,
    ) as Promise<boolean>;
}
async function searchInPage(
    contents: WebContents,
    query: string,
    target: string,
    isActive: () => boolean,
): Promise<boolean> {
    const clean = query.trim().slice(0, 100);
    if (!clean) return false;
    const search = (await contents.executeJavaScript(
        `(() => {
        const input = document.querySelector('.headerSearch__input');
        if (!input) return false;
        input.focus();
        input.select();
        return document.activeElement === input && input.selectionStart === 0 &&
            input.selectionEnd === input.value.length;
    })()`,
        true,
    )) as boolean;
    if (!search) throw new Error('Поле поиска SoundCloud недоступно.');
    await contents.insertText(clean);
    await wait(100);
    if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
    const submitted = (await contents.executeJavaScript(
        `(() => {
        const button = document.querySelector('.headerSearch__submit');
        if (!button) return false;
        button.click();
        return true;
    })()`,
        true,
    )) as boolean;
    if (!submitted) throw new Error('SoundCloud не показал кнопку поиска.');
    for (let i = 0; i < 20; i++) {
        if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
        if (await cardAvailable(contents, target)) return true;
        await wait(100);
    }
    const filtered = (await contents.executeJavaScript(
        `(() => {
        const a = [...document.querySelectorAll('a[href]')].find(a => {
            try { return new URL(a.href).pathname === '/search/sounds'; } catch { return false; }
        });
        if (!a) return false;
        a.click();
        return true;
    })()`,
        true,
    )) as boolean;
    if (filtered)
        for (let i = 0; i < 35; i++) {
            if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
            if (await cardAvailable(contents, target)) return true;
            await wait(100);
        }
    return false;
}
async function restoreInPage(contents: WebContents, previous: string, previousIndex: number): Promise<void> {
    if (contents.isDestroyed() || contents.getURL() === previous) return;
    if (contents.navigationHistory.getActiveIndex() > previousIndex) {
        contents.navigationHistory.goToIndex(previousIndex);
        for (let i = 0; i < 35 && contents.getURL() !== previous; i++) await wait(100);
    }
    if (contents.getURL() === previous) return;
    for (let step = 0; step < 4 && contents.getURL() !== previous; step++) {
        await contents.executeJavaScript('history.back()', true);
        for (let i = 0; i < 25 && contents.getURL() !== previous; i++) await wait(100);
    }
    if (contents.getURL() !== previous && new URL(previous).pathname === '/discover') {
        await contents.executeJavaScript(
            `document.querySelector('a.header__navMenuItem[href="/discover"]')?.click()`,
            true,
        );
        for (let i = 0; i < 40 && contents.getURL() !== previous; i++) await wait(100);
    }
    if (contents.getURL() !== previous) throw new Error('SoundCloud не вернулся на предыдущую страницу.');
}
async function locateTrack(
    contents: WebContents,
    target: string,
    title?: string,
    sourceQuery?: string,
    maxQueries = 3,
    beforeNavigation: () => Promise<void> = async () => {},
    isActive = () => true,
): Promise<void> {
    if (await cardAvailable(contents, target)) return;
    if (!isActive()) throw new NativeActionCanceledError();
    await beforeNavigation();
    const queries = [
        ...new Set(
            [title, sourceQuery, target.split('/').pop()?.replace(/[-_]/g, ' ')]
                .filter((value): value is string => Boolean(value?.trim()))
                .map((value) => value.trim()),
        ),
    ];
    for (const query of queries.slice(0, maxQueries)) {
        if (!isActive()) throw new NativeActionCanceledError();
        if (await searchInPage(contents, query, target, isActive)) return;
    }
    throw new NativeTrackNotFoundError();
}
async function queueOnCurrentPage(contents: WebContents, target: string, isActive: () => boolean): Promise<boolean> {
    if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
    const state = (await contents.executeJavaScript(
        `(() => {
        const target = ${JSON.stringify(target)};
        const same = (href) => { try { return new URL(href, location.href).pathname.replace(/\\/$/, '') === target; } catch { return false; } };
        if ([...document.querySelectorAll('.queue__itemsContainer a[href]')].some(a => same(a.href))) return 'already';
        const anchor = [...document.querySelectorAll('.sound a.soundTitle__title[href]')].find(a => same(a.href));
        const more = anchor?.closest('.sound')?.querySelector('button.sc-button-more,button[title="More"]');
        if (!more) return 'missing';
        more.click();
        return 'menu';
    })()`,
        true,
    )) as string;
    if (state === 'already') return true;
    if (state === 'missing') return false;
    let buttonState: {
        selected: boolean;
    } | null = null;
    for (let i = 0; i < 20; i++) {
        if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
        buttonState = (await contents.executeJavaScript(
            `(() => {
            const b = document.querySelector('.dropdownMenu button.addToNextUp');
            if (!b) return null;
            return { selected: b.classList.contains('sc-button-selected') };
        })()`,
            true,
        )) as {
            selected: boolean;
        } | null;
        if (buttonState) break;
        await wait(100);
    }
    if (!buttonState) throw new Error('SoundCloud не показал кнопку Add to Next Up.');
    if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
    if (buttonState.selected) return true;
    await contents.executeJavaScript("document.querySelector('.dropdownMenu button.addToNextUp')?.click()", true);
    for (let i = 0; i < 15; i++) {
        if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
        if ((await listNativeNextUp(contents)).some((url) => trackPath(url) === target)) return true;
        await wait(100);
    }
    const selected = await contents
        .executeJavaScript(
            `(() => {
        const target = ${JSON.stringify(target)};
        const anchor = [...document.querySelectorAll('.sound a.soundTitle__title[href]')]
            .find(a => { try { return new URL(a.href).pathname.replace(/\\/$/, '') === target; } catch { return false; } });
        const more = anchor?.closest('.sound')?.querySelector('button.sc-button-more');
        let button = document.querySelector('.dropdownMenu button.addToNextUp');
        if (!button && more) { more.click(); button = document.querySelector('.dropdownMenu button.addToNextUp'); }
        const selected = Boolean(button?.classList.contains('sc-button-selected'));
        if (selected) document.body.click();
        return selected;
    })()`,
            true,
        )
        .catch(() => false);
    if (selected) return true;
    const shape = await contents.executeJavaScript(
        `(() => ({
        queueContainers: document.querySelectorAll('.queue__itemsContainer').length,
        queueLinks: document.querySelectorAll('.queue__itemsContainer a[href]').length,
        queueControls: [...document.querySelectorAll('button')].filter(b =>
            /queue|next up/i.test([b.className, b.title, b.getAttribute('aria-label')].join(' ')))
            .slice(0, 8).map(b => ({ className: String(b.className).slice(0, 80),
                title: b.title.slice(0, 50), label: (b.getAttribute('aria-label') || '').slice(0, 50) }))
    }))()`,
        true,
    );
    throw new Error(`SoundCloud не подтвердил добавление трека в Next Up. DOM: ${JSON.stringify(shape)}`);
}
async function performNativeCard(
    contents: WebContents,
    url: string,
    title: string | undefined,
    sourceQuery: string | undefined,
    maxQueries: number,
    action: (target: string) => Promise<void>,
    isActive: () => boolean,
): Promise<void> {
    if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
    const target = trackPath(url);
    if (!target) throw new Error('Некорректная ссылка на трек SoundCloud.');
    const previous = contents.getURL();
    const previousIndex = contents.navigationHistory.getActiveIndex();
    const previousSearch = (await contents.executeJavaScript(
        `document.querySelector('.headerSearch__input')?.value || ''`,
        true,
    )) as string;
    let uncover = async () => {};
    let fullNavigation = false;
    const preventReload = (event: Electron.Event) => {
        fullNavigation = true;
        event.preventDefault();
    };
    contents.on('will-navigate', preventReload);
    try {
        await locateTrack(
            contents,
            target,
            title,
            sourceQuery,
            maxQueries,
            async () => {
                uncover = await beginNativePageCover(contents);
            },
            isActive,
        );
        if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
        if (fullNavigation) throw new Error('SoundCloud попытался перезагрузить плеер.');
        await action(target);
    } finally {
        contents.removeListener('will-navigate', preventReload);
        try {
            if (!contents.isDestroyed() && contents.getURL() !== previous)
                await restoreInPage(contents, previous, previousIndex);
        } finally {
            if (!contents.isDestroyed())
                await contents
                    .executeJavaScript(
                        `(() => {
                const input = document.querySelector('.headerSearch__input');
                if (!input) return;
                const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                set.call(input, ${JSON.stringify(previousSearch)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.blur();
            })()`,
                        true,
                    )
                    .catch(() => {});
            await uncover();
        }
    }
}
const nativeActionTail = new WeakMap<WebContents, Promise<void>>();
async function withNativeCard(
    contents: WebContents,
    url: string,
    title: string | undefined,
    sourceQuery: string | undefined,
    maxQueries: number,
    action: (target: string) => Promise<void>,
    isActive: () => boolean,
): Promise<void> {
    const prior = nativeActionTail.get(contents) || Promise.resolve();
    const result = prior.then(() => performNativeCard(contents, url, title, sourceQuery, maxQueries, action, isActive));
    const tail = result.then(
        () => {},
        () => {},
    );
    nativeActionTail.set(contents, tail);
    try {
        await result;
    } finally {
        if (nativeActionTail.get(contents) === tail) nativeActionTail.delete(contents);
    }
}
export async function addToNativeNextUp(
    contents: WebContents,
    url: string,
    title?: string,
    sourceQuery?: string,
    isActive = () => true,
): Promise<void> {
    await withNativeCard(
        contents,
        url,
        title,
        sourceQuery,
        3,
        async (target) => {
            if (!(await queueOnCurrentPage(contents, target, isActive)))
                throw new Error('Трек не появился на странице SoundCloud.');
        },
        isActive,
    );
}
export async function playInNativePlayer(
    contents: WebContents,
    url: string,
    title?: string,
    sourceQuery?: string,
    isActive = () => true,
): Promise<void> {
    if (!isActive() || contents.isDestroyed()) throw new NativeActionCanceledError();
    const current = await contents.executeJavaScript(
        `({ path: document.querySelector('.playbackSoundBadge__titleLink')?.pathname, playing: document.querySelector('.playControls__play')?.classList.contains('playing') === true })`,
        true,
    );
    if (current?.path === trackPath(url) && current.playing) return;
    await withNativeCard(
        contents,
        url,
        title,
        sourceQuery,
        3,
        async (target) => {
            const clicked = (await contents.executeJavaScript(
                `(() => {
            const current = document.querySelector('.playbackSoundBadge__titleLink')?.pathname;
            const play = document.querySelector('.playControls__play');
            if (current === ${JSON.stringify(target)} && play?.classList.contains('playing')) return true;
            if (current === ${JSON.stringify(target)} && play) { play.click(); return true; }
            const a = [...document.querySelectorAll('.sound a.soundTitle__title[href]')]
                .find(a => new URL(a.href).pathname.replace(/\\/$/, '') === ${JSON.stringify(target)});
            const button = a?.closest('.sound')?.querySelector('.soundTitle__playButton .playButton');
            if (!button) return false;
            button.click();
            return true;
        })()`,
                true,
            )) as boolean;
            if (!clicked) throw new Error('SoundCloud не показал кнопку Play для выбранного трека.');
            for (let i = 0; i < 35; i++) {
                const state = (await contents.executeJavaScript(
                    `(() => ({
                path: (() => { try { return new URL(document.querySelector('.playbackSoundBadge__titleLink')?.href).pathname.replace(/\\/$/, ''); } catch { return ''; } })(),
                playing: document.querySelector('.playControls__play')?.classList.contains('playing') === true
            }))()`,
                    true,
                )) as {
                    path: string;
                    playing: boolean;
                };
                if (state.path === target && state.playing) return;
                await wait(100);
            }
            throw new Error('SoundCloud не подтвердил воспроизведение выбранного трека.');
        },
        isActive,
    );
}
