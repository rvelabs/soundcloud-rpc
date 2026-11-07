import { invoke } from './bridge';
type Status = {
    lastfmEnabled: boolean;
    webhookEnabled: boolean;
    webhookTrigger: number;
    parseTitle: boolean;
    apiKey: string;
    hasSecret: boolean;
    connected: boolean;
    username: string;
    hasWebhookUrl: boolean;
    pending: number;
    delivered: number;
    error?: string;
    authPending: boolean;
};

export async function installIntegrationSettings(ru: boolean): Promise<void> {
    const t = (russian: string, english: string) => (ru ? russian : english);
    const panel = document.createElement('section');
    panel.className = 'settings-section';
    panel.dataset.pane = 'integrations';
    panel.hidden = true;
    panel.innerHTML = `<h2>Last.fm &amp; webhook</h2><form id="lf-form">
        <label class="check"><input id="lf-enabled" type="checkbox"><span>${t('Отправлять прослушивания в Last.fm', 'Scrobble to Last.fm')}</span></label>
        <label for="lf-key">Last.fm API key</label><input id="lf-key" maxlength="32" autocomplete="off">
        <label for="lf-secret">Last.fm Shared Secret</label><input id="lf-secret" type="password" maxlength="32" autocomplete="off">
        <div class="buttons"><button type="button" id="lf-connect">${t('Войти в Last.fm', 'Sign in to Last.fm')}</button><button type="button" id="lf-finish" class="secondary">${t('Завершить вход', 'Finish sign-in')}</button><button type="button" id="lf-disconnect" class="secondary">${t('Отключить Last.fm', 'Disconnect Last.fm')}</button></div>
        <label class="check"><input id="wb-enabled" type="checkbox"><span>${t('Отправлять webhook', 'Send playback webhook')}</span></label>
        <label for="wb-url">HTTPS webhook URL</label><input id="wb-url" type="password" maxlength="4096" autocomplete="off">
        <label for="wb-trigger">${t('Отправлять после прослушивания, %', 'Send after listening, %')}</label><input id="wb-trigger" type="number" min="0" max="100" step="1">
        <label class="check"><input id="lf-parser" type="checkbox"><span>${t('Разбирать «Исполнитель — Название»', 'Parse Artist — Title')}</span></label>
        <small>${t('Ключи хранятся зашифрованными Windows. Считается только фактическое прослушивание; неотправленные события сохраняются для повторной отправки.', 'Keys are encrypted by Windows. Only confirmed playback counts; pending events are saved for retry.')}</small>
        <div class="buttons"><button type="submit">${t('Сохранить интеграции', 'Save integrations')}</button><button type="button" id="wb-disconnect" class="secondary">${t('Удалить webhook', 'Remove webhook')}</button></div>
        <p class="muted" id="lf-status" role="status" aria-live="polite"></p></form>`;
    document.getElementById('connection-form')!.before(panel);
    const input = (id: string) => panel.querySelector<HTMLInputElement>('#' + id)!;
    const status = panel.querySelector<HTMLElement>('#lf-status')!;
    const show = (value: Status) => {
        input('lf-enabled').checked = value.lastfmEnabled;
        input('wb-enabled').checked = value.webhookEnabled;
        input('wb-trigger').value = String(value.webhookTrigger);
        input('lf-parser').checked = value.parseTitle;
        input('lf-key').value = value.apiKey;
        input('lf-secret').value = '';
        input('wb-url').value = '';
        input('lf-secret').placeholder = value.hasSecret
            ? t('Сохранён; пустое поле не меняет ключ', 'Saved; leave blank to keep')
            : '';
        input('wb-url').placeholder = value.hasWebhookUrl
            ? t('Адрес сохранён; пустое поле не меняет его', 'URL saved; leave blank to keep')
            : '';
        panel.querySelector<HTMLButtonElement>('#lf-finish')!.disabled = !value.authPending;
        status.textContent = `${value.connected ? 'Last.fm: ' + value.username : t('Last.fm не подключён', 'Last.fm is not connected')}. ${t('Ожидают отправки', 'Pending')}: ${value.pending}. ${value.error || ''}`;
    };
    const save = () =>
        invoke<Status>('listening_save', {
            options: {
                lastfmEnabled: input('lf-enabled').checked,
                webhookEnabled: input('wb-enabled').checked,
                webhookTrigger: Number(input('wb-trigger').value),
                parseTitle: input('lf-parser').checked,
                apiKey: input('lf-key').value.trim(),
                apiSecret: input('lf-secret').value.trim() || null,
                webhookUrl: input('wb-url').value.trim() || null,
            },
        });
    let busy = false;
    async function run(task: () => Promise<void>) {
        if (busy) return;
        busy = true;
        try {
            await task();
        } catch (error) {
            status.textContent = String(error);
        } finally {
            busy = false;
        }
    }
    panel.querySelector('form')!.addEventListener('submit', (event) => {
        event.preventDefault();
        void run(async () => show(await save()));
    });
    for (const [id, action] of [
        ['lf-connect', 'authorize'],
        ['lf-finish', 'finish'],
        ['lf-disconnect', 'disconnect'],
        ['wb-disconnect', 'disconnectWebhook'],
    ])
        panel.querySelector('#' + id)!.addEventListener(
            'click',
            () =>
                void run(async () => {
                    if (action === 'authorize') await save();
                    show(await invoke<Status>('lastfm_action', { action }));
                    if (action === 'authorize')
                        status.textContent = t(
                            'Разрешите доступ в открывшемся браузере, затем нажмите «Завершить вход».',
                            'Approve access in your browser, then press Finish sign-in.',
                        );
                }),
        );
    show(await invoke<Status>('listening_options'));
}
