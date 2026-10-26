const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'),
    path = require('node:path');
const repo = process.env.WAVE_TEST_REPO || path.resolve(__dirname, '..');
const out = process.env.WAVE_TEST_OUTPUT || path.join(repo, 'build-host-audit');
const profile = path.join(out, 'host-audit-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady()
    .then(async () => {
        const { relayTarget } = require(path.join(repo, 'tsc/network/relayTargets'));
        const { networkErrorCode } = require(path.join(repo, 'tsc/network/relayDiagnostics'));
        const cases = [];
        const variants = process.env.WAVE_HOST_AUDIT_VARIANT
            ? [process.env.WAVE_HOST_AUDIT_VARIANT]
            : ['baseline', 'first-party-only'];
        for (const variant of variants) {
            const blockExternal = !['baseline', 'public-playback'].includes(variant);
            const target = session.fromPartition('host-audit-' + variant + '-' + Date.now());
            const hosts = new Map();
            const observe = (details) => {
                const host = new URL(details.url).hostname;
                let item = hosts.get(host);
                if (!item) {
                    item = { host, workerAllowed: relayTarget(host), requests: 0, types: new Set(), failures: [] };
                    hosts.set(host, item);
                }
                item.types.add(details.resourceType);
                if (
                    details.resourceType === 'media' ||
                    /\.(?:m3u8|mp3|aac|m4a)(?:\/|$)/i.test(new URL(details.url).pathname)
                )
                    item.media = true;
                return item;
            };
            target.webRequest.onBeforeRequest({ urls: ['https://*/*'] }, (details, callback) => {
                const item = observe(details);
                item.requests++;
                callback({ cancel: blockExternal && !item.workerAllowed });
            });
            target.webRequest.onCompleted({ urls: ['https://*/*'] }, (details) => {
                if (details.statusCode >= 400)
                    observe(details).failures.push({ type: details.resourceType, httpStatus: details.statusCode });
            });
            target.webRequest.onErrorOccurred({ urls: ['https://*/*'] }, (details) =>
                observe(details).failures.push({ type: details.resourceType, error: networkErrorCode(details.error) }),
            );
            const win = new BrowserWindow({
                show: false,
                webPreferences: { session: target, sandbox: true, backgroundThrottling: false },
            });
            win.webContents.setAudioMuted(true);
            win.webContents.setUserAgent(
                `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`,
            );
            let loadError, state;
            void win.webContents
                .loadURL(
                    variant.startsWith('public-playback')
                        ? 'https://soundcloud.com/forss/flickermood'
                        : 'https://soundcloud.com/discover',
                )
                .catch((error) => {
                    loadError = networkErrorCode(error);
                });
            const began = Date.now();
            for (let i = 0; i < 90; i++) {
                state = await Promise.race([
                    win.webContents
                        .executeJavaScript(
                            `({header:Boolean(document.querySelector('.header')),player:Boolean(document.querySelector('.playControls')),readyState:document.readyState,errorPage:/Sorry!?\\s*Something went wrong/i.test(document.body?.innerText||'')})`,
                        )
                        .catch(() => null),
                    wait(200).then(() => null),
                ]);
                if (state?.header && state?.player) {
                    await wait(2000);
                    break;
                }
                if (loadError) break;
                await wait(200);
            }
            let playback, selectedControl;
            if (variant.startsWith('public-playback') && state?.header) {
                selectedControl = await win.webContents.executeJavaScript(
                    `(()=>{const button=document.querySelector('.fullHero .sc-button-play,.soundTitle__playButton .playButton,.fullHero .playButton,.sc-button-play,.playButton');const result={selected:button?.className,available:[...document.querySelectorAll('[class*="playButton"],.sc-button-play')].slice(0,8).map(el=>el.className)};button?.click();return result;})()`,
                    true,
                );
                for (let i = 0; i < 70; i++) {
                    playback = await win.webContents
                        .executeJavaScript(
                            `({playing:Boolean(document.querySelector('.playControls__play.playing')),playerClass:document.querySelector('.playControls__play')?.className,elapsed:document.querySelector('.playbackTimeline__timePassed')?.innerText,audio:[...document.querySelectorAll('audio')].map(el=>({paused:el.paused,currentTime:el.currentTime,readyState:el.readyState,error:el.error?.code})),loginDialog:Boolean(document.querySelector('.loginModal,.signupModal'))})`,
                        )
                        .catch(() => null);
                    if (playback?.playing && [...hosts.values()].some((item) => item.media)) {
                        await wait(2500);
                        break;
                    }
                    await wait(200);
                }
            }
            const report = {
                variant,
                blockExternal,
                elapsedMs: Date.now() - began,
                state,
                loadError,
                playback,
                selectedControl,
                hosts: [...hosts.values()]
                    .map((item) => ({ ...item, types: [...item.types], failures: item.failures.slice(0, 8) }))
                    .sort((a, b) => a.host.localeCompare(b.host)),
            };
            cases.push(report);
            console.log(JSON.stringify(report));
            win.destroy();
        }
        fs.writeFileSync(
            path.join(out, 'soundcloud-hosts.json'),
            JSON.stringify({ anonymousProfiles: true, cases }, null, 2),
        );
        app.exit(
            cases.every(
                (item) =>
                    item.state?.header &&
                    item.state?.player &&
                    (!item.variant.startsWith('public-playback') || item.playback?.playing),
            )
                ? 0
                : 1,
        );
    })
    .catch((error) => {
        console.error(error.stack);
        app.exit(1);
    });
setTimeout(() => {
    console.error('Host audit deadline');
    app.exit(2);
}, 55000).unref();
