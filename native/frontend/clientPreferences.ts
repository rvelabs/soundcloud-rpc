import { invoke } from './bridge';
export type Preferences = {
    minimizeToTray: boolean;
    zoom: number;
    theme: 'dark' | 'light' | 'auto';
    navigation: boolean;
    hidePromotions: boolean;
    hideEvents: boolean;
    hideArtistUpsells: boolean;
};
let sheet: CSSStyleSheet | undefined;
let themeObserver: MutationObserver | undefined;
let currentDark: boolean | undefined;
let media: MediaQueryList | undefined;
let applyTheme: (() => void) | undefined;
export function applyPreferences(value: Preferences): void {
    if (!sheet) {
        sheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    const rules: string[] = [];
    if (value.hidePromotions)
        rules.push(
            '.banner.m-promotion,.promotedSoundList,.promotedPlaylist,.sidebarModule__promoted{display:none!important}',
        );
    if (value.hideEvents) rules.push('.velvetCakeModule,.sidebarModule__events,.eventsModule{display:none!important}');
    if (value.hideArtistUpsells)
        rules.push(
            '.creatorSubscriptionsButton.header__creatorUpsell,.artistConnectItem.m-upsellNextPro,.spotlight__upsellBanner,.spotlight__upsellCTA,.header__proUpsell,.header__goPro,.sidebarModule__proUpsell{display:none!important}',
        );
    sheet.replaceSync(rules.join('\n'));
    applyTheme = () => {
        const dark =
            value.theme === 'dark' || (value.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
        if (document.documentElement.getAttribute('data-theme') !== (dark ? 'dark' : 'light'))
            document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        for (const element of [document.documentElement, document.body])
            if (element) {
                element.classList.toggle('theme-dark', dark);
                element.classList.toggle('theme-light', !dark);
            }
        if (dark !== currentDark) {
            currentDark = dark;
            void invoke('extensions_theme', { dark }).catch(console.error);
        }
    };
    applyTheme();
    if (!themeObserver) {
        themeObserver = new MutationObserver(() => applyTheme?.());
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    if (!media) {
        media = matchMedia('(prefers-color-scheme: dark)');
        media.addEventListener('change', () => applyTheme?.());
    }
    let navigation = document.getElementById('native-navigation');
    if (!value.navigation) {
        navigation?.remove();
        return;
    }
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', () => applyPreferences(value), { once: true });
        return;
    }
    if (!navigation) {
        navigation = document.createElement('nav');
        navigation.id = 'native-navigation';
        navigation.setAttribute('aria-label', 'Navigation');
        for (const [label, action] of [
            ['←', () => history.back()],
            ['→', () => history.forward()],
            ['↻', () => location.reload()],
        ] as const) {
            const button = document.createElement('button');
            button.textContent = label;
            button.onclick = action;
            navigation.append(button);
        }
        document.body.append(navigation);
    }
}
export async function installClientPreferences(ru: boolean): Promise<void> {
    const text = (russian: string, english: string) => (ru ? russian : english);
    const panel = document.createElement('section');
    panel.className = 'settings-section';
    panel.dataset.pane = 'client';
    panel.hidden = true;
    const heading = document.createElement('h2');
    heading.textContent = text('Клиент', 'Client');
    panel.append(heading);
    const value = await invoke<Preferences>('client_options');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    let saving = Promise.resolve();
    const save = () => {
        const next = { ...value };
        saving = saving.then(async () => {
            try {
                await invoke('client_options', { options: next });
                status.textContent = text('Сохранено', 'Saved');
            } catch (error) {
                status.textContent = String(error);
            }
        });
    };
    const label = document.createElement('label');
    label.textContent = text('Тема', 'Theme');
    const select = document.createElement('select');
    for (const [key, caption] of [
        ['auto', text('Системная', 'System')],
        ['dark', text('Тёмная', 'Dark')],
        ['light', text('Светлая', 'Light')],
    ]) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = caption;
        select.append(option);
    }
    select.value = value.theme;
    select.onchange = () => {
        value.theme = select.value as Preferences['theme'];
        save();
    };
    label.append(select);
    panel.append(label);
    for (const [key, title] of [
        ['navigation', text('Кнопки навигации', 'Navigation controls')],
        ['hidePromotions', text('Скрывать продвижение', 'Hide promotions')],
        ['hideEvents', text('Скрывать события рядом', 'Hide nearby events')],
        ['hideArtistUpsells', text('Скрывать предложения Artist Pro', 'Hide Artist Pro offers')],
    ] as const) {
        const label = document.createElement('label');
        label.className = 'check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = value[key];
        input.onchange = () => {
            value[key] = input.checked;
            save();
        };
        label.append(input, document.createTextNode(title));
        panel.append(label);
    }
    const zoomLabel = document.createElement('label'),
        zoom = document.createElement('input');
    zoom.type = 'range';
    zoom.min = '0.75';
    zoom.max = '1.5';
    zoom.step = '0.05';
    zoom.value = String(value.zoom);
    const caption = () => {
        zoomLabel.textContent = text('Масштаб: ', 'Zoom: ') + Math.round(value.zoom * 100) + '%';
        zoomLabel.append(zoom);
    };
    caption();
    zoom.oninput = () => {
        value.zoom = Number(zoom.value);
        caption();
    };
    zoom.onchange = save;
    panel.append(zoomLabel, status);
    document.body.append(panel);
}
