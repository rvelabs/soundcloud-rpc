import { describe, expect, it } from 'vitest';
import { discoverPersonalHistory, discoverRelatedCandidates } from './nativeWave';
import type { WebContents } from 'electron';
describe('SoundCloud discovery pages', () => {
    it('finds related tracks on the dedicated recommendation page', async () => {
        let loaded = '';
        const view = {
            loadURL: async (url: string) => {
                loaded = url;
            },
            getURL: () => loaded,
            executeJavaScript: async () => [
                { url: 'https://soundcloud.com/other/new', title: 'New', artist: 'Other', sourceRank: 0 },
            ],
        } as unknown as WebContents;
        const result = await discoverRelatedCandidates(view, 'https://soundcloud.com/seed/song');
        expect(loaded).toBe('https://soundcloud.com/seed/song/recommended');
        expect(result[0].url).toBe('https://soundcloud.com/other/new');
    });
    it('rejects a recommendation page redirected to a different route', async () => {
        const view = {
            loadURL: async () => {},
            getURL: () => 'https://soundcloud.com/signin',
        } as unknown as WebContents;
        expect(await discoverRelatedCandidates(view, 'https://soundcloud.com/seed/song')).toEqual([]);
    });
    it('reads likes as taste and recent listening as exclusions', async () => {
        let current = '';
        const view = {
            loadURL: async (url: string) => {
                current = url;
            },
            getURL: () => current,
            executeJavaScript: async () => [
                { url: `${current}/track`, title: 'Track', artist: 'Artist', sourceRank: 0 },
            ],
        } as unknown as WebContents;
        const result = await discoverPersonalHistory(view);
        expect(result.likes[0].url).toContain('/you/likes');
        expect(result.recent[0].url).toContain('/you/history');
    });
});
