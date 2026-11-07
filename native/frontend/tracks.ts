import { classifyTrackAvailability } from '../../src/import/availability';
import type { WaveCandidate } from '../../src/wave/waveEngine';

export function candidate(
    raw: any,
    source: WaveCandidate['source'] = 'related',
    relatedTo?: string[],
): WaveCandidate | undefined {
    const address = raw?.permalink_url;
    if (
        typeof address !== 'string' ||
        !/^https:\/\/soundcloud\.com\/[\w.~-]+\/[\w.~-]+\/?$/.test(address) ||
        !Number.isSafeInteger(raw.id) ||
        raw.id <= 0 ||
        typeof raw.title !== 'string'
    )
        return;
    return {
        url: address.replace(/\/$/, ''),
        apiId: raw.id,
        title: raw.title.slice(0, 200),
        artist: String(raw.publisher_metadata?.artist || raw.user?.username || '').slice(0, 200),
        uploaderId: raw.user?.id,
        genre: String(raw.genre || '').slice(0, 100),
        tags: String(raw.tag_list || '')
            .match(/"[^"]+"|\S+/g)
            ?.map((tag) => tag.replace(/^"|"$/g, ''))
            .slice(0, 100),
        language: raw.language,
        playbackCount: raw.playback_count,
        durationSeconds: Number(raw.duration) / 1000 || undefined,
        bpm: Number(raw.bpm) > 0 ? Number(raw.bpm) : undefined,
        bpmConfidence: raw.bpm ? 0.9 : undefined,
        audioRevision: typeof raw.last_modified === 'string' ? raw.last_modified.slice(0, 128) : undefined,
        catalogCheckedAt: Date.now(),
        metadataChecked: true,
        playability: classifyTrackAvailability(raw).status,
        relatedTo,
        source,
        sourceRank: 0,
    };
}
