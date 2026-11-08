import { api, invoke, Profile } from './bridge';
import { Discovery } from './discovery';
import { SoundCloudRecommender } from '../../src/wave/recommendation/soundcloudAdapter';
import { defaultControls } from './wave';
import type { WaveControls } from '../../src/wave/waveEngine';
import type { WaveCandidate } from '../../src/wave/waveEngine';

export async function tasteAudit(): Promise<void> {
    const report: Record<string, unknown> = {
        readOnly: true,
        workerExcluded: true,
        startedAt: new Date().toISOString(),
    };
    let discovery: Discovery | undefined;
    try {
        const end = Date.now() + 45000;
        let diagnostics;
        do {
            diagnostics = await invoke<{ version?: string; catalog?: { authenticated?: boolean; revision?: number } }>(
                'native_diagnostics',
            );
            if (diagnostics.catalog?.authenticated) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        } while (Date.now() < end);
        if (!diagnostics.catalog?.authenticated) throw Error('Copied profile has no authenticated SoundCloud session');
        const owner = Number((await api('me')).id),
            revision = Number(diagnostics.catalog.revision);
        const profile = new Profile('wave-' + owner);
        await profile.load();
        discovery = new Discovery(owner, () => revision);
        const catalog = new Map<string, WaveCandidate>();
        const model = new SoundCloudRecommender(profile, String(owner), async (seeds) => {
            report.seedEndorsements = seeds.map(({ id }) => ({ id, liked: model.liked(id) === true }));
            report.seeds = seeds.map(({ id, apiId, title, artist, genre }) => ({ id, apiId, title, artist, genre }));
            const tracks = await discovery!.related(seeds);
            for (const track of tracks) catalog.set(track.url, track);
            return tracks;
        });
        const controls = { ...defaultControls, ...(profile.get('controls') as Partial<WaveControls>) };
        model.setControls(controls);
        const before = model.diagnostics();
        const initial = await discovery.initial();
        model.setLibrarySignals(initial.signals?.likedIds || [], initial.signals?.blockedIds || []);
        model.seedLikes(initial.likes);
        let ranked = await model.refresh();
        const rounds: object[] = [{ roots: model.discoveryRoots(), count: ranked.length }];
        report.libraryBefore = initial.signals;
        await discovery.syncLibrary((signals, likes) => {
            model.setLibrarySignals(signals.likedIds, signals.blockedIds);
            model.seedLikes(likes);
            model.addCandidates(likes);
        });
        for (let round = 0; round < 5 && Date.now() < end - 5000; round++) {
            ranked = await model.refresh();
            rounds.push({ roots: model.discoveryRoots(), count: ranked.length });
        }
        report.rounds = rounds;
        report.catalogSample = [...catalog.values()].slice(-600);
        report.controls = controls;
        report.version = diagnostics.version;
        report.before = before;
        report.after = model.diagnostics();
        report.candidates = ranked
            .slice(0, 10)
            .map(({ url, title, artist, genre, source, relatedTo, recommendationReasons }) => ({
                url,
                title,
                artist,
                genre,
                source,
                relatedTo,
                reasons: recommendationReasons,
            }));
        report.discovery = discovery.diagnostics();
        report.success = ranked.length > 0;
    } catch (error) {
        report.success = false;
        report.error = String(error);
    } finally {
        discovery?.dispose();
        report.finishedAt = new Date().toISOString();
        await invoke('account_result', { report, finished: true });
    }
}
