const ipcRenderer = {
    send: (channel, ...args) => window.headerAPI.send(channel, ...args),
    invoke: (channel, ...args) => window.headerAPI.invoke(channel, ...args),
    on: (channel, listener) => window.headerAPI.on(channel, (...args) => listener(null, ...args)),
};
const platform = window.headerAPI.platform;
let isMaximized = false;
let canGoBack = false;
let canGoForward = false;
let isRefreshing = false;
let navButtons = null;
let themeColors = null;
let minimizeGlyphEl = null;
let maximizeGlyphEl = null;
let closeGlyphEl = null;
const SEGOE_GLYPHS = {
    minimize: '\uE921',
    maximize: '\uE922',
    restore: '\uE923',
    close: '\uE8BB',
    closeHighContrast: '\uEF2C',
};
const forcedColorsQuery = window.matchMedia ? window.matchMedia('(forced-colors: active)') : null;
function applyThemeColors(colors) {
    themeColors = colors;
    if (!colors) {
        document.documentElement.style.removeProperty('--header-bg');
        document.documentElement.style.removeProperty('--header-text');
        document.documentElement.style.removeProperty('--header-accent');
        const header = document.querySelector('.custom-header');
        if (header) {
            header.style.removeProperty('background-color');
            header.style.removeProperty('color');
        }
        return;
    }
    document.documentElement.style.setProperty('--header-bg', colors.primary || colors.background);
    document.documentElement.style.setProperty('--header-text', colors.text);
    document.documentElement.style.setProperty('--header-accent', colors.accent || colors.primary);
    const header = document.querySelector('.custom-header');
    if (header) {
        header.style.backgroundColor = colors.surface || colors.background;
        header.style.color = colors.text;
    }
}
function updateNavigationState(state = {}) {
    if (!navButtons) {
        navButtons = {
            back: document.getElementById('back-btn'),
            forward: document.getElementById('forward-btn'),
            refresh: document.getElementById('refresh-btn'),
        };
    }
    if ('canGoBack' in state) canGoBack = state.canGoBack;
    if ('canGoForward' in state) canGoForward = state.canGoForward;
    if ('refreshing' in state) {
        isRefreshing = state.refreshing;
        if (navButtons.refresh) {
            navButtons.refresh.classList.toggle('refreshing', isRefreshing);
            navButtons.refresh.title = isRefreshing ? 'Cancel Refresh' : 'Refresh Page';
        }
    }
    if (navButtons.back) navButtons.back.classList.toggle('disabled', !canGoBack);
    if (navButtons.forward) navButtons.forward.classList.toggle('disabled', !canGoForward);
}
function updateWindowControls() {
    if (platform === 'win32') {
        if (!maximizeGlyphEl) {
            maximizeGlyphEl = document.querySelector('#maximize-btn .icon-glyph');
        }
        if (!maximizeGlyphEl) return;
        setIconGlyph(maximizeGlyphEl, isMaximized ? SEGOE_GLYPHS.restore : SEGOE_GLYPHS.maximize);
        document.getElementById('maximize-btn').title = isMaximized ? 'Restore' : 'Maximize';
        document.getElementById('maximize-btn').setAttribute('aria-label', isMaximized ? 'Restore' : 'Maximize');
    }
}
function setIconGlyph(element, glyph) {
    if (!element) return;
    element.textContent = glyph;
}
function initializeIcons() {
    try {
        if (platform === 'win32') {
            minimizeGlyphEl = document.querySelector('#minimize-btn .icon-glyph');
            maximizeGlyphEl = document.querySelector('#maximize-btn .icon-glyph');
            closeGlyphEl = document.querySelector('#close-btn .icon-glyph');
            setIconGlyph(minimizeGlyphEl, SEGOE_GLYPHS.minimize);
            setIconGlyph(maximizeGlyphEl, SEGOE_GLYPHS.maximize);
            setIconGlyph(closeGlyphEl, getCloseGlyph());
            if (forcedColorsQuery?.addEventListener) {
                forcedColorsQuery.addEventListener('change', handleForcedColorsChange);
            } else if (forcedColorsQuery?.addListener) {
                forcedColorsQuery.addListener(handleForcedColorsChange);
            }
        }
    } catch (error) {
        console.error('Error initializing icons:', error);
    }
}
function getCloseGlyph() {
    return forcedColorsQuery?.matches ? SEGOE_GLYPHS.closeHighContrast : SEGOE_GLYPHS.close;
}
function handleForcedColorsChange() {
    if (closeGlyphEl) {
        setIconGlyph(closeGlyphEl, getCloseGlyph());
    }
}
document.body.classList.add(`platform-${platform}`);
document.querySelector('.navigation-controls')?.addEventListener('click', (e) => {
    const { id } = e.target.closest('.nav-button') || {};
    switch (id) {
        case 'back-btn':
            if (canGoBack) ipcRenderer.send('navigate-back');
            break;
        case 'forward-btn':
            if (canGoForward) ipcRenderer.send('navigate-forward');
            break;
        case 'refresh-btn':
            if (isRefreshing) {
                ipcRenderer.send('cancel-refresh');
                updateNavigationState({ refreshing: false });
            } else {
                ipcRenderer.send('refresh-page');
                updateNavigationState({ refreshing: true });
            }
            break;
    }
});
document.getElementById('minimize-btn')?.addEventListener('click', () => {
    ipcRenderer.send('minimize-window');
});
document.getElementById('maximize-btn')?.addEventListener('click', () => {
    ipcRenderer.send('maximize-window');
    isMaximized = !isMaximized;
    updateWindowControls();
});
document.getElementById('close-btn')?.addEventListener('click', () => {
    ipcRenderer.send('close-window');
});
document.querySelector('.title-bar')?.addEventListener('dblclick', () => {
    ipcRenderer.send('title-bar-double-click');
    isMaximized = !isMaximized;
    updateWindowControls();
});
ipcRenderer.on('theme-changed', (_, isDark) => {
    if (isDark) {
        document.documentElement.classList.remove('theme-light');
    } else {
        document.documentElement.classList.add('theme-light');
    }
    if (!themeColors) {
        const header = document.querySelector('.custom-header');
        if (header) {
            header.style.removeProperty('background-color');
            header.style.removeProperty('color');
        }
    }
});
ipcRenderer.on('theme-colors-changed', (_, colors) => {
    applyThemeColors(colors);
});
ipcRenderer.on('navigation-state-changed', (_, state) => {
    updateNavigationState(state);
});
ipcRenderer.on('refresh-state-changed', (_, refreshing) => {
    updateNavigationState({ refreshing });
});
ipcRenderer.on('navigation-controls-toggle', (_, enabled) => {
    const navControls = document.querySelector('.navigation-controls');
    if (navControls) {
        if (enabled) {
            navControls.classList.add('visible');
            navControls.classList.remove('hidden');
        } else {
            navControls.classList.remove('visible');
            navControls.classList.add('hidden');
            navButtons = null;
        }
    }
});
document.addEventListener('DOMContentLoaded', () => {
    initializeIcons();
    updateNavigationState();
    ipcRenderer.invoke('get-navigation-controls-enabled').then((enabled) => {
        const navControls = document.querySelector('.navigation-controls');
        if (navControls && enabled) {
            navControls.classList.add('visible');
            navControls.classList.remove('hidden');
        }
    });
    ipcRenderer.invoke('get-theme-colors').then((colors) => {
        if (colors) {
            applyThemeColors(colors);
        }
    });
    const applyWindowState = (maximized) => {
        isMaximized = maximized;
        updateWindowControls();
    };
    ipcRenderer.on('window-state-changed', (_event, maximized) => applyWindowState(maximized));
    ipcRenderer.invoke('is-maximized').then(applyWindowState);
});
