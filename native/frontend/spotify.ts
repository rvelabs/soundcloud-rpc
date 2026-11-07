import { classifyPlaylistUrl, type SourcePlaylist } from '../../src/import/source';
import { invoke } from './bridge';

export function requestSignIn(message: string, russian: boolean, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'cw-import-dialog';
        dialog.setAttribute('aria-label', 'Spotify');
        const heading = document.createElement('h2');
        heading.textContent = 'Spotify';
        const detail = document.createElement('p');
        detail.textContent = message;
        const buttons = document.createElement('div');
        buttons.className = 'cw-import-footer-actions';
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.textContent = russian ? 'Войти в Spotify' : 'Sign in to Spotify';
        const decline = document.createElement('button');
        decline.type = 'button';
        decline.autofocus = true;
        decline.textContent = russian ? 'Продолжить без входа' : 'Continue without signing in';
        const finish = (accepted: boolean) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            if (dialog.open) dialog.close();
            dialog.remove();
            resolve(accepted);
        };
        const abort = () => finish(false);
        const timer = setTimeout(abort, 45000);
        accept.onclick = () => finish(true);
        decline.onclick = abort;
        dialog.addEventListener('cancel', abort, { once: true });
        signal.addEventListener('abort', abort, { once: true });
        buttons.append(accept, decline);
        dialog.append(heading, detail, buttons);
        (document.getElementById('codex-playlist-import') || document.body).append(dialog);
        try {
            if (signal.aborted) abort();
            else dialog.showModal();
        } catch {
            abort();
        }
    });
}

export async function completeSpotify(
    initial: SourcePlaylist,
    link: string,
    owner: number,
    signal: AbortSignal,
    progress: (playlist: SourcePlaylist) => void,
    ask?: (message: string) => boolean | Promise<boolean>,
): Promise<SourcePlaylist> {
    if (initial.platform !== 'spotify' || !initial.partial || initial.tracks.length >= 500) return initial;
    const source = classifyPlaylistUrl(link);
    if (source.platform !== 'spotify') return initial;
    const id = crypto.randomUUID();
    let best = initial;
    const cancel = () => {
        void invoke('spotify_close', { id }).catch(() => {});
    };
    signal.throwIfAborted();
    signal.addEventListener('abort', cancel, { once: true });
    try {
        await invoke('spotify_open', { id, owner, url: source.url.replace('/embed/', '/'), initial });
        signal.throwIfAborted();
        const language = await invoke<{ language?: 'auto' | 'ru' | 'en' } | null>('profile_load', { key: 'settings' });
        const russian =
            language?.language === 'ru' ||
            ((!language?.language || language.language === 'auto') &&
                navigator.language.toLowerCase().startsWith('ru'));
        let deadline = Date.now() + 12000,
            asked = false;
        while (Date.now() < deadline) {
            signal.throwIfAborted();
            const state = await invoke<{ playlist: SourcePlaylist; closed: boolean; reachable: boolean }>(
                'spotify_state',
                { id },
            );
            signal.throwIfAborted();
            if (state.playlist.tracks.length >= best.tracks.length) {
                best = state.playlist;
                progress(best);
            }
            if (state.closed || !best.partial || best.tracks.length >= 500) break;
            if (!asked && Date.now() + 700 >= deadline) {
                asked = true;
                if (!state.reachable) break;
                const message = russian
                    ? `Spotify показал только часть списка (${best.tracks.length}${best.expectedTracks ? ' из ' + best.expectedTracks : ''}). Войти в Spotify в отдельном окне, чтобы дочитать его? Пароль вводится только на странице Spotify. Можно отказаться и сохранить найденную часть.`
                    : `Spotify returned only part of the list (${best.tracks.length}${best.expectedTracks ? ' of ' + best.expectedTracks : ''}). Sign in to Spotify in a separate window to read the rest? Enter your password only on Spotify. You can decline and keep the tracks already found.`;
                if (!(await (ask ? ask(message) : requestSignIn(message, russian, signal)))) break;
                signal.throwIfAborted();
                await invoke('spotify_show', { id });
                deadline = Date.now() + 5 * 60000;
            }
            await new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', done);
                    resolve();
                };
                const timer = setTimeout(done, 500);
                signal.addEventListener('abort', done, { once: true });
                if (signal.aborted) done();
            });
        }
        return best;
    } catch (error) {
        signal.throwIfAborted();
        console.debug('Native Spotify continuation unavailable', error instanceof Error ? error.name : 'Error');
        return { ...best, partial: true, partialReason: 'network' };
    } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
    }
}
