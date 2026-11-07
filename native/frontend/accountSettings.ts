import { invoke } from './bridge';
type Accounts = { current: string; selected: string; items: Array<{ id: string; name: string }> };
export async function installAccountSettings(ru: boolean): Promise<void> {
    const text = (ruText: string, enText: string) => (ru ? ruText : enText);
    const panel = document.createElement('section');
    panel.className = 'settings-section';
    panel.dataset.pane = 'client';
    panel.hidden = true;
    const heading = document.createElement('h2');
    heading.textContent = text('Аккаунты', 'Accounts');
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = text(
        'Профили хранят вход и настройки отдельно. Переключение перезапустит клиент и остановит музыку.',
        'Profiles keep sign-in and settings separate. Switching restarts the client and stops playback.',
    );
    const select = document.createElement('select');
    select.setAttribute('aria-label', text('Профиль', 'Profile'));
    const name = document.createElement('input');
    name.maxLength = 100;
    name.placeholder = text('Название нового профиля', 'New profile name');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const create = document.createElement('button'),
        rename = document.createElement('button'),
        open = document.createElement('button');
    create.textContent = text('Добавить', 'Add');
    rename.textContent = text('Переименовать', 'Rename');
    open.textContent = text('Переключить и перезапустить', 'Switch and restart');
    const show = (value: Accounts) => {
        select.replaceChildren();
        for (const item of value.items) {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = item.name + (item.id === value.current ? text(' · текущий', ' · current') : '');
            select.append(option);
        }
        select.value = value.selected;
        open.disabled = select.value === value.current;
        select.onchange = () => {
            open.disabled = select.value === value.current;
        };
    };
    const action = async (action: string) => {
        create.disabled = rename.disabled = open.disabled = true;
        try {
            show(await invoke<Accounts>('accounts_action', { action, id: select.value, name: name.value }));
            name.value = '';
        } catch (error) {
            status.textContent = String(error);
        } finally {
            create.disabled = rename.disabled = false;
        }
    };
    create.onclick = () => void action('create');
    rename.onclick = () => void action('rename');
    open.onclick = () => void action('select');
    panel.append(heading, hint, select, name, create, rename, open, status);
    document.body.append(panel);
    show(await invoke<Accounts>('accounts_options'));
}
