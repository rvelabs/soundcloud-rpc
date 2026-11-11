import { installNativePlayerMonitor, nativePlayerCommand } from '../../src/soundcloud/nativePlayerBridge';
import { nativeQueueModel, type QueueRequest } from '../../src/soundcloud/nativeQueueBridge';
import { RecommendationSession } from '../../src/wave/recommendation/session';
import { normalizeEqualizer, equalizerPresets, equalizerFrequencies } from '../../src/audio/equalizerSettings';
import { installEqualizerEngine } from '../../src/audio/equalizerEngine';
import { installEqualizerPanel } from '../../src/audio/equalizerPanel';
import { installWaveUI } from 'soundcloud-wave-ui';
import { installNativeStyles, nativeLayout } from './styles';
import { Profile, invoke } from './bridge';
import { isDeepStrictEqual } from './equal';
import { Wave } from './wave';
import { requestSignIn } from './spotify';
import speedPlugin from 'soundcloud-builtin-plugin';
import { checkAudio } from './audioCheck';
import { PlaylistRequestError } from './playlistErrors';
import { checkAdblock } from './adblockCheck';
import { SoundCloudRecommender } from '../../src/wave/recommendation/soundcloudAdapter';
import { installTrackWaveMenu } from './trackWaveMenu';

const assert = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
class Events {
    callbacks = new Map<string, Set<(...args: unknown[]) => void>>();
    on(names: string, callback: (...args: unknown[]) => void) {
        for (const name of names.split(' ')) {
            if (!this.callbacks.has(name)) this.callbacks.set(name, new Set());
            this.callbacks.get(name)!.add(callback);
        }
    }
    off(names: string, callback: (...args: unknown[]) => void) {
        for (const name of names.split(' ')) this.callbacks.get(name)?.delete(callback);
    }
    emit(name: string) {
        for (const callback of this.callbacks.get(name) || []) callback();
        for (const callback of this.callbacks.get('all') || []) callback(name);
    }
    count() {
        return [...this.callbacks.values()].reduce((sum, set) => sum + set.size, 0);
    }
}

