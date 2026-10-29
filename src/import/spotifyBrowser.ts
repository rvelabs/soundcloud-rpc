import { BrowserWindow, dialog, type Session, type WebContents } from 'electron';
import { classifyPlaylistUrl, playlistResult, type SourcePlaylist, type SourceTrack } from './source';
export function spotifySnapshot(): {
    title: string;
    tracks: Array<SourceTrack & { position: number }>;
    total?: number;
    bottom: boolean;
    reachable: boolean;
} {
    const page = document.querySelector('[data-testid="playlist-page"]') || document.querySelector('main') || document;
    const grid =
        page.querySelector('[data-testid="playlist-tracklist"]') ||
        page.querySelector('[data-testid="tracklist"]') ||
        page.querySelector('[role="grid"]');
    const namedRows = grid?.querySelectorAll('[data-testid="tracklist-row"]');
    const rows = namedRows?.length ? [...namedRows] : grid ? [...grid.querySelectorAll('[role="row"]')] : [];
    const tracks: Array<SourceTrack & { position: number }> = [];
    for (const row of rows) {
        const link = row.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
        const id = link?.href.match(/\/track\/([A-Za-z0-9]{22})(?:[/?#]|$)/)?.[1];
        const title = link?.textContent?.trim() || row.querySelector('[data-testid="track-name"]')?.textContent?.trim();
        const artist = [...row.querySelectorAll('a[href*="/artist/"]')]
            .map((item) => item.textContent?.trim())
            .filter(Boolean)
            .join(', ');
        if (!title || !artist || !id) continue;
        const duration = row.textContent?.match(/(?:^|\D)(\d{1,2}):(\d{2})(?!\d)/);
        const position =
            Number(row.getAttribute('aria-rowindex')) ||
            Number(row.querySelector('[aria-colindex="1"]')?.textContent?.trim()) ||
            tracks.length + 1;
        tracks.push({
            title: title.slice(0, 200),
            artist: artist.slice(0, 200),
            sourceId: 'spotify:track:' + id,
            position,
            ...(duration ? { durationSeconds: Number(duration[1]) * 60 + Number(duration[2]) } : {}),
        });
    }
    const header = page.querySelector<HTMLElement>('[data-testid="entity-header"]');
    const headerText =
        header?.innerText ||
        [...page.querySelectorAll('h1,p')]
            .filter((item) => !grid?.contains(item))
            .map((item) => item.textContent)
            .join(' ');
    const headerCount = headerText.match(
        /(?:^|[^\d])([\d][\d\s,.]*)\s*(?:songs?|tracks?|трек(?:а|ов)?|пес(?:ен|ни|ня)|Titel)(?:\s|$|[·,.])/i,
    )?.[1];
    const declared = Number(
        (grid?.hasAttribute('aria-rowcount') ? grid : grid?.querySelector('[aria-rowcount]'))?.getAttribute(
            'aria-rowcount',
        ),
    );
    const counted = headerCount ? Number(headerCount.replace(/\D/g, '')) : 0;
    const total =
        counted > 0
            ? counted
            : declared > 1
              ? declared - Number(Boolean(grid?.querySelector('[role="columnheader"]')))
              : undefined;
    let scroll: Element | null = grid;
    while (scroll && scroll.scrollHeight <= scroll.clientHeight + 5) scroll = scroll.parentElement;
    scroll ||= document.scrollingElement;
    const bottom = Boolean(scroll && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 8);
    if (scroll)
        scroll.scrollTop = Math.min(scroll.scrollHeight, scroll.scrollTop + Math.max(200, scroll.clientHeight * 0.8));
    const title =
        (page.querySelector('[data-testid="entityTitle"]') || page.querySelector('h1'))?.textContent
            ?.trim()
            .slice(0, 100) || '';
    return {
        tracks,
        title,
        total: total && total > 0 && total <= 1000000 ? total : undefined,
        bottom,
        reachable: Boolean(
            grid || document.querySelector('[data-testid="login-button"], [data-testid="login-username"]'),
        ),
    };
}
export async function collectSpotifyRows(
    contents: WebContents,
    initial: SourcePlaylist,
    signal: AbortSignal | undefined,
    deadline: number,
    progress?: (page: SourcePlaylist) => void,
    navigationFailed?: () => boolean,
): Promise<{ playlist: SourcePlaylist; reachable: boolean }> {
    const tracks = new Map<string, SourceTrack & { position: number }>();
    const legacyKeys = new Map<string, string>();
    initial.tracks.forEach((track, position) =>
        tracks.set(track.sourceId || `${track.artist}|${track.title}`, { ...track, position: position + 1 }),
    );
    for (const [key, track] of tracks) if (!track.sourceId) legacyKeys.set(`${track.artist}|${track.title}`, key);
    let total = initial.expectedTracks,
        title = initial.title,
        reachable = false,
        stable = 0;
    let best = initial;
    while (!contents.isDestroyed() && Date.now() < deadline) {
        signal?.throwIfAborted();
        if (navigationFailed?.()) {
            best = { ...best, partial: true, partialReason: 'network' };
            break;
        }
        const snapshot = (await contents
            .executeJavaScript(`(${spotifySnapshot.toString()})()`)
            .catch(() => null)) as ReturnType<typeof spotifySnapshot> | null;
        if (snapshot) {
            reachable ||= snapshot.reachable;
            total = snapshot.total || total;
            title = snapshot.title || title;
            const before = tracks.size;
            for (const track of snapshot.tracks) {
                const legacy = legacyKeys.get(`${track.artist}|${track.title}`);
                if (legacy) {
                    tracks.delete(legacy);
                    legacyKeys.delete(`${track.artist}|${track.title}`);
                }
                tracks.set(track.sourceId!, track);
            }
            stable = tracks.size === before ? stable + 1 : 0;
            const ordered = [...tracks.values()]
                .sort((a, b) => a.position - b.position)
                .map((track) => ({
                    title: track.title,
                    artist: track.artist,
                    sourceId: track.sourceId,
                    durationSeconds: track.durationSeconds,
                }));
            const complete = Boolean(total && tracks.size >= total);
            best = {
                ...playlistResult('spotify', title, ordered, !complete || Boolean(total && total > 500)),
                readTracks: ordered.length,
                expectedTracks: total,
                pagesRead: Math.max(1, Math.ceil(ordered.length / 50)),
                ...(total && total > 500 && tracks.size >= 500
                    ? { partialReason: 'limit' as const }
                    : !complete
                      ? { partialReason: 'authorization' as const }
                      : {}),
            };
            if (tracks.size !== before || complete) progress?.(best);
            if (complete || tracks.size >= 500 || (snapshot.bottom && stable >= 5)) break;
        }
        await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, 350);
            signal?.addEventListener('abort', done, { once: true });
            if (signal?.aborted) done();
        });
    }
    signal?.throwIfAborted();
    return { playlist: best, reachable };
}
export async function completeSpotifyPlaylist(
    initial: SourcePlaylist,
    link: string,
    options: {
        parent: BrowserWindow;
        account: string;
        russian: boolean;
        signal?: AbortSignal;
        configure?: (target: Session, force: boolean) => Promise<boolean>;
        progress?: (page: SourcePlaylist) => void;
        ask?: () => Promise<boolean>;
    },
): Promise<SourcePlaylist> {
    if (initial.platform !== 'spotify' || !initial.partial || initial.tracks.length >= 500) return initial;
    const canonical = classifyPlaylistUrl(link);
    if (canonical.platform !== 'spotify') return initial;
    const address = canonical.url.replace('/embed/', '/');
    const window = new BrowserWindow({
        parent: options.parent,
        show: false,
        width: 1050,
        height: 780,
        title: 'Spotify · SoundCloud',
        autoHideMenuBar: true,
        webPreferences: {
            partition: 'persist:spotify-import-' + options.account.replace(/[^\w-]/g, ''),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            devTools: false,
        },
    });
    window.webContents.setAudioMuted(true);
    window.webContents.setUserAgent(options.parent.webContents.getUserAgent());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const allowed = (url: string) => {
        try {
            const target = new URL(url);
            return (
                target.protocol === 'https:' &&
                (target.hostname === 'open.spotify.com' ||
                    target.hostname === 'accounts.spotify.com' ||
                    target.hostname === 'challenge.spotify.com')
            );
        } catch {
            return false;
        }
    };
    window.webContents.on('will-navigate', (event, url) => {
        if (!allowed(url)) event.preventDefault();
    });
    window.webContents.on('will-redirect', (event, url) => {
        if (!allowed(url)) event.preventDefault();
    });
    const cancel = () => {
        if (!window.isDestroyed()) window.destroy();
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
        options.signal?.throwIfAborted();
        const throughRelay = await options.configure?.(window.webContents.session, false);
        let navigationFailed = false;
        const load = () => {
            navigationFailed = false;
            void window.loadURL(address).catch((error) => {
                if (error?.code !== 'ERR_ABORTED' && error?.errno !== -3) navigationFailed = true;
            });
        };
        load();
        let result = await collectSpotifyRows(
            window.webContents,
            initial,
            options.signal,
            Date.now() + 12000,
            options.progress,
            () => navigationFailed,
        );
        if (
            result.playlist.partial &&
            result.playlist.tracks.length < 500 &&
            !result.reachable &&
            !throughRelay &&
            !window.isDestroyed() &&
            (await options.configure?.(window.webContents.session, true).catch(() => false))
        ) {
            load();
            result = await collectSpotifyRows(
                window.webContents,
                result.playlist,
                options.signal,
                Date.now() + 12000,
                options.progress,
                () => navigationFailed,
            );
        }
        if (!result.playlist.partial || window.isDestroyed() || !result.reachable) return result.playlist;
        const login = options.ask
            ? await options.ask()
            : (
                  await dialog.showMessageBox(options.parent, {
                      type: 'question',
                      title: 'Spotify',
                      message: options.russian
                          ? 'Spotify показал только часть плейлиста'
                          : 'Spotify returned only part of the playlist',
                      detail: options.russian
                          ? `Прочитано ${result.playlist.tracks.length}${result.playlist.expectedTracks ? ' из ' + result.playlist.expectedTracks : ''} треков. Можно войти в свой Spotify в отдельном окне, чтобы дочитать список. Пароль вводится только на странице Spotify. Можно отказаться и сохранить найденную часть.`
                          : `Read ${result.playlist.tracks.length}${result.playlist.expectedTracks ? ' of ' + result.playlist.expectedTracks : ''} tracks. Sign in to Spotify in a separate window to read the rest. Enter your password only on Spotify. You can decline and keep the tracks already found.`,
                      buttons: options.russian
                          ? ['Войти в Spotify', 'Продолжить без входа']
                          : ['Sign in to Spotify', 'Continue without signing in'],
                      defaultId: 1,
                      cancelId: 1,
                      noLink: true,
                  })
              ).response === 0;
        options.signal?.throwIfAborted();
        if (!login || window.isDestroyed()) return result.playlist;
        window.show();
        window.focus();
        void window.webContents
            .executeJavaScript('document.querySelector("[data-testid=login-button]")?.click()')
            .catch(() => {});
        const until = Date.now() + 5 * 60000;
        while (!window.isDestroyed() && Date.now() < until) {
            const next = await collectSpotifyRows(
                window.webContents,
                result.playlist,
                options.signal,
                Math.min(until, Date.now() + 5000),
                options.progress,
            );
            result = next;
            if (!next.playlist.partial) break;
            if (window.isDestroyed()) break;
            const current = window.webContents.isDestroyed() ? '' : window.webContents.getURL();
            if (current.startsWith('https://open.spotify.com/') && !/\/(playlist|album)\//.test(current))
                void window.loadURL(address).catch(() => {});
        }
        return result.playlist;
    } finally {
        options.signal?.removeEventListener('abort', cancel);
        cancel();
    }
}
