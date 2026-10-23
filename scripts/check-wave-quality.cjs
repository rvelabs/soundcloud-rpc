const assert = require('node:assert/strict'),
    fs = require('node:fs'),
    path = require('node:path');
const root = path.resolve(__dirname, '..');
const current = require(path.join(root, 'tsc/wave/recommendation/session.js')).RecommendationSession;
const now = Date.UTC(2026, 9, 22),
    genres = ['ambient', 'house', 'techno', 'drum and bass', 'shoegaze'];
const candidates = Array.from({ length: 500 }, (_, i) => ({
    id: 'candidate-' + i,
    title: 'Recording ' + i,
    artist: 'Artist ' + (i % 80),
    genre: genres[i % 5],
    tags: ['instrumental'],
    features: { bpm: [80, 120, 145, 174, 95][i % 5], bpmConfidence: 0.8, energy: [0.15, 0.6, 0.9, 0.85, 0.3][i % 5] },
}));
const events = Array.from({ length: 5000 }, (_, i) => ({
    track: { ...candidates[i % 500], id: 'history-' + i, title: 'History ' + i },
    kind: i % 7 === 0 ? 'skip' : 'complete',
    listenedFraction: i % 7 === 0 ? 0.1 : 1,
    at: now - i * 60000,
}));
function run(Session) {
    const model = new Session({ search: async () => candidates }, () => now);
    model.loadFeedback(events);
    model.addCandidates(candidates);
    model.rank(12);
    const times = [];
    for (let i = 0; i < 7; i++) {
        const start = performance.now();
        model.rank(12);
        times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[3];
}
const model = new current({ search: async () => candidates }, () => now);
model.loadFeedback(events);
model.addCandidates(candidates);
const cases = [
    { tempo: 'slow', mood: 'calm' },
    { tempo: 'fast', mood: 'energetic' },
    { genre: 'drum and bass', tempo: 'fast' },
    { tone: 'bass', activity: 'workout' },
];
const results = cases.map((settings) => {
    model.setControls({ mood: 'any', tempo: 'any', tone: 'any', genre: '', discovery: 'balanced', ...settings });
    model.setActivity(settings.activity);
    const ranked = model.rank(12);
    assert.ok(ranked.length);
    for (const item of ranked) {
        if (settings.tempo === 'slow') assert.ok(item.track.features.bpm < 105);
        if (settings.tempo === 'fast') assert.ok(item.track.features.bpm >= 140);
        if (settings.genre) assert.equal(item.track.genre, settings.genre);
    }
    return { settings, count: ranked.length, artists: new Set(ranked.map((i) => i.track.artist)).size };
});
const report = { candidates: 500, feedback: 5000, medianMs: run(current), cases: results };
if (process.argv[2])
    report.previousMedianMs = run(require(path.resolve(process.argv[2], 'session.js')).RecommendationSession);
console.log(JSON.stringify(report, null, 2));
