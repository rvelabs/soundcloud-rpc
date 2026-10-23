const api = window.waveHome;
const body = document.body;
const status = document.getElementById('status');
const startButton = document.getElementById('start');
const startLabel = document.getElementById('start-label');
const audioButton = document.getElementById('audio-toggle');
const audioStatus = document.getElementById('audio-status');
const playerPanel = document.getElementById('player-panel');
const playToggle = document.getElementById('play-toggle');
const seek = document.getElementById('seek');
const volume = document.getElementById('volume');
let positionMs = 0;
let seeking = false;
let visible = true;
let playing = false;
let audioStream = null;
let captureEpoch = 0;
let pendingCaptureEpoch = 0;
let audioRetryOnVisible = false;
let context = null;
let analyser = null;
let timer = null;
let timeData = null;
let freqData = null;
let lastStyle = '';
let lastStyleTime = 0;
let previousBass = 0;
let lastBeatAt = 0;
let beatIntervals = [];
let widget = null;
let selected = null;
let currentSound = null;
let currentLiked = false;
let widgetPlaying = false;
let widgetReady = false;
let desiredPlaying = false;
let loadingTrack = false;
let stopped = false;
let repeatTrack = false;
let loadSerial = 0;
let initialReadyHandled = false;
let previousVolume = 100;
let readyAt = 0;
let fallbackTimer = null;
let endWatchdog = null;
let advanceRequestedSerial = -1;
const player = document.getElementById('wave-player');
const formatTime = (ms) => {
    const seconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
function sendTrack(position = positionMs) {
    if (!selected) return;
    const sound = currentSound || {};
    positionMs = position;
    renderPosition();
    api.track({
        title: sound.title || selected.title,
        author: sound.user?.username || selected.artist,
        artwork: sound.artwork_url || sound.user?.avatar_url || '',
        elapsed: formatTime(position),
        duration: formatTime(sound.duration),
        isPlaying: widgetPlaying,
        isLiked: currentLiked,
        url: selected.url,
    });
    const duration = Number(sound.duration) || 0;
    if (
        duration > 10000 &&
        !repeatTrack &&
        desiredPlaying &&
        widgetPlaying &&
        position >= duration - 1500 &&
        advanceRequestedSerial !== loadSerial &&
        !endWatchdog
    ) {
        const serial = loadSerial;
        endWatchdog = setTimeout(() => {
            endWatchdog = null;
            if (serial === loadSerial && !repeatTrack && desiredPlaying && widgetPlaying) requestAdvance('finish');
        }, 1700);
    }
}
function requestAdvance(reason) {
    if (advanceRequestedSerial === loadSerial) return;
    advanceRequestedSerial = loadSerial;
    if (endWatchdog) clearTimeout(endWatchdog);
    endWatchdog = null;
    api.next(reason);
}
function renderPosition() {
    const duration = Math.max(0, Number(currentSound?.duration) || 0);
    document.getElementById('time-total').textContent = formatTime(duration);
    if (!seeking) {
        seek.value = duration ? String(Math.round(Math.min(1, positionMs / duration) * 1000)) : '0';
        document.getElementById('time-current').textContent = formatTime(positionMs);
    }
    seek.style.setProperty('--range-fill', `${Number(seek.value) / 10}%`);
}
function enforcePlaybackIntent(serial) {
    if (!widget || serial !== loadSerial) return;
    widget.isPaused((paused) => {
        if (serial !== loadSerial) return;
        if (desiredPlaying && paused) widget.play();
        else if (!desiredPlaying && !paused) widget.pause();
        else if (widgetPlaying !== !paused) {
            widgetPlaying = !paused;
            setPlaying(widgetPlaying);
            sendTrack();
        }
    });
}
function onWidgetReady(serial) {
    if (serial !== loadSerial || !widget) return;
    loadingTrack = false;
    widgetReady = true;
    readyAt = Date.now();
    widget.setVolume(Number(volume.value));
    widget.getCurrentSound((sound) => {
        if (serial !== loadSerial) return;
        currentSound = sound;
        sendTrack(0);
        if (sound && selected)
            api.metadata?.(selected.url, {
                genre: sound.genre || selected.genre || '',
                tags:
                    String(sound.tag_list || '')
                        .match(/"[^"]+"|[^\s]+/g)
                        ?.map((tag) => tag.replace(/^"|"$/g, '')) ||
                    selected.tags ||
                    [],
                bpm: Number(sound.bpm) || selected.bpm || undefined,
            });
    });
    if (desiredPlaying) widget.play();
    else widget.pause();
    setTimeout(() => enforcePlaybackIntent(serial), 300);
}
function setPlaybackIntent(play) {
    if (!widget) return;
    desiredPlaying = play;
    stopped = false;
    if (!play && endWatchdog) {
        clearTimeout(endWatchdog);
        endWatchdog = null;
    }
    if (play) widget.play();
    else widget.pause();
    widgetPlaying = play;
    setPlaying(play);
    sendTrack();
    const serial = loadSerial;
    setTimeout(() => enforcePlaybackIntent(serial), 300);
}
function playSelected(candidate) {
    if (!window.SC?.Widget) {
        status.textContent = 'Не загрузился официальный плеер SoundCloud. Проверьте соединение.';
        setPlaying(false);
        return;
    }
    selected = candidate;
    currentLiked = false;
    previousBass = 0;
    lastBeatAt = 0;
    beatIntervals = [];
    const serial = ++loadSerial;
    advanceRequestedSerial = -1;
    if (endWatchdog) clearTimeout(endWatchdog);
    endWatchdog = null;
    currentSound = null;
    widgetPlaying = false;
    widgetReady = false;
    desiredPlaying = true;
    loadingTrack = true;
    stopped = false;
    setPlaying(false);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    playerPanel.hidden = false;
    positionMs = 0;
    document.getElementById('track-title').textContent = candidate.title;
    document.getElementById('track-artist').textContent = candidate.artist;
    document.getElementById('artwork').removeAttribute('src');
    renderPosition();
    const options = {
        auto_play: true,
        visual: false,
        show_artwork: false,
        color: '#ff5500',
        buying: false,
        sharing: false,
        download: false,
        show_comments: false,
        callback: () => onWidgetReady(serial),
    };
    if (widget) widget.load(candidate.url, options);
    else {
        player.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(candidate.url)}&auto_play=true&visual=false&show_artwork=false&color=%23ff5500`;
        widget = window.SC.Widget(player);
        widget.bind(window.SC.Widget.Events.READY, () => {
            if (!initialReadyHandled) {
                initialReadyHandled = true;
                onWidgetReady(serial);
            }
        });
        widget.bind(window.SC.Widget.Events.PLAY, () => {
            if (loadingTrack) return;
            if (!desiredPlaying) {
                widget.pause();
                return;
            }
            widgetPlaying = true;
            widget.getCurrentSound((sound) => {
                currentSound = sound;
                sendTrack();
            });
            setPlaying(true);
        });
        widget.bind(window.SC.Widget.Events.PAUSE, () => {
            if (loadingTrack) return;
            if (desiredPlaying && Date.now() - readyAt < 500) return;
            widgetPlaying = false;
            sendTrack();
            setPlaying(false);
            const duration = Number(currentSound?.duration) || 0;
            const serial = loadSerial;
            if (desiredPlaying && !repeatTrack && duration > 10000 && positionMs >= duration - 2000)
                setTimeout(() => {
                    if (serial === loadSerial && desiredPlaying && !widgetPlaying && advanceRequestedSerial !== serial)
                        requestAdvance('finish');
                }, 700);
        });
        widget.bind(window.SC.Widget.Events.PLAY_PROGRESS, (progress) => {
            if (!loadingTrack) sendTrack(progress.currentPosition);
        });
        widget.bind(window.SC.Widget.Events.FINISH, () => {
            if (loadingTrack || stopped || !desiredPlaying) return;
            if (repeatTrack) {
                widget.seekTo(0);
                widget.play();
            } else requestAdvance('finish');
        });
        widget.bind(window.SC.Widget.Events.ERROR, () => {
            status.textContent = 'Трек недоступен. Ищем следующий…';
            requestAdvance('error');
        });
    }
    fallbackTimer = setTimeout(() => {
        if (!widgetReady && !widgetPlaying) status.textContent = 'Плеер не ответил. Попробуйте следующий трек.';
    }, 12000);
    status.textContent = `Загружаем ${candidate.title}…`;
}
function setPlaying(value) {
    playing = value;
    body.classList.toggle('playing', value);
    body.classList.toggle('paused', !visible || !value || document.hidden);
    playToggle.dataset.playing = String(value);
    playToggle.setAttribute('aria-label', value ? 'Пауза' : 'Воспроизвести');
    playToggle.title = value ? 'Пауза' : 'Воспроизвести';
    if (analyser) scheduleSample();
}
function scheduleSample() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!analyser || !visible || !playing || document.hidden) return;
    timer = setTimeout(sample, 180);
}
function sample() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);
    let power = 0;
    for (const value of timeData) power += ((value - 128) / 128) ** 2;
    const energy = Math.min(1, Math.sqrt(power / timeData.length) * 2.6);
    const band = (from, to) => {
        let sum = 0;
        for (let i = from; i < to; i++) sum += freqData[i];
        return Math.min(1, sum / (Math.max(1, to - from) * 255));
    };
    const features = { energy, bass: band(1, 12), mid: band(12, 90), treble: band(90, 300) };
    const now = performance.now();
    if (features.bass > 0.16 && features.bass > previousBass * 1.28 && now - lastBeatAt > 300) {
        const interval = now - lastBeatAt;
        if (lastBeatAt && interval >= 300 && interval <= 1000) {
            beatIntervals.push(interval);
            if (beatIntervals.length > 12) beatIntervals.shift();
            if (beatIntervals.length >= 5) {
                const sorted = [...beatIntervals].sort((a, b) => a - b);
                features.bpm = Math.round(60000 / sorted[Math.floor(sorted.length / 2)]);
            }
        }
        lastBeatAt = now;
    }
    previousBass = features.bass;
    const style = energy > 0.55 ? 'энергичное' : energy < 0.2 ? 'спокойное' : 'ровное';
    const tone =
        features.bass > features.treble * 1.5
            ? 'басовое'
            : features.treble > features.bass * 1.5
              ? 'яркое'
              : 'сбалансированное';
    if (`${style}-${tone}` !== lastStyle && Date.now() - lastStyleTime > 5000) {
        lastStyle = `${style}-${tone}`;
        lastStyleTime = Date.now();
        document.getElementById('sound-label').textContent = `Сейчас звучит: ${style} · ${tone}`;
    }
    body.style.setProperty('--brightness', String(0.85 + energy * 0.8));
    body.style.setProperty('--shift', `${Math.round((features.treble - features.bass) * 85)}deg`);
    api.audio(features);
    scheduleSample();
}
async function stopAudio() {
    captureEpoch++;
    pendingCaptureEpoch = 0;
    audioRetryOnVisible = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (audioStream) audioStream.getTracks().forEach((track) => track.stop());
    audioStream = null;
    analyser = null;
    if (context) await context.close();
    context = null;
    audioButton.textContent = 'Включить анализ';
    audioStatus.textContent = 'Выключен';
}
async function startAudio() {
    if (audioStream || pendingCaptureEpoch) return;
    if (!visible) {
        audioRetryOnVisible = true;
        return;
    }
    const epoch = ++captureEpoch;
    pendingCaptureEpoch = epoch;
    audioStatus.textContent = 'Подключаем звук плеера…';
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (epoch !== captureEpoch || !visible) {
            stream.getTracks().forEach((track) => track.stop());
            if (epoch === captureEpoch && !visible) audioRetryOnVisible = true;
            return;
        }
        const tracks = stream.getAudioTracks();
        if (!tracks.length) {
            stream.getTracks().forEach((track) => track.stop());
            throw new Error('Операционная система не предоставила аудиопоток.');
        }
        stream.getVideoTracks().forEach((track) => track.stop());
        audioStream = stream;
        audioRetryOnVisible = false;
        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);
        timeData = new Uint8Array(analyser.fftSize);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        audioButton.textContent = 'Выключить анализ';
        audioStatus.textContent = 'Анализируем только звук плеера';
        tracks[0].addEventListener(
            'ended',
            () => {
                void stopAudio();
            },
            { once: true },
        );
        scheduleSample();
    } catch (error) {
        if (epoch !== captureEpoch) return;
        audioStatus.textContent = error instanceof Error ? error.message : 'Захват звука недоступен';
        await stopAudio();
        audioStatus.textContent = 'Захват звука недоступен — подбор работает по истории';
    } finally {
        if (pendingCaptureEpoch === epoch) pendingCaptureEpoch = 0;
    }
}
window.startWaveAudio = startAudio;
async function startWave() {
    startButton.disabled = true;
    startLabel.textContent = 'Подбираем…';
    status.textContent = 'Ищем кандидатов в SoundCloud и подбираем трек';
    try {
        const result = await api.start();
        status.textContent =
            result === 'playing' ? 'Волна готова · ваш вкус учитывается' : 'Не удалось начать воспроизведение';
    } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Не удалось запустить волну';
        setPlaying(false);
    } finally {
        startButton.disabled = false;
        startLabel.textContent = 'Слушать волну';
    }
}
startButton.addEventListener('click', () => {
    void startWave();
});
document.getElementById('settings').addEventListener('click', () => {
    const panel = document.getElementById('settings-panel');
    panel.hidden = !panel.hidden;
});
audioButton.addEventListener('click', () => {
    void (audioStream ? stopAudio() : startAudio());
});
document.getElementById('back').addEventListener('click', () => api.showSoundCloud());
document.getElementById('next').addEventListener('click', () => api.next('user'));
document.getElementById('previous').addEventListener('click', () => {
    if (widgetReady && positionMs > 3000) widget.seekTo(0);
    else api.previous();
});
playToggle.addEventListener('click', () => setPlaybackIntent(!desiredPlaying));
document.getElementById('stop').addEventListener('click', () => {
    if (!widget) return;
    stopped = true;
    desiredPlaying = false;
    widgetPlaying = false;
    widget.pause();
    widget.seekTo(0);
    positionMs = 0;
    renderPosition();
    setPlaying(false);
    sendTrack(0);
});
const shuffleButton = document.getElementById('shuffle');
shuffleButton.addEventListener('click', () => {
    const enabled = shuffleButton.getAttribute('aria-pressed') !== 'true';
    shuffleButton.setAttribute('aria-pressed', String(enabled));
    api.shuffle(enabled);
});
const repeatButton = document.getElementById('repeat');
repeatButton.addEventListener('click', () => {
    repeatTrack = !repeatTrack;
    repeatButton.setAttribute('aria-pressed', String(repeatTrack));
});
seek.addEventListener('pointerdown', () => {
    seeking = true;
});
seek.addEventListener('input', () => {
    const duration = Number(currentSound?.duration) || 0;
    document.getElementById('time-current').textContent = formatTime((duration * Number(seek.value)) / 1000);
    seek.style.setProperty('--range-fill', `${Number(seek.value) / 10}%`);
});
seek.addEventListener('change', () => {
    const duration = Number(currentSound?.duration) || 0;
    if (widgetReady && duration) widget.seekTo((duration * Number(seek.value)) / 1000);
    seeking = false;
});
function applyVolume(value) {
    volume.value = String(value);
    document.getElementById('volume-value').textContent = `${volume.value}%`;
    volume.style.setProperty('--range-fill', `${volume.value}%`);
    document.getElementById('mute').dataset.muted = String(Number(volume.value) === 0);
    widget?.setVolume(Number(volume.value));
}
volume.addEventListener('input', () => {
    if (Number(volume.value) > 0) previousVolume = Number(volume.value);
    applyVolume(Number(volume.value));
});
document.getElementById('mute').addEventListener('click', () => {
    if (Number(volume.value) > 0) {
        previousVolume = Number(volume.value);
        applyVolume(0);
    } else applyVolume(previousVolume || 100);
});
for (const id of ['track-title', 'track-artist'])
    document.getElementById(id).addEventListener('click', (event) => {
        event.preventDefault();
        if (selected) api.openTrack(selected.url);
    });
const controlsTab = document.getElementById('controls-tab');
const soundcloudTab = document.getElementById('soundcloud-tab');
const controls = document.getElementById('player-controls');
const soundcloudControls = document.getElementById('soundcloud-controls');
function selectPlayerTab(showSoundCloud) {
    controlsTab.classList.toggle('active', !showSoundCloud);
    soundcloudTab.classList.toggle('active', showSoundCloud);
    controlsTab.setAttribute('aria-selected', String(!showSoundCloud));
    soundcloudTab.setAttribute('aria-selected', String(showSoundCloud));
    controls.hidden = showSoundCloud;
    soundcloudControls.classList.toggle('active', showSoundCloud);
    soundcloudControls.setAttribute('aria-hidden', String(!showSoundCloud));
}
controlsTab.addEventListener('click', () => selectPlayerTab(false));
soundcloudTab.addEventListener('click', () => selectPlayerTab(true));
document
    .querySelectorAll('.card[data-open]')
    .forEach((card) => card.addEventListener('click', () => api.navigate(card.dataset.open)));
document.querySelectorAll('.tabs button').forEach((tab) =>
    tab.addEventListener('click', () => {
        document.querySelector('.tabs button.active')?.classList.remove('active');
        tab.classList.add('active');
        if (tab.dataset.target !== 'all') api.navigate(tab.dataset.target);
    }),
);
api.on('wave-home:state', (state, message) => {
    if (state === 'loading') {
        status.textContent = 'Ищем вашу музыку…';
    }
    if (state === 'playing') {
        status.textContent = 'Волна играет · ваш вкус учитывается';
    }
    if (state === 'error') {
        setPlaying(false);
        status.textContent = String(message || 'Не удалось запустить волну');
    }
});
api.on('wave-home:visible', (value) => {
    visible = Boolean(value);
    body.classList.toggle('paused', !visible || !playing);
    if (visible && audioRetryOnVisible && !audioStream) void startAudio();
    if (context) {
        if (visible && context.state === 'suspended') void context.resume().catch(() => {});
        if (!visible && context.state === 'running') void context.suspend().catch(() => {});
    }
    scheduleSample();
});
document.addEventListener('visibilitychange', () => {
    body.classList.toggle('paused', document.hidden || !visible || !playing);
    scheduleSample();
});
api.on('wave-home:stats', (stats) => {
    const count = Number(stats?.heard) || 0;
    document.getElementById('learning').textContent = count
        ? `Учитываем ${count} прослушанных треков`
        : 'Подстраиваемся под ваш вкус';
});
api.on('wave-home:track', (track) => {
    if (!track?.title || !selected || track.url !== selected.url) return;
    document.getElementById('track-title').textContent = track.title;
    document.getElementById('track-artist').textContent = track.author || '';
    const art = document.getElementById('artwork');
    if (typeof track.artwork === 'string' && /^https:\/\//.test(track.artwork)) art.src = track.artwork;
    let hash = 0;
    for (const char of track.title + track.author) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    body.style.setProperty('--shift', `${(Math.abs(hash) % 95) - 30}deg`);
    setPlaying(Boolean(track.isPlaying));
});
api.on('wave-home:play-track', (candidate) => playSelected(candidate));
api.on('wave-home:pause', () => {
    if (widget) setPlaybackIntent(false);
});
api.on('wave-home:stop-audio', () => {
    void stopAudio();
});
api.on('wave-home:restart', () => {
    widget?.seekTo(0);
});
api.on('wave-home:liked', (url, liked) => {
    if (selected?.url !== url) return;
    currentLiked = Boolean(liked);
    sendTrack();
});
api.on('wave-home:command', (command, value) => {
    if (command === 'toggle') setPlaybackIntent(!desiredPlaying);
    if (command === 'play') setPlaybackIntent(true);
    if (command === 'pause') setPlaybackIntent(false);
    if (command === 'repeat') repeatTrack = Boolean(value);
    if (command === 'seek' && widgetReady && Number.isFinite(Number(value))) {
        const duration = Number(currentSound?.duration) || 0;
        widget?.seekTo(duration * Math.max(0, Math.min(1, Number(value))));
    }
    if (command === 'volume' && Number.isFinite(Number(value))) applyVolume(Math.max(0, Math.min(100, Number(value))));
    if (command === 'mute') document.getElementById('mute').click();
});
