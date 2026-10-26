(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = !!Element.prototype.animate && !!window.IntersectionObserver;
    const running = new Set(),
        ambient = [];
    let pageHidden = document.hidden;
    const animate = (element, frames, options = {}) => {
        if (!motion || reduce.matches || pageHidden) return;
        const animation = element.animate(frames, {
            duration: 550,
            easing: 'cubic-bezier(.22,1,.36,1)',
            fill: 'backwards',
            ...options,
        });
        running.add(animation);
        animation.finished.then(
            () => running.delete(animation),
            () => running.delete(animation),
        );
        return animation;
    };
    const reveal = (element, delay = 0) =>
        animate(
            element,
            [
                { opacity: 0, transform: 'translateY(24px)' },
                { opacity: 1, transform: 'none' },
            ],
            { delay },
        );
    const sync = () => {
        for (const item of ambient) {
            if (reduce.matches || !item.enabled()) {
                item.animation?.cancel();
                item.animation = undefined;
            } else if (pageHidden || !item.visible) item.animation?.pause();
            else {
                item.animation ||= item.element.animate(item.frames, item.options);
                item.animation.play();
            }
        }
        for (const animation of running) {
            if (reduce.matches) animation.cancel();
            else if (pageHidden) animation.pause();
            else if (animation.playState === 'paused') animation.play();
        }
    };
    const preview = document.querySelector('.wave-preview');
    if (motion) {
        const visibility = new IntersectionObserver((entries) => {
            for (const entry of entries)
                for (const item of ambient) if (item.observe === entry.target) item.visible = entry.isIntersecting;
            sync();
        });
        const loop = (element, frames, options, observe = element, enabled = () => true) => {
            ambient.push({
                element,
                frames,
                options: { iterations: Infinity, easing: 'ease-in-out', ...options },
                observe,
                enabled,
                visible: false,
            });
            visibility.observe(observe);
        };
        const glow = document.querySelector('.hero-glow');
        if (glow)
            loop(
                glow,
                [
                    { transform: 'translate(-5%,0) scale(1)', opacity: 0.5 },
                    { transform: 'translate(4%,5%) scale(1.12)', opacity: 0.8 },
                    { transform: 'translate(-5%,0) scale(1)', opacity: 0.5 },
                ],
                { duration: 18000 },
                document.querySelector('.hero'),
            );
        document
            .querySelectorAll('[data-photo-motion]')
            .forEach((image) =>
                loop(
                    image,
                    [{ transform: 'scale(1.03) translateY(0)' }, { transform: 'scale(1.09) translateY(-1%)' }],
                    { duration: 22000, direction: 'alternate' },
                    image.parentElement,
                ),
            );
        preview
            .querySelectorAll('.preview-orb')
            .forEach((orb) =>
                loop(
                    orb,
                    [{ transform: 'rotate(-8deg) scale(1)' }, { transform: 'rotate(8deg) scale(1.12)' }],
                    { duration: 6500, direction: 'alternate' },
                    preview,
                    () =>
                        preview.classList.contains('is-previewing') &&
                        orb.classList.contains('orb-' + preview.dataset.previewMood),
                ),
            );
        preview
            .querySelectorAll('.preview-bars i')
            .forEach((bar, index) =>
                loop(
                    bar,
                    [
                        { transform: `scaleY(${0.18 + (index % 4) * 0.08})` },
                        { transform: `scaleY(${0.5 + (index % 5) * 0.1})` },
                        { transform: 'scaleY(.22)' },
                    ],
                    { duration: 800 + (index % 5) * 170, delay: -(index * 97) },
                    preview,
                    () => preview.classList.contains('is-previewing'),
                ),
            );
        const observer = new IntersectionObserver(
            (entries) => {
                let delay = 0;
                for (const entry of entries)
                    if (entry.isIntersecting) {
                        observer.unobserve(entry.target);
                        reveal(entry.target, Math.min(delay, 150));
                        delay += 55;
                    }
            },
            { threshold: 0.08 },
        );
        document
            .querySelectorAll('[data-reveal], #features .card, .flow, details, .english')
            .forEach((element) => observer.observe(element));
        document.querySelectorAll('.hero-copy > *').forEach((element, index) => reveal(element, index * 45));
    }
    document.querySelector('.preview-toggle').addEventListener('click', (event) => {
        const active = preview.classList.toggle('is-previewing');
        event.currentTarget.setAttribute('aria-pressed', String(active));
        sync();
    });
    document.querySelectorAll('[data-mood]').forEach((button) =>
        button.addEventListener('click', () => {
            preview.dataset.previewMood = button.dataset.mood;
            document
                .querySelectorAll('[data-mood]')
                .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
            document.querySelectorAll('[data-mood-copy]').forEach((copy) => {
                copy.hidden = copy.dataset.moodCopy !== button.dataset.mood;
            });
            sync();
            animate(
                preview.querySelector('[data-mood-copy]:not([hidden])'),
                [
                    { opacity: 0, transform: 'translateY(5px)' },
                    { opacity: 1, transform: 'none' },
                ],
                { duration: 300 },
            );
        }),
    );
    const gallery = document.querySelector('.gallery-stage'),
        buttons = [...document.querySelectorAll('[data-gallery]')];
    let selection = 0;
    buttons.forEach((button) =>
        button.addEventListener('click', async () => {
            const generation = ++selection,
                panel = document.querySelector(`[data-gallery-panel="${button.dataset.gallery}"]`),
                image = panel.querySelector('img');
            gallery.setAttribute('aria-busy', 'true');
            image.loading = 'eager';
            await image.decode().catch(() => {});
            if (generation !== selection) return;
            buttons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
            document.querySelectorAll('[data-gallery-panel]').forEach((item) => {
                item.hidden = item !== panel;
            });
            gallery.setAttribute('aria-busy', 'false');
            reveal(panel);
        }),
    );
    document.querySelector('.gallery-tabs').hidden = false;
    const dialog = document.querySelector('.lightbox');
    let closing = false;
    let opener;
    const close = async () => {
        if (!dialog.open || closing) return;
        closing = true;
        const animation = animate(
            dialog,
            [
                { opacity: 1, transform: 'scale(1)' },
                { opacity: 0, transform: 'scale(.98)' },
            ],
            { duration: 160 },
        );
        if (animation) await animation.finished.catch(() => {});
        dialog.close();
        closing = false;
    };
    document.querySelectorAll('[data-zoom]').forEach((button) =>
        button.addEventListener('click', (event) => {
            if (!dialog.showModal) return;
            event.preventDefault();
            if (dialog.open) return;
            opener = button;
            const source = button.querySelector('img');
            const image = dialog.querySelector('img');
            image.src = source.src;
            image.alt = source.alt;
            dialog.showModal();
            animate(
                dialog,
                [
                    { opacity: 0, transform: 'translateY(18px) scale(.98)' },
                    { opacity: 1, transform: 'none' },
                ],
                { duration: 300 },
            );
        }),
    );
    dialog.querySelector('button').addEventListener('click', close);
    dialog.addEventListener('close', () => opener?.focus({ preventScroll: true }));
    dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        void close();
    });
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) void close();
    });
    document.querySelectorAll('details').forEach((details) =>
        details.addEventListener('toggle', () => {
            if (details.open) reveal(details.querySelector('p'));
        }),
    );
    let frame;
    const progress = document.querySelector('.reading-progress');
    const updateProgress = () => {
        frame = undefined;
        const distance = document.documentElement.scrollHeight - innerHeight;
        progress.style.transform = `scaleX(${distance > 0 ? Math.min(1, Math.max(0, scrollY / distance)) : 0})`;
    };
    const scheduleProgress = () => {
        if (!frame && !pageHidden) frame = requestAnimationFrame(updateProgress);
    };
    addEventListener('scroll', scheduleProgress, { passive: true });
    addEventListener('resize', scheduleProgress, { passive: true });
    document.addEventListener('visibilitychange', () => {
        pageHidden = document.hidden;
        sync();
        scheduleProgress();
    });
    reduce.addEventListener('change', sync);
    addEventListener('pagehide', () => {
        pageHidden = true;
        cancelAnimationFrame(frame);
        frame = undefined;
        sync();
    });
    addEventListener('pageshow', () => {
        pageHidden = document.hidden;
        sync();
        scheduleProgress();
    });
    scheduleProgress();
})();
