window.waveMetadataProbe = (url) =>
    new Promise((resolve) => {
        if (!window.SC?.Widget || !/^https:\/\/soundcloud\.com\//.test(url)) {
            resolve(null);
            return;
        }
        const frame = document.createElement('iframe');
        frame.width = '350';
        frame.height = '180';
        frame.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&visual=false`;
        let finished = false;
        const finish = (value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            frame.remove();
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), 6500);
        document.body.append(frame);
        const widget = window.SC.Widget(frame);
        widget.bind(window.SC.Widget.Events.READY, () =>
            widget.getCurrentSound((sound) => {
                if (!sound) {
                    finish(null);
                    return;
                }
                finish({
                    title: String(sound.title || '').slice(0, 200),
                    artist: String(sound.user?.username || '').slice(0, 100),
                    genre: String(sound.genre || '').slice(0, 80),
                    tags:
                        String(sound.tag_list || '')
                            .match(/"[^"]+"|[^\s]+/g)
                            ?.map((tag) => tag.replace(/^"|"$/g, '').slice(0, 50))
                            .slice(0, 20) || [],
                    bpm: Number(sound.bpm) || undefined,
                });
            }),
        );
    });
