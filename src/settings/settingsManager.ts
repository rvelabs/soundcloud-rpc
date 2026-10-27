import { escapeHtml } from '../utils/html';
import { readFileSync } from 'node:fs';
import { BrowserView, BrowserWindow, type WebContents } from 'electron';
import type ElectronStore from 'electron-store';
import { TranslationService } from '../services/translationService';
import type { ThemeColors } from '../utils/colorExtractor';
import { join } from 'path';
const isMac = process.platform === 'darwin';
export class SettingsManager {
    private view: BrowserView | null = null;
    private isVisible = false;
    private parentWindow: BrowserWindow;
    private store: ElectronStore;
    private translationService: TranslationService;
    private devMode = process.argv.includes('--dev');
    private colors: ThemeColors | null = null;
    private customCSS = '';
    private idleMs = 30000;
    private idleTimer?: ReturnType<typeof setTimeout>;
    constructor(parentWindow: BrowserWindow, store: ElectronStore, translationService: TranslationService) {
        this.parentWindow = parentWindow;
        this.store = store;
        this.translationService = translationService;
        this.parentWindow.on('resize', () => {
            if (this.isVisible) {
                this.updateBounds();
            }
        });
        this.parentWindow.once('closed', () => this.dispose());
    }
    public owns(contents: WebContents): boolean {
        return this.view?.webContents === contents;
    }
    public toggle(): void {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }
    public showUpdates(): void {
        this.show();
        const contents = this.view?.webContents;
        if (!contents || contents.isDestroyed()) return;
        const scroll = () => {
            if (!contents.isDestroyed())
                void contents
                    .executeJavaScript("document.getElementById('updates-section')?.scrollIntoView({block:'start'})")
                    .catch(() => {});
        };
        if (contents.isLoadingMainFrame()) contents.once('did-finish-load', scroll);
        else scroll();
    }
    private createView(): BrowserView {
        if (this.view) return this.view;
        this.view = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                nodeIntegrationInSubFrames: false,
                nodeIntegrationInWorker: false,
                preload: join(__dirname, 'settingsPreload.js'),
                devTools: this.devMode,
                ...(isMac ? { spellcheck: false } : {}),
            },
        });
        this.parentWindow.addBrowserView(this.view);
        this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        this.view.webContents.on('will-navigate', (event) => event.preventDefault());
        this.view.setBounds({ x: 0, y: -10000, width: 0, height: 0 });
        void this.view.webContents
            .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.getHtml())}`)
            .catch(() => {});
        this.view.webContents.on('console-message', (_, __, message) => {
            if (message === 'hidePanel' && !this.isVisible) {
                this.isVisible = false;
                if (this.view) {
                    this.view.setBounds({ x: 0, y: -10000, width: 0, height: 0 });
                }
                clearTimeout(this.idleTimer);
                this.idleTimer = setTimeout(() => {
                    if (!this.isVisible) this.teardownView();
                }, this.idleMs);
                this.idleTimer.unref();
            }
        });
        return this.view;
    }
    private teardownView(): void {
        clearTimeout(this.idleTimer);
        if (!this.view) return;
        try {
            this.parentWindow.removeBrowserView(this.view);
        } catch {}
        try {
            if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
        } catch {}
        this.view = null;
    }
    private updateBounds(): void {
        if (!this.view) return;
        const bounds = this.parentWindow.getBounds();
        const width = Math.min(500, Math.floor(bounds.width * 0.4));
        const HEADER_HEIGHT = 32;
        this.view.setBounds({
            x: bounds.width - width,
            y: HEADER_HEIGHT,
            width,
            height: bounds.height - HEADER_HEIGHT,
        });
    }
    private getHtml(): string {
        const theme = this.store.get('theme', 'dark');
        return `
        <style>
            ${readFileSync(join(__dirname, 'settings.css'), 'utf8')}
        </style>
        <button class="close-btn" id="close-settings" title="${this.translationService.translate('closeSettings')}" data-i18n-title="closeSettings">
            <svg viewBox="0 0 24 24">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
        </button>
        <div class="settings-panel">
            <div class="setting-group">
                <h2 data-i18n="client">${this.translationService.translate('client')}</h2>
                <div class="setting-item">
                    <span data-i18n="darkMode">${this.translationService.translate('darkMode')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="darkMode" ${theme !== 'light' ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="minimizeToTray">${this.translationService.translate('minimizeToTray')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="minimizeToTray" ${this.store.get('minimizeToTray', true) ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="enableNavigationControls">${this.translationService.translate('enableNavigationControls')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="navigationControlsEnabled" ${this.store.get('navigationControlsEnabled', false) ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="uiScale">${this.translationService.translate('uiScale')}</span>
                    <div class="input-with-unit">
                        <input type="range" id="uiScale" min="0.5" max="2" step="0.05" value="${this.store.get('uiScale', 1) as number}">
                        <span class="unit-symbol" id="uiScaleValue">${Math.round((this.store.get('uiScale', 1) as number) * 100)}%</span>
                    </div>
                </div>
                <div class="description" data-i18n="uiScaleDescription">${this.translationService.translate('uiScaleDescription')}</div>
                <section id="updates-section" style="margin:20px 0;padding:16px;border:1px solid var(--border-color,#ffffff22);border-radius:12px;scroll-margin-top:20px">
                    <h3 id="updates-title" style="font-size:16px;margin-bottom:12px">SoundCloud updates</h3>
                    <label id="updates-mode-label" for="updateMode">Update mode</label>
                    <select id="updateMode" class="textInput" style="width:100%;margin:8px 0"><option value="patch" id="update-mode-patch">Automatic: small fixes</option><option value="notify" id="update-mode-notify">Notify only</option><option value="off" id="update-mode-off">No automatic checks</option></select>
                    <p class="description" id="updates-description"></p>
                    <p class="description" id="updates-status" role="status" style="margin:12px 0">…</p>
                    <progress id="updates-progress" max="100" value="0" hidden style="width:100%;height:6px;accent-color:#ff5500;margin-bottom:12px"></progress>
                    <div style="display:flex;flex-wrap:wrap;gap:8px">
                        <button type="button" id="updates-check" class="button">Check now</button>
                        <button type="button" id="updates-download" class="button" hidden>Download update</button>
                        <button type="button" id="updates-install" class="button" hidden>Restart and install</button>
                        <button type="button" id="updates-notes" class="button">What's new</button>
                    </div>
                    <p id="updates-worker-help" class="description" style="margin-top:12px" hidden></p>
                    <button type="button" id="updates-worker-ack" class="button" hidden>Worker updated</button>
                </section>
                <div class="setting-item">
                    <span data-i18n="enableTrackParser">${this.translationService.translate('enableTrackParser')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="trackParserEnabled" ${this.store.get('trackParserEnabled', true) ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="description" data-i18n="trackParserDescription">${this.translationService.translate('trackParserDescription')}</div>
            </div>

            <div class="setting-group">
                <h2>
                    UI Customization
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                    </svg>
                </h2>
                <div class="setting-item">
                    <span data-i18n="hidePromotions">${this.translationService.translate('hidePromotions')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="hidePromotions" ${this.store.get('hidePromotions', true) ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="hideEventsNearYou">${this.translationService.translate('hideEventsNearYou')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="hideEventsNearYou" ${this.store.get('hideEventsNearYou', true) ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="hideArtistUpsells">${this.translationService.translate('hideArtistUpsells')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="hideArtistUpsells" ${this.store.get('hideArtistUpsells', true) ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
			
			<div class="setting-group">
                <h2>
                    Account Manager
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                </h2>
                <div class="setting-item">
                    <span>Switch Account</span>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <select id="accountSelector" class="theme-selector" style="min-width: 120px;">
                        </select>
                        <button id="addAccountBtn" class="theme-button" style="padding: 8px; flex: 0; min-width: 36px; display: flex; justify-content: center;" title="Add Account">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                        </button>
                    </div>
                </div>
                <div class="setting-item" style="margin-top: 4px;">
                    <span></span>
                    <button id="logoutBtn" class="theme-button" style="background: var(--bg-hover); color: #ff5500;">Log Out of Current Account</button>
                </div>
                <div class="description">App will restart to load new session safely.</div>
            </div>

            <div class="setting-group">
                <h2 data-i18n="adBlocker">${this.translationService.translate('adBlocker')}</h2>
                <div class="setting-item">
                    <span data-i18n="enableAdBlocker">${this.translationService.translate('enableAdBlocker')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="adBlocker" ${this.store.get('adBlocker') ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="description" data-i18n="changesAppRestart">${this.translationService.translate('changesAppRestart')}</div>
            </div>

            <div class="setting-group">
                <h2 data-i18n="proxy">${this.translationService.translate('proxy')}</h2>
                <div class="setting-item">
                    <span data-i18n="enableProxy">${this.translationService.translate('enableProxy')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="proxyEnabled" ${this.store.get('proxyEnabled') ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="input-group" id="proxyFields" style="display: ${this.store.get('proxyEnabled') ? 'block' : 'none'}">
                    <input type="text" class="textInput" id="proxyHost" placeholder="${this.translationService.translate('proxyHost')}" data-i18n-placeholder="proxyHost" value="${escapeHtml(this.store.get('proxyHost') || '')}">
                    <input type="text" class="textInput" id="proxyPort" placeholder="${this.translationService.translate('proxyPort')}" data-i18n-placeholder="proxyPort" value="${escapeHtml(this.store.get('proxyPort') || '')}">
                </div>
            </div>

            <div class="setting-group">
                <h2>Резервное подключение SoundCloud</h2>
                <div class="description">Ваш Cloudflare Worker. В автоматическом режиме подключаемся через него только после проверки недоступности SoundCloud. Подключение действует только в этом клиенте.</div>
                <details id="cloudflareWizard" style="margin:14px 0">
                    <summary style="cursor:pointer">Создать и настроить Worker автоматически</summary>
                    <p class="description">Откройте Cloudflare, войдите в аккаунт и создайте API-токен с правами Account Settings: Read и Workers Scripts: Edit для своего аккаунта. Вставьте его сюда. Мастер создаст Worker и его ключ, затем сам сохранит HTTPS-адрес. Токен Cloudflare хранится только в памяти на время настройки.</p>
                    <button class="button" id="cloudflareTokenPage">Открыть Cloudflare</button>
                    <input class="textInput" type="password" autocomplete="new-password" id="cloudflareApiToken" aria-label="API-токен Cloudflare" placeholder="API-токен Cloudflare (не пароль)">
                    <button class="button" id="cloudflareAccounts">Подключить аккаунт</button>
                    <div id="cloudflareAccountFields" hidden>
                        <select class="textInput" id="cloudflareAccount" aria-label="Аккаунт Cloudflare"></select>
                        <p class="description">Обновим сохранённый Worker этого клиента в выбранном аккаунте, сохранив адрес и ключ. Если подходящего Worker нет, создадим отдельный со случайным именем. Остальные Workers и адрес аккаунта сохраняются.</p>
                        <button class="button" id="cloudflareDeploy">Создать или обновить Worker</button>
                        <button class="button" id="cloudflareSetupCancel">Забыть токен</button>
                    </div>
                    <p id="cloudflareSetupStatus" class="description" role="status"></p>
                </details>
                <p class="description">Или укажите адрес уже созданного Worker вручную:</p>
                <select class="textInput" id="cloudflareMode">
                    <option value="off" ${this.store.get('cloudflareMode', 'off') === 'off' ? 'selected' : ''}>Выключено</option>
                    <option value="auto" ${this.store.get('cloudflareMode') === 'auto' ? 'selected' : ''}>Автоматически</option>
                    <option value="always" ${this.store.get('cloudflareMode') === 'always' ? 'selected' : ''}>Всегда через Worker</option>
                </select>
                <input class="textInput" id="cloudflareEndpoint" placeholder="https://your-worker.workers.dev" value="${String(this.store.get('cloudflareEndpoint', '')).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)}">
                <input class="textInput" id="cloudflareSecret" type="password" autocomplete="new-password" placeholder="${this.store.get('cloudflareSecretEncrypted') ? 'Ключ сохранён. Оставьте пустым, чтобы сохранить его.' : 'Ключ Worker (RELAY_TOKEN)'}">
                <button id="cloudflareSave" class="button">Сохранить подключение</button>
                <button id="cloudflareTest" class="button" title="Проверяет сохранённые настройки">Проверить Worker</button>
                <button id="cloudflareCopyDiagnostics" class="button">Скопировать диагностику подключения</button>
                <button id="cloudflareFiles" class="button">Файлы Worker и инструкция</button>
                <p id="cloudflareStatus" role="status" class="description">Для начала разверните Worker из комплекта исходников. Обычный прокси имеет приоритет.</p>
            </div>

            <div class="setting-group">
                <h2 data-i18n="lastfm">
                    ${this.translationService.translate('lastfm')}
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M10.599 17.211l-.881-2.393s-1.433 1.596-3.579 1.596c-1.9 0-3.249-1.652-3.249-4.296 0-3.385 1.708-4.596 3.388-4.596 2.418 0 3.184 1.568 3.845 3.578l.871 2.751c.87 2.672 2.508 4.818 7.238 4.818 3.386 0 5.673-1.037 5.673-3.77 0-2.209-1.258-3.358-3.595-3.906l-1.738-.381c-1.193-.274-1.546-.763-1.546-1.59 0-.934.736-1.485 1.937-1.485 1.313 0 2.024.488 2.14 1.652l2.745-.33c-.225-2.511-1.937-3.541-4.745-3.541-2.479 0-4.897.934-4.897 3.947 0 1.877.902 3.063 3.172 3.608l1.871.439c1.402.332 1.866.916 1.866 1.713 0 1.021-.992 1.441-2.869 1.441-2.779 0-3.936-1.457-4.596-3.469l-.901-2.75c-1.156-3.574-3.004-4.896-6.669-4.896C2.147 5.297 0 7.802 0 12.244c0 4.325 2.208 6.638 6.169 6.638 3.193 0 4.43-1.671 4.43-1.671z"/>
                    </svg>
                </h2>
                <div class="setting-item">
                    <span data-i18n="enableLastFm">${this.translationService.translate('enableLastFm')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="lastFmEnabled" ${this.store.get('lastFmEnabled') ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="input-group" id="lastFmFields" style="display: ${this.store.get('lastFmEnabled') ? 'block' : 'none'}">
                    <input type="text" class="textInput" id="lastFmApiKey" placeholder="${this.translationService.translate('lastFmApiKey')}" data-i18n-placeholder="lastFmApiKey" value="${escapeHtml(this.store.get('lastFmApiKey') || '')}">
                    <input type="password" class="textInput" id="lastFmSecret" placeholder="${this.translationService.translate('lastFmApiSecret')}" data-i18n-placeholder="lastFmApiSecret" value="${escapeHtml(this.store.get('lastFmSecret') || '')}">
                </div>
                <div class="description">
                    <a href="#" id="createLastFmApiKey" class="link" data-i18n="createApiKeyLastFm">${this.translationService.translate('createApiKeyLastFm')}</a>
                    - <span data-i18n="noCallbackUrl">${this.translationService.translate('noCallbackUrl')}</span>
                </div>
            </div>

            <div class="setting-group">
                <h2 data-i18n="webhooks">
                    ${this.translationService.translate('webhooks')}
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M10.59 13.41c.41.39.41 1.03 0 1.42-.39.39-1.03.39-1.42 0a5.003 5.003 0 0 1 0-7.07l3.54-3.54a5.003 5.003 0 0 1 7.07 0 5.003 5.003 0 0 1 0 7.07l-1.49 1.49c.01-.82-.12-1.64-.4-2.42l.47-.48a2.982 2.982 0 0 0 0-4.24 2.982 2.982 0 0 0-4.24 0l-3.53 3.53a2.982 2.982 0 0 0 0 4.24zm2.82-4.24c.39-.39 1.03-.39 1.42 0a5.003 5.003 0 0 1 0 7.07l-3.54 3.54a5.003 5.003 0 0 1-7.07 0 5.003 5.003 0 0 1 0-7.07l1.49-1.49c-.01.82.12 1.64.4 2.42l-.47.48a2.982 2.982 0 0 0 0 4.24 2.982 2.982 0 0 0 4.24 0l3.53-3.53a2.982 2.982 0 0 0 0-4.24z"/>
                    </svg>
                </h2>
                <div class="setting-item">
                    <span data-i18n="enableWebhooks">${this.translationService.translate('enableWebhooks')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="webhookEnabled" ${this.store.get('webhookEnabled') ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="input-group" id="webhookFields" style="display: ${this.store.get('webhookEnabled') ? 'block' : 'none'}">
                    <input type="url" class="textInput" id="webhookUrl" placeholder="${this.translationService.translate('webhookUrl')}" data-i18n-placeholder="webhookUrl" value="${escapeHtml(this.store.get('webhookUrl') || '')}">
                    <div class="setting-item">
                        <span data-i18n="webhookTrigger">${this.translationService.translate('webhookTrigger')}</span>
                        <div class="input-with-unit">
                            <input type="number" id="webhookTriggerPercentage" class="textInput" style="width: 80px;" min="0" max="100" step="1" value="${this.store.get('webhookTriggerPercentage', 50)}">
                            <span class="unit-symbol">%</span>
                        </div>
                    </div>
                </div>
                <div class="description" data-i18n="webhookDescription">
                    ${this.translationService.translate('webhookDescription')}
                </div>
                <div class="webhook-example-container" id="webhookFields2" style="display: ${this.store.get('webhookEnabled') ? 'block' : 'none'}">
                    <div class="example-toggle" id="webhookExampleToggle">
                        <span class="example-toggle-text" data-i18n="showWebhookExample">${this.translationService.translate('showWebhookExample')}</span>
                        <svg class="example-toggle-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                        </svg>
                    </div>
                    <div class="example-content" id="webhookExampleContent" style="display: none;">
                        <pre class="example-json">{
  "timestamp": "2025-08-12T14:30:45.123Z",
  "artist": "Artist Name",
  "track": "Track Title", 
  "duration": 240,
  "trackArt": "https://example.com/artwork.jpg",
  "originUrl": "https://soundcloud.com/track-url"
}</pre>
                    </div>
                </div>
            </div>

            <div class="setting-group">
                <h2 data-i18n="discord">
                    ${this.translationService.translate('discord')}
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M20.317 4.369a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.444.864-.608 1.249a18.707 18.707 0 0 0-5.487 0 12.505 12.505 0 0 0-.617-1.249.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.369a.07.07 0 0 0-.032.027C.533 9.045-.32 13.579.099 18.057a.082.082 0 0 0 .031.056 19.911 19.911 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028c.464-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.105 13.184 13.184 0 0 1-1.872-.9.077.077 0 0 1-.008-.128c.126-.094.252-.192.373-.291a.075.075 0 0 1 .077-.01c3.927 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.122.099.247.197.374.291a.077.077 0 0 1-.006.128 12.509 12.509 0 0 1-1.873.899.076.076 0 0 0-.04.106c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.028 19.876 19.876 0 0 0 6.002-3.03.077.077 0 0 0 .031-.056c.5-5.177-.838-9.665-3.546-13.661a.067.067 0 0 0-.033-.027zM8.02 15.331c-1.182 0-2.156-1.085-2.156-2.419 0-1.333.955-2.418 2.156-2.418 1.213 0 2.187 1.096 2.156 2.419 0 1.333-.955 2.418-2.156 2.418zm7.974 0c-1.182 0-2.156-1.085-2.156-2.419 0-1.333.955-2.418 2.156-2.418 1.213 0 2.187 1.096 2.156 2.419 0 1.333-.943 2.418-2.156 2.418z"/>
                    </svg>
                </h2>
                <div class="setting-item">
                    <span data-i18n="enableRichPresence">${this.translationService.translate('enableRichPresence')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="discordRichPresence" ${this.store.get('discordRichPresence') ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="displayWhenPaused">${this.translationService.translate('displayWhenPaused')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="displayWhenIdling" ${this.store.get('displayWhenIdling') ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="displaySmallIcon">${this.translationService.translate('displaySmallIcon')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="displaySCSmallIcon" ${this.store.get('displaySCSmallIcon') ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="displayButtons">${this.translationService.translate('displayButtons')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="displayButtons" ${this.store.get('displayButtons') ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="useArtistInStatusLine">${this.translationService.translate('useArtistInStatusLine')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="useArtistInStatusLineToggle" ${(this.store.get('statusDisplayType') as number) === 1 ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <span data-i18n="enableRichPresencePreview">${this.translationService.translate('enableRichPresencePreview')}</span>
                    <label class="toggle">
                        <input type="checkbox" id="richPresencePreviewEnabled" ${this.store.get('richPresencePreviewEnabled', false) ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="description" data-i18n="richPresencePreviewDescription">${this.translationService.translate('richPresencePreviewDescription')}</div>
                
                <div class="preview-container" id="presencePreviewContainer" style="display: ${this.store.get('richPresencePreviewEnabled', false) ? 'block' : 'none'}">
                    <div class="preview-panel">
                        <div class="preview-header-inline">
                            <span class="preview-title-inline" data-i18n="richPresencePreviewTitle">${this.translationService.translate('richPresencePreviewTitle')}</span>
                        </div>
                        <div class="discord-preview">
                            <div class="activity-section-preview" id="activitySectionPreview">
                                <div class="no-activity-preview" id="noActivityPreview" data-i18n="noActivityToShow">
                                    ${this.translationService.translate('noActivityToShow')}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="setting-group">
                <h2 data-i18n="customThemes">
                    ${this.translationService.translate('customThemes')}
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22">
                        <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
                    </svg>
                </h2>
                <div class="setting-item">
                    <span data-i18n="selectCustomTheme">${this.translationService.translate('selectCustomTheme')}</span>
                    <select id="customThemeSelector" class="theme-selector">
                        <option value="none" data-i18n="noTheme">${this.translationService.translate('noTheme')}</option>
                    </select>
                </div>
                <div class="theme-controls">
                    <button id="openThemesFolder" class="theme-button" data-i18n="openThemesFolder">${this.translationService.translate('openThemesFolder')}</button>
                    <button id="refreshThemes" class="theme-button" data-i18n="refreshThemes">${this.translationService.translate('refreshThemes')}</button>
                </div>
                <div class="description" data-i18n="customThemeDescription">${this.translationService.translate('customThemeDescription')}</div>
            </div>

            <div class="setting-group">
                <h2 data-i18n="plugins">
                    ${this.translationService.translate('plugins')}
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/>
                    </svg>
                </h2>
                <div class="plugin-list" id="pluginList">
                    <div class="no-plugins" data-i18n="noPluginsFound">${this.translationService.translate('noPluginsFound')}</div>
                </div>
                <div class="theme-controls">
                    <button id="openPluginsFolder" class="theme-button" data-i18n="openPluginsFolder">${this.translationService.translate('openPluginsFolder')}</button>
                    <button id="refreshPlugins" class="theme-button" data-i18n="refreshPlugins">${this.translationService.translate('refreshPlugins')}</button>
                </div>
                <div class="description" data-i18n="pluginsDescription">${this.translationService.translate('pluginsDescription')}</div>
            </div>

            <div class="setting-group">
                <button class="button" id="applyChanges" data-i18n="applyChanges">${this.translationService.translate('applyChanges')}</button>
            </div>
        </div>
        <script>
            ${this.getJavaScript()}
        </script>
`;
    }
    private getJavaScript(): string {
        return readFileSync(join(__dirname, 'settings.js'), 'utf8');
    }
    private execute(script: string): Promise<unknown> {
        const contents = this.view?.webContents;
        if (!contents || contents.isDestroyed()) return Promise.resolve();
        return contents.executeJavaScript(script).catch(() => {});
    }
    private show(): void {
        clearTimeout(this.idleTimer);
        const wasCreated = this.view === null;
        const view = this.createView();
        this.isVisible = true;
        this.updateBounds();
        const applyShowState = () => {
            if (view.webContents.isDestroyed() || !this.isVisible) return;
            void this.execute(`
                document.body.style.opacity;
                document.body.classList.add('visible');
            `);
            this.setThemeColors(this.colors);
            this.setCustomCSS(this.customCSS);
            view.webContents.send('update-translations');
            const isDark = this.store.get('theme', 'dark') === 'dark';
            view.webContents.send('theme-changed', isDark);
            view.webContents.send('settings-visibility', true);
        };
        if (wasCreated) {
            view.webContents.once('did-finish-load', applyShowState);
        } else {
            applyShowState();
        }
    }
    private hide(): void {
        if (!this.view) return;
        this.isVisible = false;
        this.view.webContents.send('settings-visibility', false);
        void this.execute(`
            document.body.classList.remove('visible');
            setTimeout(() => {
                window.postMessage('hidePanel', '*');
            }, 300);
        `);
    }
    public setThemeColors(colors: ThemeColors | null): void {
        this.colors = colors;
        if (!this.view) return;
        if (!colors) {
            void this.execute(`
                document.documentElement.style.removeProperty('--bg-primary');
                document.documentElement.style.removeProperty('--bg-secondary');
                document.documentElement.style.removeProperty('--text-primary');
                document.documentElement.style.removeProperty('--accent');
            `);
            return;
        }
        void this.execute(
            `
            document.documentElement.style.setProperty('--bg-primary', ${JSON.stringify(colors.surface || colors.background)});
            document.documentElement.style.setProperty('--bg-secondary', ${JSON.stringify(colors.background)});
            document.documentElement.style.setProperty('--text-primary', ${JSON.stringify(colors.text)});
            document.documentElement.style.setProperty('--accent', ${JSON.stringify(colors.accent || colors.primary)});
        `,
        ).catch(console.error);
    }
    public setCustomCSS(css: string): void {
        this.customCSS = css;
        void this.execute(`(() => {
            document.getElementById('custom-theme-style')?.remove();
            const css = ${JSON.stringify(css)};
            if (!css.trim()) return;
            const style = document.createElement('style');
            style.id = 'custom-theme-style';
            style.textContent = css;
            document.head.appendChild(style);
        })()`);
    }
    public getView(): BrowserView | null {
        return this.view;
    }
    public updateTranslations(translationService: TranslationService): void {
        this.translationService = translationService;
        if (!this.view) return;
        this.view.webContents.send('update-translations');
    }
    public dispose(): void {
        this.isVisible = false;
        this.teardownView();
    }
}
