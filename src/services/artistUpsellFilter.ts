export function installArtistUpsellFilter(enabled: boolean): void {
    const page = window as typeof window & {
        _artistUpsellInterval?: ReturnType<typeof setInterval>;
        __disposeArtistUpsells?: () => void;
    };
    clearInterval(page._artistUpsellInterval);
    page.__disposeArtistUpsells?.();
    if (!enabled) return;
    const selector = 'iframe[title="Artist tools"],iframe[title="Sidebar modules"]';
    const frames = new Map<
        HTMLIFrameElement,
        { load: () => void; observer?: MutationObserver; style?: HTMLStyleElement; container?: HTMLElement }
    >();
    const containers = new Map<HTMLElement, string>();
    const attach = (frame: HTMLIFrameElement) => {
        if (frames.has(frame)) return;
        const state: {
            load: () => void;
            observer?: MutationObserver;
            style?: HTMLStyleElement;
            container?: HTMLElement;
        } = { load: () => {} };
        state.load = () => {
            state.observer?.disconnect();
            state.style?.remove();
            if (state.container && containers.has(state.container))
                state.container.style.display = containers.get(state.container)!;
            try {
                const doc = frame.contentDocument;
                if (!doc?.head || !doc.body) return;
                doc.getElementById('custom-iframe-style')?.remove();
                const style = doc.createElement('style');
                style.id = 'custom-iframe-style';
                style.textContent = '.MuiBox-root:has(a[href*="getstarted/fan-support"]) { display: none !important; }';
                doc.head.append(style);
                state.style = style;
                const refresh = () => {
                    const container = frame.closest<HTMLElement>('.webiEmbeddedModuleContainer');
                    if (!container) return;
                    state.container = container;
                    if (!containers.has(container)) containers.set(container, container.style.display);
                    const display = doc.querySelector('svg[aria-label="Paywalled feature"]')
                        ? 'none'
                        : containers.get(container)!;
                    if (container.style.display !== display) container.style.display = display;
                };
                state.observer = new MutationObserver(refresh);
                state.observer.observe(doc.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['aria-label'],
                });
                refresh();
            } catch {}
        };
        frames.set(frame, state);
        frame.addEventListener('load', state.load);
        state.load();
    };
    const cleanupFrame = (frame: HTMLIFrameElement) => {
        const state = frames.get(frame);
        state?.observer?.disconnect();
        state?.style?.remove();
        if (state) frame.removeEventListener('load', state.load);
        frames.delete(frame);
        const container = state?.container;
        if (container && ![...frames.values()].some((item) => item.container === container)) {
            if (containers.has(container)) container.style.display = containers.get(container)!;
            containers.delete(container);
        }
    };
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === 'attributes' && record.target instanceof HTMLIFrameElement) {
                if (record.target.matches(selector)) attach(record.target);
                else cleanupFrame(record.target);
            }
            for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches(selector)) attach(node as HTMLIFrameElement);
                for (const frame of node.querySelectorAll<HTMLIFrameElement>(selector)) attach(frame);
            }
        }
        for (const frame of frames.keys()) if (!frame.isConnected) cleanupFrame(frame);
        for (const container of containers.keys()) if (!container.isConnected) containers.delete(container);
    });
    for (const frame of document.querySelectorAll<HTMLIFrameElement>(selector)) attach(frame);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['title'],
    });
    const onHide = (event: PageTransitionEvent) => {
        if (!event.persisted) page.__disposeArtistUpsells?.();
    };
    page.addEventListener('pagehide', onHide);
    page.__disposeArtistUpsells = () => {
        observer.disconnect();
        for (const frame of frames.keys()) cleanupFrame(frame);
        for (const [container, display] of containers) container.style.display = display;
        containers.clear();
        page.removeEventListener('pagehide', onHide);
        delete page.__disposeArtistUpsells;
    };
}
