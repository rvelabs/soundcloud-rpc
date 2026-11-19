import '../../native/frontend/index';
import { invoke } from '../../native/frontend/bridge';
import { nativeRuntimeExports } from '../../src/soundcloud/nativeRuntime';
import { nativeQueueModel } from './nativeQueue';
import css from './mobile.css';

const page = window as any;
if (!page.__androidUI) {
    page.__androidUI = true;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const ru = /^ru\b/i.test(navigator.language);
    const text = (r: string, e: string) => ru ? r : e;
    const mount = () => {
        const player = document.createElement('nav');
        player.id = 'android-player';
        player.setAttribute('aria-label', text('Плеер', 'Player'));
        const caption = document.createElement('a');
        caption.id = 'android-track-title';
        caption.textContent = text('Выберите музыку', 'Choose music');
        player.append(caption);
        const seek = document.createElement('input'); seek.type = 'range'; seek.min = '0'; seek.max = '0'; seek.value = '0';
        seek.id = 'android-seek'; seek.setAttribute('aria-label', text('Позиция воспроизведения', 'Playback position'));
        seek.onchange = () => void invoke('android_control', { command: 'seek', position: Number(seek.value) * 1000 }).catch(showError);
        player.append(seek);
        for (const [label, command] of [['⏮', 'previous'], ['▶', 'toggle'], ['⏭', 'next']] as const) {
            const button = document.createElement('button');
            button.textContent = label;
            button.dataset.command = command;
            button.setAttribute('aria-label', command);
            button.onclick = () => void invoke('android_control', { command }).catch(showError);
            player.append(button);
        }
        const settings = document.createElement('button');
        settings.id = 'android-open-settings';
        settings.textContent = '⚙';
        settings.setAttribute('aria-label', text('Настройки', 'Settings'));
        settings.onclick = () => void openSettings();
        player.append(settings);
        document.body.append(player);
        window.addEventListener('android-like', () => void (async () => {
            const track = page.__androidCurrentTrack;
            if (!track?.url) return;
            const values = nativeRuntimeExports();
            const Sound = values.find((item: any) => item?.prototype?.resource_type === 'sound' && typeof item?.resolve === 'function') as any;
            const actions = values.find((item: any) => ['like', 'follow', 'repost'].every((key) => typeof item?.[key] === 'function')) as any;
            if (!Sound || !actions) throw Error(text('SoundCloud ещё загружается', 'SoundCloud is still loading'));
            const [owner, slug] = new URL(track.url).pathname.split('/').filter(Boolean);
            const sound = await Sound.resolve(owner, slug);
            sound.hold();
            try {
                await sound.fetch(); await actions.like(sound);
                const likes: Map<string, boolean> = page.__androidKnownLikes ||= new Map();
                likes.set(track.url, !track.isLiked);
                if (likes.size > 256) likes.delete(likes.keys().next().value!);
                page.__androidPlayback({ ...track, isLiked: !track.isLiked });
            } finally { sound.release(); }
        })().catch(showError));
        const eq = () => {
            const element = document.getElementById('sc-equalizer');
            if (element && element.parentElement !== player) player.append(element);
        };
        window.addEventListener('android-mounted', eq);
        eq();
        window.addEventListener('android-track', (event: Event) => {
            const track = (event as CustomEvent).detail;
            caption.textContent = track.title ? `${track.author} — ${track.title}` : text('Выберите музыку', 'Choose music');
            if (track.url?.startsWith('https://soundcloud.com/')) caption.href = track.url;
            const seconds = (value: string) => String(value || '0').split(':').reduce((total, part) => total * 60 + Number(part), 0);
            seek.max = String(seconds(track.duration)); seek.value = String(seconds(track.elapsed));
            player.querySelector('[data-command=toggle]')!.textContent = track.isPlaying ? 'Ⅱ' : '▶';
        });
        // Capture play actions before the website starts a second, independent player.
        document.addEventListener('click', (event) => {
            const target = (event.target as Element)?.closest<HTMLElement>('.playButton,.sc-button-play,.sound__playButton,.trackItem__trackTitle');
            if (!target || target.closest('#android-player,#codex-wave-inline')) return;
            const card = target.closest('.sound,.soundList__item,.trackList__item,.trackItem,.listenEngagement,.listenHero');
            const link = card?.querySelector<HTMLAnchorElement>('a.soundTitle__title,a.trackItem__trackTitle,a.itemTitle__trackTitle')?.href ||
                (location.pathname.split('/').filter(Boolean).length === 2 ? location.href : undefined);
            if (!link || !/^https:\/\/soundcloud\.com\/[^/]+\/[^/?#]+/.test(link)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (page.__androidCurrentTrack?.url === link.split('?')[0]) {
                void invoke('android_control', { command: 'toggle' }).catch(showError); return;
            }
            void nativeQueueModel({ operation: 'play', urls: [link.split('?')[0]], ticket: crypto.randomUUID(), expires: Date.now() + 20000 }).catch(showError);
        }, true);
        document.addEventListener('play', (event) => {
            if (event.target instanceof HTMLMediaElement) event.target.pause();
        }, true);
    };
    function showError(error: unknown) {
        let notice = document.getElementById('android-error');
        if (!notice) { notice = document.createElement('p'); notice.id = 'android-error'; notice.setAttribute('role', 'alert'); document.body.append(notice); }
        notice.textContent = String(error);
        setTimeout(() => notice?.remove(), 7000);
    }
    const openSettings = () => invoke('android_settings').catch(showError);
    window.addEventListener('android-settings', () => void openSettings());
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
}
