import { IpcRegistry } from '../utils/ipcRegistry';
import { app, ipcMain, type BrowserView } from 'electron';
import { readFileSync, existsSync, readdirSync, statSync, watch, mkdirSync } from 'fs';
import path, { join, basename, extname } from 'path';
import type ElectronStore from 'electron-store';
import { EventEmitter } from 'events';
import { parseMetadata, type FileMetadata } from '../utils/metadataParser';
import { PluginHost } from './pluginHost';
export interface PluginInfo {
    id: string;
    filePath: string;
    metadata: FileMetadata;
    enabled: boolean;
}
export class PluginService {
    private store: ElectronStore;
    private plugins: Map<string, PluginInfo> = new Map();
    private runtimes: Map<string, PluginHost> = new Map();
    private pluginsPath: string;
    private emitter = new EventEmitter();
    private stopWatching?: () => void;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private contentView: BrowserView | null = null;
    private ipc: IpcRegistry;
    constructor(store: ElectronStore, allowed: ConstructorParameters<typeof IpcRegistry>[1] = () => false) {
        this.ipc = new IpcRegistry(ipcMain, allowed);
        this.store = store;
        this.pluginsPath = this.getPluginsPath();
        this.ensurePluginsDirectory();
        this.scanPlugins();
        this.setupIpcHandlers();
        this.startWatching();
        this.enableSavedPlugins();
    }
    private ensurePluginsDirectory(): void {
        try {
            if (!existsSync(this.pluginsPath)) {
                mkdirSync(this.pluginsPath, { recursive: true });
            }
        } catch (error) {
            console.error('Failed to create plugins directory:', error);
        }
    }
    private scanPlugins(): void {
        try {
            if (!existsSync(this.pluginsPath)) return;
            const enabledMap = (this.store.get('enabledPlugins', {}) as Record<string, boolean>) || {};
            const files = readdirSync(this.pluginsPath);
            for (const file of files) {
                const filePath = join(this.pluginsPath, file);
                const stat = statSync(filePath);
                if (!stat.isFile() || extname(file).toLowerCase() !== '.js') continue;
                try {
                    const source = readFileSync(filePath, 'utf-8');
                    const metadata = parseMetadata(source, 'js');
                    const id = basename(file, '.js');
                    if (!metadata.name) metadata.name = id;
                    this.plugins.set(id, {
                        id,
                        filePath,
                        metadata,
                        enabled: !!enabledMap[id],
                    });
                } catch (error) {
                    console.error(`Failed to load plugin ${file}:`, error);
                }
            }
        } catch (error) {
            console.error('Failed to scan plugins:', error);
        }
    }
    private startWatching(): void {
        try {
            if (!existsSync(this.pluginsPath)) return;
            if (this.stopWatching) {
                this.stopWatching();
                this.stopWatching = undefined;
            }
            const watcher = watch(this.pluginsPath, { persistent: true }, (_eventType, filename) => {
                if (!filename || extname(filename).toLowerCase() !== '.js') return;
                clearTimeout(this.refreshTimer);
                this.refreshTimer = setTimeout(() => this.refreshPlugins(), 150);
            });
            this.stopWatching = () => {
                try {
                    watcher.close();
                } catch {}
            };
        } catch (error) {
            console.error('Failed to watch plugins folder:', error);
        }
    }
    private enableSavedPlugins(): void {
        for (const [id, plugin] of this.plugins) {
            if (plugin.enabled) {
                this.activatePlugin(id);
            }
        }
    }
    private activatePlugin(id: string): boolean {
        const plugin = this.plugins.get(id);
        if (!plugin) return false;
        try {
            if (this.runtimes.has(id)) return true;
            const source = readFileSync(plugin.filePath, 'utf-8');
            const host = new PluginHost(source, plugin.filePath, (error) => {
                console.error(`Plugin ${id} stopped:`, error.message);
                if (this.runtimes.get(id) !== host) return;
                this.runtimes.delete(id);
                plugin.enabled = false;
                this.removeContentScript(id);
                this.persistEnabledState();
                this.emitter.emit('plugins-changed');
            });
            this.runtimes.set(id, host);
            void host.ready
                .then(() => this.injectContentScript(id, host))
                .catch((error) => {
                    console.error(`Failed to activate plugin ${id}:`, error.message);
                    host.dispose();
                    if (this.runtimes.get(id) !== host) return;
                    this.runtimes.delete(id);
                    plugin.enabled = false;
                    this.persistEnabledState();
                    this.emitter.emit('plugins-changed');
                });
            return true;
        } catch (error) {
            console.error(`Failed to activate plugin ${id}:`, error);
            return false;
        }
    }
    private deactivatePlugin(id: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        this.removeContentScript(id);
        this.runtimes.delete(id);
        void runtime.ready
            .then(() => runtime.call('onDisable'))
            .catch(() => {})
            .finally(() => runtime.dispose());
    }
    private async injectContentScript(id: string, runtime: PluginHost): Promise<void> {
        if (!this.contentView || this.contentView.webContents.isDestroyed()) return;
        const code = await runtime.call('contentScript');
        if (
            typeof code !== 'string' ||
            !code.trim() ||
            this.runtimes.get(id) !== runtime ||
            !this.contentView ||
            this.contentView.webContents.isDestroyed()
        )
            return;
        const wrapped = `
            (function(){
                try {
                    var existing = document.getElementById(${JSON.stringify('scrpc-plugin-' + id)});
                    if (existing) existing.remove();
                    var s = document.createElement('script');
                    s.id = ${JSON.stringify('scrpc-plugin-' + id)};
                    s.textContent = ${JSON.stringify(code)};
                    document.head.appendChild(s);
                } catch(e) { console.error(${JSON.stringify('[plugin:' + id + '] inject error:')}, e); }
            })();
        `;
        this.contentView.webContents.executeJavaScript(wrapped).catch((e: Error) => {
            console.error(`[plugin:${id}] content script injection failed:`, e);
        });
    }
    private removeContentScript(id: string): void {
        if (!this.contentView || this.contentView.webContents.isDestroyed()) return;
        const cleanup = `
            (function(){
                var el = document.getElementById(${JSON.stringify('scrpc-plugin-' + id)});
                if (el) el.remove();
                if (window.__scrpc_cleanup_${id.replace(/[^a-zA-Z0-9_]/g, '_')}) {
                    try { window.__scrpc_cleanup_${id.replace(/[^a-zA-Z0-9_]/g, '_')}(); } catch(e) {}
                    delete window.__scrpc_cleanup_${id.replace(/[^a-zA-Z0-9_]/g, '_')};
                }
            })();
        `;
        this.contentView.webContents.executeJavaScript(cleanup).catch(() => {});
    }
    public setContentView(view: BrowserView): void {
        this.contentView = view;
    }
    public injectAllContentScripts(): void {
        for (const [id, runtime] of this.runtimes) {
            void this.injectContentScript(id, runtime).catch((error) =>
                console.error('Plugin content update failed:', error.message),
            );
        }
    }
    private persistEnabledState(): void {
        const map: Record<string, boolean> = {};
        for (const [id, plugin] of this.plugins) {
            if (plugin.enabled) map[id] = true;
        }
        this.store.set('enabledPlugins', map);
    }
    public setPluginEnabled(id: string, enabled: boolean): boolean {
        const plugin = this.plugins.get(id);
        if (!plugin) return false;
        if (enabled) {
            const activated = this.activatePlugin(id);
            plugin.enabled = activated;
            this.persistEnabledState();
            return activated;
        } else {
            this.deactivatePlugin(id);
            plugin.enabled = false;
            this.persistEnabledState();
            return true;
        }
    }
    public getPlugins(): PluginInfo[] {
        return Array.from(this.plugins.values());
    }
    public refreshPlugins(): void {
        const previouslyEnabled = new Set<string>();
        for (const [id, plugin] of this.plugins) {
            if (plugin.enabled) previouslyEnabled.add(id);
        }
        for (const id of this.runtimes.keys()) {
            this.deactivatePlugin(id);
        }
        this.plugins.clear();
        this.scanPlugins();
        for (const id of previouslyEnabled) {
            const plugin = this.plugins.get(id);
            if (plugin) {
                plugin.enabled = true;
                this.activatePlugin(id);
            }
        }
        this.persistEnabledState();
        this.emitter.emit('plugins-changed');
    }
    public notifyTrackChange(track: Record<string, unknown>): void {
        for (const runtime of this.runtimes.values()) runtime.notify('onTrackChange', { ...track });
    }
    public notifyThemeChange(isDark: boolean): void {
        for (const runtime of this.runtimes.values()) runtime.notify('onThemeChange', isDark);
    }
    public getPluginsPath(): string {
        return process.argv.includes('--dev')
            ? path.join(process.cwd(), 'plugins')
            : path.join(app.getPath('userData'), 'plugins');
    }
    public onPluginsChanged(listener: () => void): () => void {
        this.emitter.on('plugins-changed', listener);
        return () => this.emitter.off('plugins-changed', listener);
    }
    public dispose(): void {
        this.ipc.dispose();
        clearTimeout(this.refreshTimer);
        this.stopWatching?.();
        for (const id of this.runtimes.keys()) this.deactivatePlugin(id);
        this.emitter.removeAllListeners();
    }
    private setupIpcHandlers(): void {
        this.ipc.handle('get-plugins', () => {
            return this.getPlugins().map((p) => ({
                id: p.id,
                metadata: p.metadata,
                enabled: p.enabled,
            }));
        });
        this.ipc.handle('set-plugin-enabled', (_, id: string, enabled: boolean) => {
            return (
                typeof id === 'string' &&
                id.length <= 200 &&
                typeof enabled === 'boolean' &&
                this.setPluginEnabled(id, enabled)
            );
        });
        this.ipc.handle('get-plugins-folder-path', () => {
            return this.pluginsPath;
        });
        this.ipc.handle('refresh-plugins', () => {
            this.refreshPlugins();
            return this.getPlugins().map((p) => ({
                id: p.id,
                metadata: p.metadata,
                enabled: p.enabled,
            }));
        });
    }
}
