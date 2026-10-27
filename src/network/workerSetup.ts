import { randomBytes } from 'node:crypto';
export interface CloudflareAccount {
    id: string;
    name: string;
}
interface Envelope {
    success: boolean;
    result: unknown;
    result_info?: {
        total_count?: number;
    };
    errors?: {
        code?: number;
    }[];
}
export class WorkerSetup {
    private token = '';
    private accounts: CloudflareAccount[] = [];
    private expires = 0;
    private plan?: {
        account: string;
        name: string;
        secret: string;
        subdomain: string;
    };
    private busy = false;
    private lifetime?: ReturnType<typeof setTimeout>;
    constructor(
        private request: typeof fetch = fetch,
        private now = Date.now,
    ) {}
    clear(): void {
        this.token = '';
        this.accounts = [];
        this.expires = 0;
        this.plan = undefined;
        clearTimeout(this.lifetime);
    }
    private async api(path: string, init: RequestInit = {}): Promise<Envelope> {
        if (!this.token || this.now() > this.expires)
            throw new Error('Время настройки истекло. Подключите аккаунт заново.');
        let response: Response;
        try {
            response = await this.request('https://api.cloudflare.com/client/v4' + path, {
                ...init,
                redirect: 'error',
                signal: AbortSignal.timeout(20000),
                headers: { ...init.headers, Authorization: 'Bearer ' + this.token },
            });
        } catch {
            throw new Error('Cloudflare не ответил. Проверьте соединение и повторите настройку.');
        }
        let body: Envelope;
        try {
            body = (await response.json()) as Envelope;
        } catch {
            throw new Error('Cloudflare вернул неожиданный ответ. Повторите позже.');
        }
        if (response.status === 404 && path.endsWith('/workers/subdomain') && !init.method)
            throw new MissingSubdomainError();
        if (!response.ok || body.success !== true) {
            if ([401, 403].includes(response.status))
                throw new Error(
                    'Cloudflare отклонил токен. Нужны права Account Settings: Read и Workers Scripts: Edit для выбранного аккаунта.',
                );
            if (response.status === 429) throw new Error('Cloudflare ограничил запросы. Подождите и повторите.');
            throw new Error(
                'Cloudflare не подтвердил операцию (HTTP ' +
                    response.status +
                    '). Проверьте аккаунт Workers в браузере.',
            );
        }
        return body;
    }
    async authorize(value: unknown): Promise<CloudflareAccount[]> {
        if (this.busy) throw new Error('Настройка уже выполняется.');
        if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{20,256}$/.test(value.trim()))
            throw new Error('Вставьте API-токен Cloudflare, а не пароль или Global API Key.');
        this.clear();
        this.token = value.trim();
        this.expires = this.now() + 10 * 60000;
        this.busy = true;
        this.lifetime = setTimeout(() => {
            if (!this.busy) this.clear();
        }, 10 * 60000);
        this.lifetime.unref();
        try {
            const accounts: CloudflareAccount[] = [];
            for (let page = 1; page <= 10; page++) {
                const result = await this.api('/accounts?per_page=50&page=' + page);
                if (!Array.isArray(result.result)) throw new Error('Не удалось прочитать аккаунты Cloudflare.');
                const batch = result.result.filter((item): item is CloudflareAccount =>
                    Boolean(
                        item &&
                            typeof item === 'object' &&
                            /^[a-f0-9]{32}$/i.test(item.id) &&
                            typeof item.name === 'string',
                    ),
                );
                accounts.push(...batch);
                if (result.result.length < 50 || page * 50 >= (result.result_info?.total_count ?? Infinity)) break;
            }
            if (!accounts.length)
                throw new Error(
                    'Токен не открыл ни одного аккаунта Cloudflare. Проверьте выбранные Account Resources.',
                );
            this.accounts = accounts;
            return accounts;
        } catch (error) {
            this.clear();
            throw error;
        } finally {
            this.busy = false;
            if (this.now() > this.expires) this.clear();
        }
    }
    async deploy(
        accountId: unknown,
        modules: {
            entry: string;
            protocol: string;
            source: string;
        },
        progress: (message: string) => void,
        existing?: { endpoint: string; secret: string },
    ): Promise<{
        endpoint: string;
        secret: string;
        name: string;
        updated: boolean;
    }> {
        if (this.busy) throw new Error('Настройка уже выполняется.');
        if (!this.token || this.now() > this.expires)
            throw new Error('Время настройки истекло. Подключите аккаунт заново.');
        if (typeof accountId !== 'string' || !this.accounts.some((item) => item.id === accountId))
            throw new Error('Выберите доступный аккаунт Cloudflare.');
        this.busy = true;
        if (!this.plan || this.plan.account !== accountId) {
            const suffix = randomBytes(8).toString('hex');
            this.plan = {
                account: accountId,
                name: 'soundcloud-wave-' + suffix,
                secret: randomBytes(32).toString('hex'),
                subdomain: 'wave-' + suffix,
            };
        }
        let plan = this.plan;
        const base = '/accounts/' + accountId + '/workers';
        let updated = false;
        try {
            progress('Получаем адрес workers.dev…');
            let subdomain = '';
            try {
                const info = await this.api(base + '/subdomain');
                subdomain =
                    (
                        info.result as {
                            subdomain?: string;
                        } | null
                    )?.subdomain || '';
            } catch (error) {
                if (!(error instanceof MissingSubdomainError)) throw error;
            }
            if (!subdomain) {
                progress('Создаём первый адрес workers.dev для аккаунта…');
                const info = await this.api(base + '/subdomain', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subdomain: plan.subdomain }),
                });
                subdomain =
                    (
                        info.result as {
                            subdomain?: string;
                        }
                    )?.subdomain || '';
            }
            if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))
                throw new Error('Cloudflare не подтвердил адрес workers.dev. Завершите настройку Workers в браузере.');
            if (existing && /^[A-Za-z0-9_-]{32,256}$/.test(existing.secret)) {
                try {
                    const address = new URL(existing.endpoint),
                        suffix = '.' + subdomain + '.workers.dev';
                    const name = address.hostname.endsWith(suffix) ? address.hostname.slice(0, -suffix.length) : '';
                    if (
                        address.protocol === 'https:' &&
                        !address.username &&
                        !address.password &&
                        !address.port &&
                        /^soundcloud-wave-[a-z0-9-]{8,40}$/.test(name)
                    ) {
                        plan = { ...plan, name, secret: existing.secret };
                        this.plan = plan;
                        updated = true;
                    }
                } catch {}
            }
            const endpoint = 'https://' + plan.name + '.' + subdomain + '.workers.dev';
            const form = new FormData();
            form.append(
                'metadata',
                new Blob(
                    [
                        JSON.stringify({
                            main_module: 'worker.mjs',
                            compatibility_date: '2026-10-22',
                            bindings: [{ type: 'secret_text', name: 'RELAY_TOKEN', text: plan.secret }],
                        }),
                    ],
                    { type: 'application/json' },
                ),
            );
            form.append(
                'worker.mjs',
                new Blob([modules.entry], { type: 'application/javascript+module' }),
                'worker.mjs',
            );
            form.append(
                'protocol.mjs',
                new Blob([modules.protocol], { type: 'application/javascript+module' }),
                'protocol.mjs',
            );
            form.append(
                'playlist-source.mjs',
                new Blob([modules.source], { type: 'application/javascript+module' }),
                'playlist-source.mjs',
            );
            progress(
                updated
                    ? 'Обновляем код Worker, сохраняем адрес и ключ…'
                    : 'Загружаем Worker и создаём ключ подключения…',
            );
            await this.api(base + '/scripts/' + plan.name, { method: 'PUT', body: form });
            progress('Включаем HTTPS-адрес Worker…');
            const enabled = await this.api(base + '/scripts/' + plan.name + '/subdomain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true, previews_enabled: false }),
            });
            if (
                !(
                    enabled.result as {
                        enabled?: boolean;
                    }
                )?.enabled
            )
                throw new Error(
                    'Cloudflare пока не включил HTTPS-адрес. Повторите создание: мастер использует тот же Worker.',
                );
            return { endpoint, secret: plan.secret, name: plan.name, updated };
        } catch (error) {
            throw new Error(
                (error instanceof Error ? error.message : 'Ошибка настройки.') +
                    ' Worker этой попытки: ' +
                    plan.name +
                    '. При повторной попытке в этом окне используется то же имя.',
            );
        } finally {
            this.busy = false;
            if (this.now() > this.expires) this.clear();
        }
    }
}
class MissingSubdomainError extends Error {}
