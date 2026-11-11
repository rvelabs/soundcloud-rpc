import {
    buildProfile,
    measuredBpm,
    normalize,
    recordingKey,
    recordingAliases,
    explicitlyRejected,
    tokensOf,
    tasteTokenWeight,
    hasMusicalMetadata,
} from './profile';
import type { TasteProfile } from './profile';
import {
    activities,
    effectiveMood,
    moodEvidence,
    matchesLanguage,
    languageEvidence,
    popularEnough,
    words,
} from './preferences';
import type { Context, Controls, Feedback, Recommendation, Track } from './types';
import {
    artistIdentity,
    measuredSoundSimilarity,
    recentPreference,
    recentReactions,
    sessionWeight,
    transitionAffinity,
} from './sessionSignals';
import { preferenceEvidence } from './evidence';
import { catalogSimilarity } from './similarity';
import { parseSoundCloudTitle } from '../../utils/trackParser';
import { rejectedSource, rejectionEvidence } from './rejections';
import { inferSessionMood, sessionMoodReason, sessionMoodScore } from './sessionMood';
const genericGenres = new Set(['hiphop rap', 'hiphop', 'rap', 'pop', 'rock', 'electronic', 'dance', 'alternative']);
const genericStyle = (token: string) => genericGenres.has(token) || tasteTokenWeight(token) < 1;
const genreKey = (genre?: string) => {
    const key = tokensOf({ id: '', title: '', artist: '', genre }).sort().join(' ');
    return ['other', 'unknown', 'all', 'various'].includes(key) ? '' : key;
};
const seedMetadata = (track: Track): Track => ({
    ...track,
    title: '',
    genre: undefined,
    tags: tokensOf({ ...track, title: '' }).filter((token) => !genericStyle(token)),
});

