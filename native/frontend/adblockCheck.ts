import { invoke } from './bridge';

export async function checkAdblock(): Promise<string[]> {
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    const result = new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(Error('WebView2 ad blocking fixture timed out'));
        }, 8000);
        const receive = (event: MessageEvent) => {
            if (
                event.source !== iframe.contentWindow ||
                event.origin !== 'https://soundcloud.com' ||
                event.data?.type !== 'native-adblock-fixture'
            )
                return;
            cleanup();
            if (!event.data.success) reject(Error(String(event.data.error)));
            else resolve(event.data.checks);
        };
        function cleanup() {
            clearTimeout(timer);
            window.removeEventListener('message', receive);
        }
        window.addEventListener('message', receive);
    });
    try {
        iframe.src = 'https://soundcloud.com/__native_adblock_fixture';
        document.body.append(iframe);
        const checks = await result;
        const state = await invoke<{ adblock: { attached: boolean; blocked: number; rules: number } }>(
            'native_diagnostics',
        );
        if (!state.adblock.attached || state.adblock.blocked < 3 || state.adblock.rules < 1000)
            throw Error('Native request filtering was not applied');
        return checks.map((name) => 'adblock-' + name);
    } finally {
        iframe.remove();
    }
}
