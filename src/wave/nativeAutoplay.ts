import type { WebContents } from 'electron';
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function setStationAutoplay(contents: WebContents, enabled: boolean): Promise<boolean | null> {
    if (contents.isDestroyed()) return null;
    const opened = (await contents.executeJavaScript(
        `(() => {
        const panel = document.querySelector('.queue');
        const show = document.querySelector('.playbackSoundBadge__showQueue');
        if (!panel || !show) return null;
        const wasOpen = panel.classList.contains('m-visible');
        const visibility = panel.style.visibility;
        if (!wasOpen) { panel.style.visibility = 'hidden'; show.click(); }
        return { wasOpen, visibility };
    })()`,
        true,
    )) as {
        wasOpen: boolean;
        visibility: string;
    } | null;
    if (!opened) return null;
    try {
        let state: boolean | null = null;
        for (let i = 0; i < 40; i++) {
            state = (await contents.executeJavaScript(
                `(() => {
                const label = document.querySelector('.queueFallback__toggle label');
                return label ? label.classList.contains('sc-toggle-on') : null;
            })()`,
                true,
            )) as boolean | null;
            if (state !== null) break;
            await wait(100);
        }
        if (state === null) return null;
        if (state !== enabled) {
            const clicked = (await contents.executeJavaScript(
                `(() => {
                const input = document.querySelector('.queueFallback__toggle input');
                if (!input) return false;
                input.click();
                return true;
            })()`,
                true,
            )) as boolean;
            if (!clicked) return null;
            let confirmed = false;
            for (let i = 0; i < 20; i++) {
                confirmed = (await contents.executeJavaScript(
                    `(() => {
                    const label = document.querySelector('.queueFallback__toggle label');
                    return !!label && label.classList.contains('sc-toggle-on') === ${enabled};
                })()`,
                    true,
                )) as boolean;
                if (confirmed) break;
                await wait(100);
            }
            if (!confirmed) return null;
        }
        return state;
    } finally {
        if (!contents.isDestroyed() && !opened.wasOpen)
            await contents
                .executeJavaScript(
                    `(() => {
            const panel = document.querySelector('.queue');
            if (panel?.classList.contains('m-visible')) document.querySelector('.queue__hide')?.click();
            if (panel) panel.style.visibility = ${JSON.stringify(opened.visibility)};
        })()`,
                    true,
                )
                .catch(() => {});
    }
}
