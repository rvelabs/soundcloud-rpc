import waveStyles from '../../src/wave/inline.css';

let stylesheet: CSSStyleSheet | undefined;

export function installNativeStyles(): void {
    stylesheet ??= new CSSStyleSheet();
    if (!stylesheet.cssRules.length)
        stylesheet.replaceSync(
            waveStyles +
                `
        #native-navigation{position:fixed;left:8px;top:8px;z-index:9999;display:flex;gap:4px}#native-navigation button{background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 8px;cursor:pointer}
        #native-update-notice{position:fixed;right:24px;top:68px;z-index:2147483000;display:flex;gap:12px;align-items:center;padding:12px 16px;max-width:calc(100vw - 48px);border:1px solid #ffffff22;border-radius:10px;background:#252525;color:#fff;box-shadow:0 8px 32px #0005;font:13px/1.4 system-ui}
        #native-update-notice button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:4px}
        #native-update-notice button:first-child{color:#ff8040;text-align:left}
    `,
        );
    if (!document.adoptedStyleSheets.includes(stylesheet))
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
}

export function nativeLayout() {
    const wave = document.getElementById('codex-wave-inline');
    const importer = document.getElementById('codex-playlist-import');
    const icons = [...document.querySelectorAll<SVGSVGElement>('#codex-wave-inline svg, #codex-playlist-import svg')];
    const visibleIcons = icons.filter((icon) => icon.getClientRects().length > 0);
    const oversizedIcons = visibleIcons.filter((icon) => {
        const bounds = icon.getBoundingClientRect();
        return bounds.width > 64 || bounds.height > 64;
    }).length;
    const styled = Boolean(wave && getComputedStyle(wave).borderRadius === '12px');
    return {
        styled,
        icons: visibleIcons.length,
        oversizedIcons,
        waveHeight: wave?.getBoundingClientRect().height || 0,
        importHeight: importer?.getBoundingClientRect().height || 0,
        success: styled && visibleIcons.length > 0 && oversizedIcons === 0,
    };
}
