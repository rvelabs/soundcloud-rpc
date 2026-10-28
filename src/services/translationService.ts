import * as en from '../i18n/en.json';
import * as pt_BR from '../i18n/pt-BR.json';
import * as es from '../i18n/es.json';
import * as ru from '../i18n/ru.json';
const translations = {
    en,
    'pt-BR': pt_BR,
    es,
    ru,
} as const;
type Lang = keyof typeof translations;
type TranslationKeys = keyof typeof en;
export class TranslationService {
    private currentLang: Lang = 'en';
    constructor(initialLang: Lang = 'en') {
        this.currentLang = initialLang;
    }
    setLanguage(lang: string) {
        const canonical = lang.toLowerCase().split('-')[0];
        this.currentLang = canonical === 'ru' ? 'ru' : canonical === 'pt' ? 'pt-BR' : canonical === 'es' ? 'es' : 'en';
    }
    getLanguage(): Lang {
        return this.currentLang;
    }
    translate(key: TranslationKeys): string {
        const dict = translations[this.currentLang] as Record<string, string>;
        return dict[key as string] ?? (en as Record<string, string>)[key as string] ?? (key as string);
    }
    getAll(): Record<string, string> {
        const result = Object.fromEntries(
            Object.keys(en)
                .filter((key) => typeof (en as Record<string, unknown>)[key] === 'string')
                .map((key) => [key, this.translate(key as TranslationKeys)]),
        );
        result.lastFmSecret = result.lastFmApiSecret;
        return result;
    }
}
