import { describe, expect, it } from 'vitest';
import { TranslationService } from './translationService';
import { interfaceText, settingsMarkup } from '../i18n/interfaceText';
import en from '../i18n/en.json';
import ru from '../i18n/ru.json';
describe('shared interface language', () => {
    it('covers all legacy settings keys in Russian and returns strings only', () => {
        expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
        const service = new TranslationService();
        service.setLanguage('ru-RU');
        expect(service.translate('darkMode')).toBe('Тёмная тема');
        expect(service.getAll().uiScale).toBe('Масштаб интерфейса');
        expect(Object.values(service.getAll()).every((value) => typeof value === 'string')).toBe(true);
        service.setLanguage('unknown');
        expect(service.translate('darkMode')).toBe(en.darkMode);
    });
    it('localizes template literals without rewriting interpolated user values', () => {
        const value = 'Автоматически';
        expect(settingsMarkup('en')`<p>Автоматически</p><input value="${value}">`).toBe(
            '<p>Automatic</p><input value="Автоматически">',
        );
        expect(settingsMarkup('ru')`<h2>Account Manager</h2>`).toContain('Аккаунты');
        expect(interfaceText('Готово: https://relay.example', 'en')).toBe('Ready: https://relay.example');
    });
});
