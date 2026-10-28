export const interfaceEnglish: Record<string, string> = {
    'Резервное подключение SoundCloud': 'SoundCloud fallback connection',
    'Ваш Cloudflare Worker. В автоматическом режиме подключаемся через него только после проверки недоступности SoundCloud. Подключение действует только в этом клиенте.':
        'Your Cloudflare Worker. Automatic mode uses it after confirming that direct access to SoundCloud fails. It applies only to this client.',
    'Создать и настроить Worker автоматически': 'Create and configure a Worker automatically',
    'Откройте Cloudflare, войдите в аккаунт и создайте API-токен с правами Account Settings: Read и Workers Scripts: Edit для своего аккаунта. Вставьте его сюда. Мастер создаст Worker и его ключ, затем сам сохранит HTTPS-адрес. Токен Cloudflare хранится только в памяти на время настройки.':
        'Sign in to Cloudflare and create an API token with Account Settings: Read and Workers Scripts: Edit for your account. Paste it here. The wizard creates a Worker and relay key and saves the HTTPS address. The setup token is kept in memory only during setup.',
    'Открыть Cloudflare': 'Open Cloudflare',
    'API-токен Cloudflare (не пароль)': 'Cloudflare API token (not your password)',
    'API-токен Cloudflare': 'Cloudflare API token',
    'Подключить аккаунт': 'Connect account',
    'Аккаунт Cloudflare': 'Cloudflare account',
    'Обновим сохранённый Worker этого клиента в выбранном аккаунте, сохранив адрес и ключ. Если подходящего Worker нет, создадим отдельный со случайным именем. Остальные Workers и адрес аккаунта сохраняются.':
        'Update this client’s saved Worker in the selected account, keeping its address and key. If none is found, create a separate Worker with a random name. Other Workers and the account subdomain are preserved.',
    'Создать или обновить Worker': 'Create or update Worker',
    'Забыть токен': 'Forget setup token',
    'Или укажите адрес уже созданного Worker вручную:': 'Or enter an existing Worker address:',
    Выключено: 'Off',
    Автоматически: 'Automatic',
    'Всегда через Worker': 'Always through Worker',
    'Ключ сохранён. Оставьте пустым, чтобы сохранить его.': 'Key saved. Leave blank to keep it.',
    'Ключ Worker (RELAY_TOKEN)': 'Worker key (RELAY_TOKEN)',
    'Сохранить подключение': 'Save connection',
    'Проверяет сохранённые настройки': 'Test the saved settings',
    'Проверить Worker': 'Test Worker',
    'Скопировать диагностику подключения': 'Copy connection diagnostics',
    'Файлы Worker и инструкция': 'Worker files and instructions',
    'Для начала разверните Worker из комплекта исходников. Обычный прокси имеет приоритет.':
        'Deploy a Worker from the included sources first. A manually configured proxy takes priority.',
    'Получаем аккаунты Cloudflare…': 'Loading Cloudflare accounts…',
    'Выберите аккаунт и нажмите «Создать Worker». Токен будет забыт через 10 минут.':
        'Choose an account and create the Worker. The setup token expires from memory in 10 minutes.',
    'Токен удалён из памяти.': 'Setup token removed from memory.',
    'Создаём Worker…': 'Creating Worker…',
    'Адрес и ключ сохранены': 'Address and key saved',
    'Ключ создан и сохранён автоматически': 'Key created and saved automatically',
    'Worker обновлён: ': 'Worker updated: ',
    'Готово: ': 'Ready: ',
    'Автоматический режим настроен.': 'Automatic mode configured.',
    'Настройки сохранены. Обычный прокси имеет приоритет.': 'Settings saved. Your manual proxy takes priority.',
    'Проверяем подключение…': 'Testing connection…',
    'Резервное подключение выключено': 'Fallback connection is off',
    'Используется вручную настроенный прокси': 'Using your manually configured proxy',
    'Нужны адрес и ключ вашего Cloudflare Worker': 'Enter your Cloudflare Worker address and key',
    'SoundCloud подключён через Cloudflare': 'SoundCloud connected through Cloudflare',
    'Автоматически: сначала обычное подключение': 'Automatic: try direct access first',
    'Обычное подключение работает': 'Direct connection works',
    'Не удалось восстановить подключение': 'Could not restore the connection',
    ' Автоперезагрузки остановлены.': ' Automatic reloads stopped.',
    'Настройки сохранены.': 'Settings saved.',
    'Диагностика скопирована.': 'Diagnostics copied.',
    'Читаем продолжение плейлиста…': 'Reading the next playlist page…',
};
const staticRussian: Record<string, string> = {
    'UI Customization': 'Оформление интерфейса',
    'Account Manager': 'Аккаунты',
    'Switch Account': 'Выбрать аккаунт',
    'Add Account': 'Добавить аккаунт',
    'Log Out': 'Выйти',
    Logout: 'Выйти',
    Username: 'Имя пользователя',
    Password: 'Пароль',
};
export function interfaceText(value: string, language: string): string {
    if (language === 'ru') return value;
    if (interfaceEnglish[value]) return interfaceEnglish[value];
    let result = value;
    for (const key of ['Worker обновлён: ', 'Готово: ', ' Автоперезагрузки остановлены.'])
        result = result.replace(key, interfaceEnglish[key]);
    return result;
}
export function settingsMarkup(language: string): (parts: TemplateStringsArray, ...values: unknown[]) => string {
    const dictionary = language === 'ru' ? staticRussian : interfaceEnglish;
    const entries = Object.entries(dictionary).sort((a, b) => b[0].length - a[0].length);
    return (parts, ...values) =>
        parts
            .map((part, index) => {
                for (const [from, to] of entries) part = part.split(from).join(to);
                return part + (index < values.length ? String(values[index]) : '');
            })
            .join('');
}
