import { IpcRegistry } from '../utils/ipcRegistry';
import { app, ipcMain } from 'electron';
import { readFileSync, existsSync, readdirSync, statSync, watch, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';
import type ElectronStore from 'electron-store';
import { EventEmitter } from 'events';
import { extractThemeColors, type ThemeColors } from '../utils/colorExtractor';
import { parseMetadata, type FileMetadata } from '../utils/metadataParser';
export interface CustomTheme {
    name: string;
    filePath: string;
    css: string;
    metadata: FileMetadata;
}
export class ThemeService {
    private store: ElectronStore;
    private customThemes: Map<string, CustomTheme> = new Map();
    private currentCustomTheme: string | null = null;
    private themesPath: string;
    private emitter = new EventEmitter();
    private stopWatching?: () => void;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private ipc: IpcRegistry;
    constructor(store: ElectronStore, allowed: ConstructorParameters<typeof IpcRegistry>[1] = () => false) {
        this.ipc = new IpcRegistry(ipcMain, allowed);
        this.store = store;
        this.themesPath = join(app.getPath('userData'), 'themes');
        this.ensureThemesDirectory();
        this.loadCustomThemes();
        this.setupIpcHandlers();
        this.startWatchingThemesFolder();
        const savedTheme = this.store.get('customTheme') as string;
        if (savedTheme && this.customThemes.has(savedTheme)) {
            this.currentCustomTheme = savedTheme;
        }
    }
    private ensureThemesDirectory(): void {
        try {
            if (!existsSync(this.themesPath)) {
                mkdirSync(this.themesPath, { recursive: true });
                console.log(`Created themes directory at: ${this.themesPath}`);
            }
        } catch (error) {
            console.error('Failed to create themes directory:', error);
        }
    }
    private loadCustomThemes(): void {
        try {
            if (!existsSync(this.themesPath)) {
                return;
            }
            const files = readdirSync(this.themesPath);
            for (const file of files) {
                const filePath = join(this.themesPath, file);
                const stat = statSync(filePath);
                if (stat.isFile() && extname(file).toLowerCase() === '.css') {
                    try {
                        const css = readFileSync(filePath, 'utf-8');
                        const themeName = basename(file, '.css');
                        const metadata = parseMetadata(css, 'css');
                        if (!metadata.name) metadata.name = themeName;
                        this.customThemes.set(themeName, {
                            name: themeName,
                            filePath,
                            css,
                            metadata,
                        });
                        console.log(`Loaded custom theme: ${themeName}`);
                    } catch (error) {
                        console.error(`Failed to load theme ${file}:`, error);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load custom themes:', error);
        }
    }
    private startWatchingThemesFolder(): void {
        try {
            if (!existsSync(this.themesPath)) return;
            if (this.stopWatching) {
                this.stopWatching();
                this.stopWatching = undefined;
            }
            const watcher = watch(this.themesPath, { persistent: true }, (_eventType, filename) => {
                if (!filename || extname(filename).toLowerCase() !== '.css') return;
                clearTimeout(this.refreshTimer);
                this.refreshTimer = setTimeout(() => {
                    try {
                        this.refreshThemes();
                        if (this.currentCustomTheme) {
                            if (!this.customThemes.has(this.currentCustomTheme)) {
                                this.currentCustomTheme = null;
                                this.store.delete('customTheme');
                            }
                            this.emitter.emit('custom-theme-updated', this.currentCustomTheme);
                        }
                    } catch (err) {
                        console.error('Error handling theme file change:', err);
                    }
                }, 150);
            });
            this.stopWatching = () => {
                try {
                    watcher.close();
                } catch {}
            };
        } catch (error) {
            console.error('Failed to watch themes folder:', error);
        }
    }
    private setupIpcHandlers(): void {
        this.ipc.handle('get-custom-themes', () => {
            return Array.from(this.customThemes.values()).map((theme) => ({
                name: theme.name,
                filePath: theme.filePath,
                metadata: theme.metadata,
            }));
        });
        this.ipc.handle('get-current-custom-theme', () => {
            return this.currentCustomTheme;
        });
        this.ipc.handle('apply-custom-theme', (_, themeName: string) => {
            return typeof themeName === 'string' && themeName.length <= 200 && this.applyCustomTheme(themeName);
        });
        this.ipc.handle('remove-custom-theme', () => {
            return this.removeCustomTheme();
        });
        this.ipc.handle('get-themes-folder-path', () => {
            return this.themesPath;
        });
        this.ipc.handle('refresh-custom-themes', () => {
            this.customThemes.clear();
            this.loadCustomThemes();
            return Array.from(this.customThemes.values()).map((theme) => ({
                name: theme.name,
                filePath: theme.filePath,
                metadata: theme.metadata,
            }));
        });
        this.ipc.handle('get-theme-colors', () => {
            return this.getCurrentThemeColors();
        });
    }
    public applyCustomTheme(themeName: string): boolean {
        try {
            if (themeName === 'none') {
                return this.removeCustomTheme();
            }
            const theme = this.customThemes.get(themeName);
            if (!theme) {
                console.error(`Theme ${themeName} not found`);
                return false;
            }
            this.currentCustomTheme = themeName;
            this.store.set('customTheme', themeName);
            this.emitter.emit('custom-theme-updated', themeName);
            console.log(`Applied custom theme: ${themeName}`);
            return true;
        } catch (error) {
            console.error('Failed to apply custom theme:', error);
            return false;
        }
    }
    public removeCustomTheme(): boolean {
        try {
            this.currentCustomTheme = null;
            this.store.delete('customTheme');
            this.emitter.emit('custom-theme-updated', null);
            console.log('Removed custom theme');
            return true;
        } catch (error) {
            console.error('Failed to remove custom theme:', error);
            return false;
        }
    }
    public getCurrentCustomThemeCSS(): string | null {
        if (!this.currentCustomTheme) {
            return null;
        }
        const theme = this.customThemes.get(this.currentCustomTheme);
        return theme ? theme.css : null;
    }
    public getCurrentThemeColors(): ThemeColors | null {
        const css = this.getCurrentCustomThemeCSS();
        if (!css) {
            return null;
        }
        return extractThemeColors(css);
    }
    public getThemesPath(): string {
        return this.themesPath;
    }
    public getAvailableThemes(): CustomTheme[] {
        return Array.from(this.customThemes.values());
    }
    public refreshThemes(): void {
        this.customThemes.clear();
        this.loadCustomThemes();
    }
    public onCustomThemeUpdated(listener: (themeName: string | null) => void): () => void {
        this.emitter.on('custom-theme-updated', listener);
        return () => this.emitter.off('custom-theme-updated', listener);
    }
    public dispose(): void {
        this.ipc.dispose();
        clearTimeout(this.refreshTimer);
        this.stopWatching?.();
        this.emitter.removeAllListeners();
    }
}
