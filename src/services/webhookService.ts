import { DeliveryOutbox } from './deliveryOutbox';
import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/asyncDataStore';
import type ElectronStore from 'electron-store';
import fetch from 'cross-fetch';
import { normalizeTrackInfo } from '../utils/trackParser';
import type { WebhookTrackData as WebhookInputData } from '../types';
export interface WebhookTrackData {
    artist: string;
    track: string;
    album?: string;
    albumArtist?: string;
    duration: number;
    trackArt?: string;
    originUrl: string;
}
export interface WebhookState {
    artist: string;
    track: string;
    startTime: number;
    duration: number;
    webhookSent: boolean;
    deliveryQueued?: boolean;
    originUrl: string;
    trackArt: string;
    isPaused: boolean;
    pausedTime: number;
    lastElapsedSeconds: number;
}
function timeStringToSeconds(timeStr: string | undefined): number {
    if (!timeStr || typeof timeStr !== 'string') return 0;
    try {
        const isNegative = timeStr.trim().startsWith('-');
        const raw = isNegative ? timeStr.trim().slice(1) : timeStr.trim();
        const parts = raw.split(':').map((p) => Number(p));
        let seconds = 0;
        for (const part of parts) {
            seconds = seconds * 60 + (isNaN(part) ? 0 : part);
        }
        return Math.max(1, Math.abs(seconds));
    } catch (error) {
        console.error('Error parsing time string:', error);
        return 0;
    }
}
function shouldSendWebhook(state: WebhookState, triggerPercentage: number): boolean {
    const totalElapsed = (Date.now() - state.startTime) / 1000;
    const playedTime = totalElapsed - state.pausedTime;
    const targetTime = (state.duration * triggerPercentage) / 100;
    return state.duration > 0 && !state.webhookSent && !state.deliveryQueued && playedTime >= targetTime;
}
export class WebhookService {
    private store: ElectronStore;
    private currentWebhookState: WebhookState | null = null;
    private webhookTimeout: NodeJS.Timeout | null = null;
    private pauseStartTime: number = 0;
    private outbox: DeliveryOutbox<{ track: WebhookTrackData; timestamp: string; scope: string; id: string }>;
    private deliveryScope(): string {
        return createHash('sha256')
            .update(String(this.store.get('webhookUrl') || ''))
            .digest('hex');
    }
    constructor(store: ElectronStore, dataStore: DataStore = store) {
        this.store = store;
        this.outbox = new DeliveryOutbox(
            dataStore,
            'webhookOutboxV1',
            async (item) => {
                if (item.scope !== this.deliveryScope()) return 'drop';
                const response = await fetch(String(this.store.get('webhookUrl')), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.id },
                    body: JSON.stringify({ timestamp: item.timestamp, eventId: item.id, ...item.track }),
                    signal: AbortSignal.timeout(10000),
                });
                if (!response.ok)
                    return response.status === 429 || response.status === 408 || response.status >= 500
                        ? 'retry'
                        : 'drop';
                const state = this.currentWebhookState;
                if (
                    state &&
                    state.track === item.track.track &&
                    state.artist === item.track.artist &&
                    new Date(state.startTime).toISOString() === item.timestamp
                )
                    state.webhookSent = true;
                return 'sent';
            },
            () => this.store.get('webhookEnabled') === true,
        );
    }
    private scheduleWebhook(): void {
        if (this.webhookTimeout) {
            clearTimeout(this.webhookTimeout);
            this.webhookTimeout = null;
        }
        if (
            !this.currentWebhookState ||
            this.currentWebhookState.webhookSent ||
            this.currentWebhookState.deliveryQueued ||
            this.currentWebhookState.isPaused ||
            this.currentWebhookState.duration <= 0
        ) {
            return;
        }
        const webhookEnabled = this.store.get('webhookEnabled') as boolean;
        if (!webhookEnabled) return;
        const triggerPercentage = this.store.get('webhookTriggerPercentage', 50) as number;
        const targetTime = (this.currentWebhookState.duration * triggerPercentage) / 100;
        const totalElapsed = (Date.now() - this.currentWebhookState.startTime) / 1000;
        const playedTime = totalElapsed - this.currentWebhookState.pausedTime;
        const remainingTime = Math.max(0, targetTime - playedTime);
        if (remainingTime <= 0) {
            this.sendScheduledWebhook();
        } else {
            this.webhookTimeout = setTimeout(() => {
                this.sendScheduledWebhook();
            }, remainingTime * 1000);
        }
    }
    private async sendScheduledWebhook(): Promise<void> {
        this.webhookTimeout = null;
        const state = this.currentWebhookState;
        if (
            !state ||
            state.webhookSent ||
            state.deliveryQueued ||
            state.isPaused ||
            !this.store.get('webhookEnabled')
        ) {
            return;
        }
        state.deliveryQueued = true;
        await this.sendWebhook({
            artist: state.artist,
            track: state.track,
            duration: state.duration,
            originUrl: state.originUrl,
            trackArt: state.trackArt,
        });
    }
    private async sendWebhook(trackData: WebhookTrackData): Promise<void> {
        if (!this.store.get('webhookEnabled') || !this.store.get('webhookUrl')) return;
        const timestamp = new Date(this.currentWebhookState?.startTime || Date.now()).toISOString();
        const scope = this.deliveryScope();
        const id = createHash('sha256')
            .update(JSON.stringify([scope, trackData.artist, trackData.track, timestamp]))
            .digest('hex');
        this.outbox.enqueue(id, { track: trackData, timestamp, scope, id });
    }
    public async updateTrackInfo(trackInfo: WebhookInputData, isPlaying: boolean = true): Promise<void> {
        const webhookEnabled = this.store.get('webhookEnabled') as boolean;
        if (!webhookEnabled) return;
        this.outbox.start();
        if (!trackInfo.title || !trackInfo.author) {
            return;
        }
        const normalizedTrack = normalizeTrackInfo(
            trackInfo.title,
            trackInfo.author,
            this.store.get('trackParserEnabled', true) as boolean,
        );
        const currentTrack = {
            artist: normalizedTrack.artist,
            track: normalizedTrack.track,
        };
        const triggerPercentage = this.store.get('webhookTriggerPercentage', 50) as number;
        if (this.currentWebhookState) {
            if (!isPlaying && !this.currentWebhookState.isPaused) {
                this.currentWebhookState.isPaused = true;
                this.pauseStartTime = Date.now();
                if (this.webhookTimeout) {
                    clearTimeout(this.webhookTimeout);
                    this.webhookTimeout = null;
                }
            } else if (isPlaying && this.currentWebhookState.isPaused) {
                this.currentWebhookState.isPaused = false;
                this.currentWebhookState.pausedTime += (Date.now() - this.pauseStartTime) / 1000;
                this.pauseStartTime = 0;
                this.scheduleWebhook();
            }
        }
        const elapsedSeconds = timeStringToSeconds(trackInfo.elapsed);
        const isLoop =
            this.currentWebhookState &&
            this.currentWebhookState.artist === currentTrack.artist &&
            this.currentWebhookState.track === currentTrack.track &&
            elapsedSeconds <= 3 &&
            this.currentWebhookState.duration > 0 &&
            this.currentWebhookState.lastElapsedSeconds >= this.currentWebhookState.duration - 3;
        if (
            !this.currentWebhookState ||
            this.currentWebhookState.artist !== currentTrack.artist ||
            this.currentWebhookState.track !== currentTrack.track ||
            isLoop
        ) {
            if (
                this.currentWebhookState &&
                !this.currentWebhookState.isPaused &&
                !this.currentWebhookState.webhookSent &&
                shouldSendWebhook(this.currentWebhookState, triggerPercentage)
            ) {
                this.currentWebhookState.deliveryQueued = true;
                void this.sendWebhook({
                    artist: this.currentWebhookState.artist,
                    track: this.currentWebhookState.track,
                    duration: this.currentWebhookState.duration,
                    originUrl: this.currentWebhookState.originUrl,
                    trackArt: this.currentWebhookState.trackArt,
                });
            }
            this.currentWebhookState = {
                artist: currentTrack.artist,
                track: currentTrack.track,
                startTime: Date.now(),
                duration: timeStringToSeconds(trackInfo.duration),
                webhookSent: false,
                originUrl: trackInfo.url,
                trackArt: trackInfo.artwork,
                isPaused: !isPlaying,
                pausedTime: 0,
                lastElapsedSeconds: elapsedSeconds,
            };
            if (!isPlaying) {
                this.pauseStartTime = Date.now();
            } else {
                this.scheduleWebhook();
            }
        } else if (this.currentWebhookState.duration <= 0) {
            this.currentWebhookState.duration = timeStringToSeconds(trackInfo.duration);
            this.scheduleWebhook();
        }
        this.currentWebhookState.lastElapsedSeconds = elapsedSeconds;
    }
    public setTriggerPercentage(percentage: number): void {
        let validPercentage = Math.max(0, Math.min(100, percentage));
        if (isNaN(validPercentage)) {
            validPercentage = 50;
        }
        this.store.set('webhookTriggerPercentage', validPercentage);
        this.scheduleWebhook();
    }
    public setWebhookUrl(url: string): void {
        this.store.set('webhookUrl', url);
    }
    public setEnabled(enabled: boolean): void {
        this.store.set('webhookEnabled', enabled);
        if (!enabled) this.dispose();
    }
    public disconnect(): void {
        this.outbox.clear();
        this.dispose();
        this.store.set('webhookEnabled', false);
        this.store.delete('webhookUrl');
        this.store.delete('webhookTriggerPercentage');
    }
    public dispose(): void {
        this.outbox.stop();
        if (this.webhookTimeout) {
            clearTimeout(this.webhookTimeout);
            this.webhookTimeout = null;
        }
        this.currentWebhookState = null;
        this.pauseStartTime = 0;
    }
}
