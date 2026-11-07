import { Wave } from './wave';
import { applyPreferences, type Preferences } from './clientPreferences';
import { Importer } from './importer';
import { Profile, api, invoke } from './bridge';
import { installEqualizerEngine } from '../../src/audio/equalizerEngine';
import { installEqualizerPanel } from '../../src/audio/equalizerPanel';
import { equalizerFrequencies, equalizerPresets, normalizeEqualizer } from '../../src/audio/equalizerSettings';
import { waveEnglish, translateWaveText } from '../../src/wave/i18n';
import { installWaveUI } from 'soundcloud-wave-ui';
import { nativeRuntimeExports } from '../../src/soundcloud/nativeRuntime';
import { installAudioFeatureCapture } from '../../src/wave/audioFeatureCapture';
import { installNativeStyles, nativeLayout } from './styles';
import { PresenceBridge } from './presence';
import { ListeningBridge } from './listening';
import { TaskbarBridge } from './taskbar';
import type { UpdateState } from './updateSettings';

async function boot() {
    if (window !== window.top || location.origin !== 'https://soundcloud.com') return;
    const page = window as any;
    if (page.__soundcloudNative) return;
    if (page.__SC_NATIVE_TASTE_AUDIT) {
        page.__soundcloudNative = { tick: async () => {} };
        await import('./tasteAudit').then((module) => module.tasteAudit());
        return;
    }
    const errors: string[] = [];
    window.addEventListener('error', (event) => {
        errors.push(String(event.error?.stack || event.message).slice(0, 1200));
        if (errors.length > 16) errors.shift();
    });
    window.addEventListener('unhandledrejection', (event) => {
        errors.push(String(event.reason?.stack || event.reason).slice(0, 1200));
        if (errors.length > 16) errors.shift();
    });
    const wave = new Wave(),
        importer = new Importer(),
        settings = new Profile('settings');
    const presence = new PresenceBridge();
    const listening = new ListeningBridge();
    const taskbar = new TaskbarBridge(undefined, () => {
        const language = settings.get('language', 'auto');
        return language === 'auto' ? navigator.language : String(language);
    });
    wave.events.on('track', (track) => taskbar.observe(track));
    wave.events.on('track', (track) => presence.observe(track));
    wave.events.on('track', (track) => listening.observe(track));
    const updateNotice = (state: UpdateState) => {
        if (
            state.mode === 'off' ||
            !['available', 'ready'].includes(state.phase) ||
            !state.version ||
            page.__dismissedNativeUpdate === state.version
        )
            return;
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => updateNotice(state), { once: true });
            return;
        }
        installNativeStyles();
        document.getElementById('native-update-notice')?.remove();
        const russian =
            settings.get('language', 'auto') === 'ru' ||
            (settings.get('language', 'auto') === 'auto' && navigator.language.toLowerCase().startsWith('ru'));
        const notice = document.createElement('div');
        notice.id = 'native-update-notice';
        notice.setAttribute('role', 'status');
        const open = document.createElement('button');
        open.textContent =
            (russian ? 'Обновление SoundCloud ' : 'SoundCloud update ') +
            state.version +
            (state.phase === 'ready' ? (russian ? ' готово · F1' : ' ready · F1') : ' · F1');
        open.onclick = () => void invoke('open_settings').catch(console.error);
        const close = document.createElement('button');
        close.textContent = '×';
        close.setAttribute('aria-label', russian ? 'Скрыть' : 'Dismiss');
        close.onclick = () => {
            page.__dismissedNativeUpdate = state.version;
            notice.remove();
        };
        notice.append(open, close);
        document.body.append(notice);
    };
    const settingsChanged = async () => {
        applyPreferences(await invoke<Preferences>('client_options'));
        listening.configure((await invoke<{ enabled: boolean }>('listening_status')).enabled);
        updateNotice(await invoke<UpdateState>('updates_status'));
    };
    document.addEventListener(
        'keydown',
        (event) => {
            if (event.key === 'F1') {
                event.preventDefault();
                if (event.repeat) return;
                void invoke('open_settings').catch(console.error);
            }
        },
        true,
    );
    let ticking = false;
    let probed = false;
    let monitorReported = false;
    page.__soundcloudNative = {
        settingsChanged,
        updateNotice,
        tick: async () => {
            if (ticking) return;
            ticking = true;
            try {
                await wave.tick();
                if (wave.monitorReady && !monitorReported) {
                    await invoke('monitor_ready', { ready: true });
                    monitorReported = true;
                }
                if (
                    page.__SC_NATIVE_PROBE &&
                    !probed &&
                    (((await invoke<any>('native_diagnostics')).catalog?.ready === true &&
                        Boolean(document.getElementById('codex-wave-inline')?.isConnected)) ||
                        performance.now() > 30000)
                ) {
                    probed = true;
                    const nativeApi = await api('search', { query: 'Nujabes' })
                        .then((result) => ({
                            success: Array.isArray(result.collection),
                            items: result.collection?.length || 0,
                        }))
                        .catch((error) => ({ success: false, message: String(error) }));
                    const host = await invoke<any>('native_diagnostics');
                    const layout = nativeLayout();
                    const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
                        .map((resource) => {
                            const url = new URL(resource.name);
                            return {
                                host: url.host,
                                path: url.pathname,
                                durationMs: Math.round(resource.duration),
                                status: (resource as any).responseStatus,
                            };
                        })
                        .filter((resource) => /soundcloud|sndcdn/.test(resource.host));
                    await invoke('smoke_result', {
                        report: {
                            success:
                                nativeRuntimeExports().length > 0 &&
                                host.catalog?.ready === true &&
                                nativeApi.success &&
                                layout.success,
                            layout,
                            type: 'public-soundcloud-page',
                            title: document.title,
                            modules: nativeRuntimeExports().length,
                            waveMounted: Boolean(
                                document.getElementById('codex-wave-inline') ||
                                    document.querySelector('[data-placement]'),
                            ),
                            host,
                            nativeApi,
                            resources: resources.slice(-40),
                            errors,
                            pageText: document.querySelector('#content')?.textContent?.slice(0, 800),
                        },
                    });
                }
            } catch (error) {
                console.error('Native wave task failed', error);
            } finally {
                ticking = false;
            }
        },
        control: (command: string) => wave.control(command),
        diagnostics: () => wave.diagnostics(),
    };
    installEqualizerEngine();
    void invoke('wave_active', { active: false }).catch(console.error);
    void invoke('monitor_ready', { ready: false }).catch(console.error);
    page.soundcloudAPI = {
        sendAudioFeatures: (value: unknown) => wave.audio(value),
        sendAudioAnalysisStatus: (value: unknown) => wave.audioStatus(value),
    };
    installAudioFeatureCapture();
    await settings.load();
    await settingsChanged();
    page.__waveInitialLanguage = settings.get('language', 'auto');
    page.__waveSystemLocale = navigator.language;
    page.__waveEnglish = waveEnglish;
    page.__waveTranslate = translateWaveText;
    page.waveInline = {
        ready: async () => ({ ...wave.ready(), interfaceLanguage: settings.get('language', 'auto') }),
        on: (channel: string, callback: (...args: unknown[]) => void) => wave.events.on(channel, callback),
        start: () => wave.start(),
        controls: (controls: any) => void wave.settings(controls).catch(console.error),
        control: (command: string) => wave.control(command),
        excludeArtist: (artist: string, excluded: boolean) => wave.exclude(artist, excluded),
        dislike: (url: string) => wave.dislike(url),
        setLanguage: async (language: string) => {
            if (!['auto', 'ru', 'en'].includes(language)) return;
            settings.set('language', language);
            await settings.flush();
            page.__soundcloudEqualizerPanel?.language(language);
        },
        copyDiagnostics: async () => {
            const value = {
                ...(await invoke<object>('native_diagnostics')),
                wave: wave.diagnostics(),
                importer: importer.diagnostics(),
            };
            await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
        },
    };
    page.playlistImporter = importer;
    const eq = normalizeEqualizer(settings.get('equalizer'));
    page.soundcloudEqualizer = {
        save: (value: unknown) => {
            const next = normalizeEqualizer(value);
            page.__soundcloudEqualizer?.set(next);
            settings.set('equalizer', next);
        },
    };
    const mount = async () => {
        installNativeStyles();
        installWaveUI();
        installEqualizerPanel({
            settings: eq,
            presets: equalizerPresets,
            frequencies: equalizerFrequencies,
            interfaceLanguage: settings.get('language', 'auto') as string,
            systemLocale: navigator.language,
        });
        page.__soundcloudEqualizer?.set(eq);
        await invoke('extensions_apply');
        await page.__soundcloudNative.tick();
        if (page.__SC_NATIVE_ACCOUNT_CHECK)
            void import('./accountCheck').then((module) => module.accountCheck(wave, importer)).catch(console.error);
    };
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', () => void mount().catch(console.error), { once: true });
    else await mount();
    window.addEventListener('pagehide', () => {
        taskbar.clear();
        void presence.clear().catch(() => {});
        void listening.clear().catch(() => {});
        void wave.dispose();
    });
    window.addEventListener('popstate', () => wave.events.emit('route'));
}

void boot().catch((error) => console.error('SoundCloud native initialization failed', error));
