import { invoke } from './bridge';
import { TogetherPlayer, nativeTogetherBackend, type RemotePlayback } from './togetherPlayer';

export type TogetherState = {
    mode: 'idle' | 'hosting' | 'following';
    phase: string;
    participants: number;
    error?: string;
    inviteUrl?: string;
    remote?: RemotePlayback;
    revision: number;
};
type Snapshot = { url: string; title: string; author: string; elapsed: string; duration: string; isPlaying: boolean };
const translate = (ru: boolean, key: string) =>
    ({
        connecting: ru ? 'Подключение…' : 'Connecting…',
        connected: ru ? 'Подключено' : 'Connected',
        waiting: ru ? 'Ожидаем ведущего' : 'Waiting for the host',
        reconnecting: ru ? 'Восстанавливаем соединение…' : 'Reconnecting…',
        ended: ru ? 'Совместное прослушивание завершено' : 'Listening session ended',
        'service-not-configured': ru
            ? 'Сервис пока недоступен. Повторите позже.'
            : 'The service is unavailable. Try again later.',
        'service-unavailable': ru ? 'Не удалось подключиться к сервису.' : 'Could not connect to the service.',
        'rate-limit': ru
            ? 'Слишком много новых сессий. Повторите через минуту.'
            : 'Too many new sessions. Try again in a minute.',
        'invalid-invite': ru
            ? 'Приглашение недействительно. Попросите новую ссылку.'
            : 'Invalid invitation. Ask for a new link.',
        expired: ru ? 'Срок приглашения истёк.' : 'This invitation has expired.',
        'room-full': ru ? 'В сессии уже максимальное число слушателей.' : 'The listening session is full.',
        unavailable: ru
            ? 'Этот трек недоступен. Ожидаем следующую песню ведущего.'
            : 'This track is unavailable. Waiting for the host’s next track.',
        'sync-unavailable': ru
            ? 'Плеер не подтвердил синхронизацию. Откройте страницу трека.'
            : 'The player could not synchronize. Open the track page.',
        ad: ru ? 'Ожидаем окончания рекламы' : 'Waiting for the ad to finish',
        'sign-in-required': ru ? 'Сначала войдите в аккаунт SoundCloud.' : 'Sign in to SoundCloud first.',
    })[key] || key;

