import { attachWindowView, detachWindowView } from '../utils/windowViews';
import { WebContentsView, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import type { ThemeColors } from '../utils/colorExtractor';
import { join } from 'path';
const isMac = process.platform === 'darwin';
export class NotificationManager {
    private view: WebContentsView | null = null;
    private queue: string[] = [];
    private isDisplaying = false;
    private parentWindow: BrowserWindow;
    private themeColors: ThemeColors | null = null;
    private devMode = process.argv.includes('--dev');
    private cancelDone?: () => void;
    private timer?: ReturnType<typeof setTimeout>;
    constructor(parentWindow: BrowserWindow) {
        this.parentWindow = parentWindow;
        parentWindow.once('closed', () => this.dispose());
    }
    private ensureView(): WebContentsView {
        if (this.view) return this.view;
        this.view = new WebContentsView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                nodeIntegrationInSubFrames: false,
                nodeIntegrationInWorker: false,
                preload: join(__dirname, 'notificationPreload.js'),
                devTools: this.devMode,
                ...(isMac ? { spellcheck: false } : {}),
            },
        });
        this.view.setBackgroundColor('#00000000');
        return this.view;
    }
    private teardownView(): void {
        if (!this.view) return;
        const view = this.view;
        try {
            detachWindowView(this.parentWindow, view);
        } catch {}
        try {
            if (!view.webContents.isDestroyed()) view.webContents.close();
        } catch {}
        this.view = null;
    }
    public setThemeColors(colors: ThemeColors | null): void {
        this.themeColors = colors;
    }
    public show(message: string): void {
        if (this.parentWindow.isDestroyed() || this.queue.includes(message)) return;
        if (this.queue.length >= 30) this.queue.shift();
        this.queue.push(message);
        if (!this.isDisplaying) {
            this.displayNext();
        }
    }
    private displayNext(): void {
        if (this.queue.length === 0) {
            this.isDisplaying = false;
            this.teardownView();
            return;
        }
        this.isDisplaying = true;
        const message = this.queue.shift();
        const bounds = this.parentWindow.getBounds();
        const width = 400;
        const height = 70;
        const view = this.ensureView();
        attachWindowView(this.parentWindow, view);
        view.setBounds({
            x: Math.floor((bounds.width - width) / 2),
            y: bounds.height - height - 100,
            width,
            height,
        });
        const backgroundColor = this.themeColors?.surface || '#303030';
        const textColor = this.themeColors?.text || '#ffffff';
        const html = `
        <style>
            body {
                margin: 0;
                display: flex;
                justify-content: center;
                align-items: center;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background-color: transparent;
                color: ${textColor};
                height: 100vh;
                opacity: 0;
                transition: opacity 0.3s ease-in-out;
                overflow: hidden;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
            }
            .notification {
                padding: 15px 25px;
                border-radius: 12px;
                font-size: 18px;
                font-weight: 600;
                text-align: center;
                transform: translateY(0);
                transition: transform 0.3s ease-in-out;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 90%;
                user-select: none;
                -webkit-user-select: none;
                background: ${backgroundColor};
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
            body.fade-out .notification {
                transform: translateY(10px);
            }
        </style>
        <body>
            <div class="notification">${String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
            <script>
                setTimeout(() => document.body.style.opacity = '1', 100);
                setTimeout(() => {
                    document.body.classList.add('fade-out');
                    document.body.style.opacity = '0';
                    setTimeout(() => {
                        window.notificationAPI.done();
                    }, 300);
                }, 4500);
            </script>
        </body>`;
        const done = (event?: IpcMainEvent) => {
            if (event && event.sender !== view.webContents) return;
            this.cancelDone?.();
            this.timer = setTimeout(() => {
                if (!this.parentWindow.isDestroyed()) this.displayNext();
            }, 100);
        };
        ipcMain.on('notification-done', done);
        this.cancelDone = () => {
            clearTimeout(this.timer);
            ipcMain.removeListener('notification-done', done);
            this.cancelDone = undefined;
        };
        this.timer = setTimeout(done, 6000);
        void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => done());
    }
    public dispose(): void {
        this.cancelDone?.();
        clearTimeout(this.timer);
        this.queue = [];
        this.isDisplaying = false;
        const view = this.view;
        this.view = null;
        if (view) {
            if (!this.parentWindow.isDestroyed()) detachWindowView(this.parentWindow, view);
            if (!view.webContents.isDestroyed()) view.webContents.close();
        }
    }
}
