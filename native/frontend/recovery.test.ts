import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ invoke: vi.fn(), player: vi.fn(), playlistModels: [] as unknown[] }));
vi.mock('../../src/soundcloud/nativeRuntime', () => ({ nativeRuntimeExports: () => host.playlistModels }));
vi.mock('../../src/soundcloud/nativePlayerBridge', () => ({
    nativeAutoplay: () => null,
    installNativePlayerMonitor: () => null,
    nativePlayerCommand: host.player,
}));
import { Wave } from './wave';
import { Profile } from './bridge';
import { Importer } from './importer';
import { net } from './platform';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
const turn = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
};
beforeEach(() => {
    host.invoke.mockReset();
    host.player.mockReset();
    host.playlistModels = [];
    const page: any = new EventTarget();
    page.__TAURI_INTERNALS__ = { invoke: host.invoke };
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', new EventTarget());
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function playingWave(): any {
    const wave: any = new Wave();
    wave.disposeMonitor = () => {};
    wave.active = true;
    wave.owner = 7;
    wave.catalogRevision = 1;
    wave.recommender = {};
    wave.refill = async () => {};
    wave.enrich = () => {};
    wave.canAdvance = () => true;
    return wave;
}

it('retains the session on credential renewal and stops on a genuine account change', async () => {
    let owner = 7;
    host.invoke.mockImplementation(async (command: string) =>
        command === 'native_diagnostics'
            ? { catalog: { revision: 2 } }
            : command === 'catalog_request'
              ? { id: owner }
              : null,
    );
    const wave = playingWave();
    await wave.tick();
    expect(wave.active).toBe(true);
    expect(wave.owner).toBe(7);
    expect(wave.catalogRevision).toBe(2);
    owner = 8;
    wave.catalogRevision = 1;
    await wave.tick();
    expect(wave.active).toBe(false);
    expect(wave.owner).toBe(0);
});

it('retries an unconfirmed terminal transition with backoff, caps retries and honours manual pause', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    host.invoke.mockResolvedValue({ catalog: { revision: 1 } });
    host.player.mockReturnValue('uncertain');
    const wave = playingWave();
    wave.current = { url: 'https://soundcloud.com/a/one', elapsed: '3:00', duration: '3:00', isPlaying: false };
    wave.queued.add('https://soundcloud.com/b/two');
    await wave.tick();
    await wave.tick();
    expect(host.player).toHaveBeenCalledTimes(1);
    vi.setSystemTime(104001);
    await wave.tick();
    expect(host.player).toHaveBeenCalledTimes(2);
    wave.manualPause = true;
    vi.setSystemTime(120000);
    await wave.tick();
    expect(host.player).toHaveBeenCalledTimes(2);
    wave.manualPause = false;
    await wave.tick();
    vi.setSystemTime(200000);
    await wave.tick();
    expect(host.player).toHaveBeenCalledTimes(3);
});

it('all flush callers wait for newer revisions and durable callers request the disk barrier', async () => {
    const first = deferred<unknown>(),
        second = deferred<unknown>();
    let saves = 0;
    host.invoke.mockImplementation((command: string) =>
        command === 'profile_save' ? (++saves === 1 ? first.promise : second.promise) : Promise.resolve(null),
    );
    const profile = new Profile('settings');
    profile.set('v', 1);
    const a = profile.flush();
    await turn();
    profile.set('v', 2);
    let done = false;
    const b = profile.flush(true).then(() => {
        done = true;
    });
    first.resolve(null);
    await turn();
    expect(saves).toBe(2);
    expect(done).toBe(false);
    second.resolve(null);
    await Promise.all([a, b]);
    expect(host.invoke).toHaveBeenCalledWith('profile_flush', { key: 'settings' });
});

it('aborts immediately and cancels the matching native source request', async () => {
    const pending = deferred<unknown>();
    host.invoke.mockImplementation((command: string) =>
        command === 'source_request' ? pending.promise : Promise.resolve(null),
    );
    const controller = new AbortController();
    const result = net.fetch('https://open.spotify.com/album/example', { signal: controller.signal });
    const checked = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await checked;
    const request = host.invoke.mock.calls.find(([command]) => command === 'source_request')![1];
    expect(host.invoke).toHaveBeenCalledWith('source_cancel', { id: request.id });
    pending.resolve({ status: 200, text: 'late' });
    await turn();
});

const raw = (id = 11) => ({
    id,
    title: 'Track',
    permalink_url: `https://soundcloud.com/a/track-${id}`,
    streamable: true,
    state: 'finished',
    policy: 'ALLOW',
    duration: 180000,
    media: { transcodings: [{ format: { protocol: 'hls' }, snipped: false }] },
});
function draft() {
    const track = raw();
    return {
        id: 'fixture',
        source: { platform: 'file', title: 'Imported', tracks: [{ artist: 'A', title: 'Track' }], partial: false },
        title: 'Imported',
        partial: false,
        savedUrls: [],
        matches: [
            {
                source: { artist: 'A', title: 'Track' },
                soundcloud: { apiId: 11, url: track.permalink_url, title: 'Track', artist: 'A', score: 1 },
            },
        ],
    };
}
function backend(saved: any = draft()) {
    const state = {
        owner: 7,
        created: 0,
        updated: 0,
        failAfterCreate: false,
        failAfterUpdate: false,
        failFlush: false,
        createFailure: undefined as Error | undefined,
        updateFailure: undefined as Error | undefined,
        playlist: undefined as any,
        draft: structuredClone(saved),
    };
    host.invoke.mockImplementation(async (command: string, args: any) => {
        if (command === 'profile_load') return { draft: structuredClone(state.draft) };
        if (command === 'profile_save') {
            if (args.key !== 'import-' + state.owner) throw Error('Profile belongs to another SoundCloud account');
            state.draft = structuredClone(args.value.draft);
            return null;
        }
        if (command === 'profile_flush') {
            if (state.failFlush) throw Error('Disk full');
            return null;
        }
        if (command !== 'catalog_request') return null;
        const request = args.request;
        if (request.operation === 'me') return { id: state.owner };
        if (request.operation === 'tracks') return request.ids.map(raw);
        if (request.operation === 'radio') return { collection: state.playlist ? [state.playlist] : [] };
        if (request.operation === 'playlist') return structuredClone(state.playlist);
        if (request.operation === 'createPlaylist') {
            expect(args.expectedOwner).toBe(state.owner);
            if (state.createFailure) throw state.createFailure;
            state.created++;
            state.playlist = {
                id: 99,
                title: request.title,
                created_at: new Date().toISOString(),
                sharing: 'private',
                user: { id: state.owner },
                tracks: request.tracks.map(raw),
            };
            if (state.failAfterCreate) throw Error('SoundCloud network request failed');
            return structuredClone(state.playlist);
        }
        if (request.operation === 'updatePlaylist') {
            expect(args.expectedOwner).toBe(state.owner);
            if (state.updateFailure) throw state.updateFailure;
            state.updated++;
            state.playlist = { ...state.playlist, title: request.title, tracks: request.tracks.map(raw) };
            if (state.failAfterUpdate) {
                state.failAfterUpdate = false;
                throw Error('Update response was lost');
            }
            return structuredClone(state.playlist);
        }
        throw Error('Unexpected request ' + request.operation);
    });
    return state;
}

it('does not write under an account different from the draft owner', async () => {
    const state = backend();
    const importer = new Importer();
    await importer.draft();
    state.owner = 8;
    await expect(importer.commit({ indexes: [0], title: 'Imported' })).rejects.toThrow('account changed');
    expect(state.created).toBe(0);
});

it('repeated and overlapping commits reuse the confirmed playlist', async () => {
    const state = backend();
    const importer = new Importer();
    await importer.draft();
    await Promise.all([
        importer.commit({ indexes: [0], title: 'Imported' }),
        importer.commit({ indexes: [0], title: 'Imported' }),
    ]);
    const result = await importer.commit({ indexes: [0], title: 'Imported' });
    expect(state.created).toBe(1);
    expect(state.updated).toBe(0);
    expect(result.already).toBe(1);
    expect(result.added).toBe(0);
    expect(state.draft.writtenPlaylistId).toBe(99);
    expect(state.draft.writtenTitle).toBe('Imported');
});

it('recovers a creation whose response was lost without repeating it, including after restart', async () => {
    const state = backend();
    const importer = new Importer();
    await importer.draft();
    state.failAfterCreate = true;
    await expect(importer.commit({ indexes: [0], title: 'Imported' })).rejects.toThrow('network');
    expect(state.draft.writeIntent).toBeDefined();
    const restarted = new Importer();
    await restarted.draft();
    state.failAfterCreate = false;
    const result = await restarted.commit({ indexes: [0], title: 'Imported' });
    expect(state.created).toBe(1);
    expect(result.playlistId).toBe(99);
    expect(state.draft.writeIntent).toBeUndefined();
});

it('never starts creation when its write-ahead checkpoint cannot reach disk', async () => {
    const state = backend();
    const importer = new Importer();
    await importer.draft();
    state.failFlush = true;
    await expect(importer.commit({ indexes: [0], title: 'Imported' })).rejects.toThrow('Disk full');
    expect(state.created).toBe(0);
});

it('does not adopt an older namesake or recreate an unconfirmed playlist', async () => {
    const state = backend({ ...draft(), writeIntent: { title: 'Imported', trackIds: [11], startedAt: Date.now() } });
    state.playlist = {
        id: 99,
        title: 'Imported',
        user: { id: 7 },
        tracks: [raw()],
        sharing: 'private',
        created_at: '2020-01-01T00:00:00Z',
    };
    const importer = new Importer();
    await importer.draft();
    await expect(importer.commit({ indexes: [0], title: 'Imported' })).rejects.toThrow('not yet confirmed');
    expect(state.created).toBe(0);
    expect(state.updated).toBe(0);
});

it('preserves edited title, explicit deselection, target and saved tracks when resuming', async () => {
    backend({
        ...draft(),
        title: 'Edited title',
        selected: [],
        savedUrls: [raw().permalink_url],
        writtenPlaylistId: 99,
        writtenAccountId: 7,
        writtenTitle: 'Edited title',
    });
    const importer = new Importer();
    const result = await importer.resume();
    expect(result?.title).toBe('Edited title');
    expect(result?.selected).toEqual([]);
    expect(result?.savedUrls).toEqual([raw().permalink_url]);
    expect(result?.writtenPlaylistId).toBe(99);
});

it('continues a large partial import after a lost append response without duplicating tracks or playlists', async () => {
    const job = draft();
    job.matches = Array.from({ length: 121 }, (_, i) => ({
        ...job.matches[0],
        soundcloud: { ...job.matches[0].soundcloud, apiId: i + 1, url: raw(i + 1).permalink_url },
    }));
    job.source.tracks = job.matches.map((match) => match.source);
    const state = backend(job);
    const importer = new Importer();
    await importer.draft();
    state.failAfterUpdate = true;
    const selection = { indexes: job.matches.map((_, i) => i), title: 'Imported' };
    await expect(importer.commit(selection)).rejects.toThrow('response was lost');
    expect(state.draft.writtenPlaylistId).toBe(99);
    expect(state.draft.savedUrls).toHaveLength(1);
    const restarted = new Importer();
    await restarted.draft();
    const result = await restarted.commit(selection);
    expect(state.created).toBe(1);
    expect(state.playlist.tracks).toHaveLength(121);
    expect(new Set(state.playlist.tracks.map((track: any) => track.id)).size).toBe(121);
    expect(result.added).toBe(71);
    expect(result.already).toBe(50);
    expect(state.draft.savedUrls).toHaveLength(121);
});

it('keeps all matches after browser CAPTCHA rejection and permits retry without a phantom pending creation', async () => {
    const state = backend();
    state.createFailure = Error('SoundCloud HTTP 403 (POST /playlists): challenge');
    class Model {
        async save() {
            throw { status: 403, responseJSON: { message: 'CAPTCHA required' } };
        }
    }
    Object.assign(Model.prototype, { resource_type: 'playlist' });
    host.playlistModels = [Model];
    const importer = new Importer();
    await importer.draft();
    await expect(importer.commit({ indexes: [0], title: 'Imported' })).rejects.toThrow('HTTP 403');
    expect(state.created).toBe(0);
    expect(state.draft.writeIntent).toBeUndefined();
    expect(state.draft.matches[0].soundcloud.apiId).toBe(11);
    expect(importer.diagnostics()).toMatchObject({
        phase: 'creating',
        pendingCreation: false,
        failure: { status: 403, transport: 'browser' },
    });
    state.createFailure = undefined;
    const result = await importer.commit({ indexes: [0], title: 'Imported' });
    expect(result.playlistId).toBe(99);
    expect(state.created).toBe(1);
});

it('creates a partial playlist from found matches and resumes after a later access rejection', async () => {
    const job = draft();
    job.matches = [
        job.matches[0],
        { source: { artist: 'Missing', title: 'Missing' } } as any,
        { ...job.matches[0], soundcloud: { ...job.matches[0].soundcloud, apiId: 12, url: raw(12).permalink_url } },
    ];
    job.source.tracks = job.matches.map((match) => match.source);
    const state = backend(job);
    state.updateFailure = Error('SoundCloud HTTP 403 (PUT /playlists/99): challenge');
    const importer = new Importer();
    await importer.draft();
    await expect(importer.commit({ indexes: [0, 1, 2], title: 'Imported' })).rejects.toThrow('HTTP 403');
    expect(state.playlist.tracks.map((track: any) => track.id)).toEqual([11]);
    expect(state.draft.writtenPlaylistId).toBe(99);
    expect(state.draft.savedUrls).toEqual([raw(11).permalink_url]);
    state.updateFailure = undefined;
    const result = await importer.commit({ indexes: [0, 1, 2], title: 'Imported' });
    expect(state.created).toBe(1);
    expect(result).toMatchObject({ added: 1, already: 1, unmatched: 1 });
    expect(state.playlist.tracks.map((track: any) => track.id)).toEqual([11, 12]);
    expect(
        host.invoke.mock.calls.find(
            ([command, args]) => command === 'catalog_request' && args.request.operation === 'createPlaylist',
        )?.[1].request.tracks,
    ).toEqual([11]);
});

it('only on explicit selection adopts a manually created owned playlist and preserves its existing tracks', async () => {
    const job = { ...draft(), writeIntent: { title: 'Imported', trackIds: [11], startedAt: Date.now() } };
    const state = backend(job);
    state.playlist = { id: 99, title: 'Imported', user: { id: 7 }, tracks: [raw(88)] };
    const importer = new Importer();
    await importer.draft();
    await expect(importer.commit({ indexes: [0], title: 'Imported' })).rejects.toThrow('not yet confirmed');
    expect(state.created).toBe(0);
    await importer.useCreatedPlaylist({ title: 'Imported' });
    expect(state.draft.writeIntent).toBeUndefined();
    const result = await importer.commit({ indexes: [0], title: 'Imported' });
    expect(result.added).toBe(1);
    expect(state.created).toBe(0);
    expect(state.playlist.tracks.map((track: any) => track.id)).toEqual([88, 11]);
});

it('does not adopt a namesake owned by another account', async () => {
    const state = backend();
    state.playlist = { id: 99, title: 'Imported', user: { id: 8 }, tracks: [] };
    const importer = new Importer();
    await importer.draft();
    await expect(importer.useCreatedPlaylist({ title: 'Imported' })).rejects.toThrow('another SoundCloud account');
    expect(state.draft.writtenPlaylistId).toBeUndefined();
    expect(state.created).toBe(0);
    expect(state.updated).toBe(0);
});
