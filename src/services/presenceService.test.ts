import { afterEach, describe, expect, it, vi } from 'vitest';
import type ElectronStore from 'electron-store';
import { PresenceService } from './presenceService';
import { TranslationService } from './translationService';
const rpc = vi.hoisted(() => ({
    isConnected: false,
    login: vi.fn(),
    destroy: vi.fn(async () => {}),
    user: { setActivity: vi.fn(async () => {}), clearActivity: vi.fn(async () => {}) },
}));
vi.mock('@xhayper/discord-rpc', () => ({
    Client: class {
        constructor() {
            return rpc;
        }
    },
}));
const track = (title: string) => ({
    title,
    author: 'Artist',
    artwork: '',
    elapsed: '0:00',
    duration: '3:00',
    isPlaying: true,
    isLiked: false,
    url: 'https://soundcloud.com/artist/track',
});
const makeStore = (enabled = true) =>
    ({
        get: (key: string, fallback?: unknown) => (key === 'discordRichPresence' ? enabled : fallback),
    }) as unknown as ElectronStore;
describe('Discord presence scheduling', () => {
    afterEach(() => {
        vi.clearAllMocks();
        rpc.isConnected = false;
    });
    it('coalesces login and publishes only the latest track after a delayed connection', async () => {
        let finish!: () => void;
        rpc.login.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finish = () => {
                        rpc.isConnected = true;
                        resolve();
                    };
                }),
        );
        const service = new PresenceService(makeStore(), new TranslationService());
        const old = service.updatePresence(track('Old track')),
            latest = service.updatePresence(track('Latest track'));
        expect(rpc.login).toHaveBeenCalledTimes(1);
        finish();
        await Promise.all([old, latest]);
        expect(rpc.user.setActivity).toHaveBeenCalledTimes(1);
        expect(rpc.user.setActivity).toHaveBeenCalledWith(expect.objectContaining({ details: 'Latest track' }));
        service.dispose();
    });
    it('does not attempt a connection when disabled, or spam retries while Discord is absent', async () => {
        rpc.login.mockRejectedValue(new Error('fixture offline'));
        const disabled = new PresenceService(makeStore(false), new TranslationService());
        expect(rpc.login).not.toHaveBeenCalled();
        disabled.dispose();
        const service = new PresenceService(makeStore(), new TranslationService());
        await service.updatePresence(track('One'));
        await service.updatePresence(track('Two'));
        await service.updatePresence(track('Three'));
        expect(rpc.login).toHaveBeenCalledTimes(1);
        expect(rpc.user.setActivity).not.toHaveBeenCalled();
        service.dispose();
    });
});
