export const equalizerFrequencies = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export interface EqualizerPreset {
    id: string;
    ru: string;
    en: string;
    gains: number[];
    group?: 'tone' | 'genre' | 'instrument';
    descriptionRu?: string;
    descriptionEn?: string;
}
const definitions: EqualizerPreset[] = [
    { id: 'flat', ru: 'Без изменений', en: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'bass', ru: 'Больше баса', en: 'Bass boost', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    { id: 'deep', ru: 'Глубокий бас', en: 'Deep bass', gains: [7, 6, 3, 0, -1, -1, 0, 0, 1, 1] },
    { id: 'bass-cut', ru: 'Меньше баса', en: 'Bass reducer', gains: [-6, -5, -3, -1, 0, 0, 0, 0, 0, 0] },
    { id: 'treble', ru: 'Больше высоких', en: 'Treble boost', gains: [0, 0, 0, 0, 0, 0, 1, 3, 4, 5] },
    { id: 'soft', ru: 'Мягкие высокие', en: 'Soft treble', gains: [1, 1, 0, 0, 0, 0, -1, -2, -4, -5] },
    { id: 'vocal', ru: 'Вокал', en: 'Vocals', gains: [-3, -2, -1, 0, 2, 3, 4, 2, 0, -1] },
    { id: 'warm', ru: 'Тёплое звучание', en: 'Warm', gains: [2, 3, 3, 2, 1, 0, -1, -1, -2, -2] },
    { id: 'clear', ru: 'Детальное звучание', en: 'Clarity', gains: [-1, -1, -2, -1, 0, 1, 3, 3, 2, 1] },
    { id: 'night', ru: 'Ночное прослушивание', en: 'Night listening', gains: [-3, -2, 0, 1, 2, 2, 1, 0, -2, -3] },
    { id: 'rock', ru: 'Рок', en: 'Rock', gains: [4, 3, 1, -1, -2, 0, 2, 3, 4, 3] },
    { id: 'pop', ru: 'Поп', en: 'Pop', gains: [-1, 1, 3, 4, 3, 1, -1, -1, 1, 2] },
    { id: 'electronic', ru: 'Электроника', en: 'Electronic', gains: [5, 4, 2, 0, -2, 0, 1, 3, 4, 3] },
    { id: 'dance', ru: 'Танцевальная', en: 'Dance', gains: [5, 4, 1, 0, 0, 2, 3, 3, 1, 0] },
    { id: 'hiphop', ru: 'Хип-хоп', en: 'Hip-hop', gains: [5, 4, 2, 1, -1, -1, 1, 0, 1, 2] },
    { id: 'phonk', ru: 'Фонк', en: 'Phonk', gains: [5, 5, 3, 0, -2, -1, 2, 3, 1, -1] },
    { id: 'dnb', ru: 'Драм-н-бейс', en: 'Drum & bass', gains: [5, 4, 2, -1, -2, 0, 2, 3, 3, 2] },
    { id: 'house', ru: 'Хаус', en: 'House', gains: [4, 4, 2, 0, -1, 0, 1, 2, 3, 2] },
    { id: 'techno', ru: 'Техно', en: 'Techno', gains: [5, 4, 2, -1, -2, -1, 1, 3, 3, 1] },
    { id: 'ambient', ru: 'Эмбиент', en: 'Ambient', gains: [2, 1, 0, -1, -1, 0, 1, 2, 2, 3] },
    { id: 'lofi', ru: 'Лоу-фай', en: 'Lo-fi', gains: [1, 3, 3, 2, 1, 0, -2, -3, -5, -6] },
    { id: 'jazz', ru: 'Джаз', en: 'Jazz', gains: [2, 2, 0, 1, -1, 0, 2, 3, 2, 1] },
    { id: 'classical', ru: 'Классика', en: 'Classical', gains: [3, 2, 0, -1, -1, 0, 1, 2, 3, 3] },
    { id: 'acoustic', ru: 'Акустика', en: 'Acoustic', gains: [0, 1, 2, 2, 1, 2, 3, 2, 1, 1] },
    { id: 'metal', ru: 'Метал', en: 'Metal', gains: [4, 3, 1, -2, -3, 0, 3, 4, 3, 2] },
    { id: 'rnb', ru: 'R&B / соул', en: 'R&B / soul', gains: [3, 4, 2, 0, 1, 2, 1, 0, 1, 2] },
    { id: 'reggae', ru: 'Регги', en: 'Reggae', gains: [4, 4, 2, 0, -1, 1, 2, 1, 0, 1] },
    { id: 'podcast', ru: 'Речь и подкасты', en: 'Speech & podcasts', gains: [-6, -4, -2, 0, 2, 3, 4, 2, -1, -3] },
    {
        id: 'punch',
        ru: 'Упругий бас',
        en: 'Bass punch',
        group: 'tone',
        gains: [0, 2, 5, 2, -1, -1, 0, 0, 0, 0],
        descriptionRu: 'Акцент на ударе баса в районе 125 Гц, без усиления самого глубокого низа.',
        descriptionEn: 'Emphasizes bass impact around 125 Hz without boosting the deepest sub-bass.',
    },
    {
        id: 'less-mud',
        ru: 'Меньше гулкости',
        en: 'Less muddiness',
        group: 'tone',
        gains: [-1, -1, -1, -4, -3, 0, 1, 0, 0, 0],
        descriptionRu: 'Приглушает область 250–500 Гц, если запись кажется гулкой или перегруженной низкой серединой.',
        descriptionEn: 'Reduces 250–500 Hz when a recording sounds boomy or crowded in the low mids.',
    },
    {
        id: 'soft-sibilance',
        ru: 'Мягче шипящие',
        en: 'Softer sibilance',
        group: 'tone',
        gains: [0, 0, 0, 0, 0, 0, -1, -3, -4, -1],
        descriptionRu: 'Смягчает резкость в районе 4–8 кГц. Воздействует на весь трек, а не только на голос.',
        descriptionEn: 'Softens the 4–8 kHz region. Affects the whole track, not just vocals.',
    },
    {
        id: 'low-volume',
        ru: 'Тихое прослушивание',
        en: 'Low-volume listening',
        group: 'tone',
        gains: [4, 3, 1, 0, -1, 0, 0, 1, 2, 3],
        descriptionRu: 'Поднимает низ и верх относительно середины для тихого прослушивания. Не сжимает динамику.',
        descriptionEn: 'Lifts bass and treble relative to the mids for quiet listening. Does not compress dynamics.',
    },
    {
        id: 'small-speakers',
        ru: 'Небольшие колонки',
        en: 'Small speakers',
        group: 'tone',
        gains: [-7, -5, -2, 2, 3, 2, 1, 1, 0, -1],
        descriptionRu: 'Убирает глубокий низ и выделяет середину. Стартовая настройка для компактных колонок.',
        descriptionEn: 'Reduces deep bass and emphasizes the mids. A starting point for compact speakers.',
    },
    {
        id: 'trap',
        ru: 'Трэп',
        en: 'Trap',
        group: 'genre',
        gains: [6, 4, 1, -2, -2, 0, 1, 2, 3, 1],
        descriptionRu: 'Глубокий низ и акцент на верхних деталях с более свободной нижней серединой.',
        descriptionEn: 'Deep low end and upper detail with less emphasis on the low mids.',
    },
    {
        id: 'dubstep',
        ru: 'Дабстеп',
        en: 'Dubstep',
        group: 'genre',
        gains: [6, 5, 2, -2, -3, -1, 2, 4, 3, 0],
        descriptionRu: 'Выделяет саб-бас и атаку в верхней середине.',
        descriptionEn: 'Emphasizes sub-bass and upper-mid attack.',
    },
    {
        id: 'trance',
        ru: 'Транс',
        en: 'Trance',
        group: 'genre',
        gains: [3, 3, 1, -1, -2, 0, 3, 4, 3, 4],
        descriptionRu: 'Более заметные синтезаторы и высокий верх при умеренном подъёме баса.',
        descriptionEn: 'Brings synths and high treble forward with a moderate bass lift.',
    },
    {
        id: 'hardstyle',
        ru: 'Хардстайл',
        en: 'Hardstyle',
        group: 'genre',
        gains: [2, 4, 5, 1, -2, -1, 2, 3, 1, 0],
        descriptionRu: 'Акцент на плотности удара в области 63–125 Гц и его атаке.',
        descriptionEn: 'Emphasizes kick weight around 63–125 Hz and its attack.',
    },
    {
        id: 'synthwave',
        ru: 'Синтвейв',
        en: 'Synthwave',
        group: 'genre',
        gains: [3, 2, 1, 0, -1, 1, 2, 2, 1, 4],
        descriptionRu: 'Добавляет телесность басу и воздуха верхним синтезаторным партиям.',
        descriptionEn: 'Adds bass body and air to high synth parts.',
    },
    {
        id: 'hyperpop',
        ru: 'Гиперпоп',
        en: 'Hyperpop',
        group: 'genre',
        gains: [2, 3, 1, -2, -2, 1, 3, 2, -1, -2],
        descriptionRu: 'Выделяет бас и присутствие вокала, смягчая самый яркий верх.',
        descriptionEn: 'Emphasizes bass and vocal presence while softening the highest treble.',
    },
    {
        id: 'indie',
        ru: 'Инди',
        en: 'Indie',
        group: 'genre',
        gains: [0, 1, 1, 2, 2, 1, 2, 1, 0, -1],
        descriptionRu: 'Умеренный акцент на гитарах и середине без сильного подъёма краёв диапазона.',
        descriptionEn: 'A moderate guitar and midrange emphasis without a strong bass or treble boost.',
    },
    {
        id: 'piano',
        ru: 'Фортепиано',
        en: 'Piano',
        group: 'instrument',
        gains: [0, 1, 2, 3, 2, 1, 2, 1, 1, 0],
        descriptionRu: 'Подчёркивает корпус и атаку фортепиано; меняет тембр всей записи.',
        descriptionEn: 'Emphasizes piano body and attack; changes the tone of the whole recording.',
    },
    {
        id: 'strings',
        ru: 'Струнные',
        en: 'Strings',
        group: 'instrument',
        gains: [-2, -1, 0, 1, 2, 3, 2, 1, 2, 1],
        descriptionRu: 'Выделяет середину и верхние гармоники струнных, приглушая глубокий низ.',
        descriptionEn: 'Highlights string midrange and upper harmonics while reducing deep bass.',
    },
];
const toneIds = new Set([
    'flat',
    'bass',
    'deep',
    'bass-cut',
    'treble',
    'soft',
    'vocal',
    'warm',
    'clear',
    'night',
    'podcast',
]);
export const equalizerPresets: EqualizerPreset[] = definitions.map((preset) => ({
    ...preset,
    group: preset.group || (toneIds.has(preset.id) ? 'tone' : 'genre'),
}));
export interface EqualizerSettings {
    enabled: boolean;
    preset: string;
    gains: number[];
    preamp: number;
}
export function normalizeEqualizer(value: unknown): EqualizerSettings {
    const input = value && typeof value === 'object' ? (value as Partial<EqualizerSettings>) : {};
    const preset = equalizerPresets.find((item) => item.id === (input.preset || 'flat'));
    const gains = equalizerFrequencies.map((_, index) => {
        const gain = Array.isArray(input.gains) ? input.gains[index] : preset?.gains[index];
        return typeof gain === 'number' && Number.isFinite(gain)
            ? Math.round(Math.max(-12, Math.min(12, gain)) * 2) / 2
            : 0;
    });
    return {
        enabled: input.enabled === true,
        preset: preset && preset.gains.every((gain, index) => gain === gains[index]) ? preset.id : 'custom',
        gains,
        preamp:
            typeof input.preamp === 'number' && Number.isFinite(input.preamp)
                ? Math.round(Math.max(-18, Math.min(0, input.preamp)) * 2) / 2
                : 0,
    };
}
