import { type TasteProfile, tokensOf } from './profile';
import { artistIdentity, measuredSoundSimilarity } from './sessionSignals';
import type { Track } from './types';
import type { Similarity } from './similarity';

export function rejectedSource(track: Track, profile: TasteProfile, selectedSeed?: string): boolean {
    return Boolean(
        track.relatedTo?.length &&
            track.relatedTo.every((id) => id !== selectedSeed && profile.dislikedIds.has(id)) &&
            !profile.likedIds.has(track.id),
    );
}

export function rejectionEvidence(track: Track, profile: TasteProfile, compare: Similarity) {
    const negative = profile.negativeSeeds.map((seed) => ({
        seed,
        similarity: compare(track, seed),
        sound: measuredSoundSimilarity(track, seed),
        explicit: profile.dislikedIds.has(seed.id) || profile.dislikedApiIds.has(seed.apiId || 0),
    }));
    const similarity = Math.max(0, ...negative.map((item) => item.similarity * (item.explicit ? 1 : 0.3)));
    if (profile.likedIds.has(track.id)) return { similarity, penalty: 0, blocked: false };
    const distinct = new Map(
        negative
            .filter((item) => item.explicit)
            .map((item) => [item.seed.apiId ? 'api:' + item.seed.apiId : item.seed.id, item]),
    );
    const matches = [...distinct.values()];
    const soundMatches = matches.filter((item) => (item.sound || 0) >= 0.85 && item.similarity >= 0.25);
    const tokens = tokensOf(track);
    const metadataMatches = matches.filter(
        (item) => item.similarity >= 0.8 && tokens.filter((token) => tokensOf(item.seed).includes(token)).length >= 3,
    );
    const positive = profile.trustedSeeds.length ? profile.trustedSeeds : profile.positiveSeeds;
    const supportedSound =
        soundMatches.length >= 2 &&
        positive.some((seed) => (measuredSoundSimilarity(track, seed) || 0) >= 0.8 && compare(track, seed) >= 0.25);
    const supportedMetadata = metadataMatches.length >= 2 && positive.some((seed) => compare(track, seed) >= 0.7);
    const artist = artistIdentity(track.artist);
    const sameCreator = matches.filter((item) =>
        track.uploaderId && item.seed.uploaderId
            ? track.uploaderId === item.seed.uploaderId
            : artistIdentity(item.seed.artist) === artist,
    ).length;
    const creatorSupport = positive.filter((seed) => artistIdentity(seed.artist) === artist).length;
    const creatorPenalty = sameCreator >= 2 ? Math.min(6, Math.max(0, sameCreator - creatorSupport) * 1.5) : 0;
    return {
        similarity,
        penalty: creatorPenalty + (soundMatches.length && !supportedSound ? Math.min(3, soundMatches.length * 1.5) : 0),
        blocked: (soundMatches.length >= 2 && !supportedSound) || (metadataMatches.length >= 2 && !supportedMetadata),
    };
}
