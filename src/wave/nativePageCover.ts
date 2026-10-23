import { BrowserView, type BrowserWindow } from 'electron';
import { nativePresentations as covers } from './nativePresentation';
export function installNativePageCover(window: BrowserWindow, content: BrowserView): void {
    let overlay: BrowserView | undefined;
    let bottom = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
        if (!overlay || window.isDestroyed()) return;
        const bounds = content.getBounds();
        overlay.setBounds({ ...bounds, height: Math.max(1, bounds.height - bottom) });
    };
    const dispose = () => {
        clearTimeout(idle);
        if (!overlay) return;
        if (!window.isDestroyed()) window.removeBrowserView(overlay);
        if (!overlay.webContents.isDestroyed()) overlay.webContents.close();
        overlay = undefined;
    };
    window.on('resize', resize);
    content.webContents.once('destroyed', () => {
        covers.delete(content.webContents);
        window.removeListener('resize', resize);
        dispose();
    });
    covers.set(content.webContents, async () => {
        clearTimeout(idle);
        const contents = content.webContents;
        if (window.isDestroyed() || contents.isDestroyed()) throw new Error('Окно SoundCloud закрыто.');
        const page = (await contents.executeJavaScript(`(() => {
            const r = document.querySelector('.playControls')?.getBoundingClientRect();
            return { x:scrollX, y:scrollY, height:innerHeight,
                top:r && r.height > 0 && r.top >= 0 && r.top < innerHeight ? Math.floor(r.top) : innerHeight };
        })()`)) as {
            x: number;
            y: number;
            height: number;
            top: number;
        };
        const bounds = content.getBounds();
        const coveredHeight = Math.max(1, Math.min(bounds.height, Math.floor(page.top * contents.getZoomFactor())));
        const image = await contents.capturePage({ x: 0, y: 0, width: bounds.width, height: coveredHeight });
        if (image.isEmpty()) throw new Error('Не удалось подготовить незаметный переход SoundCloud. Повторите подбор.');
        try {
            if (!overlay || overlay.webContents.isDestroyed()) {
                overlay = new BrowserView({
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                        backgroundThrottling: false,
                    },
                });
                overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
                await overlay.webContents.loadURL(
                    'data:text/html;charset=utf-8,' +
                        encodeURIComponent(
                            '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' +
                                '<style>html,body{margin:0;height:100%;overflow:hidden;background:#111}img{display:block;width:100%;height:100%}</style>' +
                                '<img alt="" draggable="false">',
                        ),
                );
            }
            const view = overlay;
            bottom = Math.max(0, bounds.height - coveredHeight);
            resize();
            await view.webContents.executeJavaScript(`(async()=>{
                const image=document.querySelector('img');
                await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=${JSON.stringify(image.toDataURL())};});
            })()`);
            window.addBrowserView(view);
            window.setTopBrowserView(view);
            await view.webContents.capturePage().catch(() => {});
            let finished = false;
            return async () => {
                if (finished) return;
                finished = true;
                try {
                    if (!contents.isDestroyed()) {
                        await contents.executeJavaScript(`scrollTo(${page.x},${page.y})`).catch(() => {});
                        await contents.capturePage().catch(() => {});
                    }
                } finally {
                    if (!window.isDestroyed()) window.removeBrowserView(view);
                    if (!view.webContents.isDestroyed())
                        await view.webContents
                            .executeJavaScript("document.querySelector('img').removeAttribute('src')")
                            .catch(() => {});
                    idle = setTimeout(dispose, 30000);
                }
            };
        } catch (error) {
            dispose();
            throw error;
        }
    });
}
