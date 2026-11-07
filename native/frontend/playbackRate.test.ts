import { afterEach, expect, it, vi } from 'vitest';
import { playbackRate } from './playbackRate';
afterEach(() => vi.unstubAllGlobals());
it('uses the active plugin speed with a safe normal-speed fallback', () => {
    vi.stubGlobal('window', {});
    expect(playbackRate()).toBe(1);
    for (const rate of [0.5, 1, 1.5, 2]) {
        vi.stubGlobal('window', { __scrpcPlaybackSpeedApi: { getRate: () => rate } });
        expect(playbackRate()).toBe(rate);
    }
    for (const rate of [NaN, Infinity, 0, 10]) {
        vi.stubGlobal('window', { __scrpcPlaybackSpeedApi: { getRate: () => rate } });
        expect(playbackRate()).toBe(1);
    }
    vi.stubGlobal('window', {
        __scrpcPlaybackSpeedApi: {
            getRate: () => {
                throw Error('disabled');
            },
        },
    });
    expect(playbackRate()).toBe(1);
});
