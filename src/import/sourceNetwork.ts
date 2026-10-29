import { readTextLimited } from '../utils/readText';
import { fetchPublic } from './loadSource';
import { cancelImportOperation } from './parallel';
import type { SourceRequestInit } from './youtubePagination';

export function traceCountry(text: string): string | undefined {
    return text.match(/^loc=([A-Z]{2})\r?$/m)?.[1];
}
export class PlaylistSourceNetwork {
    private cached?: { country?: string; until: number };
    private pending?: Promise<string | undefined>;
    constructor(
        private request: typeof fetch,
        private now: () => number = Date.now,
        private defaultRequest: typeof fetch = request,
    ) {}
    load(url: string, signal?: AbortSignal, init?: SourceRequestInit): Promise<string> {
        const host = new URL(url).hostname;
        return fetchPublic(
            url,
            signal,
            init,
            host === 'music.yandex.ru' || host === 'api.music.yandex.ru' ? this.request : this.defaultRequest,
        );
    }
    country(signal?: AbortSignal): Promise<string | undefined> {
        signal?.throwIfAborted();
        if (this.cached && this.cached.until > this.now()) return Promise.resolve(this.cached.country);
        if (!this.pending) {
            const task = this.request('https://www.cloudflare.com/cdn-cgi/trace', {
                credentials: 'omit',
                redirect: 'error',
                signal: AbortSignal.timeout(1500),
            })
                .then(async (response) => {
                    if (!response.ok) {
                        void response.body?.cancel().catch(() => {});
                        return undefined;
                    }
                    return traceCountry(await readTextLimited(response, 8192));
                })
                .catch(() => undefined)
                .then((country) => {
                    this.cached = { country, until: this.now() + (country ? 5 * 60000 : 30000) };
                    return country;
                })
                .finally(() => {
                    if (this.pending === task) this.pending = undefined;
                });
            this.pending = task;
        }
        return signal ? cancelImportOperation(this.pending, signal) : this.pending;
    }
}
