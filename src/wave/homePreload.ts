import { contextBridge, ipcRenderer } from 'electron';
import type { AudioFeatures } from './waveEngine';
contextBridge.exposeInMainWorld('waveHome', {
    start: () => ipcRenderer.invoke('wave-home:start'),
    showSoundCloud: () => ipcRenderer.send('wave-home:back'),
    navigate: (target: string) => ipcRenderer.send('wave-home:navigate', target),
    audio: (features: AudioFeatures) => ipcRenderer.send('wave-home:audio', features),
    next: (reason: 'user' | 'finish' | 'error' = 'user') => ipcRenderer.send('wave-home:next', reason),
    previous: () => ipcRenderer.send('wave-home:previous'),
    shuffle: (enabled: boolean) => ipcRenderer.send('wave-home:shuffle', enabled),
    track: (track: unknown) => ipcRenderer.send('wave-home:track-update', track),
    metadata: (url: string, metadata: unknown) => ipcRenderer.send('wave-home:metadata', url, metadata),
    openTrack: (url: string) => ipcRenderer.send('wave-home:open-track', url),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
        if (
            ![
                'wave-home:state',
                'wave-home:track',
                'wave-home:visible',
                'wave-home:stats',
                'wave-home:play-track',
                'wave-home:pause',
                'wave-home:restart',
                'wave-home:command',
                'wave-home:stop-audio',
                'wave-home:liked',
            ].includes(channel)
        )
            return;
        ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    },
});
