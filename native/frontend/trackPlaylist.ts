import { api, Profile } from './bridge';
import { createPlaylist, deletePlaylist } from './playlists';
import { parsePlaylistWishes } from './playlistWishes';
import { selectTrackPlaylist, type PlaylistSelection } from './playlistSelection';
import { PlaylistExpiry } from './playlistExpiry';

const strings = {
    ru: {
        menu: 'Плейлист по треку',
        heading: 'Плейлист по треку',
        help: 'Бесплатный встроенный подбор: исходный трек, ваши предпочтения и каталог SoundCloud. Без ИИ-модели и API-ключей.',
        wishes: 'Пожелания',
        example: 'Например: спокойнее, без вокала, больше баса, в основном из моих лайков',
        criteria: 'Распознано',
        unknown: 'Не распознано (не будет учтено)',
        conflicts: 'Уточните противоречивые пожелания',
        count: 'Треков',
        expiry: 'Автоудаление',
        never: 'Никогда',
        hours: (h: number) => (h < 24 ? `Через ${h} ч` : `Через ${h / 24} дн.`),
        expiryHelp:
            'Проверяется при работе клиента. Переименование, изменение треков или публикация сохраняют плейлист.',
        cancel: 'Закрыть',
        find: 'Подобрать треки',
        picking: 'Подбираю близкие треки…',
        create: 'Создать приватный плейлист',
        saving: 'Сохраняю…',
        title: 'Название',
        partial: (n: number, count: number) =>
            `Подобрано ${n} из ${count}. Посторонние треки для заполнения не добавлены.`,
        empty: 'Близких доступных треков с этими условиями не найдено. Попробуйте уточнить или убрать часть пожеланий.',
        sources: 'Часть источников SoundCloud недоступна; показаны полученные результаты.',
        done: (n: number) => `Создан приватный плейлист: ${n} треков.`,
        open: 'Открыть',
        keep: 'Оставить навсегда',
        kept: 'Автоудаление отменено.',
        scheduleFailed: 'Плейлист создан. Не удалось подтвердить сохранение срока автоудаления.',
        deleted: (n: number) => `Удалено временных плейлистов: ${n}.`,
        busy: 'Диалог подбора уже открыт',
    },
    en: {
        menu: 'Playlist from this track',
        heading: 'Playlist from this track',
        help: 'Free built-in selection using the seed track, your preferences and the SoundCloud catalog. No AI model or API keys.',
        wishes: 'Extra wishes',
        example: 'For example: calmer, no vocals, more bass, mostly from my likes',
        criteria: 'Recognized',
        unknown: 'Not recognized (will not be used)',
        conflicts: 'Please clarify conflicting wishes',
        count: 'Tracks',
        expiry: 'Auto-delete',
        never: 'Never',
        hours: (h: number) => (h < 24 ? `After ${h} hours` : `After ${h / 24} days`),
        expiryHelp: 'Checked while the client runs. Renaming, editing tracks or making the playlist public keeps it.',
        cancel: 'Close',
        find: 'Find tracks',
        picking: 'Finding close tracks…',
        create: 'Create private playlist',
        saving: 'Saving…',
        title: 'Title',
        partial: (n: number, count: number) =>
            `Found ${n} of ${count}. Unrelated tracks were not added to fill the list.`,
        empty: 'No close, available tracks meet these conditions. Try clarifying or removing some wishes.',
        sources: 'Some SoundCloud sources are unavailable; showing the results received.',
        done: (n: number) => `Created a private playlist with ${n} tracks.`,
        open: 'Open',
        keep: 'Keep forever',
        kept: 'Auto-delete cancelled.',
        scheduleFailed: 'Playlist created. The auto-delete schedule could not be confirmed.',
        deleted: (n: number) => `Deleted ${n} expired temporary playlists.`,
        busy: 'The playlist dialog is already open',
    },
};
const criteriaNames: Record<string, string> = {
    calm: 'спокойнее',
    energetic: 'энергичнее',
    happy: 'веселее',
    sad: 'грустнее',
    slow: 'медленнее',
    medium: 'средний темп',
    fast: 'быстрее',
    bass: 'больше баса',
    bright: 'ярче',
    balanced: 'сбалансированное звучание',
    instrumental: 'без вокала',
    ru: 'русский язык',
    foreign: 'иностранный язык',
    likes: 'предпочитать лайки',
    'only likes': 'только лайки',
};
const russianErrors: Record<string, string> = {
    'SoundCloud did not confirm the selected track':
        'Не удалось получить данные выбранного трека. Откройте его страницу и повторите подбор.',
    'SoundCloud account changed': 'Аккаунт SoundCloud изменился. Запустите подбор заново.',
    'Sign in to SoundCloud first': 'Сначала войдите в SoundCloud.',
    'Playlist preparation timed out': 'SoundCloud не успел ответить. Повторите подбор.',
    'SoundCloud did not confirm the new playlist':
        'SoundCloud не подтвердил создание плейлиста. Проверьте библиотеку перед повторной попыткой.',
};
const style = `
.sc-track-playlist-overlay{position:fixed;inset:0;z-index:2147483001;display:grid;place-items:center;background:#000a;padding:16px;box-sizing:border-box}
.sc-track-playlist-panel{box-sizing:border-box;width:min(600px,100%);max-height:90dvh;overflow:auto;overflow-wrap:anywhere;padding:22px;border:1px solid #ffffff25;border-radius:14px;background:#1c1c1c;color:#eee;font:14px/1.5 system-ui;box-shadow:0 16px 64px #0008}
.sc-track-playlist-panel [hidden]{display:none!important}.sc-track-playlist-results span{min-width:0}
.sc-track-playlist-panel h2{margin:0;font-size:21px}.sc-track-playlist-panel p{margin:8px 0 14px;color:#aaa}.sc-track-playlist-panel label{display:block;margin-top:12px}
.sc-track-playlist-panel input:not([type=checkbox]),.sc-track-playlist-panel textarea,.sc-track-playlist-panel select{box-sizing:border-box;width:100%;padding:9px 11px;background:#111;border:1px solid #ffffff30;border-radius:7px;color:#eee;font:inherit}
.sc-track-playlist-panel textarea{height:84px;min-height:76px;max-height:160px;resize:vertical}.sc-track-playlist-row{display:flex;gap:12px}.sc-track-playlist-row>label{flex:1;min-width:0}
.sc-track-playlist-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:10px;margin-top:18px}.sc-track-playlist-panel button{padding:9px 16px;background:#343434;border:1px solid #ffffff20;border-radius:20px;color:#eee;font:inherit;cursor:pointer}
.sc-track-playlist-panel button[type=submit]{background:#f50;border-color:#f50;font-weight:600}.sc-track-playlist-panel button:disabled{opacity:.5;cursor:default}
.sc-track-playlist-criteria{color:#c8c8c8;font-size:12px;margin-top:8px}.sc-track-playlist-results{max-height:32dvh;overflow:auto;overscroll-behavior:contain;margin-top:12px}
.sc-track-playlist-results label{padding:8px 0;border-bottom:1px solid #ffffff15;margin:0;display:flex;gap:10px}.sc-track-playlist-results input{accent-color:#f50;flex-shrink:0}.sc-track-playlist-results a{color:#eee;text-decoration:none}.sc-track-playlist-results small{display:block;color:#999}
.sc-track-playlist-notice{position:fixed;bottom:75px;left:50%;transform:translateX(-50%);max-width:88vw;padding:14px 20px;background:#252525;color:#eee;border:1px solid #ffffff30;border-radius:9px;z-index:2147483002;font:14px/1.5 system-ui}.sc-track-playlist-notice a,.sc-track-playlist-notice button{color:#ff7b38;margin-left:12px}.sc-track-playlist-notice button{background:none;border:0;cursor:pointer}
.sc-track-wave-action.sc-track-playlist-action::before{content:'♫';background:none;width:auto;height:auto}
@media(max-width:430px){.sc-track-playlist-panel{padding:16px}.sc-track-playlist-row{gap:8px}.sc-track-playlist-actions>button{flex:1}}
`;

