import { defaultWaveControls } from '../waveEngine';
import { describe, expect, it } from 'vitest';
import type ElectronStore from 'electron-store';
import { SoundCloudRecommender, toTrack } from './soundcloudAdapter';
import type { WaveCandidate } from '../waveEngine';
import type { Track } from './types';
const item = (url: string, artist: string, genre: string, bpm?: number): WaveCandidate => ({
    url,
    title: url,
    artist,
    genre,
    sourceRank: 0,
    bpm,
    bpmConfidence: bpm ? 0.7 : undefined,
});
const memoryStore = (initial: Record<string, unknown> = {}) => {
    const values = new Map(Object.entries(initial));
    return {
        values,
        store: {
            get: (key: string) => values.get(key),
            set: (key: string, value: unknown) => {
                values.set(key, value);
            },
        } as unknown as ElectronStore,
    };
};
describe('SoundCloud recommendation adapter', () => {
    it('keeps independent related-track evidence across catalog refreshes', () => {
        const { store } = memoryStore();
        const model = new SoundCloudRecommender(store, 'sources', async () => []);
        const candidate = {
            ...item('https://soundcloud.com/artist/new', 'Artist', 'ambient'),
            source: 'related' as const,
        };
        model.addCandidates([{ ...candidate, relatedTo: ['seed-one'] }]);
        model.addCandidates([{ ...candidate, relatedTo: ['seed-two'] }]);
        expect(new Set(model.rank()[0].relatedTo)).toEqual(new Set(['seed-one', 'seed-two']));
    });
    it('restores favorite candidates when a stopped wave starts again in the same client', () => {
        const { store } = memoryStore();
        const model = new SoundCloudRecommender(store, 'restart', async () => []);
        const favorite = item('https://soundcloud.com/artist/favorite', 'Artist', 'ambient');
        model.seedLikes([favorite]);
        model.setControls({ mood: 'any', tone: 'any', tempo: 'any', genre: '', discovery: 'favorites' });
        expect(model.rank(1)[0]?.url).toBe(favorite.url);
        model.clearCandidates();
        expect(model.rank(1)[0]?.url).toBe(favorite.url);
    });
    it('does not resurrect rejected catalog entries through the search adapter', async () => {
        const { store } = memoryStore();
        const bad = { ...item('bad', 'A', 'rock'), playability: 'blocked' as const };
        const good = item('good', 'B', 'rock');
        const recommender = new SoundCloudRecommender(store, 'one', async () => [bad, good]);
        expect((await recommender.refresh()).map((track) => track.url)).toEqual(['good']);
        recommender.addCandidates([{ ...good, playability: 'preview' }]);
        expect(recommender.rank()).toEqual([]);
        expect(recommender.rankBuffered([good])).toHaveLength(1);
    });
    it('drops in-flight results after stopping, and releases reservations on restart', async () => {
        const { store } = memoryStore();
        let finish!: (tracks: WaveCandidate[]) => void;
        const candidate = item('fresh', 'A', 'rock');
        const recommender = new SoundCloudRecommender(
            store,
            'one',
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const refresh = recommender.refresh();
        recommender.clearCandidates();
        finish([candidate]);
        await refresh;
        expect(recommender.rank()).toEqual([]);
        recommender.addCandidates([candidate]);
        recommender.reserve(candidate);
        expect(recommender.rank()).toEqual([]);
        recommender.clearCandidates();
        recommender.addCandidates([candidate]);
        expect(recommender.rank().map((track) => track.url)).toEqual(['fresh']);
    });
    it('ignores a legacy genre selection instead of carrying it into new discovery', async () => {
        const { store } = memoryStore();
        const queries: Track[][] = [];
        const fresh = item('https://soundcloud.com/fresh/track', 'Fresh artist', 'shoegaze');
        const recommender = new SoundCloudRecommender(store, 'brand-new-account', async (value) => {
            queries.push(value);
            return [fresh];
        });
        recommender.setControls({
            mood: 'any',
            tone: 'any',
            tempo: 'any',
            genre: 'shoegaze',
            discovery: 'new',
            activity: 'any',
        });
        expect(recommender.feedbackCount()).toBe(0);
        expect((await recommender.refresh()).map((candidate) => candidate.url)).toContain(fresh.url);
        expect(queries.flat().some((query) => query.id.includes('shoegaze'))).toBe(false);
    });
    it('migrates existing likes and plays without replaying those tracks', async () => {
        const liked = item('liked', 'A', 'shoegaze');
        const old = item('old', 'B', 'shoegaze');
        const fresh = item('fresh', 'C', 'shoegaze');
        const { store, values } = memoryStore({
            waveHistory_default: [
                {
                    url: liked.url,
                    title: liked.title,
                    artist: liked.artist,
                    genre: liked.genre,
                    liked: true,
                    plays: 0,
                    skips: 0,
                },
                {
                    url: old.url,
                    title: old.title,
                    artist: old.artist,
                    genre: old.genre,
                    liked: false,
                    plays: 1,
                    skips: 0,
                },
            ],
        });
        const recommender = new SoundCloudRecommender(store, 'default', async () => [liked, old, fresh]);
        recommender.setControls({ ...defaultWaveControls, discovery: 'new' });
        expect((await recommender.refresh()).map((candidate) => candidate.url)).toEqual(['fresh']);
        expect(Array.isArray(values.get('waveFeedbackV1_default'))).toBe(true);
    });
    it('uses a new like and a manual skip on the next ranking, then reloads feedback', async () => {
        const a = item('a', 'A', 'ambient');
        const b = item('b', 'B', 'ambient');
        const c = item('c', 'C', 'house');
        const { store } = memoryStore();
        const make = () => new SoundCloudRecommender(store, 'default', async () => [a, b, c]);
        const first = make();
        first.record(a, 'like');
        first.record(c, 'skip', 0.05);
        expect((await first.refresh())[0].url).toBe('b');
        const restarted = make();
        expect((await restarted.refresh())[0].url).toBe('b');
    });
    it('separates account taste and excludes known SoundCloud likes', async () => {
        const liked = { ...item('liked', 'A', 'rock'), liked: true };
        const newTrack = item('new', 'B', 'rock');
        const { store } = memoryStore();
        const first = new SoundCloudRecommender(store, 'one', async () => [liked, newTrack]);
        first.setControls({ ...defaultWaveControls, discovery: 'new' });
        expect((await first.refresh()).map((candidate) => candidate.url)).toEqual(['new']);
        const second = new SoundCloudRecommender(store, 'two', async () => [newTrack]);
        second.record(newTrack, 'dislike');
        expect((await second.refresh()).length).toBe(0);
        expect(first.rank().length).toBe(1);
    });
    it('requires reliable BPM before treating a SoundCloud candidate as a tempo match', () => {
        expect(toTrack({ ...item('scraped', 'A', 'techno', 90), bpmConfidence: 0.45 }).features?.bpmConfidence).toBe(
            0.45,
        );
        expect(toTrack(item('metadata', 'B', 'techno', 90)).features?.bpmConfidence).toBe(0.7);
    });
    it('starts from account-scoped cached candidates without another network search', () => {
        const fresh = item('https://soundcloud.com/new/track', 'New', 'ambient');
        const { store } = memoryStore();
        const first = new SoundCloudRecommender(store, 'one', async () => [fresh]);
        first.addCandidates([fresh]);
        const restarted = new SoundCloudRecommender(store, 'one', async () => {
            throw new Error('Search should not run for cached tracks');
        });
        expect(restarted.rank(1)[0]?.url).toBe(fresh.url);
    });
    it('preserves library hearts across restart without converting the import into live feedback', () => {
        const { store, values } = memoryStore();
        const liked = item('liked-library', 'Library artist', 'ambient');
        const model = new SoundCloudRecommender(store, 'library', async () => []);
        model.seedLikes([liked]);
        const imported = values.get('waveFeedbackV1_library') as Array<{ origin?: string }>;
        expect(imported[0].origin).toBe('library');
        const reopened = new SoundCloudRecommender(store, 'library', async () => []);
        expect(reopened.liked(liked.url)).toBe(true);
        reopened.record(liked, 'unlike');
        reopened.record(liked, 'like');
        const reactions = values.get('waveFeedbackV1_library') as Array<{ origin?: string }>;
        expect(reactions[reactions.length - 1]?.origin).toBeUndefined();
        expect(reopened.preparationRevision()).toBe(2);
    });
});
describe('artist exclusions', () => {
    it('filters all uploads before selection and after buffering, persists per account and can restore', () => {
        const { store } = memoryStore();
        const first = new SoundCloudRecommender(store, 'one', async () => []);
        const tracks = [item('a', ' Artist ', 'rock'), item('b', 'artist', 'rock'), item('c', 'Other', 'rock')];
        first.addCandidates(tracks);
        first.excludeArtist(' Artist ', true);
        expect(first.rank(1).map((track) => track.url)).toEqual(['c']);
        expect(first.rankBuffered(tracks).map((track) => track.url)).toEqual(['c']);
        const reopened = new SoundCloudRecommender(store, 'one', async () => []);
        expect(reopened.getExcludedArtists()).toEqual(['Artist']);
        expect(reopened.rankBuffered(tracks).map((track) => track.url)).toEqual(['c']);
        expect(new SoundCloudRecommender(store, 'two', async () => []).getExcludedArtists()).toEqual([]);
        reopened.excludeArtist('ARTIST', false);
        expect(
            reopened
                .rankBuffered(tracks)
                .map((track) => track.url)
                .sort(),
        ).toEqual(['a', 'b', 'c']);
        expect(reopened.feedbackCount()).toBe(0);
    });
});
