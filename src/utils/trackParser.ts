import type { ParsedTrackInfo, NormalizedTrackInfo } from '../types';
const SEPARATOR_REGEX = /(\s+[\u002D\u2013\u2014\u2015]+\s+|[\u002D\u2013\u2014\u2015]{2,})/;
const INVALID_PATTERNS = [
    /^\s*$/,
    /^[\u002D\u2013\u2014\u2015]/,
    /[\u002D\u2013\u2014\u2015]$/,
    /(.)\1{4,}/,
    /[\u002D\u2013\u2014\u2015]{2,}/,
];
const hasInvalidPatterns = (text: string): boolean => INVALID_PATTERNS.some((p) => p.test(text));
export function parseSoundCloudTitle(title: string): ParsedTrackInfo {
    if (!title || typeof title !== 'string') {
        return { artist: null, track: '' };
    }
    const cleanTitle = title.split('\n')[0].trim();
    const match = cleanTitle.match(SEPARATOR_REGEX);
    if (match && match.index && match.index > 0) {
        const artist = cleanTitle.substring(0, match.index).trim();
        const track = cleanTitle.substring(match.index + match[0].length).trim();
        if (artist.length > 0 && track.length > 0 && !hasInvalidPatterns(artist) && !hasInvalidPatterns(track)) {
            return { artist, track };
        }
    }
    return {
        artist: null,
        track: cleanTitle,
    };
}
export function normalizeTrackInfo(
    titleFromPage: string,
    authorFromPage: string,
    useTrackParser: boolean = true,
): NormalizedTrackInfo {
    if (!useTrackParser || !titleFromPage) {
        return {
            artist: authorFromPage || 'Unknown Artist',
            track: titleFromPage.split('\n')[0].trim() || 'Unknown Track',
        };
    }
    const parsed = parseSoundCloudTitle(titleFromPage);
    return {
        artist: parsed.artist || authorFromPage || 'Unknown Artist',
        track: parsed.track || 'Unknown Track',
    };
}
