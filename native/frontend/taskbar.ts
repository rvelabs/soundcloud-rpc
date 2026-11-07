import { invoke } from './bridge';
type Track = { url: string; title: string; isPlaying: boolean; isLiked: boolean };
export class TaskbarBridge {
    private signature = '';
    constructor(
        private send = (playback: object) => invoke('taskbar_update', { playback }),
        private language = () => navigator.language,
    ) {}
    observe(track: Track): void {
        const playback = {
            available: Boolean(track.url && track.title),
            playing: track.isPlaying === true,
            liked: track.isLiked === true,
            russian: this.language().toLowerCase().startsWith('ru'),
        };
        const key = JSON.stringify(playback);
        if (key === this.signature) return;
        this.signature = key;
        void this.send(playback).catch(() => {
            this.signature = '';
        });
    }
    clear(): void {
        this.observe({ url: '', title: '', isPlaying: false, isLiked: false });
    }
}
