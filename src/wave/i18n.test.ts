import { describe, expect, it } from 'vitest';
import { waveEnglish, translateWaveText } from './i18n';
describe('wave translations', () => {
    it('covers interface labels and leaves music metadata untouched', () => {
        expect(translateWaveText('Моя волна', 'en', waveEnglish)).toBe('My Wave');
        expect(translateWaveText('Моя волна', 'ru', waveEnglish)).toBe('Моя волна');
        expect(translateWaveText('Artist — Незнакомая песня', 'en', waveEnglish)).toBe('Artist — Незнакомая песня');
    });
    it('preserves template values and safely falls back for unknown messages', () => {
        expect(translateWaveText('Проверено {done} из {total}', 'en', waveEnglish, { done: 3, total: 10 })).toBe(
            'Checked 3 of 10',
        );
        for (const [original, english] of Object.entries(waveEnglish)) {
            expect([...english.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort()).toEqual(
                [...original.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort(),
            );
        }
    });
});
