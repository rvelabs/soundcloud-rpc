import { invoke } from './bridge';
export type UpdateState = {
    phase: string;
    currentVersion: string;
    version?: string;
    kind?: 'patch' | 'larger';
    percent: number;
    mode: 'patch' | 'notify' | 'off';
    installSupported: boolean;
    error?: string;
};

export async function installUpdateSettings(ru: boolean): Promise<void> {
    const t = (r: string, e: string) => (ru ? r : e);
    const section = document.createElement('section');
    section.className = 'settings-section';
    section.dataset.pane = 'client';
    section.hidden = true;
    section.innerHTML = `<h2>${t('Обновления SoundCloud', 'SoundCloud updates')}</h2><label for="native-update-mode">${t('Режим обновления', 'Update mode')}</label><select id="native-update-mode"><option value="patch">${t('Автоматически: небольшие исправления', 'Automatic: small fixes')}</option><option value="notify">${t('Только уведомления', 'Notifications only')}</option><option value="off">${t('Не проверять автоматически', 'No automatic checks')}</option></select><small>${t('Небольшие исправления скачиваются в фоне и устанавливаются при выходе через меню трея. Крупные обновления устанавливаются по вашему запросу. Закрытие в трей не считается выходом.', 'Small fixes download in the background and install when you quit from the tray menu. Larger updates need your approval. Hiding to the tray does not count as quitting.')}</small><p class="muted" id="native-update-status" role="status" aria-live="polite"></p><div class="buttons"><button type="button" data-update="check">${t('Проверить', 'Check now')}</button><button type="button" data-update="download" hidden>${t('Скачать', 'Download')}</button><button type="button" data-update="install" hidden>${t('Установить и перезапустить', 'Install and restart')}</button><button type="button" data-update="notes" class="secondary">${t('Что нового', 'Release notes')}</button></div>`;
    document.getElementById('connection-form')!.before(section);
    const mode = section.querySelector<HTMLSelectElement>('select')!,
        status = section.querySelector<HTMLElement>('#native-update-status')!;
    const render = (state: UpdateState) => {
        mode.value = state.mode;
        const phases: Record<string, string> = {
            idle: t('Проверка ещё не выполнялась.', 'Not checked yet.'),
            checking: t('Проверяем обновления…', 'Checking for updates…'),
            current: t('Установлена актуальная версия.', 'You are up to date.'),
            available: t('Доступна версия ', 'Available version ') + (state.version || ''),
            downloading: t('Скачивание: ', 'Downloading: ') + state.percent + '%',
            ready: t('Обновление готово к установке.', 'Update is ready to install.'),
            error: t(
                'Канал обновлений SoundCloud сейчас недоступен.',
                'The SoundCloud update feed is unavailable right now.',
            ),
        };
        status.textContent = `${state.currentVersion} · ${phases[state.phase] || state.phase} ${state.error || ''}`;
        if (!state.installSupported)
            status.textContent += t(
                ' Автоустановка доступна в установленной сборке SoundCloud.',
                ' Automatic installation is available in an installed SoundCloud build.',
            );
        for (const button of section.querySelectorAll<HTMLButtonElement>('[data-update]')) {
            const action = button.dataset.update;
            button.hidden =
                action === 'download'
                    ? state.phase !== 'available'
                    : action === 'install'
                      ? state.phase !== 'ready'
                      : false;
            button.disabled =
                action !== 'notes' &&
                (['checking', 'downloading'].includes(state.phase) ||
                    ((action === 'download' || action === 'install') && !state.installSupported));
        }
    };
    const load = () =>
        invoke<UpdateState>('updates_options')
            .then(render)
            .catch((error) => {
                status.textContent = String(error);
            });
    mode.addEventListener(
        'change',
        () =>
            void invoke<UpdateState>('updates_action', { action: 'mode', mode: mode.value })
                .then(render)
                .catch((error) => {
                    status.textContent = String(error);
                }),
    );
    for (const button of section.querySelectorAll<HTMLButtonElement>('[data-update]'))
        button.addEventListener('click', () => {
            button.disabled = true;
            void invoke<UpdateState>('updates_action', { action: button.dataset.update, mode: null })
                .then(render)
                .catch(async (error) => {
                    await load();
                    status.textContent += ' ' + String(error);
                })
                .finally(() => {
                    button.disabled = false;
                });
        });
    window.addEventListener('native-update-changed', () => void load());
    await load();
}
