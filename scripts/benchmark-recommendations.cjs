const { performance } = require('node:perf_hooks');
const path = require('node:path'),
    fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const { RecommendationSession } = require(path.join(root, 'tsc/wave/recommendation/session'));
const { recommend } = require(path.join(root, 'tsc/wave/recommendation/ranker'));
const { buildProfile } = require(path.join(root, 'tsc/wave/recommendation/profile'));
const { AsyncDataStore } = require(path.join(root, 'tsc/storage/asyncDataStore'));
const Conf = require(path.join(root, 'node_modules/conf'));
const now = Date.now(),
    folder = path.join(root, 'build-performance', String(now), 'synthetic-store');
const tracks = Array.from({ length: 500 }, (_, i) => ({
    id: 'seed-' + i,
    title: 'Seed ' + i,
    artist: 'Artist ' + (i % 173),
    genre: ['ambient', 'house', 'jungle', 'rock', 'shoegaze'][i % 5],
    tags: ['style-' + (i % 20), 'sound-' + (i % 13)],
    features: { energy: (i % 100) / 100, bass: 0.4, brightness: 0.3 },
}));
const events = Array.from({ length: 5000 }, (_, i) => ({
    track: tracks[i % 500],
    kind: i % 7 === 0 ? 'like' : 'complete',
    at: now - 8 * 86400000 - i * 10000,
    listenedFraction: 0.8,
}));
const candidates = tracks.map((track, i) => ({ ...track, id: 'new-' + i, title: 'New ' + i }));
const controls = { mood: 'any', tone: 'any', tempo: 'any', discovery: 'balanced' };
const stats = (values) => {
    values.sort((a, b) => a - b);
    return {
        medianMs: +values[Math.floor(values.length / 2)].toFixed(4),
        p95Ms: +values[Math.floor(values.length * 0.95)].toFixed(4),
    };
};
const measure = (run, n = 30) => {
    const values = [];
    for (let i = 0; i < n; i++) {
        const start = performance.now();
        run();
        values.push(performance.now() - start);
    }
    return stats(values);
};
(async () => {
    const profile = buildProfile(events, now),
        session = new RecommendationSession({ related: async () => [] }, () => now);
    session.loadFeedback(events);
    session.setControls(controls);
    session.addCandidates(candidates);
    session.rank(20);
    const uncached = measure(() => recommend(candidates, events, controls, { now }, 20, profile));
    const cached = measure(() => session.rank(20), 200);
    const fallback = { get: () => undefined, set: () => {} };
    const data = await AsyncDataStore.open(folder, fallback, {
        available: () => false,
        encrypt: Buffer.from,
        decrypt: (v) => v.toString(),
    });
    const conf = new Conf({
        cwd: path.join(folder, 'sync'),
        projectName: 'synthetic',
        encryptionKey: 'benchmark-only',
    });
    const synchronous = measure(() => conf.set('events', events), 20);
    const update = [],
        dispatch = [],
        wall = [];
    for (let i = 0; i < 20; i++) {
        let start = performance.now();
        data.set('events', events);
        update.push(performance.now() - start);
        start = performance.now();
        const saving = data.flush();
        dispatch.push(performance.now() - start);
        await saving;
        wall.push(performance.now() - start);
    }
    await data.close();
    const result = {
        synthetic: true,
        node: process.versions.node,
        candidates: 500,
        feedbackEvents: 5000,
        uncachedRank: uncached,
        cachedRank: cached,
        synchronousEncryptedStore: synchronous,
        inMemoryUpdate: stats(update),
        mainThreadDispatch: stats(dispatch),
        asyncWriteWallTime: stats(wall),
    };
    fs.writeFileSync(path.join(folder, 'algorithm.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
