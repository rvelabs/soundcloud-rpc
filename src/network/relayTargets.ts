const relayPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:soundcloud\.com|sndcdn\.com)$/;
const playlistPattern =
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:spotify\.com|scdn\.co|spotifycdn\.com|spotifycdn\.net)$/;
export function playlistBrowserTarget(host: string): boolean {
    return playlistPattern.test(host.toLowerCase());
}
export function playlistBrowserPac(port: number): string {
    return makePac(port, playlistPattern);
}
export function relayTarget(host: string): boolean {
    const name = host.toLowerCase();
    return relayPattern.test(name);
}
export function relayPac(port: number): string {
    return makePac(port, relayPattern);
}
function makePac(port: number, pattern: RegExp): string {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port');
    const script =
        'function FindProxyForURL(url,host){return new RegExp(' +
        JSON.stringify(pattern.source) +
        ',"i").test(host)?"PROXY 127.0.0.1:' +
        port +
        '":"DIRECT";}';
    return 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(script).toString('base64');
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
