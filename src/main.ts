import { createWaveController } from './wave/waveController';
import { createPlaylistImportController } from './import/playlistImportController';
import { attachWindowView } from './utils/windowViews';
import { WorkerSetup } from './network/workerSetup';
import { ConnectionRecovery } from './network/connectionRecovery';

import { installNativePageCover } from './wave/nativePageCover';
import {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    WebContentsView,
    Tray,
    nativeImage,
    shell,
    components,
    safeStorage,
    clipboard,
    dialog,
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

import { WindowTasks } from './utils/windowTasks';

import { IpcRegistry } from './utils/ipcRegistry';
import { validSetting } from './settings/validateSetting';
import { AsyncDataStore } from './storage/asyncDataStore';
import { writeFile, rename, readFile } from 'node:fs/promises';
import { UpdateController, type UpdateMode, type UpdateState } from './updates/updateController';
import { presentUpdate } from './updates/presentation';
import { waveEnglish, translateWaveText } from './wave/i18n';

import { trackPath } from './wave/nativeQueue';

import { audioMonitorScript } from './services/audioMonitorService';
import { installArtistUpsellFilter } from './services/artistUpsellFilter';
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
        updateMode: 'patch',
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
let updateController: UpdateController | undefined;
let proxyService: ProxyService;
let presenceService: PresenceService;
let lastFmService: LastFmService;
let webhookService: WebhookService;
let translationService: TranslationService;
let thumbarService: ThumbarService;
let themeService: ThemeService;
let shortcutService: ShortcutService;
let pluginService: PluginService;
let libraryStore: AsyncDataStore | undefined;
let libraryOpening: Promise<AsyncDataStore> | undefined;
let diagnosticWrite: Promise<void> = Promise.resolve();
let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
let waveController: ReturnType<typeof createWaveController> | undefined;
let stopWindowWork: (() => void) | undefined;
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
            'stale-media-event',
            'media-error-captured',
            'native-handoff-stalled',
            'native-cleanup-failed',
            'transition-failed',
            'transition-retry-failed',
        ].includes(event)
    )
        return;
    clearTimeout(diagnosticTimer);
    diagnosticTimer = setTimeout(() => {
        const snapshot = JSON.stringify({ capturedAt: new Date().toISOString(), events: waveTrace }, null, 2);
        const file = path.join(app.getPath('userData'), 'wave-diagnostics.json');
        diagnosticWrite = diagnosticWrite
            .then(async () => {
                await writeFile(file + '.tmp', snapshot);
                await rename(file + '.tmp', file);
            })
            .catch((error) => console.debug('Wave diagnostic write unavailable:', error));
    }, 750);
    diagnosticTimer.unref();
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
    if (updateController) return;
    const supported =
        app.isPackaged &&
        process.platform === 'win32' &&
        !process.env.PORTABLE_EXECUTABLE_DIR &&
        existsSync(path.join(process.resourcesPath, 'app-update.yml'));
    const backend = supported ? autoUpdater : undefined;
    backend?.setFeedURL({ provider: 'github', owner: 'rvelabs', repo: 'soundcloud-rpc', releaseType: 'release' });
    const metadata = require('../package.json') as { version: string; workerProtocolRevision?: number };
    const savedMode = store.get('updateMode', 'patch');
    updateController = new UpdateController(backend, {
        currentVersion: app.isPackaged ? app.getVersion() : metadata.version,
        mode: (['patch', 'notify', 'off'].includes(savedMode) ? savedMode : 'patch') as UpdateMode,
        installSupported: supported,
        canCheck: supported,
        workerRevision: metadata.workerProtocolRevision || 2,
        usesWorker: () => Boolean(store.get('cloudflareEndpoint', '')),
        pendingWorker: () => Number(store.get('pendingWorkerUpdate', 0)),
        setPendingWorker: (revision) => store.set('pendingWorkerUpdate', revision),
        changed: broadcastUpdate,
        notify: (state) => queueToastNotification(updateView(state).badge),
        beforeInstall: () => {
            isQuitting = true;
            Object.assign(app, { isQuitting: true });
        },
    });
    updateController.start();
}
function updateView(state = updateController!.snapshot()) {
    const language = store.get('waveInterfaceLanguage', 'auto');
    return presentUpdate(
        state,
        language === 'ru' || (language === 'auto' && app.getLocale().toLowerCase().startsWith('ru')),
    );
}
function broadcastUpdate(state: UpdateState) {
    const view = updateView(state);
    for (const contents of [headerView?.webContents, settingsManager?.getView()?.webContents])
        if (contents && !contents.isDestroyed()) contents.send('updates:state', view);
}
for (const channel of [
    'updates:status',
    'updates:check',
    'updates:download',
    'updates:install',
    'updates:mode',
    'updates:release-notes',
    'updates:worker-ack',
]) {
    ipcMain.handle(channel, async (event, value: unknown) => {
        if (
            !settingsManager?.owns(event.sender) &&
            !(channel === 'updates:status' && event.sender === headerView?.webContents)
        )
            throw new Error('Untrusted update action');
        if (!updateController) throw new Error('Updater is not ready');
        if (channel === 'updates:check') await updateController.check();
        if (channel === 'updates:download') void updateController.download();
        if (channel === 'updates:install') updateController.install();
        if (channel === 'updates:mode') {
            updateController.setMode(value);
            store.set('updateMode', value);
        }
        if (channel === 'updates:worker-ack') updateController.acknowledgeWorker();
        if (channel === 'updates:release-notes') await shell.openExternal(updateView().releaseUrl);
        return updateView();
    });
}
ipcMain.on('updates:open', (event) => {
    if (event.sender !== headerView?.webContents) return;
    settingsManager?.showUpdates();
});
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
function getLanguage() {
    const selected = store.get('waveInterfaceLanguage', 'auto');
    translationService.setLanguage(
        selected === 'ru' || (selected === 'auto' && app.getLocale().toLowerCase().startsWith('ru')) ? 'ru' : 'en',
    );
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
    updateDialogBounds(mainWindow);
}
function setupWindowControls() {
    if (!mainWindow) return;
    windowIpc.on('minimize-window', () => {
        if (!mainWindow) return;
        const minimizeToTray = store.get('minimizeToTray', true);
        if (minimizeToTray) {
            mainWindow.hide();
        } else {
            mainWindow.minimize();
        }
    });
    windowIpc.on('maximize-window', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    });
    windowIpc.on('title-bar-double-click', () => {
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
    windowIpc.on('close-window', () => {
        if (mainWindow) {
            const minimizeToTray = store.get('minimizeToTray', true);
            if (minimizeToTray) {
                mainWindow.hide();
            } else {
                mainWindow.close();
            }
        }
    });
    windowIpc.on('navigate-back', () => {
        if (contentView && contentView.webContents.navigationHistory.canGoBack()) {
            contentView.webContents.navigationHistory.goBack();
        }
    });
    windowIpc.on('navigate-forward', () => {
        if (contentView && contentView.webContents.navigationHistory.canGoForward()) {
            contentView.webContents.navigationHistory.goForward();
        }
    });
    windowIpc.on('refresh-page', () => {
        if (contentView) {
            if (headerView && headerView.webContents) {
                headerView.webContents.send('refresh-state-changed', true);
            }
            console.log('Manual refresh triggered - reloading page');
            contentView.webContents.reload();
        }
    });
    windowIpc.on('cancel-refresh', () => {
        if (contentView) {
            contentView.webContents.stop();
            if (headerView && headerView.webContents) {
                headerView.webContents.send('refresh-state-changed', false);
            }
        }
    });
    windowIpc.on('toggle-theme', () => {
        isDarkTheme = !isDarkTheme;
        if (headerView && headerView.webContents) {
            headerView.webContents.send('theme-changed', isDarkTheme);
        }
        applyThemeToContent(isDarkTheme);
    });
    windowIpc.handle('is-maximized', () => {
        return mainWindow ? mainWindow.isMaximized() : false;
    });
    windowIpc.handle('get-minimize-to-tray', () => {
        return store.get('minimizeToTray', true);
    });
    windowIpc.handle('get-navigation-controls-enabled', () => {
        return store.get('navigationControlsEnabled', false);
    });
    adjustContentViews();
}
let headerView: WebContentsView | null;
let contentView: WebContentsView;
const windowIpc = new IpcRegistry(ipcMain, (event, channel) => {
    if (isQuitting) return false;
    if (/^(wave-inline:|playlist-import:|soundcloud:)/.test(channel)) return isTrustedSoundCloudSender(event);
    return settingsManager?.owns(event.sender) === true || headerView?.webContents === event.sender;
});

async function init() {
    libraryOpening ??= AsyncDataStore.open(app.getPath('userData'), store, {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
    });
    libraryStore = await libraryOpening;
    await libraryStore.migrate(store);
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
    mainWindow.on('query-session-end', () => updateController?.systemShutdown());
    mainWindow.on('session-end', () => updateController?.systemShutdown());
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
    headerView = new WebContentsView({
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
    attachWindowView(mainWindow, headerView);
    const notifyWindowState = () => {
        if (headerView?.webContents && !headerView.webContents.isDestroyed() && !mainWindow.isDestroyed())
            headerView.webContents.send('window-state-changed', mainWindow.isMaximized());
    };
    mainWindow.on('maximize', notifyWindowState);
    mainWindow.on('unmaximize', notifyWindowState);
    headerView.setBounds({ x: 0, y: 0, width: mainWindow.getBounds().width, height: 32 });
    headerView.webContents.loadFile(path.join(__dirname, 'header', 'header.html'));
    const currentAccountId = store.get('currentAccountId', 'default');
    const sessionPartition = currentAccountId === 'default' ? undefined : `persist:sc_${currentAccountId}`;
    contentView = new WebContentsView({
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
            backgroundThrottling: false,
            ...(isMac ? { spellcheck: false } : {}),
        },
    });
    attachWindowView(mainWindow, contentView);
    const clientContents = contentView.webContents;
    const clientWindow = mainWindow;
    const windowTasks = new WindowTasks(() => !clientWindow.isDestroyed() && !clientContents.isDestroyed());
    clientContents.once('destroyed', () => windowTasks.dispose());
    contentView.setBounds({
        x: 0,
        y: 32,
        width: mainWindow.getBounds().width,
        height: mainWindow.getBounds().height - 32,
    });
    installNativePageCover(mainWindow, contentView);
    clientContents.setUserAgent(globalUserAgent);
    translationService = new TranslationService();
    getLanguage();
    themeService = new ThemeService(
        store,
        (event, channel) =>
            settingsManager?.owns(event.sender) === true ||
            (channel === 'get-theme-colors' && headerView?.webContents === event.sender),
    );
    pluginService = new PluginService(store, (event) => settingsManager?.owns(event.sender) === true);
    pluginService.setContentView(contentView);
    const availabilityRoute = () =>
        JSON.stringify([
            currentAccountId,
            store.get('proxyEnabled'),
            store.get('proxyHost'),
            store.get('proxyPort'),
            store.get('cloudflareMode'),
            store.get('cloudflareEndpoint'),
        ]);

    const windowImport = createPlaylistImportController({
        window: mainWindow,
        contents: clientContents,
        libraryStore,
        account: String(currentAccountId),
        userAgent: globalUserAgent,
        trusted: isTrustedSoundCloudSender,
        playing: () => Boolean(waveController?.active || lastTrackInfo.isPlaying),
        connection: () => connectionRecovery,
        russian: () => translationService.getLanguage() === 'ru',
        availabilityRoute,
        trace: traceWave,
    });
    const windowWave = (waveController = createWaveController({
        window: mainWindow,
        contents: clientContents,
        store,
        libraryStore,
        account: String(currentAccountId),
        userAgent: globalUserAgent,
        trusted: isTrustedSoundCloudSender,
        getTrack: () => lastTrackInfo,
        setTrack: (track) => {
            lastTrackInfo = track;
        },
        quitting: () => isQuitting,
        availabilityRoute,
        trace: traceWave,
        events: () => waveTrace.slice(-80),
        importDiagnostics: () => windowImport.diagnostics(),
        languageChanged: () => {
            getLanguage();
            settingsManager?.updateTranslations(translationService);
            if (updateController) broadcastUpdate(updateController.snapshot());
        },
    }));
    const stopControllers = () => {
        windowTasks.dispose();
        windowImport.dispose();
        windowWave.stop();
    };
    stopWindowWork = stopControllers;
    mainWindow.once('closed', () => {
        stopControllers();
        windowIpc.dispose();
        lastFmService?.dispose();
        webhookService?.dispose();
        presenceService?.dispose();
        themeService?.dispose();
        pluginService?.dispose();
        settingsManager?.dispose();
        notificationManager?.dispose();
        shortcutService?.destroy();
    });
    themeService.onCustomThemeUpdated(() => {
        applyThemeToContent(isDarkTheme);
    });
    notificationManager = new NotificationManager(mainWindow);
    settingsManager = new SettingsManager(mainWindow, store, translationService);
    proxyService = new ProxyService(mainWindow, store, queueToastNotification, clientContents.session);
    const connectionRecovery = new ConnectionRecovery(clientContents, store, queueToastNotification);
    let networkSettingsBusy = false;
    const workerSetup = new WorkerSetup();
    clientContents.once('destroyed', () => workerSetup.clear());
    windowIpc.handle('network:setup-accounts', async (event, token: unknown) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Подождите окончания настройки.');
        networkSettingsBusy = true;
        try {
            return await workerSetup.authorize(token);
        } finally {
            networkSettingsBusy = false;
        }
    });
    windowIpc.handle('network:setup-cancel', (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Дождитесь окончания текущей операции.');
        workerSetup.clear();
    });
    windowIpc.handle('network:setup-deploy', async (event, account: unknown) => {
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
                    source: readFileSync(path.join(folder, 'playlist-source.mjs'), 'utf8'),
                },
                (message) => {
                    if (!event.sender.isDestroyed()) event.sender.send('network:setup-progress', message);
                },
                connectionRecovery.workerSetupTarget(),
            );
            const applyNow = !store.get('proxyEnabled');
            connectionRecovery.save({ mode: 'auto', endpoint: result.endpoint, secret: result.secret });
            workerSetup.clear();
            updateController?.acknowledgeWorker();
            await connectionRecovery.configure(true);
            return { endpoint: result.endpoint, name: result.name, applied: applyNow, updated: result.updated };
        } finally {
            networkSettingsBusy = false;
        }
    });
    windowIpc.handle('network:files', async (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        return shell.openPath(
            app.isPackaged
                ? path.join(process.resourcesPath, 'soundcloud-relay')
                : path.join(__dirname, '../cloudflare/soundcloud-relay'),
        );
    });
    windowIpc.handle('network:status', (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        return connectionRecovery.getStatus(translationService.getLanguage() === 'ru' ? 'ru' : 'en');
    });
    windowIpc.handle('network:save', async (event, input: unknown) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Подождите окончания проверки подключения.');
        networkSettingsBusy = true;
        try {
            connectionRecovery.save(input);
            await proxyService.apply();
            await connectionRecovery.configure(true);
            return connectionRecovery.getStatus(translationService.getLanguage() === 'ru' ? 'ru' : 'en');
        } finally {
            networkSettingsBusy = false;
        }
    });
    windowIpc.handle('network:test', async (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Подождите окончания проверки подключения.');
        networkSettingsBusy = true;
        try {
            await connectionRecovery.testRelay();
            return connectionRecovery.getTestMessage(translationService.getLanguage() === 'ru' ? 'ru' : 'en');
        } finally {
            networkSettingsBusy = false;
        }
    });
    windowIpc.handle('network:copy-diagnostics', async (event) => {
        if (!settingsManager.owns(event.sender)) throw new Error('Недоверенная страница настроек.');
        if (networkSettingsBusy) throw new Error('Дождитесь окончания проверки подключения.');
        const diagnostic = connectionRecovery.getDiagnostics();
        if (!diagnostic) return 'Сначала нажмите «Проверить Worker».';
        const connection = await connectionRecovery.getPageDiagnostics();
        clipboard.writeText(JSON.stringify({ version: app.getVersion(), relay: diagnostic, connection }, null, 2));
        return 'Диагностика подключения скопирована. Она не содержит ключей, cookies и токенов.';
    });
    presenceService = new PresenceService(store, translationService);
    lastFmService = new LastFmService(contentView, store, libraryStore);
    webhookService = new WebhookService(store, libraryStore);
    shortcutService = new ShortcutService(mainWindow);
    shortcutService.attachToWebContents(clientContents);
    if (platform() === 'win32') thumbarService = new ThumbarService(translationService);
    setupMemoryPressureHandler();
    windowIpc.on('toggle-settings', () => {
        settingsManager.toggle();
        applyThemeToContent(isDarkTheme);
    });
    windowIpc.handle('confirm-open-homepage', async (_event, url: string) => {
        if (!url || typeof url !== 'string') return false;
        const normalizedUrl = url.trim();
        if (!/^https?:\/\//i.test(normalizedUrl)) return false;
        const confirmed = await showHomepageConfirmDialog(mainWindow, normalizedUrl);
        if (confirmed) {
            await shell.openExternal(normalizedUrl);
        }
        return confirmed;
    });
    windowIpc.on('show-plugin-homepage-dialog', async (_event, url: string) => {
        if (!url || typeof url !== 'string') return;
        const normalizedUrl = url.trim();
        if (!/^https?:\/\//i.test(normalizedUrl)) return;
        const confirmed = await showHomepageConfirmDialog(mainWindow, normalizedUrl);
        if (confirmed) {
            await shell.openExternal(normalizedUrl);
        }
    });
    windowIpc.handle('open-external-url', async (_event, url: string) => {
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
    windowIpc.handle('open-path', async (_event, targetPath: string) => {
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
    windowIpc.handle('get-current-track', (event) => {
        return settingsManager.owns(event.sender) ? lastTrackInfo : null;
    });
    await proxyService.apply();
    await connectionRecovery.configure();
    function updateNavigationState() {
        if (headerView && headerView.webContents && contentView) {
            const state = {
                canGoBack: clientContents.navigationHistory.canGoBack(),
                canGoForward: clientContents.navigationHistory.canGoForward(),
            };
            headerView.webContents.send('navigation-state-changed', state);
        }
    }
    clientContents.on('did-navigate', () => {
        updateNavigationState();
    });
    clientContents.on('did-navigate-in-page', () => {
        updateNavigationState();
        windowWave.routeChanged();
    });
    clientContents.on('did-start-loading', () => {
        if (headerView && headerView.webContents) {
            headerView.webContents.send('refresh-state-changed', true);
        }
    });
    clientContents.on('did-stop-loading', () => {
        if (headerView && headerView.webContents) {
            headerView.webContents.send('refresh-state-changed', false);
        }
        updateNavigationState();
    });
    clientContents.on('did-fail-load', () => {
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
                    path: path.join(app.getPath('userData'), 'adblock-v2.bin'),
                    read: (file) => readFile(file),
                    write: (file, data) => writeFile(file, data),
                },
            );
            blocker.enableBlockingInSession(clientContents.session);
        } catch (error) {
            console.error('Failed to initialize adblocker:', error);
        }
    }
    let isInitialLoad = true;
    clientContents.on('did-finish-load', async () => {
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
            if (new URL(clientContents.getURL()).origin === 'https://soundcloud.com') {
                await clientContents.insertCSS(readFileSync(path.join(__dirname, 'wave', 'inline.css'), 'utf8'));
                await clientContents.executeJavaScript(
                    `window.__waveEnglish=${JSON.stringify(waveEnglish)};
                    window.__waveTranslate=(${translateWaveText.toString()});
                    window.__waveInitialLanguage=${JSON.stringify(store.get('waveInterfaceLanguage', 'auto'))};
                    window.__waveSystemLocale=${JSON.stringify(app.getLocale())};\n` +
                        readFileSync(path.join(__dirname, 'wave', 'inline.js'), 'utf8'),
                );
            }
            clientContents.setZoomFactor(store.get('uiScale', 1) as number);
            await clientContents.executeJavaScript(audioMonitorScript);
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
    windowIpc.on('setting-changed', async (_event, data) => {
        if (!validSetting(data)) return;
        const key = proxyService.transformKey(data.key);
        store.set(key, data.value);
        console.log(key);
        if (key === 'displayWhenIdling') {
            displayWhenIdling = data.value === true;
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon);
        } else if (key === 'displaySCSmallIcon') {
            displaySCSmallIcon = data.value === true;
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon);
        } else if (key === 'displayButtons') {
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon, data.value === true);
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
            webhookService.setEnabled(data.value === true);
        } else if (key === 'webhookUrl') {
            webhookService.setWebhookUrl(String(data.value));
        } else if (key === 'webhookTriggerPercentage') {
            webhookService.setTriggerPercentage(Number(data.value));
        } else if (key === 'navigationControlsEnabled') {
            if (headerView && headerView.webContents) {
                headerView.webContents.send('navigation-controls-toggle', data.value);
            }
        } else if (key === 'uiScale') {
            if (contentView) clientContents.setZoomFactor(Number(data.value));
        } else if (key === 'customTheme') {
            if (data.value === 'none') {
                themeService.removeCustomTheme();
            } else {
                themeService.applyCustomTheme(String(data.value));
            }
            applyThemeToContent(isDarkTheme);
        } else if (key === 'hidePromotions' || key === 'hideEventsNearYou' || key === 'hideArtistUpsells') {
            applyThemeToContent(isDarkTheme);
        }
    });
    windowIpc.handle('get-accounts', () => {
        return {
            accounts: store.get('accounts', [{ id: 'default', name: 'Main Account' }]),
            currentAccountId: store.get('currentAccountId', 'default'),
        };
    });
    windowIpc.on('switch-account', (_, accountId) => {
        if (
            typeof accountId !== 'string' ||
            !((store.get('accounts') || []) as Array<{ id: string }>).some((account) => account.id === accountId)
        )
            return;
        store.set('currentAccountId', accountId);
        app.relaunch();
        app.quit();
    });
    windowIpc.on('add-account', () => {
        const newId = `acc_${Date.now()}`;
        const accounts = store.get('accounts', [{ id: 'default', name: 'Main Account' }]);
        accounts.push({ id: newId, name: 'New Account' });
        store.set('accounts', accounts);
        store.set('currentAccountId', newId);
        app.relaunch();
        app.quit();
    });
    windowIpc.on('logout-account', async () => {
        const currentId = store.get('currentAccountId', 'default');
        if (contentView) {
            await clientContents.session.clearStorageData();
        }
        if (currentId !== 'default') {
            const accounts = store.get('accounts', [{ id: 'default', name: 'Main Account' }]);
            const filteredAccounts = accounts.filter((a: { id: string }) => a.id !== currentId);
            store.set('accounts', filteredAccounts);
            store.set('currentAccountId', 'default');
            app.relaunch();
            app.quit();
        } else {
            if (contentView) clientContents.reload();
        }
    });
    windowIpc.on('apply-changes', async () => {
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
    const updateAccountName = async () => {
        if (accountPollBusy || !contentView || clientContents.isDestroyed()) return;
        accountPollBusy = true;
        try {
            const username = await clientContents.executeJavaScript(`
				(() => {
					try {
						const profileBtn = document.querySelector('.header__userNav [data-menu-name="profile"]');
						if (profileBtn && profileBtn.href) {
							const parts = profileBtn.href.split('/');
							return parts[parts.length - 1];
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
    };
    const scheduleAccountName = () =>
        windowTasks.defer(() => {
            void updateAccountName();
        }, 1000);
    clientContents.on('did-finish-load', scheduleAccountName);
    clientContents.on('did-navigate-in-page', scheduleAccountName);
    void clientContents.loadURL('https://soundcloud.com/').catch(() => {});
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
    windowIpc.on('setting-changed', (_, data) => {
        if (!validSetting(data)) return;
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
                (${installArtistUpsellFilter.toString()})(${hideArtistUpsells});
                const contentCSS = ${JSON.stringify(sections.all + (sections.all && sections.content ? '\n' : '') + sections.content || '')};
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
                    const css = ${JSON.stringify(headerCSS)};
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
        settingsManager.setCustomCSS(settingsCSS);
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
let initialization: Promise<void> | undefined;
function initializeClient(): Promise<void> {
    if (initialization) return initialization;
    const task = init();
    initialization = task;
    const clear = () => {
        if (initialization === task) initialization = undefined;
    };
    void task.then(clear, clear);
    return task;
}
function startupFailed(error: unknown): void {
    console.error('Client startup failed:', error);
    dialog.showErrorBox(
        'SoundCloud',
        'Не удалось загрузить локальные данные. Они сохранены без изменений. ' +
            (error instanceof Error ? error.message : String(error)),
    );
    app.quit();
}
app.on('ready', () => {
    void initializeClient().catch(startupFailed);
});
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
app.on('activate', function () {
    if (!isQuitting && (!mainWindow || mainWindow.isDestroyed())) {
        void initializeClient().catch(startupFailed);
    }
});
let libraryClosed = false;
let libraryClosing: Promise<void> | undefined;
app.on('before-quit', (event) => {
    isQuitting = true;
    if (libraryStore && !libraryClosed) {
        stopWindowWork?.();
        lastFmService?.dispose();
        webhookService?.dispose();
        event.preventDefault();
        libraryClosing ??= libraryStore
            .close()
            .catch((error) => {
                console.error('Library flush failed:', error);
            })
            .then(() => {
                libraryClosed = true;
                app.quit();
            });
        return;
    }
    updateController?.dispose();
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
    windowIpc.handle('get-translations', () => translationService.getAll());
}
function setupAudioHandler() {
    windowIpc.on('soundcloud:track-progress', (event, data: unknown) => {
        if (!isTrustedSoundCloudSender(event)) return;
        const update = validateTrackUpdatePayload({ data, reason: 'playback-state-change' });
        if (!update || update.data.url !== lastTrackInfo.url) return;
        lastTrackInfo = { ...lastTrackInfo, elapsed: update.data.elapsed, duration: update.data.duration };
        waveController?.onProgress(lastTrackInfo);
    });
    windowIpc.on('soundcloud:track-update', (event, payload: unknown) => {
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
        waveController?.onTrack(result);
        lastTrackInfo = result;
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
                return waveController?.next() || false;
            });
        }
    });
}
