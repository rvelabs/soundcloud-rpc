import type { WebContents } from 'electron';
import { nativeRuntimeExports } from './nativeRuntime';

export interface QueueRequest {
    operation: 'add' | 'play' | 'list' | 'remove';
    urls: string[];
    ticket: string;
    expires: number;
    replacement?: {
        current: string;
        expected: string[];
        remove: string[];
    };
}
export interface QueueResult {
    state: 'unsupported' | 'done' | 'unavailable' | 'uncertain' | 'cancelled';
    urls?: string[];
}
export async function nativeQueueModel(
    request: QueueRequest,
    getExports: (playback?: boolean) => unknown[],
): Promise<QueueResult> {
    type Sound = {
        get: (key: string) => unknown;
        fetch: () => PromiseLike<unknown>;
        hold: () => void;
        release: () => void;
        isPlayable: () => boolean;
        isPlaying: () => boolean;
        isBuffering?: () => boolean;
        isAd: () => boolean;
    };
    type Item = { sound: Sound; explicit: boolean };
    type Queue = { models: Item[]; remove: (items: Item[]) => void; indexOf: (item: Item) => number };
    type Manager = {
        getQueue: () => Queue;
        getCurrentQueueItem: () => Item | undefined;
        getCurrentSound: () => Sound | undefined;
        addExplicitQueueItem: (source: Sound, sound: Sound, context: object) => void;
        playSource: (source: Sound, sound: Sound, context: object, options: object) => void;
        playCurrent: (options: object) => void;
        setCurrentItem?: (item: Item, options: object) => void;
    };
    type SoundClass = {
        prototype: { resource_type?: string };
        resolve: (owner: string, track: string) => PromiseLike<Sound>;
    };
    const page = window as typeof window & { __scRpcQueueTickets?: Map<string, { cancelled: boolean }> };
    const path = (value: unknown): string | null => {
        try {
            const url = new URL(String(value));
            return url.origin === 'https://soundcloud.com' && /^\/[\w.~-]+\/[\w.~-]+\/?$/.test(url.pathname)
                ? url.pathname.replace(/\/$/, '')
                : null;
        } catch {
            return null;
        }
    };
    const exports = getExports(request.operation === 'play');
    const manager = exports.find(
        (value) =>
            value &&
            [
                'getQueue',
                'getCurrentQueueItem',
                'getCurrentSound',
                'addExplicitQueueItem',
                'playSource',
                'playCurrent',
            ].every((key) => typeof (value as Record<string, unknown>)[key] === 'function'),
    ) as Manager | undefined;
    if (!manager) return { state: 'unsupported' };
    const queue = manager.getQueue();
    if (!Array.isArray(queue?.models) || typeof queue.indexOf !== 'function') return { state: 'unsupported' };
    const address = (item?: Item) => path(item?.sound?.get('permalink_url'));
    const future = () => queue.models.slice(queue.indexOf(manager.getCurrentQueueItem()!) + 1);
    const urls = () => [
        ...new Set(
            future()
                .filter((item) => item.explicit)
                .flatMap((item) => {
                    const p = address(item);
                    return p ? ['https://soundcloud.com' + p] : [];
                }),
        ),
    ];
    if (request.operation === 'list') return { state: 'done', urls: urls() };
    if (request.operation === 'remove') {
        if (typeof queue.remove !== 'function') return { state: 'unsupported' };
        const requested = new Set(request.urls.map(path).filter(Boolean));
        const chosen = future().filter((item) => item.explicit && requested.has(address(item)));
        try {
            queue.remove(chosen);
            return {
                state: future().some((item) => item.explicit && requested.has(address(item))) ? 'uncertain' : 'done',
            };
        } catch {
            return { state: 'uncertain' };
        }
    }
    const target = path(request.urls[0]);
    if (!target || request.urls.length !== 1) return { state: 'unavailable' };
    const queued = () => future().some((item) => item.explicit && address(item) === target);
    const replacement = request.operation === 'add' ? request.replacement : undefined;
    const obsolete = new Set(replacement?.remove.map(path));
    const currentMatches = () =>
        !replacement ||
        (manager.getQueue() === queue &&
            path(manager.getCurrentSound()?.get('permalink_url')) === path(replacement.current));
    const queueMatches = () =>
        !replacement ||
        (currentMatches() && JSON.stringify(urls().map(path)) === JSON.stringify(replacement.expected.map(path)));
    if (replacement) {
        if (typeof queue.remove !== 'function') return { state: 'unsupported' };
        if (!path(replacement.current) || obsolete.has(null) || obsolete.has(target)) return { state: 'unavailable' };
        if (Date.now() >= request.expires || !queueMatches()) return { state: 'cancelled' };
    }
    const finishAdd = (): QueueResult => {
        if (!replacement)
            return { state: queued() || address(manager.getCurrentQueueItem()!) === target ? 'done' : 'uncertain' };
        const next = future().filter((item) => item.explicit);
        if (!currentMatches() || address(next.find((item) => !obsolete.has(address(item)))) !== target)
            return { state: 'uncertain', urls: urls() };
        try {
            queue.remove(next.filter((item) => obsolete.has(address(item))));
        } catch {
            return { state: 'uncertain', urls: urls() };
        }
        const remaining = urls();
        return {
            state:
                path(remaining[0]) === target && !remaining.some((url) => obsolete.has(path(url)))
                    ? 'done'
                    : 'uncertain',
            urls: remaining,
        };
    };
    if (request.operation === 'add' && queued()) return finishAdd();
    const Sound = exports.find(
        (value) =>
            (value as SoundClass)?.prototype?.resource_type === 'sound' &&
            typeof (value as SoundClass).resolve === 'function',
    ) as SoundClass | undefined;
    const filters = exports.find(
        (value) => typeof (value as { createSoundFilter?: unknown })?.createSoundFilter === 'function',
    ) as { createSoundFilter: () => (sound: Sound) => boolean } | undefined;
    const signup = exports.find(
        (value) => typeof (value as { playWithSignupWall?: unknown })?.playWithSignupWall === 'function',
    ) as { playWithSignupWall: (play: () => void) => unknown } | undefined;
    if (!Sound || !filters || (request.operation === 'play' && !signup)) return { state: 'unsupported' };
    const tickets = (page.__scRpcQueueTickets ||= new Map());
    const ticket = { cancelled: false };
    tickets.set(request.ticket, ticket);
    const active = () => !ticket.cancelled && tickets.get(request.ticket) === ticket && Date.now() < request.expires;
    let sound: Sound | undefined,
        held = false,
        acted = false;
    try {
        const [owner, slug] = target.slice(1).split('/');
        sound = await Promise.resolve(Sound.resolve(owner, slug));
        if (!active()) return { state: 'cancelled' };
        if (typeof sound?.hold !== 'function' || typeof sound.release !== 'function') return { state: 'unsupported' };
        sound.hold();
        held = true;
        if (!sound.get('policy') || !sound.get('state') || !sound.get('media')) await Promise.resolve(sound.fetch());
        if (!active()) return { state: 'cancelled' };
        if (
            path(sound.get('permalink_url')) !== target ||
            !sound.isPlayable() ||
            sound.isAd() ||
            !filters.createSoundFilter()(sound)
        )
            return { state: 'unavailable' };
        const layout = exports.find(
            (value) => typeof (value as { getCurrentLayoutInfo?: unknown })?.getCurrentLayoutInfo === 'function',
        ) as { getCurrentLayoutInfo: () => unknown } | undefined;
        const context = {
            restoreUrl: location.pathname + location.search,
            sourceInfo: {},
            layoutInfo: layout?.getCurrentLayoutInfo(),
        };
        if (request.operation === 'add') {
            if (!queueMatches()) return { state: 'cancelled' };
            if (!queued()) {
                acted = true;
                manager.addExplicitQueueItem(sound, sound, context);
            }
            return finishAdd();
        }
        let gateFailed = false;
        const previousSound = manager.getCurrentSound();
        const gate = signup!.playWithSignupWall(() => {
            if (!active()) return;
            acted = true;
            const queued = future().find((item) => item.explicit && address(item) === target);
            if (manager.getCurrentSound() === sound) manager.playCurrent({ userInitiated: true });
            else if (queued && manager.setCurrentItem) manager.setCurrentItem(queued, { userInitiated: true });
            else manager.playSource(sound!, sound!, context, { userInitiated: true });
        });
        void Promise.resolve(gate).catch(() => {
            gateFailed = true;
        });
        for (let n = 0; n < 20 && active(); n++) {
            const current = manager.getCurrentSound();
            if (
                acted &&
                current &&
                path(current.get('permalink_url')) === target &&
                (current !== previousSound || current.isPlaying() || current.isBuffering?.())
            )
                return { state: 'done' };
            if (gateFailed) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { state: acted ? 'uncertain' : 'unavailable' };
    } catch {
        return replacement && acted
            ? { state: 'uncertain', urls: urls() }
            : { state: acted ? 'uncertain' : 'unavailable' };
    } finally {
        ticket.cancelled = true;
        if (tickets.get(request.ticket) === ticket) tickets.delete(request.ticket);
        if (held) sound?.release();
    }
}

let sequence = 0;
const metrics = new WeakMap<
    WebContents,
    { calls: number; direct: number; fallbacks: number; uncertain: number; maxMs: number; last: string }
>();
export function nativeQueueDiagnostics(contents: WebContents): object {
    return { ...(metrics.get(contents) || { calls: 0, direct: 0, fallbacks: 0, uncertain: 0, maxMs: 0, last: '' }) };
}
export async function nativeQueueBridge(
    contents: WebContents,
    operation: QueueRequest['operation'],
    urls: string[],
    isActive = () => true,
): Promise<QueueResult> {
    if (!isActive() || contents.isDestroyed()) return { state: 'cancelled' };
    const stats = metrics.get(contents) || { calls: 0, direct: 0, fallbacks: 0, uncertain: 0, maxMs: 0, last: '' },
        started = Date.now();
    metrics.set(contents, stats);
    stats.calls++;
    const ticket = `queue-${Date.now()}-${sequence++}`;
    const request: QueueRequest = { operation, urls, ticket, expires: Date.now() + 4500 };
    let cancelled = false;
    const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        if (!contents.isDestroyed())
            void contents
                .executeJavaScript(
                    `window.__scRpcQueueTickets?.get(${JSON.stringify(ticket)}) && (window.__scRpcQueueTickets.get(${JSON.stringify(ticket)}).cancelled=true)`,
                )
                .catch(() => {});
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const interval = ['add', 'play'].includes(operation)
        ? setInterval(() => {
              if (!isActive()) cancel();
          }, 100)
        : undefined;
    interval?.unref();
    try {
        const result = await Promise.race([
            contents
                .executeJavaScript(
                    `(${nativeQueueModel.toString()})(${JSON.stringify(request)},${nativeRuntimeExports.toString()})`,
                    true,
                )
                .catch((): QueueResult => ({ state: 'uncertain' })),
            new Promise<QueueResult>((resolve) => {
                timeout = setTimeout(() => {
                    cancel();
                    resolve({ state: 'uncertain' });
                }, 5000);
                timeout.unref();
            }),
        ]);
        if (!isActive() || result?.state === 'uncertain') cancel();
        stats.last = operation + ':' + (result?.state || 'unsupported');
        if (result?.state === 'done') stats.direct++;
        else if (!result || result.state === 'unsupported') stats.fallbacks++;
        else if (result.state === 'uncertain') stats.uncertain++;
        stats.maxMs = Math.max(stats.maxMs, Date.now() - started);
        return !isActive()
            ? { state: 'cancelled' }
            : result && typeof result.state === 'string'
              ? result
              : { state: 'unsupported' };
    } finally {
        clearInterval(interval);
        clearTimeout(timeout);
    }
}
