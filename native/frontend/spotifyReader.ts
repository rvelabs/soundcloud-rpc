import { spotifySnapshot } from '../../src/import/spotifySnapshot';
import { invoke } from './bridge';

if (window === window.top && location.origin === 'https://open.spotify.com') {
    const page = window as Window & { __nativeSpotifyJobId?: string; __nativeSpotifyRead?: () => Promise<void> };
    let busy = false;
    page.__nativeSpotifyRead = async () => {
        const id = page.__nativeSpotifyJobId;
        if (busy || !id) return;
        busy = true;
        try {
            await invoke('spotify_page', { id, snapshot: spotifySnapshot() });
        } finally {
            busy = false;
        }
    };
}
