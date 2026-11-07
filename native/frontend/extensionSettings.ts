import { invoke } from './bridge';
type File = {
    id: string;
    name: string;
    author: string;
    version: string;
    description: string;
    kind: 'plugin' | 'theme';
    enabled: boolean;
    error?: string;
};
type State = { files: File[]; theme: string | null };

export async function installExtensionSettings(ru: boolean): Promise<void> {
    const t = (r: string, e: string) => (ru ? r : e);
    const section = document.createElement('section');
    section.className = 'settings-section';
    section.dataset.pane = 'extensions';
    section.hidden = true;
    section.innerHTML = `<h2>${t('Плагины и темы', 'Plugins and themes')}</h2><p class="muted">${t('Включайте только плагины, которым доверяете: их интерфейсный код работает на странице SoundCloud.', 'Enable only plugins you trust: their page code runs inside SoundCloud.')}</p><div id="native-plugins"></div><label for="native-theme">${t('CSS-тема', 'CSS theme')}</label><select id="native-theme"></select><div class="buttons"><button type="button" data-extension-action="plugins" class="secondary">${t('Папка плагинов', 'Plugins folder')}</button><button type="button" data-extension-action="themes" class="secondary">${t('Папка тем', 'Themes folder')}</button><button type="button" data-extension-action="refresh" class="secondary">${t('Обновить список', 'Refresh')}</button></div><p class="muted" id="native-extensions-status" role="status"></p>`;
    document.getElementById('connection-form')!.before(section);
    const list = section.querySelector('#native-plugins')!,
        select = section.querySelector<HTMLSelectElement>('#native-theme')!,
        status = section.querySelector<HTMLElement>('#native-extensions-status')!;
    let busy = false;
    const render = (state: State) => {
        list.replaceChildren();
        select.replaceChildren();
        const original = document.createElement('option');
        original.value = '';
        original.textContent = t('Штатная тема SoundCloud', 'SoundCloud default');
        select.append(original);
        for (const file of state.files) {
            if (file.kind === 'theme') {
                const option = document.createElement('option');
                option.value = file.id;
                option.textContent = file.name;
                select.append(option);
                continue;
            }
            const label = document.createElement('label');
            label.className = 'check';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = file.enabled;
            input.addEventListener('change', () => void action('toggle', file.id, input.checked));
            const title = document.createElement('span');
            title.textContent = file.name + (file.version ? ' · ' + file.version : '');
            label.append(input, title);
            list.append(label);
            const detail = document.createElement('small');
            detail.textContent = file.error || file.description;
            list.append(detail);
        }
        select.value = state.theme || '';
        if (!state.files.some((file) => file.kind === 'plugin')) {
            const empty = document.createElement('p');
            empty.className = 'muted';
            empty.textContent = t('Положите .js-плагины в папку плагинов.', 'Place .js plugins in the plugins folder.');
            list.append(empty);
        }
    };
    async function action(action: string, id: string | null = null, enabled: boolean | null = null) {
        if (busy) return;
        busy = true;
        try {
            render(await invoke<State>('extensions_action', { action, id, enabled }));
            status.textContent = '';
        } catch (error) {
            status.textContent = String(error);
        } finally {
            busy = false;
        }
    }
    select.addEventListener('change', () => void action('theme', select.value));
    for (const button of section.querySelectorAll<HTMLButtonElement>('[data-extension-action]'))
        button.addEventListener('click', () => void action(button.dataset.extensionAction!));
    window.addEventListener('native-extensions-changed', () => {
        if (!busy)
            void invoke<State>('extensions_options')
                .then(render)
                .catch((error) => {
                    status.textContent = String(error);
                });
    });
    render(await invoke<State>('extensions_options'));
}
