(() => {
    if (window.__soundcloudWaveInline) return;
    const api = window.waveInline;
    if (!api) return;
    window.__soundcloudWaveInline = true;
    const icon = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
    const icons = {
        play: icon('<path d="M8 5.4v13.2L18.5 12 8 5.4Z"/>'),
        pause: icon('<path d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z"/>'),
        previous: icon('<path d="M4 5h2v14H4zM19 5.3 8 12l11 6.7V5.3Z"/>'),
        next: icon('<path d="m5 5.3 11 6.7-11 6.7V5.3ZM18 5h2v14h-2z"/>'),
        shuffle: icon(
            '<path d="M4 7h2.2c3.7 0 5.5 10 9.6 10H20m0 0-3-3m3 3-3 3M4 17h2.2c1.5 0 2.6-1.4 3.7-3.2M13.8 10.2C15 8.4 15.9 7 17.8 7H20m0 0-3-3m3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        ),
        repeat: icon(
            '<path d="M19 8V6.5A2.5 2.5 0 0 0 16.5 4h-9A2.5 2.5 0 0 0 5 6.5V8m0 8v1.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V16M2.5 6 5 8.5 7.5 6M16.5 18l2.5-2.5L21.5 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        ),
        stop: icon('<path d="M5 5h14v14H5z"/>'),
        heart: icon(
            '<path d="M20.3 8.5c0 3.5-4.3 6.8-8.3 10-4-3.2-8.3-6.5-8.3-10a4.5 4.5 0 0 1 8.3-2.4 4.5 4.5 0 0 1 8.3 2.4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
        ),
        volume: icon(
            '<path d="M4 9v6h3.4l4.2 3.5v-13L7.4 9H4Zm10.1-.8a5.2 5.2 0 0 1 0 7.6m2.4-10a8.5 8.5 0 0 1 0 12.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        ),
        mute: icon(
            '<path d="M4 9v6h3.4l4.2 3.5v-13L7.4 9H4Zm10.5.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        ),
    };
    const root = document.createElement('section');
    root.id = 'codex-wave-inline';
    root.setAttribute('aria-label', 'Моя волна');
    root.innerHTML = `
      <div class="cw-hero">
        <div class="cw-aurora" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="cw-content">
          <div class="cw-kicker"><span class="cw-dot"></span> SOUNDCloud · персональная волна</div>
          <div class="cw-top"><div><h2>Моя волна</h2><p>Музыка под ваш вкус. Выбирайте настроение — остальное подберёт волна.</p></div>
          <div class="cw-actions"><button class="cw-start" type="button" data-command="start">${icons.play}${icons.pause}<span>Слушать</span></button>
          <button class="cw-stop" type="button" data-command="stop">Завершить волну</button>
          <button class="cw-settings-open" type="button" data-command="settings-open">Настроить</button><button class="cw-import-open" type="button" data-command="import-open">Импорт плейлиста</button></div></div>
          <div class="cw-options" aria-label="Настройки подбора">
            <div class="cw-option"><span>Настроение</span><div role="group"><button data-setting="mood" data-value="any">Любое</button><button data-setting="mood" data-value="calm">Спокойное</button><button data-setting="mood" data-value="energetic">Бодрое</button><button data-setting="mood" data-value="happy">Весёлое</button><button data-setting="mood" data-value="sad">Грустное</button></div></div>
            <div class="cw-option"><span>Звучание</span><div role="group"><button data-setting="tone" data-value="any">Любое</button><button data-setting="tone" data-value="balanced">Сбалансированное</button><button data-setting="tone" data-value="bass">Басовое</button><button data-setting="tone" data-value="bright">Яркое</button></div></div>
            <div class="cw-option"><span>Темп</span><div role="group"><button data-setting="tempo" data-value="any">Любой</button><button data-setting="tempo" data-value="slow">Медленный</button><button data-setting="tempo" data-value="medium">Средний</button><button data-setting="tempo" data-value="fast">Быстрый</button></div></div>
            <div class="cw-option"><span>По характеру</span><div role="group"><button data-setting="discovery" data-value="favorites">Любимое</button><button data-setting="discovery" data-value="new">Незнакомое</button><button data-setting="discovery" data-value="popular">Популярное</button><button data-setting="discovery" data-value="balanced">Баланс</button></div></div>
            <div class="cw-option"><span>Под занятие</span><div role="group"><button data-setting="activity" data-value="any">Любое</button><button data-setting="activity" data-value="wake">Просыпаюсь</button><button data-setting="activity" data-value="commute">В дороге</button><button data-setting="activity" data-value="focus">Работаю</button><button data-setting="activity" data-value="relax">Отдых</button><button data-setting="activity" data-value="workout">Тренируюсь</button><button data-setting="activity" data-value="sleep">Засыпаю</button></div></div>
            <div class="cw-option"><span>По языку</span><div role="group"><button data-setting="language" data-value="any">Любой</button><button data-setting="language" data-value="ru">Русский</button><button data-setting="language" data-value="foreign">Иностранный</button><button data-setting="language" data-value="instrumental">Без слов</button></div></div>
            <label class="cw-genre">Жанр <span class="cw-genre-fields"><select aria-label="Выбрать жанр">
              <option value="">Любой жанр</option><option>ambient</option><option>breakcore</option>
              <option>drum and bass</option><option>dubstep</option><option>electronic</option>
              <option>hardstyle</option><option>hip-hop</option><option>house</option>
              <option>indie</option><option>jazz</option><option>jungle</option><option>lofi</option>
              <option>metal</option><option>phonk</option><option>pop</option><option>rap</option>
              <option>rock</option><option>shoegaze</option><option>techno</option><option>trance</option>
            </select><input type="text" maxlength="40" placeholder="Или свой жанр" aria-label="Вписать свой жанр"></span></label>
          </div>
        </div>
      </div>
      <div class="cw-player-wrap" aria-hidden="true">
      <div class="cw-player">
        <div class="cw-art" aria-hidden="true">♫</div><div class="cw-track"><div class="cw-track-head"><strong class="cw-title">Подбираем трек…</strong><button class="cw-like" type="button" data-command="like" aria-label="Добавить в понравившиеся" aria-pressed="false" title="Добавить в понравившиеся">${icons.heart}</button></div><span class="cw-artist"></span><span class="cw-tags"></span></div>
        <div class="cw-transport"><button type="button" data-command="previous" aria-label="Предыдущий трек" title="Предыдущий трек">${icons.previous}</button><button class="cw-play" type="button" data-command="toggle" aria-label="Воспроизвести" title="Воспроизвести">${icons.play}${icons.pause}</button><button type="button" data-command="next" aria-label="Следующий трек" title="Следующий трек">${icons.next}</button></div>
        <div class="cw-extras"><button type="button" data-command="shuffle" aria-pressed="false" title="Перемешать" aria-label="Перемешать">${icons.shuffle}</button><button type="button" data-command="repeat" aria-pressed="false" title="Повтор трека" aria-label="Повтор трека">${icons.repeat}</button><button type="button" data-command="stop" title="Остановить волну" aria-label="Остановить волну">${icons.stop}</button></div>
        <div class="cw-timeline"><span class="cw-elapsed">0:00</span><input type="range" min="0" max="1000" value="0" aria-label="Перемотка"><span class="cw-duration">0:00</span></div>
        <div class="cw-volume"><button type="button" data-command="mute" aria-label="Выключить звук" title="Выключить звук">${icons.volume}${icons.mute}</button><input type="range" min="0" max="100" value="100" aria-label="Громкость"></div>
      </div></div><p class="cw-status" role="status">Рекомендации SoundCloud + ваш локальный вкус</p>
      <div class="cw-insight" hidden><details><summary>Почему этот трек</summary><p class="cw-reasons"></p><span class="cw-evidence"></span></details><button type="button" data-command="dislike" title="Меньше похожих рекомендаций">Не подходит</button><button type="button" data-command="exclude-artist" title="Исключить этого исполнителя из Моей волны">Не предлагать исполнителя</button></div>
      <dialog class="cw-import-dialog" aria-label="Импорт плейлиста">
        <div class="cw-import-head"><div><strong>Импорт плейлиста</strong><p>Яндекс Музыка, Spotify или YouTube Music</p></div>
          <button type="button" data-command="import-close" aria-label="Закрыть">×</button></div>
        <div class="cw-import-source"><input type="url" placeholder="Вставьте ссылку на публичный плейлист" aria-label="Ссылка на плейлист">
          <button type="button" data-command="import-scan">Найти треки</button></div>
        <label class="cw-import-title">Название в SoundCloud <input type="text" maxlength="100" aria-label="Название нового плейлиста" disabled></label>
        <div class="cw-import-progress" hidden><div class="cw-import-progress-head"><span class="cw-import-orbit" aria-hidden="true"></span><strong class="cw-import-caption">Готовим импорт</strong><span class="cw-import-count"></span></div><div class="cw-import-meter" role="progressbar" aria-label="Прогресс импорта" aria-valuemin="0" aria-valuemax="100"><i></i></div></div>
        <p class="cw-import-message" role="status">Найденные совпадения можно проверить перед созданием плейлиста.</p>
        <div class="cw-import-results" aria-live="polite"></div>
        <div class="cw-import-footer"><span class="cw-import-summary"></span><div class="cw-import-footer-actions"><button class="cw-import-cancel" type="button" data-command="import-cancel" hidden>Отменить поиск</button><button class="cw-import-commit" type="button" data-command="import-commit" disabled>Создать в SoundCloud</button></div></div>
      </dialog>`;
    const settingsDialog = document.createElement('dialog');
    settingsDialog.className = 'cw-settings-dialog';
    settingsDialog.setAttribute('aria-label', 'Настроить Мою волну');
    settingsDialog.innerHTML =
        '<div class="cw-settings-head"><h3>Настроить Мою волну</h3><button type="button" data-command="settings-reset" title="Сбросить настройки подбора" aria-label="Сбросить настройки подбора"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7V3m0 4h-4M20 7a8 8 0 1 0 0 10"/></svg></button><button type="button" data-command="settings-close" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>';
    const options = root.querySelector('.cw-options');
    const group = (key) => options.querySelector('[data-setting="' + key + '"]').closest('.cw-option');
    const groups = ['activity', 'discovery', 'mood', 'language'].map(group);
    const advanced = document.createElement('details');
    advanced.className = 'cw-advanced';
    advanced.innerHTML =
        '<summary>Дополнительно: звучание, темп и жанр</summary><div class="cw-advanced-content"></div>';
    advanced.lastElementChild.append(group('tone'), group('tempo'), options.querySelector('.cw-genre'));
    options.replaceChildren(...groups, advanced);
    settingsDialog.append(options);
    const languageHint = document.createElement('p');
    languageHint.className = 'cw-language-hint';
    languageHint.textContent = 'Фильтр языка выбирает треки с явной пометкой языка или отсутствия вокала.';
    settingsDialog.append(languageHint);
    const characterHint = document.createElement('p');
    characterHint.className = 'cw-language-hint';
    settingsDialog.append(characterHint);
    const exclusions = document.createElement('details');
    exclusions.className = 'cw-exclusions';
    exclusions.innerHTML =
        '<summary>Исключённые исполнители <span></span></summary><p>Действует только в Моей волне. Ваши лайки и подписки сохраняются.</p><div></div>';
    settingsDialog.append(exclusions);
    const renderExclusions = (artists) => {
        exclusions.querySelector('span').textContent = artists.length ? '· ' + artists.length : '';
        const list = exclusions.querySelector('div');
        list.replaceChildren();
        if (!artists.length) {
            list.textContent = 'Вы пока никого не исключили.';
            return;
        }
        for (const artist of artists) {
            const row = document.createElement('div'),
                name = document.createElement('span'),
                button = document.createElement('button');
            name.textContent = artist;
            button.type = 'button';
            button.textContent = 'Вернуть';
            button.dataset.command = 'restore-artist';
            button.dataset.artist = artist;
            row.append(name, button);
            list.append(row);
        }
    };
    renderExclusions([]);
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
    let waveError = false;
    let playing = false;
    let candidate = null;
    let durationSeconds = 0;
    let internalSeek = false;
    let previousVolume = 100;
    let lastArtwork = '';
    let lastVisualAt = 0;
    let lastVisual = '';
    let liked = false;
    let likeKnown = false;
    let likePending = false;
    let likeRequestId = 0;
    const importer = window.playlistImporter;
    let importBusy = false;
    let importScanning = false;
    let importScanPromise = Promise.resolve();
    let importTotal = 0,
        importCompleted = 0;
    let importMatches = [];
    const importRows = new Map();
    const importMessage = (value) => {
        $('.cw-import-message').textContent = value;
    };
    const importError = (error) =>
        String(error?.message || 'Не удалось завершить импорт.')
            .replace(/^Error invoking remote method '[^']+':\s*/i, '')
            .replace(/^Error:\s*/i, '');
    const updateImportProgress = (phase, completed = 0, total = 0) => {
        const progress = $('.cw-import-progress'),
            meter = $('.cw-import-meter');
        progress.hidden = false;
        progress.classList.toggle('is-busy', !['done', 'error'].includes(phase));
        progress.classList.toggle('is-indeterminate', !total && !['done', 'error'].includes(phase));
        progress.classList.toggle('is-error', phase === 'error');
        const captions = {
            source: 'Читаем плейлист',
            matching: 'Ищем и проверяем треки',
            checking: 'Проверяем доступность',
            creating: 'Создаём плейлист',
            adding: 'Добавляем музыку',
            done: 'Готово',
            error: 'Проверка остановлена',
        };
        $('.cw-import-caption').textContent = captions[phase] || 'Готовим импорт';
        $('.cw-import-count').textContent = total ? `${Math.min(completed, total)} / ${total}` : '';
        const percent = total ? Math.min(100, Math.max(0, (completed / total) * 100)) : 0;
        meter.style.setProperty('--cw-import-progress', `${percent}%`);
        if (total) meter.setAttribute('aria-valuenow', String(Math.round(percent)));
        else meter.removeAttribute('aria-valuenow');
    };
    const updateImportSummary = () => {
        $('.cw-import-summary').textContent = importScanning
            ? importTotal
                ? `Проверено ${importCompleted} из ${importTotal}`
                : 'Готовим поиск…'
            : importMatches.length
              ? `${importMatches.filter((item) => item.soundcloud).length} доступных совпадений из ${importMatches.length}`
              : '';
        $('.cw-import-commit').textContent = importScanning
            ? 'Создать из найденных'
            : 'Добавить выбранные в SoundCloud';
        $('.cw-import-commit').disabled = (importBusy && !importScanning) || !$('.cw-import-results input:checked');
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
            ? 'Добавлено в плейлист'
            : entry.pending
              ? 'Проверяем…'
              : entry.soundcloud
                ? `SoundCloud: ${entry.soundcloud.artist} — ${entry.soundcloud.title} (${Math.round(entry.soundcloud.score * 100)}%) · Полный поток доступен`
                : entry.error || 'В SoundCloud не найдено';
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
    const $ = (selector) => root.querySelector(selector);
    const parseTime = (value) =>
        String(value || '0:00')
            .split(':')
            .reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
    let homeMain = null;
    const isHome = () => ['/', '/discover'].includes(location.pathname.replace(/\/+$/, '') || '/');
    const detach = () => {
        homeMain = null;
        if (active && document.body) {
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
        const before = target || [...host.children].find((node) => node !== root) || null;
        root.classList.remove('cw-detached');
        root.dataset.placement = target ? 'personalized' : 'home';
        if (root.parentElement !== host || root.nextElementSibling !== before) host.insertBefore(root, before);
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
                    !homeMain.contains(record.target) ||
                    [...record.addedNodes, ...record.removedNodes].every(
                        (node) => node === root || node.nodeType !== 1,
                    ),
            )
        )
            return;
        schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    place();
    const updateVisibility = (visible) => root.classList.toggle('cw-window-hidden', !visible);
    api.on('visibility', updateVisibility);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) updateVisibility(false);
    });
    const renderControls = () => {
        const selectedLabels = [...root.querySelectorAll('[data-setting]')]
            .filter(
                (button) =>
                    controls[button.dataset.setting] === button.dataset.value &&
                    !['any', 'balanced'].includes(button.dataset.value),
            )
            .map((button) => button.textContent.trim());
        presetSummary.textContent =
            [...selectedLabels, controls.genre].filter(Boolean).join(' · ') ||
            'По вашему вкусу · все настройки открыты';
        languageHint.hidden = !controls.language || controls.language === 'any';
        characterHint.textContent =
            controls.discovery === 'favorites'
                ? 'Любимое — ваши лайки и треки, которые вы слушали с интересом.'
                : controls.discovery === 'popular'
                  ? 'Популярное — от 1000 прослушиваний в SoundCloud, с учётом вашего вкуса.'
                  : '';
        characterHint.hidden = !characterHint.textContent;
        root.querySelectorAll('[data-setting]').forEach((button) => {
            const selected = controls[button.dataset.setting] === button.dataset.value;
            button.setAttribute('aria-pressed', String(selected));
        });
        const selected = [...$('.cw-genre select').options].find((option) => option.value === controls.genre);
        $('.cw-genre select').value = selected ? controls.genre : '';
        $('.cw-genre input').value = selected ? '' : controls.genre || '';
    };
    const renderLike = () => {
        const button = $('.cw-like');
        const title = liked && likeKnown ? 'Убрать из понравившихся' : 'Добавить в понравившиеся';
        root.classList.toggle('cw-liked', liked && likeKnown);
        button.setAttribute('aria-pressed', String(liked && likeKnown));
        button.setAttribute('aria-label', title);
        button.title = title;
        button.disabled = likePending || !candidate;
    };
    const updateActive = (value) => {
        active = Boolean(value);
        renderExplanation(candidate);
        if (!active) playing = false;
        root.classList.toggle('cw-active', active);
        root.classList.toggle('cw-playing', playing);
        document.documentElement.classList.toggle('codex-wave-active', active);
        $('.cw-player-wrap').inert = !active;
        $('.cw-player-wrap').setAttribute('aria-hidden', String(!active));
        $('.cw-start span').textContent = active ? 'Волна включена' : 'Слушать';
        $('.cw-start').setAttribute('aria-pressed', String(active));
        schedule();
    };
    const updateTrack = (track) => {
        if (!track?.title) return;
        if ($('.cw-title').textContent !== track.title) $('.cw-title').textContent = track.title;
        const artist = track.author || candidate?.artist || '';
        if ($('.cw-artist').textContent !== artist) $('.cw-artist').textContent = artist;
        const artwork = typeof track.artwork === 'string' && /^https:\/\//.test(track.artwork) ? track.artwork : '';
        if (artwork !== lastArtwork) {
            lastArtwork = artwork;
            $('.cw-art').style.backgroundImage = artwork ? `url("${artwork.replace(/["\\]/g, '')}")` : '';
        }
        playing = Boolean(track.isPlaying);
        root.classList.toggle('cw-playing', playing);
        $('.cw-play').setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
        $('.cw-play').title = playing ? 'Пауза' : 'Воспроизвести';
        $('.cw-start span').textContent = active ? 'Волна включена' : 'Слушать';
        durationSeconds = parseTime(track.duration);
        if ($('.cw-duration').textContent !== (track.duration || '0:00'))
            $('.cw-duration').textContent = track.duration || '0:00';
        if ($('.cw-elapsed').textContent !== (track.elapsed || '0:00'))
            $('.cw-elapsed').textContent = track.elapsed || '0:00';
        if (!internalSeek)
            $('.cw-timeline input').value = String(
                durationSeconds ? Math.round((parseTime(track.elapsed) / durationSeconds) * 1000) : 0,
            );
    };
    root.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || !root.contains(button)) return;
        if (button.dataset.setting) {
            controls[button.dataset.setting] = button.dataset.value;
            renderControls();
            api.controls(controls);
            $('.cw-status').textContent = active
                ? 'Подберём следующие треки с этой настройкой'
                : 'Настройка применится при запуске волны';
            return;
        }
        const command = button.dataset.command;
        if (command === 'settings-open') {
            if (!settingsDialog.open) settingsDialog.showModal();
            return;
        }
        if (command === 'settings-close') {
            settingsDialog.close();
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
                $('.cw-status').textContent = 'Импорт недоступен в этой сборке.';
                return;
            }
            $('.cw-import-dialog').showModal();
            $('.cw-import-source input').focus();
            return;
        }
        if (command === 'import-close') {
            if (!importBusy) $('.cw-import-dialog').close();
            else importMessage('Дождитесь завершения текущего действия.');
            return;
        }
        if (command === 'import-scan') {
            if (importBusy) return;
            const link = $('.cw-import-source input').value.trim();
            importBusy = true;
            importScanning = true;
            importMatches = [];
            renderImport();
            button.disabled = true;
            importTotal = 0;
            importCompleted = 0;
            updateImportProgress('source');
            $('.cw-import-source input').disabled = true;
            $('.cw-import-cancel').hidden = false;
            $('.cw-import-cancel').disabled = false;
            $('.cw-import-title input').value = '';
            $('.cw-import-title input').disabled = true;
            importMessage('Читаем плейлист…');
            importScanPromise = importer
                .scan(link)
                .then((result) => {
                    importMatches = (result.matches || []).map((item, index) => ({
                        ...item,
                        selected: importMatches[index]?.selected,
                    }));
                    renderImport();
                    $('.cw-import-title input').value = result.title || '';
                    $('.cw-import-title input').disabled = false;
                    importMessage(
                        `${result.title}: проверьте совпадения перед добавлением.` +
                            (result.partial ? ' Источник показал только часть треков.' : ''),
                    );
                    updateImportProgress('done', importMatches.length, importMatches.length);
                })
                .catch((error) => {
                    importMatches = importMatches.map((item) =>
                        item.pending ? { ...item, pending: false, error: 'Проверка остановлена.' } : item,
                    );
                    importMessage(importError(error) + ' Найденные треки сохранены — их можно добавить в плейлист.');
                    updateImportProgress('error', importCompleted, importTotal);
                })
                .finally(() => {
                    importBusy = false;
                    importScanning = false;
                    button.disabled = false;
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
                importMessage('Отменяем поиск…');
                importer.cancel();
            }
            return;
        }
        if (command === 'import-commit') {
            if (importScanning) {
                button.disabled = true;
                importMessage('Останавливаем поиск и сохраняем найденную часть…');
                importer.cancel();
                void importScanPromise.then(() => button.click());
                return;
            }
            if (importBusy) return;
            const indexes = [...root.querySelectorAll('.cw-import-results input:checked')].map((input) =>
                Number(input.dataset.index),
            );
            if (!indexes.length) {
                importMessage('Выберите хотя бы один найденный трек.');
                return;
            }
            importBusy = true;
            button.disabled = true;
            $('.cw-import-source button').disabled = true;
            updateImportProgress('checking', 0, indexes.length);
            importMessage('Создаём плейлист в SoundCloud…');
            void importer
                .commit({ indexes, title: $('.cw-import-title input').value.trim() })
                .then((result) => {
                    importMessage(
                        `Готово: добавлено ${result.added} треков в «${result.title}».` +
                            (result.already ? ` Уже были в плейлисте: ${result.already}.` : '') +
                            (result.failures.length ? ` Не удалось добавить ${result.failures.length}.` : '') +
                            (result.unmatched
                                ? ` Без совпадений или ещё не проверено: ${result.unmatched}. Найденная часть сохранена.`
                                : '') +
                            (result.duplicates ? ` Повторы пропущены: ${result.duplicates}.` : ''),
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
                    $('.cw-status').textContent = error.message || 'Не удалось изменить исключения';
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
                    $('.cw-status').textContent = error.message || 'Не удалось сменить трек';
                })
                .finally(() => {
                    button.disabled = false;
                });
            return;
        }
        if (command === 'start') {
            if (!active || waveError) {
                $('.cw-status').textContent = 'Ищем вашу музыку…';
                button.disabled = true;
                void api
                    .start()
                    .catch((error) => {
                        $('.cw-status').textContent = error.message || 'Не удалось запустить волну';
                    })
                    .finally(() => {
                        button.disabled = false;
                    });
            } else
                $('.cw-status').textContent =
                    'Следующий трек готовится заранее. Воспроизведением управляет SoundCloud.';
        } else if (command === 'like') {
            if (likePending || !candidate) return;
            const desired = likeKnown ? !liked : true;
            const requestId = ++likeRequestId;
            likePending = true;
            renderLike();
            $('.cw-status').textContent = desired ? 'Добавляем трек в понравившиеся…' : 'Убираем лайк…';
            void api
                .like(candidate.url, desired)
                .then((result) => {
                    if (requestId !== likeRequestId || result?.url !== candidate?.url) return;
                    liked = Boolean(result.liked);
                    likeKnown = true;
                    renderLike();
                    $('.cw-status').textContent = liked
                        ? 'Трек добавлен в понравившиеся SoundCloud'
                        : 'Лайк снят в SoundCloud';
                })
                .catch((error) => {
                    if (requestId === likeRequestId)
                        $('.cw-status').textContent = error?.message || 'Не удалось изменить лайк в SoundCloud';
                })
                .finally(() => {
                    if (requestId === likeRequestId) {
                        likePending = false;
                        renderLike();
                    }
                });
        } else if (command) {
            if (command === 'shuffle' || command === 'repeat') {
                const enabled = button.getAttribute('aria-pressed') !== 'true';
                button.setAttribute('aria-pressed', String(enabled));
                api.control(command, enabled);
            } else if (command === 'mute') {
                const slider = $('.cw-volume input');
                if (Number(slider.value) > 0) {
                    previousVolume = Number(slider.value);
                    slider.value = '0';
                } else slider.value = String(previousVolume || 100);
                root.classList.toggle('cw-muted', Number(slider.value) === 0);
                api.control('volume', Number(slider.value));
            } else api.control(command);
        }
    });
    const renderExplanation = (item) => {
        $('.cw-insight').hidden = !item || !active;
        $('.cw-reasons').textContent =
            item?.recommendationReasons
                ?.filter((reason) => reason !== 'похож на пропущенное')
                .slice(0, 3)
                .join(' · ') || 'Подбор по вашему вкусу и настройкам';
        $('.cw-evidence').textContent =
            item?.bpm && item.bpmConfidence >= 0.65
                ? [item.genre, 'BPM из метаданных: ' + item.bpm].filter(Boolean).join(' · ')
                : [item?.genre, 'Темп без подтверждённого BPM оценивается по тегам'].filter(Boolean).join(' · ');
    };
    const applyGenre = (genre) => {
        controls.genre = genre.trim();
        api.controls(controls);
        $('.cw-status').textContent = active
            ? 'Подберём следующие треки с этим жанром'
            : 'Жанр применится при запуске волны';
    };
    $('.cw-genre select').addEventListener('change', (event) => {
        $('.cw-genre input').value = '';
        applyGenre(event.target.value);
    });
    $('.cw-genre input').addEventListener('change', (event) => {
        $('.cw-genre select').value = '';
        applyGenre(event.target.value);
    });
    $('.cw-timeline input').addEventListener('pointerdown', () => {
        internalSeek = true;
    });
    $('.cw-timeline input').addEventListener('change', (event) => {
        api.control('seek', Number(event.target.value) / 1000);
        internalSeek = false;
    });
    $('.cw-volume input').addEventListener('input', (event) => {
        const volume = Number(event.target.value);
        if (volume > 0) previousVolume = volume;
        root.classList.toggle('cw-muted', volume === 0);
        api.control('volume', volume);
    });
    $('.cw-import-results').addEventListener('change', (event) => {
        const index = Number(event.target.dataset.index);
        if (importMatches[index]) importMatches[index].selected = event.target.checked;
        updateImportSummary();
    });
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
            importMessage(`${state.detail || 'Импорт'}${state.total ? ` · ${state.completed}/${state.total}` : ''}`);
        });
    api.on('active', updateActive);
    api.on('track', updateTrack);
    api.on('candidate', (item) => {
        likeRequestId++;
        likePending = false;
        liked = false;
        likeKnown = false;
        candidate = item;
        renderExplanation(item);
        renderLike();
        lastArtwork = '';
        $('.cw-art').style.backgroundImage = '';
        $('.cw-title').textContent = item?.title || 'Подбираем трек…';
        $('.cw-artist').textContent = item?.artist || '';
        $('.cw-tags').textContent = [item?.genre, ...(item?.tags || []), item?.bpm && `${item.bpm} BPM`]
            .filter(Boolean)
            .slice(0, 4)
            .join(' · ');
    });
    api.on('liked', (state) => {
        if (!state || state.url !== candidate?.url) return;
        liked = Boolean(state.liked);
        likeKnown = Boolean(state.known);
        renderLike();
    });
    api.on('metadata', (metadata) => {
        $('.cw-tags').textContent = [metadata?.genre, ...(metadata?.tags || []), metadata?.bpm && `${metadata.bpm} BPM`]
            .filter(Boolean)
            .slice(0, 4)
            .join(' · ');
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
        $('.cw-start span').textContent = waveError ? 'Повторить подбор' : active ? 'Волна включена' : 'Слушать';
        $('.cw-status').textContent =
            state === 'loading'
                ? 'Ищем вашу музыку…'
                : state === 'playing'
                  ? String(message || 'Следующий трек готовится заранее')
                  : String(message || 'Не удалось запустить волну');
    });
    api.on('stats', (stats) => {
        if (stats?.heard) $('.cw-kicker').textContent = `МОЯ ВОЛНА · учтено ${stats.heard} прослушиваний`;
    });
    api.on('scroll', () => {
        schedule();
        setTimeout(() => root.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
    });
    api.on('route', schedule);
    void api.ready().then((state) => {
        if (!state) return;
        renderExclusions(state.excludedArtists || []);
        controls = { ...controls, ...state.controls };
        renderControls();
        updateActive(state.active);
        updateVisibility(state.visible);
        if (state.candidate) {
            candidate = state.candidate;
            $('.cw-title').textContent = candidate.title;
            $('.cw-artist').textContent = candidate.artist;
        }
        if (candidate && state.like?.url === candidate.url) {
            liked = Boolean(state.like.liked);
            likeKnown = Boolean(state.like.known);
        }
        renderLike();
        renderExplanation(candidate);
        if (state.track) updateTrack(state.track);
    });
})();
