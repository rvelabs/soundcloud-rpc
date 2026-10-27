import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { confirmPlaylistWrite } from './nativePlaylist';
function fixture() {
    const debug = Object.assign(new EventEmitter(), {
        isAttached: vi.fn(() => false),
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn<(method:string,params?:object)=>Promise<unknown>>(async () => undefined),
    });
    const message = (method: string, params: object) => debug.emit('message', {}, `Network.${method}`, params);
    const request = () =>
        message('requestWillBeSent', {
            requestId: 'write',
            request: {
                method: 'PUT',
                url: 'https://api-v2.soundcloud.com/playlists/123',
            },
        });
    return { debug, message, request, view: { debugger: debug } as unknown as WebContents };
}
describe('official playlist write completion', () => {
    it('waits beyond optimistic UI and response headers until the write finishes', async () => {
        const f = fixture();
        let done = false;
        const task = confirmPlaylistWrite(f.view, async () => {
            f.request();
            return true;
        }).then(() => {
            done = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(done).toBe(false);
        f.message('responseReceived', { requestId: 'write', response: { status: 200 } });
        await Promise.resolve();
        expect(done).toBe(false);
        f.message('loadingFinished', { requestId: 'write' });
        await task;
        expect(done).toBe(true);
        expect(f.debug.listenerCount('message')).toBe(0);
    });
    it('reports server errors instead of counting the optimistic button as saved', async () => {
        const f = fixture();
        const task = confirmPlaylistWrite(f.view, async () => {
            f.request();
            f.message('responseReceived', { requestId: 'write', response: { status: 403 } });
            f.message('loadingFinished', { requestId: 'write' });
            return true;
        });
        await expect(task).rejects.toThrow('403');
        expect(f.debug.listenerCount('message')).toBe(0);
    });
    it('cleans observers when no button exists', async () => {
        const f = fixture();
        expect(await confirmPlaylistWrite(f.view, async () => false)).toBe(false);
        expect(f.debug.listenerCount('message')).toBe(0);
    });
    it('identifies account confirmation and rate limits as global failures rather than unavailable songs', async () => {
        for (const status of [401, 403, 429]) {
            const f = fixture();
            f.debug.sendCommand.mockImplementation(async (method) =>
                method === 'Network.getResponseBody'
                    ? { body: JSON.stringify({ errors: [{ message: 'Please verify your email address' }] }) }
                    : undefined,
            );
            const task = confirmPlaylistWrite(f.view, async () => {
                f.request();
                f.message('responseReceived', { requestId: 'write', response: { status } });
                f.message('loadingFinished', { requestId: 'write' });
                return true;
            });
            await expect(task).rejects.toMatchObject({ status, fatal: true });
        }
    });
});
