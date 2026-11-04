import { describe, expect, it } from 'vitest';
import { equalizerFrequencies, equalizerPresets, normalizeEqualizer } from './equalizerSettings';

describe('equalizer settings', () => {
    it('starts disabled and never silently enables processing on invalid persisted input', () => {
        for (const value of [undefined, null, {}, 'enabled', { enabled: 'true' }])
            expect(normalizeEqualizer(value)).toEqual({
                enabled: false,
                preset: 'flat',
                gains: Array(10).fill(0),
                preamp: 0,
            });
    });
    it('bounds untrusted gains and preamp, handles missing bands and rejects non-finite values', () => {
        const result = normalizeEqualizer({
            enabled: true,
            preset: '<script>',
            gains: [Infinity, NaN, -100, 100, 0.76, '4'],
            preamp: 12,
        });
        expect(result.gains).toEqual([0, 0, -12, 12, 1, 0, 0, 0, 0, 0]);
        expect(result.preamp).toBe(0);
        expect(result.preset).toBe('custom');
        expect(normalizeEqualizer({ preamp: -99 }).preamp).toBe(-18);
    });
    it('preserves an exact preset across restart and treats modified curves as custom', () => {
        const preset = equalizerPresets.find((item) => item.id === 'bass')!;
        const state = normalizeEqualizer({ enabled: true, preset: preset.id, preamp: -2.5 });
        expect(state.gains).toEqual(preset.gains);
        expect(normalizeEqualizer(JSON.parse(JSON.stringify(state)))).toEqual(state);
        state.gains[0] = 2;
        expect(normalizeEqualizer(state).preset).toBe('custom');
        expect(preset.gains[0]).toBe(6);
    });
    it('provides distinct valid bilingual curves for every preset', () => {
        expect(equalizerPresets.length).toBeGreaterThanOrEqual(25);
        expect(new Set(equalizerPresets.map((item) => item.id)).size).toBe(equalizerPresets.length);
        expect(new Set(equalizerPresets.map((item) => JSON.stringify(item.gains))).size).toBe(equalizerPresets.length);
        for (const preset of equalizerPresets) {
            expect(preset.gains).toHaveLength(equalizerFrequencies.length);
            expect(normalizeEqualizer({ preset: preset.id }).gains).toEqual(preset.gains);
            expect(preset.ru.length).toBeGreaterThan(2);
            expect(preset.en.length).toBeGreaterThan(2);
        }
    });
});
