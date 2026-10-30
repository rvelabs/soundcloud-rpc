import { discoverRelatedCandidates, discoverPersonalHistory, extractWaveLinks } from './nativeWave';
import { setTrackLiked } from './nativeLike';
import {
    defaultWaveControls,
    parseTime,
    type AudioFeatures,
    type WaveCandidate,
    type WaveControls,
} from './waveEngine';
import { SoundCloudRecommender } from './recommendation/soundcloudAdapter';
import { RelatedDiscovery } from './relatedDiscovery';
import { ListeningEvidence } from './listeningEvidence';
import { WindowTasks } from '../utils/windowTasks';
import { WorkScheduler, type WorkPriority } from '../utils/workScheduler';
import { freemem } from 'node:os';
import { IdleResource } from '../utils/idleResource';
import { IpcRegistry } from '../utils/ipcRegistry';
import { PreparedQueue } from './preparedQueue';
import { PlaybackCoordinator } from './playbackCoordinator';
import { EndedPlaybackRecovery } from './playbackRecovery';
import {
    addToNativeNextUp,
    listNativeNextUp,
    removeNativeNextUp,
    playInNativePlayer,
    trackPath,
    NativeTrackNotFoundError,
    NativeActionCanceledError,
} from './nativeQueue';
import { enrichPublicTrack, setPublicMetadataFetch } from './trackMetadata';
import { installWaveMediaEndCapture } from './mediaEndCapture';
import { installAudioFeatureCapture } from './audioFeatureCapture';
import { setStationAutoplay } from './nativeAutoplay';
import type { SoundFeatures } from './recommendation/types';
import type { TrackInfo } from '../types';
import {
    app,
    clipboard,
    ipcMain,
    WebContentsView,
    type WebContents,
    type BrowserWindow,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
} from 'electron';
import type ElectronStore from 'electron-store';
import type { DataStore } from '../storage/asyncDataStore';
import { confirmTrackPlayback } from '../import/availability';
import { AudioAnalysisCache } from './audioAnalysisCache';
export function createWaveController(options: {
    scheduler?: WorkScheduler;
    window: BrowserWindow;
    contents: WebContents;
    store: ElectronStore;
    libraryStore: DataStore;
    account: string;
    userAgent: string;
    getTrack: () => TrackInfo;
    setTrack: (track: TrackInfo) => void;
    trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
    quitting: () => boolean;
    availabilityRoute: () => string;
    languageChanged: () => void;
    events: () => object[];
    importDiagnostics: () => object | undefined;
    trace: (event: string, current?: string, observed?: string, detail?: string) => void;
}) {
    const {
        window: mainWindow,
        contents: clientContents,
        store,
        libraryStore,
        account: currentAccountId,
        userAgent: globalUserAgent,
        getTrack,
        setTrack,
        trusted: isTrustedSoundCloudSender,
        quitting,
        availabilityRoute,
        languageChanged,
        events,
        importDiagnostics,
        trace: traceWave,
    } = options;
    const windowIpc = new IpcRegistry(ipcMain, isTrustedSoundCloudSender);
    const windowTasks = new WindowTasks(() => !mainWindow.isDestroyed() && !clientContents.isDestroyed());
    const waveListening = new ListeningEvidence();
    const audioAnalysis = new AudioAnalysisCache(libraryStore, currentAccountId);
    const scheduler = options.scheduler || new WorkScheduler();
    const enrichCandidate = (track: WaveCandidate, priority: WorkPriority = 'prefetch') =>
        scheduler.run('network', priority, async () => audioAnalysis.enrich(await enrichPublicTrack(track)));
    let waveStarting = false;
    let waveVisible = false;
    let onNativeWaveTrackUpdate: ((track: TrackInfo) => void) | null = null;
    let onNativeProgress: ((track: TrackInfo) => void) | undefined;
    let onWaveNextRequest: (() => void) | null = null;
    const releaseMetadata = setPublicMetadataFetch((input, init) =>
        clientContents.session.fetch(input instanceof URL ? input.href : input, {
            ...init,
            credentials: 'omit',
        }),
    );
    waveListening.reset();
    const discoveryPage = new IdleResource(
        () => {
            const view = new WebContentsView({
                webPreferences: {
                    session: clientContents.session,
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    webSecurity: true,
                    backgroundThrottling: false,
                    images: false,
                },
            });
            view.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
            view.webContents.setUserAgent(globalUserAgent);
            view.webContents.setAudioMuted(true);
            view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            return view.webContents;
        },
        (contents) => {
            if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
        },
        () => (freemem() < 2 * 1024 ** 3 ? 0 : 120000),
        async (contents) => {
            if (contents.isDestroyed() || contents.getURL() === 'about:blank') return;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    contents.loadURL('about:blank'),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(() => {
                            if (!contents.isDestroyed()) contents.stop();
                            resolve();
                        }, 1000);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        },
        1500,
    );
    let waveHistoryLoaded = false;
    let waveCurrent = '';
    let waveReachedEnd = false;
    let waveCurrentCandidate: WaveCandidate | null = null;
    const waveHistory: WaveCandidate[] = [];
    const waveFuture: WaveCandidate[] = [];
    const wavePrepared = new PreparedQueue<WaveCandidate>();
    const nativeQueued: WaveCandidate[] = [];
    const nativeQueueFailureKey = `waveQueueUnavailableV17_2_${currentAccountId}`;
    const stationAutoplayMarkerKey = `waveStationAutoplayWasOn_${currentAccountId}`;
    let stationAutoplayPrevious: boolean | null = store.get(stationAutoplayMarkerKey) === true ? true : null;
    let stationAutoplayTask: Promise<void> | null = null;
    let stationRecoveryAttempted = false;
    const disableStationAutoplay = (): Promise<void> => {
        if (stationAutoplayTask) return stationAutoplayTask;
        const task = (async () => {
            const previous = await setStationAutoplay(clientContents, false);
            if (previous === true) {
                stationAutoplayPrevious = true;
                store.set(stationAutoplayMarkerKey, true);
            } else if (previous === false && stationAutoplayPrevious === null) stationAutoplayPrevious = false;
        })();
        stationAutoplayTask = task;
        const clearTask = () => {
            if (stationAutoplayTask === task) stationAutoplayTask = null;
        };
        void task.then(clearTask, clearTask);
        return task;
    };
    const restoreStationAutoplay = async (): Promise<void> => {
        if (stationAutoplayTask) await stationAutoplayTask.catch(() => {});
        if (stationAutoplayPrevious !== true) return;
        const previous = await setStationAutoplay(clientContents, true);
        if (previous === null) return;
        stationAutoplayPrevious = null;
        store.delete(stationAutoplayMarkerKey);
    };
    let nativeQueueAvailable = Date.now() - Number(store.get(nativeQueueFailureKey) || 0) > 60 * 60 * 1000;
    let nativeQueueTask: Promise<void> | null = null;
    let nativeQueueAttempt = 0;
    let nativeAdding: WaveCandidate | null = null;
    let nativeQueueResetTask: Promise<void> | null = null;
    let waveShuffle = false;
    let waveLikeView: WebContentsView | null = null;
    let likeTask: Promise<boolean> | null = null;
    const waveKnownLikes = new Map<string, boolean>();
    let waveCurrentRecorded = false;
    let audioSamples = 0;
    const audioTotals = { energy: 0, bass: 0, brightness: 0 };
    const controlsKey = `waveControls_${currentAccountId}`;
    const savedControls = store.get(controlsKey) as Partial<WaveControls> | undefined;
    const waveControls: WaveControls = { ...defaultWaveControls };
    const noSelectionMessage = () =>
        waveControls.discovery === 'favorites'
            ? 'Не нашлось любимых треков с этими настройками. Ослабьте фильтры или добавьте лайки.'
            : waveControls.language && waveControls.language !== 'any'
              ? 'Не нашлось треков с подтверждённой пометкой языка. Попробуйте другой язык.'
              : ['happy', 'sad'].includes(waveControls.mood)
                ? 'Не нашлось треков с явной пометкой выбранного настроения. Попробуйте изменить фильтры.'
                : waveControls.discovery === 'popular'
                  ? 'Не нашлось доступных популярных треков с этими настройками.'
                  : 'Добавьте несколько понравившихся треков в SoundCloud или включите любимую запись — волна найдёт похожую музыку. Если они уже есть, попробуйте ослабить фильтры.';
    let waveQueueEpoch = 0;
    let endCaptureQueueReady = false;
    const syncMediaEndCapture = () => {
        if (clientContents.isDestroyed() || !clientContents.getURL().startsWith('https://soundcloud.com/')) return;
        void clientContents
            .executeJavaScript(
                `window.__waveMediaEndState = Object.assign(
            window.__waveMediaEndState || {}, { active: ${waveVisible}, queueReady: ${endCaptureQueueReady}, currentPath: ${JSON.stringify(trackPath(waveCurrent))},
                analysisReadyPath: ${JSON.stringify(waveCurrentCandidate && audioAnalysis.get(waveCurrentCandidate) ? trackPath(waveCurrent) : null)},
                ...(${!waveVisible || endCaptureQueueReady} ? { handoffPending: false, protectedUntil: 0 } : {}) });window.dispatchEvent(new Event('__soundcloudWaveMediaState'));`,
                true,
            )
            .catch(() => {});
    };
    const sendInline = (channel: string, ...args: unknown[]) => {
        if (!clientContents.isDestroyed()) clientContents.send(`wave-inline:${channel}`, ...args);
        if (channel === 'active' || channel === 'candidate') syncMediaEndCapture();
        if (channel === 'queue-ready') {
            endCaptureQueueReady = args[0] === true;
            syncMediaEndCapture();
        }
    };
    const knownLike = (url: string) => waveKnownLikes.get(url) ?? waveRecommender.liked(url);
    const likeState = (url: string) => ({ url, known: knownLike(url) !== undefined, liked: knownLike(url) === true });
    const sendLikeState = (url: string) => {
        sendInline('liked', likeState(url));
    };
    const getLikeView = () => {
        if (!waveLikeView?.webContents || waveLikeView.webContents.isDestroyed()) {
            waveLikeView = new WebContentsView({
                webPreferences: {
                    session: clientContents.session,
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    webSecurity: true,
                },
            });
            waveLikeView.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
            waveLikeView.webContents.setUserAgent(globalUserAgent);
            waveLikeView.webContents.setAudioMuted(true);
            waveLikeView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        }
        return waveLikeView.webContents;
    };
    const releaseLikePage = () => {
        if (waveLikeView?.webContents && !waveLikeView.webContents.isDestroyed())
            waveLikeView.webContents.close({ waitForBeforeUnload: false });
        waveLikeView = null;
    };
    const relatedDiscovery = new RelatedDiscovery((url) =>
        discoveryPage.use((contents) =>
            scheduler.run('page', 'prefetch', () => discoverRelatedCandidates(contents, url)),
        ),
    );
    const waveRecommender = new SoundCloudRecommender(libraryStore, currentAccountId, async (seeds) => {
        const generation = waveGeneration;
        return relatedDiscovery.discover(seeds, () => waveVisible && generation === waveGeneration);
    });
    let waveMetadataWarmupStarted = false;
    const onDidFinishLoad = () => {
        if (clientContents.isDestroyed() || !clientContents.getURL().startsWith('https://soundcloud.com/')) return;
        void clientContents
            .executeJavaScript(
                `(${installWaveMediaEndCapture.toString()})();(${installAudioFeatureCapture.toString()})()`,
                true,
            )
            .then(syncMediaEndCapture)
            .catch((error) => console.debug('Wave media end hook unavailable:', error));
        if (!stationRecoveryAttempted && stationAutoplayPrevious === true && !waveVisible) {
            stationRecoveryAttempted = true;
            windowTasks.defer(() => {
                if (!waveVisible)
                    void restoreStationAutoplay().catch((error) =>
                        console.debug('Wave station autoplay restore unavailable:', error),
                    );
            }, 600);
        }
        windowTasks.defer(() => {
            if (
                clientContents.isDestroyed() ||
                waveVisible ||
                !clientContents.getURL().startsWith('https://soundcloud.com/')
            )
                return;
            void clientContents
                .executeJavaScript(`(${extractWaveLinks.toString()})()`, true)
                .then(async (tracks: WaveCandidate[]) => {
                    waveRecommender.addCandidates(tracks.map((track) => ({ ...track, source: 'personal' })));
                    if (waveMetadataWarmupStarted) return;
                    waveMetadataWarmupStarted = true;
                    const ranked = waveRecommender.rank(8);
                    if (ranked.length)
                        waveRecommender.addCandidates(
                            await Promise.all(ranked.map((track) => enrichCandidate(track, 'catalog'))),
                        );
                })
                .catch((error) => console.debug('Wave home preload unavailable:', error));
        }, 400);
    };
    clientContents.on('did-finish-load', onDidFinishLoad);
    const recordCurrent = (kind: 'skip' | 'complete' | 'play') => {
        if (!waveCurrentCandidate || waveCurrentRecorded) return;
        const duration = getTrack().url === waveCurrent ? parseTime(getTrack().duration) : 0;
        const fraction = waveListening.fraction(
            waveCurrentCandidate.url,
            duration || waveCurrentCandidate.durationSeconds || 0,
        );
        const features: SoundFeatures | undefined = audioSamples
            ? {
                  source: 'media-element-v1',
                  sampleSeconds: audioSamples,
                  energy: audioTotals.energy / audioSamples,
                  bass: audioTotals.bass / audioSamples,
                  brightness: audioTotals.brightness / audioSamples,
              }
            : undefined;
        if (features) audioAnalysis.remember(waveCurrentCandidate, features);
        waveRecommender.record(
            waveCurrentCandidate,
            kind === 'complete' && fraction < 0.7 ? 'play' : kind,
            fraction,
            features,
        );
        waveCurrentRecorded = true;
    };
    const setControls = (input: Partial<WaveControls>) => {
        const previous = JSON.stringify(waveControls);
        if (['any', 'calm', 'energetic', 'happy', 'sad'].includes(String(input.mood))) waveControls.mood = input.mood!;
        if (['any', 'balanced', 'bass', 'bright'].includes(String(input.tone))) waveControls.tone = input.tone!;
        if (['any', 'slow', 'medium', 'fast'].includes(String(input.tempo))) waveControls.tempo = input.tempo!;
        if (['familiar', 'favorites', 'balanced', 'new', 'popular'].includes(String(input.discovery)))
            waveControls.discovery = input.discovery === 'familiar' ? 'favorites' : input.discovery!;
        if (['any', 'focus', 'relax', 'workout', 'wake', 'commute', 'sleep'].includes(String(input.activity)))
            waveControls.activity = input.activity!;
        if (['any', 'ru', 'foreign', 'instrumental'].includes(String(input.language)))
            waveControls.language = input.language!;
        waveControls.genre = '';
        waveRecommender.setControls(waveControls);
        if (JSON.stringify(waveControls) !== previous) {
            endedRecovery.cancel();
            waveQueueEpoch++;
            waveGeneration++;
            playback.invalidate();
            for (const candidate of waveFuture) waveRecommender.release(candidate);
            waveFuture.length = 0;
            wavePrepared.clear();
            if (waveVisible)
                void resetNativeQueue()
                    .then(prepareUpcoming)
                    .then(() => (waveCurrentCandidate ? fillNativeQueue() : playback.request('start')))
                    .catch((error) => console.debug('Wave settings refresh unavailable:', error));
        }
        store.set(controlsKey, waveControls);
        clientContents.send('wave-inline:controls', waveControls);
    };
    let waveGeneration = 0;
    let waveNextTask: Promise<void> | null = null;
    let waveNextTaskGeneration = -1;
    let waveSearchTail: Promise<void> = Promise.resolve();
    let waveDiscoveryTask: Promise<void> | undefined;
    let preparedFeedbackRevision = waveRecommender.preparationRevision();
    const refreshWaveDiscovery = (): void => {
        if (waveDiscoveryTask || !waveVisible) return;
        const generation = waveGeneration;
        const task = waveRecommender
            .refreshIfNeeded()
            .then(async (changed) => {
                if (!changed || !waveVisible || generation !== waveGeneration) return;
                wavePrepared.clear(true);
                traceWave('discovery-direction-refreshed', waveCurrent);
                await prepareUpcoming();
            })
            .catch((error) => console.debug('Wave live discovery unavailable:', error))
            .finally(() => {
                if (waveDiscoveryTask === task) waveDiscoveryTask = undefined;
            });
        waveDiscoveryTask = task;
    };
    const prepareUpcoming = async () => {
        if (!waveVisible) return;
        const revision = waveRecommender.preparationRevision();
        if (preparedFeedbackRevision !== revision) {
            preparedFeedbackRevision = revision;
            wavePrepared.clear(true);
        }
        refreshWaveDiscovery();
        if (wavePrepared.length >= 3) return;
        const generation = waveGeneration;
        const settingsEpoch = waveQueueEpoch;
        await wavePrepared.prepare(
            async (publish) => {
                const target = waveStarting || waveNextTask ? 1 : 3;
                const available = () =>
                    waveRecommender
                        .rank(20)
                        .filter(
                            (item) =>
                                (['favorites', 'balanced', 'familiar'].includes(waveControls.discovery || 'balanced') ||
                                    item.source === 'related') &&
                                item.url !== waveCurrent &&
                                item.url !== getTrack().url &&
                                !waveFuture.some((future) => future.url === item.url) &&
                                !nativeQueued.some((queued) => queued.url === item.url),
                        );
                const cached = available().slice(0, 4);
                if (cached.length) {
                    const checked: WaveCandidate[] = [];
                    let publishedFirst = false;
                    await Promise.all(
                        cached.map(async (item) => {
                            const candidate = await enrichCandidate(item);
                            if (generation !== waveGeneration || settingsEpoch !== waveQueueEpoch || !waveVisible)
                                return;
                            checked.push(candidate);
                            waveRecommender.addCandidates([candidate]);
                            if (waveControls.tempo === 'any' && !publishedFirst) {
                                const first = waveRecommender.rankBuffered(checked).slice(0, 1);
                                if (first.length) {
                                    publish(first);
                                    publishedFirst = true;
                                }
                            }
                        }),
                    );
                    if (generation !== waveGeneration || settingsEpoch !== waveQueueEpoch || !waveVisible) return [];
                    waveRecommender.addCandidates(checked);
                    const ready = waveRecommender.rankBuffered(checked).slice(0, target);
                    publish(ready);
                    if (ready.length >= target) return ready;
                }

                const previousSearch = waveSearchTail;
                let release!: () => void;
                waveSearchTail = new Promise<void>((resolve) => {
                    release = resolve;
                });
                await previousSearch;
                try {
                    if (generation !== waveGeneration || settingsEpoch !== waveQueueEpoch || !waveVisible) return [];
                    const minimum = waveStarting || waveNextTask ? 1 : 3;
                    if (available().length < minimum) {
                        try {
                            const visible = (await clientContents.executeJavaScript(
                                `(${extractWaveLinks.toString()})()`,
                                true,
                            )) as WaveCandidate[];
                            waveRecommender.addCandidates(visible);
                        } catch (error) {
                            console.debug('Wave visible recommendations unavailable:', error);
                        }
                    }
                    if (!available().length && waveControls.discovery === 'favorites') return [];
                    if (available().length < minimum && waveControls.discovery !== 'favorites')
                        await waveRecommender.refresh();
                    if (generation !== waveGeneration || settingsEpoch !== waveQueueEpoch || !waveVisible) return [];
                    const playable: WaveCandidate[] = [];
                    const targetCount = waveStarting || waveNextTask ? 1 : 3;
                    for (let round = 0; round < 2 && playable.length < targetCount; round++) {
                        if (round && waveControls.discovery !== 'favorites') await waveRecommender.refresh();
                        const ranked = available().slice(0, 12);
                        for (let i = 0; i < ranked.length && playable.length < targetCount; i += 4) {
                            const batch = await Promise.all(
                                ranked.slice(i, i + 4).map((track) => enrichCandidate(track)),
                            );
                            if (generation !== waveGeneration || settingsEpoch !== waveQueueEpoch || !waveVisible)
                                return [];
                            waveRecommender.addCandidates(batch);
                            for (const candidate of waveRecommender.rankBuffered(batch)) {
                                const duration = candidate.durationSeconds;
                                if (duration && (duration < 45 || duration > 1200)) {
                                    waveRecommender.reserve(candidate);
                                    traceWave('duration-rejected', waveCurrent, candidate.url, String(duration));
                                    continue;
                                }
                                if (!playable.some((old) => old.url === candidate.url)) playable.push(candidate);
                            }
                            publish(waveRecommender.rankBuffered(playable).slice(0, targetCount));
                        }
                    }
                    return waveRecommender.rankBuffered(playable).slice(0, targetCount);
                } finally {
                    release();
                }
            },
            [
                waveCurrent,
                getTrack().url,
                ...waveFuture.map((candidate) => candidate.url),
                ...nativeQueued.map((candidate) => candidate.url),
            ],
        );
    };
    const takeDiverseUpcoming = async (includeFuture = true): Promise<WaveCandidate | undefined> => {
        for (let i = waveFuture.length - 1; i >= 0; i--) {
            const path = trackPath(waveFuture[i].url);
            if (
                path === trackPath(waveCurrent) ||
                path === trackPath(getTrack().url || '') ||
                waveHistory.slice(-10).some((track) => trackPath(track.url) === path)
            )
                waveFuture.splice(i, 1);
        }
        if (includeFuture && waveFuture.length)
            return waveFuture.splice(
                waveShuffle ? Math.floor(Math.random() * waveFuture.length) : waveFuture.length - 1,
                1,
            )[0];
        const epoch = waveQueueEpoch;
        const options: WaveCandidate[] = [];
        const collect = async () => {
            while (options.length < 3) {
                const next = options.length && !wavePrepared.length ? undefined : await wavePrepared.take(waveShuffle);
                if (!next) break;
                if (next.url !== waveCurrent && !options.some((item) => item.url === next.url)) options.push(next);
            }
        };
        await collect();
        if (!options.length) {
            void prepareUpcoming().catch((error) => console.debug('Wave preparation unavailable:', error));
            await collect();
        }
        if (epoch !== waveQueueEpoch || !waveVisible) return undefined;
        if (!options.length) return undefined;
        let ranked = waveRecommender.rankBuffered(
            options,
            options.length,
            [...(!includeFuture ? waveFuture : []), waveCurrentCandidate, ...waveHistory.slice(-2)]
                .map((item) => item?.artist || '')
                .filter(Boolean),
        );
        if (!ranked.length) {
            for (const item of options) waveRecommender.reserve(item);
            options.length = 0;
            void prepareUpcoming().catch((error) => console.debug('Wave preparation unavailable:', error));
            await collect();
            if (epoch !== waveQueueEpoch || !waveVisible) return undefined;
            ranked = waveRecommender.rankBuffered(
                options,
                options.length,
                [waveCurrentCandidate?.artist || ''].filter(Boolean),
            );
        }
        const chosen = ranked.shift();
        wavePrepared.putBack(ranked);
        return chosen;
    };
    const chooseNext = async (reason: 'start' | 'user' | 'native-user' | 'finish' | 'error' = 'start') => {
        if (waveNextTask) {
            traceWave('next-coalesced', waveCurrent, undefined, reason);
            if (waveNextTaskGeneration === waveGeneration) return waveNextTask;
            try {
                await waveNextTask;
            } catch {}
            if (waveNextTask && waveNextTaskGeneration === waveGeneration) return waveNextTask;
        }
        const generation = waveGeneration;
        nativeQueueAttempt++;
        traceWave('next-requested', waveCurrent, undefined, reason);
        const task = (async () => {
            try {
                if (reason === 'user') {
                    recordCurrent('skip');
                } else if (reason === 'finish') recordCurrent('complete');
                else if (reason === 'error') recordCurrent('play');
                let chosen: WaveCandidate | undefined;
                let playError: unknown;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const candidate = await takeDiverseUpcoming();
                    if (generation !== waveGeneration || !waveVisible) return;
                    if (!candidate) break;
                    traceWave('candidate-selected', waveCurrent, candidate.url, reason);
                    const previous = waveCurrent;
                    waveCurrent = candidate.url;
                    try {
                        await clientContents.executeJavaScript(
                            `if (window.__waveMediaEndState) window.__waveMediaEndState.expectedPath = ${JSON.stringify(trackPath(candidate.url))};`,
                            true,
                        );
                        await scheduler.run('playback', 'playback', () =>
                            playInNativePlayer(
                                clientContents,
                                candidate.url,
                                candidate.title,
                                candidate.sourceQuery,
                                () => generation === waveGeneration && waveVisible,
                                (phase) => traceWave('native-step', previous, candidate.url, phase),
                            ),
                        );
                        traceWave('candidate-playing', previous, candidate.url, reason);
                        chosen = candidate;
                        break;
                    } catch (error) {
                        playError = error;
                        traceWave(
                            'candidate-failed',
                            previous,
                            candidate.url,
                            error instanceof Error ? error.message.slice(0, 120) : 'unknown',
                        );
                        waveCurrent = previous;
                        waveRecommender.release(candidate);
                        waveRecommender.reserve(candidate);
                    }
                }
                if (generation !== waveGeneration || !waveVisible) return;
                if (!chosen) {
                    if (!playError)
                        traceWave(
                            'selection-empty',
                            waveCurrent,
                            undefined,
                            JSON.stringify({
                                controls: waveControls,
                                prepared: wavePrepared.length,
                                upcoming: waveFuture.length,
                                queued: nativeQueued.length,
                                discovery: relatedDiscovery.diagnostics(),
                                recommendation: waveRecommender.diagnostics(),
                                scheduler: scheduler.diagnostics(),
                            }),
                        );
                    throw playError || new Error(noSelectionMessage());
                }
                waveRecommender.reserve(chosen, true);
                if (waveCurrentCandidate) {
                    waveHistory.push(waveCurrentCandidate);
                    if (waveHistory.length > 100) waveHistory.shift();
                }
                waveCurrentCandidate = chosen;
                waveRecommender.setAnchor(chosen);
                waveReachedEnd = false;
                waveCurrentRecorded = false;
                audioSamples = 0;
                audioTotals.energy = 0;
                audioTotals.bass = 0;
                audioTotals.brightness = 0;
                sendInline('candidate', chosen);
                sendLikeState(chosen.url);
                sendInline('state', 'playing');
                void disableStationAutoplay().catch((error) =>
                    console.debug('Wave station autoplay refresh unavailable:', error),
                );
                void fillNativeQueue().catch((error) => console.debug('Wave prefetch unavailable:', error));
                void prepareUpcoming()
                    .then(loadWaveTaste)
                    .catch((error) => console.debug('Wave prefetch unavailable:', error));
            } catch (error) {
                if (generation !== waveGeneration || !waveVisible) return;
                const message = error instanceof Error ? error.message : 'Не удалось подобрать трек.';
                sendInline('state', 'error', message);
                throw error;
            }
        })();
        waveNextTask = task;
        waveNextTaskGeneration = generation;
        try {
            await task;
        } finally {
            if (waveNextTask === task) {
                waveNextTask = null;
                if (!clientContents.isDestroyed())
                    void clientContents
                        .executeJavaScript(
                            'if (window.__waveMediaEndState) Object.assign(window.__waveMediaEndState, {handoffPending:false, protectedUntil:0, expectedPath:undefined})',
                        )
                        .catch(() => {});
            }
            if (waveVisible)
                void prepareUpcoming().catch((error) => console.debug('Wave buffer refill unavailable:', error));
        }
    };
    const playback = new PlaybackCoordinator({
        active: () => waveVisible && !clientContents.isDestroyed(),
        nativeReady: () => nativeQueueAvailable && nativeQueued.length > 0,
        select: chooseNext,
        advanceNative: async (reason) => {
            const previous = waveCurrent;
            const generation = waveGeneration;
            const expected = trackPath(nativeQueued[0]?.url || '');
            const clicked =
                !['user', 'error'].includes(reason) ||
                (await clientContents
                    .executeJavaScript(
                        `(() => {
                const button = document.querySelector('.skipControl__next');
                if (!button || button.disabled) return false;
                button.click(); return true;
            })()`,
                        true,
                    )
                    .catch(() => false));
            const deadline = Date.now() + (reason === 'finish' ? 1200 : 2000);
            while (
                clicked &&
                waveVisible &&
                generation === waveGeneration &&
                !clientContents.isDestroyed() &&
                Date.now() < deadline
            ) {
                const state = await clientContents
                    .executeJavaScript(
                        `({path:document.querySelector('.playbackSoundBadge__titleLink')?.pathname,playing:document.querySelector('.playControls__play')?.classList.contains('playing')===true})`,
                    )
                    .catch(() => null);
                if (!state) break;
                if (
                    state.path &&
                    state.path !== trackPath(previous) &&
                    (state.path === expected || waveCurrentCandidate?.url === 'https://soundcloud.com' + state.path)
                )
                    return true;
                await new Promise((resolve) => setTimeout(resolve, 80));
            }
            if (!waveVisible || generation !== waveGeneration || clientContents.isDestroyed()) return true;
            traceWave('native-handoff-stalled', previous, undefined, reason);
            nativeQueueAttempt++;
            const pending = [...nativeQueued];
            nativeQueueAvailable = false;
            sendInline('queue-ready', false);
            await resetNativeQueue().catch((error) =>
                traceWave(
                    'native-cleanup-failed',
                    previous,
                    undefined,
                    error instanceof Error ? error.message : 'unknown',
                ),
            );
            nativeQueueAvailable = false;
            if (waveVisible && generation === waveGeneration) {
                const retained = pending.filter(
                    (item) => item.url !== waveCurrent && !waveFuture.some((future) => future.url === item.url),
                );
                for (const item of waveFuture) waveRecommender.release(item);
                for (const item of [...retained, ...waveFuture.slice().reverse()]) waveRecommender.reserve(item, true);
                waveFuture.push(...retained.reverse());
            }
            return false;
        },
    });
    const endedRecovery = new EndedPlaybackRecovery({
        current: () => (waveVisible && !clientContents.isDestroyed() ? waveCurrent : undefined),
        ended: async (url) => {
            if (!waveVisible || clientContents.isDestroyed() || waveCurrent !== url) return false;
            return clientContents.executeJavaScript(
                `(() => {
                    const state = window.__waveMediaEndState;
                    const capture = window.__waveMediaEndSnapshot?.();
                    return state?.active === true && !state.expectedPath &&
                        capture?.media.some(media => media.active && !media.manualPause && (media.ended || media.terminal) &&
                            media.path === ${JSON.stringify(trackPath(url))}) === true;
                })()`,
                true,
            );
        },
        advance: () => playback.request('finish'),
        failed: (error, attempt) => {
            traceWave(
                attempt ? 'transition-retry-failed' : 'transition-failed',
                waveCurrent,
                undefined,
                `${attempt}: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown'}`,
            );
            console.debug('Wave finish unavailable:', error);
        },
    });
    onWaveNextRequest = () => {
        endedRecovery.cancel();
        void playback.request('user').catch((error) => console.debug('Wave next unavailable:', error));
    };
    const fillNativeQueue = async (): Promise<void> => {
        if (nativeQueueResetTask) await nativeQueueResetTask;
        if (nativeQueueTask) return nativeQueueTask;
        const generation = waveGeneration;
        const attempt = nativeQueueAttempt;
        const task = (async () => {
            let missingCandidates = 0;
            if (!nativeQueueAvailable && waveFuture.length) sendInline('state', 'playing', 'Следующий трек готов');
            while (
                waveVisible &&
                generation === waveGeneration &&
                attempt === nativeQueueAttempt &&
                (nativeQueueAvailable ? nativeQueued.length < 2 : waveFuture.length < 1)
            ) {
                void prepareUpcoming().catch((error) =>
                    console.debug('Wave background preparation unavailable:', error),
                );
                const next = await takeDiverseUpcoming(nativeQueueAvailable);
                if (!next || generation !== waveGeneration || attempt !== nativeQueueAttempt || !waveVisible) break;
                if (next.url === waveCurrent || nativeQueued.some((item) => item.url === next.url)) continue;
                if (nativeQueueAvailable) {
                    try {
                        const occupied = (await listNativeNextUp(clientContents)).some(
                            (url) =>
                                trackPath(url) !== trackPath(waveCurrent) &&
                                !nativeQueued.some((item) => trackPath(item.url) === trackPath(url)),
                        );
                        if (occupied) {
                            if (nativeQueued.length) {
                                waveFuture.push(next);
                                waveRecommender.reserve(next, true);
                                break;
                            }
                            nativeQueueAvailable = false;
                            traceWave('queue-occupied', waveCurrent, next.url);
                        } else {
                            nativeAdding = next;
                            await scheduler.run('playback', 'prefetch', () =>
                                addToNativeNextUp(
                                    clientContents,
                                    next.url,
                                    next.title,
                                    next.sourceQuery,
                                    () =>
                                        generation === waveGeneration && attempt === nativeQueueAttempt && waveVisible,
                                    (phase) => traceWave('native-step', waveCurrent, next.url, phase),
                                ),
                            );
                            nativeAdding = null;
                            store.set(nativeQueueFailureKey, 0);
                            traceWave('queue-confirmed', waveCurrent, next.url);
                        }
                    } catch (error) {
                        if (error instanceof NativeActionCanceledError) {
                            if (!clientContents.isDestroyed() && nativeAdding?.url === next.url)
                                await removeNativeNextUp(clientContents, [next.url]).catch(() => false);
                            if (waveVisible && generation === waveGeneration) {
                                waveFuture.push(next);
                                waveRecommender.reserve(next, true);
                            }
                            break;
                        }
                        if (error instanceof NativeTrackNotFoundError) {
                            traceWave('queue-candidate-missing', waveCurrent, next.url);
                            waveRecommender.reserve(next);
                            if (++missingCandidates < 3) continue;
                            if (nativeQueued.length) break;
                            nativeQueueAvailable = false;
                            traceWave('queue-search-fallback', waveCurrent);
                            continue;
                        }
                        if (nativeQueued.length) {
                            waveFuture.push(next);
                            waveRecommender.reserve(next, true);
                            break;
                        }
                        nativeQueueAvailable = false;
                        store.set(nativeQueueFailureKey, Date.now());
                        traceWave(
                            'queue-failed',
                            waveCurrent,
                            next.url,
                            error instanceof Error ? error.message.slice(0, 500) : 'unknown',
                        );
                        console.debug('Native Next Up unavailable; using prepared Wave transition:', error);
                    }
                }
                if (generation !== waveGeneration || attempt !== nativeQueueAttempt || !waveVisible) break;
                if (nativeQueueAvailable) {
                    nativeQueued.push(next);
                    waveRecommender.reserve(next, true);
                } else {
                    waveFuture.unshift(next);
                    waveRecommender.reserve(next, true);
                }
                sendInline('queue-ready', nativeQueueAvailable && nativeQueued.length > 0);
                waveRecommender.reserve(next);
                sendInline('state', 'playing', 'Следующий трек готов');
            }
        })();
        nativeQueueTask = task;
        try {
            await task;
        } finally {
            if (nativeQueueTask === task) {
                nativeQueueTask = null;
                nativeAdding = null;
            }
        }
    };
    const resetNativeQueue = async (): Promise<void> => {
        if (nativeQueueResetTask) return nativeQueueResetTask;
        const stale = [...nativeQueued, ...(nativeAdding ? [nativeAdding] : [])];
        nativeQueued.length = 0;
        sendInline('queue-ready', false);
        const task = (async () => {
            await nativeQueueTask?.catch(() => {});
            if (clientContents.isDestroyed()) return;
            if (stale.length) {
                const removed = await removeNativeNextUp(
                    clientContents,
                    stale.map((item) => item.url),
                );
                nativeQueueAvailable = removed;
                traceWave('queue-reset', waveCurrent, undefined, removed ? 'confirmed' : 'prepared-transition');
                for (const item of stale) waveRecommender.release(item);
            }
            nativeAdding = null;
        })();
        nativeQueueResetTask = task;
        try {
            await task;
        } finally {
            if (nativeQueueResetTask === task) nativeQueueResetTask = null;
        }
    };
    if (savedControls && typeof savedControls === 'object') setControls(savedControls);
    let waveTasteTask: Promise<void> | undefined;
    const loadWaveTaste = async (): Promise<void> => {
        if (waveTasteTask) return waveTasteTask;
        if (waveHistoryLoaded || windowWorkStopped || quitting() || clientContents.isDestroyed()) return;
        const previousSearch = waveSearchTail;
        let release!: () => void;
        waveSearchTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        const task = (async () => {
            await previousSearch;
            try {
                if (windowWorkStopped || quitting() || clientContents.isDestroyed()) return;
                const personal = await discoveryPage.use((contents) =>
                    scheduler.run('page', 'prefetch', () => discoverPersonalHistory(contents)),
                );
                if (windowWorkStopped || quitting() || clientContents.isDestroyed()) return;
                waveRecommender.seedLikes(personal.likes);
                waveRecommender.seedRecent(personal.recent);
                waveHistoryLoaded = personal.likes.length > 0 || personal.recent.length > 0;
                sendInline('stats', waveRecommender.stats());
            } catch (error) {
                if (!windowWorkStopped && !quitting()) console.debug('Wave taste history unavailable:', error);
            } finally {
                release();
            }
        })();
        waveTasteTask = task;
        try {
            await task;
        } finally {
            if (waveTasteTask === task) waveTasteTask = undefined;
        }
    };
    const disposeWaveViews = () => {
        if (!options.scheduler) scheduler.dispose();
        windowIpc.dispose();
        endedRecovery.cancel();
        windowTasks.dispose();
        waveVisible = false;
        waveGeneration++;
        waveQueueEpoch++;
        wavePrepared.clear();
        onNativeWaveTrackUpdate = null;
        onNativeProgress = undefined;
        discoveryPage.dispose();
        for (const view of [waveLikeView]) {
            const contents = view?.webContents;
            if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
        }
    };
    let windowWorkStopped = false;
    const stop = () => {
        if (windowWorkStopped) return;
        windowWorkStopped = true;
        releaseMetadata();
        clientContents.removeListener('did-finish-load', onDidFinishLoad);
        clientContents.removeListener('before-input-event', onBeforeInputEvent);
        clientContents.removeListener('destroyed', stop);
        if (waveVisible && waveCurrentCandidate) recordCurrent('play');
        else if (getTrack().url) {
            const fraction = waveListening.fraction(getTrack().url, parseTime(getTrack().duration));
            waveRecommender.record(
                { url: getTrack().url, title: getTrack().title, artist: getTrack().author, sourceRank: 0 },
                fraction >= 0.9 ? 'complete' : 'play',
                fraction,
            );
        }
        playback.invalidate();
        waveRecommender.clearCandidates();
        disposeWaveViews();
        onWaveNextRequest = null;
    };
    let confirmedPlaybackUrl = '';
    onNativeProgress = (track) => {
        if (
            track.url &&
            track.url !== confirmedPlaybackUrl &&
            track.isPlaying &&
            waveListening.fraction(track.url, parseTime(track.duration)) * parseTime(track.duration) >= 3
        ) {
            confirmTrackPlayback(clientContents.session, track.url, availabilityRoute());
            confirmedPlaybackUrl = track.url;
        }
    };
    onNativeWaveTrackUpdate = (track) => {
        onNativeProgress?.(track);
        if (!waveVisible) {
            if (getTrack().url && getTrack().url !== track.url) {
                const old = getTrack();
                const fraction = waveListening.fraction(old.url || '', parseTime(old.duration));
                waveRecommender.record(
                    { url: old.url!, title: old.title, artist: old.author, sourceRank: 0 },
                    fraction >= 0.9 ? 'complete' : fraction < 0.2 ? 'skip' : 'play',
                    fraction,
                );
            }
            if (
                track.url &&
                waveRecommender.liked(track.url) !== track.isLiked &&
                (track.isLiked || getTrack().url === track.url)
            )
                waveRecommender.record(
                    { url: track.url, title: track.title, artist: track.author, sourceRank: 0 },
                    track.isLiked ? 'like' : 'unlike',
                );
            return;
        }
        sendInline('track', track);
        if (!track.url) return;
        if (track.url !== getTrack().url) {
            traceWave(
                track.url === waveCurrent ? 'expected-track' : 'unexpected-track',
                waveCurrent,
                track.url,
                waveNextTask ? 'transition-in-progress' : 'no-transition',
            );
        }
        if (
            waveCurrentCandidate &&
            track.url === waveCurrent &&
            getTrack().url === track.url &&
            getTrack().isLiked !== track.isLiked
        ) {
            waveKnownLikes.set(track.url, track.isLiked);
            waveRecommender.record(waveCurrentCandidate, track.isLiked ? 'like' : 'unlike');
            sendLikeState(track.url);
            void prepareUpcoming().catch((error) => console.debug('Wave reaction preparation unavailable:', error));
        }
        if (track.url === waveCurrent) {
            if (getTrack().url !== track.url)
                void disableStationAutoplay().catch((error) =>
                    console.debug('Wave station autoplay refresh unavailable:', error),
                );
            if (!nativeQueueAvailable || (!nativeQueued.length && !nativeQueueTask)) {
                const duration = parseTime(track.duration);
                const elapsed = parseTime(track.elapsed);
                waveReachedEnd = duration > 0 && elapsed >= duration - 1;
                return;
            }
            return;
        }
        if ((!nativeQueueAvailable || !nativeQueued.length) && waveCurrentCandidate) {
            const duration = parseTime(getTrack().duration);
            const elapsed = parseTime(getTrack().elapsed);
            void playback
                .request(waveReachedEnd || (duration > 0 && elapsed >= duration - 2) ? 'finish' : 'user')
                .catch((error) => console.debug('Wave transition unavailable:', error));
            return;
        }
        if (waveCurrentCandidate) {
            const duration = parseTime(getTrack().duration);
            const elapsed = parseTime(getTrack().elapsed);
            recordCurrent(duration > 0 && elapsed / duration >= 0.9 ? 'complete' : 'skip');
            waveHistory.push(waveCurrentCandidate);
            if (waveHistory.length > 100) waveHistory.shift();
        }
        waveCurrent = track.url;
        waveCurrentCandidate = nativeQueued.find((item) => item.url === track.url) || null;
        waveRecommender.setAnchor(waveCurrentCandidate || undefined);
        waveCurrentRecorded = false;
        audioSamples = 0;
        audioTotals.energy = 0;
        audioTotals.bass = 0;
        audioTotals.brightness = 0;
        const index = nativeQueued.findIndex((item) => item.url === track.url);
        if (index >= 0) nativeQueued.splice(0, index + 1);
        sendInline('queue-ready', nativeQueueAvailable && nativeQueued.length > 0);
        if (waveCurrentCandidate) {
            waveRecommender.reserve(waveCurrentCandidate, true);
            sendInline('candidate', waveCurrentCandidate);
            sendLikeState(waveCurrentCandidate.url);
        }
        void fillNativeQueue().catch((error) =>
            sendInline(
                'state',
                'error',
                error instanceof Error ? error.message : 'Не удалось пополнить очередь SoundCloud.',
            ),
        );
    };
    const showWave = () => {
        if (waveVisible) return;
        waveVisible = true;
        waveGeneration++;
        sendInline('active', true);
    };
    const hideWave = () => {
        if (!waveVisible) return;
        endedRecovery.cancel();
        sendInline('queue-ready', false);
        waveVisible = false;
        playback.invalidate();
        waveReachedEnd = false;
        waveGeneration++;
        waveQueueEpoch++;
        discoveryPage.release();
        recordCurrent('play');
        waveRecommender.clearCandidates();
        waveRecommender.setAnchor(undefined);
        waveFuture.length = 0;
        wavePrepared.clear();
        if (!likeTask) releaseLikePage();
        sendInline('active', false);
        void resetNativeQueue().catch((error) => console.debug('Wave queue reset unavailable:', error));
        void restoreStationAutoplay().catch((error) =>
            console.debug('Wave station autoplay restore unavailable:', error),
        );
    };
    const startWave = async (): Promise<'playing' | 'open'> => {
        showWave();
        if (waveStarting) return 'open';
        const generation = waveGeneration;
        waveStarting = true;
        sendInline('state', 'loading');
        try {
            if (getTrack().url)
                waveRecommender.setAnchor({
                    url: getTrack().url,
                    title: getTrack().title,
                    artist: getTrack().author,
                    sourceRank: 0,
                });
            if (!getTrack().isPlaying || !getTrack().url) {
                if (
                    !waveRecommender
                        .rank(20)
                        .some((candidate) => waveControls.discovery === 'favorites' || candidate.source === 'related')
                )
                    await loadWaveTaste();
                if (
                    waveControls.discovery !== 'favorites' &&
                    !waveRecommender.rank(20).some((candidate) => candidate.source === 'related')
                )
                    await waveRecommender.refresh();
                await playback.request('start');
            } else {
                waveCurrent = getTrack().url;
                waveCurrentCandidate = {
                    url: waveCurrent,
                    title: getTrack().title,
                    artist: getTrack().author,
                    sourceRank: 0,
                    durationSeconds: parseTime(getTrack().duration),
                };
                waveRecommender.setAnchor(waveCurrentCandidate);
                waveCurrentRecorded = false;
                waveRecommender.reserve(waveCurrentCandidate, true);
                sendInline('candidate', waveCurrentCandidate);
                waveReachedEnd = false;
                sendInline('track', getTrack());
            }
            if (generation !== waveGeneration || !waveVisible) return 'open';
            void disableStationAutoplay()
                .catch((error) => console.debug('Wave station autoplay unavailable:', error))
                .then(fillNativeQueue)
                .catch((error) =>
                    sendInline(
                        'state',
                        'error',
                        error instanceof Error ? error.message : 'Не удалось пополнить очередь SoundCloud.',
                    ),
                );
            void loadWaveTaste();
            sendInline('state', 'playing');
            windowTasks.defer(() => {
                if (waveVisible && generation === waveGeneration)
                    void prepareUpcoming().catch((error) => console.debug('Wave buffer warmup unavailable:', error));
            }, 0);
            return 'playing';
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Не удалось запустить Мою волну.';
            hideWave();
            sendInline('state', 'error', message);
            throw error;
        } finally {
            waveStarting = false;
        }
    };
    const waveDiagnostics = () => ({
        version: app.getVersion(),
        active: waveVisible,
        current: trackPath(waveCurrent),
        observed: {
            path: trackPath(getTrack().url || ''),
            elapsed: getTrack().elapsed,
            duration: getTrack().duration,
            playing: getTrack().isPlaying,
        },
        source: 'related-tracks',
        events: events(),
        import: importDiagnostics(),
        controls: { ...waveControls },
        discovery: relatedDiscovery.diagnostics(),
        scheduler: scheduler.diagnostics(),
        discoveryPage: discoveryPage.diagnostics(),
        recommendation: waveRecommender.diagnostics(),
        prepared: wavePrepared.length,
        upcoming: waveFuture.map((item) => item.url),
        nativeQueued: nativeQueued.map((item) => item.url),
        choosing: Boolean(waveNextTask),
        transitionPending: playback.pending,
        nativeQueueAvailable,
        rendererQueueReady: endCaptureQueueReady,
        filling: Boolean(nativeQueueTask),
    });
    windowIpc.handle('wave-inline:copy-diagnostics', async (event) => {
        if (!isTrustedSoundCloudSender(event)) throw new Error('Недоверенная страница.');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let renderer: unknown;
        try {
            renderer = await Promise.race([
                clientContents
                    .executeJavaScript(
                        `({
                    monitorActive: Boolean(window.__soundCloudMonitorActive),
                    monitorDisposed: Boolean(window.__soundCloudMonitorDisposed),
                    capture: window.__waveMediaEndSnapshot?.(),
                    mediaState: window.__waveMediaEndState
                })`,
                        true,
                    )
                    .catch(() => ({ unavailable: true })),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve({ unavailable: true }), 1000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        clipboard.writeText(JSON.stringify({ ...waveDiagnostics(), renderer }, null, 2));
        return true;
    });
    windowIpc.handle('wave-inline:ready', (event) => {
        if (!isTrustedSoundCloudSender(event)) return null;
        return {
            active: waveVisible,
            interfaceLanguage: store.get('waveInterfaceLanguage', 'auto'),
            controls: waveControls,
            excludedArtists: waveRecommender.getExcludedArtists(),
            track: waveVisible ? getTrack() : null,
            stats: waveRecommender.stats(),
            candidate: waveCurrentCandidate,
            diagnostics: waveDiagnostics(),
            queueReady: nativeQueueAvailable && nativeQueued.length > 0,
            like: waveCurrentCandidate ? likeState(waveCurrentCandidate.url) : null,
        };
    });
    windowIpc.handle('wave-inline:set-language', (event, language: unknown) => {
        if (!isTrustedSoundCloudSender(event) || !['auto', 'ru', 'en'].includes(String(language)))
            throw new Error('Invalid interface language');
        store.set('waveInterfaceLanguage', language);
        languageChanged();
        sendInline('interface-language', language);
        return language;
    });
    windowIpc.handle('wave-inline:like', async (event, url: unknown, desired: unknown) => {
        if (
            !isTrustedSoundCloudSender(event) ||
            !waveVisible ||
            !waveCurrentCandidate ||
            typeof url !== 'string' ||
            url !== waveCurrentCandidate.url ||
            typeof desired !== 'boolean'
        )
            throw new Error('Недоступное действие с лайком.');
        const candidate = waveCurrentCandidate;
        const previous = likeTask;
        const task = (async () => {
            if (previous) {
                try {
                    await previous;
                } catch {}
            }
            if (!waveVisible || waveCurrent !== candidate.url) throw new Error('Трек уже сменился.');
            return setTrackLiked(getLikeView(), candidate.url, desired, candidate.title);
        })();
        likeTask = task;
        try {
            const liked = await task;
            waveKnownLikes.set(candidate.url, liked);
            waveRecommender.record(candidate, liked ? 'like' : 'unlike');
            if (waveCurrent === candidate.url && waveVisible) {
                if (getTrack().url === candidate.url) setTrack({ ...getTrack(), isLiked: liked });
                sendLikeState(candidate.url);
                if (getTrack().url === candidate.url) sendInline('track', getTrack());
                sendInline('stats', waveRecommender.stats());
                void prepareUpcoming().catch((error) => console.debug('Wave reaction preparation unavailable:', error));
            }
            return { url: candidate.url, liked };
        } finally {
            if (likeTask === task) {
                likeTask = null;
                releaseLikePage();
            }
        }
    });
    windowIpc.handle('wave-inline:start', async (event) => {
        if (!isTrustedSoundCloudSender(event)) throw new Error('Недоверенный вызов волны.');
        return startWave();
    });
    windowIpc.handle('wave-inline:exclude-artist', async (event, artist: unknown, excluded: unknown) => {
        if (
            !isTrustedSoundCloudSender(event) ||
            typeof artist !== 'string' ||
            !artist.trim() ||
            artist.length > 200 ||
            typeof excluded !== 'boolean' ||
            (excluded && (!waveVisible || waveCurrentCandidate?.artist !== artist)) ||
            (!excluded && !waveRecommender.getExcludedArtists().includes(artist))
        )
            throw new Error('Исполнитель недоступен.');
        waveRecommender.excludeArtist(artist, excluded);
        if (excluded && nativeQueued.some((item) => item.artist.trim().toLowerCase() === artist.trim().toLowerCase())) {
            waveGeneration++;
            playback.invalidate();
            void resetNativeQueue()
                .then(prepareUpcoming)
                .then(fillNativeQueue)
                .catch((error) => console.debug('Wave artist queue refresh unavailable:', error));
        }
        waveQueueEpoch++;
        for (const candidate of waveFuture) waveRecommender.release(candidate);
        waveFuture.length = 0;
        wavePrepared.clear();
        sendInline('excluded-artists', waveRecommender.getExcludedArtists());
        if (excluded && waveVisible && waveCurrentCandidate?.artist === artist) await playback.request('user');
        return waveRecommender.getExcludedArtists();
    });
    windowIpc.handle('wave-inline:dislike', async (event, url: unknown) => {
        if (
            !isTrustedSoundCloudSender(event) ||
            !waveVisible ||
            typeof url !== 'string' ||
            url !== waveCurrent ||
            waveCurrentCandidate?.url !== url
        )
            throw new Error('Трек уже сменился.');
        waveRecommender.record(waveCurrentCandidate, 'dislike');
        traceWave('feedback-dislike', waveCurrent);
        waveQueueEpoch++;
        waveGeneration++;
        playback.invalidate();
        for (const candidate of waveFuture) waveRecommender.release(candidate);
        waveFuture.length = 0;
        wavePrepared.clear();
        await resetNativeQueue();
        await playback.request('user');
    });
    windowIpc.on('wave-inline:control', (event, command: unknown, value: unknown) => {
        if (!isTrustedSoundCloudSender(event) || typeof command !== 'string') return;
        if (!waveVisible && command !== 'stop') return;
        if (command === 'stop') {
            hideWave();
            return;
        }
        if (command === 'prepare') {
            void fillNativeQueue().catch((error) => console.debug('Wave preparation unavailable:', error));
            return;
        }
        if (command === 'next' || command === 'native-next') {
            if (command === 'native-next' && typeof value === 'string' && value !== trackPath(waveCurrent)) return;
            endedRecovery.cancel();
            void playback
                .request(command === 'next' ? 'user' : 'native-user')
                .catch((error) => console.debug('Wave next unavailable:', error));
            return;
        }
        if (command === 'finish' || command === 'error') {
            if (typeof value === 'string' && value && value !== trackPath(waveCurrent)) {
                traceWave('stale-media-event', waveCurrent, `https://soundcloud.com${value}`, command);
                return;
            }
            traceWave(command === 'finish' ? 'media-ended-captured' : 'media-error-captured', waveCurrent);
            if (command === 'finish') void endedRecovery.request();
            else void playback.request(command).catch((error) => console.debug('Wave finish unavailable:', error));
            return;
        }
        if (command === 'shuffle' && typeof value === 'boolean') {
            waveShuffle = value;
            return;
        }
    });
    windowIpc.on('wave-inline:controls', (event, input: unknown) => {
        if (isTrustedSoundCloudSender(event) && input && typeof input === 'object')
            setControls(input as Partial<WaveControls>);
    });
    let lastInlineAudioAt = 0;
    windowIpc.on('wave-inline:audio', (event, input: unknown) => {
        if (
            !isTrustedSoundCloudSender(event) ||
            !waveVisible ||
            !waveCurrentCandidate ||
            !input ||
            typeof input !== 'object'
        )
            return;
        const features = input as AudioFeatures & { path?: string; source?: string; sampleSeconds?: number };
        if (
            features.path !== trackPath(waveCurrent) ||
            features.source !== 'media-element-v1' ||
            typeof features.sampleSeconds !== 'number' ||
            features.sampleSeconds < 0 ||
            features.sampleSeconds > 93 ||
            !['energy', 'bass', 'mid', 'treble'].every((key) => {
                const value = features[key as keyof AudioFeatures];
                return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
            })
        )
            return;
        const now = Date.now();
        if (now - lastInlineAudioAt < 750) return;
        lastInlineAudioAt = now;
        if (audioSamples < 90) {
            audioTotals.energy += features.energy;
            audioTotals.bass += features.bass;
            audioTotals.brightness += features.treble;
            audioSamples++;
        }
    });

    const onBeforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
        if (!waveVisible || input.type !== 'keyDown' || input.key !== 'MediaNextTrack') return;
        event.preventDefault();
        onWaveNextRequest?.();
    };
    clientContents.on('before-input-event', onBeforeInputEvent);
    clientContents.once('destroyed', stop);
    return {
        get active() {
            return waveVisible;
        },
        onProgress(track: TrackInfo) {
            if (windowWorkStopped) return;
            waveListening.observe(track.url || '', parseTime(track.elapsed), track.isPlaying);
            onNativeProgress?.(track);
        },
        onTrack(track: TrackInfo) {
            if (windowWorkStopped) return;
            waveListening.observe(track.url || '', parseTime(track.elapsed), track.isPlaying);
            onNativeWaveTrackUpdate?.(track);
        },
        next() {
            if (!waveVisible) return false;
            onWaveNextRequest?.();
            return true;
        },
        routeChanged() {
            sendInline('route');
        },
        stop,
    };
}
