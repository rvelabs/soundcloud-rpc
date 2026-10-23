import { app, ipcMain, type BrowserView } from 'electron';
import { readFileSync, existsSync, readdirSync, statSync, watch, mkdirSync } from 'fs';
import path, { join, basename, extname } from 'path';
import type ElectronStore from 'electron-store';
import { EventEmitter } from 'events';
import { parseMetadata, type FileMetadata } from '../utils/metadataParser';
import { Script, createContext, type Context } from 'vm';
export interface PluginInfo {
    id: string;
    filePath: string;
    metadata: FileMetadata;
    enabled: boolean;
}
interface PluginRuntime {
    context: Context;
    exports: PluginExports;
    cleanupTimers: () => void;
}
interface PluginExports {
    onEnable?: () => void;
    onDisable?: () => void;
    onTrackChange?: (track: Record<string, unknown>) => void;
    onThemeChange?: (isDark: boolean) => void;
    contentScript?: () => string;
}
export class PluginService {
    private store: ElectronStore;
    private plugins: Map<string, PluginInfo> = new Map();
    private runtimes: Map<string, PluginRuntime> = new Map();
    private pluginsPath: string;
    private emitter = new EventEmitter();
    private stopWatching?: () => void;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private contentView: BrowserView | null = null;
    constructor(store: ElectronStore) {
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
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const cleanupTimers = () => {
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
        };
        try {
            if (this.runtimes.has(id)) return true;
            const source = readFileSync(plugin.filePath, 'utf-8');
            const pluginExports: PluginExports = {};
            const sandbox = {
                module: { exports: pluginExports },
                exports: pluginExports,
                console: {
                    log: (...args: unknown[]) => console.log(`[plugin:${id}]`, ...args),
                    warn: (...args: unknown[]) => console.warn(`[plugin:${id}]`, ...args),
                    error: (...args: unknown[]) => console.error(`[plugin:${id}]`, ...args),
                },
                setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
                    const timer = setTimeout(() => {
                        timers.delete(timer);
                        callback(...args);
                    }, delay);
                    timers.add(timer);
                    return timer;
                },
                clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
                    clearTimeout(timer);
                    timers.delete(timer);
                },
                setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
                    const timer = setInterval(callback, delay, ...args);
                    timers.add(timer);
                    return timer;
                },
                clearInterval: (timer: ReturnType<typeof setTimeout>) => {
                    clearInterval(timer);
                    timers.delete(timer);
                },
            };
            const context = createContext(sandbox);
            const script = new Script(source, { filename: plugin.filePath });
            script.runInContext(context, { timeout: 1000 });
            const resolved = sandbox.module.exports || sandbox.exports;
            this.runtimes.set(id, { context, exports: resolved, cleanupTimers });
            resolved.onEnable?.();
            this.injectContentScript(id, resolved);
            return true;
        } catch (error) {
            cleanupTimers();
            this.runtimes.delete(id);
            console.error(`Failed to activate plugin ${id}:`, error);
            return false;
        }
    }
    private deactivatePlugin(id: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        try {
            runtime.exports.onDisable?.();
        } catch (e) {
            console.error(`[plugin:${id}] onDisable error:`, e);
        }
        this.removeContentScript(id);
        runtime.cleanupTimers();
        this.runtimes.delete(id);
    }
    private injectContentScript(id: string, exports: PluginExports): void {
        if (!this.contentView || this.contentView.webContents.isDestroyed()) return;
        let code: string | undefined;
        try {
            code = exports.contentScript?.();
        } catch (e) {
            console.error(`[plugin:${id}] contentScript() error:`, e);
            return;
        }
        if (!code || !code.trim()) return;
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
            this.injectContentScript(id, runtime.exports);
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
        for (const [id, runtime] of this.runtimes) {
            try {
                runtime.exports.onTrackChange?.({ ...track });
            } catch (e) {
                console.error(`[plugin:${id}] onTrackChange error:`, e);
            }
        }
    }
    public notifyThemeChange(isDark: boolean): void {
        for (const [id, runtime] of this.runtimes) {
            try {
                runtime.exports.onThemeChange?.(isDark);
            } catch (e) {
                console.error(`[plugin:${id}] onThemeChange error:`, e);
            }
        }
    }
    public getPluginsPath(): string {
        return app.isPackaged ? path.join(app.getPath('userData'), 'plugins') : path.join(process.cwd(), 'plugins');
    }
    public onPluginsChanged(listener: () => void): () => void {
        this.emitter.on('plugins-changed', listener);
        return () => this.emitter.off('plugins-changed', listener);
    }
    public dispose(): void {
        clearTimeout(this.refreshTimer);
        this.stopWatching?.();
        for (const id of this.runtimes.keys()) this.deactivatePlugin(id);
        this.emitter.removeAllListeners();
    }
    private setupIpcHandlers(): void {
        ipcMain.handle('get-plugins', () => {
            return this.getPlugins().map((p) => ({
                id: p.id,
                metadata: p.metadata,
                enabled: p.enabled,
            }));
        });
        ipcMain.handle('set-plugin-enabled', (_, id: string, enabled: boolean) => {
            return this.setPluginEnabled(id, enabled);
        });
        ipcMain.handle('get-plugins-folder-path', () => {
            return this.pluginsPath;
        });
        ipcMain.handle('refresh-plugins', () => {
            this.refreshPlugins();
            return this.getPlugins().map((p) => ({
                id: p.id,
                metadata: p.metadata,
                enabled: p.enabled,
            }));
        });
    }
}
