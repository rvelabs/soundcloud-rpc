export function relayTarget(host: string): boolean {
    const name = host.toLowerCase();
    return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:soundcloud\.com|sndcdn\.com)$/.test(name);
}
export function workerEndpoint(value: string): string {
    const url = new URL(value.trim());
    if (
        url.protocol !== 'https:' ||
        !['/', '/tunnel', '/tunnel/'].includes(url.pathname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.port ||
        !url.hostname.includes('.') ||
        /^\d+(?:\.\d+){3}$/.test(url.hostname) ||
        url.hostname.endsWith('.local')
    )
        throw new Error('Укажите HTTPS-адрес вашего Cloudflare Worker без ключа в ссылке.');
    url.pathname = url.pathname.replace(/(?:\/tunnel)?\/$|\/tunnel$/, '') + '/tunnel';
    url.protocol = 'wss:';
    return url.href;
}
