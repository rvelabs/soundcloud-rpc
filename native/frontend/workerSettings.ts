import { invoke } from './bridge';
type Account = { id: string; name: string };
export async function installWorkerSettings(ru: boolean): Promise<void> {
    const t = (r: string, e: string) => (ru ? r : e);
    const section = document.createElement('section');
    section.className = 'settings-section';
    section.dataset.pane = 'connection';
    section.hidden = true;
    section.innerHTML = `<h2>${t('Создать или обновить Worker', 'Create or update Worker')}</h2><p class="muted">${t('Создайте API-токен Cloudflare с правами Account Settings: Read и Workers Scripts: Edit. Токен хранится только в памяти на время настройки; адрес и ключ Worker сохраняются зашифрованными.', 'Create a Cloudflare API token with Account Settings: Read and Workers Scripts: Edit. The token stays in memory during setup; the Worker address and key are saved encrypted.')}</p><button type="button" class="secondary" id="cf-dashboard">${t('Открыть Cloudflare', 'Open Cloudflare')}</button><label for="cf-token">Cloudflare API token</label><input id="cf-token" type="password" maxlength="256" autocomplete="off"><div class="buttons"><button type="button" id="cf-authorize">${t('Подключить аккаунт', 'Connect account')}</button></div><label id="cf-account-label" for="cf-account" hidden>${t('Аккаунт Cloudflare', 'Cloudflare account')}</label><select id="cf-account" hidden></select><div class="buttons"><button type="button" id="cf-deploy" hidden>${t('Создать / обновить Worker', 'Create / update Worker')}</button><button type="button" id="cf-probe" class="secondary">${t('Проверить Worker', 'Check Worker')}</button><button type="button" id="cf-copy" class="secondary">${t('Скопировать диагностику', 'Copy diagnostics')}</button><button type="button" id="cf-files" class="secondary">${t('Файлы Worker', 'Worker files')}</button></div><p class="muted" id="cf-status" role="status" aria-live="polite"></p><pre id="cf-report" hidden></pre>`;
    document.getElementById('connection-form')!.after(section);
    const get = <T extends HTMLElement>(id: string) => section.querySelector<T>('#' + id)!;
    const token = get<HTMLInputElement>('cf-token'),
        account = get<HTMLSelectElement>('cf-account'),
        status = get<HTMLElement>('cf-status');
    const captions: Record<string, string> = {
        'Reading the workers.dev address…': 'Получаем адрес workers.dev…',
        'Creating your first workers.dev address…': 'Создаём адрес workers.dev…',
        'Uploading the Worker and its connection key…': 'Загружаем Worker и его ключ…',
        'Enabling the HTTPS address…': 'Включаем HTTPS-адрес…',
    };
    window.addEventListener('native-worker-progress', (event) => {
        const message = (event as CustomEvent<string>).detail;
        status.textContent = ru ? captions[message] || message : message;
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
    const action = <T>(action: string, fields: object = {}) =>
        invoke<T>('worker_setup_action', { action, token: null, account: null, ...fields });
    get('cf-dashboard').onclick = () =>
        void run(async () => {
            await action('dashboard');
        });
    get('cf-files').onclick = () =>
        void run(async () => {
            await action('files');
        });
    get('cf-authorize').onclick = () =>
        void run(async () => {
            status.textContent = t('Подключаем аккаунт…', 'Connecting account…');
            try {
                const response = await action<{ accounts: Account[] }>('authorize', { token: token.value.trim() });
                account.replaceChildren();
                for (const item of response.accounts) {
                    const option = document.createElement('option');
                    option.value = item.id;
                    option.textContent = item.name;
                    account.append(option);
                }
                account.hidden = false;
                get('cf-account-label').hidden = false;
                get('cf-deploy').hidden = false;
                status.textContent = t(
                    'Выберите аккаунт и создайте Worker.',
                    'Choose the account, then create the Worker.',
                );
            } finally {
                token.value = '';
            }
        });
    get('cf-deploy').onclick = () =>
        void run(async () => {
            const response = await action<{ endpoint: string }>('deploy', { account: account.value });
            (document.getElementById('endpoint') as HTMLInputElement).value = response.endpoint;
            (document.getElementById('mode') as HTMLSelectElement).value = 'auto';
            const key = document.getElementById('key') as HTMLInputElement;
            key.value = '';
            key.placeholder = t('Ключ создан и сохранён', 'Key created and saved');
            document.getElementById('restart')!.hidden = false;
            status.textContent = t(
                'Готово. Проверьте Worker, затем перезапустите клиент, чтобы применить подключение.',
                'Ready. Check the Worker, then restart the client to apply the connection.',
            );
        });
    get('cf-probe').onclick = () =>
        void run(async () => {
            status.textContent = t(
                'Проверяем страницу, API и скрипты через Worker…',
                'Checking the website, API and scripts through Worker…',
            );
            await invoke('connection_save', {
                mode: (document.getElementById('mode') as HTMLSelectElement).value,
                endpoint: (document.getElementById('endpoint') as HTMLInputElement).value.trim(),
                key: (document.getElementById('key') as HTMLInputElement).value.trim(),
            });
            const report = await action<{ success: boolean }>('probe');
            status.textContent = report.success
                ? t(
                      'Проверка прошла. Можно применить подключение перезапуском.',
                      'Check passed. Restart to apply the connection.',
                  )
                : t(
                      'Не все ресурсы доступны. Скопируйте диагностику подключения.',
                      'Some resources are unavailable. Copy the connection diagnostics.',
                  );
            document.getElementById('restart')!.hidden = false;
        });
    get('cf-copy').onclick = () =>
        void run(async () => {
            const report = JSON.stringify(await action('diagnostics'), null, 2);
            try {
                await navigator.clipboard.writeText(report);
                status.textContent = t('Диагностика скопирована.', 'Diagnostics copied.');
            } catch {
                get('cf-report').textContent = report;
                get('cf-report').hidden = false;
                status.textContent = t('Скопируйте отчёт ниже.', 'Copy the report below.');
            }
        });
}
