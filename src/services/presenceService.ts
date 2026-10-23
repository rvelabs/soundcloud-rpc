import type ElectronStore from 'electron-store';
import { ActivityType } from 'discord-api-types/v10';
import { Client as DiscordClient, SetActivity } from '@xhayper/discord-rpc';
import { TranslationService } from './translationService';
import { normalizeTrackInfo } from '../utils/trackParser';
import type { TrackInfo } from '../types';
export interface Info {
    rpc: DiscordClient;
    ready: boolean;
    autoReconnect: boolean;
}
export class PresenceService {
    private store: ElectronStore;
    private info: Info;
    private displayWhenIdling: boolean;
    private displaySCSmallIcon: boolean;
    private displayButtons: boolean;
    private statusDisplayType: number;
    private translationService: TranslationService;
    private loginTask?: Promise<void>;
    private nextLoginAt = 0;
    private revision = 0;
    constructor(store: ElectronStore, translationService: TranslationService) {
        this.store = store;
        this.displayWhenIdling = store.get('displayWhenIdling', false) as boolean;
        this.displaySCSmallIcon = store.get('displaySCSmallIcon', false) as boolean;
        this.displayButtons = store.get('displayButtons', false) as boolean;
        this.translationService = translationService;
        this.statusDisplayType = (store.get('statusDisplayType') as number) ?? 1;
        this.info = {
            rpc: new DiscordClient({
                clientId: '1090770350251458592',
            }),
            ready: false,
            autoReconnect: true,
        };
        if (store.get('discordRichPresence')) void this.connect();
    }
    private async connect(): Promise<void> {
        if (this.info.rpc.isConnected) return;
        if (this.loginTask) return this.loginTask;
        if (Date.now() < this.nextLoginAt) return;
        this.nextLoginAt = Date.now() + 30000;
        const task = this.info.rpc.login().catch((error) => console.debug('Discord RPC unavailable:', error));
        this.loginTask = task;
        try {
            await task;
        } finally {
            if (this.loginTask === task) this.loginTask = undefined;
        }
    }
    public async updatePresence(trackInfo: TrackInfo): Promise<void> {
        const revision = ++this.revision;
        try {
            if (!this.store.get('discordRichPresence')) {
                this.clearActivity();
                return;
            }
            if (trackInfo.isPlaying) {
                if (!trackInfo.title || !trackInfo.author) {
                    console.log('Incomplete track info:', trackInfo);
                    return;
                }
                const normalizedTrack = normalizeTrackInfo(
                    trackInfo.title,
                    trackInfo.author,
                    this.store.get('trackParserEnabled', true) as boolean,
                );
                const currentTrack = {
                    author: normalizedTrack.artist,
                    title: normalizedTrack.track,
                    url: trackInfo.url,
                };
                const [elapsedTime, totalTime] = [trackInfo.elapsed, trackInfo.duration];
                const artworkUrl = trackInfo.artwork;
                const parseTimeToMs = (time: string): number => {
                    if (!time) return 0;
                    const isNegative = time.trim().startsWith('-');
                    const raw = isNegative ? time.trim().slice(1) : time.trim();
                    const parts = raw.split(':').map((p) => Number(p));
                    let seconds = 0;
                    for (const part of parts) {
                        seconds = seconds * 60 + (isNaN(part) ? 0 : part);
                    }
                    const ms = seconds * 1000;
                    return isNegative ? -ms : ms;
                };
                const elapsedMilliseconds = Math.max(0, parseTimeToMs(elapsedTime));
                const parsedTotal = parseTimeToMs(totalTime);
                const totalMilliseconds = parsedTotal < 0 ? elapsedMilliseconds + Math.abs(parsedTotal) : parsedTotal;
                if (totalMilliseconds <= 0) return;
                if (!this.info.rpc.isConnected) {
                    await this.connect();
                }
                if (revision !== this.revision || !this.info.rpc.isConnected || !this.store.get('discordRichPresence'))
                    return;
                const now = Date.now();
                const startTimestamp = now - elapsedMilliseconds;
                const endTimestamp = startTimestamp + totalMilliseconds;
                const activity: SetActivity & {
                    name?: string;
                    statusDisplayType?: number;
                } = {
                    type: ActivityType.Listening,
                    name: this.statusDisplayType === 1 ? currentTrack.author : 'SoundCloud',
                    details: `${this.shortenString(currentTrack.title)}${currentTrack.title.length < 2 ? '⠀⠀' : ''}`,
                    state: `${this.shortenString(currentTrack.author)}${currentTrack.author.length < 2 ? '⠀⠀' : ''}`,
                    largeImageKey: artworkUrl ? artworkUrl.replace('50x50.', '500x500.') : undefined,
                    startTimestamp,
                    endTimestamp,
                    smallImageKey: this.displaySCSmallIcon ? 'soundcloud-logo' : '',
                    smallImageText: this.displaySCSmallIcon ? 'SoundCloud' : '',
                    statusDisplayType: this.statusDisplayType,
                    instance: false,
                };
                if (this.displayButtons && currentTrack.url) {
                    activity.buttons = [
                        {
                            label: `▶️ ${this.translationService.translate('listenOnSoundcloud')}`,
                            url: currentTrack.url,
                        },
                    ];
                }
                await this.info.rpc.user?.setActivity(activity);
            } else if (this.displayWhenIdling && this.store.get('discordRichPresence')) {
                await this.info.rpc.user?.setActivity({
                    details: 'Listening to SoundCloud',
                    state: 'Paused',
                    largeImageKey: 'idling',
                    largeImageText: 'Paused',
                    smallImageKey: 'soundcloud-logo',
                    smallImageText: 'SoundCloud',
                    instance: false,
                });
            } else {
                await this.info.rpc.user?.clearActivity();
            }
        } catch (error) {
            console.error('Error during RPC update:', error);
        }
    }
    public updateDisplaySettings(
        displayWhenIdling: boolean,
        displaySCSmallIcon: boolean,
        displayButtons?: boolean,
    ): void {
        this.displayWhenIdling = displayWhenIdling;
        this.displaySCSmallIcon = displaySCSmallIcon;
        if (displayButtons !== undefined) {
            this.displayButtons = displayButtons;
        }
    }
    public setStatusDisplayType(statusDisplayType: number): void {
        this.statusDisplayType = statusDisplayType;
    }
    public async reconnect(): Promise<void> {
        this.nextLoginAt = 0;
        await this.connect();
    }
    public isConnected(): boolean {
        return this.info.rpc.isConnected;
    }
    public clearActivity(): void {
        this.revision++;
        void this.info.rpc.user
            ?.clearActivity()
            .catch((error) => console.debug('Discord clear activity failed:', error));
    }
    public dispose(): void {
        this.revision++;
        void this.info.rpc.destroy().catch(() => {});
    }
    private shortenString(str: string): string {
        return str.length > 128 ? str.substring(0, 125) + '...' : str;
    }
}
