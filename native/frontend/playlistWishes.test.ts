import { expect, it } from 'vitest';
import { fitsPlaylistWishes, parsePlaylistWishes, playlistWishBonus } from './playlistWishes';
import type { Track } from '../../src/wave/recommendation/types';

const track = (extra: Partial<Track> = {}): Track => ({
    id: 'a',
    title: 'Track',
    artist: 'Artist',
    genre: 'jungle',
    tags: ['jungle'],
    ...extra,
});
it('parses Russian and English wishes without a remote model, and leaves unknown words visible', () => {
    expect(parsePlaylistWishes('спокойнее, без вокала, больше баса, в основном из моих лайков')).toMatchObject({
        mood: 'calm',
        language: 'instrumental',
        tone: 'bass',
        likes: 'prefer',
        unrecognized: [],
    });
    expect(parsePlaylistWishes('calmer, no vocals, mostly from my likes')).toMatchObject({
        mood: 'calm',
        language: 'instrumental',
        likes: 'prefer',
        unrecognized: [],
    });
    expect(parsePlaylistWishes('как закат на Марсе').unrecognized).toContain('марсе');
});
it('does not turn negated genres into positive requests or match words inside artist names', () => {
    const wishes = parsePlaylistWishes('без рэпа, побыстрее');
    expect(wishes).toMatchObject({ exclude: ['hip hop'], tempo: 'fast' });
    expect(wishes.genre).toBeUndefined();
    expect(fitsPlaylistWishes(track({ genre: 'Hip-hop & Rap' }), wishes, false)).toBe(false);
    const noTrap = parsePlaylistWishes('no trap');
    expect(fitsPlaylistWishes(track({ title: 'Bootstrap', tags: ['jungle'] }), noTrap, false)).toBe(true);
    expect(fitsPlaylistWishes(track({ tags: ['trap'] }), noTrap, false)).toBe(false);
});
it('recognizes the screenshot wording as instrumental music rather than an excluded word', () => {
    for (const phrase of [
        'спокойное, без голоса',
        'спокойное, без голосов',
        'спокойнее, без пения',
        'calmer, without voice',
        'calm, no singing',
    ]) {
        const wishes = parsePlaylistWishes(phrase);
        expect(wishes).toMatchObject({ mood: 'calm', language: 'instrumental', exclude: [], unrecognized: [] });
        expect(fitsPlaylistWishes(track({ genre: 'Ambient', tags: ['ambient', 'instrumental'] }), wishes, false)).toBe(
            true,
        );
        expect(fitsPlaylistWishes(track({ language: 'en', tags: ['vocal'] }), wishes, false)).toBe(false);
    }
});
it('supports quoted excluded artists and detects conflicting requests instead of guessing', () => {
    const wishes = parsePlaylistWishes('без «Bad Artist», jungle');
    expect(wishes).toMatchObject({ genre: 'jungle', exclude: ['bad artist'] });
    expect(fitsPlaylistWishes(track({ artist: 'Bad Artist' }), wishes, false)).toBe(false);
    expect(parsePlaylistWishes('slow and fast').conflicts).not.toHaveLength(0);
    expect(parsePlaylistWishes('без вокала, на русском').conflicts).not.toHaveLength(0);
    expect(parsePlaylistWishes('jungle, no jungle').conflicts).not.toHaveLength(0);
});
it('distinguishes preference for likes from a strict likes-only requirement', () => {
    expect(parsePlaylistWishes('только из моих лайков').likes).toBe('only');
    const strict = parsePlaylistWishes('only my likes');
    expect(strict.likes).toBe('only');
    expect(fitsPlaylistWishes(track(), strict, false)).toBe(false);
    expect(fitsPlaylistWishes(track(), strict, true)).toBe(true);
    const prefer = parsePlaylistWishes('more likes');
    expect(fitsPlaylistWishes(track(), prefer, false)).toBe(true);
    expect(playlistWishBonus(track(), prefer, true)).toBeGreaterThan(playlistWishBonus(track(), prefer, false));
});
it('requires evidence for language and tempo instead of inventing analysis of unseen audio', () => {
    expect(fitsPlaylistWishes(track(), parsePlaylistWishes('no vocals'), false)).toBe(false);
    expect(fitsPlaylistWishes(track({ tags: ['instrumental'] }), parsePlaylistWishes('no vocals'), false)).toBe(true);
    const fast = parsePlaylistWishes('faster');
    expect(fitsPlaylistWishes(track({ genre: 'ambient', tags: [] }), fast, false)).toBe(false);
    expect(fitsPlaylistWishes(track({ features: { bpm: 170, bpmConfidence: 0.95 } }), fast, false)).toBe(true);
    expect(fitsPlaylistWishes(track({ features: { bpm: 75, bpmConfidence: 0.95 } }), fast, false)).toBe(false);
});
