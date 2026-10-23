import { contextBridge, ipcRenderer } from 'electron';
import type { TrackInfo, TrackUpdateReason } from './types';
let waveTransportActive = false;
let waveNativeQueueReady = false;
let lastWavePointerDown = 0;
let lastWaveEndedAt = 0;
const sendWaveFinish = () => {
    if (!waveTransportActive || waveNativeQueueReady) return;
    const now = Date.now();
    if (now - lastWaveEndedAt < 1000) return;
    lastWaveEndedAt = now;
    ipcRenderer.send('wave-inline:control', 'finish');
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
            if (!waveTransportActive || waveNativeQueueReady) return;
            if (!(event.target instanceof Element) || !event.target.closest('.skipControl__next')) return;
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
    'ended',
    (event) => {
        if (!waveTransportActive || waveNativeQueueReady || !(event.target instanceof HTMLMediaElement)) return;
        event.stopImmediatePropagation();
        sendWaveFinish();
    },
    true,
);
window.addEventListener('__soundcloudWaveMediaEnded', sendWaveFinish, true);
contextBridge.exposeInMainWorld('soundcloudAPI', {
    sendTrackProgress: (data: TrackInfo) => {
        if (waveTransportActive) ipcRenderer.send('soundcloud:track-progress', data);
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
                'excluded-artists',
                'active',
                'state',
                'track',
                'stats',
                'candidate',
                'audio',
                'metadata',
                'controls',
                'scroll',
                'visibility',
                'route',
                'liked',
            ].includes(channel)
        )
            return;
        ipcRenderer.on(`wave-inline:${channel}`, (_event, ...args) => callback(...args));
    },
});
contextBridge.exposeInMainWorld('playlistImporter', {
    scan: (url: string) => ipcRenderer.invoke('playlist-import:scan', url),
    commit: (selection: { indexes: number[]; title: string }) =>
        ipcRenderer.invoke('playlist-import:commit', selection),
    cancel: () => ipcRenderer.send('playlist-import:cancel'),
    onProgress: (callback: (state: unknown) => void) =>
        ipcRenderer.on('playlist-import:progress', (_event, state) => callback(state)),
});
