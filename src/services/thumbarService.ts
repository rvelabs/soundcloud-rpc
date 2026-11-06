import { WebContentsView, BrowserWindow, nativeImage } from 'electron';
import * as path from 'path';
import { TranslationService } from './translationService';
import { RESOURCES_PATH } from '../main';
import { controlNativePlayer } from '../soundcloud/nativePlayerBridge';
export class ThumbarService {
    private translationService: TranslationService;
    private icons = new Map<string, ReturnType<typeof nativeImage.createFromPath>>();
    private lastState = '';
    private icon(name: string) {
        let image = this.icons.get(name);
        if (!image) {
            image = nativeImage.createFromPath(path.join(RESOURCES_PATH, 'icons', name + '.ico'));
            this.icons.set(name, image);
        }
        return image;
    }
    constructor(translationService: TranslationService) {
        this.translationService = translationService;
    }
    public updateThumbarButtons(
        win: BrowserWindow | null,
        isPlaying: boolean,
        isLiked: boolean,
        mainWindow: WebContentsView | null,
        onNext?: () => boolean,
    ): void {
        if (!win || !mainWindow || win.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
        const state = [
            win.id,
            mainWindow.webContents.id,
            isPlaying,
            isLiked,
            this.translationService.getLanguage(),
        ].join(':');
        if (state === this.lastState) return;
        this.lastState = state;
        const backwardIcon = this.icon('backward'),
            playIcon = this.icon('play'),
            pauseIcon = this.icon('pause');
        const forwardIcon = this.icon('forward'),
            likeIcon = this.icon('heart'),
            unlikeIcon = this.icon('heart-filled');
        const buttons = [
            {
                tooltip: isLiked
                    ? this.translationService.translate('unlike')
                    : this.translationService.translate('like'),
                icon: isLiked ? unlikeIcon : likeIcon,
                click: () => {
                    void controlNativePlayer(mainWindow.webContents, 'like');
                },
            },
            {
                tooltip: this.translationService.translate('previous'),
                icon: backwardIcon,
                click: () => {
                    void controlNativePlayer(mainWindow.webContents, 'previous');
                },
            },
            {
                tooltip: isPlaying
                    ? this.translationService.translate('pause')
                    : this.translationService.translate('play'),
                icon: isPlaying ? pauseIcon : playIcon,
                click: () => {
                    void controlNativePlayer(mainWindow.webContents, 'toggle');
                },
            },
            {
                tooltip: this.translationService.translate('next'),
                icon: forwardIcon,
                click: () => {
                    if (onNext?.()) return;
                    void controlNativePlayer(mainWindow.webContents, 'next');
                },
            },
        ];
        win.setThumbarButtons(buttons);
    }
}
