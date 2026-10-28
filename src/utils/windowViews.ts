import type { BrowserWindow, WebContentsView } from 'electron';
const owners = new WeakMap<BrowserWindow, Set<WebContentsView>>();
export function attachWindowView(window: BrowserWindow, view: WebContentsView): void {
    if (window.isDestroyed() || view.webContents.isDestroyed()) return;
    let views = owners.get(window);
    if (!views) {
        views = new Set();
        owners.set(window, views);
        const owned = views;
        window.once('closed', () => {
            for (const current of [...owned])
                if (!current.webContents.isDestroyed()) current.webContents.close({ waitForBeforeUnload: false });
            owned.clear();
            owners.delete(window);
        });
    }
    if (!views.has(view)) {
        views.add(view);
        const owned = views;
        view.webContents.once('destroyed', () => owned.delete(view));
    }
    window.contentView.addChildView(view);
}
export function detachWindowView(window: BrowserWindow, view: WebContentsView): void {
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
}