export class TogetherBridge {
    private player: TogetherPlayer;
    private state?: TogetherState;
    private reads = 0;
    private publishSignature = '';
    private panel?: HTMLElement;
    private stopped = false;
    private modeEpoch = 0;
    private dismissed = '';
    private backend = nativeTogetherBackend();
    private lastTrack?: { track: Snapshot; at: number };
    constructor(
        suspend: () => Promise<void>,
        private russian: () => boolean,
    ) {
        this.player = new TogetherPlayer(this.backend, suspend);
        document.addEventListener(
            'click',
            (event) => {
                if (
                    event.isTrusted &&
                    event.target instanceof Element &&
                    event.target.closest(
                        '.playControls__play,.skipControl__next,.skipControl__previous,.playButton,.sc-button-play,.playbackTimeline__progressWrapper',
                    )
                )
                    this.manual();
            },
            true,
        );
        document.addEventListener(
            'keydown',
            (event) => {
                if (
                    event.isTrusted &&
                    event.code === 'Space' &&
                    !/INPUT|TEXTAREA|SELECT/.test((event.target as Element)?.tagName || '')
                )
                    this.manual();
            },
            true,
        );
    }
    observe(track: Snapshot): void {
        this.lastTrack = { track: { ...track }, at: Date.now() };
        this.publish();
    }
    private publish(): void {
        if (this.state?.mode !== 'hosting') return;
        if (!this.lastTrack) return;
        const { track, at } = this.lastTrack;
        const ms = (value: string) => value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) * 1000;
        const current = this.backend.current();
        const same = current?.url === track.url.replace(/\/$/, '');
        const value = {
            trackUrl: track.url,
            title: track.title.slice(0, 200),
            author: track.author.slice(0, 200),
            positionMs: Math.min(ms(track.duration), ms(track.elapsed) + (track.isPlaying ? Date.now() - at : 0)),
            durationMs: ms(track.duration),
            playing: current?.ad ? false : same ? current.playing : track.isPlaying,
        };
        if (current?.ad) value.positionMs = ms(track.elapsed);
        if (same && !current.ad && Number.isFinite(current.positionMs)) value.positionMs = current.positionMs;
        if (!value.durationMs) return;
        const signature = JSON.stringify(value);
        if (signature === this.publishSignature) return;
        this.publishSignature = signature;
        void invoke('together_observe', { playback: value }).catch(() => {
            this.publishSignature = '';
        });
    }
    manual(): void {
        if (this.state?.mode !== 'following') return;
        this.modeEpoch++;
        this.player.leave();
        this.state = undefined;
        void invoke('together_action', { action: 'leave' })
            .then(() => this.tick())
            .catch(console.error);
    }
    async tick(): Promise<void> {
        if (this.stopped) return;
        const request = ++this.reads,
            epoch = this.modeEpoch;
        const state = await invoke<TogetherState>('together_status');
        if (request !== this.reads || epoch !== this.modeEpoch || this.stopped) return;
        const changed = state.mode !== this.state?.mode;
        this.state = state;
        if (state.mode === 'following')
            void this.player
                .update(state.remote || null)
                .then(() => this.render())
                .catch(() => {});
        else this.player.leave(this.state.phase === 'ended' || this.state.phase === 'error');
        if (changed) {
            this.dismissed = '';
            this.publishSignature = '';
        }
        this.publish();
        this.render();
    }
    private render() {
        if (!this.state || this.stopped) return;
        const state = this.state,
            ru = this.russian();
        if (state.mode === 'idle' && this.dismissed === state.phase) return;
        if (state.mode === 'idle' && !['ended', 'error'].includes(state.phase)) {
            this.panel?.remove();
            this.panel = undefined;
            return;
        }
        let sheet = (window as unknown as { __scTogetherSheet?: CSSStyleSheet }).__scTogetherSheet;
        if (!sheet) {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(
                '#sc-together{position:fixed;bottom:70px;right:20px;z-index:2147482999;max-width:min(430px,calc(100vw - 40px));padding:12px 16px;border:1px solid #ff641c55;border-radius:10px;background:#25221f;color:#eee8df;font:13px/1.5 system-ui;box-shadow:0 8px 24px #0005}#sc-together p{margin:0 0 8px}#sc-together button{border:1px solid #ffffff30;border-radius:15px;background:none;color:inherit;padding:5px 12px;margin-right:8px;cursor:pointer;font:inherit}',
            );
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            (window as unknown as { __scTogetherSheet: CSSStyleSheet }).__scTogetherSheet = sheet;
        }
        if (!this.panel?.isConnected) {
            this.panel = document.createElement('aside');
            this.panel.id = 'sc-together';
            this.panel.setAttribute('aria-label', ru ? 'Совместное прослушивание' : 'Listen together');
            document.body?.append(this.panel);
        }
        const signature = JSON.stringify([
            state.mode,
            state.phase,
            state.participants,
            state.error,
            this.player.error,
            ru,
        ]);
        if (this.panel.dataset.state === signature) return;
        this.panel.dataset.state = signature;
        this.panel.replaceChildren();
        const text = document.createElement('p');
        text.textContent =
            (state.mode === 'hosting'
                ? ru
                    ? 'Вы ведущий'
                    : 'You are hosting'
                : state.mode === 'following'
                  ? ru
                      ? 'Слушаете вместе'
                      : 'Listening together'
                  : '') +
            ' · ' +
            translate(ru, this.player.error || state.error || state.phase) +
            (state.mode !== 'idle' ? ` · ${state.participants}` : '');
        this.panel.append(text);
        if (state.mode === 'hosting' && state.inviteUrl) {
            const copy = document.createElement('button');
            copy.textContent = ru ? 'Пригласить' : 'Invite';
            copy.onclick = () =>
                void navigator.clipboard.writeText(state.inviteUrl!).then(() => {
                    copy.textContent = ru ? 'Ссылка скопирована' : 'Link copied';
                });
            this.panel.append(copy);
        }
        const leave = document.createElement('button');
        leave.textContent = state.mode === 'idle' ? (ru ? 'Закрыть' : 'Dismiss') : ru ? 'Выйти' : 'Leave';
        leave.onclick = () => {
            this.modeEpoch++;
            this.player.leave();
            this.panel?.remove();
            this.panel = undefined;
            if (state.mode === 'idle') {
                this.dismissed = state.phase;
                return;
            }
            void invoke('together_action', { action: 'leave' })
                .then(() => this.tick())
                .catch(console.error);
        };
        this.panel.append(leave);
    }
    dispose() {
        this.stopped = true;
        this.player.leave();
        this.panel?.remove();
    }
}

