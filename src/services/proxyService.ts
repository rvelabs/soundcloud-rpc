import { app, BrowserWindow, type Session } from 'electron';
import type ElectronStore from 'electron-store';
interface ProxyData {
    user: string;
    password: string;
}
export class ProxyService {
    private window: BrowserWindow;
    private store: ElectronStore;
    private targetSession: Session;
    private onNotification: (message: string) => void;
    constructor(
        window: BrowserWindow,
        store: ElectronStore,
        notifyCallback: (message: string) => void,
        targetSession?: Session,
    ) {
        this.window = window;
        this.targetSession = targetSession || window.webContents.session;
        this.store = store;
        this.onNotification = notifyCallback;
        const login = (
            event: Electron.Event,
            contents: Electron.WebContents,
            _request: Electron.AuthenticationResponseDetails,
            auth: Electron.AuthInfo,
            callback: (username?: string, password?: string) => void,
        ) => {
            if (contents.session !== this.targetSession || !auth.isProxy || !this.store.get('proxyEnabled')) return;
            const expectedHost = String(this.store.get('proxyHost', ''))
                .trim()
                .replace(/^\[|\]$/g, '')
                .toLowerCase();
            if (auth.host.toLowerCase() !== expectedHost || auth.port !== Number(this.store.get('proxyPort'))) return;
            const credentials = this.handleAuth(auth);
            if (!credentials.username && !credentials.password) return;
            event.preventDefault();
            callback(credentials.username, credentials.password);
        };
        app.on('login', login);
        window.once('closed', () => app.removeListener('login', login));
    }
    async apply(): Promise<void> {
        if (!this.window) return;
        const proxyEnabled = this.store.get('proxyEnabled');
        const proxyHost = this.store.get('proxyHost');
        const proxyPort = this.store.get('proxyPort');
        if (proxyEnabled && proxyHost && proxyPort) {
            try {
                const host = String(proxyHost).trim(),
                    port = Number(proxyPort);
                const address = new URL(`http://${host}:${port}`);
                if (
                    !Number.isInteger(port) ||
                    port < 1 ||
                    port > 65535 ||
                    address.username ||
                    address.password ||
                    address.pathname !== '/' ||
                    address.search ||
                    address.hash ||
                    !address.hostname
                )
                    throw new Error('Invalid proxy address');
                await this.targetSession.setProxy({
                    proxyRules: address.origin,
                });
                await this.targetSession.closeAllConnections();
                console.log('Proxy enabled for SoundCloud session');
            } catch (err) {
                console.error('Failed to set proxy:', err);
                this.onNotification('Failed to set proxy. Check your settings.');
            }
        } else {
            await this.targetSession.setProxy({ mode: 'system' });
            await this.targetSession.closeAllConnections();
        }
    }
    handleAuth(auth: Electron.AuthInfo): {
        username: string;
        password: string;
    } {
        if (!auth.isProxy || !this.store.get('proxyEnabled')) {
            return { username: '', password: '' };
        }
        const proxyData = this.store.get('proxyData') as ProxyData | undefined;
        return {
            username: proxyData?.user || '',
            password: proxyData?.password || '',
        };
    }
    transformKey(key: string): string {
        const keyMap: Record<string, string> = {
            proxyEnabled: 'proxyEnabled',
            proxyHost: 'proxyHost',
            proxyPort: 'proxyPort',
            proxyData: 'proxyData',
        };
        return keyMap[key] || key;
    }
}
