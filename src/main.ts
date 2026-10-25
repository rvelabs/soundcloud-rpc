import { WorkerSetup } from './network/workerSetup';
import { ConnectionRecovery } from './network/connectionRecovery';
import { writePartialPlaylist } from './import/partialPlaylist';
import { installNativePageCover } from './wave/nativePageCover';
import {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    BrowserView,
    Tray,
    nativeImage,
    shell,
    components,
    safeStorage,
    clipboard,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
} from 'electron';
import { ElectronBlocker, fullLists } from '@ghostery/adblocker-electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import fetch from 'cross-fetch';
import { setupDarwinMenu } from './macos/menu';
import { NotificationManager } from './notifications/notificationManager';
import { SettingsManager } from './settings/settingsManager';
import { ProxyService } from './services/proxyService';
import { PresenceService } from './services/presenceService';
import { LastFmService } from './services/lastFmService';
import { TranslationService } from './services/translationService';
import { ThumbarService } from './services/thumbarService';
import { WebhookService } from './services/webhookService';
import { ThemeService } from './services/themeService';
import { ShortcutService } from './services/shortcutService';
import { PluginService } from './services/pluginService';
import { discoverRelatedCandidates, discoverPersonalHistory, extractWaveLinks } from './wave/nativeWave';
import { setTrackLiked } from './wave/nativeLike';
import {
    WaveEngine,
    defaultWaveControls,
    parseTime,
    type AudioFeatures,
    type WaveCandidate,
    type WaveControls,
} from './wave/waveEngine';
import { SoundCloudRecommender } from './wave/recommendation/soundcloudAdapter';
import { RelatedDiscovery } from './wave/relatedDiscovery';
import { ListeningEvidence } from './wave/listeningEvidence';
import { PreparedQueue } from './wave/preparedQueue';
import {
    addToNativeNextUp,
    listNativeNextUp,
    playInNativePlayer,
    trackPath,
    NativeTrackNotFoundError,
    NativeActionCanceledError,
} from './wave/nativeQueue';
import { enrichPublicTrack, setPublicMetadataFetch } from './wave/trackMetadata';
import { installWaveMediaEndCapture } from './wave/mediaEndCapture';
import { setStationAutoplay } from './wave/nativeAutoplay';
import { loadSourcePlaylist } from './import/loadSource';
import { findSoundCloudMatch, type ImportMatch } from './import/match';
import { cancelImportOperation, automaticImportConcurrency, mapImportTracks } from './import/parallel';
import { createAvailabilityChecker } from './import/availability';
import { availableParallelism, freemem } from 'node:os';
import { createSoundCloudPlaylist, addSoundCloudPlaylistTrack } from './import/nativePlaylist';
import type { SourcePlaylist } from './import/source';
import type { SoundFeatures } from './wave/recommendation/types';
import { audioMonitorScript } from './services/audioMonitorService';
import { showHomepageConfirmDialog, updateDialogBounds } from './settings/confirmPopup';
import type { TrackInfo } from './types';
import { validateTrackUpdatePayload } from './validation';
import path from 'path';
import type { EventEmitter } from 'node:events';
import { platform } from 'os';
const Store = require('electron-store');
import { autoUpdater } from 'electron-updater';
import windowStateManager from 'electron-window-state';
export const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../assets');
console.log(`Resources path: ${RESOURCES_PATH}`);
const userDataPath = app.getPath('userData');
app.setName('SoundCloud');
app.setPath('userData', userDataPath);
if (process.platform === 'win32') app.setAppUserModelId('dev.codex.soundcloud-wave');
const store = new Store({
    defaults: {
        adBlocker: false,
        proxyEnabled: false,
        proxyHost: '',
        proxyPort: '',
        proxyData: { user: '', password: '' },
        lastFmEnabled: false,
        lastFmApiKey: '',
        lastFmSecret: '',
        lastFmSessionKey: '',
        webhookEnabled: false,
        webhookUrl: '',
        webhookTriggerPercentage: 50,
        displayWhenIdling: false,
        displaySCSmallIcon: false,
        discordRichPresence: true,
        displayButtons: false,
        statusDisplayType: 1,
        theme: 'dark',
        minimizeToTray: false,
        navigationControlsEnabled: false,
        trackParserEnabled: true,
        richPresencePreviewEnabled: false,
        autoUpdaterEnabled: false,
        hidePromotions: true,
        hideEventsNearYou: true,
        hideArtistUpsells: true,
        accounts: [{ id: 'default', name: 'Main Account' }],
        currentAccountId: 'default',
    },
    clearInvalidConfig: true,
    encryptionKey: 'soundcloud-rpc-config',
});
let isDarkTheme = store.get('theme') !== 'light';
let mainWindow: BrowserWindow;
let notificationManager: NotificationManager;
let settingsManager: SettingsManager;
let proxyService: ProxyService;
let presenceService: PresenceService;
let lastFmService: LastFmService;
let webhookService: WebhookService;
let translationService: TranslationService;
let thumbarService: ThumbarService;
let themeService: ThemeService;
let shortcutService: ShortcutService;
let pluginService: PluginService;
let waveStarting = false;
let waveEngine: WaveEngine;
const waveHomeView = null as BrowserView | null;
let waveDiscoveryView: BrowserView | null = null;
let waveVisible = false;
let onNativeWaveTrackUpdate: ((track: TrackInfo) => void) | null = null;
const waveListening = new ListeningEvidence();
let onWaveNextRequest: (() => void) | null = null;
const waveTrace: {
    at: number;
    event: string;
    current?: string;
    observed?: string;
    detail?: string;
}[] = [];
function traceWave(event: string, current?: string, observed?: string, detail?: string): void {
    waveTrace.push({
        at: Date.now(),
        event,
        current: current ? trackPath(current) || undefined : undefined,
        observed: observed ? trackPath(observed) || undefined : undefined,
        detail,
    });
    if (waveTrace.length > 80) waveTrace.shift();
    if (
        ![
            'expected-track',
            'unexpected-track',
            'candidate-playing',
            'candidate-failed',
            'queue-confirmed',
            'queue-failed',
            'queue-occupied',
            'queue-candidate-missing',
            'queue-search-fallback',
            'media-ended-captured',
        ].includes(event)
    )
        return;
    try {
        writeFileSync(
            path.join(app.getPath('userData'), 'wave-diagnostics.json'),
            JSON.stringify({ capturedAt: new Date().toISOString(), events: waveTrace }, null, 2),
        );
    } catch (error) {
        console.debug('Wave diagnostic write unavailable:', error);
    }
}
let tray: Tray | null = null;
let isQuitting = false;
let memoryPressureHandlerRegistered = false;
const devMode = process.argv.includes('--dev');
const isMac = process.platform === 'darwin';
const globalUserAgent = isMac
    ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
    : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = globalUserAgent;
