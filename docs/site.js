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
        extrasKicker: 'ALSO ON THE RECORD',
        extrasTitle: 'Little things.<br>A big difference.',
        discordBody: 'Let your friends see what’s playing.',
        lastfmBody: 'Keep your listening history going.',
        backgroundTitle: 'Music in the background',
        backgroundBody: 'Minimize the window. The animation rests; the music stays.',
        openTitle: 'Open source',
        openBody: 'Look inside, suggest an idea, or report a bug.',
        faqTitle: 'Good to<br> know.',
        askQuestion: 'Another question?',
        faqOfficialQ: 'Is this the official SoundCloud app?',
        faqOfficialA:
            'No. This is a free, independent fork of soundcloud-rpc maintained by rvelabs. It is not affiliated with SoundCloud. You need your own SoundCloud account to listen.',
        faqRadioQ: 'How does My Wave work?',
        faqRadioA:
            'It combines related SoundCloud tracks, independent ranking and your listening feedback. It is not Yandex Music’s proprietary algorithm. Start by liking a few tracks or playing a favorite. Mood and tempo accuracy depend on available metadata.',
        faqImportQ: 'Will every track be transferred?',
        faqImportA:
            'Import finds existing SoundCloud versions; it does not copy audio files. Some tracks may be missing or unavailable. You can save the matched part separately. Sources may return incomplete lists; SoundCloud playlists are limited to 500 tracks.',
        faqNetworkQ: 'What if the service won’t open on my network?',
        faqNetworkA:
            'F1 includes a setup wizard for a personal Cloudflare Worker. It can provide a fallback connection to SoundCloud and read public playlist metadata. You need your own Cloudflare account, and Cloudflare must be reachable. For the new Worker import, update both the app and Worker to 0.28.6 or later. CSV/TXT/TSV import is an alternative for track lists.',
        faqInstallQ: 'What do I need to install it?',
        faqInstallA:
            'Windows 10 or 11 (x64) and a SoundCloud account. Download the installer from GitHub Releases. There is no trusted publisher signature yet, so Windows may show a warning. Source code and checksums are published with each release. Upgrading preserves your profile.',
        downloadKicker: 'THE NEXT TRACK COULD BE YOUR FAVORITE',
        downloadTitle: 'Your music.<br>To be continued.',
        sourceCode: 'Source code',
        downloadNote: 'Free · Windows x64 · SoundCloud account required',
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
    for (const element of document.querySelectorAll('[data-i18n]')) original.set(element, element.innerHTML);
    const attributes = new Map();
    for (const element of document.querySelectorAll('[data-label],[data-alt]'))
        attributes.set(element, element.getAttribute(element.dataset.alt ? 'alt' : 'aria-label'));
    const record = document.querySelector('.record-art');
    const recordDisc = document.querySelector('.record-disc');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const reveals = new Set();
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
        document.title =
            language === 'en' ? 'SoundCloud Desktop — get off repeat' : 'SoundCloud Desktop — хватит слушать по кругу';
        updateSource();
        syncMotion();
        try {
            localStorage.setItem('soundcloud-site-language', language);
        } catch {}
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
                    const animation = entry.target.animate(
                        [
                            { opacity: 0, transform: 'translateY(22px)' },
                            { opacity: 1, transform: 'translateY(0)' },
                        ],
                        { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)' },
                    );
                    trackAnimation(animation);
                }
            },
            { threshold: 0.08 },
        );
        for (const section of document.querySelectorAll('[data-reveal]')) observer.observe(section);
    }
    document.addEventListener('visibilitychange', syncMotion);
    reduce.addEventListener('change', syncMotion);
    addEventListener('pageshow', syncMotion);
    let selected;
    try {
        selected = localStorage.getItem('soundcloud-site-language');
    } catch {}
    setLanguage(selected || (navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en'));
})();