async function test() {
    (window as any).__scSmokePhase = 'script-started';
    const started = performance.now(),
        checks: string[] = [];
    assert(isDeepStrictEqual({ a: [1, { b: true }] }, { a: [1, { b: true }] }), 'portable equality');
    assert(!isDeepStrictEqual({ a: undefined }, {}), 'equality keeps missing properties distinct');
    checks.push('portable-equality');
    (window as any).__scSmokePhase = 'native-profile';
    const profile = new Profile('settings');
    await profile.load();
    profile.set('test', 'persisted');
    await profile.flush(true);
    const saved = new Profile('settings');
    await saved.load();
    assert(saved.get('test') === 'persisted', 'native IPC persistence');
    checks.push('native-profile-ipc');
    checks.push('durable-profile-barrier');
    checks.push(...(await checkAdblock()));
    const media = document.createElement('audio');
    media.muted = true;
    document.body.append(media);
    const bytes = new Uint8Array(44 + 16000 * 2),
        view = new DataView(bytes.buffer);
    const text = (at: number, value: string) =>
        [...value].forEach((char, index) => (bytes[at + index] = char.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, bytes.length - 44, true);
    const source = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    let current: Sound | undefined,
        likesValue = false,
        holds = 0;
    class Sound extends Events {
        constructor(readonly id: number) {
            super();
        }
        get(key: string) {
            return (
                {
                    id: this.id,
                    title: 'Track ' + this.id,
                    permalink_url: `https://soundcloud.com/test/track-${this.id}`,
                    user: { username: 'Test' },
                    policy: 'ALLOW',
                    state: 'finished',
                    media: {},
                    user_favorite: likesValue,
                } as Record<string, unknown>
            )[key];
        }
        hold() {
            holds++;
        }
        release() {
            holds--;
        }
        fetch() {
            return Promise.resolve(this);
        }
        isPlayable() {
            return true;
        }
        isAd() {
            return false;
        }
        isPlaying() {
            return current === this && !media.paused;
        }
        isBuffering() {
            return false;
        }
        currentTime() {
            return media.currentTime * 1000;
        }
        getMediaDuration() {
            return 1000;
        }
        static prototypeResource = 'sound';
        static resolve(_owner: string, slug: string) {
            return Promise.resolve(new Sound(Number(slug.split('-').pop())));
        }
    }
    Object.assign(Sound.prototype, { resource_type: 'sound' });
    type Item = { sound: Sound; explicit: boolean };
    const queue = {
        models: [] as Item[],
        indexOf: (item: Item) => queue.models.indexOf(item),
        remove: (items: Item[]) => {
            queue.models = queue.models.filter((item) => !items.includes(item));
        },
    };
    const manager = Object.assign(new Events(), {
        getQueue: () => queue,
        getCurrentSound: () => current,
        getCurrentQueueItem: () => queue.models.find((item) => item.sound === current),
        addExplicitQueueItem: (_source: Sound, sound: Sound) => queue.models.push({ sound, explicit: true }),
        playSource: (_source: Sound, sound: Sound) => {
            queue.models = [{ sound, explicit: true }];
            manager.setCurrentItem(queue.models[0]);
        },
        playCurrent: () => {
            void media.play();
        },
        toggleCurrent: () => (media.paused ? void media.play() : media.pause()),
        playPrev: () => {},
        playNext: () => {
            const index = queue.indexOf(manager.getCurrentQueueItem()!);
            const next = queue.models[index + 1];
            if (next) manager.setCurrentItem(next);
        },
        setCurrentItem: (item: Item) => {
            current = item.sound;
            media.src = source;
            void media.play();
            manager.emit('change');
        },
    });
    media.addEventListener('timeupdate', () => current?.emit('timeupdate'));
    media.addEventListener('play', () => current?.emit('play'));
    media.addEventListener('pause', () => current?.emit('pause'));
    media.addEventListener('ended', () => {
        current?.emit('ended');
        manager.playNext();
    });
    const likes = Object.assign(new Events(), { get: () => likesValue });
    class Likes {}
    Object.assign(Likes.prototype, { readEndpoint: 'soundLikesIds' });
    Object.assign(Likes, { instances: { find: () => likes } });
    const actions = {
        like: () => {
            likesValue = !likesValue;
            likes.emit('change');
        },
        follow() {},
        repost() {},
    };
    const exports = [
        manager,
        Sound,
        Likes,
        actions,
        { createSoundFilter: () => () => true },
        { playWithSignupWall: (play: () => void) => play() },
    ];
    const seen = new Set<string>();
    let latest: any;
    const unbind = installNativePlayerMonitor(
        () => exports,
        (value: any) => {
            latest = value;
            seen.add(value.url);
        },
        (value: any) => {
            latest = value;
        },
    );
    assert(unbind, 'native SDK monitor starts');
    const trackUrl = (id: number) => `https://soundcloud.com/test/track-${id}`;
    const call = (operation: QueueRequest['operation'], ids: number[], replacement?: QueueRequest['replacement']) =>
        nativeQueueModel(
            {
                operation,
                urls: ids.map(trackUrl),
                ticket: crypto.randomUUID(),
                expires: Date.now() + 10000,
                replacement,
            },
            () => exports,
        );
    assert((await call('play', [1])).state === 'done', 'native play accepted');
    for (const id of [2, 3]) assert((await call('add', [id])).state === 'done', 'next-up commit ' + id);
    const review = await call('add', [3], {
        current: trackUrl(1),
        expected: [trackUrl(2), trackUrl(3)],
        remove: [trackUrl(2)],
    });
    assert(review.state === 'done' && review.urls?.[0] === trackUrl(3), 'next-up review changes the successor');
    for (const id of [2, 4, 5]) assert((await call('add', [id])).state === 'done', 'next-up commit ' + id);
    const deadline = performance.now() + 12000;
    while (seen.size < 5 && performance.now() < deadline) await wait(100);
    assert(
        seen.size === 5,
        'five natural tracks in an invisible WebView: ' +
            JSON.stringify({
                seen: [...seen],
                id: current?.id,
                paused: media.paused,
                ended: media.ended,
                position: media.currentTime,
                ready: media.readyState,
                error: media.error?.message,
                queue: queue.models.map((item) => item.sound.id),
            }),
    );
    assert([...seen][1] === trackUrl(3), 'revised successor plays at the natural transition');
    checks.push('background-revised-next-up');
    checks.push('five-natural-background-tracks');
    assert((await call('play', [6])).state === 'done', 'replay after queue end');
    await wait(150);
    nativePlayerCommand('toggle', () => exports);
    await wait(150);
    assert(media.paused && latest?.isPlaying === false, 'manual pause updates native monitor');
    checks.push('manual-pause');
    nativePlayerCommand('like', () => exports);
    await wait(100);
    assert(latest?.isLiked === true, 'like update');
    likesValue = false;
    await call('play', [7]);
    await wait(100);
    assert(latest?.isLiked === false, 'like resets for next track');
    checks.push('like-reset');
    const runtime = Object.assign(() => undefined, {
        c: Object.fromEntries(exports.map((value, index) => [index, { exports: value }])),
        m: {},
    });
    (window as any).__scRpcModules = [runtime];
    const wave = new Wave();
    const originalResolve = Sound.resolve;
    let releaseResolve: ((sound: Sound) => void) | undefined;
    Sound.resolve = (_owner, _slug) =>
        new Promise<Sound>((resolve) => {
            releaseResolve = resolve;
        });
    const pending = (wave as any).queue('play', ['https://soundcloud.com/test/track-8']);
    while (!releaseResolve) await wait(5);
    wave.stop();
    releaseResolve(new Sound(8));
    assert((await pending).state === 'cancelled' && current?.id === 7, 'stale playback cannot run after stopping wave');
    Sound.resolve = originalResolve;
    checks.push('pending-playback-cancellation');
    Sound.resolve = (_owner, _slug) => new Promise<Sound>(() => {});
    const hungAt = performance.now();
    const hung = await (wave as any).queue('add', ['https://soundcloud.com/test/track-9']);
    assert(
        hung.state === 'uncertain' && performance.now() - hungAt < 10000,
        'unresponsive SDK cannot block the queue indefinitely',
    );
    assert((window as any).__scRpcQueueTickets.size === 0, 'expired queue tickets are removed');
    Sound.resolve = originalResolve;
    checks.push('unresponsive-sdk-timeout');
    const isAd = current!.isAd;
    current!.isAd = () => true;
    assert(!(wave as any).canAdvance(), 'automatic recovery respects advertisements');
    current!.isAd = isAd;
    checks.push('ad-recovery-guard');
    media.pause();
    unbind!();
    assert(
        manager.count() === 0 && likes.count() === 0 && current!.count() === 0 && holds === 0,
        'listener and hold cleanup',
    );
    checks.push('listener-cleanup');
    const session = new RecommendationSession({ related: async () => [] }, () => 10000);
    session.loadFeedback(
        [1, 2, 3].map((id) => ({
            kind: 'like',
            at: 1000,
            track: {
                id: String(id),
                title: 'Known ' + id,
                artist: 'Seed ' + id,
                genre: 'drum and bass',
                tags: ['jungle', 'breakbeat'],
            },
        })),
    );
    session.addCandidates([
        {
            id: 'related',
            title: 'Fresh jungle',
            artist: 'New artist',
            genre: 'dnb',
            tags: ['jungle'],
            relatedTo: ['1'],
        },
        { id: 'bad', title: 'Promo', artist: 'Other', genre: 'country', tags: ['country'], relatedTo: ['1'] },
    ]);
    assert(session.rank(1)[0]?.track.id === 'related', 'shared taste relevance preserved');
    checks.push('recommendation-parity');
    const selection = (id: number) => ({
        url: trackUrl(id),
        apiId: id,
        title: 'Track ' + id,
        artist: 'Artist ' + id,
        genre: 'Hip-hop & Rap',
        sourceRank: 0,
    });
    const selected = selection(21);
    const model = new SoundCloudRecommender(profile, 'track-wave-smoke', async ([seed], advance) =>
        advance
            ? [{ ...selection(23), tags: ['boombap'], stationSeed: seed.id, stationRank: 0 }]
            : [
                  { ...selection(22), relatedTo: [seed.id] },
                  { ...selection(24), tags: ['sigilkore'], relatedTo: [seed.id] },
              ],
    );
    Object.assign(wave, {
        recommender: model,
        initialize: async () => {},
        candidates: new Map([[selected.url, selected]]),
    });
    installNativeStyles();
    const card = document.createElement('article');
    card.className = 'audibleTile playableTile';
    const title = document.createElement('a');
    title.href = selected.url;
    title.className = 'audibleTile__audibleHeading playableTile__heading';
    const more = document.createElement('button');
    more.className = 'sc-button-more';
    const menu = document.createElement('div');
    menu.className = 'dropdownMenu';
    menu.id = 'dropdown-button-fixture';
    const stationRow = document.createElement('div');
    stationRow.className = 'moreActions__group';
    const station = document.createElement('a');
    station.className = 'sc-button-startstation';
    station.textContent = 'Estación';
    station.href = '#station';
    stationRow.append(station);
    menu.append(stationRow);
    const otherMenu = menu.cloneNode(true) as HTMLElement;
    otherMenu.id = 'dropdown-button-other';
    document.body.append(otherMenu);
    more.setAttribute('aria-haspopup', 'true');
    more.setAttribute('aria-owns', menu.id);
    more.onclick = () => {
        if (menu.isConnected) menu.remove();
        else document.body.append(menu);
    };
    card.append(title, more);
    document.body.append(card);
    let trackWaveStart: Promise<void> | undefined;
    const removeMenu = installTrackWaveMenu(
        (url) => (trackWaveStart = wave.start(url)),
        (value) => value,
    );
    more.click();
    await wait(0);
    const trackWaveButton = station.nextElementSibling as HTMLButtonElement | null;
    assert(trackWaveButton?.textContent === 'Волна по треку', 'track wave follows Station in the official menu');
    assert(
        !otherMenu.querySelector('.sc-track-wave-action'),
        'track wave uses only the overlay owned by the clicked tile',
    );
    trackWaveButton!.click();
    await trackWaveStart;
    assert(!menu.isConnected && current?.id === 21, 'track wave plays the selected card and closes its menu');
    const trackWaveDeadline = performance.now() + 800;
    let successors = (await call('list', [])).urls || [];
    while (successors.length < 2 && performance.now() < trackWaveDeadline) {
        await wait(15);
        successors = (await call('list', [])).urls || [];
    }
    assert(
        successors.length === 2 && [22, 23].map(trackUrl).every((url) => successors.includes(url)),
        'track wave with sparse metadata preloads anchored successors: ' + successors.join(','),
    );
    wave.stop();
    media.pause();
    removeMenu();
    otherMenu.remove();
    card.remove();
    checks.push('track-menu-starts-selected-wave');
    checks.push('track-wave-sparse-seed-queues-station-and-related');
    installEqualizerEngine();
    assert(equalizerPresets.length >= 30, 'preset library');
    assert(
        normalizeEqualizer({ preamp: 99, gains: Array(10).fill(99) }).gains.every((gain) => gain <= 12),
        'equalizer input bounds',
    );
    checks.push('equalizer-presets');
    (window as any).__scSmokePhase = 'interface-styles';
    history.replaceState(null, '', '/');
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
    const stylesBefore = document.adoptedStyleSheets.length;
    installNativeStyles();
    installNativeStyles();
    assert(document.adoptedStyleSheets.length === stylesBefore, 'stylesheet installation is idempotent');
    (window as any).waveInline = {
        ready: async () => wave.ready(),
        on: (channel: string, listener: (...args: unknown[]) => void) => wave.events.on(channel, listener),
        controls: () => {},
    };
    let importProgress: ((state: object) => void) | undefined;
    let importDraft: object | undefined;
    let importWrites = 0;
    const importMatch = {
        source: { title: 'Source recording', artist: 'Original artist' },
        soundcloud: { apiId: 7, title: 'Found recording', artist: 'Uploader', score: 1 },
    };
    (window as any).playlistImporter = {
        onProgress: (callback: (state: object) => void) => {
            importProgress = callback;
        },
        draft: async () => importDraft,
        scan: async () => {
            importProgress?.({
                phase: 'matching',
                completed: 1,
                total: 2,
                tracks: [importMatch.source],
                index: 0,
                match: importMatch,
            });
            return (importDraft = { title: 'Partial import', matches: [importMatch], selected: [0], savedUrls: [] });
        },
        commit: async () => {
            importWrites++;
            importProgress?.({ phase: 'creating', completed: 0, total: 1 });
            throw new PlaylistRequestError('create', 403, 'browser', 'CAPTCHA required');
        },
        selection: () => {},
    };
    installWaveUI();
    await wait(300);
    const layout = nativeLayout();
    assert(layout.success, 'wave styles and SVG geometry: ' + JSON.stringify(layout));
    const importRoot = document.getElementById('codex-playlist-import')!;
    (importRoot.querySelector('.cw-import-open') as HTMLButtonElement).click();
    (importRoot.querySelector('.cw-import-source input') as HTMLInputElement).value =
        'https://music.yandex.ru/playlists/fixture';
    (importRoot.querySelector('[data-command="import-scan"]') as HTMLButtonElement).click();
    await wait(50);
    (importRoot.querySelector('.cw-import-commit') as HTMLButtonElement).click();
    await wait(50);
    assert(
        ['Не удалось сохранить плейлист', 'Could not save the playlist'].includes(
            importRoot.querySelector('.cw-import-caption')!.textContent || '',
        ),
        'write failure is not presented as a source error',
    );
    assert(
        importRoot.querySelectorAll('.cw-import-row').length === 1 && importWrites === 1,
        'CAPTCHA preserves matches without automatic write retries',
    );
    const verifyButton = importRoot.querySelector('.cw-import-verify') as HTMLButtonElement;
    assert(!verifyButton.hidden, 'verification handoff is visible');
    verifyButton.click();
    assert(
        !(importRoot.querySelector('.cw-import-dialog') as HTMLDialogElement).open,
        'import dialog releases the official page for human verification',
    );
    checks.push('import-captcha-preserves-matches');
    checks.push('import-write-stage-and-manual-verification');
    assert(layout.waveHeight < 600 && layout.importHeight < 250, 'cards fit the viewport');
    assert(
        getComputedStyle(document.querySelector('.cw-start svg:nth-child(2)')!).display === 'none',
        'pause icon hidden before playing',
    );
    checks.push('wave-styles-strict-csp');
    document.querySelector<HTMLButtonElement>('.cw-settings-open')!.click();
    await wait(100);
    const settingsDialog = document.querySelector<HTMLDialogElement>('.cw-settings-dialog')!;
    assert(settingsDialog.open && getComputedStyle(settingsDialog).position === 'fixed', 'settings dialog is styled');
    assert(settingsDialog.getBoundingClientRect().width <= innerWidth, 'settings fit viewport');
    settingsDialog.close();
    document.querySelector<HTMLButtonElement>('.cw-import-open')!.click();
    await wait(100);
    const importDialog = document.querySelector<HTMLDialogElement>('.cw-import-dialog')!;
    assert(importDialog.open && getComputedStyle(importDialog).borderRadius === '16px', 'import dialog is styled');
    importDialog.close();
    checks.push('native-dialog-layout');
    const consent = requestSignIn(
        'Spotify returned part of the list. Sign in or keep the available tracks.',
        false,
        new AbortController().signal,
    );
    await wait(80);
    const consentDialog = [...document.querySelectorAll<HTMLDialogElement>('.cw-import-dialog')].find(
        (dialog) => dialog !== importDialog,
    )!;
    assert(
        consentDialog?.open && getComputedStyle(consentDialog).borderRadius === '16px',
        'Spotify consent uses the existing dialog styles without blocking the event loop',
    );
    assert(consentDialog.getBoundingClientRect().width <= innerWidth, 'Spotify consent fits the viewport');
    consentDialog.querySelector<HTMLButtonElement>('button:last-child')!.click();
    assert(!(await consent) && !consentDialog.isConnected, 'Spotify refusal closes its own dialog');
    const abortConsent = new AbortController();
    const pendingConsent = requestSignIn('Spotify sign-in is optional.', true, abortConsent.signal);
    abortConsent.abort();
    assert(!(await pendingConsent), 'cancelled import closes the sign-in prompt');
    checks.push('nonblocking-spotify-consent');
    (window as any).soundcloudEqualizer = { save: () => {} };
    installEqualizerPanel({
        settings: normalizeEqualizer(undefined),
        presets: equalizerPresets,
        frequencies: equalizerFrequencies,
        interfaceLanguage: 'en',
        systemLocale: 'en-US',
    });
    const eq = document.getElementById('sc-equalizer')!.shadowRoot!;
    const eqToggle = eq.querySelector<HTMLButtonElement>('.toggle')!;
    assert(getComputedStyle(eqToggle).width === '32px', 'equalizer styles survive strict CSP');
    eqToggle.click();
    assert(!eq.querySelector<HTMLElement>('.panel')!.hidden, 'equalizer opens');
    assert(eq.querySelectorAll('.band input').length === 10, 'ten equalizer bands');
    eqToggle.click();
    await wait(100);
    assert(violations.length === 0, 'no blocked inline styles: ' + violations.join(', '));
    checks.push('equalizer-styles-strict-csp');
    new Function(speedPlugin.contentScript())();
    await wait(100);
    const speed = document.getElementById('scrpc-playback-speed-host')?.shadowRoot;
    assert(speed, 'bundled speed control is mounted');
    const speedToggle = speed!.querySelector<HTMLButtonElement>('.toggle')!;
    assert(getComputedStyle(speedToggle).height === '32px', 'speed plugin styles survive strict CSP');
    speedToggle.click();
    const speedPanel = document.getElementById('scrpc-playback-speed-panel-host')!.shadowRoot!;
    assert(!speedPanel.querySelector<HTMLElement>('.panel')!.hidden, 'speed presets open');
    speedPanel.querySelector<HTMLButtonElement>('[data-rate="1.5"]')!.click();
    assert(media.playbackRate === 1.5, 'speed preset updates application audio');
    (window as any).__scrpc_cleanup_playback_speed();
    assert(!document.getElementById('scrpc-playback-speed-host'), 'speed plugin cleans up its controls');
    assert(violations.length === 0, 'plugin generated no CSP style violations: ' + violations.join(', '));
    checks.push('sandbox-plugin-content-strict-csp');
    await invoke('smoke_settings', { open: true });
    type PanelState = {
        visible: boolean;
        bounds: number[];
        parentSize: number[];
        actualBounds: number[];
        parent: string;
        windows: number;
        webviews: number;
    };
    type SettingsResult = { success: boolean; checks: string[]; message?: string; panel: PanelState };
    let settingsResult: SettingsResult | null = null;
    for (let attempt = 0; attempt < 60 && !settingsResult; attempt++) {
        await wait(100);
        settingsResult = await invoke('smoke_settings', { open: false });
    }
    assert(settingsResult?.success, 'native settings integration: ' + JSON.stringify(settingsResult));
    checks.push(...settingsResult!.checks);
    const panel = settingsResult!.panel;
    assert(
        panel.parent === 'smoke' && panel.windows === 1 && panel.webviews === 2,
        'settings is a child view in the original window',
    );
    assert(
        panel.bounds[0] + panel.bounds[2] === panel.parentSize[0] &&
            panel.bounds[1] === 0 &&
            panel.bounds[3] < panel.parentSize[1],
        'settings stays on the right above the player',
    );
    assert(
        JSON.stringify(panel.actualBounds) === JSON.stringify(panel.bounds),
        'actual native controller bounds match the panel layout',
    );
    checks.push('settings-embedded-right-panel');
    const reopenedProfile = new Profile('settings');
    await reopenedProfile.load();
    assert(reopenedProfile.get('test') === 'persisted', 'main IPC still works with multiple child webviews');
    await invoke('native_diagnostics');
    const panelTracks = new Set<string>();
    const panelMonitor = installNativePlayerMonitor(
        () => exports,
        (value) => panelTracks.add((value as { url: string }).url),
        () => {},
    );
    await call('play', [31]);
    await call('add', [32]);
    await call('add', [33]);
    const panelDeadline = performance.now() + 6000;
    while (panelTracks.size < 4 && performance.now() < panelDeadline) await wait(100);
    assert(
        panelTracks.has('https://soundcloud.com/test/track-33'),
        'natural playback continues behind the settings panel',
    );
    panelMonitor!();
    checks.push('background-playback-with-settings');
    media.loop = true;
    await call('play', [34]);
    await wait(100);
    await invoke('smoke_settings', { open: false, action: 'close' });
    await wait(100);
    const closed = await invoke<SettingsResult>('smoke_settings', { open: false });
    assert(
        !closed.panel.visible && closed.panel.windows === 1 && !media.paused,
        'close button hides only the panel and keeps playback running',
    );
    const reopened = await invoke<SettingsResult>('smoke_settings', { open: true });
    assert(
        reopened.panel.visible && reopened.panel.windows === 1 && reopened.panel.webviews === 2 && !media.paused,
        'reopening reuses the panel and preserves playback',
    );
    await invoke('smoke_settings', { open: false, action: 'resize' });
    await wait(150);
    const resized = await invoke<SettingsResult>('smoke_settings', { open: false });
    assert(
        resized.panel.bounds[0] + resized.panel.bounds[2] === resized.panel.parentSize[0],
        'panel follows parent resize',
    );
    assert(
        JSON.stringify(resized.panel.actualBounds) === JSON.stringify(resized.panel.bounds),
        'actual child controller follows resize',
    );
    assert(!media.paused, 'parent resize keeps playback running');
    media.loop = false;
    media.pause();
    checks.push('settings-close-reopen-resize');
    const audio = await checkAudio(wave, media, () => likesValue);
    checks.push(
        'measured-audio-to-persistent-taste',
        'visible-live-listening-count',
        'windows-taskbar-native-command-routing',
    );
    URL.revokeObjectURL(source);
    await invoke('smoke_result', {
        report: {
            success: true,
            host: 'Rust + WebView2',
            checks,
            audio,
            layout,
            tracks: seen.size,
            elapsedMs: Math.round(performance.now() - started),
            hidden: document.hidden,
        },
    });
}

if (window === window.top)
    void test().catch((error) => {
        (window as any).__scSmokeError = String(error);
        return invoke('smoke_result', {
            report: { success: false, message: String(error), stack: error instanceof Error ? error.stack : undefined },
        });
    });