let playlistStyles: CSSStyleSheet | undefined;

export class TrackPlaylist {
    private readonly request: typeof api;
    private readonly loadProfile: (key: string) => Promise<Pick<Profile, 'get' | 'set' | 'flush'>>;
    private closed = false;
    private closeDialog?: () => void;
    private notice?: HTMLElement;
    private noticeTimer?: ReturnType<typeof setTimeout>;
    private expiry?: { owner: number; controller: PlaylistExpiry };
    private expiryTask?: { owner: number; task: Promise<PlaylistExpiry> };
    constructor(
        private russian: () => boolean,
        dependencies: {
            request?: typeof api;
            loadProfile?: (key: string) => Promise<Pick<Profile, 'get' | 'set' | 'flush'>>;
        } = {},
    ) {
        this.request = dependencies.request || api;
        this.loadProfile =
            dependencies.loadProfile ||
            (async (key) => {
                const profile = new Profile(key);
                await profile.load();
                return profile;
            });
    }
    private get t() {
        return this.russian() ? strings.ru : strings.en;
    }
    get label(): string {
        return this.t.menu;
    }
    private errorText(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        return this.russian() ? russianErrors[message] || message : message;
    }
    private styles() {
        playlistStyles ??= new CSSStyleSheet();
        if (!playlistStyles.cssRules.length) playlistStyles.replaceSync(style);
        if (!document.adoptedStyleSheets.includes(playlistStyles))
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, playlistStyles];
    }
    private show(message: string, link?: string, keep?: () => Promise<void>) {
        if (this.closed) return;
        this.styles();
        this.notice?.remove();
        clearTimeout(this.noticeTimer);
        const node = document.createElement('div');
        node.className = 'sc-track-playlist-notice';
        node.setAttribute('role', 'status');
        node.textContent = message;
        if (link) {
            const anchor = document.createElement('a');
            anchor.href = link;
            anchor.textContent = this.t.open;
            node.append(anchor);
        }
        if (keep) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = this.t.keep;
            button.onclick = () => {
                button.disabled = true;
                void keep()
                    .then(() => this.show(this.t.kept))
                    .catch((error) => this.show(this.errorText(error)));
            };
            node.append(button);
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute('aria-label', this.t.cancel);
        close.onclick = () => node.remove();
        node.append(close);
        document.body.append(node);
        this.notice = node;
        this.noticeTimer = setTimeout(() => node.remove(), keep ? 60000 : 20000);
    }
    private async schedule(owner: number): Promise<PlaylistExpiry> {
        if (this.expiry?.owner === owner) return this.expiry.controller;
        if (this.expiryTask?.owner === owner) return this.expiryTask.task;
        const task = (async () => {
            const profile = await this.loadProfile('playlists-' + owner);
            const controller = new PlaylistExpiry(
                owner,
                profile,
                (entry, allowed) => deletePlaylist(entry.id, owner, this.request, undefined, entry, allowed),
                async () => Number((await this.request('me')).id),
            );
            this.expiry = { owner, controller };
            return controller;
        })();
        this.expiryTask = { owner, task };
        try {
            return await task;
        } finally {
            if (this.expiryTask?.task === task) this.expiryTask = undefined;
        }
    }
    async open(seed: string): Promise<void> {
        if (this.closed) return;
        if (this.closeDialog) throw Error(this.t.busy);
        this.styles();
        const t = this.t;
        const previousFocus = document.activeElement;
        const overlay = document.createElement('div');
        overlay.className = 'sc-track-playlist-overlay';
        const panel = document.createElement('form');
        panel.className = 'sc-track-playlist-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'sc-track-playlist-heading');
        const heading = document.createElement('h2');
        heading.id = 'sc-track-playlist-heading';
        heading.textContent = t.heading;
        const help = document.createElement('p');
        help.textContent = t.help;
        const seedLine = document.createElement('p');
        seedLine.textContent = new URL(seed).pathname.slice(1);
        const label = (name: string, input: HTMLElement) => {
            const node = document.createElement('label');
            node.append(document.createTextNode(name), input);
            return node;
        };
        const wishes = document.createElement('textarea');
        wishes.maxLength = 500;
        wishes.placeholder = t.example;
        const criteria = document.createElement('div');
        criteria.className = 'sc-track-playlist-criteria';
        criteria.setAttribute('aria-live', 'polite');
        const row = document.createElement('div');
        row.className = 'sc-track-playlist-row';
        const count = document.createElement('select');
        [10, 20, 30, 40].forEach((n) => count.add(new Option(String(n), String(n), false, n === 20)));
        const expiry = document.createElement('select');
        expiry.add(new Option(t.never, '0'));
        [12, 24, 72, 168].forEach((h) => expiry.add(new Option(t.hours(h), String(h))));
        row.append(label(t.count, count), label(t.expiry, expiry));
        const expiryHelp = document.createElement('small');
        expiryHelp.textContent = t.expiryHelp;
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        const title = document.createElement('input');
        title.maxLength = 100;
        title.required = false;
        const titleLabel = label(t.title, title);
        titleLabel.hidden = true;
        const results = document.createElement('div');
        results.className = 'sc-track-playlist-results';
        const actions = document.createElement('div');
        actions.className = 'sc-track-playlist-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = t.cancel;
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.textContent = t.find;
        actions.append(cancel, submit);
        panel.append(
            heading,
            seedLine,
            help,
            label(t.wishes, wishes),
            criteria,
            row,
            expiryHelp,
            titleLabel,
            status,
            results,
            actions,
        );
        overlay.append(panel);
        let selection: PlaylistSelection | undefined;
        let pending: AbortController | undefined;
        let saving = false;
        let finished = false;
        const selectedIds = new Set<number>();
        const close = () => {
            if (saving && !this.closed) return;
            finished = true;
            pending?.abort();
            overlay.remove();
            document.removeEventListener('keydown', keydown, true);
            this.closeDialog = undefined;
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                close();
            }
            if (event.key === 'Tab') {
                const inputs = [
                    ...panel.querySelectorAll<HTMLElement>(
                        'button:not(:disabled),textarea,select,input:not([type=hidden]),a[href]',
                    ),
                ].filter((node) => !node.closest('[hidden]'));
                const first = inputs[0],
                    last = inputs[inputs.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                }
                if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        };
        const updateCriteria = () => {
            const parsed = parsePlaylistWishes(wishes.value);
            const names = parsed.recognized.map((term) => (this.russian() ? criteriaNames[term] || term : term));
            criteria.textContent = [
                names.length ? `${t.criteria}: ${[...new Set(names)].join(', ')}` : '',
                parsed.unrecognized.length ? `${t.unknown}: ${parsed.unrecognized.join(' ')}` : '',
                parsed.conflicts.length ? t.conflicts : '',
            ]
                .filter(Boolean)
                .join('. ');
            submit.disabled = parsed.conflicts.length > 0;
            selection = undefined;
            results.replaceChildren();
            selectedIds.clear();
            titleLabel.hidden = true;
            status.textContent = '';
            submit.textContent = t.find;
        };
        wishes.oninput = updateCriteria;
        count.onchange = updateCriteria;
        cancel.onclick = close;
        overlay.onclick = (event) => {
            if (event.target === overlay) close();
        };
        panel.addEventListener('keydown', (event) => event.stopPropagation());
        panel.onsubmit = (event) => {
            event.preventDefault();
            if (pending || saving) return;
            if (!selection) {
                pending = new AbortController();
                const signal = pending.signal;
                submit.disabled = true;
                wishes.disabled = count.disabled = true;
                status.textContent = t.picking;
                void selectTrackPlaylist(seed, wishes.value.trim(), Number(count.value), signal, {
                    request: this.request,
                    loadProfile: (owner) => this.loadProfile('wave-' + owner),
                })
                    .then((value) => {
                        if (finished || signal.aborted) return;
                        selection = value;
                        seedLine.textContent = `${value.seed.artist} — ${value.seed.title}`;
                        title.value = value.title;
                        titleLabel.hidden = false;
                        status.textContent =
                            value.tracks.length === 0
                                ? t.empty
                                : value.tracks.length < value.requested
                                  ? t.partial(value.tracks.length, value.requested)
                                  : `${value.tracks.length} / ${value.requested}`;
                        if (value.warnings.some((warning) => warning.startsWith('Some')))
                            status.textContent += ' ' + t.sources;
                        for (const track of value.tracks) {
                            const checkbox = document.createElement('input');
                            checkbox.type = 'checkbox';
                            checkbox.checked = true;
                            selectedIds.add(track.apiId!);
                            checkbox.onchange = () => {
                                if (checkbox.checked) selectedIds.add(track.apiId!);
                                else selectedIds.delete(track.apiId!);
                                submit.disabled = !selectedIds.size;
                            };
                            const text = document.createElement('span');
                            const link = document.createElement('a');
                            link.textContent = `${track.artist} — ${track.title}`;
                            link.href = track.url;
                            link.target = '_blank';
                            link.rel = 'noopener noreferrer';
                            const reason = document.createElement('small');
                            reason.textContent = [
                                track.genre,
                                ...(this.russian() ? track.recommendationReasons || [] : []),
                            ]
                                .filter(Boolean)
                                .slice(0, 3)
                                .join(' · ');
                            text.append(link, reason);
                            const item = document.createElement('label');
                            item.append(checkbox, text);
                            results.append(item);
                        }
                        submit.textContent = value.tracks.length ? t.create : t.find;
                        if (!value.tracks.length) selection = undefined;
                    })
                    .catch((error) => {
                        if (!finished && !signal.aborted) status.textContent = this.errorText(error);
                    })
                    .finally(() => {
                        pending = undefined;
                        if (!finished) {
                            wishes.disabled = count.disabled = false;
                            submit.disabled = Boolean(selection && !selectedIds.size);
                        }
                    });
                return;
            }
            if (!selectedIds.size || !title.value.trim()) {
                title.focus();
                return;
            }
            const prepared = selection;
            const ids = prepared.tracks.filter((track) => selectedIds.has(track.apiId!)).map((track) => track.apiId!);
            const hours = Number(expiry.value);
            const name = title.value.trim();
            saving = true;
            submit.disabled = cancel.disabled = true;
            wishes.disabled = count.disabled = expiry.disabled = title.disabled = true;
            status.textContent = t.saving;
            void (async () => {
                if ((await this.request('me')).id !== prepared.owner || this.closed)
                    throw Error('SoundCloud account changed');
                const created = await createPlaylist(name, ids, this.request, undefined, prepared.owner);
                const id = Number(created?.id);
                if (!Number.isSafeInteger(id) || id <= 0) throw Error('SoundCloud did not confirm the new playlist');
                let path = '/you/sets';
                try {
                    const url = new URL(String(created.permalink_url));
                    if (url.origin === 'https://soundcloud.com') path = url.pathname;
                } catch {
                    /* use Library */
                }
                let keep: (() => Promise<void>) | undefined;
                let message = t.done(ids.length);
                if (hours > 0)
                    try {
                        const schedule = await this.schedule(prepared.owner);
                        await schedule.schedule({
                            id,
                            title: String(created.title || name),
                            tracks: ids,
                            deleteAt: Date.now() + hours * 3600_000,
                        });
                        keep = () => schedule.keep(id);
                    } catch {
                        message = t.scheduleFailed;
                    }
                saving = false;
                close();
                this.show(message, path, keep);
            })().catch((error) => {
                saving = false;
                if (finished) return;
                status.textContent = this.errorText(error);
                submit.disabled = cancel.disabled = false;
                wishes.disabled = count.disabled = expiry.disabled = title.disabled = false;
            });
        };
        this.closeDialog = close;
        document.addEventListener('keydown', keydown, true);
        document.body.append(overlay);
        wishes.focus();
    }
    startSweeping(): () => void {
        let running = false;
        const run = async () => {
            if (this.closed || running) return;
            running = true;
            try {
                const owner = Number((await this.request('me')).id);
                if (!Number.isSafeInteger(owner) || owner <= 0 || this.closed) return;
                const schedule = await this.schedule(owner);
                const deleted = await schedule.sweep(() => !this.closed);
                if (deleted) this.show(this.t.deleted(deleted));
            } catch (error) {
                console.debug('Playlist expiry deferred', error);
            } finally {
                running = false;
            }
        };
        const first = setTimeout(() => {
            void run();
        }, 30000);
        const interval = setInterval(() => {
            void run();
        }, 15 * 60000);
        return () => {
            this.closed = true;
            clearTimeout(first);
            clearInterval(interval);
            clearTimeout(this.noticeTimer);
            this.closeDialog?.();
            this.notice?.remove();
        };
    }
}
