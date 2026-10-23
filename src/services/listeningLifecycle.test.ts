import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type ElectronStore from 'electron-store';
import type { BrowserView } from 'electron';
import { WebhookService } from './webhookService';
import { LastFmService } from './lastFmService';
const request = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: request }));
const memory = () => {
    const values = new Map<string, unknown>(
        Object.entries({
            webhookEnabled: true,
            webhookUrl: 'https://example.test/hook',
            webhookTriggerPercentage: 50,
            lastFmEnabled: true,
            lastFmApiKey: 'key',
            lastFmSecret: 'secret',
            lastFmSessionKey: 'session',
        }),
    );
    return {
        values,
        store: {
            get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
            set: (key: string, value: unknown) => values.set(key, value),
            delete: (key: string) => values.delete(key),
        } as unknown as ElectronStore,
    };
};
const track = (title = 'A', elapsed = '0:00', duration = '4:00') => ({
    title,
    author: 'Artist',
    elapsed,
    duration,
    artwork: '',
    url: 'https://soundcloud.com/artist/' + title,
});
const response = () => Promise.resolve({ ok: true, json: async () => ({}) });
const messages = () =>
    request.mock.calls
        .map(([, init]) => init?.body)
        .filter((value) => typeof value === 'string')
        .map((value) => JSON.parse(value));
const scrobbles = () =>
    request.mock.calls.filter(
        ([, init]) => init?.body instanceof URLSearchParams && init.body.get('method') === 'track.scrobble',
    );
describe('listening integrations under overlapping events', () => {
    const disposables: {
        dispose(): void;
    }[] = [];
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
        request.mockReset();
        request.mockImplementation(response);
    });
    afterEach(() => {
        for (const service of disposables.splice(0)) service.dispose();
        vi.useRealTimers();
    });
    it('never marks a new webhook track sent when the preceding HTTP request resolves late', async () => {
        const { store } = memory();
        const service = new WebhookService(store);
        disposables.push(service);
        let finish!: (value: unknown) => void;
        request.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await service.updateTrackInfo(track('A'));
        await vi.advanceTimersByTimeAsync(120000);
        await service.updateTrackInfo(track('B'));
        finish({ ok: true });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(120000);
        expect(messages().map((item) => item.track)).toEqual(['A', 'B']);
    });
    it('does not reset a webhook on early likes, send while paused, or fire after disabling', async () => {
        const { store } = memory();
        const service = new WebhookService(store);
        disposables.push(service);
        await service.updateTrackInfo(track());
        await vi.advanceTimersByTimeAsync(1000);
        await service.updateTrackInfo(track('A', '0:01'));
        await vi.advanceTimersByTimeAsync(59000);
        await service.updateTrackInfo(track('A', '1:00'), false);
        await vi.advanceTimersByTimeAsync(3600000);
        expect(request).not.toHaveBeenCalled();
        await service.updateTrackInfo(track('A', '1:00'), true);
        await vi.advanceTimersByTimeAsync(60000);
        expect(messages()).toHaveLength(1);
        await service.updateTrackInfo(track('B'));
        service.setEnabled(false);
        await vi.advanceTimersByTimeAsync(240000);
        expect(messages()).toHaveLength(1);
    });
    it('waits for duration, and honours a zero-percent webhook setting', async () => {
        const { store } = memory();
        const service = new WebhookService(store);
        disposables.push(service);
        service.setTriggerPercentage(0);
        await service.updateTrackInfo(track('A', '0:00', ''));
        expect(request).not.toHaveBeenCalled();
        await service.updateTrackInfo(track('A'));
        await Promise.resolve();
        expect(messages()).toHaveLength(1);
    });
    it('scrobbles late duration once, never invents repeats, and excludes short tracks', async () => {
        const { store } = memory();
        const service = new LastFmService({ webContents: {} } as BrowserView, store);
        disposables.push(service);
        await service.updateTrackInfo(track('A', '0:00', ''));
        await vi.advanceTimersByTimeAsync(1000);
        await service.updateTrackInfo(track('A', '0:01'));
        await vi.advanceTimersByTimeAsync(120000);
        expect(scrobbles()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(15 * 60000);
        expect(scrobbles()).toHaveLength(1);
        await service.updateTrackInfo(track('B', '0:00', '0:20'));
        await vi.advanceTimersByTimeAsync(60000);
        expect(scrobbles()).toHaveLength(1);
    });
    it('does not scrobble a long pause, or let an old HTTP response claim the next track', async () => {
        const { store } = memory();
        const service = new LastFmService({ webContents: {} } as BrowserView, store);
        disposables.push(service);
        await service.updateTrackInfo(track('A'));
        await vi.advanceTimersByTimeAsync(60000);
        await service.updateTrackInfo(track('A', '1:00'), false);
        await vi.advanceTimersByTimeAsync(3600000);
        await service.updateTrackInfo(track('B'));
        expect(scrobbles()).toHaveLength(0);
        let finish!: (value: unknown) => void;
        request.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        vi.advanceTimersByTime(120000);
        await service.updateTrackInfo(track('C'));
        finish({ ok: true, json: async () => ({}) });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(120000);
        expect(scrobbles()).toHaveLength(2);
    });
    it('subscribes to the Last.fm callback before starting navigation and cleans up', async () => {
        const { store, values } = memory();
        values.delete('lastFmSessionKey');
        const contents = Object.assign(new EventEmitter(), {
            getURL: () => 'https://soundcloud.com/discover',
            isDestroyed: () => false,
            loadURL: vi.fn(async (url: string) => {
                if (url.includes('last.fm'))
                    contents.emit('will-redirect', {}, 'https://soundcloud.com/discover?token=example');
            }),
        });
        request.mockResolvedValue({ json: async () => ({ session: { key: 'new-session' } }) });
        const service = new LastFmService({ webContents: contents } as unknown as BrowserView, store);
        disposables.push(service);
        await service.authenticate();
        await Promise.resolve();
        await Promise.resolve();
        expect(values.get('lastFmSessionKey')).toBe('new-session');
        expect(contents.listenerCount('will-redirect')).toBe(0);
    });
});
