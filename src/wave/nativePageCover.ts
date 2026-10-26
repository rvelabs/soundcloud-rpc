import { BrowserView, type BrowserWindow, type WebContents, type Rectangle, type NativeImage } from 'electron';
import { nativePresentations as covers } from './nativePresentation';
export function installNativePageCover(window: BrowserWindow, content: BrowserView): void {
    const contents = content.webContents;
    let overlay: BrowserView | undefined;
    let bottom = 0;
    let lastFrame = '';
    let idle: ReturnType<typeof setTimeout> | undefined;
    const alive = () => !window.isDestroyed() && !contents.isDestroyed();
    const visible = () => alive() && window.isVisible() && !window.isMinimized();
    const capture = async (target: WebContents, rect?: Rectangle): Promise<NativeImage | undefined> => {
        if (!visible() || target.isDestroyed()) return undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                target.capturePage(rect, { stayHidden: true }).catch(() => undefined),
                new Promise<undefined>((resolve) => {
                    timeout = setTimeout(() => resolve(undefined), 500);
                }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
    };
    const resize = () => {
        if (!overlay || !alive()) return;
        const bounds = content.getBounds();
        overlay.setBounds({ ...bounds, height: Math.max(1, bounds.height - bottom) });
    };
    const dispose = () => {
        clearTimeout(idle);
        if (!overlay) return;
        if (!window.isDestroyed()) window.removeBrowserView(overlay);
        const viewContents = overlay.webContents;
        if (viewContents && !viewContents.isDestroyed()) viewContents.close();
        overlay = undefined;
        lastFrame = '';
    };
    window.on('resize', resize);
    contents.once('destroyed', () => {
        covers.delete(contents);
        window.removeListener('resize', resize);
        dispose();
    });
    covers.set(contents, async () => {
        clearTimeout(idle);
        if (!alive()) throw new Error('Окно SoundCloud закрыто.');
        const page = (await contents.executeJavaScript(`(() => {
            const r=document.querySelector('.playControls')?.getBoundingClientRect();
            return {x:scrollX,y:scrollY,height:innerHeight,top:r&&r.height>0&&r.top>=0&&r.top<innerHeight?Math.floor(r.top):innerHeight};
        })()`)) as { x: number; y: number; height: number; top: number };
        if (!alive()) throw new Error('Окно SoundCloud закрыто.');
        const bounds = content.getBounds();
        const coveredHeight = Math.max(1, Math.min(bounds.height, Math.floor(page.top * contents.getZoomFactor())));
        const image = await capture(contents, { x: 0, y: 0, width: bounds.width, height: coveredHeight });
        if (image && !image.isEmpty()) lastFrame = image.toDataURL();
        try {
            if (!alive()) throw new Error('Окно SoundCloud закрыто.');
            if (!overlay?.webContents || overlay.webContents.isDestroyed()) {
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
                            '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';img-src data:;style-src \'unsafe-inline\'">' +
                                '<style>html,body{margin:0;height:100%;overflow:hidden;background:#111}img{display:block;width:100%;height:100%}[hidden]{display:none!important}.fallback{height:100%;display:flex;align-items:center;justify-content:center;gap:12px;color:#bbb;font:16px Arial;background:radial-gradient(ellipse at 55% 40%,#32202d,#111 65%)}.fallback i{width:8px;height:8px;border-radius:50%;background:#f50}</style>' +
                                '<img alt="" draggable="false" hidden><div class="fallback"><i></i>SoundCloud</div>',
                        ),
                );
            }
            if (!alive() || !overlay?.webContents) throw new Error('Окно SoundCloud закрыто.');
            const view = overlay;
            const viewContents = view.webContents;
            bottom = Math.max(0, bounds.height - coveredHeight);
            resize();
            await viewContents.executeJavaScript(`(async()=>{
                const image=document.querySelector('img'),fallback=document.querySelector('.fallback'),src=${JSON.stringify(lastFrame)};
                if(src){await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=src});image.hidden=false;fallback.hidden=true;}
                else {image.hidden=true;fallback.hidden=false;}
            })()`);
            if (!alive() || viewContents.isDestroyed()) throw new Error('Окно SoundCloud закрыто.');
            window.addBrowserView(view);
            window.setTopBrowserView(view);
            await capture(viewContents);
            let finished = false;
            return async () => {
                if (finished) return;
                finished = true;
                try {
                    if (!contents.isDestroyed()) {
                        await contents.executeJavaScript(`scrollTo(${page.x},${page.y})`).catch(() => {});
                        await capture(contents);
                    }
                } finally {
                    if (!window.isDestroyed() && !viewContents.isDestroyed()) window.removeBrowserView(view);
                    if (!viewContents.isDestroyed())
                        await viewContents
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
