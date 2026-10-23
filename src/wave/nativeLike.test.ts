import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import type { WebContents } from 'electron';
import { inspectLikeButton, isSoundCloudTrackUrl, setTrackLiked } from './nativeLike';
describe('native SoundCloud like action', () => {
    it('accepts only track pages on soundcloud.com', () => {
        expect(isSoundCloudTrackUrl('https://soundcloud.com/artist/song')).toBe(true);
        expect(isSoundCloudTrackUrl('https://soundcloud.com.evil.example/artist/song')).toBe(false);
        expect(isSoundCloudTrackUrl('https://soundcloud.com/you/likes')).toBe(false);
    });
    it('ignores the unrelated bottom player heart', () => {
        let clicked = false;
        const bottom = {
            classList: { contains: (name: string) => name === 'playbackSoundBadge__like' },
            closest: () => null,
            getAttribute: () => null,
            click: () => {
                clicked = true;
            },
        };
        const result = runInNewContext(`(${inspectLikeButton.toString()})(true)`, {
            document: { querySelector: () => null, querySelectorAll: () => [bottom] },
        });
        expect(result).toEqual({ found: false, liked: false });
        expect(clicked).toBe(false);
    });
    it('finds only the matching result card when the track page has no like button', () => {
        let clicked = '';
        const card = (path: string) => ({
            querySelector: (selector: string) =>
                selector.startsWith('a.')
                    ? { href: `https://soundcloud.com${path}` }
                    : {
                          disabled: false,
                          classList: { contains: () => false },
                          getAttribute: () => null,
                          click: () => {
                              clicked = path;
                          },
                      },
        });
        const result = runInNewContext(
            `(${inspectLikeButton.toString()})(true,'https://soundcloud.com/artist/right',true)`,
            {
                URL,
                document: { querySelectorAll: () => [card('/artist/wrong'), card('/artist/right')] },
            },
        );
        expect(result).toEqual({ found: true, liked: false });
        expect(clicked).toBe('/artist/right');
    });
    it('likes once and checks the resulting site state', async () => {
        const url = 'https://soundcloud.com/artist/song';
        let loaded = '';
        let loads = 0;
        let liked = false;
        let clicks = 0;
        const view = {
            getURL: () => loaded,
            loadURL: async (target: string) => {
                loaded = target;
                loads++;
            },
            executeJavaScript: async (script: string) => {
                if (script.includes(')(true,')) {
                    clicks++;
                    liked = true;
                }
                return { found: true, liked };
            },
        } as unknown as WebContents;
        expect(await setTrackLiked(view, url, true, '', 0)).toBe(true);
        expect(clicks).toBe(1);
        expect(loads).toBe(2);
        expect(await setTrackLiked(view, url, true, '', 0)).toBe(true);
        expect(clicks).toBe(1);
    });
    it('refuses to click if SoundCloud redirects away from the requested track', async () => {
        let clicks = 0;
        const view = {
            getURL: () => 'https://soundcloud.com/signin',
            loadURL: async () => {},
            executeJavaScript: async () => {
                clicks++;
                return { found: true, liked: false };
            },
        } as unknown as WebContents;
        await expect(setTrackLiked(view, 'https://soundcloud.com/artist/song', true, '', 0)).rejects.toThrow(
            'перенаправил',
        );
        expect(clicks).toBe(0);
    });
});
