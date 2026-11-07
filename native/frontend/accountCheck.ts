import { api, invoke } from './bridge';
import { nativeRuntimeExports } from '../../src/soundcloud/nativeRuntime';
import { classifyTrackAvailability } from '../../src/import/availability';
import { nativeLayout } from './styles';
import { normalizeEqualizer, equalizerPresets } from '../../src/audio/equalizerSettings';
import type { Wave } from './wave';
import type { Importer } from './importer';
import { cleanupCreatedPlaylist, createdPlaylistIds } from './playlists';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ensure = (value: unknown, message: string) => {
    if (!value) throw Error(message);
};
async function until(test: () => boolean | Promise<boolean>, timeout = 12000): Promise<void> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await test()) return;
        await wait(250);
    }
    throw Error('Condition timeout (' + timeout + ' ms)');
}
function methods(value: object): string[] {
    const keys = new Set<string>();
    for (let level = 0; value && level < 5; level++, value = Object.getPrototypeOf(value))
        for (const key of Object.getOwnPropertyNames(value)) {
            try {
                if (typeof (value as any)[key] === 'function') keys.add(key);
            } catch {}
        }
    return [...keys].sort();
}

export async function accountCheck(wave: Wave, importer: Importer): Promise<void> {
    const report: any = {
        startedAt: new Date().toISOString(),
        workerExcluded: true,
        isolatedPreferences: true,
        checks: [],
        transitions: [],
    };
    const save = (finished = false) => invoke('account_result', { report, finished });
    const check = async (name: string, task: () => Promise<unknown>) => {
        const started = performance.now();
        report.stage = name;
        await save();
        try {
            report.checks.push({
                name,
                success: true,
                result: await task(),
                elapsedMs: Math.round(performance.now() - started),
            });
        } catch (error) {
            report.checks.push({
                name,
                success: false,
                error: String(error),
                elapsedMs: Math.round(performance.now() - started),
            });
        }
        await save();
    };
    let cleanupId = 0;
    let restoreLike: (() => Promise<void>) | undefined;
    const capture = new Set<HTMLMediaElement>();
    const originalPlay = HTMLMediaElement.prototype.play;
    const volumes = new Map<HTMLMediaElement, number>();
    HTMLMediaElement.prototype.play = function () {
        capture.add(this);
        if (!volumes.has(this)) volumes.set(this, this.volume);
        this.volume = 0.04;
        return originalPlay.call(this);
    };
    const page = window as any;
    const eqBefore = page.__soundcloudEqualizer?.snapshot();
    let rawLikes: any[] = [];
    try {
        await until(
            async () => (await invoke<any>('native_diagnostics')).catalog?.authenticated === true && wave.monitorReady,
            45000,
        );
        const user = await api('me');
        ensure(Number.isSafeInteger(user.id), 'Authenticated /me response');
        report.authenticated = true;
        await check('real-page-layout', async () => {
            const layout = nativeLayout();
            ensure(layout.success, 'Styles/geometry');
            return layout;
        });
        await check('library-and-hydration', async () => {
            const likes = await api('likes', { owner: user.id });
            rawLikes = (likes.collection || []).map((item: any) => item.track || item);
            ensure(rawLikes.length > 0, 'No liked tracks available');
            const hydrated = await api<any[]>('tracks', { ids: rawLikes.slice(0, 3).map((item) => item.id) });
            return {
                likes: rawLikes.length,
                hydrated: hydrated.length,
                playable: hydrated.filter((t) => classifyTrackAvailability(t).status === 'available').length,
            };
        });
        for (const path of [
            '/me/track_likes/ids',
            '/me/mutings/users/ids',
            '/me/play-history/tracks',
            '/me/playlist_likes/ids',
            '/mixed-selections',
            '/stream',
        ])
            await check('api:' + path, async () => {
                const value = await api('radio', { path, params: { limit: '20' } });
                return {
                    shape: Array.isArray(value) ? 'array' : typeof value,
                    items: value.collection?.length ?? value.length ?? null,
                    sampleKeys: Object.keys(value.collection?.[0] || {}).slice(0, 20),
                };
            });
        await check('wave-start-and-real-queue', async () => {
            await wave.start();
            await until(() => Boolean(wave.ready().track?.isPlaying), 20000);
            await until(() => wave.diagnostics().queued >= 2, 20000);
            const manager = nativeRuntimeExports().find(
                (v: any) => typeof v?.getCurrentSound === 'function' && typeof v?.getQueue === 'function',
            ) as any;
            report.sdk = { manager: methods(manager), sound: methods(manager.getCurrentSound()), media: capture.size };
            return { active: wave.active, queued: wave.diagnostics().queued, monitor: wave.monitorReady };
        });
        if (wave.ready().track?.isPlaying) {
            await check('discord-listening-acknowledged', async () => {
                await until(async () => (await invoke<any>('native_diagnostics')).discord?.active === true, 25000);
                const discord = (await invoke<any>('native_diagnostics')).discord;
                ensure(discord.lastType === 2, 'Discord must confirm Listening activity');
                return discord;
            });
            await check('pause-is-preserved-and-discord-clears', async () => {
                wave.control('toggle');
                await until(() => wave.ready().track?.isPlaying === false);
                await wait(4000);
                ensure(!wave.ready().track?.isPlaying, 'Background tick resumed a manual pause');
                await until(async () => (await invoke<any>('native_diagnostics')).discord?.active === false);
                wave.control('toggle');
                await until(() => wave.ready().track?.isPlaying === true);
                return { manualPause: true, resume: true };
            });
            await check('like-and-restore', async () => {
                const before = wave.ready().track!;
                const Likes = nativeRuntimeExports().find(
                    (value: any) => value?.prototype?.readEndpoint === 'soundLikesIds',
                ) as any;
                const likes = Likes?.instances?.find(() => true);
                const sync = async () => {
                    await wait(700);
                    if (typeof likes?.fetch === 'function') await Promise.resolve(likes.fetch());
                };
                const restore = async () => {
                    if (wave.ready().track?.url === before.url && wave.ready().track?.isLiked !== before.isLiked) {
                        wave.control('like');
                        await until(() => wave.ready().track?.isLiked === before.isLiked);
                        await sync();
                        ensure(wave.ready().track?.isLiked === before.isLiked, 'Server did not confirm restored like');
                    }
                };
                restoreLike = restore;
                wave.control('like');
                await until(() => wave.ready().track?.isLiked !== before.isLiked);
                await sync();
                ensure(wave.ready().track?.isLiked !== before.isLiked, 'Server did not confirm changed like');
                await restore();
                restoreLike = undefined;
                return { toggle: true, restored: true, serverRefresh: typeof likes?.fetch === 'function' };
            });
            await check('navigation-keeps-playback', async () => {
                const exports = nativeRuntimeExports() as any[];
                const history = exports
                    .map((value) => value?.history)
                    .filter((value) => value && typeof value.navigate === 'function')
                    .sort((a, b) => (b.handlers?.length || 0) - (a.handlers?.length || 0))[0];
                ensure(history, 'SoundCloud navigation module unavailable');
                const before = wave.ready().track!.url;
                history.navigate('you/likes', { trigger: true });
                try {
                    await wait(2500);
                    report.navigation = {
                        path: location.pathname,
                        sameTrack: wave.ready().track?.url === before,
                        playing: wave.ready().track?.isPlaying,
                        handlers: history.handlers?.length,
                    };
                    ensure(
                        location.pathname.startsWith('/you/'),
                        'Router did not navigate to Library: ' + location.pathname,
                    );
                    ensure(
                        report.navigation.sameTrack && report.navigation.playing,
                        'Navigation interrupted playback: ' + JSON.stringify(report.navigation),
                    );
                } finally {
                    history.navigate('', { trigger: true });
                    await wait(2500);
                }
                ensure(wave.ready().track?.isPlaying, 'Return to Home interrupted playback');
                return { continuous: true, path: report.navigation.path };
            });
            await check('equalizer-live-audio', async () => {
                const preset = equalizerPresets.find((p) => p.id !== 'flat')!;
                page.__soundcloudEqualizer.set(
                    normalizeEqualizer({ enabled: true, preset: preset.id, gains: preset.gains, preamp: -6 }),
                );
                await until(() => page.__soundcloudEqualizer.snapshot().status === 'active', 10000);
                const snapshot = page.__soundcloudEqualizer.snapshot();
                page.__soundcloudEqualizer.set(normalizeEqualizer(undefined));
                return snapshot;
            });
            await check('volume-and-media-seek', async () => {
                const media = [...capture].find((m) => !m.paused && Number.isFinite(m.duration) && m.duration > 0);
                ensure(media, 'Actual SoundCloud media element was not captured');
                media!.volume = 0.08;
                await wait(300);
                ensure(Math.abs(media!.volume - 0.08) < 0.005, 'Volume not applied');
                media!.volume = 0.04;
                media!.currentTime = Math.min(20, media!.duration / 3);
                await wait(1500);
                return { volume: media!.volume, time: media!.currentTime, nativeElapsed: wave.ready().track?.elapsed };
            });
            await check('four-consecutive-background-endings', async () => {
                for (let transition = 0; transition < 4; transition++) {
                    await until(() => wave.diagnostics().queued >= 2, 25000);
                    const current = wave.ready().track!;
                    const media = [...capture].find((m) => !m.paused && Number.isFinite(m.duration) && m.duration > 10);
                    ensure(media, 'Playing media missing');
                    const startedAt = performance.now();
                    if (
                        !page.__SC_NATIVE_CHECK_QUICK &&
                        transition === 0 &&
                        media!.duration - media!.currentTime <= 150
                    ) {
                        await until(
                            () => Boolean(wave.ready().track?.isPlaying && wave.ready().track?.url !== current.url),
                            (media!.duration + 25) * 1000,
                        );
                        report.transitions.push({
                            kind: 'full-natural-remainder',
                            elapsedMs: Math.round(performance.now() - startedAt),
                        });
                    } else {
                        media!.currentTime = media!.duration - 5;
                        await until(
                            () => Boolean(wave.ready().track?.isPlaying && wave.ready().track?.url !== current.url),
                            30000,
                        );
                        report.transitions.push({
                            kind: 'real-end-after-seek',
                            elapsedMs: Math.round(performance.now() - startedAt),
                        });
                    }
                    await save();
                    await wait(2000);
                }
                return { transitions: report.transitions.length, queued: wave.diagnostics().queued };
            });
        }
        await check('partial-import-and-private-playlist', async () => {
            const originals = rawLikes
                .filter((track) => classifyTrackAvailability(track).status === 'available')
                .slice(0, 2);
            ensure(originals.length === 2, 'Need two available source tracks');
            const source = {
                platform: 'file',
                title: 'Native diagnostic ' + new Date().toISOString(),
                partial: false,
                tracks: [
                    ...originals.map((raw) => ({
                        title: raw.title,
                        artist: raw.publisher_metadata?.artist || raw.user?.username || '',
                        durationSeconds: raw.duration / 1000,
                    })),
                    { title: 'nonexistent-' + crypto.randomUUID(), artist: 'native-diagnostic-unmatched' },
                ],
            };
            const found = await (importer as any).scanSource(source);
            const indexes = found.matches.flatMap((m: any, i: number) => (m.soundcloud ? [i] : []));
            ensure(indexes.length > 0 && indexes.length < source.tracks.length, 'Expected partial real matching');
            const result = await importer.commit({ indexes, title: source.title });
            cleanupId = result.playlistId;
            const persisted = await api('playlist', { id: cleanupId });
            const playlist = persisted.playlist || persisted;
            ensure(playlist.user?.id === user.id || playlist.user_id === user.id, 'Created playlist owner');
            ensure(
                playlist.tracks?.length === result.added && playlist.sharing === 'private',
                'Private playlist tracks not saved',
            );
            await cleanupCreatedPlaylist(cleanupId);
            cleanupId = 0;
            return { matched: indexes.length, requested: source.tracks.length, added: result.added, removed: true };
        });
        await check('settings-queue-refresh', async () => {
            const before = { ...wave.controls };
            await wave.settings({ ...before, discovery: 'new' });
            ensure(wave.controls.discovery === 'new', 'Control update not applied');
            await wave.settings(before);
            return { restored: true, diagnostics: wave.diagnostics().discovery };
        });
        await check('ordinary-playback-discord', async () => {
            wave.stop();
            if (wave.ready().track?.isPlaying) wave.control('toggle');
            await until(() => wave.ready().track?.isPlaying === false);
            await until(async () => (await invoke<any>('native_diagnostics')).discord?.active === false);
            wave.control('toggle');
            await until(async () => (await invoke<any>('native_diagnostics')).discord?.active === true);
            ensure(!wave.active, 'Wave unexpectedly resumed');
            return { ordinaryPlayback: true, discord: true };
        });
    } catch (error) {
        report.fatal = String(error);
    } finally {
        try {
            await restoreLike?.();
        } catch (error) {
            report.likeRestoreError = String(error);
        }
        if (cleanupId) {
            try {
                await cleanupCreatedPlaylist(cleanupId);
                cleanupId = 0;
            } catch (error) {
                report.cleanupError = { playlistId: cleanupId, error: String(error) };
            }
        }
        for (const id of createdPlaylistIds()) {
            try {
                await cleanupCreatedPlaylist(id);
            } catch (error) {
                report.cleanupError = { playlistId: id, error: String(error) };
            }
        }
        if (wave.ready().track?.isPlaying) wave.control('toggle');
        wave.stop();
        HTMLMediaElement.prototype.play = originalPlay;
        for (const [media, volume] of volumes) media.volume = volume;
        if (eqBefore) page.__soundcloudEqualizer.set(normalizeEqualizer(undefined));
        report.wave = wave.diagnostics();
        report.host = await invoke('native_diagnostics');
        report.success =
            !report.fatal &&
            !report.cleanupError &&
            !report.likeRestoreError &&
            report.checks.every((c: any) => c.success);
        report.finishedAt = new Date().toISOString();
        await save(true);
    }
}
