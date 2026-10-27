import { describe, it, expect, vi } from 'vitest';
import { WorkerSetup } from './workerSetup';
const account = 'a'.repeat(32),
    token = 'test_api_token_'.repeat(3);
const modules = {
    entry: "import './protocol.mjs';",
    protocol: 'export const relay=true;',
    source: 'export const source=true;',
};
const response = (result: unknown, status = 200) =>
    new Response(JSON.stringify({ success: status < 400, result }), {
        status,
        headers: { 'content-type': 'application/json' },
    });
function fixture(
    options: {
        newAccount?: boolean;
        denied?: boolean;
        enableFails?: boolean;
    } = {},
) {
    const calls: {
        url: string;
        init: RequestInit;
    }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes('/accounts?')) return response([{ id: account, name: 'Personal' }]);
        if (url.endsWith('/workers/subdomain')) {
            if (init.method === 'PUT') return response({ subdomain: JSON.parse(String(init.body)).subdomain });
            return response(
                options.newAccount ? null : { subdomain: 'existing-user' },
                options.denied ? 403 : options.newAccount ? 404 : 200,
            );
        }
        if (url.endsWith('/subdomain')) return options.enableFails ? response(null, 503) : response({ enabled: true });
        return response({ id: 'uploaded' });
    });
    return { setup: new WorkerSetup(fetcher as typeof fetch), calls, options };
}
describe('Cloudflare Worker setup', () => {
    it('uploads all modules and a generated secret, preserves existing account domain and obtains an HTTPS endpoint', async () => {
        const { setup, calls } = fixture();
        try {
            expect(await setup.authorize(token)).toEqual([{ id: account, name: 'Personal' }]);
            const result = await setup.deploy(account, modules, () => {});
            expect(result.endpoint).toBe('https://' + result.name + '.existing-user.workers.dev');
            expect(result.secret).toMatch(/^[a-f0-9]{64}$/);
            expect(calls.some((call) => call.url.endsWith('/workers/subdomain') && call.init.method === 'PUT')).toBe(
                false,
            );
            const uploaded = calls.find((call) => call.init.body instanceof FormData)!;
            const form = uploaded.init.body as FormData;
            const metadata = JSON.parse(await (form.get('metadata') as Blob).text());
            expect(metadata.main_module).toBe('worker.mjs');
            expect(metadata.bindings).toEqual([{ name: 'RELAY_TOKEN', type: 'secret_text', text: result.secret }]);
            expect(await (form.get('worker.mjs') as Blob).text()).toBe(modules.entry);
            expect(await (form.get('protocol.mjs') as Blob).text()).toBe(modules.protocol);
            expect(await (form.get('playlist-source.mjs') as Blob).text()).toBe(modules.source);
            expect(
                calls.every(
                    (call) => call.url.startsWith('https://api.cloudflare.com/client/v4/') && !call.url.includes(token),
                ),
            ).toBe(true);
        } finally {
            setup.clear();
        }
    });
    it('updates the saved app Worker in its account without rotating its address or key', async () => {
        const { setup, calls } = fixture();
        try {
            await setup.authorize(token);
            const existing = {
                endpoint: 'https://soundcloud-wave-1234567890.existing-user.workers.dev',
                secret: 's'.repeat(64),
            };
            const result = await setup.deploy(account, modules, () => {}, existing);
            expect(result.endpoint).toBe(existing.endpoint);
            expect(result.secret).toBe(existing.secret);
            expect(result.updated).toBe(true);
            const form = calls.find((call) => call.init.body instanceof FormData)!.init.body as FormData;
            expect(JSON.parse(await (form.get('metadata') as Blob).text()).bindings[0].text).toBe(existing.secret);
        } finally {
            setup.clear();
        }
    });
    it('creates a subdomain only when missing and refuses inaccessible account IDs', async () => {
        const { setup, calls } = fixture({ newAccount: true });
        try {
            await setup.authorize(token);
            await expect(setup.deploy('b'.repeat(32), modules, () => {})).rejects.toThrow('Выберите');
            await setup.deploy(account, modules, () => {});
            expect(
                calls.filter((call) => call.url.endsWith('/workers/subdomain') && call.init.method === 'PUT'),
            ).toHaveLength(1);
        } finally {
            setup.clear();
        }
    });
    it('does not treat permission failures as a missing subdomain', async () => {
        const { setup, calls } = fixture({ denied: true });
        try {
            await setup.authorize(token);
            await expect(setup.deploy(account, modules, () => {})).rejects.toThrow('права');
            expect(calls.some((call) => call.init.method === 'PUT')).toBe(false);
        } finally {
            setup.clear();
        }
    });
    it('does not claim success on failed activation and reuses the same worker and key on retry', async () => {
        const state = fixture({ enableFails: true });
        try {
            await state.setup.authorize(token);
            await expect(state.setup.deploy(account, modules, () => {})).rejects.toThrow('HTTP 503');
            state.options.enableFails = false;
            await state.setup.deploy(account, modules, () => {});
            const uploads = state.calls.filter((call) => call.init.body instanceof FormData);
            expect(uploads).toHaveLength(2);
            expect(uploads[0].url).toBe(uploads[1].url);
            const keys = await Promise.all(
                uploads.map(
                    async (call) =>
                        JSON.parse(await ((call.init.body as FormData).get('metadata') as Blob).text()).bindings[0]
                            .text,
                ),
            );
            expect(keys[0]).toBe(keys[1]);
        } finally {
            state.setup.clear();
        }
    });
    it('forgets credentials and rejects a second deploy after clearing the setup session', async () => {
        const { setup, calls } = fixture();
        await setup.authorize(token);
        setup.clear();
        const count = calls.length;
        await expect(setup.deploy(account, modules, () => {})).rejects.toThrow();
        expect(calls).toHaveLength(count);
    });
});