function scoreFromTrack(
    track: Track,
    seed: Track,
    profile: TasteProfile,
    compare: ReturnType<typeof catalogSimilarity>,
    recentArtist: number,
    context: Context,
    tasteReferences: Track[],
): Recommendation | null {
    const linked = Boolean(track.relatedTo?.includes(seed.id));
    const candidateStyle = seedMetadata(track);
    const metadata = compare(track, seed);
    const genre = genreKey(seed.genre);
    const candidateGenre = genreKey(track.genre);
    const sharedGenre = Boolean(genre && genre === candidateGenre);
    const compatibleGenre = sharedGenre || !genre || !candidateGenre;
    const sameGenre = sharedGenre && genre.split(' ').some((token) => !genericStyle(token));
    const styleMatch = sameGenre || metadata >= 0.32;
    const stationRank = track.stationSeed === seed.id ? (track.stationRank ?? Infinity) : Infinity;
    const stationMatch = compatibleGenre && stationRank < (linked ? 24 : 10);
    const sparseMatch =
        linked && compatibleGenre && !candidateStyle.tags?.length && (track.sourceRank ?? Infinity) < 12;
    if (!styleMatch && !(linked && sharedGenre) && !stationMatch && !sparseMatch) return null;
    const profileSimilarity = Math.max(0, ...tasteReferences.map((reference) => compare(track, reference)));
    const sound = measuredSoundSimilarity(track, seed);
    const fromBpm = measuredBpm(seed.features),
        toBpm = measuredBpm(track.features);
    const tempoGap = fromBpm && toBpm ? Math.abs(Math.log2(toBpm / fromBpm)) : undefined;
    const seedEnergy = seed.features?.energy;
    const trackEnergy = track.features?.energy;
    const similarEnergy =
        seedEnergy !== undefined &&
        trackEnergy !== undefined &&
        Math.min(seedEnergy, trackEnergy) >= 0.02 &&
        Math.max(seedEnergy, trackEnergy) <= Math.min(seedEnergy, trackEnergy) * 1.65 &&
        Math.abs(seedEnergy - trackEnergy) <= 0.08;
    const similarAudio =
        sound !== undefined && sound >= 0.86 && (tempoGap === undefined ? similarEnergy : tempoGap <= 0.22);
    const independentMatch = linked && sharedGenre && (profileSimilarity >= 0.45 || similarAudio);
    const strong = styleMatch || independentMatch;
    if (!strong) {
        const audioMismatch =
            sound !== undefined &&
            (sound < 0.55 ||
                (seedEnergy !== undefined &&
                    trackEnergy !== undefined &&
                    Math.max(seedEnergy, trackEnergy) >= 0.08 &&
                    Math.min(seedEnergy, trackEnergy) * 3 < Math.max(seedEnergy, trackEnergy)));
        if ((!stationMatch && !sparseMatch) || audioMismatch || (tempoGap !== undefined && tempoGap > 0.45))
            return null;
    }
    if (tempoGap !== undefined && tempoGap > 0.45 && sound !== undefined && sound < 0.35) return null;
    const rejection = rejectionEvidence(track, profile, compare);
    if (rejection.blocked && !context.knownLikedApiIds?.has(track.apiId || 0)) return null;
    const tempo = transitionAffinity(track, seed);
    const quality =
        metadata * 5 +
        Number(sameGenre) +
        Number(linked) * 2 +
        (stationMatch ? 1.2 / Math.sqrt(1 + stationRank) + 0.9 : 0) +
        profileSimilarity * 1.2 +
        (sound === undefined ? 0 : (sound - 0.5) * 3) +
        tempo * 2 -
        rejection.similarity * 2.2 -
        rejection.penalty;
    if (quality < 0.8) return null;
    return {
        track,
        quality,
        trackWaveTier: strong ? 3 : stationMatch ? 2 : 1,
        score: quality - (recentArtist < 0 ? 0 : 5 / (1 + recentArtist * 0.6)) + 0.3 / (1 + (track.sourceRank || 0)),
        reasons: [
            'подбор по выбранному треку',
            ...(styleMatch ? ['похожие жанр и теги'] : []),
            ...(independentMatch && profileSimilarity >= 0.45 ? ['совпадение жанра и тегов с историей'] : []),
            ...(!strong && stationMatch ? ['из станции по выбранному треку'] : []),
            ...(!strong && !stationMatch ? ['из похожих треков SoundCloud · мало данных о звучании'] : []),
            ...(sound !== undefined && sound >= 0.75 ? ['похожее звучание по аудиоанализу'] : []),
        ],
        measuredTempoMatch: false,
    };
}

