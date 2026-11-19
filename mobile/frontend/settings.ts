import { invoke, Profile } from '../../native/frontend/bridge';
import { installClientPreferences } from '../../native/frontend/clientPreferences';
import { installIntegrationSettings } from '../../native/frontend/integrationSettings';
import { installWorkerSettings } from '../../native/frontend/workerSettings';
import css from './mobile.css';
const page = window as any;
const ru = /^ru\b/i.test(navigator.language);
const text = (r: string, e: string) => (ru ? r : e);
const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
document.adoptedStyleSheets = [sheet];
function showError(error: unknown) {
    const p = document.createElement('p');
    p.setAttribute('role', 'alert');
    p.textContent = String(error);
    (document.getElementById('android-settings') || document.body).append(p);
}
async function openSettings() {
    document.getElementById('android-settings')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'android-settings';
    const close = document.createElement('button');
    close.textContent = '×';
    close.className = 'android-close';
    close.setAttribute('aria-label', text('Закрыть', 'Close'));
    close.onclick = () => {
        dialog.close();
        void invoke('android_close_settings');
    };
    const title = document.createElement('h1');
    title.textContent = text('Настройки', 'Settings');
    dialog.append(close, title);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    try {
        await installClientPreferences(ru);
        const client = document.querySelector<HTMLElement>('.settings-section[data-pane=client]');
        if (client) {
            client.hidden = false;
            dialog.append(client);
        }
        const profile = new Profile('settings');
        await profile.load();
        const language = document.createElement('select');
        for (const [value, label] of [
            ['auto', text('Язык системы', 'System language')],
            ['ru', 'Русский'],
            ['en', 'English'],
        ]) {
            language.append(new Option(label, value));
        }
        language.value = String(profile.get('language', 'auto'));
        language.onchange = () => void invoke('android_language', { language: language.value });
        dialog.append(language);
        const speed = document.createElement('select');
        speed.setAttribute('aria-label', text('Скорость воспроизведения', 'Playback speed'));
        for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) speed.append(new Option(`${rate}×`, String(rate)));
        speed.value = String(page.__androidPlaybackRate || 1);
        speed.onchange = () => {
            page.__androidPlaybackRate = Number(speed.value);
            void invoke('android_control', { command: 'speed', rate: Number(speed.value) }).catch(showError);
        };
        dialog.append(speed);
        const reset = document.createElement('button');
        reset.textContent = text('Очистить аудиоанализ', 'Reset audio analysis');
        reset.onclick = async () => {
            if (!confirm(text('Очистить анализ и историю предпочтений?', 'Clear analysis and listening preferences?')))
                return;
            const user = await invoke<any>('catalog_request', { request: { operation: 'me' } });
            await invoke('analysis_reset', { owner: user.id });
            await invoke('android_reload');
        };
        dialog.append(reset);
        const connection = await invoke<any>('connection_load');
        const heading = document.createElement('h2');
        heading.textContent = 'Cloudflare Worker';
        dialog.append(heading);
        const mode = document.createElement('select');
        for (const [value, label] of [
            ['off', text('Напрямую', 'Direct')],
            ['auto', text('Автоматически', 'Automatic')],
            ['on', text('Через Worker', 'Use Worker')],
        ])
            mode.append(new Option(label, value));
        mode.value = connection.mode;
        mode.id = 'mode';
        const endpoint = document.createElement('input');
        endpoint.type = 'url';
        endpoint.placeholder = 'https://your-worker.workers.dev';
        endpoint.value = connection.endpoint;
        const key = document.createElement('input');
        key.type = 'password';
        key.placeholder = text('Ключ Worker', 'Worker key');
        key.autocomplete = 'off';
        endpoint.id = 'endpoint';
        key.id = 'key';
        const save = document.createElement('button');
        save.textContent = text('Сохранить подключение', 'Save connection');
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        save.onclick = () =>
            void invoke('connection_save', { mode: mode.value, endpoint: endpoint.value, key: key.value })
                .then(() => {
                    key.value = '';
                    status.textContent = text('Сохранено. Перезапустите приложение.', 'Saved. Restart the app.');
                })
                .catch((error) => {
                    status.textContent = String(error);
                });
        dialog.append(mode, endpoint, key, save, status);
        const connectionForm = document.createElement('div');
        connectionForm.id = 'connection-form';
        dialog.append(connectionForm);
        const restart = document.createElement('p');
        restart.id = 'restart';
        restart.hidden = true;
        restart.textContent = text(
            'Новые настройки подключения применятся после полного перезапуска приложения.',
            'Connection changes apply after a full app restart.',
        );
        dialog.append(restart);
        await installWorkerSettings(ru);
        const worker = document.querySelector<HTMLElement>('.settings-section[data-pane=connection]');
        if (worker) {
            worker.hidden = false;
            worker.querySelector('#cf-files')?.remove();
        }
        await installIntegrationSettings(ru);
        const integrations = document.querySelector<HTMLElement>('.settings-section[data-pane=integrations]');
        if (integrations) {
            integrations.hidden = false;
            const note = integrations.querySelector('small');
            if (note)
                note.textContent = text(
                    'Ключи хранятся в Android Keystore. Учитывается фактическое прослушивание.',
                    'Keys are encrypted with Android Keystore. Only confirmed playback counts.',
                );
        }
    } catch (error) {
        showError(error);
    }
}

void openSettings();
