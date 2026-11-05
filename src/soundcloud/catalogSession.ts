import type { WebContents } from 'electron';
import { SoundCloudCatalog } from './catalog';
import type { WorkScheduler } from '../utils/workScheduler';

export function installSoundCloudCatalog(
    contents: WebContents,
    scheduler: WorkScheduler,
    route: () => string,
): SoundCloudCatalog {
    const session = contents.session;
    const catalog = new SoundCloudCatalog(session.fetch.bind(session) as typeof fetch, scheduler, route);
    session.webRequest.onSendHeaders(
        {
            urls: [
                'https://api-v2.soundcloud.com/*',
                'https://api.soundcloud.com/sign-out*',
                'https://api-auth.soundcloud.com/sign-out*',
            ],
        },
        (details) => {
            if (details.webContentsId !== contents.id || contents.isDestroyed()) return;
            try {
                if (new URL(contents.getURL()).origin !== 'https://soundcloud.com') return;
                if (new URL(details.url).pathname === '/sign-out') catalog.reset();
                else catalog.observe(details.url, details.requestHeaders);
            } catch {}
        },
    );
    session.webRequest.onResponseStarted({ urls: ['https://api-v2.soundcloud.com/*'] }, (details) => {
        if (details.webContentsId === contents.id && details.statusCode === 401) catalog.reset();
        if (
            details.webContentsId === contents.id &&
            details.statusCode >= 200 &&
            details.statusCode < 300 &&
            ['PUT', 'DELETE'].includes(details.method)
        ) {
            const match = new URL(details.url).pathname.match(/^\/users\/(\d+)\/track_likes\/(\d+)$/);
            if (match) catalog.observeLike(Number(match[1]), Number(match[2]), details.method === 'PUT');
        }
    });
    const cookiesChanged = (_event: unknown, cookie: Electron.Cookie) => {
        if (/(^|\.)soundcloud\.com$/.test(cookie.domain || '') && /oauth|auth|session/i.test(cookie.name))
            catalog.reset();
    };
    session.cookies.on('changed', cookiesChanged);
    contents.once('destroyed', () => {
        session.webRequest.onSendHeaders(null);
        session.webRequest.onResponseStarted(null);
        session.cookies.removeListener('changed', cookiesChanged);
        catalog.dispose();
    });
    return catalog;
}
