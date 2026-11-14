import type { Track, TrackSample } from './types';

function quantile(sorted: number[], fraction: number): number {
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

export function describeEnvelope(values: number[], duration: number): TrackSample | undefined {
    if (values.length < 64 || duration < 6 || duration > 1200 || values.length / duration < 8) return;
    const ordered = [...values].sort((a, b) => a - b);
    const peak = quantile(ordered, 0.95);
    if (!Number.isFinite(peak) || peak <= 0.0001) return;
    const dynamics = [0.1, 0.25, 0.5, 0.75].map((q) => Math.max(0, quantile(ordered, q) / peak));
    const onsets = values.slice(1).map((value, i) => Math.max(0, Math.min(2, value / peak) - values[i] / peak));
    const mean = onsets.reduce((sum, value) => sum + value, 0) / onsets.length;
    const centered = onsets.map((value) => value - mean);
    const power = centered.reduce((sum, value) => sum + value * value, 0);
    const rate = values.length / duration;
    const rhythm = Array.from({ length: 19 }, (_, index) => {
        const lag = Math.round((0.25 + index * 0.05) * rate);
        let cross = 0;
        for (let i = lag; i < centered.length; i++) cross += centered[i] * centered[i - lag];
        return power > 0 ? Math.max(0, cross / power) : 0;
    });
    return { rhythm, dynamics };
}

export function describePcm(samples: Float32Array, rate: number): TrackSample | undefined {
    const window = Math.round(rate / 50);
    const envelope: number[] = [];
    let low = 0,
        mid = 0,
        lowPower = 0,
        midPower = 0,
        highPower = 0;
    const lowFactor = 1 - Math.exp((-2 * Math.PI * 250) / rate);
    const midFactor = 1 - Math.exp((-2 * Math.PI * 3500) / rate);
    const end = Math.min(samples.length, rate * 30);
    for (let offset = 0; offset + window <= end; offset += window) {
        let energy = 0;
        for (let index = offset; index < offset + window; index++) {
            const sample = samples[index];
            low += lowFactor * (sample - low);
            mid += midFactor * (sample - mid);
            lowPower += low * low;
            midPower += (mid - low) ** 2;
            highPower += (sample - mid) ** 2;
            energy += sample * sample;
        }
        envelope.push(Math.sqrt(energy / window));
    }
    const sample = describeEnvelope(envelope, (envelope.length * window) / rate);
    if (sample) {
        const total = lowPower + midPower + highPower;
        sample.spectrum = [lowPower / total, midPower / total, highPower / total];
    }
    return sample;
}

export function validTrackSample(value: unknown): value is TrackSample {
    const valid = (items: unknown, length: number) =>
        Array.isArray(items) && items.length === length && items.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
    const sample = value as TrackSample | undefined;
    return Boolean(
        sample &&
            valid(sample.rhythm, 19) &&
            valid(sample.dynamics, 4) &&
            (sample.spectrum === undefined || valid(sample.spectrum, 3)) &&
            (sample.envelope === undefined ||
                (valid(sample.envelope?.rhythm, 19) && valid(sample.envelope?.dynamics, 4))),
    );
}

export function trackSampleSimilarity(track: Track, seed: Track): number | undefined {
    const left = track.sample,
        right = seed.sample;
    if (!validTrackSample(left) || !validTrackSample(right)) return;
    const spectral = Boolean(left.spectrum && right.spectrum);
    const a = !spectral && left.spectrum ? left.envelope : left;
    const b = !spectral && right.spectrum ? right.envelope : right;
    if (!a || !b) return;
    const distance = (left: number[], right: number[]) =>
        left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / left.length;
    const rhythmDistance = distance(a.rhythm, b.rhythm);
    const dynamicsDistance = distance(a.dynamics, b.dynamics);
    if (Math.min(Math.max(...a.rhythm), Math.max(...b.rhythm)) < 0.15) return;
    const rhythmPeak = (values: number[]) => values.indexOf(Math.max(...values));
    const aLag = 0.25 + rhythmPeak(a.rhythm) * 0.05;
    const bLag = 0.25 + rhythmPeak(b.rhythm) * 0.05;
    const ratio = Math.max(aLag, bLag) / Math.min(aLag, bLag);
    if (ratio > 1.18 && Math.abs(ratio - 2) > 0.15) return;
    if (left.spectrum && right.spectrum) {
        const spectralDistance = distance(left.spectrum, right.spectrum);
        if (rhythmDistance > 0.12 || dynamicsDistance > 0.14 || spectralDistance > 0.12) return;
        return 1 - rhythmDistance - dynamicsDistance - spectralDistance;
    }
    // A waveform carries no timbre. Require both catalogue sources to agree before treating it as evidence.
    if (
        track.stationSeed !== seed.id ||
        !track.relatedTo?.includes(seed.id) ||
        rhythmDistance > 0.065 ||
        dynamicsDistance > 0.08
    ) return;
    return 0.8 - rhythmDistance - dynamicsDistance;
}
