import { describe, it, expect, vi } from 'vitest';
import { RecoveryPolicy } from './recoveryPolicy';
import { relayTarget, workerEndpoint } from './relayTargets';
describe('connection recovery', () => {
    it('does not reroute a healthy connection or interrupt active playback', async () => {
        const actions = {
            direct: vi.fn(async () => true),
            relay: vi.fn(async () => true),
            activate: vi.fn(async () => {}),
            playing: vi.fn(async () => false),
        };
        expect(await new RecoveryPolicy(actions).recover()).toBe('direct');
        expect(actions.relay).not.toHaveBeenCalled();
        actions.playing.mockResolvedValue(true);
        expect(await new RecoveryPolicy(actions).recover()).toBe('deferred');
        expect(actions.activate).not.toHaveBeenCalled();
    });
    it('switches only after successful relay probe, coalesces failures and cools down', async () => {
        let now = 1000;
        const actions = {
            direct: vi.fn(async () => false),
            relay: vi.fn(async () => false),
            activate: vi.fn(async () => {}),
            playing: vi.fn(async () => false),
        };
        const policy = new RecoveryPolicy(actions, () => now);
        expect(await Promise.all([policy.recover(), policy.recover()])).toEqual(['unavailable', 'unavailable']);
        expect(actions.relay).toHaveBeenCalledTimes(1);
        expect(await policy.recover()).toBe('cooldown');
        expect(actions.direct).toHaveBeenCalledTimes(1);
        now += 120001;
        actions.relay.mockResolvedValue(true);
        expect(await policy.recover()).toBe('relay');
        expect(actions.activate).toHaveBeenCalledTimes(1);
    });
    it('rechecks playback after network probes', async () => {
        const actions = {
            direct: async () => false,
            relay: async () => true,
            activate: vi.fn(async () => {}),
            playing: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        };
        expect(await new RecoveryPolicy(actions).recover()).toBe('deferred');
        expect(actions.activate).not.toHaveBeenCalled();
    });
    it('limits destinations and validates secret-free HTTPS endpoints', () => {
        for (const host of ['soundcloud.com', 'api-v2.soundcloud.com', 'cf-media.sndcdn.com'])
            expect(relayTarget(host)).toBe(true);
        for (const host of [
            '127.0.0.1',
            'soundcloud.com.evil.test',
            'evilsoundcloud.com',
            'localhost',
            'api..soundcloud.com',
        ])
            expect(relayTarget(host)).toBe(false);
        expect(workerEndpoint('https://example.workers.dev')).toBe('wss://example.workers.dev/tunnel');
        expect(workerEndpoint('https://example.workers.dev/tunnel')).toBe('wss://example.workers.dev/tunnel');
        for (const url of [
            'http://example.com',
            'https://user:key@example.com',
            'https://127.0.0.1',
            'https://example.com/?token=secret',
        ])
            expect(() => workerEndpoint(url)).toThrow();
    });
});
