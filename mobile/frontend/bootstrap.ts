(() => {
    const page = window as any;
    if (page.__androidBridgeInstalled || !page.__SC_ANDROID) return;
    page.__androidBridgeInstalled = true;
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    page.__SC_ANDROID.onmessage = (event: MessageEvent) => {
        const result = JSON.parse(event.data);
        const request = pending.get(result.id);
        if (!request) return;
        pending.delete(result.id);
        clearTimeout(request.timer);
        if (result.error) request.reject(new Error(result.error));
        else request.resolve(result.value);
    };
    const invoke = (command: string, args: object = {}) => new Promise<any>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Android request timed out')); }, 25000);
        pending.set(id, { resolve, reject, timer });
        page.__SC_ANDROID.postMessage(JSON.stringify({ id, command, args }));
    });
    const local = new Set(['taskbar_update', 'presence_update', 'extensions_theme']);
    let equalizerStatus: object = { status: 'waiting', reason: 'native-connecting' };
    page.__soundcloudEqualizer = {
        set(value: object) {
            void invoke('android_equalizer', value).then((status) => {
                equalizerStatus = status;
                window.dispatchEvent(new Event('soundcloud-equalizer-status'));
            }).catch(console.error);
        },
        snapshot: () => equalizerStatus,
    };
    page.__TAURI_INTERNALS__ = {
        invoke(command: string, args: any = {}) {
            if (local.has(command)) return Promise.resolve(null);
            if (command === 'open_settings') {
                window.dispatchEvent(new Event('android-settings'));
                return Promise.resolve(null);
            }
            if (command === 'updates_status') return Promise.resolve({ mode: 'off', phase: 'idle' });
            if (command === 'extensions_apply') {
                window.dispatchEvent(new Event('android-mounted'));
                return Promise.resolve(null);
            }
            if (command === 'listening_save') return invoke('listening_options', args).then(async (value) => {
                await page.__soundcloudNative?.settingsChanged(); return value;
            });
            if (command === 'client_options' && args.options) return invoke(command, args).then(async (value) => {
                await page.__soundcloudNative?.settingsChanged(); return value;
            });
            if (command === 'lastfm_action' && args.action === 'authorize') return invoke(command, args).then(async (value) => {
                await invoke('android_open', { url: value.url }); return invoke('listening_options');
            });
            if (command === 'android_control' && args.command === 'like') {
                window.dispatchEvent(new Event('android-like')); return Promise.resolve(null);
            }
            if (command === 'worker_setup_action' && args.action === 'dashboard') return invoke('android_open', { url: 'https://dash.cloudflare.com/profile/api-tokens' });
            return invoke(command, args);
        },
    };
    page.__androidPlayback = (track: any) => {
        if (page.__androidKnownLikes?.has(track.url)) track.isLiked = page.__androidKnownLikes.get(track.url);
        page.__androidCurrentTrack = track;
        window.dispatchEvent(new CustomEvent('android-track', { detail: track }));
    };
    const viewport = () => {
        let meta = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
        if (!meta && document.head) {
            meta = document.createElement('meta'); meta.name = 'viewport'; document.head.append(meta);
        }
        if (meta) meta.content = 'width=device-width,initial-scale=1,viewport-fit=cover';
    };
    viewport();
    document.addEventListener('DOMContentLoaded', viewport, { once: true });
})();
