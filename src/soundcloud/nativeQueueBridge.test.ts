import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { nativeQueueModel, type QueueRequest, type QueueResult } from './nativeQueueBridge';
function fixture() {
    let current: { sound: Sound; explicit: boolean } | undefined,
        writes = 0,
        throwAfterAdd = false;
    const models = new Map<string, Sound>();
    class Sound {
        held = 0;
        constructor(public slug: string) {}
        get(key: string): unknown {
            return (
                {
                    permalink_url: 'https://soundcloud.com/artist/' + this.slug,
                    policy: this.slug === 'blocked' ? 'SNIP' : 'ALLOW',
                    state: 'finished',
                    media: { transcodings: [] },
                } as Record<string, unknown>
            )[key];
        }
        hold() {
            this.held++;
        }
        release() {
            this.held--;
        }
        async fetch() {}
        isAd() {
            return false;
        }
        isPlayable() {
            return true;
        }
        isPlaying() {
            return current?.sound === this;
        }
        static async resolve(_owner: string, slug: string) {
            if (!models.has(slug)) models.set(slug, new Sound(slug));
            return models.get(slug)!;
        }
    }
    Object.assign(Sound.prototype, { resource_type: 'sound' });
    const queue = {
        models: [] as { sound: Sound; explicit: boolean }[],
        indexOf: (item: unknown) => queue.models.indexOf(item as never),
        remove: (items: unknown[]) => {
            queue.models = queue.models.filter((item) => !items.includes(item));
        },
    };
    const manager = {
        getQueue: () => queue,
        getCurrentQueueItem: () => current,
        getCurrentSound: () => current?.sound,
        setCurrentItem(item: { sound: Sound; explicit: boolean }) {
            current = item;
            writes++;
        },
        playCurrent() {},
        playSource(_source: Sound, sound: Sound) {
            current = { sound, explicit: false };
            queue.models.unshift(current);
            writes++;
        },
        addExplicitQueueItem(_source: Sound, sound: Sound) {
            queue.models.push({ sound, explicit: true });
            writes++;
            if (throwAfterAdd) throw Error('Lost acknowledgement');
        },
    };
    const exports = [
        Sound,
        manager,
        { createSoundFilter: () => (sound: Sound) => sound.slug !== 'blocked' },
        { playWithSignupWall: (play: () => void) => play() },
    ];
    const window: { __scRpcQueueTickets?: Map<string, { cancelled: boolean }> } = {};
    let serial = 0;
    const run = (
        operation: QueueRequest['operation'],
        slugs: string[],
        expires = Date.now() + 5000,
        replacement?: QueueRequest['replacement'],
    ): Promise<QueueResult> =>
        runInNewContext(`(${nativeQueueModel.toString()})(request,()=>exports)`, {
            request: {
                operation,
                urls: slugs.map((slug) => 'https://soundcloud.com/artist/' + slug),
                ticket: 't' + serial++,
                expires,
                replacement,
            },
            exports,
            window,
            location: { pathname: '/discover', search: '' },
            URL,
            Date,
            Map,
            Set,
            setTimeout,
        });
    return {
        run,
        queue,
        models,
        window,
        Sound,
        writes: () => writes,
        advance: () => manager.setCurrentItem(queue.models[1]),
        setThrow: () => {
            throwAfterAdd = true;
        },
    };
}
describe('native model queue adapter', () => {
    const url = (slug: string) => 'https://soundcloud.com/artist/' + slug;
    const replace = (expected: string[], remove: string[]) => ({
        current: url('one'),
        expected: expected.map(url),
        remove: remove.map(url),
    });
    it('keeps the existing queue until a new replacement is confirmed', async () => {
        const f = fixture();
        await f.run('play', ['one']);
        await f.run('add', ['two']);
        await f.run('add', ['three']);
        const plan = replace(['two', 'three'], ['two', 'three']);
        expect((await f.run('add', ['blocked'], undefined, plan)).state).toBe('unavailable');
        expect((await f.run('list', [])).urls).toEqual([url('two'), url('three')]);
        expect(await f.run('add', ['fresh'], undefined, plan)).toEqual({ state: 'done', urls: [url('fresh')] });
        expect(f.queue.models.map((item) => item.sound.slug)).toEqual(['one', 'fresh']);
    });
    it('promotes a ready replacement without resolving it again', async () => {
        const f = fixture();
        await f.run('play', ['one']);
        await f.run('add', ['two']);
        await f.run('add', ['three']);
        f.Sound.resolve = async () => {
            throw Error('No network');
        };
        expect(await f.run('add', ['three'], undefined, replace(['two', 'three'], ['two']))).toEqual({
            state: 'done',
            urls: [url('three')],
        });
    });
    it('aborts a replacement if playback or manual Next Up changes while resolving it', async () => {
        for (const change of ['manual', 'advance']) {
            const f = fixture();
            await f.run('play', ['one']);
            await f.run('add', ['two']);
            let resolve!: (sound: InstanceType<typeof f.Sound>) => void;
            f.Sound.resolve = () =>
                new Promise((done) => {
                    resolve = done;
                });
            const pending = f.run('add', ['fresh'], undefined, replace(['two'], ['two']));
            if (change === 'manual') f.queue.models.push({ sound: new f.Sound('manual'), explicit: true });
            else f.advance();
            resolve(new f.Sound('fresh'));
            expect((await pending).state).toBe('cancelled');
            expect(f.queue.models.map((item) => item.sound.slug)).toEqual(
                change === 'manual' ? ['one', 'two', 'manual'] : ['one', 'two'],
            );
        }
    });
    it('starts and queues tracks without DOM, deduplicates them, and preserves current playback on removal', async () => {
        const f = fixture();
        expect((await f.run('play', ['one'])).state).toBe('done');
        expect((await f.run('add', ['two'])).state).toBe('done');
        await f.run('add', ['two']);
        await f.run('add', ['user']);
        expect(f.writes()).toBe(3);
        expect((await f.run('list', [])).urls).toEqual([
            'https://soundcloud.com/artist/two',
            'https://soundcloud.com/artist/user',
        ]);
        await f.run('remove', ['one', 'two']);
        expect(f.queue.models.map((item) => item.sound.slug)).toEqual(['one', 'user']);
        expect([...f.models.values()].every((model) => model.held === 0)).toBe(true);
    });
    it('honors native track filtering before touching the queue', async () => {
        const f = fixture();
        expect((await f.run('add', ['blocked'])).state).toBe('unavailable');
        expect(f.writes()).toBe(0);
    });
    it('plays a committed queue entry without creating a second copy', async () => {
        const f = fixture();
        await f.run('play', ['one']);
        await f.run('add', ['two']);
        await f.run('add', ['three']);
        expect((await f.run('play', ['two'])).state).toBe('done');
        expect(f.queue.models.filter((item) => item.sound.slug === 'two')).toHaveLength(1);
        expect((await f.run('list', [])).urls).toEqual(['https://soundcloud.com/artist/three']);
    });
    it('distinguishes preloaded automatic candidates from committed Next Up entries', async () => {
        const f = fixture();
        await f.run('play', ['one']);
        f.queue.models.push({ sound: new f.Sound('two'), explicit: false });
        expect((await f.run('list', [])).urls).toEqual([]);
        await f.run('add', ['two']);
        expect(f.writes()).toBe(2);
        expect((await f.run('list', [])).urls).toEqual(['https://soundcloud.com/artist/two']);
    });
    it('cancels a pending resolution and never performs its late mutation', async () => {
        const f = fixture();
        let resolve!: (sound: InstanceType<typeof f.Sound>) => void;
        f.Sound.resolve = () =>
            new Promise((done) => {
                resolve = done;
            });
        const pending = f.run('add', ['late']);
        f.window.__scRpcQueueTickets!.get('t0')!.cancelled = true;
        resolve(new f.Sound('late'));
        expect((await pending).state).toBe('cancelled');
        expect(f.writes()).toBe(0);
    });
    it('reports an uncertain mutation and recognizes its result without adding a duplicate', async () => {
        const f = fixture();
        f.setThrow();
        expect((await f.run('add', ['one'])).state).toBe('uncertain');
        expect((await f.run('add', ['one'])).state).toBe('done');
        expect(f.writes()).toBe(1);
    });
    it('does not mutate when the operation deadline has expired', async () => {
        const f = fixture();
        expect((await f.run('play', ['late'], Date.now() - 1)).state).toBe('cancelled');
        expect(f.writes()).toBe(0);
    });
});
