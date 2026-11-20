import { AudioAnalysisCache } from '../../src/wave/audioAnalysisCache';
import { SoundCloudRecommender, toTrack } from '../../src/wave/recommendation/soundcloudAdapter';
import { normalize, recordingAliases } from '../../src/wave/recommendation/profile';
import { RadioSources, type LibrarySignals } from '../../src/soundcloud/radioSources';
import { parseApiTrack } from '../../src/soundcloud/trackTypes';
import { apiObject } from '../../src/soundcloud/accountTypes';
import type { DataStore } from '../../src/storage/asyncDataStore';
import type { WaveCandidate } from '../../src/wave/waveEngine';
import { api, Profile } from './bridge';
import { candidate } from './tracks';
import { TrackSamples } from './trackSamples';
import { fitsPlaylistWishes, parsePlaylistWishes, playlistWishBonus, type PlaylistWishes } from './playlistWishes';

export interface PlaylistSelection {
    owner: number;
    seed: WaveCandidate;
    title: string;
    tracks: WaveCandidate[];
    requested: number;
    wishes: PlaylistWishes;
    warnings: string[];
}
type Dependencies = {
    request?: typeof api;
    loadProfile?: (owner: number) => Promise<DataStore>;
    now?: () => number;
};

/** A snapshot prevents playlist preparation from altering live Wave feedback, controls, or queues. */
function snapshot(profile: DataStore): DataStore {
    const values = new Map<string, unknown>();
    return {
        get(key, fallback) {
            if (!values.has(key)) values.set(key, structuredClone(profile.get(key, fallback)));
            return values.get(key);
        },
        set: (key, value) => {
            values.set(key, structuredClone(value));
        },
    };
}
const list = (value: unknown): unknown[] => {
    const entries = Array.isArray(value) ? value : apiObject(value)?.collection;
    return Array.isArray(entries) ? entries : [];
};
const alive = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
};

