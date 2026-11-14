import { describeEnvelope, describePcm, validTrackSample } from '../../src/wave/recommendation/trackSample';
import type { TrackSample } from '../../src/wave/recommendation/types';
import type { WaveCandidate } from '../../src/wave/waveEngine';
import { invoke, type Profile } from './bridge';

type Payload = { audio?: string; waveform?: number[]; duration?: number };
type Entry = { at: number; sample?: TrackSample };
const day = 86400000;

export class TrackSamples {
    private readonly key: string;
    private readonly cache = new Map<string, Entry>();
    private pending?: Promise<void>;

    constructor(private readonly store: Profile, private readonly owner: number) {
        this.key = 'waveTrackSamplesV1_' + owner;
        const saved = store.get(this.key);
        if (Array.isArray(saved))
            for (const entry of saved.slice(-120))
                if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1]?.at))
                    this.cache.set(entry[0], entry[1]);
    }

    private identity(track: WaveCandidate): string {
        return JSON.stringify([track.url, track.audioRevision || '', track.durationSeconds || 0]);
    }

    private get(track: WaveCandidate): Entry | undefined {
        const entry = this.cache.get(this.identity(track));
        if (!entry || entry.at > Date.now() || Date.now() - entry.at >= (entry.sample ? 30 * day : day / 24)) return;
        return entry.sample && !validTrackSample(entry.sample) ? undefined : entry;
    }

    enrich(track: WaveCandidate): WaveCandidate {
        const sample = this.get(track)?.sample;
        return sample ? { ...track, sample } : track;
    }

    get running(): boolean {
        return Boolean(this.pending);
    }

    start(
        tracks: WaveCandidate[],
        limit: number,
        valid: () => boolean,
        update: (track: WaveCandidate) => void,
        finished: () => void,
    ): number {
        if (this.pending || limit <= 0) return 0;
        const next = tracks.filter((track) => !this.get(track)).slice(0, Math.min(5, limit));
        if (!next.length) return 0;
        this.pending = this.run(next, valid, update).finally(() => {
            this.pending = undefined;
            if (valid()) finished();
        });
        void this.pending.catch(console.error);
        return next.length;
    }

    private async run(
        tracks: WaveCandidate[],
        valid: () => boolean,
        update: (track: WaveCandidate) => void,
    ): Promise<void> {
        for (const track of tracks) {
            if (!valid()) return;
            let payload: Payload | null;
            try {
                payload = await invoke<Payload | null>('wave_sample', { url: track.url, expectedOwner: this.owner });
            } catch {
                return;
            }
            if (!valid()) return;
            const waveform = payload?.waveform && payload.duration
                ? describeEnvelope(payload.waveform, payload.duration)
                : undefined;
            let sample = waveform;
            if (payload?.audio) {
                try {
                    const data = Uint8Array.from(atob(payload.audio), (c) => c.charCodeAt(0));
                    const buffer = await new OfflineAudioContext(1, 1, 12000).decodeAudioData(data.buffer);
                    const decoded = describePcm(buffer.getChannelData(0), buffer.sampleRate);
                    if (decoded) sample = { ...decoded, envelope: waveform };
                } catch {
                    // Some encodings are unavailable in WebView2.
                }
            }
            if (!valid()) return;
            const id = this.identity(track);
            this.cache.delete(id);
            this.cache.set(id, { at: Date.now(), sample });
            while (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value!);
            this.store.set(this.key, [...this.cache]);
            if (sample) update({ ...track, sample });
        }
    }
}
