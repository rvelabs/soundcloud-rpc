import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSoundCloud, describeRelayDiagnostic, networkErrorCode, type RelayDiagnostic } from './relayDiagnostics';
const html = '<script src="https://a-v2.sndcdn.com/assets/app.js"></script>';
afterEach(() => vi.useRealTimers());
describe('relay diagnosis at the failing stage', () => {
    it('allows each HTTPS stage its own budget, including a slow body', async () => {
        vi.useFakeTimers();
        const started: Record<string, number> = {};
        const fetcher = vi.fn(async (url: RequestInfo | URL) => {
            started[String(url)] = Date.now();
            await new Promise((resolve) => setTimeout(resolve, 8000));
            return String(url).includes('api-')
                ? new Response('', { status: 401 })
                : String(url).includes('sndcdn')
                  ? new Response('globalThis.ready=true;')
                  : new Response(html);
        });
        const probe = probeSoundCloud(fetcher as typeof fetch, { timeoutMs: 10000 });
        await vi.advanceTimersByTimeAsync(24000);
        expect((await probe).map((stage) => stage.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
        expect(started['https://api-v2.soundcloud.com/']).toBe(started['https://api-auth.soundcloud.com/']);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('recognizes the page across streamed chunks and accepts API auth-required without credentials', async () => {
        const encoder = new TextEncoder();
        const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.credentials).toBe('omit');
            if (String(url).includes('api-')) return new Response('', { status: 401 });
            if (String(url).includes('sndcdn')) return new Response('globalThis.ready=true;');
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('<script src="https://a.snd'));
                        controller.enqueue(encoder.encode('cdn.com/assets/app.js"></script>'));
                        controller.close();
                    },
                }),
            );
        });
        expect((await probeSoundCloud(fetcher as typeof fetch)).map((stage) => stage.outcome)).toEqual([
            'ok',
            'ok',
            'ok',
            'ok',
        ]);
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
            .mockResolvedValueOnce(new Response('globalThis.ready=true;'))
            .mockResolvedValueOnce(new Response('', { status: 403 }));
        expect((await probeSoundCloud(fetcher as typeof fetch))[2]).toMatchObject({
            stage: 'api',
            outcome: 'http',
            httpStatus: 403,
        });
    });
    it('rejects a healthy HTML response when the interface CDN is blocked or returns a challenge', async () => {
        for (const asset of [
            () => new Response('', { status: 403 }),
            () => new Response('<html>Access check</html>', { headers: { 'content-type': 'text/html' } }),
            () => {
                throw Error('net::ERR_CONNECTION_CLOSED');
            },
        ]) {
            const fetcher = vi.fn(async (url: RequestInfo | URL) =>
                String(url).includes('sndcdn') ? asset() : new Response(html),
            );
            const stages = await probeSoundCloud(fetcher as typeof fetch);
            expect(stages.map((stage) => stage.stage)).toEqual(['website', 'assets']);
            expect(stages[0].outcome).toBe('ok');
            expect(stages[1].outcome).not.toBe('ok');
            expect(stages[1].host).toBe('a-v2.sndcdn.com');
            expect(fetcher).toHaveBeenCalledTimes(2);
        }
    });
    it('samples bounded first-party bootstrap assets without following third-party script references', async () => {
        const page =
            html +
            '<script src="https://untrusted.example/assets/track.js"></script><script src="https://a-v2.sndcdn.com/assets/last.js"></script>';
        const fetcher = vi.fn(async (url: RequestInfo | URL) =>
            String(url).includes('api-')
                ? new Response('', { status: 401 })
                : String(url).includes('sndcdn')
                  ? new Response('x'.repeat(200000))
                  : new Response(page),
        );
        const stages = await probeSoundCloud(fetcher as typeof fetch);
        expect(stages.map((stage) => stage.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
        expect(fetcher.mock.calls.map((args) => String(args[0]))).toEqual([
            'https://soundcloud.com/discover',
            'https://a-v2.sndcdn.com/assets/app.js',
            'https://a-v2.sndcdn.com/assets/last.js',
            'https://api-v2.soundcloud.com/',
            'https://api-auth.soundcloud.com/',
        ]);
    });
    it('checks CSS outside the asset directory and identifies an unavailable authentication service', async () => {
        let cssBlocked = true;
        const fetcher = vi.fn(async (url: RequestInfo | URL) => {
            const host = new URL(String(url)).hostname;
            if (host === 'soundcloud.com')
                return new Response(html + '<link href="https://style.sndcdn.com/css/app.css" rel="stylesheet">');
            if (host === 'style.sndcdn.com') return new Response('body{}', { status: cssBlocked ? 503 : 200 });
            if (host === 'api-auth.soundcloud.com') return new Response('', { status: cssBlocked ? 405 : 503 });
            if (host === 'api-v2.soundcloud.com') return new Response('', { status: 401 });
            return new Response('globalThis.ready=true;');
        });
        const css = await probeSoundCloud(fetcher as typeof fetch);
        expect(css[css.length - 1]).toMatchObject({
            stage: 'assets',
            host: 'style.sndcdn.com',
            outcome: 'http',
            httpStatus: 503,
        });
        cssBlocked = false;
        const auth = await probeSoundCloud(fetcher as typeof fetch);
        expect(auth[auth.length - 1]).toMatchObject({
            stage: 'auth',
            host: 'api-auth.soundcloud.com',
            outcome: 'http',
            httpStatus: 503,
        });
    });
    it('accepts method-required on the unauthenticated auth endpoint', async () => {
        const fetcher = vi.fn(async (url: RequestInfo | URL) =>
            String(url).includes('api-auth')
                ? new Response('', { status: 405 })
                : String(url).includes('api-v2')
                  ? new Response('', { status: 401 })
                  : String(url).includes('sndcdn')
                    ? new Response('globalThis.ready=true;')
                    : new Response(html),
        );
        expect((await probeSoundCloud(fetcher as typeof fetch)).map((stage) => stage.outcome)).toEqual([
            'ok',
            'ok',
            'ok',
            'ok',
        ]);
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
