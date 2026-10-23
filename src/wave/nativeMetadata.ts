import type { WebContents } from 'electron';
import type { WaveCandidate } from './waveEngine';
import { isSoundCloudTrackUrl } from './nativeLike';
interface Metadata {
    title?: string;
    artist?: string;
    genre?: string;
    tags?: string[];
    bpm?: number;
}
export function mergeMetadata(candidate: WaveCandidate, metadata: Metadata | null): WaveCandidate {
    if (!metadata) return { ...candidate, metadataChecked: true };
    const bpm = Number(metadata.bpm);
    return {
        ...candidate,
        genre: metadata.genre || candidate.genre,
        tags: metadata.tags?.length ? metadata.tags : candidate.tags,
        bpm: bpm >= 60 && bpm <= 200 ? Math.round(bpm) : candidate.bpm,
        bpmConfidence: bpm >= 60 && bpm <= 200 ? 0.7 : candidate.bpmConfidence,
        metadataChecked: true,
    };
}
export async function enrichCandidates(view: WebContents, candidates: WaveCandidate[], limit = 8): Promise<void> {
    let checked = 0;
    for (const candidate of candidates) {
        if (checked >= limit) break;
        if (candidate.metadataChecked || !isSoundCloudTrackUrl(candidate.url)) continue;
        checked++;
        try {
            const metadata = (await view.executeJavaScript(
                `window.waveMetadataProbe(${JSON.stringify(candidate.url)})`,
                true,
            )) as Metadata | null;
            Object.assign(candidate, mergeMetadata(candidate, metadata));
        } catch {
            candidate.metadataChecked = true;
        }
    }
}
