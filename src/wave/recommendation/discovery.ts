import { normalize } from './profile';
import { activities, languageQuery } from './preferences';
import type { Controls } from './types';
import type { TasteProfile } from './profile';
export function discoveryQueries(profile: TasteProfile, controls: Controls, rotation = 0): string[] {
    const preferred = [...profile.tokens]
        .filter(([, weight]) => weight > 0.5)
        .sort((a, b) => b[1] - a[1])
        .map(([token]) => token)
        .slice(0, 12);
    const styles = [...profile.styles]
        .filter(([, weight]) => weight > 0.5)
        .sort((a, b) => b[1] - a[1])
        .map(([style]) => style);
    const seeds = controls.genre?.trim()
        ? [controls.genre.trim()]
        : [...new Set([...styles, ...preferred])].slice(0, 12);
    if (!seeds.length) seeds.push('electronic', 'indie', 'ambient');
    const rotated = [...seeds.slice(rotation % seeds.length), ...seeds.slice(0, rotation % seeds.length)];
    const qualifier = [
        controls.mood === 'calm'
            ? 'chill'
            : controls.mood === 'energetic'
              ? 'energetic'
              : controls.mood === 'happy'
                ? 'happy uplifting'
                : controls.mood === 'sad'
                  ? 'sad melancholic'
                  : '',
        controls.tempo === 'slow'
            ? 'slow'
            : controls.tempo === 'medium'
              ? 'midtempo'
              : controls.tempo === 'fast'
                ? 'fast'
                : '',
        controls.tone === 'bass' ? 'bass' : controls.tone === 'bright' ? 'bright' : '',
        controls.discovery === 'new' ? 'underground' : controls.discovery === 'popular' ? 'popular' : '',
        languageQuery(controls, rotation),
    ]
        .filter(Boolean)
        .join(' ');
    const situation = controls.activity ? activities[controls.activity].query : '';
    const variations = [
        'melodic',
        'atmospheric',
        'deep',
        'minimal',
        'experimental',
        'instrumental',
        'underground',
        'new',
    ];
    const intents =
        rotated.length === 1
            ? [
                  rotated[0],
                  `${rotated[0]} ${variations[rotation % variations.length]}`,
                  `${rotated[0]} ${variations[(rotation + 3) % variations.length]}`,
              ]
            : rotated.slice(0, 3);
    return [
        ...new Set(
            [
                ...(!controls.genre?.trim() &&
                (controls.mood === 'happy' ||
                    controls.mood === 'sad' ||
                    (controls.language && controls.language !== 'any') ||
                    controls.discovery === 'popular')
                    ? [qualifier]
                    : []),
                ...intents.map((seed) => [seed, qualifier, situation].filter(Boolean).join(' ')),
                ...rotated.slice(0, 3),
            ].map(normalize),
        ),
    ].slice(0, 6);
}
