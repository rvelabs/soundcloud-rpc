import { describe, expect, it } from 'vitest';
import { buildProfile } from './profile';
import { recommend } from './ranker';
import { measuredSoundSimilarity, recentPreference } from './sessionSignals';
import { defaultControls, type Feedback, type Track } from './types';

const now = 10000000;
const track = (id: string, bass?: number, brightness?: number): Track => ({
    id,
    title: 'Recording',
    artist: id,
    genre: 'house',
    features: bass === undefined ? undefined : { source: 'media-element-v1', sampleSeconds: 30, bass, brightness },
});
const skip = (id: string, at = now): Feedback => ({ track: track(id), kind: 'skip', listenedFraction: 0.05, at });

describe('ambiguous skips and temporary listening intent', () => {
    it('never turns passive skips into a lasting dislike of a favorite style', () => {
        const likes: Feedback[] = [{ track: track('favorite'), kind: 'like', at: now - 86400000 }];
        const before = buildProfile(likes, now);
        const after = buildProfile([...likes, ...Array.from({ length: 20 }, (_, i) => skip(String(i)))], now);
        expect(after.tokens).toEqual(before.tokens);
        expect(after.styles).toEqual(before.styles);
        expect(after.negativeSeeds).toEqual([]);
        expect(after.likedIds.has('favorite')).toBe(true);
        expect(after.heardIds.has('19')).toBe(true);
    });
    it('needs three distinct recent recordings before changing a genre direction', () => {
        expect(recentPreference([skip('a')], now).size).toBe(0);
        expect(recentPreference([skip('a'), skip('b')], now).size).toBe(0);
        expect(recentPreference([skip('a'), skip('a'), skip('a')], now).size).toBe(0);
        expect(recentPreference([skip('a'), skip('b'), skip('c')], now).get('house')).toBeLessThan(-1);
        expect(recentPreference([skip('a'), skip('b'), skip('c')], now + 11 * 60000).size).toBe(0);
    });
    it('does not combine skips spread over unrelated listening moments', () => {
        expect(recentPreference([skip('a', now - 11 * 60000), skip('b'), skip('c')], now).size).toBe(0);
    });
    it('distinguishes measured sound inside the same genre without using mastering loudness', () => {
        expect(measuredSoundSimilarity(track('a', 0.8, 0.1), track('b', 0.8, 0.1))).toBe(1);
        expect(measuredSoundSimilarity(track('a', 0.8, 0.1), track('b', 0.1, 0.8))).toBe(0);
        expect(measuredSoundSimilarity(track('a'), track('b', 0.8, 0.1))).toBeUndefined();
        const lowQuality = track('a', 0.8, 0.1);
        lowQuality.features!.sampleSeconds = 3;
        expect(measuredSoundSimilarity(lowQuality, track('b', 0.8, 0.1))).toBeUndefined();
    });
    it('does not convert a pattern of measured sound skips into a broad genre penalty', () => {
        const events = ['a', 'b', 'c'].map((id) => ({ ...skip(id), track: track(id, 0.8, 0.1) }));
        expect(recentPreference(events, now).has('house')).toBe(false);
    });
    it('temporarily reduces matching sound after repeated skips while retaining the other sound in the genre', () => {
        const pool = [track('bass-candidate', 0.8, 0.1), track('bright-candidate', 0.1, 0.8)];
        const likes: Feedback[] = [{ track: track('favorite'), kind: 'like', at: now - 86400000 }];
        const skipped: Feedback[] = ['a', 'b'].map((id) => ({ ...skip(id), track: track(id, 0.8, 0.1) }));
        const scores = (events: Feedback[], clock = now) =>
            new Map(
                recommend(pool, events, defaultControls, { now: clock }, 10).map((item) => [item.track.id, item.score]),
            );
        const before = scores(likes);
        const afterOne = scores([...likes, skipped[0]]);
        expect(afterOne.get('bass-candidate')).toBeCloseTo(before.get('bass-candidate')!);
        const after = scores([...likes, ...skipped]);
        expect(after.get('bass-candidate')).toBeLessThan(before.get('bass-candidate')! - 0.5);
        expect(after.get('bright-candidate')).toBeCloseTo(before.get('bright-candidate')!);
        const expired = scores([...likes, ...skipped], now + 11 * 60000);
        expect(expired.get('bass-candidate')).toBeCloseTo(scores(likes, now + 11 * 60000).get('bass-candidate')!);
    });
    it('preserves an explicit dislike as a persistent instruction', () => {
        const profile = buildProfile([{ track: track('no'), kind: 'dislike', at: now }, skip('no')], now);
        expect(profile.dislikedIds.has('no')).toBe(true);
        expect(profile.negativeSeeds.map((item) => item.id)).toContain('no');
    });
});
