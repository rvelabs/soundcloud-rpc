import { invoke } from './bridge';
import { installAccountSettings } from './accountSettings';
import { installClientPreferences } from './clientPreferences';
import { installIntegrationSettings } from './integrationSettings';
import { installExtensionSettings } from './extensionSettings';
import { installUpdateSettings } from './updateSettings';
import { installWorkerSettings } from './workerSettings';
import { installAnalysisSettings } from './analysisSettings';

async function mountSettings() {
    const language = await invoke<string>('interface_language');
    const ru = language === 'ru' || (language === 'auto' && navigator.language.toLowerCase().startsWith('ru'));
    const text = (russian: string, english: string) => (ru ? russian : english);
    const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const close = element<HTMLButtonElement>('settings-close');
    close.title = text('Закрыть настройки (Esc)', 'Close settings (Esc)');
    close.setAttribute('aria-label', text('Закрыть настройки', 'Close settings'));
    close.onclick = () => void invoke('close_settings').catch(console.error);
    document.addEventListener('keydown', (event) => {
        if (['Escape', 'F1'].includes(event.key) && !event.defaultPrevented) {
            event.preventDefault();
            if (!event.repeat) void invoke('close_settings').catch(console.error);
        }
    });
    const status = element('status'),
        mode = element<HTMLSelectElement>('mode'),
        endpoint = element<HTMLInputElement>('endpoint'),
        key = element<HTMLInputElement>('key');
    const discordEnabled = element<HTMLInputElement>('discord-enabled');
    const discordButton = element<HTMLInputElement>('discord-button');
    element('discord-heading').textContent = text('Статус в Discord', 'Discord status');
    element('discord-enabled-label').textContent = text(
        'Показывать музыку, которую я слушаю',
        'Show the music I am listening to',
    );
    element('discord-button-label').textContent = text(
        'Кнопка «Слушать в SoundCloud»',
        'Show Listen on SoundCloud button',
    );
    let discordOptions = { enabled: true, showButton: true, showIcon: false };
    type DiscordState = { options: typeof discordOptions; diagnostics: { active: boolean } };
    const showDiscord = (value: DiscordState) => {
        discordOptions = value.options;
        discordEnabled.checked = discordOptions.enabled;
        discordButton.checked = discordOptions.showButton;
        element('discord-status').textContent = !discordOptions.enabled
            ? text('Статус выключен.', 'Status is disabled.')
            : value.diagnostics.active
              ? text('Discord подтвердил статус прослушивания.', 'Discord acknowledged your listening status.')
              : text(
                    'Статус появится во время воспроизведения. Приложение Discord должно быть открыто.',
                    'The status appears during playback. The Discord desktop app must be running.',
                );
    };
    void invoke<DiscordState>('presence_options')
        .then(showDiscord)
        .catch((error) => {
            element('discord-status').textContent = String(error);
        });
    for (const input of [discordEnabled, discordButton])
        input.addEventListener('change', async () => {
            try {
                showDiscord(
                    await invoke<DiscordState>('presence_options', {
                        options: {
                            ...discordOptions,
                            enabled: discordEnabled.checked,
                            showButton: discordButton.checked,
                        },
                    }),
                );
            } catch (error) {
                element('discord-status').textContent = String(error);
            }
        });
    document.documentElement.lang = ru ? 'ru' : 'en';
    for (const [id, label] of Object.entries({
        heading: 'Настройки',
        'mode-label': 'Режим подключения',
        'endpoint-label': 'HTTPS-адрес Cloudflare Worker',
        'key-label': 'Ключ Worker',
        privacy: 'Ключ шифруется средствами Windows и не передаётся странице SoundCloud.',
        save: 'Сохранить',
        restart: 'Перезапустить клиент',
    }))
        if (ru) element(id).textContent = label;
    if (ru)
        [...mode.options].forEach(
            (option, index) =>
                (option.textContent = ['Напрямую', 'Автоматический резерв', 'Всегда через Worker'][index]),
        );
    void invoke<{ mode: string; endpoint: string; hasKey: boolean; relayActive: boolean }>('connection_load')
        .then((value) => {
            mode.value = value.mode;
            endpoint.value = value.endpoint;
            key.placeholder = value.hasKey
                ? text('Ключ сохранён; оставьте пустым', 'Key saved; leave blank to keep it')
                : '';
            status.textContent = value.relayActive
                ? text('Сейчас подключено через Worker.', 'Currently connected through Worker.')
                : text('Сейчас используется прямое подключение.', 'Currently using a direct connection.');
        })
        .catch((error) => (status.textContent = String(error)));
    document.getElementById('connection-form')!.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = element<HTMLButtonElement>('save');
        button.disabled = true;
        try {
            await invoke('connection_save', {
                mode: mode.value,
                endpoint: endpoint.value.trim(),
                key: key.value.trim(),
            });
            key.value = '';
            element('restart').hidden = false;
            status.textContent = text(
                'Сохранено. Перезапуск применит подключение и остановит текущую музыку.',
                'Saved. Restart applies the connection and stops current playback.',
            );
        } catch (error) {
            status.textContent = String(error);
        } finally {
            button.disabled = false;
        }
    });
    element('restart').addEventListener(
        'click',
        () => void invoke('restart_native').catch((error) => (status.textContent = String(error))),
    );
    const results = await Promise.allSettled([
        Promise.resolve().then(() => installAnalysisSettings(ru)),
        installClientPreferences(ru),
        installAccountSettings(ru),
        installIntegrationSettings(ru),
        installExtensionSettings(ru),
        installUpdateSettings(ru),
        installWorkerSettings(ru),
    ]);
    for (const result of results)
        if (result.status === 'rejected') element('settings-error').textContent = String(result.reason);
    const captions: Record<string, string> = {
        client: 'Общее',
        integrations: 'Интеграции',
        extensions: 'Дополнения',
        connection: 'Подключение',
    };
    const showPane = (pane: string) => {
        if (!Object.prototype.hasOwnProperty.call(captions, pane)) pane = 'client';
        for (const section of document.querySelectorAll<HTMLElement>('[data-pane]'))
            section.hidden = section.dataset.pane !== pane;
        for (const button of document.querySelectorAll<HTMLButtonElement>('[data-pane-target]'))
            button.setAttribute('aria-pressed', String(button.dataset.paneTarget === pane));
        localStorage.setItem('native-settings-pane', pane);
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-pane-target]')) {
        if (ru) button.textContent = captions[button.dataset.paneTarget!];
        button.onclick = () => showPane(button.dataset.paneTarget!);
    }
    showPane(localStorage.getItem('native-settings-pane') || 'client');
    if ((window as unknown as { __SC_SETTINGS_TEST?: boolean }).__SC_SETTINGS_TEST)
        void import('./settingsCheck').then((module) => module.checkSettings());
}
void mountSettings().catch((error) => {
    document.getElementById('status')!.textContent = String(error);
});
