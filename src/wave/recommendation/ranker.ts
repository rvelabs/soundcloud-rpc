import {
    buildProfile,
    measuredBpm,
    normalize,
    recordingKey,
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
    const negativeSimilarity = Math.max(
        0,
        ...profile.negativeSeeds.map((seed) => compare(track, seed) * (profile.dislikedIds.has(seed.id) ? 1 : 0.3)),
    );
    const familiarFactor = ['familiar', 'favorites'].includes(controls.discovery)
        ? 2.2
        : controls.discovery === 'new'
          ? 1.25
          : 1.2;
    const affinityFactor =
        controls.discovery === 'new' ? 0.9 : ['familiar', 'favorites'].includes(controls.discovery) ? 1.15 : 1;
    let score = affinity * affinityFactor + seedSimilarity * familiarFactor - negativeSimilarity * 2.2;
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
    const rejected = new Set(reactions.filter((event) => sessionWeight(event) < 0).map((event) => event.track.id));
    const intent = {
        activeReferences: context.discoverySeeds || [],
        activeIds: new Set((context.discoverySeeds || []).map((track) => track.id)),
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
    for (const id of recentIds) {
        for (const key of profile.recordingsById.get(id) || []) blockedRecordings.add(key);
        const reserved = unique.get(id);
        if (reserved) blockedRecordings.add(recordingKey(reserved));
    }
    const unseen = [...unique.values()].filter((track) => {
        const key = recordingKey(track);
        if (profile.dislikedIds.has(track.id) || recentIds.has(track.id) || blockedRecordings.has(key)) return false;
        if (favoriteMode && !favorites.has(track.id) && !context.knownLikedApiIds?.has(track.apiId || 0)) return false;
        if (
            ['new', 'popular'].includes(controls.discovery) &&
            (profile.heardIds.has(track.id) ||
                profile.likedIds.has(track.id) ||
                context.knownLikedApiIds?.has(track.apiId || 0) ||
                knownRecordings.has(key))
        )
            return false;
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
    for (const track of pool) {
        const item = scoreTrack(
            track,
            profile,
            controls,
            context,
            compare,
            recentIndexes.get(artistOf(track)) ?? -1,
            intent,
        );
        if (!item) continue;
        const key = recordingKey(track);
        const previous = recordings.get(key);
        if (!previous || item.score > previous.score) recordings.set(key, item);
    }
    const scored = [...recordings.values()];
    const chosen: Recommendation[] = [];
    const usedArtists = new Set(recent.slice(0, 2));
    while (scored.length && chosen.length < limit) {
        const highestQuality = Math.max(...scored.map((entry) => entry.quality ?? entry.score));
        const qualified = scored.filter((entry) => (entry.quality ?? entry.score) >= highestQuality - 1.8);
        let group = qualified;
        if (controls.discovery === 'balanced') {
            const wantKnown = (chosen.length + (context.sequenceOffset || 0)) % 3 === 2;
            const mixed = qualified.filter((entry) => {
                const known =
                    profile.heardIds.has(entry.track.id) ||
                    context.knownLikedApiIds?.has(entry.track.apiId || 0) ||
                    knownRecordings.has(recordingKey(entry.track));
                return known === wantKnown;
            });
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
        scored.splice(scored.indexOf(next), 1);
        chosen.push(next);
        usedArtists.add(artistOf(next.track));
    }
    return chosen;
}
