import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSoundCloud, describeRelayDiagnostic, networkErrorCode, type RelayDiagnostic } from './relayDiagnostics';
const html = '<script src="https://a-v2.sndcdn.com/assets/app.js"></script>';
afterEach(() => vi.useRealTimers());
describe('relay diagnosis at the failing stage', () => {
    it('allows each HTTPS stage its own budget, including a slow body', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn(async (url: RequestInfo | URL) => {
            await new Promise((resolve) => setTimeout(resolve, 8000));
            return String(url).includes('api-v2') ? new Response('', { status: 401 }) : new Response(html);
        });
        const probe = probeSoundCloud(fetcher as typeof fetch, { timeoutMs: 10000 });
        await vi.advanceTimersByTimeAsync(16000);
        expect((await probe).map((stage) => stage.outcome)).toEqual(['ok', 'ok']);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('recognizes the page across streamed chunks and accepts API auth-required without credentials', async () => {
        const encoder = new TextEncoder();
        const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.credentials).toBe('omit');
            if (fetcher.mock.calls.length === 2) return new Response('', { status: 401 });
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('<script src="https://a.snd'));
                        controller.enqueue(encoder.encode('cdn.com/app.js"></script>'));
                        controller.close();
                    },
                }),
            );
        });
        expect((await probeSoundCloud(fetcher as typeof fetch)).map((stage) => stage.outcome)).toEqual(['ok', 'ok']);
    });
    it('reports a failed partial transfer without labeling it a wrong key or copying response data', async () => {
        let reads = 0;
        const secret = 'PRIVATE_RESPONSE_DATA';
        const fetcher = vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        pull(controller) {
                            if (reads++ === 0)
                                controller.enqueue(new TextEncoder().encode(html + secret + 'x'.repeat(16000)));
                            else controller.error(new Error('net::ERR_CONNECTION_RESET at ' + secret));
                        },
                    }),
                ),
        );
        const stages = await probeSoundCloud(fetcher as typeof fetch);
        expect(stages).toHaveLength(1);
        expect(stages[0]).toMatchObject({ outcome: 'network', networkCode: 'ERR_CONNECTION_RESET' });
        expect(stages[0].bytesRead).toBeGreaterThan(16000);
        expect(JSON.stringify(stages)).not.toContain(secret);
    });
    it('terminates a request that never settles and propagates a caller cancellation', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
            signal = init?.signal as AbortSignal;
            return new Promise<Response>(() => {});
        });
        const pending = probeSoundCloud(fetcher as typeof fetch, { timeoutMs: 1000 });
        await vi.advanceTimersByTimeAsync(1000);
        expect((await pending)[0].outcome).toBe('timeout');
        expect(signal?.aborted).toBe(true);
        const controller = new AbortController();
        const canceled = probeSoundCloud(fetcher as typeof fetch, { signal: controller.signal });
        controller.abort();
        expect((await canceled)[0].outcome).toBe('cancelled');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('separates site and API HTTP refusals from an unrelated HTML challenge', async () => {
        expect(
            (await probeSoundCloud(vi.fn(async () => new Response('', { status: 451 })) as typeof fetch))[0],
        ).toMatchObject({ stage: 'website', outcome: 'http', httpStatus: 451 });
        expect(
            (await probeSoundCloud(vi.fn(async () => new Response('<h1>Access check</h1>')) as typeof fetch))[0]
                .outcome,
        ).toBe('unexpected-page');
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response(html))
            .mockResolvedValueOnce(new Response('', { status: 403 }));
        expect((await probeSoundCloud(fetcher as typeof fetch))[1]).toMatchObject({
            stage: 'api',
            outcome: 'http',
            httpStatus: 403,
        });
    });
    it('distinguishes Worker authentication, network and upstream failures with safe error codes', () => {
        const report: RelayDiagnostic = {
            checkedAt: '',
            endpointHost: 'test.workers.dev',
            success: false,
            elapsedMs: 0,
            stages: [{ stage: 'website', outcome: 'network', elapsedMs: 0, bytesRead: 0 }],
            tunnels: [
                {
                    id: 1,
                    host: 'soundcloud.com',
                    opened: false,
                    sentBytes: 0,
                    receivedBytes: 0,
                    elapsedMs: 0,
                    failure: 'http',
                    httpStatus: 401,
                },
            ],
        };
        expect(describeRelayDiagnostic(report)).toContain('отклонил ключ');
        report.tunnels[0].httpStatus = 502;
        expect(describeRelayDiagnostic(report)).toContain('HTTP 502');
        report.tunnels[0] = {
            ...report.tunnels[0],
            failure: 'network',
            httpStatus: undefined,
            networkCode: 'ENOTFOUND',
        };
        expect(describeRelayDiagnostic(report)).toContain('DNS');
        report.tunnels[0] = { ...report.tunnels[0], networkCode: undefined, opened: true, receivedBytes: 16384 };
        expect(describeRelayDiagnostic(report)).toContain('загрузка страницы');
        expect(networkErrorCode(new Error('request with Bearer TOP_SECRET: net::ERR_CONNECTION_RESET'))).toBe(
            'ERR_CONNECTION_RESET',
        );
        expect(networkErrorCode(new Error('Bearer TOP_SECRET'))).toBeUndefined();
    });
});
