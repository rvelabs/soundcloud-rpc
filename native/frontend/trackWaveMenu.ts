import { trackPath } from '../../src/wave/nativeQueue';

const trackRows =
    '.trackItem, .compactTrackListItem, .queueItemView, .soundBadge, .audibleTile, .playableTile, .playControls, .sound';
const trackLinks = [
    'a.soundTitle__title[href]',
    'a.trackItem__trackTitle[href]',
    'a.sound__title[href]',
    'a.soundBadge__titleLink[href]',
    'a.playbackSoundBadge__titleLink[href]',
    'a.audibleTile__audibleHeading[href]',
    'a.playableTile__heading[href]',
    '.queueItemView__title a[href]',
    '.compactTrackListItem__trackTitle[data-permalink-path]',
].join(',');
const menuRoots = '.dropdownMenu, [role="menu"], .activityActions__dropdown, .storyFooter__moreActionsDropdown';

function trackFromTrigger(trigger: HTMLElement): string | undefined {
    const row = trigger.closest(trackRows);
    if (row?.matches('.soundBadge.playlist')) return;
    for (const link of row?.querySelectorAll<HTMLElement>(trackLinks) || []) {
        if (link.closest(trackRows) !== row) continue;
        const address = link.getAttribute('href') || link.dataset.permalinkPath;
        if (!address || !URL.canParse(address, location.href)) continue;
        const path = trackPath(new URL(address, location.href).href);
        if (path && !path.endsWith('/sets')) return 'https://soundcloud.com' + path;
    }
    if (trigger.closest('.listenEngagement') || row?.matches('.sound.listenContext')) {
        const path = trackPath(location.href);
        if (path) return 'https://soundcloud.com' + path;
    }
    return undefined;
}

export function installTrackWaveMenu(
    start: (url: string) => Promise<void>,
    translate: (text: string) => string,
): () => void {
    let item: HTMLElement | undefined;
    let observe: MutationObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let notice: HTMLElement | undefined;
    let noticeTimeout: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
        observe?.disconnect();
        clearTimeout(timeout);
        item?.remove();
        item = undefined;
    };
    const report = (message: string) => {
        notice?.remove();
        clearTimeout(noticeTimeout);
        const next = document.createElement('div');
        next.className = 'sc-track-wave-notice';
        next.setAttribute('role', 'status');
        next.textContent = translate(message);
        document.body.append(next);
        notice = next;
        noticeTimeout = setTimeout(() => next.remove(), 5000);
    };
    const click = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        const trigger = event.target.closest<HTMLElement>(
            '.sc-button-more, [aria-haspopup][aria-owns][title="More"], button[title="More"]',
        );
        if (!trigger) {
            if (!event.target.closest(menuRoots) && !event.target.closest('.sc-track-wave-action')) close();
            return;
        }
        close();
        const url = trackFromTrigger(trigger);
        if (!url) return;
        const insert = () => {
            if (item?.isConnected || !trigger.isConnected || trigger.getAttribute('aria-expanded') === 'false') return;
            const controlled = trigger.getAttribute('aria-owns') || trigger.getAttribute('aria-controls');
            const menu = controlled ? document.getElementById(controlled) : undefined;
            const candidates = controlled
                ? menu
                    ? [menu]
                    : []
                : [...document.querySelectorAll<HTMLElement>(menuRoots)];
            const visible = candidates.filter(
                (entry) => entry.getClientRects().length && getComputedStyle(entry).visibility !== 'hidden',
            );
            if (visible.length !== 1) return;
            const actions = [...visible[0].querySelectorAll<HTMLElement>('button, a, [role="menuitem"]')];
            const station = actions.find(
                (entry) =>
                    entry.matches('.sc-button-startstation, .sc-button-station, .startStation, .playStation') ||
                    /^(?:station|start station|станция|запустить станцию)$/i.test(entry.textContent?.trim() || ''),
            );
            const reference = station || actions.find((entry) => entry.matches('.addToNextUp, .sc-button-addtoset'));
            if (!reference) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sc-button sc-track-wave-action';
            button.textContent = translate('Волна по треку');
            if (visible[0].matches('[role="menu"]') || reference.matches('[role="menuitem"]'))
                button.setAttribute('role', 'menuitem');
            const row = reference.closest('li');
            if (row && visible[0].contains(row)) {
                item = document.createElement('li');
                item.append(button);
                row.after(item);
            } else {
                item = button;
                reference.after(button);
            }
            button.addEventListener('click', (action) => {
                action.preventDefault();
                action.stopPropagation();
                trigger.click();
                close();
                void start(url).catch((error) =>
                    report(error instanceof Error ? error.message : 'Не удалось запустить волну'),
                );
            });
        };
        observe = new MutationObserver(insert);
        observe.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-expanded', 'aria-owns', 'aria-controls', 'hidden', 'class', 'style'],
        });
        queueMicrotask(insert);
        timeout = setTimeout(() => observe?.disconnect(), 1500);
    };
    document.addEventListener('click', click, true);
    return () => {
        document.removeEventListener('click', click, true);
        close();
        clearTimeout(noticeTimeout);
        notice?.remove();
    };
}
