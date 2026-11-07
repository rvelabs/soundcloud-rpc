import type { SourceTrack } from './source';
export function spotifySnapshot(): {
    title: string;
    tracks: Array<SourceTrack & { position: number }>;
    total?: number;
    bottom: boolean;
    reachable: boolean;
} {
    const page = document.querySelector('[data-testid="playlist-page"]') || document.querySelector('main') || document;
    const grid =
        page.querySelector('[data-testid="playlist-tracklist"]') ||
        page.querySelector('[data-testid="tracklist"]') ||
        page.querySelector('[role="grid"]');
    const namedRows = grid?.querySelectorAll('[data-testid="tracklist-row"]');
    const rows = namedRows?.length ? [...namedRows] : grid ? [...grid.querySelectorAll('[role="row"]')] : [];
    const tracks: Array<SourceTrack & { position: number }> = [];
    for (const row of rows) {
        const link = row.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
        const id = link?.href.match(/\/track\/([A-Za-z0-9]{22})(?:[/?#]|$)/)?.[1];
        const title = link?.textContent?.trim() || row.querySelector('[data-testid="track-name"]')?.textContent?.trim();
        const artist = [...row.querySelectorAll('a[href*="/artist/"]')]
            .map((item) => item.textContent?.trim())
            .filter(Boolean)
            .join(', ');
        if (!title || !artist || !id) continue;
        const duration = row.textContent?.match(/(?:^|\D)(\d{1,2}):(\d{2})(?!\d)/);
        const position =
            Number(row.getAttribute('aria-rowindex')) ||
            Number(row.querySelector('[aria-colindex="1"]')?.textContent?.trim()) ||
            tracks.length + 1;
        tracks.push({
            title: title.slice(0, 200),
            artist: artist.slice(0, 200),
            sourceId: 'spotify:track:' + id,
            position,
            ...(duration ? { durationSeconds: Number(duration[1]) * 60 + Number(duration[2]) } : {}),
        });
    }
    const header = page.querySelector<HTMLElement>('[data-testid="entity-header"]');
    const headerText =
        header?.innerText ||
        [...page.querySelectorAll('h1,p')]
            .filter((item) => !grid?.contains(item))
            .map((item) => item.textContent)
            .join(' ');
    const headerCount = headerText.match(
        /(?:^|[^\d])([\d][\d\s,.]*)\s*(?:songs?|tracks?|трек(?:а|ов)?|пес(?:ен|ни|ня)|Titel)(?:\s|$|[·,.])/i,
    )?.[1];
    const declared = Number(
        (grid?.hasAttribute('aria-rowcount') ? grid : grid?.querySelector('[aria-rowcount]'))?.getAttribute(
            'aria-rowcount',
        ),
    );
    const counted = headerCount ? Number(headerCount.replace(/\D/g, '')) : 0;
    const total =
        counted > 0
            ? counted
            : declared > 1
              ? declared - Number(Boolean(grid?.querySelector('[role="columnheader"]')))
              : undefined;
    let scroll: Element | null = grid;
    while (scroll && scroll.scrollHeight <= scroll.clientHeight + 5) scroll = scroll.parentElement;
    scroll ||= document.scrollingElement;
    const bottom = Boolean(scroll && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 8);
    if (scroll)
        scroll.scrollTop = Math.min(scroll.scrollHeight, scroll.scrollTop + Math.max(200, scroll.clientHeight * 0.8));
    const title =
        (page.querySelector('[data-testid="entityTitle"]') || page.querySelector('h1'))?.textContent
            ?.trim()
            .slice(0, 100) || '';
    return {
        tracks,
        title,
        total: total && total > 0 && total <= 1000000 ? total : undefined,
        bottom,
        reachable: Boolean(
            grid || document.querySelector('[data-testid="login-button"], [data-testid="login-username"]'),
        ),
    };
}
