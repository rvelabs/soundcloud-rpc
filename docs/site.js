(() => {
    'use strict';
    const english = {
        skip: 'Skip to content',
        navLabel: 'Main navigation',
        navWave: 'My Wave',
        navFeatures: 'Features',
        navDownload: 'Download',
        releaseNote: 'A new chapter for My Wave',
        heroTitle: 'More music.<br><em>Fewer repeats.</em>',
        heroDescription:
            'The SoundCloud you know — with personal radio, playlist import and your own sound. A free desktop client for Windows.',
        download: 'Download for Windows',
        seeApp: 'Take a look inside',
        heroNote: 'Free. Open source.',
        stripWave: 'Your personal radio',
        stripImport: 'Your playlists, with you',
        stripEq: '42 sound presets',
        appKicker: 'FAMILIAR. NOW MORE YOU.',
        appTitle: 'Right where you listen.',
        appIntro:
            'An addition to the SoundCloud interface. Its player, queue and your likes stay right where they belong.',
        galleryLabel: 'Client interface',
        zoomLabel: 'Enlarge the image',
        closeLabel: 'Close',
        tabWave: 'My Wave',
        tabSettings: 'Customize',
        tabImport: 'Import',
        tabEq: 'Equalizer',
        demoNote: 'Interface demonstration · sample tracks',
        waveKicker: 'MORE THAN SHUFFLE',
        waveTitle: 'Your taste.<br>More than one direction.',
        waveIntro:
            'From recordings you enjoy to something you haven’t heard yet. My Wave combines related SoundCloud tracks and independent ranking.',
        tasteBody:
            'Likes and ordinary listening help build your taste profile. Sound features are processed locally and cached.',
        moodBody:
            'Choose a mood, activity, music language and a balance of familiar music and discoveries. One quick skip does not reject a whole genre.',
        queueBody:
            'The next tracks are prepared ahead of time. Change pages or minimize the window — your music keeps playing.',
        algorithmLink: 'How discovery works',
        tasteQueue: 'Something new, up next',
        tasteQueueOne: 'Connected to your interests',
        tasteQueueTwo: 'Another side of your taste',
        tasteQueueThree: 'Room for a discovery',
        tasteCaption: 'One favorite style shouldn’t close off all the others.',
        featuresKicker: 'MORE THAN A PLAYER',
        featuresTitle: 'Your collection. Your sound.',
        importTitle: 'Keep your playlists close.',
        importIntro:
            'The client finds SoundCloud versions of your tracks and builds a playlist from the matches. Even when not everything is found.',
        platformLabel: 'Playlist source',
        yandex: 'Yandex Music',
        importDetail:
            'Audio files are not copied. Review matches and save the found part. CSV, TXT and TSV files are supported.',
        eqTitle: 'Tuned to you.',
        eqIntro:
            'Ten bands, 42 presets and manual adjustment in the SoundCloud player. Automatic headroom helps avoid overload.',
        eqPresetsLabel: 'Preset preview',
        eqWarm: 'Warm',
        eqPunch: 'Bass',
        eqVocal: 'Vocals',
        eqDemoNote: 'A visual preset example. Adjust the sound in the app; some protected streams cannot be processed.',
        socialBody: 'Show the track you’re playing and keep your listening history going.',
        clientTitle: 'Settings in F1',
        clientBody: 'Ad blocking, updates, theme, zoom, extensions and learning reset.',
        openTitle: 'Open source',
        openBody: 'A free, independent project. Look inside and suggest an improvement.',
        faqTitle: 'Before the first track.',
        askQuestion: 'Ask a question',
        faqOfficialQ: 'Is this the official SoundCloud app?',
        faqOfficialA:
            'No. This is a free, independent soundcloud-rpc fork by rvelabs, not affiliated with SoundCloud. You need your own SoundCloud account to listen.',
        faqRadioQ: 'How does My Wave work?',
        faqRadioA:
            'Related SoundCloud tracks, independent ranking and your reactions. Ordinary listening counts too. It is not Yandex Music’s proprietary algorithm: mood and tempo accuracy depend on available metadata.',
        faqImportQ: 'Will every track be transferred?',
        faqImportA:
            'Import finds existing versions; it does not copy music. Recordings may be missing or unavailable. Save the matched part separately; SoundCloud playlists are limited to 500 tracks. Sources sometimes return incomplete lists. Spotify may require an additional sign-in, which you can decline.',
        faqDataQ: 'Where is the analysis stored? Can I reset it?',
        faqDataA:
            'Your taste profile and measured sound features are stored locally. Reset analysis and learning in F1 without deleting SoundCloud likes or playlists. A backup is created before the reset, then the client restarts.',
        faqNetworkQ: 'What if the service will not open?',
        faqNetworkA:
            'F1 includes a personal Cloudflare Worker setup wizard for fallback connectivity and reading public playlists. You need your own Cloudflare account, and Cloudflare must be reachable on your network. You can also use an existing Worker. CSV/TXT/TSV import is available for track lists.',
        faqInstallQ: 'What do I need to install it?',
        faqInstallA:
            'Windows 10 or 11, x64, WebView2 and a SoundCloud account. The build uses Rust + WebView2. The installer replaces Electron and imports supported history and audio cache; sign in again after the switch. Profiles survive updates. There is no trusted publisher signature yet, so Windows may show a warning.',
        downloadKicker: 'YOUR NEXT FAVORITE IS ALREADY OUT THERE',
        downloadTitle: 'Keep the music going?',
        downloadNote: '0.2.12 · Windows x64 · Free',
        sourceCode: 'Source code',
        footerNote: 'An independent project. SoundCloud and other names belong to their respective owners.',
        feedback: 'Feedback',
    };
    const seo = {
        ru: {
            title: 'SoundCloud для Windows — Моя волна и импорт плейлистов',
            description:
                'Бесплатный клиент SoundCloud для Windows: Моя волна, 42 пресета эквалайзера, перенос плейлистов Spotify, Яндекс Музыки и YouTube Music. Открытый код.',
            locale: 'ru_RU',
            alternate: 'en_US',
            imageAlt: 'SoundCloud Desktop от rvelabs: Моя волна, эквалайзер и перенос плейлистов для Windows',
        },
        en: {
            title: 'SoundCloud for Windows — My Wave & Playlist Import',
            description:
                'Discover music with My Wave in a free SoundCloud client for Windows. 42 EQ presets, Spotify, Yandex and YouTube playlist import. Open source.',
            locale: 'en_US',
            alternate: 'ru_RU',
            imageAlt: 'SoundCloud Desktop by rvelabs: My Wave, equalizer and playlist import for Windows',
        },
    };
    const original = new Map([...document.querySelectorAll('[data-i18n]')].map((node) => [node, node.innerHTML]));
    const attributes = new Map(
        [...document.querySelectorAll('[data-label]')].map((node) => [node, node.getAttribute('aria-label')]),
    );
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const animations = new Set();
    const gallery = {
        wave: {
            title: ['Нажми. И слушай.', 'Press play. Keep going.'],
            description: [
                'Лайки и прослушивания задают направление. Следующие треки готовятся, пока играет текущий.',
                'Likes and listening set the direction. The next tracks are prepared while the current one plays.',
            ],
            points: [
                ['Подбор по твоим интересам', 'Discovery around your interests'],
                ['Привычная очередь SoundCloud', 'The familiar SoundCloud queue'],
                ['Музыка продолжает играть в фоне', 'Music keeps playing in the background'],
            ],
        },
        settings: {
            title: ['Под твой момент.', 'For your kind of moment.'],
            description: [
                'Настроение, занятие, язык и баланс знакомой музыки с открытиями. Настройки живут рядом с плеером.',
                'Mood, activity, music language and a balance of old favorites and discoveries. Settings live right beside the player.',
            ],
            points: [
                ['Выбор настроения и занятия', 'Mood and activity controls'],
                ['Знакомое или новое', 'Familiar music or discoveries'],
                ['Звучание, темп и исключения', 'Sound, tempo and exclusions'],
            ],
        },
        import: {
            title: ['Собирал годами? Забирай.', 'Years in the making? Bring it.'],
            description: [
                'Вставь ссылку, проверь найденные версии и сохрани совпадения в SoundCloud. Пропущенные треки не останавливают весь перенос.',
                'Paste a link, review the matching versions and save them to SoundCloud. Missing tracks do not stop the whole transfer.',
            ],
            points: [
                ['Spotify, Яндекс Музыка, YouTube', 'Spotify, Yandex Music, YouTube'],
                ['CSV, TXT и TSV без исходного сервиса', 'CSV, TXT and TSV without the source service'],
                ['Сохранение найденной части', 'Save the matched part'],
            ],
        },
        equalizer: {
            title: ['Твой характер звука.', 'Your kind of sound.'],
            description: [
                'От тёплого звучания до акцента на басе или вокале. Выбери пресет или настрой каждую полосу самостоятельно.',
                'From a warmer sound to a focus on bass or vocals. Pick a preset or adjust every band yourself.',
            ],
            points: [
                ['10 полос и 42 пресета', '10 bands and 42 presets'],
                ['Настройки сохраняются автоматически', 'Settings save automatically'],
                ['Работает и в свёрнутом окне', 'Keeps working when minimized'],
            ],
        },
    };
    const sources = {
        spotify: [
            'Вставь ссылку на публичный плейлист или альбом Spotify в импорт внутри клиента.',
            'Paste a public Spotify playlist or album link into playlist import in the client.',
        ],
        yandex: [
            'Поделись публичным плейлистом Яндекс Музыки и вставь его ссылку в клиент.',
            'Share a public Yandex Music playlist and paste its link into the client.',
        ],
        youtube: [
            'Скопируй ссылку на публичный плейлист YouTube или YouTube Music.',
            'Copy a public YouTube or YouTube Music playlist link.',
        ],
        file: [
            'Выбери CSV/TSV со столбцами исполнителя и названия или TXT «Исполнитель — Название». До 4 МБ.',
            'Choose a CSV/TSV with artist and track columns, or a TXT “Artist — Track” list. Up to 4 MB.',
        ],
    };
    const sourceNames = {
        spotify: ['Spotify', 'Spotify'],
        yandex: ['Яндекс Музыка', 'Yandex Music'],
        youtube: ['YouTube Music', 'YouTube Music'],
        file: ['CSV / TXT', 'CSV / TXT'],
    };
    const curves = {
        warm: [2, 3, 3, 2, 1, 0, -1, -1, -2, -2],
        punch: [0, 2, 5, 2, -1, -1, 0, 0, 0, 0],
        vocal: [-3, -2, -1, 0, 2, 3, 4, 2, 0, -1],
    };
    let language = 'ru',
        source = 'spotify',
        selected = 'wave',
        sequence = 0,
        recordVisible = true,
        focused = true,
        frame = 0;
    const index = () => (language === 'en' ? 1 : 0);
    const runAnimation = (element, frames, options) => {
        if (reduce.matches || document.hidden || !element.animate) return;
        const animation = element.animate(frames, options);
        if (!focused) animation.pause();
        animations.add(animation);
        animation.finished.then(
            () => animations.delete(animation),
            () => animations.delete(animation),
        );
        return animation;
    };
    const syncMotion = () => {
        const active = !document.hidden && focused;
        document.body.classList.toggle('motion-still', !active || !recordVisible);
        for (const animation of animations) {
            if (reduce.matches) {
                animation.finish();
                continue;
            }
            if (active) animation.play();
            else animation.pause();
        }
    };
    const updateSource = () => {
        document.querySelector('.source-name').textContent = sourceNames[source][index()];
        const text = document.querySelector('[data-source-copy]');
        text.textContent = sources[source][index()];
        for (const button of document.querySelectorAll('[data-source]'))
            button.setAttribute('aria-pressed', String(button.dataset.source === source));
        runAnimation(
            text,
            [
                { opacity: 0.4, transform: 'translateY(5px)' },
                { opacity: 1, transform: 'none' },
            ],
            { duration: 240, easing: 'ease-out' },
        );
    };
    const image = document.getElementById('product-image');
    const updateGallery = async (animate = true) => {
        const current = ++sequence,
            item = gallery[selected],
            keys = Object.keys(gallery);
        document.querySelector('[data-gallery-index]').textContent = '0' + (keys.indexOf(selected) + 1) + ' / 04';
        document.querySelector('[data-gallery-title]').textContent = item.title[index()];
        document.querySelector('[data-gallery-description]').textContent = item.description[index()];
        document.querySelector('[data-gallery-points]').replaceChildren(
            ...item.points.map((point) => {
                const li = document.createElement('li');
                li.textContent = point[index()];
                return li;
            }),
        );
        for (const button of document.querySelectorAll('[data-gallery]')) {
            const active = button.dataset.gallery === selected;
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        }
        document.getElementById('gallery-panel').setAttribute('aria-labelledby', 'tab-' + selected);
        const url = './images/app-' + selected + (language === 'ru' ? '-ru' : '') + '.webp';
        const next = new Image();
        next.src = url;
        try {
            await next.decode();
        } catch {
            if (current === sequence) image.dataset.loadError = 'true';
            return;
        }
        if (current !== sequence) return;
        image.removeAttribute('data-load-error');
        image.src = url;
        image.alt =
            item.title[index()] +
            ' — ' +
            (language === 'ru' ? 'демонстрация интерфейса SoundCloud' : 'SoundCloud interface demonstration');
        if (animate)
            runAnimation(
                image,
                [
                    { opacity: 0.35, transform: 'translateY(6px)' },
                    { opacity: 1, transform: 'none' },
                ],
                { duration: 330, easing: 'cubic-bezier(.22,1,.36,1)' },
            );
    };
    const setLanguage = (next) => {
        language = next === 'en' ? 'en' : 'ru';
        document.documentElement.lang = language;
        for (const [node, text] of original)
            node.innerHTML = language === 'en' ? english[node.dataset.i18n] || text : text;
        for (const [node, text] of attributes)
            node.setAttribute('aria-label', language === 'en' ? english[node.dataset.label] || text : text);
        for (const button of document.querySelectorAll('[data-site-language]'))
            button.setAttribute('aria-pressed', String(button.dataset.siteLanguage === language));
        const metadata = seo[language];
        document.title = metadata.title;
        for (const selector of [
            'meta[name="description"]',
            'meta[property="og:description"]',
            'meta[name="twitter:description"]',
        ])
            document.querySelector(selector)?.setAttribute('content', metadata.description);
        for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]'])
            document.querySelector(selector)?.setAttribute('content', metadata.title);
        for (const selector of ['meta[property="og:image:alt"]', 'meta[name="twitter:image:alt"]'])
            document.querySelector(selector)?.setAttribute('content', metadata.imageAlt);
        document.querySelector('meta[property="og:locale"]')?.setAttribute('content', metadata.locale);
        document.querySelector('meta[property="og:locale:alternate"]')?.setAttribute('content', metadata.alternate);
        const schema = document.getElementById('software-schema');
        if (schema) {
            const value = JSON.parse(schema.textContent);
            value.description = metadata.description;
            schema.textContent = JSON.stringify(value);
        }
        updateSource();
        void updateGallery(false);
    };
    for (const button of document.querySelectorAll('[data-site-language]'))
        button.addEventListener('click', () => setLanguage(button.dataset.siteLanguage));
    for (const button of document.querySelectorAll('[data-source]'))
        button.addEventListener('click', () => {
            if (!Object.hasOwn(sources, button.dataset.source)) return;
            source = button.dataset.source;
            updateSource();
        });
    const tabs = [...document.querySelectorAll('[data-gallery]')];
    for (const button of tabs) {
        button.addEventListener('click', () => {
            if (selected === button.dataset.gallery) return;
            selected = button.dataset.gallery;
            void updateGallery();
        });
        button.addEventListener('keydown', (event) => {
            const at = tabs.indexOf(button),
                step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            let next = step
                ? (at + step + tabs.length) % tabs.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : -1;
            if (next < 0) return;
            event.preventDefault();
            tabs[next].focus();
            tabs[next].click();
        });
    }
    for (const button of document.querySelectorAll('[data-eq]'))
        button.addEventListener('click', () => {
            const curve = curves[button.dataset.eq];
            for (const [at, band] of [...document.querySelectorAll('.eq-bands>div')].entries()) {
                band.style.setProperty('--gain', curve[at]);
                band.querySelector('span').textContent = (curve[at] > 0 ? '+' : '') + curve[at];
            }
            for (const other of document.querySelectorAll('[data-eq]'))
                other.setAttribute('aria-pressed', String(other === button));
            document.querySelector('.eq-demo-announcement').textContent = button.textContent;
        });
    const disclosureAnimations = new Map();
    for (const details of document.querySelectorAll('.questions details'))
        details.querySelector('summary').addEventListener('click', (event) => {
            if (reduce.matches || !details.animate) return;
            event.preventDefault();
            const content = details.querySelector('.faq-answer'),
                previous = disclosureAnimations.get(details);
            const closing = previous ? previous.closing === false : details.open;
            const from = details.open ? content.getBoundingClientRect().height : 0;
            previous?.animation.cancel();
            details.open = true;
            const full = content.scrollHeight;
            const animation = content.animate(
                [
                    { height: from + 'px', opacity: closing ? 1 : 0 },
                    { height: (closing ? 0 : full) + 'px', opacity: closing ? 0 : 1 },
                ],
                { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' },
            );
            disclosureAnimations.set(details, { animation, closing });
            animations.add(animation);
            animation.onfinish = () => {
                details.open = !closing;
                disclosureAnimations.delete(details);
                animations.delete(animation);
            };
            animation.oncancel = () => animations.delete(animation);
        });
    const dialog = document.querySelector('.image-dialog');
    const zoom = document.querySelector('[data-zoom]');
    zoom.addEventListener('click', () => {
        const enlarged = dialog.querySelector('img');
        enlarged.src = image.src;
        enlarged.alt = image.alt;
        if (!dialog.open) dialog.showModal();
        runAnimation(
            dialog,
            [
                { opacity: 0, transform: 'translateY(9px)' },
                { opacity: 1, transform: 'none' },
            ],
            { duration: 220, easing: 'ease-out' },
        );
    });
    document.querySelector('[data-close-image]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => zoom.focus({ preventScroll: true }));
    dialog.addEventListener('click', (event) => {
        const rect = dialog.getBoundingClientRect();
        if (
            event.target === dialog &&
            (event.clientX < rect.left ||
                event.clientX > rect.right ||
                event.clientY < rect.top ||
                event.clientY > rect.bottom)
        )
            dialog.close();
    });
    if ('IntersectionObserver' in window) {
        const once = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    once.unobserve(entry.target);
                    runAnimation(
                        entry.target,
                        [
                            { opacity: 0.4, translate: '0 18px' },
                            { opacity: 1, translate: '0 0' },
                        ],
                        { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)' },
                    );
                }
            },
            { rootMargin: '0px 0px -16px 0px' },
        );
        for (const element of document.querySelectorAll('[data-reveal]')) once.observe(element);
        new IntersectionObserver(
            ([entry]) => {
                recordVisible = entry.isIntersecting;
                syncMotion();
            },
            { threshold: 0.02 },
        ).observe(document.querySelector('[data-motion]'));
        const links = [...document.querySelectorAll('.nav-links a')];
        const sections = new IntersectionObserver(
            (entries) => {
                for (const entry of entries)
                    if (entry.isIntersecting)
                        for (const link of links)
                            link.setAttribute('aria-current', String(link.hash === '#' + entry.target.id));
            },
            { rootMargin: '-15% 0px -60%' },
        );
        for (const link of links) {
            const section = document.querySelector(link.hash);
            if (section) sections.observe(section);
        }
    }
    const progress = () => {
        frame = 0;
        const range = document.documentElement.scrollHeight - innerHeight;
        document.documentElement.style.setProperty('--scroll', String(range > 0 ? scrollY / range : 0));
    };
    const queueProgress = () => {
        if (!frame && !document.hidden) frame = requestAnimationFrame(progress);
    };
    const nativeProgress = CSS.supports('animation-timeline:scroll()');
    const syncProgress = () => {
        const fallback = !nativeProgress || reduce.matches;
        for (const type of ['scroll', 'resize']) {
            removeEventListener(type, queueProgress);
            if (fallback) addEventListener(type, queueProgress, { passive: true });
        }
        if (fallback) queueProgress();
    };
    syncProgress();
    document.addEventListener('visibilitychange', syncMotion);
    addEventListener('blur', () => {
        focused = false;
        syncMotion();
    });
    addEventListener('focus', () => {
        focused = true;
        syncMotion();
    });
    addEventListener('pageshow', syncMotion);
    reduce.addEventListener('change', () => {
        syncMotion();
        syncProgress();
    });
    setLanguage(/^ru(?:-|$)/i.test(navigator.language || '') ? 'ru' : 'en');
    syncMotion();
})();
