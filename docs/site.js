(() => {
    'use strict';
    const english = {
        skip: 'Skip to content',
        navLabel: 'Main navigation',
        navWave: 'My Wave',
        navImport: 'Bring your music',
        heroKicker: 'YOUR SOUNDCLOUD. TO BE CONTINUED.',
        heroTitle: '<span>Off</span><span>repeat<span class="orange">.</span></span>',
        heroDescription: 'Your next favorite track is out there. My Wave helps you find it — right inside SoundCloud.',
        download: 'Download for Windows',
        seeApp: 'Take a look',
        heroNote: 'Free. Open source. Windows 10 / 11, x64.',
        releaseNote: 'New in 0.2.12: improved My Wave and ad blocking ↗',
        sleeveLabel: 'THE NEVER-ENDING SIDE A',
        baseline: 'A FAMILIAR PLAYER. A DIFFERENT NEXT TRACK.',
        learnMore: 'Learn more',
        waveKicker: 'PERSONAL RADIO',
        waveTitle: 'Your favorites.<br>A starting point.',
        waveIntro:
            'You don’t have to decide what comes next. Start with something you love, and let the music carry on.',
        tasteTitle: 'From your favorites to new finds',
        tasteBody:
            'Related SoundCloud tracks and independent ranking. Likes and listening feedback help set the direction.',
        moodTitle: 'For the moment you’re in',
        moodBody: 'Mood, activity, familiar or unfamiliar tracks, and music language. All in one panel.',
        queueTitle: 'Something good is already up next',
        queueBody:
            'The next tracks are prepared ahead of time. Music keeps playing as you change pages or minimize the window.',
        algorithmLink: 'See how discovery works',
        nativePlayer: 'The queue, likes and player are still SoundCloud.',
        waveAlt: 'My Wave card inside the SoundCloud desktop client',
        settingsAlt: 'My Wave settings for mood, activity and music language',
        settingsNote: 'Your day.<br>Your settings.',
        waveBottom: 'LESS SEARCHING. MORE “WAIT, WHAT IS THIS TRACK?”',
        importKicker: 'YOUR COLLECTION COMES WITH YOU',
        importTitle: 'Keep your<br>playlists close.',
        importIntro:
            'Spent years putting them together? Bring them along. The client finds SoundCloud versions and builds a playlist from the matches.',
        importDetail:
            'Not everything matched? Save what did. Source unavailable? Load the list through your Worker or import a CSV/TXT/TSV file.',
        importLimits: 'More about playlist import',
        transferLabel: 'WHERE’S YOUR MUSIC?',
        platformLabel: 'Playlist source',
        yandex: 'Yandex Music',
        transferResult: 'Keep the matches, even when not every track is found.',
        eqKicker: 'MAKE THE SOUND YOURS',
        eqTitle: 'More bass.<br>Or more detail.',
        eqIntro: 'Ten bands, 42 presets and your own settings — right in the native SoundCloud player.',
        eqDetail:
            'From softer highs to punchier bass. Choose a genre, bring vocals forward, or adjust every band. Your settings save automatically.',
        eqSafety: 'Automatic headroom helps avoid overload when boosting frequencies.',
        eqName: 'Equalizer',
        eqPresetsLabel: 'Preset preview',
        eqWarm: 'Warm',
        eqPunch: 'Bass punch',
        eqVocal: 'Vocals',
        eqDemoNote: 'Try the presets on this diagram. Adjust your sound in the app.',
        extrasKicker: 'ALSO ON THE RECORD',
        extrasTitle: 'Little things.<br>A big difference.',
        discordBody: 'Let your friends see what’s playing.',
        lastfmBody: 'Keep your listening history going.',
        backgroundTitle: 'Music in the background',
        backgroundBody: 'Minimize the window. Your music keeps playing, with a lightweight static My Wave background.',
        openTitle: 'Open source',
        openBody: 'Look inside, suggest an idea, or report a bug.',
        faqTitle: 'Good to<br> know.',
        askQuestion: 'Another question?',
        faqOfficialQ: 'Is this the official SoundCloud app?',
        faqOfficialA:
            'No. This is a free, independent fork of soundcloud-rpc maintained by rvelabs. It is not affiliated with SoundCloud. You need your own SoundCloud account to listen.',
        faqRadioQ: 'How does My Wave work?',
        faqRadioA:
            'It combines related SoundCloud tracks, independent ranking and your reactions. Ordinary listening counts with My Wave off; sound features are processed locally and cached. It is not Yandex Music’s proprietary algorithm. Mood and tempo accuracy depend on available metadata.',
        faqImportQ: 'Will every track be transferred?',
        faqImportA:
            'Import finds existing SoundCloud versions; it does not copy audio files. Some tracks may be missing or unavailable. You can save the matched part separately. Sources may return incomplete lists; SoundCloud playlists are limited to 500 tracks.',
        faqNetworkQ: 'What if the service won’t open on my network?',
        faqNetworkA:
            'F1 includes a setup wizard for a personal Cloudflare Worker. It can provide a fallback connection to SoundCloud and read public playlist metadata. You need your own Cloudflare account, and Cloudflare must be reachable. If you already have a Worker, update it through the F1 setup wizard. CSV/TXT/TSV import is an alternative for track lists.',
        faqInstallQ: 'What do I need to install it?',
        faqInstallA:
            'Windows 10 or 11 (x64), WebView2 and a SoundCloud account. The current build uses Rust + WebView2. The installer replaces Electron and imports supported history and audio cache; sign in again afterward. Existing Native profiles survive updates. There is no trusted publisher signature yet, so Windows may show a warning.',
        downloadKicker: 'THE NEXT TRACK COULD BE YOUR FAVORITE',
        downloadTitle: 'Your music.<br>To be continued.',
        sourceCode: 'Source code',
        downloadNote: '0.2.12 · Windows x64 · Rust + WebView2 · Free',
        footerNote:
            'An independent project. Made for listening.<br>SoundCloud and other names belong to their respective owners.',
        feedback: 'Feedback',
    };
    const sources = {
        spotify: {
            name: ['Spotify', 'Spotify'],
            copy: [
                'Открой публичный плейлист Spotify, скопируй ссылку и вставь её в импорт внутри клиента.',
                'Open a public Spotify playlist, copy its link, and paste it into playlist import in the app.',
            ],
        },
        yandex: {
            name: ['Яндекс Музыка', 'Yandex Music'],
            copy: [
                'Поделись публичным плейлистом Яндекс Музыки. Вставь его ссылку в импорт внутри клиента.',
                'Share a public Yandex Music playlist. Paste its link into playlist import in the app.',
            ],
        },
        youtube: {
            name: ['YouTube Music', 'YouTube Music'],
            copy: [
                'Скопируй ссылку на публичный плейлист YouTube или YouTube Music и открой импорт в клиенте.',
                'Copy the link to a public YouTube or YouTube Music playlist and open playlist import in the app.',
            ],
        },
        file: {
            name: ['CSV / TXT / TSV', 'CSV / TXT / TSV'],
            copy: [
                'Выбери файл до 4 МБ: CSV/TSV с названием и исполнителем или TXT «Исполнитель — Название». Доступ к исходному сервису не нужен.',
                'Choose a file up to 4 MB: CSV/TSV with track and artist columns, or TXT “Artist — Title”. No source service access is needed.',
            ],
        },
    };
    const original = new Map();
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
    for (const element of document.querySelectorAll('[data-i18n]')) original.set(element, element.innerHTML);
    const attributes = new Map();
    for (const element of document.querySelectorAll('[data-label],[data-alt]'))
        attributes.set(element, element.getAttribute(element.dataset.alt ? 'alt' : 'aria-label'));
    const record = document.querySelector('.record-art');
    const recordDisc = document.querySelector('.record-disc');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const reveals = new Set();
    const eqCurves = {
        warm: [2, 3, 3, 2, 1, 0, -1, -1, -2, -2],
        punch: [0, 2, 5, 2, -1, -1, 0, 0, 0, 0],
        vocal: [-3, -2, -1, 0, 2, 3, 4, 2, 0, -1],
    };
    let language = 'ru',
        source = 'spotify',
        visible = true,
        entrancePlayed = false;
    const trackAnimation = (animation) => {
        reveals.add(animation);
        animation.finished.then(
            () => reveals.delete(animation),
            () => reveals.delete(animation),
        );
    };
    const motionAllowed = () => !document.hidden && visible;
    const syncMotion = () => {
        record.classList.toggle('is-still', !motionAllowed());
        if (!reduce.matches && motionAllowed() && !entrancePlayed) {
            entrancePlayed = true;
            trackAnimation(
                recordDisc.animate(
                    [
                        { opacity: 0.4, transform: 'translate(-18%, 5%) rotate(-6deg)' },
                        { opacity: 1, transform: 'none' },
                    ],
                    { duration: 1100, easing: 'cubic-bezier(.22,1,.36,1)' },
                ),
            );
            trackAnimation(
                record
                    .querySelector('.sleeve')
                    .animate([{ transform: 'translateX(14px) rotate(-14deg)' }, { transform: 'rotate(-9deg)' }], {
                        duration: 1200,
                        easing: 'cubic-bezier(.22,1,.36,1)',
                    }),
            );
        }
        for (const animation of reveals) {
            if (reduce.matches || ['idle', 'finished'].includes(animation.playState)) {
                animation.cancel();
                reveals.delete(animation);
            } else if (document.hidden || (!visible && animation.effect?.target.closest('.record-art')))
                animation.pause();
            else animation.play();
        }
    };
    const updateSource = () => {
        const index = language === 'en' ? 1 : 0;
        document.querySelector('.source-name').textContent = sources[source].name[index];
        const text = document.querySelector('[data-source-copy]');
        text.textContent = sources[source].copy[index];
        if (!reduce.matches && !document.hidden)
            trackAnimation(
                text.animate(
                    [
                        { opacity: 0.2, transform: 'translateY(5px)' },
                        { opacity: 1, transform: 'none' },
                    ],
                    { duration: 260, easing: 'ease-out' },
                ),
            );
        for (const button of document.querySelectorAll('[data-source]'))
            button.setAttribute('aria-pressed', String(button.dataset.source === source));
    };
    for (const button of document.querySelectorAll('[data-eq]'))
        button.addEventListener('click', () => {
            const curve = eqCurves[button.dataset.eq];
            for (const [index, band] of [...document.querySelectorAll('.eq-bands > div')].entries()) {
                band.style.setProperty('--gain', curve[index]);
                band.querySelector('span').textContent = curve[index] > 0 ? '+' + curve[index] : String(curve[index]);
            }
            for (const preset of document.querySelectorAll('[data-eq]'))
                preset.setAttribute('aria-pressed', String(preset === button));
            document.querySelector('.eq-demo-announcement').textContent = button.textContent;
        });
    const setLanguage = (next) => {
        language = next === 'en' ? 'en' : 'ru';
        document.documentElement.lang = language;
        for (const [element, html] of original)
            element.innerHTML = language === 'en' ? english[element.dataset.i18n] || html : html;
        for (const [element, value] of attributes) {
            const key = element.dataset.alt || element.dataset.label;
            element.setAttribute(
                element.dataset.alt ? 'alt' : 'aria-label',
                language === 'en' ? english[key] || value : value,
            );
        }
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
        syncMotion();
    };
    for (const button of document.querySelectorAll('[data-site-language]'))
        button.addEventListener('click', () => setLanguage(button.dataset.siteLanguage));
    for (const button of document.querySelectorAll('[data-source]'))
        button.addEventListener('click', () => {
            source = button.dataset.source;
            updateSource();
        });
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(
            ([entry]) => {
                visible = entry.isIntersecting;
                syncMotion();
            },
            { threshold: 0.06 },
        ).observe(record);
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    observer.unobserve(entry.target);
                    if (reduce.matches || document.hidden) continue;
                    const targets =
                        entry.target.dataset.reveal === 'stagger'
                            ? [...entry.target.children].filter((element) => !element.classList.contains('giant-arrow'))
                            : [entry.target];
                    targets.forEach((target, index) => {
                        const animation = target.animate(
                            [
                                { opacity: 0, translate: '0 28px' },
                                { opacity: 1, translate: '0 0' },
                            ],
                            {
                                duration: 850,
                                delay: Math.min(index * 85, 340),
                                fill: 'backwards',
                                easing: 'cubic-bezier(.22,1,.36,1)',
                            },
                        );
                        trackAnimation(animation);
                    });
                }
            },
            { threshold: 0, rootMargin: '0px 0px -28px 0px' },
        );
        for (const section of document.querySelectorAll('[data-reveal]')) observer.observe(section);
    }
    document.addEventListener('visibilitychange', syncMotion);
    reduce.addEventListener('change', syncMotion);
    addEventListener('pageshow', syncMotion);
    setLanguage(/^ru(?:-|$)/i.test(navigator.language || '') ? 'ru' : 'en');
})();
