import { invoke } from '../../native/frontend/bridge';
import type { NativePlayerCommand } from '../../src/soundcloud/nativePlayerBridge.ts';

export function installNativePlayerMonitor(
    _exports: () => unknown[],
    update: (track: unknown, cause: string) => void,
    progress: (track: unknown) => void,
): () => void {
    let previous = '';
    const receive = (event: Event) => {
        const track = (event as CustomEvent).detail;
        if (!track?.url) return;
        const signature = JSON.stringify([track.url, track.isPlaying, track.isLiked]);
        if (signature !== previous) {
            previous = signature;
            update(track, 'playback-state-change');
        } else progress(track);
    };
    window.addEventListener('android-track', receive);
    return () => window.removeEventListener('android-track', receive);
}

export function nativePlayerCommand(command: NativePlayerCommand, _exports?: () => unknown[]): string {
    void invoke('android_control', { command }).catch(console.error);
    return 'done';
}

export function nativeAutoplay(_enabled: boolean, _exports: () => unknown[]): null {
    return null;
}
