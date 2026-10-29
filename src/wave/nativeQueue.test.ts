import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { addToNativeNextUp, NativeActionCanceledError, playInNativePlayer, trackPath } from './nativeQueue';
describe('native SoundCloud queue bridge', () => {
    it('does not click Play for a stopped run that was waiting behind another native action', async () => {
        const view = new EventEmitter() as WebContents;
        view.getURL = () => 'https://soundcloud.com/discover';
        view.isDestroyed = () => false;
        Object.defineProperty(view, 'navigationHistory', { value: { getActiveIndex: () => 1 } });
        let release!: (value: string) => void,
            active = true;
        const execute = vi
            .fn()
            .mockResolvedValue(undefined)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            )
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce('already');
        view.executeJavaScript = vi.fn((code, ...args) =>
            code.startsWith('({ path:') ? Promise.resolve({ path: '', playing: false }) : execute(code, ...args),
        );
        const queued = addToNativeNextUp(view, 'https://soundcloud.com/artist/one');
        const play = playInNativePlayer(view, 'https://soundcloud.com/artist/two', undefined, undefined, () => active);
        const rejected = expect(play).rejects.toBeInstanceOf(NativeActionCanceledError);
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
        active = false;
        release('');
        await queued;
        await rejected;
        expect(execute.mock.calls.some(([code]) => code.includes('.soundTitle__playButton .playButton'))).toBe(false);
    });
    it('accepts track permalinks and rejects foreign or non-track URLs', () => {
        expect(trackPath('https://soundcloud.com/artist/my-track?utm_source=share')).toBe('/artist/my-track');
        expect(trackPath('https://evil.example/artist/my-track')).toBeNull();
        expect(trackPath('https://soundcloud.com/artist/sets/my-track')).toBeNull();
        expect(trackPath('javascript:alert(1)')).toBeNull();
    });
    it('adds a visible card through the native menu and verifies Next Up', async () => {
        const view = new EventEmitter() as WebContents;
        view.getURL = () => 'https://soundcloud.com/search?q=test';
        view.isDestroyed = () => false;
        Object.defineProperty(view, 'navigationHistory', { value: { getActiveIndex: () => 1 } });
        view.insertText = vi.fn();
        view.sendInputEvent = vi.fn();
        const execute = vi
            .fn()
            .mockResolvedValue(undefined)
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce('menu')
            .mockResolvedValueOnce({ selected: false })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(['https://soundcloud.com/artist/my-track']);
        view.executeJavaScript = vi.fn((code, ...args) =>
            code.startsWith('({ path:') ? Promise.resolve({ path: '', playing: false }) : execute(code, ...args),
        );
        await addToNativeNextUp(view, 'https://soundcloud.com/artist/my-track');
        expect(execute.mock.calls[3][0]).toContain('button.addToNextUp');
        expect(view.insertText).not.toHaveBeenCalled();
        expect(execute.mock.calls.some(([code]) => code.includes("button.addToNextUp')?.click()"))).toBe(true);
        expect(view.sendInputEvent).not.toHaveBeenCalled();
    });
    it('plays through a visible SoundCloud card and verifies the native player', async () => {
        const view = new EventEmitter() as WebContents;
        view.getURL = () => 'https://soundcloud.com/search?q=test';
        view.isDestroyed = () => false;
        Object.defineProperty(view, 'navigationHistory', { value: { getActiveIndex: () => 1 } });
        const execute = vi
            .fn()
            .mockResolvedValue(undefined)
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce({ path: '/artist/my-track', playing: true });
        view.executeJavaScript = vi.fn((code, ...args) =>
            code.startsWith('({ path:') ? Promise.resolve({ path: '', playing: false }) : execute(code, ...args),
        );
        await playInNativePlayer(view, 'https://soundcloud.com/artist/my-track');
        expect(execute.mock.calls[2][0]).toContain('.soundTitle__playButton .playButton');
        expect(execute.mock.calls[3][0]).toContain('.playControls__play');
    });
    it('serializes queue and playback actions on the same SoundCloud page', async () => {
        const view = new EventEmitter() as WebContents;
        view.getURL = () => 'https://soundcloud.com/discover';
        view.isDestroyed = () => false;
        Object.defineProperty(view, 'navigationHistory', { value: { getActiveIndex: () => 1 } });
        let release!: (value: string) => void;
        const held = new Promise<string>((resolve) => {
            release = resolve;
        });
        const execute = vi
            .fn()
            .mockResolvedValue(undefined)
            .mockReturnValueOnce(held)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce('already')
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce({ path: '/artist/next-track', playing: true });
        view.executeJavaScript = vi.fn((code, ...args) =>
            code.startsWith('({ path:') ? Promise.resolve({ path: '', playing: false }) : execute(code, ...args),
        );
        const queued = addToNativeNextUp(view, 'https://soundcloud.com/artist/queued-track');
        const played = playInNativePlayer(view, 'https://soundcloud.com/artist/next-track');
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
        release('');
        await Promise.all([queued, played]);
        expect(execute.mock.calls[4][0]).toContain('.headerSearch__input');
    });
});