/** Read-only preparation. Saving is a separate, explicit UI action after the user has seen the result. */
export async function selectTrackPlaylist(
    url: string,
    requestText: string,
    count: number,
    signal?: AbortSignal,
    dependencies: Dependencies = {},
): Promise<PlaylistSelection> {
    if (!Number.isInteger(count) || count < 10 || count > 40) throw Error('Choose 10–40 tracks');
    if (requestText.length > 500) throw Error('Wishes are too long');
    if (!/^https:\/\/soundcloud\.com\/[\w.~-]+\/[\w.~-]+\/?$/.test(url)) throw Error('Invalid SoundCloud track URL');
    const wishes = parsePlaylistWishes(requestText);
    if (wishes.conflicts.length) throw Error('Conflicting wishes: ' + wishes.conflicts.join(', '));
    const request = dependencies.request || api;
    const now = dependencies.now || Date.now;
    const started = now();
    alive(signal);
    const owner = Number((await request('me')).id);
    if (!Number.isSafeInteger(owner) || owner <= 0) throw Error('Sign in to SoundCloud first');
    const check = () => {
        alive(signal);
        if (now() - started > 60_000) throw Error('Playlist preparation timed out');
    };
    const read = async (operation: string, fields: object = {}) => {
        check();
        // Cancellation/timeout releases the UI immediately. The host's bounded read can finish,
        // but it cannot enqueue another request or write anything on behalf of this preparation.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: (() => void) | undefined;
        try {
            const result = await Promise.race([
                request(operation, fields, true, owner),
                new Promise<never>((_resolve, reject) => {
                    cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
                    signal?.addEventListener('abort', cancel, { once: true });
                    if (signal?.aborted) cancel();
                    timer = setTimeout(
                        () => reject(Error('Playlist preparation timed out')),
                        Math.max(1, 60_000 - (now() - started)),
                    );
                }),
            ]);
            check();
            return result;
        } finally {
            clearTimeout(timer);
            if (cancel) signal?.removeEventListener('abort', cancel);
        }
    };
    const profileTask = dependencies.loadProfile
        ? dependencies.loadProfile(owner)
        : (async () => {
              const profile = new Profile('wave-' + owner);
              await profile.load();
              return profile;
          })();
    const [rawSeed, profile] = await Promise.all([read('resolve', { url: url.replace(/\/$/, '') }), profileTask]);
    check();
    const store = snapshot(profile);
    const audio = new AudioAnalysisCache(store, String(owner), now);
    // TrackSamples.enrich only reads cached fingerprints; it starts no decoder, window, or download.
    const samples = new TrackSamples(profile as Profile, owner);
    const enrich = (track: WaveCandidate) => samples.enrich(audio.enrich(track));
    const resolved = candidate(rawSeed);
    if (!resolved || resolved.url !== url.replace(/\/$/, ''))
        throw Error('SoundCloud did not confirm the selected track');
    if (['blocked', 'preview', 'protected'].includes(resolved.playability || ''))
        throw Error('The selected track is unavailable');
    const seed = enrich(resolved);
    const engine = new SoundCloudRecommender(store, String(owner), async () => [], now);
    engine.clearCandidates();
    engine.setTrackSeed(seed);
    const pool = new Map<number, WaveCandidate>();
    const liked = new Set<number>();
    const warnings = new Set<string>();
    const add = (
        raw: unknown,
        source: WaveCandidate['source'] = 'related',
        rank = 0,
        linked = false,
        station = false,
    ) => {
        const next = candidate(raw, source, linked ? [seed.url] : undefined);
        if (!next?.apiId || next.apiId === seed.apiId || !next.artist) return;
        const previous = pool.get(next.apiId);
        pool.set(
            next.apiId,
            enrich({
                ...next,
                sourceRank: previous?.sourceRank ?? rank,
                relatedTo: linked ? [seed.url] : previous?.relatedTo,
                stationSeed: station ? seed.url : previous?.stationSeed,
                stationRank: station ? rank : previous?.stationRank,
            }),
        );
    };
    const radio = new RadioSources(
        async (path, params, decode) => decode(await read('radio', { path, params })),
        async (ids) => list(await read('tracks', { ids })).flatMap((raw) => parseApiTrack(raw) || []),
        () => (signal?.aborted ? -1 : owner),
        now,
    );
    const related = async (offset: number) =>
        list(await read('related', { id: seed.apiId, offset })).forEach((raw, i) =>
            add(raw, 'related', offset + i, true),
        );
    const station = async () =>
        (await radio.station(seed.apiId!)).forEach((raw, i) => add(raw, 'related', i, false, true));
    const likes = async () => {
        // Likes are an optional extra source, not a reason to fail related-track discovery.
        const entries = list(await read('likes', { owner, offset: 0 }));
        for (const [i, entry] of entries.entries()) {
            const track = parseApiTrack(apiObject(entry)?.track);
            if (!track) continue;
            liked.add(track.id);
            add(track, 'collection', i);
        }
    };
    const gather = async (tasks: Array<() => Promise<unknown>>) => {
        // Two reads at a time leave native catalog capacity to playback/next-track preparation.
        for (let i = 0; i < tasks.length; i += 2) {
            check();
            const results = await Promise.allSettled(tasks.slice(i, i + 2).map((task) => task()));
            for (const result of results)
                if (result.status === 'rejected') {
                    check();
                    warnings.add('Some SoundCloud sources were unavailable');
                }
        }
    };
    await gather([() => related(0), station, likes]);
    check();
    let signals: LibrarySignals | null = null;
    await gather([
        async () => {
            signals = await radio.signals(owner, signal);
        },
    ]);
    const library = signals as LibrarySignals | null;
    library?.likedIds.forEach((id) => liked.add(id));
    engine.setLibrarySignals([...liked], library?.blockedIds || []);
    const rank = () => {
        const candidates = [...pool.values()].filter((track) =>
            fitsPlaylistWishes(toTrack(track), wishes, liked.has(track.apiId!) || engine.liked(track.url) === true),
        );
        engine.clearCandidates();
        engine.addCandidates([seed, ...candidates], false);
        const eligible = new Set(candidates.map((track) => track.apiId));
        return engine.rank(pool.size + 1).filter((track) => eligible.has(track.apiId));
    };
    let ranked = rank();
    if (ranked.length < count) {
        const queryTerms = [
            wishes.genre || seed.genre,
            ...(seed.tags || []).slice(0, 2),
            wishes.language === 'instrumental' ? 'instrumental' : '',
            wishes.mood || '',
        ];
        const query = queryTerms.filter(Boolean).join(' ').slice(0, 200);
        await gather([
            () => related(50),
            ...(query
                ? [async () => list(await read('search', { query })).forEach((raw, i) => add(raw, 'related', i))]
                : []),
        ]);
        ranked = rank();
    }
    // Requests for bass/brightness/likes are preferences within an anchored tier, never a new seed.
    ranked.sort(
        (a, b) =>
            (b.trackWaveTier || 0) - (a.trackWaveTier || 0) ||
            (b.recommendationScore || 0) +
                playlistWishBonus(toTrack(b), wishes, liked.has(b.apiId!) || engine.liked(b.url) === true) -
                ((a.recommendationScore || 0) +
                    playlistWishBonus(toTrack(a), wishes, liked.has(a.apiId!) || engine.liked(a.url) === true)),
    );
    const chosen: WaveCandidate[] = [];
    const recordings = new Set(recordingAliases(toTrack(seed)));
    const perArtist = new Map<string, number>();
    while (ranked.length && chosen.length < count) {
        const firstTier = ranked[0].trackWaveTier || 0;
        const best = ranked[0].recommendationScore || 0;
        const index = ranked.findIndex(
            (track) =>
                (track.trackWaveTier || 0) === firstTier &&
                (track.recommendationScore || 0) >= best - 2 &&
                normalize(track.artist) !== normalize(chosen[chosen.length - 1]?.artist || ''),
        );
        const [track] = ranked.splice(Math.max(0, index), 1);
        const aliases = recordingAliases(toTrack(track));
        const artist = normalize(track.artist);
        if (
            aliases.some((alias) => recordings.has(alias)) ||
            (perArtist.get(artist) || 0) >= Math.max(2, Math.ceil(count / 5))
        )
            continue;
        chosen.push(track);
        aliases.forEach((alias) => recordings.add(alias));
        perArtist.set(artist, (perArtist.get(artist) || 0) + 1);
    }
    // A final metadata batch prevents stale cached availability from being saved as a full track.
    const verified = chosen.length
        ? new Map(
              list(await read('tracks', { ids: chosen.map((track) => track.apiId!) })).flatMap((raw) => {
                  const track = candidate(raw);
                  return track?.apiId ? [[track.apiId, track] as const] : [];
              }),
          )
        : new Map();
    const tracks = chosen.filter((track) => verified.get(track.apiId!)?.playability === 'available');
    if (tracks.length < count)
        warnings.add('Fewer close, available tracks than requested; unrelated tracks were not added');
    check();
    if ((await read('me')).id !== owner) throw Error('SoundCloud account changed');
    return {
        owner,
        seed,
        title: `Mix · ${seed.title}`.slice(0, 100),
        tracks,
        requested: count,
        wishes,
        warnings: [...warnings],
    };
}
