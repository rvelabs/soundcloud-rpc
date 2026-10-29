import type { BrowserWindow } from 'electron';
import type { ConnectionRecovery } from '../network/connectionRecovery';
import { loadSourcePlaylist } from './loadSource';
import { completeSpotifyPlaylist } from './spotifyBrowser';
import { classifyPlaylistUrl, type SourcePlaylist } from './source';
import type { PlaylistSourceNetwork } from './sourceNetwork';
export class PlaylistSourceReader {
    constructor(
        private options: {
            parent: BrowserWindow;
            account: string;
            connection: ConnectionRecovery;
            network?: PlaylistSourceNetwork;
            relayFirst: () => boolean;
            russian: () => boolean;
            progress: (read: number, total: number, message: string) => void;
        },
    ) {}
    async read(link: string, signal: AbortSignal): Promise<SourcePlaylist> {
        const { connection } = this.options;
        const country =
            classifyPlaylistUrl(link).platform === 'yandex' && this.options.relayFirst()
                ? await this.options.network?.country(signal)
                : undefined;
        const progress = (page: SourcePlaylist) =>
            this.options.progress(
                page.readTracks || page.tracks.length,
                page.expectedTracks || 0,
                'Читаем продолжение плейлиста…',
            );
        const source = await loadSourcePlaylist(link, signal, {
            relay: connection.canLoadPlaylistSource()
                ? (url, cancel, init) => connection.loadPlaylistSource(url, cancel, init)
                : undefined,
            preferRelay: this.options.relayFirst(),
            country,
            direct: this.options.network
                ? (url, cancel, init) => this.options.network!.load(url, cancel, init)
                : undefined,
            onPage: progress,
            onRoute: (route) =>
                this.options.progress(
                    0,
                    0,
                    route === 'relay' ? 'Читаем плейлист через Worker…' : 'Читаем плейлист напрямую…',
                ),
        });
        if (source.platform !== 'spotify' || !source.partial) return source;
        try {
            return await completeSpotifyPlaylist(source, link, {
                parent: this.options.parent,
                account: this.options.account,
                signal,
                russian: this.options.russian(),
                configure: (target, force) => connection.configurePlaylistSession(target, force),
                progress,
            });
        } catch (error) {
            signal.throwIfAborted();
            console.debug('Spotify source continuation unavailable:', error instanceof Error ? error.name : 'Error');
            return { ...source, partialReason: 'network' };
        }
    }
}
