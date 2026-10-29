import { describe, expect, it } from 'vitest';
import { matchIdentity, matchScore } from './matchIdentity';
const source = { artist: '1.klas$', title: 'Трек из архива', durationSeconds: 180 };
describe('original artist identity for reuploads', () => {
    it('accepts an original artist credit in the title even when the uploader is unrelated', () => {
        const identity = matchIdentity(source, {
            artist: 'Old music archive',
            title: '1.Klass — Трек из архива',
            durationSeconds: 181,
        });
        expect(identity.score).toBeGreaterThan(0.9);
        expect(identity.requiresReview).toBe(false);
        expect(matchScore(source, { artist: 'Uploader', title: '1.Klass Трек из архива' })).toBeGreaterThan(0.9);
        expect(matchScore(source, { artist: 'Uploader', title: '1.Klass-Трек из архива' })).toBeGreaterThan(0.9);
    });
    it('uses publisher metadata and Cyrillic/Latin artist spellings', () => {
        expect(
            matchIdentity(
                { ...source, artist: '1 Класс' },
                { title: source.title, artist: 'Reuploads', publisherArtist: '1.Klass' },
            ).requiresReview,
        ).toBe(false);
        expect(matchScore(source, { artist: '1klas', title: source.title })).toBeGreaterThan(0.85);
    });
    it('keeps a title-only reupload as an unchecked candidate rather than falsely confirming the artist', () => {
        const identity = matchIdentity(source, {
            artist: 'Random uploader',
            title: source.title,
            durationSeconds: 180,
        });
        expect(identity.score).toBeGreaterThanOrEqual(0.78);
        expect(identity.score).toBeLessThan(0.85);
        expect(identity.requiresReview).toBe(true);
    });
    it('does not turn an artist mention in a description into verified authorship', () => {
        const identity = matchIdentity(source, {
            artist: 'Uploader',
            title: source.title,
            description: 'Fans of 1.Klass can listen here.',
        });
        expect(identity.requiresReview).toBe(true);
        expect(identity.score).toBeLessThan(0.85);
    });
    it('rejects generic ambiguous titles and prefix matches to a different song', () => {
        expect(
            matchScore({ artist: 'Original', title: 'Intro' }, { artist: 'Someone else', title: 'Intro' }),
        ).toBeLessThan(0.78);
        expect(
            matchScore({ artist: 'Original', title: 'Love' }, { artist: 'Original', title: 'Love Me Now' }),
        ).toBeLessThan(0.78);
    });
    it.each(['(Remix)', '(Cover)', '(Live)', '(Slowed)', '(Instrumental)'])(
        'does not substitute %s for the original',
        (version) => {
            expect(matchScore(source, { artist: source.artist, title: source.title + ' ' + version })).toBeLessThan(
                0.78,
            );
        },
    );
    it('rejects a much longer version even when the title and artist match', () => {
        expect(
            matchIdentity(source, { artist: source.artist, title: source.title, durationSeconds: 320 }).reviewReason,
        ).toBe('duration');
        expect(matchScore(source, { artist: source.artist, title: source.title, durationSeconds: 320 })).toBeLessThan(
            0.85,
        );
    });
});
