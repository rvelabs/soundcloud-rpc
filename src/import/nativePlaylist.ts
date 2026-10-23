import type { WebContents } from 'electron';
import { trackPath } from '../wave/nativeQueue';
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(test: () => Promise<T | null>, message: string): Promise<T> {
    for (let i = 0; i < 40; i++) {
        const result = await test();
        if (result !== null) return result;
        await wait(250);
    }
    throw new Error(message);
}
async function click(view: WebContents, expression: string): Promise<boolean> {
    return view.executeJavaScript(
        `(() => { const b = ${expression}; if (!b) return false; b.click(); return true; })()`,
        true,
    );
}
export async function confirmPlaylistWrite(view: WebContents, action: () => Promise<boolean>): Promise<boolean> {
    const debug = view.debugger;
    if (debug.isAttached()) throw new Error('Страница импорта уже занята отладчиком. Повторите импорт.');
    debug.attach('1.3');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const writes = new Map<string, number>();
    let finish!: () => void, fail!: (error: Error) => void;
    const saved = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
    });
    void saved.catch(() => {});
    const onMessage = (
        _event: unknown,
        method: string,
        params: {
            requestId?: string;
            request?: {
                url: string;
                method: string;
            };
            response?: {
                status: number;
            };
        },
    ) => {
        const id = params.requestId || '';
        if (method === 'Network.requestWillBeSent') {
            const request = params.request;
            if (!request) return;
            try {
                const url = new URL(request.url);
                if (
                    ['api.soundcloud.com', 'api-v2.soundcloud.com'].includes(url.hostname) &&
                    /^\/playlists(?:\/|$)/.test(url.pathname) &&
                    ['POST', 'PUT', 'PATCH'].includes(request.method)
                )
                    writes.set(id, 0);
            } catch {}
        } else if (method === 'Network.responseReceived' && writes.has(id))
            writes.set(id, params.response?.status || 0);
        else if (method === 'Network.loadingFinished' && writes.has(id)) {
            const status = writes.get(id)!;
            if (status >= 200 && status < 300) finish();
            else fail(new Error(`SoundCloud не сохранил плейлист (код ${status}).`));
        } else if (method === 'Network.loadingFailed' && writes.has(id))
            fail(new Error('Запрос сохранения плейлиста оборвался. Повторите добавление.'));
    };
    debug.on('message', onMessage);
    try {
        await debug.sendCommand('Network.enable');
        timer = setTimeout(
            () => fail(new Error('SoundCloud не подтвердил сохранение плейлиста. Повторите добавление.')),
            15000,
        );
        const clicked = await action();
        if (!clicked) return false;
        await saved;
        return true;
    } finally {
        clearTimeout(timer);
        debug.removeListener('message', onMessage);
        if (debug.isAttached()) debug.detach();
    }
}
async function openAddDialog(view: WebContents, url: string, query: string): Promise<void> {
    const target = trackPath(url);
    if (!target) throw new Error('Некорректная ссылка SoundCloud.');
    await view.loadURL(`https://soundcloud.com/search/sounds?q=${encodeURIComponent(query.trim().slice(0, 120))}`);
    await until(
        async () =>
            view.executeJavaScript(
                `(() => {
        const a = [...document.querySelectorAll('.sound a.soundTitle__title[href]')]
            .find(a => { try { return new URL(a.href).pathname.replace(/\\/$/, '') === ${JSON.stringify(target)}; }
                catch { return false; } });
        const more = a?.closest('.sound')?.querySelector('.sc-button-more');
        if (!more) return null;
        more.click(); return true;
    })()`,
                true,
            ) as Promise<boolean | null>,
        'SoundCloud не показал найденный трек в поиске.',
    );
    await until(
        async () =>
            view.executeJavaScript(
                `(() => {
        const button = document.querySelector('.dropdownMenu .sc-button-addtoset, .dropdownMenu button[title="Add to playlist"]');
        if (!button) return null;
        button.click(); return true;
    })()`,
                true,
            ) as Promise<boolean | null>,
        'SoundCloud не показал Add to Playlist для трека.',
    );
    await until(
        async () =>
            view.executeJavaScript(
                `document.querySelector('.modal .addToPlaylistItem, .modal .addToPlaylistList__item, .modal .createPlaylistForm, .modal .createPlaylist__title input, .modal [class*="addToPlaylist"]') ? true : null`,
                true,
            ),
        'SoundCloud не показал окно плейлистов.',
    );
}
async function closeDialog(view: WebContents): Promise<void> {
    await click(
        view,
        `document.querySelector('.addToPlaylistTabs, .createPlaylist')?.closest('.modal, [role="dialog"]')?.querySelector('.modal__closeButton, button[aria-label="Close"]')`,
    ).catch(() => {});
}
export function activatePlaylistCreation(): 'form' | 'tab' | 'missing' {
    const input = document.querySelector<HTMLInputElement>('.createPlaylist__title input');
    if (input && input.getClientRects().length && !input.closest('[hidden], [aria-hidden="true"]')) return 'form';
    const tabs = [
        ...document.querySelectorAll<HTMLElement>('.addToPlaylistTabs .tabs__tab, .addToPlaylistTabs [role="tab"]'),
    ];
    const tab =
        tabs.find((item) =>
            /create(?: a| new)? playlist|созда(?:ть|ние)(?: новый)? плейлист/i.test(item.textContent || ''),
        ) || (tabs.length === 2 ? tabs[1] : undefined);
    if (!tab) return 'missing';
    tab.click();
    return 'tab';
}
function rowProbe(title: string): string {
    return `(() => {
        const name = ${JSON.stringify(title)}.trim().toLocaleLowerCase();
        const rows = [...document.querySelectorAll('.addToPlaylistList__item')]
            .filter(row => (row.querySelector('.addToPlaylistItem__titleLink, [class*="titleLink"]')?.textContent || '').trim().toLocaleLowerCase() === name);
        if (!rows.length) return { count: 0, added: false };
        const button = rows[0].querySelector('button.addToPlaylistButton');
        return { count: rows.length, added: !!button &&
            (button.classList.contains('sc-button-selected') || /added|добавлено/i.test(button.textContent || '')) };
    })()`;
}
interface RowState {
    count: number;
    added: boolean;
}
async function rowState(view: WebContents, title: string): Promise<RowState> {
    return view.executeJavaScript(rowProbe(title), true);
}
export async function createSoundCloudPlaylist(
    view: WebContents,
    title: string,
    firstTrack: string,
    query: string,
): Promise<'added' | 'already'> {
    const name = title.trim().slice(0, 100);
    if (!name) throw new Error('Название плейлиста пустое.');
    await openAddDialog(view, firstTrack, query);
    try {
        await until(
            async () =>
                view.executeJavaScript(
                    `document.querySelector('.addToPlaylistList__item') || document.querySelector('.createPlaylist__title input')?.getClientRects().length ? true : null`,
                    true,
                ),
            'Список плейлистов пока не загрузился.',
        ).catch(() => {});
        const existing = await rowState(view, name);
        if (existing.count > 1)
            throw new Error('В SoundCloud несколько плейлистов с таким названием. Уточните название перед импортом.');
        if (existing.count === 1) {
            if (!existing.added) {
                const added = await confirmPlaylistWrite(view, () =>
                    click(
                        view,
                        `(() => {
                    const name = ${JSON.stringify(name.toLocaleLowerCase())};
                    const row = [...document.querySelectorAll('.addToPlaylistList__item')]
                        .find(r => (r.querySelector('.addToPlaylistItem__titleLink, [class*="titleLink"]')?.textContent || '').trim().toLocaleLowerCase() === name);
                    return row?.querySelector('button.addToPlaylistButton:not(.sc-button-selected)');
                })()`,
                    ),
                );
                if (!added) throw new Error('SoundCloud не показал добавление в существующий плейлист.');
                await until(
                    async () => ((await rowState(view, name)).added ? true : null),
                    'SoundCloud не подтвердил первый трек.',
                );
            }
            return existing.added ? 'already' : 'added';
        }
        const creation = await until(async () => {
            const state = (await view.executeJavaScript(`(${activatePlaylistCreation.toString()})()`, true)) as string;
            return state === 'missing' ? null : state;
        }, 'SoundCloud не открыл форму создания плейлиста. Проверьте вход и подтверждение аккаунта.');
        if (!creation) throw new Error('Форма создания плейлиста недоступна.');
        const inputReady = await until(
            async () =>
                view.executeJavaScript(
                    `document.querySelector('.createPlaylist__title input')?.getClientRects().length ? true : null`,
                    true,
                ),
            'SoundCloud не показал поле названия плейлиста.',
        );
        if (!inputReady) throw new Error('Поле названия недоступно.');
        await view.executeJavaScript(
            `(() => {
            const input = document.querySelector('.createPlaylist__title input');
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${JSON.stringify(name)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('.createPlaylist__sharing label[data-radio-value="private"]')?.click();
        })()`,
            true,
        );
        await wait(200);
        const privateSelected = await view.executeJavaScript(
            `document.querySelector('.createPlaylist__sharing input[value="private"]')?.checked === true`,
            true,
        );
        if (!privateSelected) throw new Error('SoundCloud не подтвердил приватность нового плейлиста.');
        const saved = await confirmPlaylistWrite(view, () =>
            click(view, `document.querySelector('.createPlaylist__saveButton:not(:disabled)')`),
        );
        if (!saved) throw new Error('SoundCloud не показал кнопку сохранения плейлиста.');
        await until(
            async () =>
                view.executeJavaScript(`!document.querySelector('.createPlaylist__saveButton') ? true : null`, true),
            'SoundCloud не подтвердил создание плейлиста.',
        );
    } finally {
        await closeDialog(view);
    }
    await openAddDialog(view, firstTrack, query);
    try {
        const row = await until(async () => {
            const state = await rowState(view, name);
            return state.count ? state : null;
        }, 'Созданный плейлист не появился в аккаунте SoundCloud.');
        if (row.count !== 1 || !row.added) throw new Error('SoundCloud не подтвердил первый трек в новом плейлисте.');
    } finally {
        await closeDialog(view);
    }
    return 'added';
}
export async function addSoundCloudPlaylistTrack(
    view: WebContents,
    title: string,
    trackUrl: string,
    query: string,
): Promise<'added' | 'already'> {
    await openAddDialog(view, trackUrl, query);
    try {
        const state = await until(async () => {
            const row = await rowState(view, title);
            return row.count ? row : null;
        }, 'SoundCloud не нашёл целевой плейлист.');
        if (state.count !== 1) throw new Error('SoundCloud не нашёл единственный целевой плейлист.');
        if (state.added) return 'already';
        const clicked = await confirmPlaylistWrite(view, () =>
            click(
                view,
                `(() => {
            const name = ${JSON.stringify(title.trim().toLocaleLowerCase())};
            const row = [...document.querySelectorAll('.addToPlaylistList__item')]
                .find(r => (r.querySelector('.addToPlaylistItem__titleLink, [class*="titleLink"]')?.textContent || '').trim().toLocaleLowerCase() === name);
            return row?.querySelector('button.addToPlaylistButton:not(.sc-button-selected)');
        })()`,
            ),
        );
        if (!clicked) throw new Error('SoundCloud не показал кнопку добавления в плейлист.');
        await until(
            async () => ((await rowState(view, title)).added ? true : null),
            'SoundCloud не подтвердил добавление трека.',
        );
    } finally {
        await closeDialog(view);
    }
    await openAddDialog(view, trackUrl, query);
    try {
        const row = await until(async () => {
            const state = await rowState(view, title);
            return state.count ? state : null;
        }, 'Не удалось повторно проверить плейлист.');
        if (row.count !== 1 || !row.added)
            throw new Error('SoundCloud не сохранил трек в плейлисте. Повторите добавление.');
    } finally {
        await closeDialog(view);
    }
    return 'added';
}
