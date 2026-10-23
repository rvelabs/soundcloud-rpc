import { buildProfile, measuredBpm, normalize, recordingKey, tokensOf } from './profile';
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
): Recommendation {
    const tags = tokensOf(track);
    const reasons: string[] = [];
    const tokenAffinity =
        tags.reduce((sum, token) => sum + Math.max(-5, Math.min(5, profile.tokens.get(token) || 0)), 0) /
        Math.sqrt(Math.max(1, tags.length));
    const affinity = Math.max(-3.5, Math.min(3.5, tokenAffinity));
    const seedSimilarity = Math.max(0, ...profile.positiveSeeds.map((seed) => compare(track, seed)));
    const negativeSimilarity = Math.max(0, ...profile.negativeSeeds.map((seed) => compare(track, seed)));
    const familiarFactor = ['familiar', 'favorites'].includes(controls.discovery)
        ? 2.2
        : controls.discovery === 'new'
          ? 0.25
          : 1.2;
    const affinityFactor =
        controls.discovery === 'new' ? 0.35 : ['familiar', 'favorites'].includes(controls.discovery) ? 1.15 : 1;
    let score = affinity * affinityFactor + seedSimilarity * familiarFactor - negativeSimilarity * 2.2;
    if (affinity > 0.5) reasons.push('совпадение жанра и тегов с историей');
    if (negativeSimilarity > 0.5) reasons.push('похож на пропущенное');
    if (!seedSimilarity && controls.discovery === 'new') {
        score += 1.8;
        reasons.push('новое направление');
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
    if (preferredEnergy !== undefined && energy !== undefined && Number.isFinite(energy))
        score += (1 - Math.abs(preferredEnergy - energy)) * 0.8;
    const recentArtist = (context.recentArtists || []).findIndex((name) => normalize(name) === normalize(track.artist));
    if (recentArtist >= 0) score -= 5 / (1 + recentArtist * 0.6);
    score += 0.4 / Math.sqrt(Math.max(0, track.sourceRank || 0) + 1);
    score += hash(track.id, context.seed || 1) * 0.12;
    if (!reasons.length) reasons.push('новый трек из каталога');
    return { track, score, reasons, measuredTempoMatch: bpm !== undefined && tempoMatches(bpm, controls.tempo) };
}
export function recommend(
    candidates: Track[],
    events: Feedback[],
    controls: Controls,
    context: Context,
    limit = 10,
    suppliedProfile?: TasteProfile,
): Recommendation[] {
    const profile = suppliedProfile || buildProfile(events, context.now);
    const favorites = new Set([...profile.likedIds, ...profile.positiveSeeds.map((track) => track.id)]);
    const favoriteMode = controls.discovery === 'favorites';
    const cooldown = favoriteMode ? Math.min(3, Math.max(0, favorites.size - 1)) : 100;
    const recentIds = new Set([
        ...(context.recentTrackIds || []).slice(0, cooldown),
        ...(context.reservedTrackIds || []),
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
    const recordingSeen = new Set<string>();
    const unseen = [...unique.values()].filter((track) => {
        const key = recordingKey(track);
        if (
            profile.dislikedIds.has(track.id) ||
            recentIds.has(track.id) ||
            blockedRecordings.has(key) ||
            recordingSeen.has(key)
        )
            return false;
        if (favoriteMode && !favorites.has(track.id)) return false;
        if (
            controls.discovery !== 'familiar' &&
            !favoriteMode &&
            (profile.heardIds.has(track.id) || profile.likedIds.has(track.id) || knownRecordings.has(key))
        )
            return false;
        recordingSeen.add(key);
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
    const tokenCache = new Map<Track, Set<string>>();
    const tokenSet = (track: Track) => {
        let value = tokenCache.get(track);
        if (!value) {
            value = new Set(tokensOf(track));
            tokenCache.set(track, value);
        }
        return value;
    };
    const compare = (a: Track, b: Track) => {
        const left = tokenSet(a),
            right = tokenSet(b);
        return left.size && right.size
            ? [...left].filter((token) => right.has(token)).length / Math.sqrt(left.size * right.size)
            : 0;
    };
    const scored = pool.map((track) => scoreTrack(track, profile, controls, context, compare));
    const chosen: Recommendation[] = [];
    const usedArtists = new Set((context.recentArtists || []).slice(0, 2).map(normalize));
    while (scored.length && chosen.length < limit) {
        const highest = Math.max(...scored.map((e) => e.score));
        const eligible = scored.filter((entry) => entry.score >= highest - 3);
        const diverse = eligible.filter((entry) => !usedArtists.has(normalize(entry.track.artist)));
        const options = diverse.length ? diverse : scored;
        let next = options[0],
            best = -Infinity;
        for (const entry of options) {
            const adjusted =
                entry.score - chosen.reduce((sum, selected) => sum + compare(entry.track, selected.track) * 0.75, 0);
            if (adjusted > best || (adjusted === best && entry.track.id.localeCompare(next.track.id) < 0)) {
                next = entry;
                best = adjusted;
            }
        }
        scored.splice(scored.indexOf(next), 1);
        chosen.push(next);
        usedArtists.add(normalize(next.track.artist));
    }
    return chosen;
}