function applyMacMemoryOptimizations(): void {
    if (!isMac) return;
    const existingDisableFeatures = app.commandLine.getSwitchValue('disable-features');
    const features = new Set(
        existingDisableFeatures
            .split(',')
            .map((feature) => feature.trim())
            .filter(Boolean),
    );
    features.add('BackForwardCache');
    app.commandLine.appendSwitch('disable-features', Array.from(features).join(','));
    app.commandLine.appendSwitch('renderer-process-limit', '1');
    app.commandLine.appendSwitch('disk-cache-size', '1');
    app.commandLine.appendSwitch('media-cache-size', '1');
    app.commandLine.appendSwitch('enable-low-end-device-mode');
}
applyMacMemoryOptimizations();
const HEADER_HEIGHT = 32;
const isMas = process.mas === true;
if (!isMas) {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
        app.quit();
        process.exit(0);
    }
}
Object.defineProperty(app, 'isQuitting', {
    value: false,
    writable: true,
    configurable: true,
});
let displayWhenIdling = store.get('displayWhenIdling') as boolean;
let displaySCSmallIcon = store.get('displaySCSmallIcon') as boolean;
function setupUpdater() {
    if (app.isPackaged) return;
    if (!store.get('autoUpdaterEnabled', true)) {
        console.log('Auto-updater disabled by user setting');
        return;
    }
    if (process.platform === 'linux' && !process.env.APPIMAGE) {
        console.log('Not running from AppImage, skipping auto-updater');
        return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', () => {
        queueToastNotification('Update Available');
    });
    autoUpdater.on('update-downloaded', () => {
        queueToastNotification('Update Completed');
    });
    autoUpdater.checkForUpdates();
}
function installDesktopFile() {
    if (process.platform !== 'linux' || !process.env.APPIMAGE) return;
    try {
        const dataHome = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
        const desktopFilePath = path.join(dataHome, 'applications', 'soundcloud-rpc.desktop');
        const iconFilePath = path.join(dataHome, 'icons', 'hicolor', '1024x1024', 'apps', 'soundcloud-rpc.png');
        if (!existsSync(iconFilePath)) {
            mkdirSync(path.dirname(iconFilePath), { recursive: true });
            copyFileSync(path.join(RESOURCES_PATH, 'icons', 'soundcloud.png'), iconFilePath);
        }
        const entry = [
            '[Desktop Entry]',
            'Name=SoundCloud',
            'Comment=SoundCloud client with Discord Rich Presence',
            `Exec="${process.env.APPIMAGE}" %U`,
            'Icon=soundcloud-rpc',
            'Type=Application',
            'Categories=AudioVideo;Audio;Music;',
            'StartupWMClass=soundcloud-rpc',
            'Terminal=false',
            '',
        ].join('\n');
        const existing = existsSync(desktopFilePath) ? readFileSync(desktopFilePath, 'utf8') : '';
        if (existing !== entry) {
            mkdirSync(path.dirname(desktopFilePath), { recursive: true });
            writeFileSync(desktopFilePath, entry);
            console.log(`Desktop file written to ${desktopFilePath}`);
        }
    } catch (error) {
        console.error('Failed to write desktop file:', error);
    }
}
function setupTray() {
    if (tray) {
        tray.destroy();
        tray = null;
    }
    const iconPath = path.join(
        RESOURCES_PATH,
        'icons',
        process.platform === 'win32' ? 'soundcloud-win.ico' : 'soundcloud.png',
    );
    const icon = nativeImage.createFromPath(iconPath);
    const trayIcon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    tray.setToolTip('SoundCloud RPC');
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'SoundCloud',
            click: () => {
                if (mainWindow) {
                    if (!mainWindow.isVisible()) mainWindow.show();
                    if (mainWindow.isMinimized()) mainWindow.restore();
                    mainWindow.focus();
                }
            },
        },
        {
            label: 'Settings',
            click: () => {
                if (settingsManager) {
                    settingsManager.toggle();
                }
            },
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.quit();
            },
        },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        if (mainWindow) {
            const isMinimized = mainWindow.isMinimized();
            const isVisible = mainWindow.isVisible();
            if (isMinimized) {
                mainWindow.restore();
            }
            if (!isVisible) {
                mainWindow.show();
            }
            mainWindow.focus();
            adjustContentViews();
        }
    });
}
async function getLanguage() {
    if (!contentView) return;
    const langInfo = await contentView.webContents.executeJavaScript(`
        const langEl = document.querySelector('html');
        new Promise(resolve => {
            resolve({
                lang: langEl ? langEl.getAttribute('lang') : 'en',
            });
        })
    `);
    translationService.setLanguage(langInfo.lang);
}
function createBrowserWindow(windowState: { width: number; height: number; x?: number; y?: number }): BrowserWindow {
    const window = new BrowserWindow({
        width: windowState.width,
        height: windowState.height,
        x: windowState.x,
        y: windowState.y,
        title: 'SoundCloud',
        icon: path.join(RESOURCES_PATH, 'icons', 'soundcloud.png'),
        frame: process.platform === 'darwin',
        titleBarStyle: process.platform === 'darwin' ? 'hidden' : undefined,
        trafficLightPosition: process.platform === 'darwin' ? { x: 10, y: 10 } : undefined,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            javascript: true,
            images: true,
            plugins: true,
            experimentalFeatures: false,
            devTools: devMode,
            backgroundThrottling: false,
            ...(isMac ? { spellcheck: false } : {}),
        },
        backgroundColor: isDarkTheme ? '#121212' : '#ffffff',
    });
    window.webContents.setUserAgent(globalUserAgent);
    return window;
}
let lastTrackInfo: TrackInfo = {
    title: '',
    author: '',
    artwork: '',
    elapsed: '',
    duration: '',
    isPlaying: false,
    isLiked: false,
    url: '',
};
function isTrustedSoundCloudSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    if (!contentView || event.sender.id !== contentView.webContents.id) return false;
    const frameUrl = event.senderFrame?.url || event.sender.getURL();
    try {
        const url = new URL(frameUrl);
        return (
            url.protocol === 'https:' && (url.hostname === 'soundcloud.com' || url.hostname.endsWith('.soundcloud.com'))
        );
    } catch {
        return false;
    }
}
function adjustContentViews() {
    if (!mainWindow || !contentView || !headerView) return;
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) return;
    const { width, height } = mainWindow.getContentBounds();
    headerView.setBounds({
        x: 0,
        y: 0,
        width,
        height: HEADER_HEIGHT,
    });
    contentView.setBounds({
        x: 0,
        y: HEADER_HEIGHT,
        width,
        height: height - HEADER_HEIGHT,
    });
    if (waveHomeView && waveVisible) {
        waveHomeView.setBounds({ x: 0, y: HEADER_HEIGHT, width: 1, height: 1 });
    }
    updateDialogBounds(mainWindow);
}
function setupWindowControls() {
    if (!mainWindow) return;
    ipcMain.on('minimize-window', () => {
        if (!mainWindow) return;
        const minimizeToTray = store.get('minimizeToTray', true);
        if (minimizeToTray) {
            mainWindow.hide();
        } else {
            mainWindow.minimize();
        }
    });
    ipcMain.on('maximize-window', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    });
    ipcMain.on('title-bar-double-click', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    });
    mainWindow.on('maximize', () => {
        adjustContentViews();
    });
    mainWindow.on('unmaximize', () => {
        adjustContentViews();
    });
    mainWindow.on('resize', () => {
        adjustContentViews();
    });
    ipcMain.on('close-window', () => {
        if (mainWindow) {
            const minimizeToTray = store.get('minimizeToTray', true);
            if (minimizeToTray) {
                mainWindow.hide();
            } else {
                mainWindow.close();
            }
        }
    });
    ipcMain.on('navigate-back', () => {
        if (contentView && contentView.webContents.navigationHistory.canGoBack()) {
            contentView.webContents.navigationHistory.goBack();
        }
    });
    ipcMain.on('navigate-forward', () => {
        if (contentView && contentView.webContents.navigationHistory.canGoForward()) {
            contentView.webContents.navigationHistory.goForward();
        }
    });
    ipcMain.on('refresh-page', () => {
        if (contentView) {
            if (headerView && headerView.webContents) {
                headerView.webContents.send('refresh-state-changed', true);
            }
            console.log('Manual refresh triggered - reloading page');
            contentView.webContents.reload();
        }
    });
    ipcMain.on('cancel-refresh', () => {
        if (contentView) {
            contentView.webContents.stop();
            if (headerView && headerView.webContents) {
                headerView.webContents.send('refresh-state-changed', false);
            }
        }
    });
    ipcMain.on('toggle-theme', () => {
        isDarkTheme = !isDarkTheme;
        if (headerView && headerView.webContents) {
            headerView.webContents.send('theme-changed', isDarkTheme);
        }
        applyThemeToContent(isDarkTheme);
    });
    ipcMain.handle('is-maximized', () => {
        return mainWindow ? mainWindow.isMaximized() : false;
    });
    ipcMain.handle('get-minimize-to-tray', () => {
        return store.get('minimizeToTray', true);
    });
    ipcMain.handle('get-navigation-controls-enabled', () => {
        return store.get('navigationControlsEnabled', false);
    });
    adjustContentViews();
}
let headerView: BrowserView | null;
let contentView: BrowserView;
async function init() {
    try {
        await components.whenReady();
        console.log('Components ready:', components.status());
    } catch (error) {
        console.error('Failed to initialize components:', error);
    }
    setupUpdater();
    installDesktopFile();
    setupTray();
    if (process.platform === 'darwin') setupDarwinMenu();
    else Menu.setApplicationMenu(null);
    const windowState = windowStateManager({ defaultWidth: 800, defaultHeight: 800 });
    mainWindow = createBrowserWindow(windowState);
    windowState.manage(mainWindow);
    mainWindow.on('close', (event) => {
        const minimizeToTray = store.get('minimizeToTray', true);
        if (minimizeToTray && !isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
    mainWindow.on('minimize', () => {
        const minimizeToTray = store.get('minimizeToTray', true);
        if (minimizeToTray) {
            mainWindow.hide();
        }
    });
    const updateWaveVisibility = () => {
        if (contentView && !contentView.webContents.isDestroyed()) {
            contentView.webContents.send(
                'wave-inline:visibility',
                mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused(),
            );
        }
        if (waveHomeView && !waveHomeView.webContents.isDestroyed()) {
            waveHomeView.webContents.send(
                'wave-home:visible',
                waveVisible && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused(),
            );
        }
    };
    mainWindow.on('focus', updateWaveVisibility);
    mainWindow.on('blur', updateWaveVisibility);
    mainWindow.on('minimize', updateWaveVisibility);
    mainWindow.on('restore', updateWaveVisibility);
    mainWindow.on('hide', updateWaveVisibility);
    mainWindow.on('show', updateWaveVisibility);
    headerView = new BrowserView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            preload: path.join(__dirname, 'header', 'headerPreload.js'),
            devTools: devMode,
            ...(isMac ? { spellcheck: false } : {}),
        },
    });
    mainWindow.addBrowserView(headerView);
    const notifyWindowState = () => {
        if (headerView && !headerView.webContents.isDestroyed())
            headerView.webContents.send('window-state-changed', mainWindow.isMaximized());
    };
    mainWindow.on('maximize', notifyWindowState);
    mainWindow.on('unmaximize', notifyWindowState);
    headerView.setBounds({ x: 0, y: 0, width: mainWindow.getBounds().width, height: 32 });
    headerView.setAutoResize({ width: true, height: false });
    headerView.webContents.loadFile(path.join(__dirname, 'header', 'header.html'));
    const currentAccountId = store.get('currentAccountId', 'default');
    const sessionPartition = currentAccountId === 'default' ? undefined : `persist:sc_${currentAccountId}`;
    contentView = new BrowserView({
        webPreferences: {
            ...(sessionPartition ? { partition: sessionPartition } : {}),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            devTools: devMode,
            preload: path.join(__dirname, 'preload.js'),
            ...(isMac ? { spellcheck: false } : {}),
        },
    });
    mainWindow.addBrowserView(contentView);
    contentView.setBounds({
        x: 0,
        y: 32,
        width: mainWindow.getBounds().width,
        height: mainWindow.getBounds().height - 32,
    });
    contentView.setAutoResize({ width: true, height: true });
    installNativePageCover(mainWindow, contentView);
    setPublicMetadataFetch((input, init) =>
        contentView.webContents.session.fetch(input instanceof URL ? input.href : input, {
            ...init,
            credentials: 'omit',
        }),
    );
    waveEngine = new WaveEngine(store);
    waveListening.reset();
    waveDiscoveryView = new BrowserView({
        webPreferences: {
            session: contentView.webContents.session,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            backgroundThrottling: false,
            images: false,
        },
    });
    waveDiscoveryView.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
    waveDiscoveryView.webContents.setUserAgent(globalUserAgent);
    waveDiscoveryView.webContents.setAudioMuted(true);
    waveDiscoveryView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contentView.webContents.setUserAgent(globalUserAgent);
    translationService = new TranslationService();
    themeService = new ThemeService(store);
    pluginService = new PluginService(store);
    pluginService.setContentView(contentView);
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
            const previous = await setStationAutoplay(contentView.webContents, false);
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
        const previous = await setStationAutoplay(contentView.webContents, true);
        if (previous === null) return;
        stationAutoplayPrevious = null;
        store.delete(stationAutoplayMarkerKey);
    };
    let nativeQueueAvailable = Date.now() - Number(store.get(nativeQueueFailureKey) || 0) > 60 * 60 * 1000;
    let nativeQueueTask: Promise<void> | null = null;
    let lastQueueInspection = 0;
    let waveShuffle = false;
    let waveLikeView: BrowserView | null = null;
    let importView: BrowserView | null = null;
    let importDraft: {
        source: SourcePlaylist;
        matches: ImportMatch[];
    } | null = null;
    let importTask: Promise<unknown> | null = null;
    let importScanController: AbortController | null = null;
    const importSearchViews = new Set<BrowserView>();
    const closeImportView = (view: BrowserView) => {
        if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
        importSearchViews.delete(view);
    };
    const createImportView = (search = false) => {
        const view = new BrowserView({
            webPreferences: {
                session: contentView.webContents.session,
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
        return view;
    };
    const getImportView = () => {
        if (!importView || importView.webContents.isDestroyed()) importView = createImportView();
        return importView.webContents;
    };
    mainWindow.once('closed', () => {
        importScanController?.abort();
        for (const view of importSearchViews) closeImportView(view);
        if (importView) closeImportView(importView);
    });
    const importProgress = (
        phase: string,
        completed: number,
        total: number,
        detail = '',
        update: Record<string, unknown> = {},
    ) => {
        if (!contentView.webContents.isDestroyed())
            contentView.webContents.send('playlist-import:progress', { phase, completed, total, detail, ...update });
    };
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
        if (
            contentView.webContents.isDestroyed() ||
            !contentView.webContents.getURL().startsWith('https://soundcloud.com/')
        )
            return;
        void contentView.webContents
            .executeJavaScript(
                `window.__waveMediaEndState = Object.assign(
            window.__waveMediaEndState || {}, { active: ${waveVisible}, queueReady: ${endCaptureQueueReady},
                ...(${!waveVisible || endCaptureQueueReady} ? { handoffPending: false, protectedUntil: 0 } : {}) });`,
                true,
            )
            .catch(() => {});
    };
    const sendInline = (channel: string, ...args: unknown[]) => {
        if (!contentView.webContents.isDestroyed()) contentView.webContents.send(`wave-inline:${channel}`, ...args);
        if (channel === 'active') syncMediaEndCapture();
        if (channel === 'queue-ready') {
            endCaptureQueueReady = args[0] === true;
            syncMediaEndCapture();
        }
    };
    const knownLike = (url: string) => waveKnownLikes.get(url) ?? waveEngine.liked(url);
    const likeState = (url: string) => ({ url, known: knownLike(url) !== undefined, liked: knownLike(url) === true });
    const sendLikeState = (url: string) => {
        sendInline('liked', likeState(url));
        waveHomeView?.webContents.send('wave-home:liked', url, knownLike(url) === true);
    };
    const getLikeView = () => {
        if (!waveLikeView || waveLikeView.webContents.isDestroyed()) {
            waveLikeView = new BrowserView({
                webPreferences: {
                    session: contentView.webContents.session,
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
        if (waveLikeView && !waveLikeView.webContents.isDestroyed())
            void waveLikeView.webContents.loadURL('about:blank').catch(() => {});
    };
    const relatedDiscovery = new RelatedDiscovery((url) =>
        discoverRelatedCandidates(waveDiscoveryView!.webContents, url),
    );
    const waveRecommender = new SoundCloudRecommender(store, currentAccountId, async (seeds) => {
        const generation = waveGeneration;
        return relatedDiscovery.discover(seeds, () => waveVisible && generation === waveGeneration);
    });
    let waveMetadataWarmupStarted = false;
    contentView.webContents.on('did-finish-load', () => {
        if (
            contentView.webContents.isDestroyed() ||
            !contentView.webContents.getURL().startsWith('https://soundcloud.com/')
        )
            return;
        void contentView.webContents
            .executeJavaScript(`(${installWaveMediaEndCapture.toString()})()`, true)
            .then(syncMediaEndCapture)
            .catch((error) => console.debug('Wave media end hook unavailable:', error));
        if (!stationRecoveryAttempted && stationAutoplayPrevious === true && !waveVisible) {
            stationRecoveryAttempted = true;
            setTimeout(() => {
                if (!waveVisible)
                    void restoreStationAutoplay().catch((error) =>
                        console.debug('Wave station autoplay restore unavailable:', error),
                    );
            }, 600);
        }
        setTimeout(() => {
            if (
                contentView.webContents.isDestroyed() ||
                waveVisible ||
                !contentView.webContents.getURL().startsWith('https://soundcloud.com/')
            )
                return;
            void contentView.webContents
                .executeJavaScript(`(${extractWaveLinks.toString()})()`, true)
                .then(async (tracks: WaveCandidate[]) => {
                    waveRecommender.addCandidates(tracks.map((track) => ({ ...track, source: 'personal' })));
                    if (waveMetadataWarmupStarted) return;
                    waveMetadataWarmupStarted = true;
                    const ranked = waveRecommender.rank(8);
                    if (ranked.length) waveRecommender.addCandidates(await Promise.all(ranked.map(enrichPublicTrack)));
                })
                .catch((error) => console.debug('Wave home preload unavailable:', error));
        }, 400);
    });
    const recordCurrent = (kind: 'skip' | 'complete' | 'play') => {
        if (!waveCurrentCandidate || waveCurrentRecorded) return;
        const duration = lastTrackInfo.url === waveCurrent ? parseTime(lastTrackInfo.duration) : 0;
        const fraction = waveListening.fraction(
            waveCurrentCandidate.url,
            duration || waveCurrentCandidate.durationSeconds || 0,
        );
        const features: SoundFeatures | undefined = audioSamples
            ? {
                  energy: audioTotals.energy / audioSamples,
                  bass: audioTotals.bass / audioSamples,
                  brightness: audioTotals.brightness / audioSamples,
              }
            : undefined;
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
            waveQueueEpoch++;
            for (const candidate of waveFuture) waveRecommender.release(candidate);
            waveFuture.length = 0;
            wavePrepared.clear();
            if (waveVisible)
                void prepareUpcoming()
                    .then(fillNativeQueue)
                    .catch((error) => console.debug('Wave settings refresh unavailable:', error));
        }
        store.set(controlsKey, waveControls);
        contentView.webContents.send('wave-inline:controls', waveControls);
    };
    let waveGeneration = 0;
    let waveNextTask: Promise<void> | null = null;
    let waveNextTaskGeneration = -1;
    let waveSearchTail: Promise<void> = Promise.resolve();
    const prepareUpcoming = async () => {
        if (!waveVisible) return;
        if (wavePrepared.length >= 3) return;
        const generation = waveGeneration;
        const settingsEpoch = waveQueueEpoch;
        await wavePrepared.prepare(async () => {
            const previousSearch = waveSearchTail;
            let release!: () => void;
            waveSearchTail = new Promise<void>((resolve) => {
                release = resolve;
            });
            await previousSearch;
            try {
                if (generation !== waveGeneration || settingsEpoch !== waveQueueEpoch || !waveVisible) return [];
                const minimum = waveStarting || waveNextTask ? 1 : 3;
                const available = () =>
                    waveRecommender
                        .rank(20)
                        .filter(
                            (item) =>
                                (waveControls.discovery === 'favorites' || item.source === 'related') &&
                                item.url !== waveCurrent &&
                                item.url !== lastTrackInfo.url &&
                                !waveFuture.some((future) => future.url === item.url) &&
                                !nativeQueued.some((queued) => queued.url === item.url),
                        );
                if (available().length < minimum) {
                    try {
                        const visible = (await contentView.webContents.executeJavaScript(
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
                        const batch = await Promise.all(ranked.slice(i, i + 4).map(enrichPublicTrack));
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
                    }
                }
                return waveRecommender.rankBuffered(playable).slice(0, targetCount);
            } finally {
                release();
            }
        }, [
            waveCurrent,
            lastTrackInfo.url,
            ...waveFuture.map((candidate) => candidate.url),
            ...nativeQueued.map((candidate) => candidate.url),
        ]);
    };
    if (savedControls && typeof savedControls === 'object') setControls(savedControls);
    const takeDiverseUpcoming = async (): Promise<WaveCandidate | undefined> => {
        const epoch = waveQueueEpoch;
        const options: WaveCandidate[] = [];
        const collect = async () => {
            while (options.length < 3) {
                const next = waveFuture.pop() || (await wavePrepared.take(waveShuffle));
                if (!next) break;
                if (next.url !== waveCurrent && !options.some((item) => item.url === next.url)) options.push(next);
            }
        };
        await collect();
        if (!options.length) {
            await prepareUpcoming();
            await collect();
        }
        if (epoch !== waveQueueEpoch || !waveVisible) return undefined;
        if (!options.length) return undefined;
        let ranked = waveRecommender.rankBuffered(
            options,
            options.length,
            [waveCurrentCandidate, ...waveHistory.slice(-2)].map((item) => item?.artist || '').filter(Boolean),
        );
        if (!ranked.length) {
            options.length = 0;
            await prepareUpcoming();
            await collect();
            if (epoch !== waveQueueEpoch || !waveVisible) return undefined;
            ranked = waveRecommender.rankBuffered(
                options,
                options.length,
                [waveCurrentCandidate?.artist || ''].filter(Boolean),
            );
        }
        const chosen = ranked.shift();
        for (let i = ranked.length - 1; i >= 0; i--) waveFuture.push(ranked[i]);
        return chosen;
    };
    const chooseNext = async (reason: 'start' | 'user' | 'finish' | 'error' = 'start') => {
        if (waveNextTask) {
            traceWave('next-coalesced', waveCurrent, undefined, reason);
            if (waveNextTaskGeneration === waveGeneration) return waveNextTask;
            try {
                await waveNextTask;
            } catch {}
            if (waveNextTask && waveNextTaskGeneration === waveGeneration) return waveNextTask;
        }
        const generation = waveGeneration;
        traceWave('next-requested', waveCurrent, undefined, reason);
        const task = (async () => {
            try {
                if (reason === 'user') {
                    waveEngine.skipCurrent();
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
                        await contentView.webContents.executeJavaScript(
                            `if (window.__waveMediaEndState) window.__waveMediaEndState.expectedPath = ${JSON.stringify(trackPath(candidate.url))};`,
                            true,
                        );
                        await playInNativePlayer(
                            contentView.webContents,
                            candidate.url,
                            candidate.title,
                            candidate.sourceQuery,
                            () => generation === waveGeneration && waveVisible,
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
                        waveRecommender.reserve(candidate);
                    }
                }
                if (generation !== waveGeneration || !waveVisible) return;
                if (!chosen) throw playError || new Error(noSelectionMessage());
                waveRecommender.reserve(chosen);
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
                waveHomeView?.webContents.send('wave-home:play-track', chosen);
                sendInline('candidate', chosen);
                sendLikeState(chosen.url);
                waveHomeView?.webContents.send('wave-home:state', 'playing');
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
                waveHomeView?.webContents.send('wave-home:state', 'error', message);
                sendInline('state', 'error', message);
                throw error;
            }
        })();
        waveNextTask = task;
        waveNextTaskGeneration = generation;
        try {
            await task;
        } finally {
            if (waveNextTask === task) waveNextTask = null;
            if (waveVisible)
                void prepareUpcoming().catch((error) => console.debug('Wave buffer refill unavailable:', error));
        }
    };
    onWaveNextRequest = () => {
        void chooseNext('user').catch((error) => console.debug('Wave next unavailable:', error));
    };
    const fillNativeQueue = async (): Promise<void> => {
        if (nativeQueueTask) return nativeQueueTask;
        const generation = waveGeneration;
        const task = (async () => {
            let missingCandidates = 0;
            if (!nativeQueueAvailable && waveFuture.length) sendInline('state', 'playing', 'Следующий трек готов');
            while (
                waveVisible &&
                generation === waveGeneration &&
                (nativeQueueAvailable ? nativeQueued.length < 1 : waveFuture.length < 1)
            ) {
                await prepareUpcoming();
                const next = await takeDiverseUpcoming();
                if (!next || generation !== waveGeneration || !waveVisible) break;
                if (next.url === waveCurrent || nativeQueued.some((item) => item.url === next.url)) continue;
                if (nativeQueueAvailable) {
                    try {
                        const occupied = (await listNativeNextUp(contentView.webContents)).some(
                            (url) => trackPath(url) !== trackPath(waveCurrent),
                        );
                        if (occupied) {
                            nativeQueueAvailable = false;
                            traceWave('queue-occupied', waveCurrent, next.url);
                        } else {
                            await addToNativeNextUp(
                                contentView.webContents,
                                next.url,
                                next.title,
                                next.sourceQuery,
                                () => generation === waveGeneration && waveVisible,
                            );
                            store.set(nativeQueueFailureKey, 0);
                            traceWave('queue-confirmed', waveCurrent, next.url);
                        }
                    } catch (error) {
                        if (error instanceof NativeActionCanceledError) break;
                        if (error instanceof NativeTrackNotFoundError) {
                            traceWave('queue-candidate-missing', waveCurrent, next.url);
                            waveRecommender.reserve(next);
                            if (++missingCandidates < 3) continue;
                            nativeQueueAvailable = false;
                            traceWave('queue-search-fallback', waveCurrent);
                            continue;
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
                if (generation !== waveGeneration || !waveVisible) break;
                if (nativeQueueAvailable) nativeQueued.push(next);
                else waveFuture.push(next);
                sendInline('queue-ready', nativeQueueAvailable && nativeQueued.length > 0);
                waveRecommender.reserve(next);
                sendInline('state', 'playing', 'Следующий трек готов');
            }
        })();
        nativeQueueTask = task;
        try {
            await task;
        } finally {
            if (nativeQueueTask === task) nativeQueueTask = null;
        }
    };
    let waveTasteTask: Promise<void> | undefined;
    const loadWaveTaste = async (): Promise<void> => {
        if (waveTasteTask) return waveTasteTask;
        if (waveHistoryLoaded || !waveDiscoveryView) return;
        const previousSearch = waveSearchTail;
        let release!: () => void;
        waveSearchTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        const task = (async () => {
            await previousSearch;
            try {
                if (!waveDiscoveryView || waveDiscoveryView.webContents.isDestroyed()) return;
                const personal = await discoverPersonalHistory(waveDiscoveryView.webContents);
                waveEngine.ingestLikes(personal.likes);
                waveRecommender.seedLikes(personal.likes);
                waveRecommender.seedRecent(personal.recent);
                waveHistoryLoaded = personal.likes.length > 0 || personal.recent.length > 0;
                sendInline('stats', waveEngine.stats());
            } catch (error) {
                console.debug('Wave taste history unavailable:', error);
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
    let tasteWarmup: ReturnType<typeof setTimeout> | undefined;
    contentView.webContents.once('did-finish-load', () => {
        tasteWarmup = setTimeout(() => {
            void loadWaveTaste();
        }, 1800);
    });
    mainWindow.once('closed', () => {
        clearTimeout(tasteWarmup);
        waveVisible = false;
        waveGeneration++;
        waveQueueEpoch++;
        wavePrepared.clear();
        onNativeWaveTrackUpdate = null;
        for (const view of [waveDiscoveryView, waveLikeView])
            if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    });
    onNativeWaveTrackUpdate = (track) => {
        if (!waveVisible) return;
        sendInline('track', track);
        if (!track.url) return;
        if (track.url !== lastTrackInfo.url) {
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
            lastTrackInfo.url === track.url &&
            lastTrackInfo.isLiked !== track.isLiked
        ) {
            waveKnownLikes.set(track.url, track.isLiked);
            waveRecommender.record(waveCurrentCandidate, track.isLiked ? 'like' : 'unlike');
            sendLikeState(track.url);
        }
        if (track.url === waveCurrent) {
            if (lastTrackInfo.url !== track.url)
                void disableStationAutoplay().catch((error) =>
                    console.debug('Wave station autoplay refresh unavailable:', error),
                );
            if (!nativeQueueAvailable || (!nativeQueued.length && !nativeQueueTask)) {
                const duration = parseTime(track.duration);
                const elapsed = parseTime(track.elapsed);
                if (duration > 0 && elapsed >= duration - 2) waveReachedEnd = true;
                if (
                    lastTrackInfo.isPlaying &&
                    !track.isPlaying &&
                    duration > 0 &&
                    (elapsed >= duration - 1 || (waveReachedEnd && elapsed === 0))
                )
                    void chooseNext('finish').catch((error) => console.debug('Wave transition unavailable:', error));
                return;
            }
            if (Date.now() - lastQueueInspection > 7000 && !nativeQueueTask) {
                lastQueueInspection = Date.now();
                void listNativeNextUp(contentView.webContents)
                    .then((urls) => {
                        if (!waveVisible) return;
                        const paths = new Set(urls.map(trackPath));
                        for (let i = nativeQueued.length - 1; i >= 0; i--)
                            if (!paths.has(trackPath(nativeQueued[i].url))) nativeQueued.splice(i, 1);
                        if (!nativeQueued.length)
                            void fillNativeQueue().catch((error) =>
                                sendInline(
                                    'state',
                                    'error',
                                    error instanceof Error ? error.message : 'Не удалось пополнить очередь SoundCloud.',
                                ),
                            );
                    })
                    .catch((error) => console.debug('Wave queue inspection unavailable:', error));
            }
            return;
        }
        if ((!nativeQueueAvailable || !nativeQueued.length) && waveCurrentCandidate) {
            const duration = parseTime(lastTrackInfo.duration);
            const elapsed = parseTime(lastTrackInfo.elapsed);
            void chooseNext(waveReachedEnd || (duration > 0 && elapsed >= duration - 2) ? 'finish' : 'user').catch(
                (error) => console.debug('Wave transition unavailable:', error),
            );
            return;
        }
        if (waveCurrentCandidate) {
            const duration = parseTime(lastTrackInfo.duration);
            const elapsed = parseTime(lastTrackInfo.elapsed);
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
            waveRecommender.reserve(waveCurrentCandidate);
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
        updateWaveVisibility();
    };
    const hideWave = () => {
        if (!waveVisible) return;
        sendInline('queue-ready', false);
        waveVisible = false;
        waveReachedEnd = false;
        waveGeneration++;
        waveQueueEpoch++;
        if (waveDiscoveryView && !waveDiscoveryView.webContents.isDestroyed()) {
            waveDiscoveryView.webContents.stop();
            void waveDiscoveryView.webContents.loadURL('about:blank').catch(() => {});
        }
        recordCurrent('play');
        waveRecommender.clearCandidates();
        waveRecommender.setAnchor(undefined);
        waveFuture.length = 0;
        wavePrepared.clear();
        if (!likeTask) releaseLikePage();
        sendInline('active', false);
        updateWaveVisibility();
        nativeQueued.length = 0;
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
            if (lastTrackInfo.url)
                waveRecommender.setAnchor({
                    url: lastTrackInfo.url,
                    title: lastTrackInfo.title,
                    artist: lastTrackInfo.author,
                    sourceRank: 0,
                });
            if (!lastTrackInfo.isPlaying || !lastTrackInfo.url) {
                await loadWaveTaste();
                await prepareUpcoming();
                let first: WaveCandidate | undefined;
                let playError: unknown;
                for (let attempt = 0; attempt < 5; attempt++) {
                    const candidate = await takeDiverseUpcoming();
                    if (generation !== waveGeneration || !waveVisible) return 'open';
                    if (!candidate) break;
                    waveCurrent = candidate.url;
                    try {
                        await contentView.webContents.executeJavaScript(
                            `if (window.__waveMediaEndState) window.__waveMediaEndState.expectedPath = ${JSON.stringify(trackPath(candidate.url))};`,
                            true,
                        );
                        await playInNativePlayer(
                            contentView.webContents,
                            candidate.url,
                            candidate.title,
                            candidate.sourceQuery,
                            () => generation === waveGeneration && waveVisible,
                        );
                        first = candidate;
                        break;
                    } catch (error) {
                        waveCurrent = lastTrackInfo.url;
                        playError = error;
                        waveRecommender.reserve(candidate);
                    }
                }
                if (!first) throw playError || new Error(noSelectionMessage());
                waveCurrentCandidate = first;
                waveRecommender.setAnchor(first);
                waveReachedEnd = false;
                waveCurrentRecorded = false;
                waveRecommender.reserve(first);
                sendInline('candidate', first);
            } else {
                waveCurrent = lastTrackInfo.url;
                waveCurrentCandidate = {
                    url: waveCurrent,
                    title: lastTrackInfo.title,
                    artist: lastTrackInfo.author,
                    sourceRank: 0,
                    durationSeconds: parseTime(lastTrackInfo.duration),
                };
                waveRecommender.setAnchor(waveCurrentCandidate);
                waveCurrentRecorded = false;
                waveRecommender.reserve(waveCurrentCandidate);
                sendInline('candidate', waveCurrentCandidate);
                waveReachedEnd = false;
                sendInline('track', lastTrackInfo);
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
            setTimeout(() => {
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
        source: 'related-tracks',
        controls: { ...waveControls },
        discovery: relatedDiscovery.diagnostics(),
        recommendation: waveRecommender.diagnostics(),
        prepared: wavePrepared.length,
        upcoming: waveFuture.map((item) => item.url),
        nativeQueued: nativeQueued.map((item) => item.url),
        choosing: Boolean(waveNextTask),
        filling: Boolean(nativeQueueTask),
    });
    ipcMain.handle('wave-inline:copy-diagnostics', (event) => {
        if (!isTrustedSoundCloudSender(event)) throw new Error('Недоверенная страница.');
        clipboard.writeText(JSON.stringify(waveDiagnostics(), null, 2));
        return true;
    });
    ipcMain.handle('wave-inline:ready', (event) => {
        if (!isTrustedSoundCloudSender(event)) return null;
        return {
            active: waveVisible,
            controls: waveControls,
            excludedArtists: waveRecommender.getExcludedArtists(),
            track: waveVisible ? lastTrackInfo : null,
            stats: waveEngine.stats(),
            candidate: waveCurrentCandidate,
            diagnostics: waveDiagnostics(),
            queueReady: nativeQueueAvailable && nativeQueued.length > 0,
            like: waveCurrentCandidate ? likeState(waveCurrentCandidate.url) : null,
            visible: mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused(),
        };
    });
    ipcMain.handle('wave-inline:like', async (event, url: unknown, desired: unknown) => {
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
            waveEngine.setLiked(candidate.url, liked, candidate);
            waveRecommender.record(candidate, liked ? 'like' : 'unlike');
            if (waveCurrent === candidate.url && waveVisible) {
                if (lastTrackInfo.url === candidate.url) lastTrackInfo = { ...lastTrackInfo, isLiked: liked };
                sendLikeState(candidate.url);
                if (lastTrackInfo.url === candidate.url) sendInline('track', lastTrackInfo);
                waveHomeView?.webContents.send('wave-home:stats', waveEngine.stats());
                sendInline('stats', waveEngine.stats());
            }
            return { url: candidate.url, liked };
        } finally {
            if (likeTask === task) {
                likeTask = null;
                releaseLikePage();
            }
        }
    });
    ipcMain.handle('wave-inline:start', async (event) => {
        if (!isTrustedSoundCloudSender(event)) throw new Error('Недоверенный вызов волны.');
        return startWave();
    });
    ipcMain.handle('wave-inline:exclude-artist', async (event, artist: unknown, excluded: unknown) => {
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
            nativeQueueAvailable = false;
            nativeQueued.length = 0;
            sendInline('queue-ready', false);
        }
        waveQueueEpoch++;
        for (const candidate of waveFuture) waveRecommender.release(candidate);
        waveFuture.length = 0;
        wavePrepared.clear();
        sendInline('excluded-artists', waveRecommender.getExcludedArtists());
        if (excluded && waveVisible && waveCurrentCandidate?.artist === artist) await chooseNext('user');
        return waveRecommender.getExcludedArtists();
    });
    ipcMain.handle('wave-inline:dislike', async (event, url: unknown) => {
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
        await chooseNext('user');
    });
    ipcMain.handle('playlist-import:scan', async (event, link: unknown) => {
        if (!isTrustedSoundCloudSender(event) || typeof link !== 'string' || link.length > 1000)
            throw new Error('Недопустимая ссылка на плейлист.');
        if (importTask) throw new Error('Предыдущий импорт ещё выполняется.');
        const controller = new AbortController();
        importScanController = controller;
        const slots = new Map<number, BrowserView>();
        const task = (async () => {
            importDraft = null;
            importProgress('source', 0, 0, 'Читаем плейлист…');
            const source = await loadSourcePlaylist(link, controller.signal);
            controller.signal.throwIfAborted();
            const concurrency = automaticImportConcurrency(availableParallelism(), freemem(), source.tracks.length);
            const availability = createAvailabilityChecker(contentView.webContents.session, controller.signal);
            importProgress('matching', 0, source.tracks.length, 'Ищем совпадения…', {
                title: source.title,
                tracks: source.tracks,
                partial: source.partial,
                concurrency,
            });
            const partialMatches: ImportMatch[] = source.tracks.map((track) => ({
                source: track,
                error: 'Проверка ещё не завершена.',
            }));
            importDraft = { source, matches: partialMatches };
            const matches = await mapImportTracks(source.tracks, {
                concurrency,
                signal: controller.signal,
                run: async (track, _index, slot): Promise<ImportMatch> => {
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
                },
                onComplete: (match, index, completed) => {
                    partialMatches[index] = match;
                    importProgress(
                        'matching',
                        completed,
                        source.tracks.length,
                        `${match.source.artist} — ${match.source.title}`,
                        { index, match },
                    );
                },
            });
            importDraft = { source, matches };
            return { title: source.title, platform: source.platform, partial: source.partial, matches };
        })();
        importTask = task;
        try {
            return await task;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('Поиск отменён.');
            throw error;
        } finally {
            for (const view of slots.values()) closeImportView(view);
            if (importScanController === controller) importScanController = null;
            if (importTask === task) importTask = null;
        }
    });
    ipcMain.handle('playlist-import:commit', async (event, selection: unknown) => {
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
        const playlistTitle = input.title.trim();
        const task = (async () => {
            const title = playlistTitle;
            const availability = createAvailabilityChecker(contentView.webContents.session);
            importProgress('checking', 0, chosen.length, 'Проверяем доступность перед добавлением…');
            const checks = await mapImportTracks(chosen, {
                concurrency: automaticImportConcurrency(availableParallelism(), freemem(), chosen.length),
                run: async (item) => ({
                    item,
                    availability: await availability(item.soundcloud!.url).catch(() => ({
                        status: 'unknown' as const,
                        reason: 'SoundCloud не ответил при проверке доступности.',
                    })),
                }),
                onComplete: (_result, _index, completed) => importProgress('checking', completed, chosen.length, title),
            });
            const available = checks
                .filter((result) => result.availability.status === 'available')
                .map((result) => result.item);
            const failures: {
                title: string;
                reason: string;
            }[] = checks
                .filter((result) => result.availability.status !== 'available')
                .map((result) => ({ title: result.item.source.title, reason: result.availability.reason }));
            if (!available.length)
                throw new Error('Доступные полные версии не найдены. Плейлист не создан. Повторите поиск.');
            const view = getImportView();
            importProgress('creating', 0, available.length, title);
            const result = await writePartialPlaylist(available, {
                title: (item) => item.source.title,
                create: (item) =>
                    createSoundCloudPlaylist(view, title, item.soundcloud!.url, item.soundcloud!.sourceQuery),
                add: (item) =>
                    addSoundCloudPlaylistTrack(view, title, item.soundcloud!.url, item.soundcloud!.sourceQuery),
                progress: (completed, item) => importProgress('adding', completed, available.length, item.source.title),
            });
            failures.push(...result.failures);
            if (!result.successful.length)
                throw new Error(
                    'SoundCloud не подтвердил добавление ни одного трека. Найденные совпадения сохранены — можно повторить добавление. ' +
                        (failures[0]?.reason || ''),
                );
            importProgress('done', available.length, available.length, title);
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
            if (importView) {
                closeImportView(importView);
                importView = null;
            }
            if (importTask === task) importTask = null;
        }
    });
    ipcMain.on('playlist-import:cancel', (event) => {
        if (isTrustedSoundCloudSender(event) && importScanController) {
            importScanController.abort();
            for (const view of importSearchViews) closeImportView(view);
        }
    });
    ipcMain.on('wave-inline:control', (event, command: unknown, value: unknown) => {
        if (!isTrustedSoundCloudSender(event) || typeof command !== 'string') return;
        if (!waveVisible && command !== 'stop') return;
        if (command === 'stop') {
            hideWave();
            return;
        }
        if (command === 'next') {
            void chooseNext('user').catch((error) => console.debug('Wave next unavailable:', error));
            return;
        }
        if (command === 'finish') {
            traceWave('media-ended-captured', waveCurrent);
            void chooseNext('finish').catch((error) => console.debug('Wave finish unavailable:', error));
            return;
        }
        if (command === 'shuffle' && typeof value === 'boolean') {
            waveShuffle = value;
            return;
        }
    });
    ipcMain.on('wave-inline:controls', (event, input: unknown) => {
        if (isTrustedSoundCloudSender(event) && input && typeof input === 'object')
            setControls(input as Partial<WaveControls>);
    });
    ipcMain.handle('wave-home:start', async (event) => {
        if (!waveHomeView || event.sender !== waveHomeView.webContents) throw new Error('Недоверенный вызов волны.');
        return startWave();
    });
    ipcMain.on('wave-home:next', (event, reason: unknown) => {
        if (waveVisible && waveHomeView && event.sender === waveHomeView.webContents) {
            void chooseNext(
                reason === 'user' ? 'user' : reason === 'finish' ? 'finish' : reason === 'error' ? 'error' : 'start',
            ).catch(() => {});
        }
    });
    ipcMain.on('wave-home:previous', (event) => {
        if (!waveVisible || !waveHomeView || event.sender !== waveHomeView.webContents || waveNextTask) return;
        const previous = waveHistory.pop();
        if (!previous) {
            waveHomeView.webContents.send('wave-home:restart');
            return;
        }
        recordCurrent('play');
        if (waveCurrentCandidate) waveFuture.push(waveCurrentCandidate);
        waveCurrentCandidate = previous;
        waveCurrent = previous.url;
        waveCurrentRecorded = false;
        audioSamples = 0;
        audioTotals.energy = 0;
        audioTotals.bass = 0;
        audioTotals.brightness = 0;
        waveHomeView.webContents.send('wave-home:play-track', previous);
        sendInline('candidate', previous);
        sendLikeState(previous.url);
    });
    ipcMain.on('wave-home:shuffle', (event, enabled: unknown) => {
        if (waveHomeView && event.sender === waveHomeView.webContents && typeof enabled === 'boolean')
            waveShuffle = enabled;
    });
    ipcMain.on('wave-home:track-update', (event, track: TrackInfo) => {
        if (
            !waveHomeView ||
            event.sender !== waveHomeView.webContents ||
            !track ||
            track.url !== waveCurrent ||
            typeof track.title !== 'string'
        )
            return;
        const known = knownLike(track.url);
        const currentTrack = known === undefined ? track : { ...track, isLiked: known };
        lastTrackInfo = currentTrack;
        waveEngine.observe(currentTrack);
        waveHomeView.webContents.send('wave-home:track', currentTrack);
        sendInline('track', currentTrack);
        waveHomeView.webContents.send('wave-home:stats', waveEngine.stats());
        sendInline('stats', waveEngine.stats());
        void presenceService?.updatePresence(currentTrack);
    });
    ipcMain.on('wave-home:back', (event) => {
        if (waveHomeView && event.sender === waveHomeView.webContents) hideWave();
    });
    ipcMain.on('wave-home:open-track', (event, target: unknown) => {
        if (!waveHomeView || event.sender !== waveHomeView.webContents || typeof target !== 'string') return;
        try {
            const url = new URL(target);
            if (url.origin !== 'https://soundcloud.com' || url.pathname.split('/').filter(Boolean).length !== 2) return;
            hideWave();
            void contentView.webContents.loadURL(url.href);
        } catch {}
    });
    ipcMain.on('wave-home:navigate', (event, target: unknown) => {
        if (!waveHomeView || event.sender !== waveHomeView.webContents || typeof target !== 'string') return;
        if (target === 'daily' || target === 'weekly') {
            void startWave().catch(() => {});
            return;
        }
        const urls: Record<string, string> = {
            likes: 'https://soundcloud.com/you/likes',
            home: 'https://soundcloud.com/discover',
            genres: 'https://soundcloud.com/discover',
            new: 'https://soundcloud.com/discover',
            charts: 'https://soundcloud.com/charts/top',
            collections: 'https://soundcloud.com/discover',
        };
        if (urls[target]) {
            hideWave();
            void contentView.webContents.loadURL(urls[target]);
        }
    });
    let lastInlineAudioAt = 0;
    ipcMain.on('wave-home:audio', (event, features: AudioFeatures) => {
        if (
            !waveHomeView ||
            event.sender !== waveHomeView.webContents ||
            !features ||
            !['energy', 'bass', 'mid', 'treble'].every(
                (key) =>
                    typeof features[key as keyof AudioFeatures] === 'number' &&
                    Number.isFinite(features[key as keyof AudioFeatures]),
            )
        )
            return;
        waveEngine.audio(features);
        if (audioSamples < 10000 && waveVisible && waveCurrentCandidate) {
            audioTotals.energy += Math.max(0, Math.min(1, features.energy));
            audioTotals.bass += Math.max(0, Math.min(1, features.bass));
            audioTotals.brightness += Math.max(0, Math.min(1, features.treble));
            audioSamples++;
        }
        const now = Date.now();
        if (now - lastInlineAudioAt >= 500) {
            lastInlineAudioAt = now;
            sendInline('audio', features);
        }
    });
    ipcMain.on('wave-home:metadata', (event, url: unknown, metadata: unknown) => {
        if (
            !waveHomeView ||
            event.sender !== waveHomeView.webContents ||
            url !== waveCurrent ||
            !metadata ||
            typeof metadata !== 'object'
        )
            return;
        waveEngine.metadata(
            url,
            metadata as {
                genre?: string;
                tags?: string[];
                bpm?: number;
            },
        );
        if (waveCurrentCandidate) {
            const item = metadata as {
                genre?: unknown;
                tags?: unknown;
                bpm?: unknown;
            };
            if (typeof item.genre === 'string') waveCurrentCandidate.genre = item.genre.slice(0, 80);
            if (Array.isArray(item.tags))
                waveCurrentCandidate.tags = item.tags
                    .filter((tag): tag is string => typeof tag === 'string')
                    .slice(0, 20);
            const bpm = Number(item.bpm);
            if (Number.isFinite(bpm) && bpm >= 50 && bpm <= 220) {
                waveCurrentCandidate.bpm = bpm;
                waveCurrentCandidate.bpmConfidence = 0.7;
            }
            waveCurrentCandidate.metadataChecked = true;
        }
        sendInline('metadata', metadata);
    });
    themeService.onCustomThemeUpdated(() => {
        applyThemeToContent(isDarkTheme);
    });
    notificationManager = new NotificationManager(mainWindow);
    settingsManager = new SettingsManager(mainWindow, store, translationService);
    proxyService = new ProxyService(mainWindow, store, queueToastNotification, contentView.webContents.session);
    const connectionRecovery = new ConnectionRecovery(contentView.webContents, store, queueToastNotification);
    let networkSettingsBusy = false;
    const workerSetup = new WorkerSetup();
    contentView.webContents.once('destroyed', () => workerSetup.clear());
    ipcMain.handle('network:setup-accounts', async (event, token: unknown) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Подождите окончания настройки.');
        networkSettingsBusy = true;
        try {
            return await workerSetup.authorize(token);
        } finally {
            networkSettingsBusy = false;
        }
    });
    ipcMain.handle('network:setup-cancel', (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Дождитесь окончания текущей операции.');
        workerSetup.clear();
    });
    ipcMain.handle('network:setup-deploy', async (event, account: unknown) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Подождите окончания настройки.');
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное хранилище ключей недоступно.');
        networkSettingsBusy = true;
        try {
            const folder = app.isPackaged
                ? path.join(process.resourcesPath, 'soundcloud-relay')
                : path.join(__dirname, '../cloudflare/soundcloud-relay');
            const result = await workerSetup.deploy(
                account,
                {
                    entry: readFileSync(path.join(folder, 'worker.mjs'), 'utf8'),
                    protocol: readFileSync(path.join(folder, 'protocol.mjs'), 'utf8'),
                },
                (message) => {
                    if (!event.sender.isDestroyed()) event.sender.send('network:setup-progress', message);
                },
            );
            const applyNow = store.get('cloudflareMode', 'off') === 'off' && !store.get('proxyEnabled');
            connectionRecovery.save({ mode: 'auto', endpoint: result.endpoint, secret: result.secret });
            workerSetup.clear();
            if (applyNow) await connectionRecovery.configure();
            return { endpoint: result.endpoint, name: result.name, applied: applyNow };
        } finally {
            networkSettingsBusy = false;
        }
    });
    ipcMain.handle('network:files', async (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        return shell.openPath(
            app.isPackaged
                ? path.join(process.resourcesPath, 'soundcloud-relay')
                : path.join(__dirname, '../cloudflare/soundcloud-relay'),
        );
    });
    ipcMain.handle('network:status', (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        return connectionRecovery.getStatus();
    });
    ipcMain.handle('network:save', async (event, input: unknown) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Подождите окончания проверки подключения.');
        networkSettingsBusy = true;
        try {
            connectionRecovery.save(input);
            await proxyService.apply();
            await connectionRecovery.configure();
            return connectionRecovery.getStatus();
        } finally {
            networkSettingsBusy = false;
        }
    });
    ipcMain.handle('network:test', async (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Подождите окончания проверки подключения.');
        networkSettingsBusy = true;
        try {
            return (await connectionRecovery.testRelay())
                ? 'Worker доступен: сайт и API SoundCloud отвечают.'
                : 'Worker не смог подключиться к SoundCloud. Проверьте адрес, ключ и ограничения Cloudflare.';
        } finally {
            networkSettingsBusy = false;
        }
    });
    presenceService = new PresenceService(store, translationService);
    lastFmService = new LastFmService(contentView, store);
    webhookService = new WebhookService(store);
    shortcutService = new ShortcutService(mainWindow);
    shortcutService.attachToWebContents(contentView.webContents);
    contentView.webContents.on('before-input-event', (event, input) => {
        if (!waveVisible || input.type !== 'keyDown' || input.key !== 'MediaNextTrack') return;
        event.preventDefault();
        void chooseNext('user').catch((error) => console.debug('Wave media next unavailable:', error));
    });
    if (platform() === 'win32') thumbarService = new ThumbarService(translationService);
    setupMemoryPressureHandler();
    ipcMain.on('toggle-settings', () => {
        settingsManager.toggle();
        applyThemeToContent(isDarkTheme);
    });
    ipcMain.handle('confirm-open-homepage', async (_event, url: string) => {
        if (!url || typeof url !== 'string') return false;
        const normalizedUrl = url.trim();
        if (!/^https?:\/\//i.test(normalizedUrl)) return false;
        const confirmed = await showHomepageConfirmDialog(mainWindow, normalizedUrl);
        if (confirmed) {
            await shell.openExternal(normalizedUrl);
        }
        return confirmed;
    });
    ipcMain.on('show-plugin-homepage-dialog', async (_event, url: string) => {
        if (!url || typeof url !== 'string') return;
        const normalizedUrl = url.trim();
        if (!/^https?:\/\//i.test(normalizedUrl)) return;
        const confirmed = await showHomepageConfirmDialog(mainWindow, normalizedUrl);
        if (confirmed) {
            await shell.openExternal(normalizedUrl);
        }
    });
    ipcMain.handle('open-external-url', async (_event, url: string) => {
        if (!url || typeof url !== 'string') return '';
        const normalizedUrl = url.trim();
        try {
            const parsed = new URL(normalizedUrl);
            if (parsed.protocol !== 'https:') return '';
            await shell.openExternal(parsed.toString());
            return '';
        } catch {
            return '';
        }
    });
    ipcMain.handle('open-path', async (_event, targetPath: string) => {
        if (!targetPath || typeof targetPath !== 'string') return 'Invalid path';
        const allowedPaths = [themeService.getThemesPath(), pluginService.getPluginsPath()].map((allowedPath) =>
            path.resolve(allowedPath),
        );
        const normalizedPath = path.resolve(targetPath);
        if (!allowedPaths.includes(normalizedPath)) return 'Blocked path';
        return shell.openPath(targetPath);
    });
    setupWindowControls();
    initializeShortcuts();
    setupThemeHandlers();
    setupTranslationHandlers();
    setupAudioHandler();
    ipcMain.handle('get-current-track', (event) => {
        return settingsManager.owns(event.sender) ? lastTrackInfo : null;
    });
    await proxyService.apply();
    await connectionRecovery.configure();
    function updateNavigationState() {
        if (headerView && headerView.webContents && contentView) {
            const state = {
                canGoBack: contentView.webContents.navigationHistory.canGoBack(),
                canGoForward: contentView.webContents.navigationHistory.canGoForward(),
            };
            headerView.webContents.send('navigation-state-changed', state);
        }
    }
    contentView.webContents.on('did-navigate', () => {
        updateNavigationState();
    });
    contentView.webContents.on('did-navigate-in-page', () => {
        updateNavigationState();
        sendInline('route');
    });
    contentView.webContents.on('did-start-loading', () => {
        if (headerView && headerView.webContents) {
            headerView.webContents.send('refresh-state-changed', true);
        }
    });
    contentView.webContents.on('did-stop-loading', () => {
        if (headerView && headerView.webContents) {
            headerView.webContents.send('refresh-state-changed', false);
        }
        updateNavigationState();
    });
    contentView.webContents.on('did-fail-load', () => {
        if (headerView && headerView.webContents) {
            headerView.webContents.send('refresh-state-changed', false);
        }
        updateNavigationState();
    });
    if (store.get('adBlocker')) {
        try {
            const blocker = await ElectronBlocker.fromLists(
                (url) => fetch(url, { signal: AbortSignal.timeout(10000) }),
                fullLists,
                { enableCompression: true },
                {
                    path: 'engine.bin',
                    read: async (...args) => readFileSync(...args),
                    write: async (...args) => writeFileSync(...args),
                },
            );
            blocker.enableBlockingInSession(contentView.webContents.session);
        } catch (error) {
            console.error('Failed to initialize adblocker:', error);
        }
    }
    let isInitialLoad = true;
    contentView.webContents.on('did-finish-load', async () => {
        await lastFmService.authenticate();
        await getLanguage();
        if (isInitialLoad) {
            notificationManager.show(translationService.translate('pressF1ToOpenSettings'));
            isInitialLoad = false;
        }
        settingsManager.updateTranslations(translationService);
        updateNavigationState();
        const navigationEnabled = store.get('navigationControlsEnabled', false);
        if (headerView && headerView.webContents) {
            headerView.webContents.send('navigation-controls-toggle', navigationEnabled);
        }
        await reinitializeAfterPageLoad();
    });
    async function reinitializeAfterPageLoad() {
        try {
            applyThemeToContent(isDarkTheme);
            if (new URL(contentView.webContents.getURL()).origin === 'https://soundcloud.com') {
                await contentView.webContents.insertCSS(
                    readFileSync(path.join(__dirname, 'wave', 'inline.css'), 'utf8'),
                );
                await contentView.webContents.executeJavaScript(
                    readFileSync(path.join(__dirname, 'wave', 'inline.js'), 'utf8'),
                );
            }
            contentView.webContents.setZoomFactor(store.get('uiScale', 1) as number);
            await contentView.webContents.executeJavaScript(audioMonitorScript);
            if (pluginService) {
                pluginService.injectAllContentScripts();
            }
            if (presenceService) {
                await presenceService.updatePresence(lastTrackInfo);
            }
        } catch (error) {
            console.error('Failed to reinitialize after page load:', error);
        }
    }
    ipcMain.on('setting-changed', async (_event, data) => {
        const key = proxyService.transformKey(data.key);
        store.set(key, data.value);
        console.log(key);
        if (key === 'displayWhenIdling') {
            displayWhenIdling = data.value;
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon);
        } else if (key === 'displaySCSmallIcon') {
            displaySCSmallIcon = data.value;
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon);
        } else if (key === 'displayButtons') {
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon, data.value);
        } else if (key === 'statusDisplayType') {
            presenceService.setStatusDisplayType(data.value as number);
        } else if (key === 'minimizeToTray') {
            if (data.value === false && tray) {
                tray.destroy();
                tray = null;
            } else if (data.value === true && !tray) {
                setupTray();
            }
        } else if (key === 'webhookEnabled') {
            webhookService.setEnabled(data.value);
        } else if (key === 'webhookUrl') {
            webhookService.setWebhookUrl(data.value);
        } else if (key === 'webhookTriggerPercentage') {
            webhookService.setTriggerPercentage(data.value);
        } else if (key === 'navigationControlsEnabled') {
            if (headerView && headerView.webContents) {
                headerView.webContents.send('navigation-controls-toggle', data.value);
            }
        } else if (key === 'uiScale') {
            if (contentView) contentView.webContents.setZoomFactor(data.value);
        } else if (key === 'autoUpdaterEnabled') {
            if (data.value) {
                setupUpdater();
            } else {
                console.log('Auto-updater disabled by user');
            }
        } else if (key === 'customTheme') {
            if (data.value === 'none') {
                themeService.removeCustomTheme();
            } else {
                themeService.applyCustomTheme(data.value);
            }
            applyThemeToContent(isDarkTheme);
        } else if (key === 'hidePromotions' || key === 'hideEventsNearYou' || key === 'hideArtistUpsells') {
            applyThemeToContent(isDarkTheme);
        }
    });
    ipcMain.handle('get-accounts', () => {
        return {
            accounts: store.get('accounts', [{ id: 'default', name: 'Main Account' }]),
            currentAccountId: store.get('currentAccountId', 'default'),
        };
    });
    ipcMain.on('switch-account', (_, accountId) => {
        store.set('currentAccountId', accountId);
        app.relaunch();
        app.quit();
    });
    ipcMain.on('add-account', () => {
        const newId = `acc_${Date.now()}`;
        const accounts = store.get('accounts', [{ id: 'default', name: 'Main Account' }]);
        accounts.push({ id: newId, name: 'New Account' });
        store.set('accounts', accounts);
        store.set('currentAccountId', newId);
        app.relaunch();
        app.quit();
    });
    ipcMain.on('logout-account', async () => {
        const currentId = store.get('currentAccountId', 'default');
        if (contentView) {
            await contentView.webContents.session.clearStorageData();
        }
        if (currentId !== 'default') {
            const accounts = store.get('accounts', [{ id: 'default', name: 'Main Account' }]);
            const filteredAccounts = accounts.filter((a: { id: string }) => a.id !== currentId);
            store.set('accounts', filteredAccounts);
            store.set('currentAccountId', 'default');
            app.relaunch();
            app.quit();
        } else {
            if (contentView) contentView.webContents.reload();
        }
    });
    ipcMain.on('apply-changes', async () => {
        await proxyService.apply();
        await connectionRecovery.configure();
        if (store.get('lastFmEnabled')) {
            await lastFmService.authenticate();
        }
        if (store.get('adBlocker')) {
            mainWindow.webContents.reload();
        }
        if (store.get('discordRichPresence')) {
            await presenceService.updatePresence(lastTrackInfo);
        } else {
            presenceService.clearActivity();
        }
    });
    let accountPollBusy = false;
    const accountPoll = setInterval(async () => {
        if (accountPollBusy || !contentView || contentView.webContents.isDestroyed()) return;
        accountPollBusy = true;
        try {
            const username = await contentView.webContents.executeJavaScript(`
				(() => {
					try {
						const profileBtn = document.querySelector('.header__userNav [data-menu-name="profile"]');
						if (profileBtn && profileBtn.href) {
							const parts = profileBtn.href.split('/');
							return parts[parts.length - 1]; // returns "elricfd"
						}
						const userBtn = document.querySelector('.header__userNavUsernameButton');
						if (userBtn && userBtn.href) {
							const parts = userBtn.href.split('/');
							return parts[parts.length - 1];
						}
						
						return null;
					} catch(err) {
						return null;
					}
				})()
			`);
            if (username && typeof username === 'string' && username.trim() !== '') {
                const accounts = store.get('accounts', [{ id: 'default', name: 'Main Account' }]);
                const currentId = store.get('currentAccountId', 'default');
                const accountIndex = accounts.findIndex((a: { id: string }) => a.id === currentId);
                if (accountIndex !== -1 && accounts[accountIndex].name !== username) {
                    console.log(`[Account Manager] Found new username: ${username}. Updating database...`);
                    accounts[accountIndex].name = username;
                    store.set('accounts', [...accounts]);
                    if (settingsManager && settingsManager.getView()) {
                        settingsManager.getView()?.webContents.send('accounts-updated');
                    }
                }
            }
        } catch {
        } finally {
            accountPollBusy = false;
        }
    }, 5000);
    mainWindow.once('closed', () => clearInterval(accountPoll));
    void contentView.webContents.loadURL('https://soundcloud.com/').catch(() => {});
}
function setupMemoryPressureHandler() {
    if (memoryPressureHandlerRegistered) return;
    if (!isMac) return;
    memoryPressureHandlerRegistered = true;
    (app as unknown as EventEmitter).on('memory-pressure', async (_event: unknown, details: unknown) => {
        const level = typeof details === 'string' ? details : 'unknown';
        console.warn(`Memory pressure detected (${level}). Clearing caches and history.`);
        if (contentView) {
            contentView.webContents.clearHistory();
        }
        const session = contentView?.webContents.session;
        if (!session) return;
        try {
            await session.clearCache();
        } catch (error) {
            console.warn('Failed to clear HTTP cache:', error);
        }
        try {
            await session.clearStorageData({ storages: ['cachestorage'] });
        } catch (error) {
            console.warn('Failed to clear Cache Storage:', error);
        }
    });
}
function setupThemeHandlers() {
    isDarkTheme = store.get('theme', 'dark') === 'dark';
    if (headerView && headerView.webContents) {
        headerView.webContents.send('theme-changed', isDarkTheme);
    }
    if (settingsManager) {
        settingsManager.getView()?.webContents.send('theme-changed', isDarkTheme);
    }
    applyThemeToContent(isDarkTheme);
    ipcMain.on('setting-changed', (_, data) => {
        if (data.key === 'theme') {
            isDarkTheme = data.value === 'dark';
            store.set('theme', data.value);
            if (pluginService) {
                pluginService.notifyThemeChange(isDarkTheme);
            }
            if (headerView && headerView.webContents) {
                headerView.webContents.send('theme-changed', isDarkTheme);
            }
            if (settingsManager) {
                settingsManager.getView()?.webContents.send('theme-changed', isDarkTheme);
            }
            applyThemeToContent(isDarkTheme);
        }
    });
}
function applyThemeToContent(isDark: boolean) {
    if (!contentView) return;
    const customThemeCSS = themeService.getCurrentCustomThemeCSS();
    const themeColors = themeService.getCurrentThemeColors();
    if (notificationManager) {
        notificationManager.setThemeColors(themeColors);
    }
    if (settingsManager) {
        settingsManager.setThemeColors(themeColors);
    }
    if (headerView && headerView.webContents) {
        headerView.webContents.send('theme-colors-changed', themeColors);
    }
    const hidePromotions = store.get('hidePromotions', true);
    const hideEventsNearYou = store.get('hideEventsNearYou', true);
    const hideArtistUpsells = store.get('hideArtistUpsells', true);
    const sections = (function splitSections(css: string | null) {
        const res = { all: '', content: '', header: '', settings: '' } as Record<string, string>;
        if (!css) return res;
        const regex =
            /\/\*\s*@target\s+(all|content|header|settings)\s*\*\/[\s\S]*?(?=(\/\*\s*@target\s+(?:all|content|header|settings)\s*\*\/)|$)/gi;
        let match: RegExpExecArray | null;
        let any = false;
        while ((match = regex.exec(css)) !== null) {
            any = true;
            const block = match[0];
            const targetMatch = /@target\s+(all|content|header|settings)/i.exec(block);
            const target = (targetMatch?.[1] || '').toLowerCase();
            const body = block.replace(/^[\s\S]*?\*\//, '').trim();
            res[target] += (res[target] ? '\n' : '') + body;
        }
        if (!any) {
            res.content = css;
        }
        return res;
    })(customThemeCSS);
    const themeScript = `
        (function() {
            try {
                document.documentElement.classList.toggle('theme-light', !${isDark});
                document.documentElement.classList.toggle('theme-dark', ${isDark});
                document.body.classList.toggle('theme-light', !${isDark});
                document.body.classList.toggle('theme-dark', ${isDark});
                
                if (${isDark}) {
                    document.documentElement.style.setProperty('--background-base', '#121212');
                    document.documentElement.style.setProperty('--background-surface', '#212121');
                    document.documentElement.style.setProperty('--text-base', '#ffffff');
                } else {
                    document.documentElement.style.setProperty('--background-base', '#ffffff');
                    document.documentElement.style.setProperty('--background-surface', '#f2f2f2');
                    document.documentElement.style.setProperty('--text-base', '#333333');
                }
                
                const style = document.createElement('style');
                style.id = 'custom-scrollbar-style';
                style.textContent = \`
                    ::-webkit-scrollbar-button {
                        display: none;
                    }
                    
                    ::-webkit-scrollbar {
                        width: 8px;
                        height: 8px;
                        background-color: ${isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)'};
                    }
                    
                    ::-webkit-scrollbar-track {
                        background-color: transparent;
                    }
                    
                    ::-webkit-scrollbar-thumb {
                        background-color: ${isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)'};
                        border-radius: 4px;
                        transition: background-color 0.3s;
                    }
                    
                    ::-webkit-scrollbar-thumb:hover {
                        background-color: ${isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)'};
                    }
                    
                    ::-webkit-scrollbar-corner {
                        background-color: transparent;
                    }
                    
                    ${hidePromotions ? '.banner.m-promotion { display: none !important; }' : ''}
                    
                    ${hideEventsNearYou ? '.velvetCakeModule { display: none !important; }' : ''}
                    
					${hideArtistUpsells ? '.creatorSubscriptionsButton.header__creatorUpsell, .artistConnectItem.m-upsellNextPro, .dropdownMenu [href*="checkout.soundcloud.com"], .dropdownMenu *:has(> svg.profileMenu__icon path[fill="#F50"]), .spotlight:has(.spotlight__upsellBanner), .spotlight__upsellBanner, .spotlight__upsellCTA, .sidebarContent:has(.velvetCakeIframe), .artistConnectContainer .tileGallery__sliderPeekForward, .artistConnectContainer .tileGallery__sliderPeekBackward, .MuiBox-root:has(a[href*="getstarted/fan-support"]) { display: none !important; }' : ''}
                \`;
                
                const existingStyle = document.getElementById('custom-scrollbar-style');
                if (existingStyle) {
                    existingStyle.remove();
                }
                document.head.appendChild(style);
                if (window._artistUpsellInterval) clearInterval(window._artistUpsellInterval);
                window._artistUpsellInterval = setInterval(() => {
                    document.querySelectorAll('iframe[title="Artist tools"], iframe[title="Sidebar modules"]').forEach(iframe => {
                        try {
                            const doc = iframe.contentDocument || iframe.contentWindow?.document;
                            const container = iframe.closest('.webiEmbeddedModuleContainer');
                            
                            if (container && doc) {
                                if (!doc.getElementById('custom-iframe-style')) {
                                    const iframeStyle = doc.createElement('style');
                                    iframeStyle.id = 'custom-iframe-style';
                                    iframeStyle.textContent = '${hideArtistUpsells ? '.MuiBox-root:has(a[href*="getstarted/fan-support"]) { display: none !important; }' : ''}';
                                    doc.head.appendChild(iframeStyle);
                                }
                                if (${hideArtistUpsells} && doc.querySelector('svg[aria-label="Paywalled feature"]')) {
                                    container.style.display = 'none';
                                } else {
                                    container.style.display = '';
                                }
                            }
                        } catch(e) {
                        }
                    });
                }, 1000);
                const contentCSS = \`${sections.all + (sections.all && sections.content ? '\n' : '') + sections.content || ''}\`;
                if (contentCSS.trim()) {
                    const customStyle = document.createElement('style');
                    customStyle.id = 'custom-theme-style';
                    customStyle.textContent = contentCSS;
                    
                    const existingCustomStyle = document.getElementById('custom-theme-style');
                    if (existingCustomStyle) {
                        existingCustomStyle.remove();
                    }
                    document.head.appendChild(customStyle);
                    console.log('Applied custom theme CSS');
                } else {
                    const existingCustomStyle = document.getElementById('custom-theme-style');
                    if (existingCustomStyle) {
                        existingCustomStyle.remove();
                        console.log('Removed custom theme CSS');
                    }
                }
            } catch(e) {
                console.error('Error applying theme:', e);
            }
        })();
    `;
    contentView.webContents.executeJavaScript(themeScript).catch(console.error);
    const headerCSS = sections.all + (sections.all && sections.header ? '\n' : '') + sections.header || '';
    if (headerView && headerView.webContents) {
        const headerScript = `
            (function(){
                try {
                    const css = \`${headerCSS}\`;
                    const id = 'custom-theme-style';
                    const existing = document.getElementById(id);
                    if (existing) existing.remove();
                    if (css.trim()){
                        const style = document.createElement('style');
                        style.id = id;
                        style.textContent = css;
                        document.head.appendChild(style);
                        console.log('Applied custom header theme CSS');
                    }
                } catch(e){ console.error('Header theme inject error:', e); }
            })();
        `;
        headerView.webContents.executeJavaScript(headerScript).catch(console.error);
    }
    if (settingsManager) {
        const settingsCSS = sections.all + (sections.all && sections.settings ? '\n' : '') + sections.settings || '';
        const settingsScript = `
            (function(){
                try {
                    const css = \`${settingsCSS}\`;
                    const id = 'custom-theme-style';
                    const existing = document.getElementById(id);
                    if (existing) existing.remove();
                    if (css.trim()){
                        const style = document.createElement('style');
                        style.id = id;
                        style.textContent = css;
                        document.head.appendChild(style);
                        console.log('Applied custom settings theme CSS');
                    }
                } catch(e){ console.error('Settings theme inject error:', e); }
            })();
        `;
        settingsManager.getView()?.webContents.executeJavaScript(settingsScript).catch(console.error);
    }
}
function initializeShortcuts() {
    if (!mainWindow || !contentView || !settingsManager) return;
    shortcutService.register('openSettings', 'F1', 'Open Settings', () => settingsManager.toggle());
    if (devMode) {
        shortcutService.register('devTools', 'F12', 'Open Developer Tools', () => {
            if (contentView) contentView.webContents.openDevTools();
        });
    }
    shortcutService.register('zoomIn', 'CommandOrControl+=', 'Zoom In', () => {
        if (!contentView) return;
        const zoomLevel = contentView.webContents.getZoomLevel();
        contentView.webContents.setZoomLevel(Math.min(zoomLevel + 1, 9));
    });
    shortcutService.register('zoomOut', 'CommandOrControl+-', 'Zoom Out', () => {
        if (!contentView) return;
        const zoomLevel = contentView.webContents.getZoomLevel();
        contentView.webContents.setZoomLevel(Math.max(zoomLevel - 1, -9));
    });
    shortcutService.register('zoomReset', 'CommandOrControl+0', 'Reset Zoom', () => {
        if (contentView) contentView.webContents.setZoomLevel(0);
    });
    shortcutService.register('goBack', 'CommandOrControl+B', 'Go Back', () => {
        if (contentView && contentView.webContents.navigationHistory.canGoBack()) {
            contentView.webContents.navigationHistory.goBack();
        }
    });
    shortcutService.register('goBackAlt', 'CommandOrControl+P', 'Go Back (Alternative)', () => {
        if (contentView && contentView.webContents.navigationHistory.canGoBack()) {
            contentView.webContents.navigationHistory.goBack();
        }
    });
    shortcutService.register('goForward', 'CommandOrControl+F', 'Go Forward', () => {
        if (contentView && contentView.webContents.navigationHistory.canGoForward()) {
            contentView.webContents.navigationHistory.goForward();
        }
    });
    shortcutService.register('goForwardAlt', 'CommandOrControl+N', 'Go Forward (Alternative)', () => {
        if (contentView && contentView.webContents.navigationHistory.canGoForward()) {
            contentView.webContents.navigationHistory.goForward();
        }
    });
    shortcutService.register('refresh', 'CommandOrControl+R', 'Refresh Page', () => {
        if (contentView) {
            if (headerView && headerView.webContents) {
                headerView.webContents.send('refresh-state-changed', true);
            }
            contentView.webContents.reload();
        }
    });
    console.log(`Initialized ${shortcutService.count} keyboard shortcuts`);
}
app.on('ready', init);
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
app.on('activate', function () {
    if (mainWindow === null) {
        init();
    }
});
app.on('before-quit', () => {
    isQuitting = true;
    lastFmService?.dispose();
    webhookService?.dispose();
    presenceService?.dispose();
    pluginService?.dispose();
    themeService?.dispose();
    settingsManager?.dispose();
    notificationManager?.dispose();
    if (shortcutService) {
        shortcutService.destroy();
    }
    if (tray) {
        tray.destroy();
        tray = null;
    }
});
app.on('will-quit', () => {
    if (tray) {
        tray.destroy();
        tray = null;
    }
});
app.on('second-instance', () => {
    if (!mainWindow) {
        return;
    }
    if (!mainWindow.isVisible()) {
        mainWindow.show();
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.focus();
});
export function queueToastNotification(message: string) {
    if (mainWindow && notificationManager) {
        notificationManager.show(message);
    }
}
function setupTranslationHandlers() {
    ipcMain.handle('get-translations', () => {
        return {
            client: translationService.translate('client'),
            darkMode: translationService.translate('darkMode'),
            adBlocker: translationService.translate('adBlocker'),
            enableAdBlocker: translationService.translate('enableAdBlocker'),
            changesAppRestart: translationService.translate('changesAppRestart'),
            proxy: translationService.translate('proxy'),
            proxyHost: translationService.translate('proxyHost'),
            proxyPort: translationService.translate('proxyPort'),
            enableProxy: translationService.translate('enableProxy'),
            enableLastFm: translationService.translate('enableLastFm'),
            lastfm: translationService.translate('lastfm'),
            lastFmApiKey: translationService.translate('lastFmApiKey'),
            lastFmSecret: translationService.translate('lastFmApiSecret'),
            createApiKeyLastFm: translationService.translate('createApiKeyLastFm'),
            noCallbackUrl: translationService.translate('noCallbackUrl'),
            webhooks: translationService.translate('webhooks'),
            discord: translationService.translate('discord'),
            enableWebhooks: translationService.translate('enableWebhooks'),
            webhookUrl: translationService.translate('webhookUrl'),
            webhookTrigger: translationService.translate('webhookTrigger'),
            webhookDescription: translationService.translate('webhookDescription'),
            showWebhookExample: translationService.translate('showWebhookExample'),
            enableRichPresence: translationService.translate('enableRichPresence'),
            displayWhenPaused: translationService.translate('displayWhenPaused'),
            displaySmallIcon: translationService.translate('displaySmallIcon'),
            displayButtons: translationService.translate('displayButtons'),
            useArtistInStatusLine: translationService.translate('useArtistInStatusLine'),
            enableRichPresencePreview: translationService.translate('enableRichPresencePreview'),
            richPresencePreview: translationService.translate('richPresencePreview'),
            richPresencePreviewDescription: translationService.translate('richPresencePreviewDescription'),
            applyChanges: translationService.translate('applyChanges'),
            minimizeToTray: translationService.translate('minimizeToTray'),
            enableNavigationControls: translationService.translate('enableNavigationControls'),
            enableTrackParser: translationService.translate('enableTrackParser'),
            trackParserDescription: translationService.translate('trackParserDescription'),
            enableAutoUpdater: translationService.translate('enableAutoUpdater'),
            customThemes: translationService.translate('customThemes'),
            selectCustomTheme: translationService.translate('selectCustomTheme'),
            noTheme: translationService.translate('noTheme'),
            openThemesFolder: translationService.translate('openThemesFolder'),
            refreshThemes: translationService.translate('refreshThemes'),
            customThemeDescription: translationService.translate('customThemeDescription'),
            plugins: translationService.translate('plugins'),
            openPluginsFolder: translationService.translate('openPluginsFolder'),
            refreshPlugins: translationService.translate('refreshPlugins'),
            pluginsDescription: translationService.translate('pluginsDescription'),
            noPluginsFound: translationService.translate('noPluginsFound'),
            pressF1ToOpenSettings: translationService.translate('pressF1ToOpenSettings'),
            closeSettings: translationService.translate('closeSettings'),
            noActivityToShow: translationService.translate('noActivityToShow'),
            richPresencePreviewTitle: translationService.translate('richPresencePreviewTitle'),
            hidePromotions: translationService.translate('hidePromotions'),
            hideEventsNearYou: translationService.translate('hideEventsNearYou'),
            hideArtistUpsells: translationService.translate('hideArtistUpsells'),
        };
    });
}
function setupAudioHandler() {
    ipcMain.on('soundcloud:track-progress', (event, data: unknown) => {
        if (!waveVisible || !isTrustedSoundCloudSender(event)) return;
        const update = validateTrackUpdatePayload({ data, reason: 'playback-state-change' });
        if (!update || update.data.url !== lastTrackInfo.url) return;
        lastTrackInfo = { ...lastTrackInfo, elapsed: update.data.elapsed, duration: update.data.duration };
        waveListening.observe(lastTrackInfo.url || '', parseTime(lastTrackInfo.elapsed), lastTrackInfo.isPlaying);
    });
    ipcMain.on('soundcloud:track-update', (event, payload: unknown) => {
        if (!isTrustedSoundCloudSender(event)) {
            console.warn('Rejected track update from untrusted sender');
            return;
        }
        const update = validateTrackUpdatePayload(payload);
        if (!update) {
            console.warn('Rejected invalid track update payload');
            return;
        }
        const { data: result, reason } = update;
        if (devMode) {
            console.debug(`Track update received: ${reason}`);
        }
        waveListening.observe(result.url || '', parseTime(result.elapsed), result.isPlaying);
        onNativeWaveTrackUpdate?.(result);
        lastTrackInfo = result;
        if (waveEngine) {
            waveEngine.observe(result);
            waveHomeView?.webContents.send('wave-home:track', result);
            waveHomeView?.webContents.send('wave-home:stats', waveEngine.stats());
        }
        if (pluginService) {
            pluginService.notifyTrackChange(result as unknown as Record<string, unknown>);
        }
        if (result.title && result.author && result.duration) {
            void Promise.all([
                lastFmService.updateTrackInfo(
                    {
                        title: result.title,
                        author: result.author,
                        duration: result.duration,
                        elapsed: result.elapsed,
                    },
                    result.isPlaying,
                ),
                webhookService.updateTrackInfo(
                    {
                        title: result.title,
                        author: result.author,
                        duration: result.duration,
                        url: result.url,
                        artwork: result.artwork,
                        elapsed: result.elapsed,
                    },
                    result.isPlaying,
                ),
                presenceService.updatePresence(result),
            ]).catch((error) => console.error('Playback integration update failed:', error));
        } else {
            void presenceService.updatePresence(result);
        }
        if (settingsManager) {
            settingsManager.getView()?.webContents.send('presence-preview-update', result);
        }
        if (thumbarService) {
            thumbarService.updateThumbarButtons(mainWindow, result.isPlaying, result.isLiked, contentView, () => {
                if (!waveVisible) return false;
                onWaveNextRequest?.();
                return true;
            });
        }
    });
}
