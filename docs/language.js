(() => {
    const english = {
        Возможности: 'Features',
        'Windows · Open source · Бесплатно': 'Windows · Open source · Free',
        'Ваш SoundCloud.': 'Your SoundCloud.',
        'Ваша музыка.': 'Your music.',
        'Знакомый плеер, персональная «Моя волна» и плейлисты из других сервисов. Всё в одном настольном клиенте.':
            'A familiar player, your personal radio, and playlists from other services. All in one desktop app.',
        'Скачать для Windows ↗': 'Download for Windows ↗',
        Документация: 'Documentation',
        'Неофициальный клиент. Нужен аккаунт SoundCloud. Поддержка Windows x64.':
            'Unofficial client. Requires a SoundCloud account. Windows x64.',
        'Больше любимой музыки': 'More music to love',
        '01 / ПЕРСОНАЛЬНЫЙ ПОТОК': '01 / PERSONAL RADIO',
        'Моя волна': 'My Wave',
        'Похожие треки к вашим любимым записям, реакции на прослушивание и разнообразие исполнителей. Настроение, занятие и язык — в отдельной панели.':
            'Related tracks from your favorites, listening feedback and artist variety. Customize the mood, activity and music language.',
        '02 / ВАША КОЛЛЕКЦИЯ': '02 / YOUR COLLECTION',
        'Импорт плейлистов': 'Playlist import',
        'Вставьте ссылку Яндекс Музыки, Spotify или YouTube Music. Проверьте совпадения и создайте плейлист SoundCloud даже из найденной части.':
            'Paste a Yandex Music, Spotify or YouTube Music link. Review the matches and create a SoundCloud playlist, even from a partial result.',
        '03 / ПРИВЫЧНОЕ УПРАВЛЕНИЕ': '03 / FAMILIAR CONTROLS',
        'Штатный плеер': 'Native player',
        'Громкость, перемотка, очередь и лайки SoundCloud. Discord Rich Presence, Last.fm, темы и плагины дополняют клиент.':
            'SoundCloud volume, seeking, queue and likes. With Discord Rich Presence, Last.fm, themes and plugins.',
        'Как подбирается музыка': 'How music is selected',
        'Понравившиеся записи → похожие треки SoundCloud → персональное ранжирование → подготовленная очередь.':
            'Tracks you enjoy → related tracks on SoundCloud → personalized ranking → prepared queue.',
        'Подбор начинается с конкретной музыки. Текстовый поиск по названию жанра не используется для получения рекомендаций. Недавние повторы и исключённые исполнители отсекаются локально.':
            'Discovery starts from actual music. Recommendations do not use text searches for genre names. Recent repeats and excluded artists are filtered locally.',
        'Перед установкой': 'Before you install',
        'Это официальное приложение SoundCloud?': 'Is this an official SoundCloud app?',
        'Нет. Это открытый форк': 'No. This is an open-source fork of',
        '. SoundCloud и другие упомянутые сервисы принадлежат их владельцам; проект с ними не аффилирован.':
            '. SoundCloud and the other services belong to their respective owners. This project is not affiliated with them.',
        'Это тот же алгоритм, что у Яндекс Музыки?': 'Is this the Yandex Music algorithm?',
        'Нет. Закрытая модель Яндекса не копируется. Здесь используются похожие записи SoundCloud и собственное ранжирование. Для нового аккаунта добавьте несколько лайков или включите любимый трек. Неполные метаданные ограничивают точность настроения, языка и темпа.':
            'No. It uses related SoundCloud tracks and independent ranking. For a new account, like a few tracks or play a favorite. Incomplete metadata limits mood, music language and tempo matching.',
        'Перенесутся все треки моего плейлиста?': 'Will every track in my playlist be imported?',
        'Клиент ищет соответствующие записи в SoundCloud и не копирует аудиофайлы. Совпадения, версии и доступность зависят от каталога, региона и аккаунта. Spotify и YouTube могут отдавать неполный список; найденную часть можно сохранить отдельно.':
            'The client finds matching SoundCloud uploads without copying audio. Matches and availability depend on the catalog, region and account. Spotify and YouTube may return only part of a playlist; you can save the available matches.',
        'Почему Windows предупреждает об издателе?': 'Why does Windows warn about the publisher?',
        'Установщик пока не имеет доверенной цифровой подписи. Исходники и контрольная сумма SHA-256 доступны в GitHub Releases. Режим тестовой подписи Windows не требуется.':
            'The installer does not yet have a trusted publisher signature. Source code and SHA-256 checksums are available on GitHub Releases. Windows test-signing mode is not required.',
        'Как сообщить об ошибке?': 'How do I report a bug?',
        'Откройте «Моя волна» → «Настроить» → «Скопировать диагностику» и':
            'Open My Wave → Customize → Copy diagnostics and',
        'создайте issue': 'create an issue',
        '. Перед публикацией проверьте отчёт: он включает публичные ссылки на треки. Cookies и токены туда не включаются.':
            '. Review the public track links before sharing. Cookies and tokens are excluded.',
        'Исходный код': 'Source code',
        'Обратная связь': 'Feedback',
    };
    const entries = [];
    const labels = [...document.querySelectorAll('[data-en]')].map((element) => ({
        element,
        ru: element.innerHTML,
        en: element.dataset.en,
    }));
    const attributes = [...document.querySelectorAll('[data-en-alt],[data-en-label]')].map((element) => ({
        element,
        attribute: element.hasAttribute('data-en-alt') ? 'alt' : 'aria-label',
        en: element.dataset.enAlt || element.dataset.enLabel,
        ru: element.getAttribute(element.hasAttribute('data-en-alt') ? 'alt' : 'aria-label'),
    }));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName) || node.parentElement?.closest('[data-en]'))
            continue;
        const original = node.nodeValue;
        const key = original.replace(/\s+/g, ' ').trim();
        if (english[key]) entries.push({ node, original, key });
    }
    const originalTitle = document.title;
    const apply = (language) => {
        const locale = language === 'ru' ? 'ru' : 'en';
        document.documentElement.lang = locale;
        document.title =
            locale === 'ru' ? originalTitle : 'SoundCloud Desktop for Windows — My Wave & playlist import | rvelabs';
        for (const { node, original, key } of entries)
            node.nodeValue = locale === 'ru' ? original : original.replace(original.trim(), english[key]);
        for (const { element, ru, en } of labels) {
            if (locale === 'ru') element.innerHTML = ru;
            else element.textContent = en;
        }
        for (const { element, attribute, ru, en } of attributes)
            element.setAttribute(attribute, locale === 'ru' ? ru : en);
        for (const button of document.querySelectorAll('[data-site-language]'))
            button.setAttribute('aria-pressed', String(button.dataset.siteLanguage === locale));
        document
            .querySelector('nav')
            .setAttribute('aria-label', locale === 'ru' ? 'Основная навигация' : 'Main navigation');
        try {
            localStorage.setItem('interfaceLanguage', locale);
        } catch {}
    };
    for (const button of document.querySelectorAll('[data-site-language]'))
        button.addEventListener('click', () => apply(button.dataset.siteLanguage));
    let saved;
    try {
        saved = localStorage.getItem('interfaceLanguage');
    } catch {}
    apply(saved || (navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'));
})();
