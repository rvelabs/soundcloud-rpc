import { TrackPlaylist } from './trackPlaylist';
import type { api } from './bridge';

/** Runs only in the isolated Windows smoke harness. No real catalog writes or account data. */
export async function checkTrackPlaylist(): Promise<string[]> {
    const assert = (value: unknown, message: string) => {
        if (!value) throw Error(message);
    };
    const saved = new Map<string, Record<string, unknown>>();
    type Request = { operation: string; ids?: number[]; tracks?: number[]; title?: string };
    const writes: Array<{ request: Request; expectedOwner?: number }> = [];
    const expiryCount = () => {
        const entries = saved.get('playlists-42')?.trackPlaylistExpiryV1;
        return Array.isArray(entries) ? entries.length : 0;
    };
    const raw = (id: number) => ({
        id,
        title: `Jungle ${id}`,
        permalink_url: `https://soundcloud.com/test/jungle-${id}`,
        user: { id: 100 + id, username: `Artist ${id}` },
        genre: 'jungle',
        tag_list: 'jungle breakbeat instrumental',
        duration: 180000,
        state: 'finished',
        streamable: true,
        policy: 'ALLOW',
        media: { transcodings: [{ format: { protocol: 'hls' } }] },
    });
    let current: TrackPlaylist | undefined;
    let dispose: (() => void) | undefined;
    const until = async (condition: () => boolean) => {
        const end = performance.now() + 3000;
        while (!condition() && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
        assert(condition(), 'track playlist UI timed out');
    };
    const read = (async (operation: string, fields: object = {}, background = false, expectedOwner?: number) => {
        const request: Request = { operation, ...fields };
        if (operation !== 'me')
            assert(background && expectedOwner === 42, 'playlist reads and writes retain account scope');
        if (request.operation === 'me') return { id: 42 };
        if (request.operation === 'resolve') return { ...raw(1), policy: 'BLOCK', streamable: false };
        if (request.operation === 'related') return { collection: [raw(2), raw(3)] };
        if (request.operation === 'radio' || request.operation === 'search' || request.operation === 'likes')
            return { collection: [], next_href: null };
        if (request.operation === 'tracks') return (request.ids || []).map(raw);
        if (request.operation === 'createPlaylist') {
            writes.push(structuredClone({ request, expectedOwner }));
            return {
                id: 1001,
                title: request.title,
                permalink_url: 'https://soundcloud.com/test/sets/playlist',
                sharing: 'private',
            };
        }
        throw Error('Unexpected playlist smoke catalog operation');
    }) as typeof api;
    const loadProfile = async (key: string) => {
        const data: Record<string, unknown> = structuredClone(saved.get(key) || {});
        return {
            get: (name: string, fallback?: unknown) => data[name] ?? fallback,
            set: (name: string, value: unknown) => {
                data[name] = structuredClone(value);
            },
            flush: async () => {
                saved.set(key, structuredClone(data));
            },
        };
    };
    try {
        for (const russian of [true, false]) {
            current = new TrackPlaylist(() => russian, { request: read, loadProfile });
            dispose = current.startSweeping();
            await current.open(raw(1).permalink_url);
            const panel = document.querySelector<HTMLFormElement>('.sc-track-playlist-panel')!;
            assert(panel && panel.getAttribute('aria-modal') === 'true', 'track playlist accessible dialog');
            assert(!/claude|sonnet|haiku|opus|tokens/i.test(panel.textContent || ''), 'no paid model controls');
            const text = panel.querySelector('textarea')!;
            text.value = russian ? 'спокойное, без голоса, марсианский закат' : 'calm, no voice, martian sunset';
            text.dispatchEvent(new Event('input'));
            assert(
                panel
                    .querySelector('.sc-track-playlist-criteria')!
                    .textContent!.includes(russian ? 'марсианский' : 'martian'),
                'unknown wishes visible',
            );
            assert(
                !panel.querySelector('.sc-track-playlist-criteria')!.textContent!.includes('−голоса'),
                'voice wish is not an exclusion',
            );
            assert(text.getBoundingClientRect().height <= 160, 'wishes input starts compact');
            const selectors = panel.querySelectorAll('select');
            selectors[1].value = '12';
            for (const width of [320, 390, 600, 960]) {
                const overlay = panel.parentElement!;
                overlay.style.width = Math.min(innerWidth, width) + 'px';
                overlay.style.right = 'auto';
                assert(
                    panel.scrollWidth <= panel.clientWidth + 1 && panel.getBoundingClientRect().right <= width + 1,
                    'playlist panel fits width ' + width,
                );
            }
            const before = writes.length;
            panel.requestSubmit();
            await until(() => panel.querySelectorAll('input[type=checkbox]').length === 2);
            assert(writes.length === before, 'preview does not create playlist');
            const first = panel.querySelector<HTMLInputElement>('input[type=checkbox]')!;
            first.click();
            panel.querySelector<HTMLInputElement>('input:not([type=checkbox])')!.value = 'My free mix';
            panel.requestSubmit();
            await until(() => !panel.isConnected);
            assert(
                writes.length === before + 1 && writes[writes.length - 1].expectedOwner === 42,
                'one account-scoped creation',
            );
            assert(writes[writes.length - 1].request.tracks?.length === 1, 'unchecked track omitted');
            assert(expiryCount() === 1, 'opt-in expiry saved separately');
            const keep = [...document.querySelectorAll<HTMLButtonElement>('.sc-track-playlist-notice button')].find(
                (button) => button.textContent === (russian ? 'Оставить навсегда' : 'Keep forever'),
            )!;
            keep.click();
            await until(() => expiryCount() === 0);
            await current.open(raw(1).permalink_url);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            assert(!document.querySelector('.sc-track-playlist-panel'), 'Escape closes without creation');
            dispose();
            dispose = undefined;
            current = undefined;
        }
        assert(writes.length === 2, 'no incidental writes from closing dialogs');
        assert(!saved.has('wave-42'), 'playlist selection never overwrites wave profile');
        return [
            'free-playlist-dialog-ru-en',
            'free-playlist-responsive-320-960',
            'free-playlist-preview-before-save',
            'free-playlist-private-account-scoped-save',
            'free-playlist-opt-in-expiry-and-keep',
            'free-playlist-unknown-wishes-visible',
            'free-playlist-restricted-seed-reference',
            'free-playlist-voice-wish-and-compact-input',
        ];
    } finally {
        dispose?.();
    }
}
