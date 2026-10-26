(() => {
    if (!Element.prototype.animate || !window.IntersectionObserver) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const hero = document.querySelector('.hero');
    const glow = document.querySelector('.hero-glow');
    const running = new Set();
    let ambient;
    let inView = true;
    const reveal = (element, delay = 0) => {
        if (reduce.matches) return;
        const animation = element.animate(
            [
                { opacity: 0, transform: 'translateY(18px)' },
                { opacity: 1, transform: 'none' },
            ],
            { duration: 600, delay, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' },
        );
        running.add(animation);
        animation.finished.then(
            () => running.delete(animation),
            () => running.delete(animation),
        );
    };
    const sync = () => {
        if (reduce.matches) {
            ambient?.cancel();
            ambient = undefined;
            for (const animation of running) animation.cancel();
            running.clear();
            return;
        }
        if (!ambient && glow) {
            ambient = glow.animate(
                [
                    { transform: 'translate(-5%, 0) scale(1)', opacity: 0.65 },
                    { transform: 'translate(4%, 5%) scale(1.12)', opacity: 1 },
                    { transform: 'translate(-5%, 0) scale(1)', opacity: 0.65 },
                ],
                { duration: 18000, iterations: Infinity, easing: 'ease-in-out' },
            );
        }
        if (document.hidden || !inView) ambient?.pause();
        else ambient?.play();
    };
    const visibility = new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        sync();
    });
    if (hero) visibility.observe(hero);
    const observer = new IntersectionObserver(
        (entries) => {
            let delay = 0;
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                observer.unobserve(entry.target);
                reveal(entry.target, delay);
                delay += 65;
            }
        },
        { threshold: 0.08 },
    );
    document.querySelectorAll('.card, .flow, details, .english').forEach((element) => observer.observe(element));
    document.querySelectorAll('.hero > :not(.hero-glow)').forEach((element, index) => reveal(element, index * 70));
    document.querySelectorAll('details').forEach((details) => {
        details.addEventListener('toggle', () => {
            if (details.open) reveal(details.querySelector('p'));
        });
    });
    document.addEventListener('visibilitychange', sync);
    reduce.addEventListener('change', sync);
    window.addEventListener('pagehide', () => ambient?.pause());
    window.addEventListener('pageshow', sync);
    sync();
})();
