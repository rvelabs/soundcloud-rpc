import { contextBridge, ipcRenderer } from 'electron';
import type { TrackInfo, TrackUpdateReason } from './types';
import { installWaveMediaEndCapture } from './wave/mediaEndCapture';
if (location.origin === 'https://soundcloud.com')
    contextBridge.executeInMainWorld({ func: installWaveMediaEndCapture });
let waveTransportActive = false;
let waveNativeQueueReady = false;
let lastWavePointerDown = 0;
let lastWaveEndedAt = 0;
let lastWaveEndedKey = '';
const sendWaveFinish = (path?: string, reason = 'finish') => {
    if (!waveTransportActive) return;
    const now = Date.now();
    const key = reason + ':' + (path || '');
    if (key === lastWaveEndedKey && now - lastWaveEndedAt < 1000) return;
    lastWaveEndedAt = now;
    lastWaveEndedKey = key;
    ipcRenderer.send('wave-inline:control', reason, path);
};
ipcRenderer.on('wave-inline:active', (_event, active: boolean) => {
    waveTransportActive = active;
});
ipcRenderer.on('wave-inline:queue-ready', (_event, ready: boolean) => {
    waveNativeQueueReady = ready;
});
void ipcRenderer
    .invoke('wave-inline:ready')
    .then((state) => {
        if (!state) return;
        waveTransportActive = Boolean(state.active);
        waveNativeQueueReady = Boolean(state.queueReady);
    })
    .catch(() => {});
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const) {
    window.addEventListener(
        type,
        (event) => {
            if (!waveTransportActive) return;
            if (!(event.target instanceof Element) || !event.target.closest('.skipControl__next')) return;
            if (waveNativeQueueReady && !(event.target.closest('.skipControl__next') as HTMLButtonElement).disabled) {
                if (type === 'click')
                    ipcRenderer.send(
                        'wave-inline:control',
                        'native-next',
                        document.querySelector<HTMLAnchorElement>('.playbackSoundBadge__titleLink')?.pathname,
                    );
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            if (type === 'pointerdown') {
                lastWavePointerDown = Date.now();
                ipcRenderer.send('wave-inline:control', 'next');
            } else if (type === 'click' && Date.now() - lastWavePointerDown > 750) {
                ipcRenderer.send('wave-inline:control', 'next');
            }
        },
        true,
    );
}
window.addEventListener(
    '__soundcloudWaveMediaEnded',
    (event) =>
        sendWaveFinish(
            typeof (event as CustomEvent).detail === 'string' ? (event as CustomEvent<string>).detail : undefined,
        ),
    true,
);
window.addEventListener(
    '__soundcloudWaveMediaError',
    (event) => {
        const path = (event as CustomEvent).detail;
        if (typeof path === 'string' && path) sendWaveFinish(path, 'error');
    },
    true,
);
window.addEventListener(
    '__soundcloudWavePrepareNext',
    () => {
        if (waveTransportActive) ipcRenderer.send('wave-inline:control', 'prepare');
    },
    true,
);
contextBridge.exposeInMainWorld('soundcloudAPI', {
    sendAudioFeatures: (features: unknown) => {
        if (waveTransportActive) ipcRenderer.send('wave-inline:audio', features);
    },
    sendTrackProgress: (data: TrackInfo) => {
        ipcRenderer.send('soundcloud:track-progress', data);
    },
    sendTrackUpdate: (data: TrackInfo, reason: TrackUpdateReason) => {
        ipcRenderer.send('soundcloud:track-update', {
            data,
            reason,
        });
    },
});
contextBridge.exposeInMainWorld('waveInline', {
    ready: () => ipcRenderer.invoke('wave-inline:ready'),
    copyDiagnostics: () => ipcRenderer.invoke('wave-inline:copy-diagnostics'),
    setLanguage: (language: string) => ipcRenderer.invoke('wave-inline:set-language', language),
    start: () => ipcRenderer.invoke('wave-inline:start'),
    control: (command: string, value?: unknown) => ipcRenderer.send('wave-inline:control', command, value),
    like: (url: string, desired: boolean) => ipcRenderer.invoke('wave-inline:like', url, desired),
    excludeArtist: (artist: string, excluded: boolean) =>
        ipcRenderer.invoke('wave-inline:exclude-artist', artist, excluded),
    dislike: (url: string) => ipcRenderer.invoke('wave-inline:dislike', url),
    controls: (value: unknown) => ipcRenderer.send('wave-inline:controls', value),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
        if (
            ![
                'interface-language',
                'excluded-artists',
                'active',
                'state',
                'track',
                'stats',
                'candidate',
                'metadata',
                'controls',
                'scroll',
                'route',
                'liked',
            ].includes(channel)
        )
            return;
        const listener = (_event: unknown, ...args: unknown[]) => callback(...args);
        ipcRenderer.on(`wave-inline:${channel}`, listener);
        return () => ipcRenderer.removeListener(`wave-inline:${channel}`, listener);
    },
});
contextBridge.exposeInMainWorld('playlistImporter', {
    draft: () => ipcRenderer.invoke('playlist-import:draft'),
    resume: () => ipcRenderer.invoke('playlist-import:resume'),
    selection: (input: unknown) => ipcRenderer.send('playlist-import:selection', input),
    scan: (url: string) => ipcRenderer.invoke('playlist-import:scan', url),
    scanFile: () => ipcRenderer.invoke('playlist-import:scan-file'),
    commit: (selection: { indexes: number[]; title: string }) =>
        ipcRenderer.invoke('playlist-import:commit', selection),
    cancel: () => ipcRenderer.send('playlist-import:cancel'),
    onProgress: (callback: (state: unknown) => void) => {
        const listener = (_event: unknown, state: unknown) => callback(state);
        ipcRenderer.on('playlist-import:progress', listener);
        return () => ipcRenderer.removeListener('playlist-import:progress', listener);
    },
});