export function installTogetherSettings(ru: boolean): void {
    const section = document.createElement('section');
    section.dataset.pane = 'client';
    section.hidden = true;
    section.className = 'preferences';
    const text = (russian: string, english: string) => (ru ? russian : english);
    section.innerHTML = `<h2>${text('Слушать вместе', 'Listen together')}</h2><p class="muted">${text('Пригласите друзей через Discord или ссылку. Музыкой управляет ведущий. Ручное переключение у слушателя завершает подключение.', 'Invite friends through Discord or a link. The host controls playback. Manual playback controls leave the session.')}</p><div class="buttons"><button type="button" id="together-host">${text('Разрешить слушать со мной', 'Let others listen with me')}</button><button type="button" id="together-copy" class="secondary" hidden>${text('Копировать приглашение', 'Copy invitation')}</button><button type="button" id="together-leave" class="secondary" hidden>${text('Завершить', 'Leave')}</button></div><label>${text('Ссылка-приглашение', 'Invitation link')}<input id="together-invite" type="text" maxlength="512" placeholder="https://rvelabs.github.io/soundcloud-rpc/join/#…"></label><button type="button" id="together-join" class="secondary">${text('Присоединиться', 'Join')}</button><p id="together-status" class="muted" role="status"></p>`;
    document.getElementById('discord-settings')!.after(section);
    const element = <T extends HTMLElement>(id: string) => section.querySelector<T>('#' + id)!;
    let last: TogetherState | undefined;
    const show = (state: TogetherState) => {
        last = state;
        element('together-host').hidden = state.mode !== 'idle';
        element('together-copy').hidden = !state.inviteUrl;
        element('together-leave').hidden = state.mode === 'idle';
        element('together-status').textContent =
            state.phase === 'idle'
                ? text(
                      'Приглашение появится в вашем статусе Discord во время прослушивания.',
                      'Your invitation appears in Discord while you listen.',
                  )
                : translate(ru, state.error || state.phase);
    };
    const action = async (action: string) => {
        const buttons = [...section.querySelectorAll('button')];
        buttons.forEach((b) => (b.disabled = true));
        try {
            show(
                await invoke<TogetherState>('together_action', {
                    action,
                    invite: element<HTMLInputElement>('together-invite').value.trim(),
                }),
            );
        } catch (error) {
            element('together-status').textContent = translate(
                ru,
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            buttons.forEach((b) => (b.disabled = false));
        }
    };
    element('together-host').onclick = () => void action('host');
    element('together-join').onclick = () => void action('join');
    element('together-leave').onclick = () => void action('leave');
    element('together-copy').onclick = () => {
        if (last?.inviteUrl) void navigator.clipboard.writeText(last.inviteUrl);
    };
    void invoke<TogetherState>('together_status')
        .then(show)
        .catch(() => {});
    // Settings can remain open during playback; native updates refresh this panel without a timer.
    (window as unknown as { __togetherSettingsRefresh?: () => void }).__togetherSettingsRefresh = () => {
        void invoke<TogetherState>('together_status')
            .then(show)
            .catch(() => {});
    };
}
