import { saveImportSelection } from './saveSelection';
import { PlaylistSourceReader } from './sourceReader';
import { loadLocalPlaylist } from './localSource';
import { findSoundCloudMatch, type ImportMatch } from './match';
import { cancelImportOperation, automaticImportConcurrency, mapImportTracks } from './parallel';
import { ImportJournal, type ImportJob } from './importJournal';
import { TaskPool } from './taskPool';
import { createSoundCloudPlaylist, addSoundCloudPlaylistTrack, PlaylistWriteError } from './nativePlaylist';
import type { SourcePlaylist } from './source';
import { PlaylistSourceNetwork } from './sourceNetwork';
import { PublicSoundCloudSearch } from './publicSearch';
import { matchIdentity } from './matchIdentity';
import {
    WebContentsView,
    session,
    dialog,
    ipcMain,
    type WebContents,
    type BrowserWindow,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
} from 'electron';
import { availableParallelism, freemem } from 'node:os';
import { IpcRegistry } from '../utils/ipcRegistry';
import type { DataStore } from '../storage/asyncDataStore';
import type { ConnectionRecovery } from '../network/connectionRecovery';
import { createAvailabilityChecker, cacheTrackAvailability } from './availability';
export function createPlaylistImportController(options: {
    window: BrowserWindow;
    contents: WebContents;
    libraryStore: DataStore;
    account: string;
    userAgent: string;
    trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
    playing: () => boolean;
    connection: () => ConnectionRecovery;
    russian: () => boolean;
    availabilityRoute: () => string;
    trace: (event: string, current?: string, observed?: string, detail?: string) => void;
}) {
    const {
        window: mainWindow,
        contents: clientContents,
        libraryStore,
        account: currentAccountId,
        userAgent: globalUserAgent,
        trusted: isTrustedSoundCloudSender,
        playing,
        connection,
        russian,
        availabilityRoute,
        trace: traceWave,
    } = options;
    const clientWindow = mainWindow;
    const windowIpc = new IpcRegistry(ipcMain, isTrustedSoundCloudSender);
    let disposed = false;
    let importView: WebContentsView | null = null;
    const importJournal = new ImportJournal(libraryStore, currentAccountId);
    const sourceSession = session.fromPartition('wave-playlist-direct');
    const sourceNetwork = new PlaylistSourceNetwork(
        sourceSession.fetch.bind(sourceSession) as typeof fetch,
        Date.now,
        clientContents.session.fetch.bind(clientContents.session) as typeof fetch,
    );
    let importDraft: ImportJob | null = importJournal.current() || null;
    const importDomPool = new TaskPool(() => (freemem() < 2 * 1024 ** 3 || playing() ? 2 : 3));
    let importTask: Promise<unknown> | null = null;
    let importScanController: AbortController | null = null;
    let importCommitController: AbortController | null = null;
    let importFileDialogOpen = false;
    const importSearchViews = new Set<WebContentsView>();
    const closeImportView = (view: WebContentsView) => {
        const contents = view.webContents;
        if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
        importSearchViews.delete(view);
    };
    const createImportView = (search = false) => {
        const view = new WebContentsView({
            webPreferences: {
                session: clientContents.session,
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                backgroundThrottling: false,
                images: !search,
                spellcheck: false,
            },
        });
        view.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
        view.webContents.setUserAgent(globalUserAgent);
        view.webContents.setAudioMuted(true);
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        if (search)
            view.webContents.on('did-navigate', (_event, _url, status) => {
                if (status === 429) importDomPool.backoff();
            });
        return view;
    };
    const getImportView = () => {
        if (disposed || mainWindow.isDestroyed() || clientContents.isDestroyed())
            throw new Error('Окно импорта закрыто.');
        if (!importView?.webContents || importView.webContents.isDestroyed()) importView = createImportView();
        return importView.webContents;
    };
    const importProgress = (
        phase: string,
        completed: number,
        total: number,
        detail = '',
        update: Record<string, unknown> = {},
    ) => {
        if (completed === 0 || completed === total || phase === 'error' || completed % 25 === 0)
            traceWave('import-' + phase, undefined, undefined, `${completed}/${total} ${detail}`.slice(0, 300));
        if (!clientContents.isDestroyed())
            clientContents.send('playlist-import:progress', { phase, completed, total, detail, ...update });
    };
    const scanPlaylist = async (load: (signal: AbortSignal) => Promise<SourcePlaylist>) => {
        if (disposed) throw new Error('Окно импорта закрыто.');
        if (importTask) throw new Error('Предыдущий импорт ещё выполняется.');
        const controller = new AbortController();
        importScanController = controller;
        const slots = new Map<number, WebContentsView>();
        const task = (async () => {
            importProgress('source', 0, 0, 'Читаем плейлист…');
            await sourceSession.setProxy({ mode: 'system' });
            controller.signal.throwIfAborted();
            const source = await load(controller.signal);
            controller.signal.throwIfAborted();
            const concurrency = automaticImportConcurrency(availableParallelism(), freemem(), source.tracks.length);
            const importRoute = availabilityRoute();
            const availability = createAvailabilityChecker(clientContents.session, controller.signal, importRoute);
            importProgress('matching', 0, source.tracks.length, 'Ищем совпадения…', {
                title: source.title,
                tracks: source.tracks,
                partial: source.partial,
                partialReason: source.partialReason,
                expectedTracks: source.expectedTracks,
                concurrency,
            });
            const job = importJournal.begin(source);
            const partialMatches = job.matches;
            importDraft = job;
            const search = new PublicSoundCloudSearch(
                clientContents.session.fetch.bind(clientContents.session) as typeof fetch,
                (track) =>
                    importDomPool.run(async (slot) => {
                        let view = slots.get(slot);
                        if (!view || view.webContents.isDestroyed()) {
                            view = createImportView(true);
                            slots.set(slot, view);
                            importSearchViews.add(view);
                        }
                        const currentView = view;
                        const deadline = new AbortController();
                        const signal = AbortSignal.any([controller.signal, deadline.signal]);
                        let timedOut = false;
                        const timer = setTimeout(() => {
                            timedOut = true;
                            deadline.abort();
                        }, 40000);
                        const closeOnAbort = () => closeImportView(currentView);
                        signal.addEventListener('abort', closeOnAbort, { once: true });
                        try {
                            return await cancelImportOperation(
                                findSoundCloudMatch(currentView.webContents, track, signal, availability),
                                signal,
                            );
                        } catch {
                            controller.signal.throwIfAborted();
                            closeImportView(currentView);
                            slots.delete(slot);
                            return {
                                source: track,
                                error: timedOut
                                    ? 'Поиск занял слишком долго. Повторите проверку.'
                                    : 'SoundCloud не ответил. Повторите проверку.',
                            };
                        } finally {
                            clearTimeout(timer);
                            signal.removeEventListener('abort', closeOnAbort);
                        }
                    }, controller.signal),
                controller.signal,
                () => concurrency,
            );
            const matches = await mapImportTracks(source.tracks, {
                concurrency,
                signal: controller.signal,
                run: async (track, index): Promise<ImportMatch> => {
                    const cached = partialMatches[index].soundcloud || importJournal.cached(track);
                    if (cached && matchIdentity(track, cached).score >= 0.78) {
                        const checked = await availability(cached.url);
                        if (checked.status === 'available') {
                            const identity = matchIdentity(track, cached);
                            return {
                                source: track,
                                soundcloud: {
                                    ...cached,
                                    score: identity.score,
                                    requiresReview: identity.requiresReview,
                                    reviewReason: identity.reviewReason,
                                    availability: checked,
                                },
                            };
                        }
                    }
                    return search.match(track);
                },
                onComplete: (match, index, completed) => {
                    if (match.soundcloud?.availability)
                        cacheTrackAvailability(
                            clientContents.session,
                            match.soundcloud.url,
                            importRoute,
                            match.soundcloud.availability,
                        );
                    partialMatches[index] = match;
                    importJournal.remember(match);
                    importJournal.save(job, true);
                    importProgress(
                        'matching',
                        completed,
                        source.tracks.length,
                        `${match.source.artist} — ${match.source.title}`,
                        { index, match },
                    );
                },
            });
            job.matches = matches;
            importDraft = job;
            importJournal.save(job);
            return {
                title: job.title || source.title,
                platform: source.platform,
                partial: source.partial,
                partialReason: source.partialReason,
                expectedTracks: source.expectedTracks,
                matches,
                selectedIndexes: job.selected,
                savedUrls: job.savedUrls,
                writtenTitle: job.writtenTitle,
            };
        })();
        importTask = task;
        try {
            return await task;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('Поиск отменён.');
            throw error;
        } finally {
            importJournal.flush();
            controller.abort();
            for (const view of slots.values()) closeImportView(view);
            if (importScanController === controller) importScanController = null;
            if (importTask === task) importTask = null;
        }
    };
    windowIpc.handle('playlist-import:draft', () => importDraft);
    windowIpc.handle('playlist-import:resume', () => {
        if (!importDraft) throw new Error('Нет сохранённого импорта.');
        const source = importDraft.source;
        return scanPlaylist(async () => source);
    });
    windowIpc.on('playlist-import:selection', (_event, input: unknown) => {
        if (!importDraft || !input || typeof input !== 'object') return;
        const value = input as { indexes?: unknown; title?: unknown };
        if (
            !Array.isArray(value.indexes) ||
            value.indexes.length > 500 ||
            typeof value.title !== 'string' ||
            value.title.length > 100
        )
            return;
        importDraft.selected = [
            ...new Set(
                value.indexes.filter(
                    (index): index is number =>
                        Number.isInteger(index) && index >= 0 && index < importDraft!.matches.length,
                ),
            ),
        ];
        importDraft.title = value.title;
        importJournal.save(importDraft);
    });
    windowIpc.handle('playlist-import:scan', (event, link: unknown) => {
        if (!isTrustedSoundCloudSender(event) || typeof link !== 'string' || link.length > 1000)
            throw new Error('Недопустимая ссылка на плейлист.');
        return scanPlaylist((signal) =>
            new PlaylistSourceReader({
                parent: clientWindow,
                account: String(currentAccountId),
                connection: connection(),
                network: sourceNetwork,
                relayFirst: () => connection().prefersPlaylistRelay(),
                russian: () => russian(),
                progress: (read, total, message) => importProgress('source', read, total, message),
            }).read(link, signal),
        );
    });
    windowIpc.handle('playlist-import:scan-file', async (event) => {
        if (!isTrustedSoundCloudSender(event)) throw new Error('Недоверенная страница импорта.');
        if (importTask || importFileDialogOpen) throw new Error('Предыдущий импорт ещё выполняется.');
        importFileDialogOpen = true;
        try {
            const selected = await dialog.showOpenDialog(mainWindow, {
                properties: ['openFile'],
                filters: [{ name: 'Playlist CSV / TXT', extensions: ['csv', 'txt', 'tsv'] }],
            });
            if (
                selected.canceled ||
                !selected.filePaths.length ||
                mainWindow.isDestroyed() ||
                clientContents.isDestroyed()
            )
                return { cancelled: true };
            return await scanPlaylist((signal) => loadLocalPlaylist(selected.filePaths[0], signal));
        } finally {
            importFileDialogOpen = false;
        }
    });
    windowIpc.handle('playlist-import:commit', async (event, selection: unknown) => {
        const input = selection as {
            indexes?: unknown;
            title?: unknown;
        } | null;
        if (
            !isTrustedSoundCloudSender(event) ||
            !importDraft ||
            importTask ||
            !Array.isArray(input?.indexes) ||
            typeof input?.title !== 'string' ||
            !input.title.trim() ||
            input.title.length > 100
        )
            throw new Error('Сначала проверьте найденные треки.');
        const draft = importDraft;
        const selected = input.indexes;
        const indexes = [
            ...new Set(
                selected.filter(
                    (item): item is number => Number.isInteger(item) && item >= 0 && item < draft.matches.length,
                ),
            ),
        ].sort((a, b) => a - b);
        if (indexes.length !== selected.length || indexes.length < 1)
            throw new Error('Выберите хотя бы один найденный трек.');
        const selectedMatches = indexes.map((index) => draft.matches[index]);
        const seenUrls = new Set<string>();
        const chosen = selectedMatches.filter((item) => {
            if (!item.soundcloud) return false;
            const url = item.soundcloud.url;
            if (seenUrls.has(url)) return false;
            seenUrls.add(url);
            return true;
        });
        draft.selected = indexes;
        draft.title = input.title.trim();
        importJournal.save(draft);
        const playlistTitle = input.title.trim();
        const controller = new AbortController();
        importCommitController = controller;
        const task = (async () => {
            const title = playlistTitle;
            const availability = createAvailabilityChecker(
                clientContents.session,
                controller.signal,
                availabilityRoute(),
            );
            const result = await saveImportSelection(chosen, {
                saved: (item) => {
                    if (draft.writtenTitle !== title) draft.savedUrls = [];
                    draft.writtenTitle = title;
                    draft.savedUrls = [...new Set([...(draft.savedUrls || []), item.soundcloud!.url])];
                    importJournal.save(draft);
                },
                check: availability,
                stopOnError: (error) => error instanceof PlaylistWriteError && error.fatal,
                concurrency: automaticImportConcurrency(availableParallelism(), freemem(), chosen.length),
                signal: controller.signal,
                create: (item) =>
                    createSoundCloudPlaylist(
                        getImportView(),
                        title,
                        item.soundcloud!.url,
                        item.soundcloud!.sourceQuery,
                    ),
                add: (item) =>
                    addSoundCloudPlaylistTrack(
                        getImportView(),
                        title,
                        item.soundcloud!.url,
                        item.soundcloud!.sourceQuery,
                    ),
                progress: (phase, completed, total, detail) => importProgress(phase, completed, total, detail || title),
            });
            draft.savedUrls = [
                ...new Set([...(draft.savedUrls || []), ...result.successful.map((item) => item.soundcloud!.url)]),
            ];
            importJournal.save(draft);
            const failures = result.failures;
            if (!result.successful.length)
                throw new Error(
                    'SoundCloud не подтвердил добавление ни одного трека. Найденные совпадения сохранены — можно повторить добавление. ' +
                        (failures[0]?.reason || ''),
                );
            importProgress('done', chosen.length, chosen.length, title);
            return {
                title,
                added: result.added,
                already: result.already,
                successfulUrls: result.successful.map((item) => item.soundcloud!.url),
                unmatched: draft.matches.filter((item) => !item.soundcloud).length,
                duplicates: indexes.length - chosen.length,
                failures,
            };
        })();
        importTask = task;
        try {
            return await task;
        } finally {
            if (importCommitController === controller) importCommitController = null;
            if (importView) {
                closeImportView(importView);
                importView = null;
            }
            if (importTask === task) importTask = null;
        }
    });
    windowIpc.on('playlist-import:cancel', (event) => {
        if (isTrustedSoundCloudSender(event) && importScanController) {
            importScanController.abort();
            for (const view of importSearchViews) closeImportView(view);
        }
    });

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clientContents.removeListener('destroyed', dispose);
        windowIpc.dispose();
        importScanController?.abort();
        importCommitController?.abort();
        for (const view of importSearchViews) closeImportView(view);
        if (importView) closeImportView(importView);
        importView = null;
        importJournal.dispose();
    };
    clientContents.once('destroyed', dispose);
    return {
        diagnostics() {
            return importDraft
                ? {
                      source: importDraft.source.platform,
                      total: importDraft.matches.length,
                      matched: importDraft.matches.filter((match) => match.soundcloud).length,
                      updatedAt: importDraft.updatedAt,
                  }
                : undefined;
        },
        dispose,
    };
}