const toneHints = {
    bass: new Set(['bass', '808', 'sub', 'phonk', 'trap', 'dubstep', 'drill']),
    bright: new Set(['bright', 'synth', 'pop', 'trance', 'hyperpop', 'vocal', 'sparkle']),
    balanced: new Set(['acoustic', 'indie', 'soul', 'jazz', 'organic', 'balanced']),
};
const tempoHints = {
    slow: new Set(['slow', 'slowed', 'downtempo', 'ambient', 'slowcore']),
    medium: new Set(['midtempo', 'groove', 'moderate']),
    fast: new Set(['fast', 'sped', 'uptempo', 'speedcore', 'nightcore', 'jungle']),
};
function matchesGenre(track: Track, requested: string): boolean {
    const genreText = (text: string) =>
        normalize(text)
            .replace(/\bd(?:rum)?\s*(?:&|and|n)\s*b(?:ass)?\b|\bdnb\b/g, 'drum bass')
            .replace(/\blo[ -]?fi\b/g, 'lofi')
            .replace(/\bhip[ -]?hop\b/g, 'hip hop')
            .replace(/\br(?:&|n)b\b/g, 'rhythm blues')
            .replace(/\band\b/g, '');
    const wanted = genreText(requested)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2);
    if (!wanted.length) return false;
    const metadata = genreText([track.genre || '', ...(track.tags || []), ...tokensOf(track)].join(' ')).split(
        /[^\p{L}\p{N}]+/u,
    );
    if (wanted.every((word) => metadata.includes(word))) return true;
    const hint = genreText(track.queryHint || '').split(/[^\p{L}\p{N}]+/u);
    return !track.genre && !track.tags?.length && wanted.every((word) => hint.includes(word));
}
function fitsSettings(track: Track, controls: Controls, context: Context): boolean {
    if (
        controls.mood === 'any' &&
        !context.activity &&
        !controls.activity &&
        controls.tempo === 'any' &&
        (!controls.language || controls.language === 'any') &&
        controls.discovery !== 'popular'
    )
        return true;
    const tags = tokensOf(track);
    const mood = effectiveMood(controls, context);
    const evidence = moodEvidence(track, mood);
    if (evidence.conflict) return false;
    const allowInspection = context.allowUnverified && !track.catalogChecked;
    if ((mood === 'happy' || mood === 'sad') && !allowInspection && evidence.score <= 0) return false;
    if (!matchesLanguage(track, controls, allowInspection)) return false;
    if (
        controls.discovery === 'popular' &&
        !popularEnough(track) &&
        !(allowInspection && track.playbackCount === undefined)
    )
        return false;
    if (controls.tempo !== 'any' && measuredBpm(track.features) === undefined) {
        const wanted = tags.some((tag) => tempoHints[controls.tempo as keyof typeof tempoHints].has(tag));
        const opposite = (Object.keys(tempoHints) as Array<keyof typeof tempoHints>).some(
            (key) => key !== controls.tempo && tags.some((tag) => tempoHints[key].has(tag)),
        );
        if (opposite && !wanted) return false;
    }
    return true;
}
export function tempoMatches(bpm: number, tempo: Controls['tempo']): boolean {
    return (
        tempo === 'any' || (tempo === 'slow' ? bpm < 105 : tempo === 'medium' ? bpm >= 105 && bpm < 140 : bpm >= 140)
    );
}
function hash(value: string, seed: number): number {
    let result = seed | 0;
    for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
    return (result >>> 0) / 4294967296;
}
function scoreTrack(
    track: Track,
    profile: TasteProfile,
    controls: Controls,
    context: Context,
    compare: (a: Track, b: Track) => number,
    recentArtist: number,
    intent: {
        rejected: Set<string>;
        positive: Array<{ track: Track; weight: number }>;
        references: Track[];
        referenceIds: Set<string>;
        established: boolean;
        negative: Feedback[];
        activeReferences: Track[];
        activeIds: Set<string>;
    },
): Recommendation | null {
    const tags = tokensOf(track);
    const reasons: string[] = [];
    const tokenAffinity =
        tags.reduce((sum, token) => {
            const weight = profile.tokens.get(token) || 0;
            return (
                sum + Math.sign(weight) * Math.min(5, Math.log2(1 + Math.abs(weight)) / 1.5) * tasteTokenWeight(token)
            );
        }, 0) / Math.sqrt(Math.max(1, tags.length));
    const affinity = Math.max(-3.5, Math.min(3.5, tokenAffinity));
    const seedSimilarity = Math.max(0, ...intent.references.map((seed) => compare(track, seed)));
    const usable = (track.relatedTo || []).filter((id) => !profile.dislikedIds.has(id) && !intent.rejected.has(id));
    const references = usable.filter((id) => intent.referenceIds.has(id));
    const activeLinks = usable.filter((id) => intent.activeIds.has(id));
    const directionSimilarity = Math.max(0, ...intent.activeReferences.map((seed) => compare(track, seed)));
    const focused = intent.activeReferences.length > 0 && !['favorites', 'familiar'].includes(controls.discovery);
    if (
        focused &&
        !activeLinks.length &&
        directionSimilarity < 0.22 &&
        seedSimilarity < 0.22 &&
        !profile.likedIds.has(track.id) &&
        !context.knownLikedApiIds?.has(track.apiId || 0)
    )
        return null;
    if (
        intent.established &&
        !controls.genre &&
        !profile.likedIds.has(track.id) &&
        !context.knownLikedApiIds?.has(track.apiId || 0) &&
        seedSimilarity < 0.12 &&
        references.length < 2 &&
        !activeLinks.length &&
        (hasMusicalMetadata(track) || references.length === 0)
    )
        return null;
    const rejection = rejectionEvidence(track, profile, compare);
    if (rejection.blocked && !context.knownLikedApiIds?.has(track.apiId || 0)) return null;
    const negativeSimilarity = rejection.similarity;
    const familiarFactor = ['familiar', 'favorites'].includes(controls.discovery)
        ? 2.2
        : controls.discovery === 'new'
          ? 1.25
          : 1.2;
    const affinityFactor =
        controls.discovery === 'new' ? 0.9 : ['familiar', 'favorites'].includes(controls.discovery) ? 1.15 : 1;
    let score =
        affinity * affinityFactor + seedSimilarity * familiarFactor - negativeSimilarity * 2.2 - rejection.penalty;
    if (rejection.penalty) reasons.push('учтены повторные «не подходит»');
    if (focused) {
        score += directionSimilarity * 1.2 + (activeLinks.length ? 2 : 0);
        if (activeLinks.length) reasons.push('связь с опорными записями этой волны');
    }
    if (track.source === 'related' && track.relatedTo?.length) {
        if (focused ? activeLinks.length : usable.length) {
            score +=
                (intent.references.length ? (hasMusicalMetadata(track) ? 0.35 : 0.9) : 2.2) +
                seedSimilarity * 1.5 +
                Math.min(2, references.length) * 0.35;
            reasons.push(
                references.length ? 'похожие треки к понравившимся записям' : 'похожие треки к опорным записям',
            );
            if (references.length > 1) reasons.push('рекомендуется к нескольким вашим трекам');
        } else {
            score -= 1.2;
            reasons.push('ослаблена связь с недавно отвергнутой музыкой');
        }
    }
    if (affinity > 0.5) reasons.push('совпадение жанра и тегов с историей');
    if (negativeSimilarity > 0.5) reasons.push('похож на пропущенное');
    if (seedSimilarity > 0.15 && seedSimilarity < 0.65 && controls.discovery === 'new') {
        score += 0.6;
        reasons.push('новое направление');
    }
    const sessionAffinity =
        tags.reduce((sum, token) => sum + (context.preferenceSignals?.get(token) || 0), 0) /
        Math.sqrt(Math.max(1, tags.length));
    score +=
        sessionAffinity < -0.8
            ? -Math.min(5, (-sessionAffinity - 0.8) * 4 + 0.4)
            : Math.max(-0.4, Math.min(1.5, sessionAffinity * (sessionAffinity < 0 ? 0.5 : 1)));
    if (sessionAffinity > 0.35) reasons.push('учтены реакции в этой сессии');
    const currentInterest = Math.max(0, ...intent.positive.map((event) => compare(track, event.track) * event.weight));
    score += Math.min(controls.discovery === 'new' ? 0.4 : 0.7, currentInterest);
    if (currentInterest > 0.3) reasons.push('продолжение удачного направления текущей сессии');
    const recentNegative = intent.negative
        .filter((event) => event.kind !== 'skip' || context.now - event.at < 10 * 60000)
        .map((event) => {
            const sound = event.kind === 'skip' ? measuredSoundSimilarity(track, event.track) : undefined;
            return {
                similarity: sound === undefined ? compare(track, event.track) : sound,
                measured: sound !== undefined,
                weight: Math.abs(sessionWeight(event)) * 2 ** (-(context.now - event.at) / (8 * 60000)),
                explicit: event.kind === 'dislike',
            };
        });
    const negativeNeighbors = recentNegative.filter((event) => event.similarity >= 0.25);
    if (negativeNeighbors.length) {
        const strength = negativeNeighbors.some((event) => event.explicit)
            ? 2.5
            : negativeNeighbors.filter((event) => event.measured && event.similarity >= 0.75).length >= 2
              ? 1.3
              : negativeNeighbors.length >= 3
                ? 1.4
                : 0;
        score -= Math.min(
            5,
            negativeNeighbors
                .sort((a, b) => b.similarity * b.weight - a.similarity * a.weight)
                .slice(0, 2)
                .reduce((sum, event) => sum + event.similarity * event.weight, 0) * strength,
        );
    }
    const requested = normalize(controls.genre || '');
    if (requested) {
        score += 4;
        reasons.push(!track.genre && !track.tags?.length ? 'жанр по поисковому запросу' : 'выбранный жанр');
    }
    const energy = track.features?.energy;
    const mood = moodEvidence(track, effectiveMood(controls, context));
    score += mood.score;
    if (mood.reason) reasons.push(mood.reason);
    const inferredMoodScore = sessionMoodScore(track, context.sessionMood);
    score += inferredMoodScore;
    if (inferredMoodScore > 0 && context.sessionMood) reasons.unshift(sessionMoodReason[context.sessionMood.mood]);
    if (controls.language && controls.language !== 'any') {
        const evidence = languageEvidence(track);
        if (evidence.language === controls.language) {
            score += 3;
            reasons.push(evidence.reason);
        }
    }
    if (controls.discovery === 'popular' && popularEnough(track)) {
        score += Math.min(4, Math.log10(track.playbackCount!) / 2);
        reasons.push('популярность по прослушиваниям SoundCloud');
    }
    const bpm = measuredBpm(track.features);
    if (controls.tempo !== 'any' && bpm !== undefined) {
        score += 1.8;
        reasons.push('BPM соответствует темпу');
    } else if (controls.tempo !== 'any') {
        const match = tags.some((tag) => tempoHints[controls.tempo as keyof typeof tempoHints].has(tag));
        const opposite = (Object.keys(tempoHints) as Array<keyof typeof tempoHints>).some(
            (key) => key !== controls.tempo && tags.some((tag) => tempoHints[key].has(tag)),
        );
        score += match ? 1.7 : opposite ? -1.7 : 0;
        if (match) reasons.push('темп по тегам, BPM не подтверждён');
    }
    if (controls.tone !== 'any') {
        const bass = track.features?.bass;
        const brightness = track.features?.brightness;
        if (bass !== undefined && brightness !== undefined) {
            const difference = bass - brightness;
            score +=
                controls.tone === 'bass'
                    ? difference * 2
                    : controls.tone === 'bright'
                      ? -difference * 2
                      : 1 - Math.abs(difference) * 2;
            reasons.push('измеренный звуковой баланс');
        } else {
            const match = tags.some((tag) => toneHints[controls.tone as keyof typeof toneHints].has(tag));
            const opposite =
                controls.tone !== 'balanced' &&
                tags.some((tag) => toneHints[controls.tone === 'bass' ? 'bright' : 'bass'].has(tag));
            score += match ? 2.2 : opposite ? -1.5 : 0;
            if (match) reasons.push('звучание по тегам');
        }
    }
    if (context.activity) {
        const tags = words(track),
            info = activities[context.activity];
        const match = info.tags.some((tag) => tags.has(tag));
        score += match ? 2.5 : 0;
        if (match) reasons.push('подходит для выбранного занятия');
    }
    const preferredEnergy = profile.sound.energy;
    if (seedSimilarity >= 0.12 && preferredEnergy !== undefined && energy !== undefined && Number.isFinite(energy))
        score += (1 - Math.abs(preferredEnergy - energy)) * 0.8;
    const quality = score;
    if (recentArtist >= 0) score -= 5 / (1 + recentArtist * 0.6);
    score += 0.4 / Math.sqrt(Math.max(0, track.sourceRank || 0) + 1);
    score += hash(track.id, context.seed || 1) * 0.12;
    if (!reasons.length) reasons.push('новый трек из каталога');
    return {
        selection: {
            profileSimilarity: seedSimilarity,
            directionSimilarity,
            activeLinks: activeLinks.length,
            staleLinks: usable.length - activeLinks.length,
        },
        track,
        score,
        quality,
        reasons,
        measuredTempoMatch: bpm !== undefined && tempoMatches(bpm, controls.tempo),
        evidence: preferenceEvidence(track, controls, context),
    };
}
export function recommend(
    candidates: Track[],
    events: Feedback[],
    controls: Controls,
    context: Context,
    limit = 10,
    suppliedProfile?: TasteProfile,
    similarity: typeof catalogSimilarity = catalogSimilarity,
): Recommendation[] {
    const profile = suppliedProfile || buildProfile(events, context.now);
    const reactions = context.sessionReactions || recentReactions(events, context.now);
    const inferredMood = context.trackSeed
        ? undefined
        : inferSessionMood(controls, { ...context, sessionReactions: reactions });
    const activeReferences = (context.discoverySeeds || []).filter(
        (track) => sessionMoodScore(track, inferredMood) > -1.5,
    );
    const rejected = new Set(reactions.filter((event) => sessionWeight(event) < 0).map((event) => event.track.id));
    const intent = {
        activeReferences,
        activeIds: new Set(activeReferences.map((track) => track.id)),
        rejected,
        references: profile.trustedSeeds.length ? profile.trustedSeeds : profile.positiveSeeds,
        referenceIds: new Set(
            (profile.trustedSeeds.length ? profile.trustedSeeds : profile.positiveSeeds).map((seed) => seed.id),
        ),
        established: profile.trustedSeeds.filter(hasMusicalMetadata).length >= 3,
        negative: reactions.filter((event) => sessionWeight(event) < 0),
        positive: reactions
            .filter((event) => sessionWeight(event) > 0)
            .map((event) => ({
                track: event.track,
                weight: sessionWeight(event) * 2 ** (-(context.now - event.at) / (15 * 60000)),
            })),
    };
    context = {
        ...context,
        sessionReactions: reactions,
        sessionMood: inferredMood,
        preferenceSignals: context.preferenceSignals || recentPreference(reactions, context.now),
        anchor: context.anchor && !rejected.has(context.anchor.id) ? context.anchor : undefined,
    };
    const favorites = new Set([...profile.likedIds, ...profile.positiveSeeds.map((track) => track.id)]);
    const favoriteMode = controls.discovery === 'favorites';
    const cooldown = favoriteMode ? Math.min(3, Math.max(0, favorites.size - 1)) : 100;
    const recentIds = new Set([
        ...(context.recentTrackIds || []).slice(0, cooldown),
        ...(context.reservedTrackIds || []),
        ...(!favoriteMode
            ? events
                  .filter(
                      (event) => ['play', 'complete', 'skip'].includes(event.kind) && context.now - event.at < 86400000,
                  )
                  .map((event) => event.track.id)
            : []),
    ]);
    const unique = new Map<string, Track>();
    for (const candidate of candidates)
        if (candidate.id && candidate.artist && !unique.has(candidate.id)) unique.set(candidate.id, candidate);
    const knownRecordings = profile.knownRecordings;
    const blockedRecordings = new Set(profile.dislikedRecordings);
    const blockedApiIds = new Set<number>();
    if (context.trackSeed) {
        recentIds.add(context.trackSeed.id);
        if (context.trackSeed.apiId) blockedApiIds.add(context.trackSeed.apiId);
        for (const key of recordingAliases(context.trackSeed)) blockedRecordings.add(key);
    }
    const knownApiIds = new Set(context.knownLikedApiIds);
    for (const { track } of events) {
        if (!track.apiId) continue;
        if (recentIds.has(track.id)) blockedApiIds.add(track.apiId);
        if (profile.heardIds.has(track.id) || profile.likedIds.has(track.id)) knownApiIds.add(track.apiId);
    }
    for (const id of recentIds) {
        for (const key of profile.recordingsById.get(id) || []) blockedRecordings.add(key);
        const reserved = unique.get(id);
        if (!reserved) continue;
        if (reserved.apiId) blockedApiIds.add(reserved.apiId);
        for (const key of recordingAliases(reserved)) blockedRecordings.add(key);
    }
    const aliases = new Map<Track, string[]>();
    const keysOf = (track: Track): string[] => {
        const cached = aliases.get(track);
        if (cached) return cached;
        const keys = recordingAliases(track);
        aliases.set(track, keys);
        return keys;
    };
    const known = (track: Track) =>
        profile.heardIds.has(track.id) ||
        profile.likedIds.has(track.id) ||
        knownApiIds.has(track.apiId || 0) ||
        keysOf(track).some((key) => knownRecordings.has(key));
    const unseen = [...unique.values()].filter((track) => {
        if (
            explicitlyRejected(track, profile) ||
            rejectedSource(track, profile, context.trackSeed?.id) ||
            recentIds.has(track.id) ||
            blockedApiIds.has(track.apiId || 0) ||
            keysOf(track).some((alias) => blockedRecordings.has(alias))
        )
            return false;
        if (favoriteMode && !favorites.has(track.id) && !context.knownLikedApiIds?.has(track.apiId || 0)) return false;
        if (['new', 'popular'].includes(controls.discovery) && known(track)) return false;
        return true;
    });
    const requestedGenre = normalize(controls.genre || '');
    const genrePool = unseen.filter(
        (track) => (!requestedGenre || matchesGenre(track, requestedGenre)) && fitsSettings(track, controls, context),
    );
    const matches =
        controls.tempo === 'any'
            ? genrePool
            : genrePool.filter((track) => {
                  const bpm = measuredBpm(track.features);
                  return bpm !== undefined && tempoMatches(bpm, controls.tempo);
              });
    const pool =
        controls.tempo === 'any' || matches.length
            ? matches
            : genrePool.filter((track) => measuredBpm(track.features) === undefined);
    const compare = similarity([
        ...(context.similarityCorpus || pool),
        ...profile.positiveSeeds,
        ...profile.trustedSeeds,
        ...profile.negativeSeeds,
        ...reactions.map((event) => event.track),
        ...(context.recentTracks || []),
        ...(context.trackSeed ? [context.trackSeed] : []),
    ]);
    const trustedArtists = new Set(intent.references.map((track) => artistIdentity(track.artist)));
    const artistCache = new Map<string, string>();
    const artistOf = (track: Track): string => {
        const key = JSON.stringify([track.artist, track.title]);
        let value = artistCache.get(key);
        if (value === undefined) {
            const parsed = parseSoundCloudTitle(track.title).artist;
            const credited = parsed && artistIdentity(parsed);
            value = credited && trustedArtists.has(credited) ? credited : artistIdentity(track.artist);
            artistCache.set(key, value);
        }
        return value;
    };
    const recent = (context.recentArtists || []).map((name, index) => {
        const item = context.recentTracks?.[index];
        const track = item?.artist === name ? item : context.recentTracks?.find((track) => track.artist === name);
        return track ? artistOf(track) : artistIdentity(name);
    });
    const recentIndexes = new Map<string, number>();
    recent.forEach((name, index) => {
        if (!recentIndexes.has(name)) recentIndexes.set(name, index);
    });
    const recordings = new Map<string, Recommendation>();
    const selectedSeed = context.trackSeed;
    const trackWaveReferences = selectedSeed
        ? intent.references
              .filter(
                  (reference) =>
                      reference.id !== selectedSeed.id &&
                      (!selectedSeed.apiId || reference.apiId !== selectedSeed.apiId),
              )
              .slice(0, 16)
        : [];
    const styles = new WeakMap<Track, Track>();
    const styleOf = (track: Track) => {
        const cached = styles.get(track);
        if (cached) return cached;
        const style = seedMetadata(track);
        styles.set(track, style);
        return style;
    };
    const compareStyles = (left: Track, right: Track) => compare(styleOf(left), styleOf(right));
    for (const track of pool) {
        const recentArtist = recentIndexes.get(artistOf(track)) ?? -1;
        const item = selectedSeed
            ? scoreFromTrack(track, selectedSeed, profile, compareStyles, recentArtist, context, trackWaveReferences)
            : scoreTrack(track, profile, controls, context, compare, recentArtist, intent);
        if (!item) continue;
        const key = recordingKey(track);
        const previous = recordings.get(key);
        const tier = (item.trackWaveTier || 0) - (previous?.trackWaveTier || 0);
        if (!previous || tier > 0 || (tier === 0 && item.score > previous.score)) recordings.set(key, item);
    }
    const scored = [...recordings.values()];
    const chosen: Recommendation[] = [];
    const usedArtists = new Set(recent.slice(0, 8));
    const recentFailures = reactions
        .filter((event) => context.now - event.at < 10 * 60000)
        .slice(-3)
        .filter((event) => event.kind === 'dislike' || (event.kind === 'skip' && sessionWeight(event) <= -0.6));
    const familiarEvery = recentFailures.length >= 2 ? 2 : 3;
    while (scored.length && chosen.length < limit) {
        const highestTier = Math.max(...scored.map((entry) => entry.trackWaveTier || 0));
        const rankedTier = highestTier ? scored.filter((entry) => entry.trackWaveTier === highestTier) : scored;
        const highestQuality = Math.max(...rankedTier.map((entry) => entry.quality ?? entry.score));
        const qualified = rankedTier.filter((entry) => (entry.quality ?? entry.score) >= highestQuality - 1.8);
        let group = qualified;
        if (controls.discovery === 'balanced' && !context.trackSeed) {
            const wantKnown = (chosen.length + (context.sequenceOffset || 0)) % familiarEvery === familiarEvery - 1;
            const mixed = qualified.filter((entry) => known(entry.track) === wantKnown);
            if (mixed.length) group = mixed;
        }
        const highest = Math.max(...group.map((e) => e.score));
        const eligible = group.filter((entry) => entry.score >= highest - 3);
        const diverse = eligible.filter((entry) => !usedArtists.has(artistOf(entry.track)));
        const noImmediateRepeat = eligible.filter(
            (entry) =>
                artistOf(entry.track) !== (chosen.length ? artistOf(chosen[chosen.length - 1].track) : recent[0]),
        );
        const fair = (diverse.length ? diverse : noImmediateRepeat.length ? noImmediateRepeat : eligible).filter(
            (entry) => {
                const artist = artistOf(entry.track);
                return (
                    [
                        ...chosen.slice(-5).map((item) => artistOf(item.track)),
                        ...recent.slice(0, Math.max(0, 5 - chosen.length)),
                    ].filter((name) => name === artist).length < 2
                );
            },
        );
        const options = fair.length
            ? fair
            : diverse.length
              ? diverse
              : noImmediateRepeat.length
                ? noImmediateRepeat
                : eligible;
        let next = options[0],
            best = -Infinity;
        const previous = chosen.length ? chosen[chosen.length - 1].track : context.anchor;
        const recentTracks = [
            ...chosen
                .slice(-3)
                .reverse()
                .map((item) => item.track),
            ...(context.recentTracks || []),
        ].slice(0, 3);
        const selectedTracks = chosen.slice(-4).map((item) => item.track);
        for (const entry of options) {
            const repetition = recentTracks.length
                ? recentTracks.reduce((sum, track) => sum + compare(entry.track, track), 0) / recentTracks.length
                : 0;
            const adjusted =
                entry.score -
                Math.max(0, ...selectedTracks.map((track) => compare(entry.track, track))) * 0.75 -
                repetition * 0.4 +
                transitionAffinity(entry.track, previous);
            if (adjusted > best || (adjusted === best && entry.track.id.localeCompare(next.track.id) < 0)) {
                next = entry;
                best = adjusted;
            }
        }
        const selectedKeys = keysOf(next.track);
        for (let index = scored.length - 1; index >= 0; index--) {
            const { track } = scored[index];
            if (
                scored[index] === next ||
                (track.apiId && track.apiId === next.track.apiId) ||
                keysOf(track).some((key) => selectedKeys.includes(key))
            )
                scored.splice(index, 1);
        }
        chosen.push(next);
        usedArtists.add(artistOf(next.track));
    }
    return chosen;
}
