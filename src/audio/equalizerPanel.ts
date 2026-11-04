import type { EqualizerSettings, equalizerPresets } from './equalizerSettings';

export interface EqualizerModel {
    settings: EqualizerSettings;
    presets: typeof equalizerPresets;
    frequencies: number[];
    interfaceLanguage: string;
    systemLocale: string;
}
export function installEqualizerPanel(model: EqualizerModel): void {
    const page = window as typeof window & {
        soundcloudEqualizer?: { save: (value: EqualizerSettings) => void };
        __soundcloudEqualizer?: { set: (value: EqualizerSettings) => void; snapshot: () => Record<string, unknown> };
        __soundcloudEqualizerPanel?: { language: (value: string) => void };
    };
    if (page.__soundcloudEqualizerPanel || !page.soundcloudEqualizer) return;
    const api = page.soundcloudEqualizer;
    let settings = { ...model.settings, gains: [...model.settings.gains] };
    let language = model.interfaceLanguage;
    const ru = () => (language === 'auto' ? model.systemLocale : language).toLowerCase().startsWith('ru');
    const text = (russian: string, english: string) => (ru() ? russian : english);
    const host = document.createElement('div');
    host.id = 'sc-equalizer';
    host.style.cssText =
        'display:inline-flex;align-items:center;flex:0 0 36px;align-self:center;margin-left:8px;height:48px;z-index:20';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{color-scheme:dark;font:12px/1.4 Arial,Helvetica,sans-serif;color:#eee}
      *{box-sizing:border-box}button,select,input{font:inherit}button{cursor:pointer}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #ff773d;outline-offset:4px}
      .toggle{display:grid;place-items:center;width:32px;height:32px;padding:6px;background:none;border:0;border-radius:5px;color:#eee}.toggle:hover,.toggle[aria-expanded=true]{background:#ffffff15}.toggle[data-enabled=true]{color:#f50}
      svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
      .panel{position:fixed;bottom:64px;right:12px;width:min(600px,calc(100vw - 24px));max-height:calc(100vh - 88px);overflow:auto;background:#202020;border:1px solid #ffffff20;border-radius:12px;box-shadow:0 14px 48px #0008;padding:20px;z-index:2147483000;animation:enter .16s ease-out;isolation:isolate}
      [hidden]{display:none!important}.head{display:flex;align-items:center;gap:12px}.head h2{font-size:19px;line-height:1.2;margin:0;flex:1;color:#fff}.close{width:28px;height:28px;background:transparent;border:0;color:#aaa;display:grid;place-items:center}.close:hover{color:white}
      .power{width:38px;height:22px;background:#666;border:0;border-radius:20px;padding:3px;position:relative}.power:after{content:'';display:block;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}.power[aria-checked=true]{background:#f50}.power[aria-checked=true]:after{transform:translateX(16px)}
      .presets{display:flex;align-items:center;gap:12px;margin:20px 0 12px}.presets label{flex:1;display:flex;align-items:center;gap:10px;color:#bbb}.presets select{min-width:0;width:100%;background:#303030;border:1px solid #555;border-radius:5px;padding:8px;color:#fff}.reset{background:transparent;border:1px solid #555;border-radius:5px;padding:8px 10px;color:#ddd}.reset:hover{border-color:#999}
      .description{margin:0 0 8px;font-size:12px;line-height:1.5;color:#aaa}
      .chart{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:2px;padding:12px 0 8px;position:relative}.chart:before{content:'';position:absolute;left:0;right:0;top:119px;border-top:1px solid #ffffff17;pointer-events:none}
      .band{display:flex;align-items:center;flex-direction:column;gap:9px;min-width:0}.band output{font-size:11px;color:#eee;font-variant-numeric:tabular-nums;min-height:16px}.band input{writing-mode:vertical-lr;direction:rtl;width:22px;height:164px;accent-color:#f50;cursor:ns-resize;margin:0}.band span{font-size:11px;color:#bbb;white-space:nowrap}
      .preamp{display:grid;grid-template-columns:auto 1fr 48px;gap:12px;align-items:center;margin-top:16px;padding-top:16px;border-top:1px solid #ffffff16;color:#bbb}.preamp input{min-width:0;width:100%;accent-color:#f50;margin:0}.preamp output{text-align:right;font-variant-numeric:tabular-nums;color:#eee}
      .hint{font-size:11px;color:#999;min-height:30px;margin:14px 0 0}.hint[data-error=true]{color:#ffc09f}.foot{margin:4px 0 0;color:#777;font-size:11px}
      @keyframes enter{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.panel{animation:none}.power:after{transition:none}}@media(max-width:480px){.panel{padding:14px}.presets{gap:7px}.presets label{display:block}.presets select{margin-top:5px}.preamp{gap:6px}.band output,.band span{font-size:10px}}
    </style>
    <button type="button" class="toggle" aria-expanded="false" aria-controls="eq-panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v5m0 6v7M12 3v10m0 6v2M19 3v2m0 6v10"/><path d="M2 8h6v6H2zM9 13h6v6H9zM16 5h6v6h-6z"/></svg></button>
    <section id="eq-panel" class="panel" role="dialog" aria-modal="false" aria-labelledby="eq-heading" hidden>
      <div class="head"><h2 id="eq-heading"></h2><button type="button" class="power" role="switch"></button><button type="button" class="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
      <div class="presets"><label><span class="preset-label"></span><select></select></label><button type="button" class="reset"></button></div>
      <p class="description" hidden></p>
      <div class="chart"></div>
      <label class="preamp"><span></span><input type="range" min="-18" max="0" step="0.5"><output></output></label>
      <p class="hint" role="status" aria-live="polite"></p><p class="foot"></p>
    </section>`;
    const $ = <T extends Element = HTMLElement>(selector: string) => shadow.querySelector<T>(selector)!;
    const toggle = $<HTMLButtonElement>('.toggle');
    const panel = $<HTMLElement>('.panel');
    const power = $<HTMLButtonElement>('.power');
    const select = $<HTMLSelectElement>('select');
    const preamp = $<HTMLInputElement>('.preamp input');
    const decibels = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
    const listeners = new AbortController();
    const signal = listeners.signal;
    const bands = model.frequencies.map((frequency, index) => {
        const label = document.createElement('label');
        label.className = 'band';
        const output = document.createElement('output');
        const range = document.createElement('input');
        Object.assign(range, { type: 'range', min: '-12', max: '12', step: '0.5' });
        range.setAttribute('aria-label', frequency + ' Hz');
        range.dataset.band = String(index);
        const caption = document.createElement('span');
        caption.textContent = frequency >= 1000 ? frequency / 1000 + 'k' : String(frequency);
        label.append(output, range, caption);
        $('.chart').append(label);
        return { range, output };
    });
    for (const group of ['tone', 'genre', 'instrument']) {
        const container = document.createElement('optgroup');
        container.dataset.group = group;
        for (const preset of model.presets.filter((item) => (item.group || 'genre') === group)) {
            const option = document.createElement('option');
            option.value = preset.id;
            container.append(option);
        }
        if (container.children.length) select.append(container);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.disabled = true;
    select.append(custom);
    const renderDescription = () => {
        const preset = model.presets.find((item) => item.id === settings.preset);
        const description = ru() ? preset?.descriptionRu : preset?.descriptionEn;
        $('.description').textContent = description || '';
        $('.description').hidden = !description;
    };
    const refreshStatus = () => {
        const status = page.__soundcloudEqualizer?.snapshot();
        const hint = $('.hint');
        hint.dataset.error = String(settings.enabled && status?.status === 'unavailable');
        hint.textContent = !settings.enabled
            ? text('Выключен — исходное звучание.', 'Off — original sound.')
            : status?.status === 'unavailable'
              ? status.reason === 'protected'
                  ? text(
                        'Этот защищённый поток не предоставляет доступ к обработке звука.',
                        'This protected stream does not expose audio for processing.',
                    )
                  : status.reason === 'cors'
                    ? text(
                          'Браузер не разрешает обработку звука этого потока.',
                          'The browser does not allow audio processing for this stream.',
                      )
                    : text(
                          'Не удалось подключиться к аудиотракту плеера. Подробности есть в диагностике.',
                          'Could not connect to the player’s audio graph. Details are available in diagnostics.',
                      )
              : status?.status === 'active'
                ? text('Эквалайзер работает. Автозапас громкости: ', 'Equalizer active. Automatic headroom: ') +
                  decibels(-Number(status.headroomDb || 0))
                : status?.reason === 'loading' ||
                    status?.reason === 'native-connecting' ||
                    status?.reason === 'native-suspended' ||
                    status?.reason === 'context-suspended'
                  ? text('Подключаемся к плееру…', 'Connecting to the player…')
                  : text(
                        'Настройки готовы. Включите трек в SoundCloud.',
                        'Settings ready. Play a track in SoundCloud.',
                    );
    };
    const render = () => {
        power.setAttribute('aria-checked', String(settings.enabled));
        toggle.dataset.enabled = String(settings.enabled);
        select.value = settings.preset;
        renderDescription();
        preamp.value = String(settings.preamp);
        $('.preamp output').textContent = decibels(settings.preamp);
        bands.forEach(({ range, output }, index) => {
            range.value = String(settings.gains[index]);
            range.setAttribute('aria-valuetext', decibels(settings.gains[index]));
            output.value = decibels(settings.gains[index]).replace(' dB', '');
        });
        refreshStatus();
    };
    const save = () => {
        page.__soundcloudEqualizer?.set(settings);
        api.save({ ...settings, gains: [...settings.gains] });
        render();
    };
    const localize = () => {
        const title = text('Эквалайзер', 'Equalizer');
        toggle.title = title;
        toggle.setAttribute('aria-label', title);
        $('#eq-heading').textContent = title;
        panel.lang = ru() ? 'ru' : 'en';
        power.setAttribute('aria-label', text('Включить эквалайзер', 'Enable equalizer'));
        $('.close').setAttribute('aria-label', text('Закрыть', 'Close'));
        $('.reset').textContent = text('Сбросить', 'Reset');
        $('.preset-label').textContent = text('Пресет', 'Preset');
        $('.preamp span').textContent = text('Усиление', 'Preamp');
        preamp.setAttribute('aria-label', text('Усиление', 'Preamp'));
        $('.foot').textContent = text(
            'Настройки сохраняются автоматически. Обрабатывается только плеер этого окна.',
            'Settings save automatically. Only this window’s player is processed.',
        );
        [...select.options].forEach((option) => {
            const preset = model.presets.find((item) => item.id === option.value);
            option.textContent = preset ? (ru() ? preset.ru : preset.en) : text('Свой', 'Custom');
        });
        const groups = {
            tone: text('Звучание', 'Sound'),
            genre: text('Жанры', 'Genres'),
            instrument: text('Инструменты', 'Instruments'),
        };
        for (const group of select.querySelectorAll('optgroup'))
            group.label = groups[group.dataset.group as keyof typeof groups];
        renderDescription();
        refreshStatus();
    };
    const close = (restore = false) => {
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        if (restore) toggle.focus();
    };
    toggle.addEventListener(
        'click',
        () => {
            panel.hidden = !panel.hidden;
            toggle.setAttribute('aria-expanded', String(!panel.hidden));
            if (!panel.hidden) {
                refreshStatus();
                select.focus();
            }
        },
        { signal },
    );
    $('.close').addEventListener('click', () => close(true), { signal });
    panel.addEventListener(
        'keydown',
        (event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                close(true);
            }
        },
        { signal },
    );
    document.addEventListener(
        'pointerdown',
        (event) => {
            if (!panel.hidden && !event.composedPath().includes(host)) close();
        },
        { signal },
    );
    power.addEventListener(
        'click',
        () => {
            settings.enabled = !settings.enabled;
            save();
        },
        { signal },
    );
    select.addEventListener(
        'change',
        () => {
            const preset = model.presets.find((item) => item.id === select.value);
            if (!preset) return;
            settings = { enabled: true, preset: preset.id, gains: [...preset.gains], preamp: settings.preamp };
            save();
        },
        { signal },
    );
    $('.reset').addEventListener(
        'click',
        () => {
            settings = { enabled: settings.enabled, preset: 'flat', gains: model.frequencies.map(() => 0), preamp: 0 };
            save();
        },
        { signal },
    );
    bands.forEach(({ range }, index) =>
        range.addEventListener(
            'input',
            () => {
                settings.gains[index] = Number(range.value);
                settings.preset = 'custom';
                settings.enabled = true;
                save();
            },
            { signal },
        ),
    );
    preamp.addEventListener(
        'input',
        () => {
            settings.preamp = Number(preamp.value);
            settings.enabled = true;
            save();
        },
        { signal },
    );
    page.addEventListener('soundcloud-equalizer-status', refreshStatus, { signal });
    const mount = () => {
        if (host.isConnected) return;
        const player = document.querySelector('.playControls');
        if (!player) return;
        const container = player.querySelector('.playControls__elements');
        host.style.position = container ? 'relative' : 'absolute';
        host.style.right = container ? '' : '12px';
        host.style.bottom = container ? '' : '0';
        (container || player).append(host);
    };
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true });
    mount();
    page.__soundcloudEqualizerPanel = {
        language(value) {
            language = value;
            localize();
        },
    };
    localize();
    render();
    page.addEventListener('pagehide', (event) => {
        close();
        if (!(event as PageTransitionEvent).persisted) {
            observer.disconnect();
            listeners.abort();
            host.remove();
        }
    });
}
