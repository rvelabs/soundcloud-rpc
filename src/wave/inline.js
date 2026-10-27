(() => {
    if (window.__soundcloudWaveInline) return;
    const api = window.waveInline;
    if (!api) return;
    window.__soundcloudWaveInline = true;
    let interfaceLanguage = window.__waveInitialLanguage || 'ru';
    const systemLocale = window.__waveSystemLocale || navigator.language;
    const resolvedLanguage = () =>
        (interfaceLanguage === 'auto' ? systemLocale : interfaceLanguage).toLowerCase().startsWith('ru') ? 'ru' : 'en';
    const t = (text, values = {}) => {
        if (window.__waveTranslate)
            return window.__waveTranslate(text, resolvedLanguage(), window.__waveEnglish || {}, values);
        return String(text).replace(/\{(\w+)\}/g, (match, key) =>
            values[key] === undefined ? match : String(values[key]),
        );
    };
    const translatedMarkup = [];
    const englishToOriginal = new Map(
        Object.entries(window.__waveEnglish || {}).map(([original, english]) => [english, original]),
    );
    const originalText = (text) => {
        const trimmed = text.trim();
        const key = englishToOriginal.get(trimmed);
        return /[А-Яа-яЁё]/.test(trimmed) ? trimmed : key;
    };
    const localizeMarkup = (container) => {
        const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) {
            const node = walk.currentNode,
                original = node.nodeValue;
            const key = originalText(original);
            if (key)
                translatedMarkup.push(() => {
                    if (node.parentNode) node.nodeValue = original.replace(original.trim(), t(key));
                });
        }
        for (const element of [container, ...container.querySelectorAll('*')])
            for (const attr of ['aria-label', 'title', 'placeholder']) {
                const original = element.getAttribute(attr);
                const key = original && originalText(original);
                if (key) translatedMarkup.push(() => element.setAttribute(attr, t(key)));
            }
    };
    const icon = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
    const icons = {
        play: icon('<path d="M8 5.4v13.2L18.5 12 8 5.4Z"/>'),
        pause: icon('<path d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z"/>'),
        shuffle: icon(
            '<path d="M4 7h2.2c3.7 0 5.5 10 9.6 10H20m0 0-3-3m3 3-3 3M4 17h2.2c1.5 0 2.6-1.4 3.7-3.2M13.8 10.2C15 8.4 15.9 7 17.8 7H20m0 0-3-3m3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        ),
    };
    const root = document.createElement('section');
    root.id = 'codex-wave-inline';
    root.setAttribute('aria-label', t('Моя волна'));
    root.innerHTML = `
      <div class="cw-hero">
        <div class="cw-aurora" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="cw-content">
          <div class="cw-kicker"><span class="cw-dot"></span> SOUNDCloud · персональная волна</div>
          <div class="cw-top"><div><h2>Моя волна</h2><p>Музыка под ваш вкус. Выбирайте настроение — остальное подберёт волна.</p></div>
          <div class="cw-actions"><button class="cw-start" type="button" data-command="start">${icons.play}${icons.pause}<span>Слушать</span></button>
          <button class="cw-stop" type="button" data-command="stop">Завершить волну</button>
          <button class="cw-settings-open" type="button" data-command="settings-open">Настроить</button></div></div>
          <div class="cw-options" aria-label="Настройки подбора">
            <div class="cw-option"><span>Настроение</span><div role="group"><button data-setting="mood" data-value="any">Любое</button><button data-setting="mood" data-value="calm">Спокойное</button><button data-setting="mood" data-value="energetic">Бодрое</button><button data-setting="mood" data-value="happy">Весёлое</button><button data-setting="mood" data-value="sad">Грустное</button></div></div>
            <div class="cw-option"><span>Звучание</span><div role="group"><button data-setting="tone" data-value="any">Любое</button><button data-setting="tone" data-value="balanced">Сбалансированное</button><button data-setting="tone" data-value="bass">Басовое</button><button data-setting="tone" data-value="bright">Яркое</button></div></div>
            <div class="cw-option"><span>Темп</span><div role="group"><button data-setting="tempo" data-value="any">Любой</button><button data-setting="tempo" data-value="slow">Медленный</button><button data-setting="tempo" data-value="medium">Средний</button><button data-setting="tempo" data-value="fast">Быстрый</button></div></div>
            <div class="cw-option"><span>По характеру</span><div role="group"><button data-setting="discovery" data-value="favorites">Любимое</button><button data-setting="discovery" data-value="new">Незнакомое</button><button data-setting="discovery" data-value="popular">Популярное</button><button data-setting="discovery" data-value="balanced">Баланс</button></div></div>
            <div class="cw-option"><span>Под занятие</span><div role="group"><button data-setting="activity" data-value="any">Любое</button><button data-setting="activity" data-value="wake">Просыпаюсь</button><button data-setting="activity" data-value="commute">В дороге</button><button data-setting="activity" data-value="focus">Работаю</button><button data-setting="activity" data-value="relax">Отдых</button><button data-setting="activity" data-value="workout">Тренируюсь</button><button data-setting="activity" data-value="sleep">Засыпаю</button></div></div>
            <div class="cw-option"><span>По языку</span><div role="group"><button data-setting="language" data-value="any">Любой</button><button data-setting="language" data-value="ru">Русский</button><button data-setting="language" data-value="foreign">Иностранный</button><button data-setting="language" data-value="instrumental">Без слов</button></div></div>
          </div>
        </div>
      </div>
      <p class="cw-status" role="status">Рекомендации SoundCloud + ваш локальный вкус</p>
      <div class="cw-insight" hidden><details><summary>Почему этот трек</summary><p class="cw-reasons"></p><span class="cw-evidence"></span></details><button type="button" data-command="dislike" title="Меньше похожих рекомендаций">Не подходит</button><button type="button" data-command="exclude-artist" title="Исключить этого исполнителя из Моей волны">Не предлагать исполнителя</button></div>
      <dialog class="cw-import-dialog" aria-label="Импорт плейлиста">
        <div class="cw-import-head"><div><strong>Импорт плейлиста</strong><p>Плейлисты Яндекс Музыки, Spotify, YouTube Music и альбомы Spotify</p></div>
          <button type="button" data-command="import-close" aria-label="Закрыть">×</button></div>
        <div class="cw-import-source"><input type="url" placeholder="Ссылка на публичный плейлист или альбом Spotify" aria-label="Ссылка на плейлист или альбом Spotify">
          <button type="button" data-command="import-scan">Найти треки</button></div>
        <button class="cw-import-resume" type="button" data-command="import-resume" hidden>Продолжить сохранённый импорт</button>
        <button class="cw-import-file" type="button" data-command="import-file" title="CSV с названием и исполнителем или TXT «Исполнитель — Название»">Импорт из CSV/TXT</button>
        <label class="cw-import-title">Название в SoundCloud <input type="text" maxlength="100" aria-label="Название нового плейлиста" disabled></label>
        <div class="cw-import-progress" hidden><div class="cw-import-progress-head"><span class="cw-import-orbit" aria-hidden="true"></span><strong class="cw-import-caption">Готовим импорт</strong><span class="cw-import-count"></span></div><div class="cw-import-meter" role="progressbar" aria-label="Прогресс импорта" aria-valuemin="0" aria-valuemax="100"><i></i></div></div>
        <p class="cw-import-message" role="status">Найденные совпадения можно проверить перед созданием плейлиста.</p>
        <div class="cw-import-results" aria-live="polite"></div>
        <div class="cw-import-footer"><span class="cw-import-summary"></span><div class="cw-import-footer-actions"><button class="cw-import-cancel" type="button" data-command="import-cancel" hidden>Отменить поиск</button><button class="cw-import-commit" type="button" data-command="import-commit" disabled>Создать в SoundCloud</button></div></div>
      </dialog>`;
    const importCard = document.createElement('section');
    importCard.id = 'codex-playlist-import';
    importCard.setAttribute('aria-label', t('Импорт плейлистов'));
    importCard.innerHTML =
        '<div class="ci-copy"><span class="ci-icon" aria-hidden="true">' +
        icons.shuffle +
        '</span><div><h3>Ваша музыка — с вами</h3><p>Перенесите плейлист из Spotify, Яндекс Музыки или YouTube Music.</p></div></div><button class="cw-import-open" type="button" data-command="import-open">Перенести плейлист</button>';
    const importDialog = root.querySelector('.cw-import-dialog');
    importCard.append(importDialog);
    const settingsDialog = document.createElement('dialog');
    settingsDialog.className = 'cw-settings-dialog';
    settingsDialog.setAttribute('aria-label', t('Настроить Мою волну'));
    settingsDialog.innerHTML =
        '<div class="cw-settings-head"><h3>Настроить Мою волну</h3><button type="button" data-command="settings-reset" title="Сбросить настройки подбора" aria-label="Сбросить настройки подбора"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7V3m0 4h-4M20 7a8 8 0 1 0 0 10"/></svg></button><button type="button" data-command="settings-close" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>';
    const options = root.querySelector('.cw-options');
    const group = (key) => options.querySelector('[data-setting="' + key + '"]').closest('.cw-option');
    const groups = ['activity', 'discovery', 'mood', 'language'].map(group);
    const advanced = document.createElement('details');
    advanced.className = 'cw-advanced';
    advanced.innerHTML = '<summary>Дополнительно: звучание и темп</summary><div class="cw-advanced-content"></div>';
    advanced.lastElementChild.append(group('tone'), group('tempo'));
    options.replaceChildren(...groups, advanced);
    settingsDialog.append(options);
    const uiLanguage = document.createElement('label');
    uiLanguage.className = 'cw-interface-language';
    uiLanguage.innerHTML =
        '<span>Язык интерфейса</span><select aria-label="Язык интерфейса"><option value="auto">Автоматически</option><option value="ru">Русский</option><option value="en">English</option></select>';
    settingsDialog.insertBefore(uiLanguage, options);
    const languageHint = document.createElement('p');
    languageHint.className = 'cw-language-hint';
    languageHint.textContent = t('Фильтр языка выбирает треки с явной пометкой языка или отсутствия вокала.');
    settingsDialog.append(languageHint);
    const characterHint = document.createElement('p');
    characterHint.className = 'cw-language-hint';
    settingsDialog.append(characterHint);
    const exclusions = document.createElement('details');
    exclusions.className = 'cw-exclusions';
    exclusions.innerHTML =
        '<summary>Исключённые исполнители <span></span></summary><p>Действует только в Моей волне. Ваши лайки и подписки сохраняются.</p><div></div>';
    settingsDialog.append(exclusions);
    let excludedArtists = [];
    const renderExclusions = (artists) => {
        excludedArtists = artists;
        exclusions.querySelector('span').textContent = artists.length ? '· ' + artists.length : '';
        const list = exclusions.querySelector('div');
        list.replaceChildren();
        if (!artists.length) {
            list.textContent = t('Вы пока никого не исключили.');
            return;
        }
        for (const artist of artists) {
            const row = document.createElement('div'),
                name = document.createElement('span'),
                button = document.createElement('button');
            name.textContent = artist;
            button.type = 'button';
            button.textContent = t('Вернуть');
            button.dataset.command = 'restore-artist';
            button.dataset.artist = artist;
            row.append(name, button);
            list.append(row);
        }
    };
    renderExclusions([]);
    const diagnostics = document.createElement('div');
    diagnostics.className = 'cw-diagnostics';
    diagnostics.innerHTML =
        '<button type="button" data-command="copy-diagnostics">Скопировать диагностику</button><p>Версия, настройки, очередь и источники рекомендаций. В отчёте есть публичные ссылки треков; вход и токены не включаются.</p><span role="status"></span>';
    settingsDialog.append(diagnostics);
    root.append(settingsDialog);
    const presetSummary = document.createElement('p');
    presetSummary.className = 'cw-preset-summary';
    root.querySelector('.cw-content').append(presetSummary);
    let controls = {
        mood: 'any',
        tone: 'any',
        tempo: 'any',
        genre: '',
        discovery: 'balanced',
        activity: 'any',
        language: 'any',
    };
    let active = false;
    let heardCount = 0;
    let waveError = false;
    let playing = false;
    let candidate = null;
    let lastVisualAt = 0;
    let lastVisual = '';
    const importer = window.playlistImporter;
    let importBusy = false;
    let importScanning = false;
    let importScanPromise = Promise.resolve();
    let importTotal = 0,
        importCompleted = 0;
    let importMatches = [];
    const importRows = new Map();
    let lastImportProgress;
    const importMessage = (value) => {
        $('.cw-import-message').textContent = value;
    };
    const importError = (error) =>
        t(
            String(error?.message || 'Не удалось завершить импорт.')
                .replace(/^Error invoking remote method '[^']+':\s*/i, '')
                .replace(/^Error:\s*/i, ''),
        );
    const updateImportProgress = (phase, completed = 0, total = 0) => {
        lastImportProgress = { phase, completed, total };
        const progress = $('.cw-import-progress'),
            meter = $('.cw-import-meter');
        progress.hidden = false;
        progress.classList.toggle('is-busy', !['done', 'error'].includes(phase));
        progress.classList.toggle('is-indeterminate', !total && !['done', 'error'].includes(phase));
        progress.classList.toggle('is-error', phase === 'error');
        const captions = {
            source: t('Читаем плейлист'),
            matching: t('Ищем и проверяем треки'),
            checking: t('Проверяем доступность'),
            creating: t('Создаём плейлист'),
            adding: t('Добавляем музыку'),
            done: t('Готово'),
            error: total ? t('Проверка остановлена') : t('Не удалось прочитать источник'),
        };
        $('.cw-import-caption').textContent = captions[phase] || t('Готовим импорт');
        $('.cw-import-count').textContent = total ? `${Math.min(completed, total)} / ${total}` : '';
        const percent = total ? Math.min(100, Math.max(0, (completed / total) * 100)) : 0;
        meter.style.setProperty('--cw-import-progress', `${percent}%`);
        if (total) meter.setAttribute('aria-valuenow', String(Math.round(percent)));
        else meter.removeAttribute('aria-valuenow');
    };
    const updateImportSummary = () => {
        $('.cw-import-summary').textContent = importScanning
            ? importTotal
                ? t('Проверено {done} из {total}', { done: importCompleted, total: importTotal })
                : t('Готовим поиск…')
            : importMatches.length
              ? t('{found} доступных совпадений из {total}', {
                    found: importMatches.filter((item) => item.soundcloud).length,
                    total: importMatches.length,
                })
              : '';
        $('.cw-import-commit').textContent = importScanning
            ? t('Создать из найденных')
            : t('Добавить выбранные в SoundCloud');
        $('.cw-import-commit').disabled = (importBusy && !importScanning) || !$('.cw-import-results input:checked');
        $('.cw-import-file').disabled = importBusy;
        $('.cw-import-resume').disabled = importBusy;
    };
    const updateImportRow = (index) => {
        const entry = importMatches[index],
            nodes = importRows.get(index);
        if (!entry || !nodes) return;
        nodes.check.disabled = !entry.soundcloud || entry.imported || (importBusy && !importScanning);
        nodes.check.checked = Boolean(
            !entry.imported && entry.soundcloud && (entry.selected ?? entry.soundcloud.score >= 0.85),
        );
        nodes.source.textContent = `${entry.source.artist} — ${entry.source.title}`;
        nodes.found.textContent = entry.imported
            ? t('Добавлено в плейлист')
            : entry.pending
              ? t('Проверяем…')
              : entry.soundcloud
                ? `SoundCloud: ${entry.soundcloud.artist} — ${entry.soundcloud.title} (${Math.round(entry.soundcloud.score * 100)}%) · ${t(entry.soundcloud.availability?.evidence === 'playback' ? 'Воспроизведение подтверждено' : 'Доступен по метаданным')}`
                : t(entry.error || '') || t('В SoundCloud не найдено');
    };
    const renderImport = () => {
        const container = $('.cw-import-results');
        container.replaceChildren();
        importRows.clear();
        const fragment = document.createDocumentFragment();
        importMatches.forEach((_entry, index) => {
            const row = document.createElement('label');
            row.className = 'cw-import-row';
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.dataset.index = String(index);
            const text = document.createElement('span');
            const source = document.createElement('strong');
            const found = document.createElement('small');
            importRows.set(index, { check, source, found });
            updateImportRow(index);
            text.append(source, found);
            row.append(check, text);
            fragment.append(row);
        });
        container.append(fragment);
        updateImportSummary();
    };
    localizeMarkup(root);
    localizeMarkup(importCard);
    translatedMarkup.forEach((render) => render());
    const $ = (selector) => root.querySelector(selector) || importCard.querySelector(selector);
    let homeMain = null;
    const isHome = () => ['/', '/discover'].includes(location.pathname.replace(/\/+$/, '') || '/');
    const detach = () => {
        homeMain = null;
        if (importDialog.open || importBusy) {
            importCard.classList.add('ci-detached');
            if (importCard.parentElement !== document.body) document.body.append(importCard);
        } else importCard.remove();
        if ((active || settingsDialog.open) && document.body) {
            root.classList.add('cw-detached');
            if (root.parentElement !== document.body) document.body.appendChild(root);
        } else if (root.isConnected) root.remove();
    };
    const place = () => {
        if (!isHome()) {
            detach();
            return;
        }
        const page = document.querySelector('#content') || document.querySelector('main,[role="main"]');
        const main = page?.querySelector('.l-main,main,[role="main"]') || page;
        if (!main) {
            detach();
            return;
        }
        homeMain = main;
        const headings = [...main.querySelectorAll('h1,h2,h3,h4,[role="heading"]')];
        const heading = headings.find((node) =>
            /more of what you like|больше того, что вам нравится/i.test(node.textContent || ''),
        );
        const personalized =
            heading?.closest('.mixedSelectionModule, .lazyLoadingList__item, .module, section') ||
            heading?.parentElement?.parentElement;
        const content = [...main.children].find((node) => node.classList.contains('l-content')) || main;
        const target =
            personalized && main.contains(personalized) && !personalized.contains(root) ? personalized : null;
        const host = target?.parentElement || content;
        const before = target || [...host.children].find((node) => node !== root && node !== importCard) || null;
        root.classList.remove('cw-detached');
        root.dataset.placement = target ? 'personalized' : 'home';
        importCard.classList.remove('ci-detached');
        if (importCard.parentElement !== host || importCard.nextElementSibling !== before)
            host.insertBefore(importCard, before);
        if (root.parentElement !== host || root.nextElementSibling !== importCard) host.insertBefore(root, importCard);
    };
    let pending = false;
    const schedule = () => {
        if (pending) return;
        pending = true;
        setTimeout(() => {
            pending = false;
            place();
        }, 250);
    };
    const observer = new MutationObserver((records) => {
        if (!isHome()) return;
        if (
            root.isConnected &&
            homeMain?.isConnected &&
            records.every(
                (record) =>
                    root.contains(record.target) ||
                    importCard.contains(record.target) ||
                    !homeMain.contains(record.target) ||
                    [...record.addedNodes, ...record.removedNodes].every(
                        (node) => node === root || node === importCard || node.nodeType !== 1,
                    ),
            )
        )
            return;
        schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    place();
    let windowActive = false;
    let inViewport = true;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => {
        const moving =
            windowActive &&
            !document.hidden &&
            inViewport &&
            !root.classList.contains('cw-detached') &&
            !reducedMotion.matches;
        root.classList.toggle('cw-motion', moving);
        root.classList.toggle('cw-window-hidden', !windowActive || document.hidden);
    };
    const updateVisibility = (visible) => {
        windowActive = Boolean(visible);
        updateMotion();
    };
    const intersection = new IntersectionObserver(
        (entries) => {
            inViewport = entries[0]?.isIntersecting ?? false;
            updateMotion();
        },
        { threshold: 0 },
    );
    intersection.observe(root);
    reducedMotion.addEventListener('change', updateMotion);
    window.addEventListener(
        'pagehide',
        () => {
            intersection.disconnect();
            reducedMotion.removeEventListener('change', updateMotion);
            observer.disconnect();
        },
        { once: true },
    );
    const closeDialog = (dialog) => {
        if (!dialog.open || dialog.dataset.closing) return;
        if (reducedMotion.matches) {
            dialog.close();
            return;
        }
        dialog.dataset.closing = 'true';
        const motion = dialog.animate(
            [
                { opacity: 1, transform: 'translateY(0)' },
                { opacity: 0, transform: dialog === settingsDialog ? 'translateX(32px)' : 'translateY(12px)' },
            ],
            { duration: 180, easing: 'ease-in', fill: 'forwards' },
        );
        void motion.finished
            .catch(() => {})
            .finally(() => {
                dialog.close();
                delete dialog.dataset.closing;
                motion.cancel();
            });
    };
    settingsDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeDialog(settingsDialog);
    });
    importDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (!importBusy) closeDialog(importDialog);
        else importMessage(t('Дождитесь завершения текущего действия.'));
    });
    for (const dialog of [settingsDialog, importDialog])
        dialog.addEventListener('click', (event) => {
            if (event.target !== dialog) return;
            const r = dialog.getBoundingClientRect();
            if (
                event.clientX >= r.left &&
                event.clientX <= r.right &&
                event.clientY >= r.top &&
                event.clientY <= r.bottom
            )
                return;
            if (dialog === importDialog && importBusy) return;
            closeDialog(dialog);
        });
    api.on('visibility', updateVisibility);
    document.addEventListener('visibilitychange', updateMotion);
    const renderControls = () => {
        const selectedLabels = [...root.querySelectorAll('[data-setting]')]
            .filter(
                (button) =>
                    controls[button.dataset.setting] === button.dataset.value &&
                    !['any', 'balanced'].includes(button.dataset.value),
            )
            .map((button) => button.textContent.trim());
        presetSummary.textContent =
            selectedLabels.filter(Boolean).join(' · ') || t('По вашему вкусу · все настройки открыты');
        languageHint.hidden = !controls.language || controls.language === 'any';
        characterHint.textContent =
            controls.discovery === 'favorites'
                ? t('Любимое — ваши лайки и треки, которые вы слушали с интересом.')
                : controls.discovery === 'popular'
                  ? t('Популярное — от 1000 прослушиваний в SoundCloud, с учётом вашего вкуса.')
                  : '';
        characterHint.hidden = !characterHint.textContent;
        root.querySelectorAll('[data-setting]').forEach((button) => {
            const selected = controls[button.dataset.setting] === button.dataset.value;
            button.setAttribute('aria-pressed', String(selected));
        });
    };
    const updateActive = (value) => {
        active = Boolean(value);
        renderExplanation(candidate);
        if (!active) playing = false;
        root.classList.toggle('cw-active', active);
        root.classList.toggle('cw-playing', playing);
        document.documentElement.classList.toggle('codex-wave-active', active);
        $('.cw-start span').textContent = active ? t('Волна включена') : t('Слушать');
        $('.cw-start').setAttribute('aria-pressed', String(active));
        schedule();
    };
    const updateTrack = (track) => {
        if (!track?.title) return;
        playing = Boolean(track.isPlaying);
        root.classList.toggle('cw-playing', playing);
    };
    const handleClick = (event) => {
        const button = event.target.closest('button');
        if (!button || (!root.contains(button) && !importCard.contains(button))) return;
        if (button.dataset.setting) {
            controls[button.dataset.setting] = button.dataset.value;
            renderControls();
            api.controls(controls);
            $('.cw-status').textContent = active
                ? t('Подберём следующие треки с этой настройкой')
                : t('Настройка применится при запуске волны');
            return;
        }
        const command = button.dataset.command;
        if (command === 'copy-diagnostics') {
            if (!api.copyDiagnostics) return;
            button.disabled = true;
            void api
                .copyDiagnostics()
                .then(() => {
                    diagnostics.querySelector('span').textContent = t('Отчёт скопирован');
                })
                .catch(() => {
                    diagnostics.querySelector('span').textContent = t('Не удалось скопировать отчёт');
                })
                .finally(() => {
                    button.disabled = false;
                });
            return;
        }
        if (command === 'settings-open') {
            if (!settingsDialog.open) settingsDialog.showModal();
            return;
        }
        if (command === 'settings-close') {
            closeDialog(settingsDialog);
            return;
        }
        if (command === 'settings-reset') {
            controls = {
                mood: 'any',
                tone: 'any',
                tempo: 'any',
                genre: '',
                discovery: 'balanced',
                activity: 'any',
                language: 'any',
            };
            renderControls();
            api.controls(controls);
            return;
        }
        if (command === 'import-open') {
            if (!importer) {
                $('.cw-status').textContent = t('Импорт недоступен в этой сборке.');
                return;
            }
            $('.cw-import-dialog').showModal();
            $('.cw-import-source input').focus();
            if (importer.draft && !importBusy)
                void importer
                    .draft()
                    .then((draft) => {
                        if (!draft || importBusy || !$('.cw-import-dialog').open) return;
                        importMatches = draft.matches.map((item, index) => ({
                            ...item,
                            selected: draft.selected ? draft.selected.includes(index) : undefined,
                            imported:
                                draft.writtenTitle === (draft.title || draft.source.title) &&
                                draft.savedUrls?.includes(item.soundcloud?.url),
                        }));
                        $('.cw-import-title input').value = draft.title || draft.source.title;
                        $('.cw-import-title input').disabled = false;
                        $('.cw-import-resume').hidden = false;
                        renderImport();
                        importMessage(t('Найденные треки сохранены — их можно добавить в плейлист.'));
                    })
                    .catch(() => {});
            return;
        }
        if (command === 'import-close') {
            if (!importBusy) closeDialog(importDialog);
            else importMessage(t('Дождитесь завершения текущего действия.'));
            return;
        }
        if (command === 'import-scan' || command === 'import-file' || command === 'import-resume') {
            if (importBusy) return;
            const fromFile = command === 'import-file',
                previousMatches = importMatches,
                previousTitle = $('.cw-import-title input').value;
            const link = $('.cw-import-source input').value.trim();
            importBusy = true;
            importScanning = true;
            importMatches = [];
            renderImport();
            button.disabled = true;
            $('.cw-import-source button').disabled = true;
            importTotal = 0;
            importCompleted = 0;
            updateImportProgress('source');
            $('.cw-import-source input').disabled = true;
            $('.cw-import-cancel').hidden = false;
            $('.cw-import-cancel').disabled = false;
            $('.cw-import-title input').value = '';
            $('.cw-import-title input').disabled = true;
            importMessage(t('Читаем плейлист…'));
            importScanPromise = importer[fromFile ? 'scanFile' : command === 'import-resume' ? 'resume' : 'scan'](link)
                .then((result) => {
                    if (result.cancelled) {
                        importMatches = previousMatches;
                        $('.cw-import-title input').value = previousTitle;
                        $('.cw-import-progress').hidden = true;
                        importMessage('');
                        return;
                    }
                    importMatches = (result.matches || []).map((item, index) => ({
                        ...item,
                        selected: result.selectedIndexes
                            ? result.selectedIndexes.includes(index)
                            : importMatches[index]?.selected,
                        imported:
                            result.writtenTitle === result.title && result.savedUrls?.includes(item.soundcloud?.url),
                    }));
                    renderImport();
                    $('.cw-import-title input').value = result.title || '';
                    $('.cw-import-title input').disabled = false;
                    importMessage(
                        t('{title}: проверьте совпадения перед добавлением.', { title: result.title }) +
                            (result.partial
                                ? t(
                                      ' Источник показал только часть треков. Для полного списка используйте импорт CSV/TXT.',
                                  )
                                : ''),
                    );
                    updateImportProgress('done', importMatches.length, importMatches.length);
                })
                .catch((error) => {
                    importMatches = importMatches.map((item) =>
                        item.pending ? { ...item, pending: false, error: 'Проверка остановлена.' } : item,
                    );
                    importMessage(
                        importError(error) +
                            (importMatches.some((item) => item.soundcloud)
                                ? t(' Найденные треки сохранены — их можно добавить в плейлист.')
                                : ''),
                    );
                    updateImportProgress('error', importCompleted, importTotal);
                })
                .finally(() => {
                    importBusy = false;
                    importScanning = false;
                    button.disabled = false;
                    $('.cw-import-source button').disabled = false;
                    $('.cw-import-source input').disabled = false;
                    $('.cw-import-title input').disabled = false;
                    $('.cw-import-cancel').hidden = true;
                    renderImport();
                });
            return;
        }
        if (command === 'import-cancel') {
            if (importScanning) {
                button.disabled = true;
                importMessage(t('Отменяем поиск…'));
                importer.cancel();
            }
            return;
        }
        if (command === 'import-commit') {
            if (importScanning) {
                button.disabled = true;
                importMessage(t('Останавливаем поиск и сохраняем найденную часть…'));
                importer.cancel();
                void importScanPromise.then(() => button.click());
                return;
            }
            if (importBusy) return;
            const indexes = [...importCard.querySelectorAll('.cw-import-results input:checked')].map((input) =>
                Number(input.dataset.index),
            );
            if (!indexes.length) {
                importMessage(t('Выберите хотя бы один найденный трек.'));
                return;
            }
            importBusy = true;
            button.disabled = true;
            $('.cw-import-file').disabled = true;
            $('.cw-import-source button').disabled = true;
            updateImportProgress('checking', 0, indexes.length);
            importMessage(t('Создаём плейлист в SoundCloud…'));
            void importer
                .commit({ indexes, title: $('.cw-import-title input').value.trim() })
                .then((result) => {
                    importMessage(
                        t('Готово: добавлено {count} треков в «{title}».', {
                            count: result.added,
                            title: result.title,
                        }) +
                            (result.already ? t(' Уже были в плейлисте: {count}.', { count: result.already }) : '') +
                            (result.failures.length
                                ? t(' Не удалось добавить {count}.', { count: result.failures.length })
                                : '') +
                            (result.unmatched
                                ? t(' Без совпадений или ещё не проверено: {count}. Найденная часть сохранена.', {
                                      count: result.unmatched,
                                  })
                                : '') +
                            (result.duplicates ? t(' Повторы пропущены: {count}.', { count: result.duplicates }) : ''),
                    );
                    const saved = new Set(result.successfulUrls || []);
                    importMatches = importMatches.map((item) =>
                        saved.has(item.soundcloud?.url) ? { ...item, imported: true } : item,
                    );
                    renderImport();
                    updateImportProgress('done', result.added + result.already, result.added + result.already);
                })
                .catch((error) => {
                    importMessage(importError(error));
                    updateImportProgress('error');
                })
                .finally(() => {
                    importBusy = false;
                    $('.cw-import-source button').disabled = false;
                    renderImport();
                });
            return;
        }
        if (command === 'exclude-artist' || command === 'restore-artist') {
            const artist = command === 'exclude-artist' ? candidate?.artist : button.dataset.artist;
            if (!artist || !api.excludeArtist) return;
            button.disabled = true;
            void api
                .excludeArtist(artist, command === 'exclude-artist')
                .then(renderExclusions)
                .catch((error) => {
                    $('.cw-status').textContent = error.message || t('Не удалось изменить исключения');
                })
                .finally(() => {
                    button.disabled = false;
                });
            return;
        }
        if (command === 'dislike') {
            if (!candidate || !api.dislike) return;
            button.disabled = true;
            void api
                .dislike(candidate.url)
                .catch((error) => {
                    $('.cw-status').textContent = error.message || t('Не удалось сменить трек');
                })
                .finally(() => {
                    button.disabled = false;
                });
            return;
        }
        if (command === 'start') {
            if (!active || waveError) {
                $('.cw-status').textContent = t('Ищем вашу музыку…');
                button.disabled = true;
                void api
                    .start()
                    .catch((error) => {
                        $('.cw-status').textContent = error.message || t('Не удалось запустить волну');
                    })
                    .finally(() => {
                        button.disabled = false;
                    });
            } else
                $('.cw-status').textContent = t(
                    'Следующий трек готовится заранее. Воспроизведением управляет SoundCloud.',
                );
        } else if (command) api.control(command);
    };
    root.addEventListener('click', handleClick);
    importCard.addEventListener('click', handleClick);

    const renderExplanation = (item) => {
        $('.cw-insight').hidden = !item || !active;
        $('.cw-reasons').textContent =
            item?.recommendationReasons
                ?.filter((reason) => reason !== 'похож на пропущенное')
                .map((reason) => t(reason))
                .slice(0, 3)
                .join(' · ') || t('Подбор по вашему вкусу и настройкам');
        $('.cw-evidence').textContent =
            item?.bpm && item.bpmConfidence >= 0.65
                ? [item.genre, t('BPM из метаданных: ') + item.bpm].filter(Boolean).join(' · ')
                : [item?.genre, t('Темп без подтверждённого BPM оценивается по тегам')].filter(Boolean).join(' · ');
    };
    $('.cw-import-results').addEventListener('change', (event) => {
        const index = Number(event.target.dataset.index);
        if (importMatches[index]) importMatches[index].selected = event.target.checked;
        updateImportSummary();
        saveImportSelection();
    });
    $('.cw-import-title input').addEventListener('change', () => saveImportSelection());
    const saveImportSelection = () => {
        if (!importer?.selection) return;
        importer.selection({
            title: $('.cw-import-title input').value,
            indexes: importMatches.flatMap((item, index) =>
                (item.selected ?? item.soundcloud?.score >= 0.85) ? [index] : [],
            ),
        });
    };
    if (importer)
        importer.onProgress((state) => {
            if (!$('.cw-import-dialog').open || !importBusy || !state) return;
            if (importScanning) {
                importTotal = state.total || importTotal;
                importCompleted = state.completed || 0;
            }
            updateImportProgress(state.phase, state.completed, state.total);
            if (importScanning && Array.isArray(state.tracks)) {
                importMatches = state.tracks.map((source) => ({ source, pending: true }));
                $('.cw-import-title input').value = state.title || '';
                renderImport();
            }
            if (
                importScanning &&
                Number.isInteger(state.index) &&
                state.match &&
                state.index >= 0 &&
                state.index < importMatches.length
            ) {
                importMatches[state.index] = state.match;
                updateImportRow(state.index);
                updateImportSummary();
            }
            if (importScanning) updateImportSummary();
            importMessage(`${state.detail || t('Импорт')}${state.total ? ` · ${state.completed}/${state.total}` : ''}`);
        });
    api.on('active', updateActive);
    api.on('track', updateTrack);
    api.on('candidate', (item) => {
        let palette = 0;
        for (const char of item?.url || '') palette = (palette * 31 + char.charCodeAt(0)) | 0;
        root.style.setProperty('--cw-hue', ((palette >>> 0) % 100) - 50 + 'deg');
        candidate = item;
        renderExplanation(item);
    });
    api.on('audio', (features) => {
        if (!features || root.classList.contains('cw-window-hidden')) return;
        const now = Date.now();
        if (now - lastVisualAt < 500) return;
        const brightness = Math.round((0.7 + Math.min(1, features.energy || 0) * 0.8) * 20) / 20;
        const hue = Math.round(((features.treble || 0) - (features.bass || 0)) * 18) * 5;
        const visual = `${brightness}:${hue}`;
        if (visual !== lastVisual) {
            root.style.setProperty('--cw-brightness', String(brightness));
            root.style.setProperty('--cw-hue', `${hue}deg`);
            lastVisual = visual;
        }
        lastVisualAt = now;
    });
    api.on('excluded-artists', renderExclusions);
    api.on('controls', (value) => {
        controls = { ...controls, ...value };
        renderControls();
    });
    api.on('state', (state, message) => {
        waveError = state === 'error';
        root.classList.toggle('cw-loading', state === 'loading');
        $('.cw-start span').textContent = waveError
            ? t('Повторить подбор')
            : active
              ? t('Волна включена')
              : t('Слушать');
        $('.cw-status').textContent =
            state === 'loading'
                ? t('Ищем вашу музыку…')
                : state === 'playing'
                  ? String(t(message || t('Следующий трек готовится заранее')))
                  : String(t(message || 'Не удалось запустить волну'));
    });
    api.on('stats', (stats) => {
        heardCount = stats?.heard || 0;
        if (stats?.heard)
            $('.cw-kicker').textContent = t('МОЯ ВОЛНА · учтено {count} прослушиваний', { count: stats.heard });
    });
    api.on('scroll', () => {
        schedule();
        setTimeout(() => root.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
    });
    api.on('route', schedule);
    const applyInterfaceLanguage = (value) => {
        interfaceLanguage = ['auto', 'ru', 'en'].includes(value) ? value : 'auto';
        root.lang = importCard.lang = resolvedLanguage();
        uiLanguage.querySelector('select').value = interfaceLanguage;
        translatedMarkup.forEach((render) => render());
        renderControls();
        renderExplanation(candidate);
        renderExclusions(excludedArtists);
        renderImport();
        if (lastImportProgress)
            updateImportProgress(lastImportProgress.phase, lastImportProgress.completed, lastImportProgress.total);
        if (heardCount)
            $('.cw-kicker').textContent = t('МОЯ ВОЛНА · учтено {count} прослушиваний', { count: heardCount });
        $('.cw-start span').textContent = t(waveError ? 'Повторить подбор' : active ? 'Волна включена' : 'Слушать');
        $('.cw-status').textContent = t(
            active ? 'Следующий трек готовится заранее' : 'Рекомендации SoundCloud + ваш локальный вкус',
        );
    };
    uiLanguage.querySelector('select').addEventListener('change', async (event) => {
        const value = event.target.value;
        try {
            if (api.setLanguage) await api.setLanguage(value);
            applyInterfaceLanguage(value);
        } catch {
            uiLanguage.querySelector('select').value = interfaceLanguage;
        }
    });
    api.on('interface-language', applyInterfaceLanguage);
    void api.ready().then((state) => {
        if (!state) return;
        heardCount = state.stats?.heard || 0;
        applyInterfaceLanguage(state.interfaceLanguage || interfaceLanguage);
        renderExclusions(state.excludedArtists || []);
        controls = { ...controls, ...state.controls };
        renderControls();
        updateActive(state.active);
        updateVisibility(state.visible);
        if (state.candidate) candidate = state.candidate;
        renderExplanation(candidate);
        if (state.track) updateTrack(state.track);
    });
})();
