import { api, Profile } from './bridge';
import { deletePlaylist } from './playlists';

export interface ExpiringPlaylist {
    id: number;
    title: string;
    tracks: number[];
    deleteAt: number;
    failures?: number;
}
type Store = Pick<Profile, 'get' | 'set' | 'flush'>;
const key = 'trackPlaylistExpiryV1';
const valid = (entry: ExpiringPlaylist) =>
    entry &&
    Number.isSafeInteger(entry.id) &&
    entry.id > 0 &&
    typeof entry.title === 'string' &&
    entry.title.length <= 100 &&
    Array.isArray(entry.tracks) &&
    entry.tracks.length > 0 &&
    entry.tracks.length <= 40 &&
    entry.tracks.every((id) => Number.isSafeInteger(id) && id > 0) &&
    Number.isFinite(entry.deleteAt) &&
    entry.deleteAt > 0 &&
    (entry.failures === undefined || (Number.isInteger(entry.failures) && entry.failures >= 0 && entry.failures < 5));

/** Separate account-scoped storage never rewrites My Wave's in-memory preference profile. */
export class PlaylistExpiry {
    private sweeping?: Promise<number>;
    constructor(
        private owner: number,
        private store: Store,
        private remove = (entry: ExpiringPlaylist, allowed: () => boolean) =>
            deletePlaylist(entry.id, owner, api, undefined, entry, allowed),
        private currentOwner = async () => Number((await api('me')).id),
        private now = Date.now,
    ) {}
    private entries(): ExpiringPlaylist[] {
        const entries = this.store.get(key, []);
        return Array.isArray(entries)
            ? entries
                  .filter(valid)
                  .slice(-100)
                  .map((item) => structuredClone(item))
            : [];
    }
    private async save(entries: ExpiringPlaylist[]): Promise<void> {
        this.store.set(key, entries);
        await this.store.flush(true);
    }
    async schedule(entry: ExpiringPlaylist): Promise<void> {
        if (!valid(entry)) throw Error('Invalid playlist expiry');
        await this.save([...this.entries().filter((item) => item.id !== entry.id), entry].slice(-100));
    }
    async keep(id: number): Promise<void> {
        await this.save(this.entries().filter((item) => item.id !== id));
    }
    sweep(active = () => true): Promise<number> {
        if (this.sweeping) return this.sweeping;
        const task = this.run(active).finally(() => {
            this.sweeping = undefined;
        });
        this.sweeping = task;
        return task;
    }
    private async run(active: () => boolean): Promise<number> {
        const due = this.entries()
            .filter((entry) => entry.deleteAt <= this.now())
            .slice(0, 5);
        let deleted = 0;
        for (const entry of due) {
            if (!active() || (await this.currentOwner()) !== this.owner || !active()) break;
            // Re-read the entry after asynchronous reads so clicking Keep wins over a pending sweep.
            if (!this.entries().some((current) => current.id === entry.id && current.deleteAt === entry.deleteAt))
                continue;
            try {
                if (
                    await this.remove(
                        entry,
                        () =>
                            active() &&
                            this.entries().some((item) => item.id === entry.id && item.deleteAt === entry.deleteAt),
                    )
                )
                    deleted++;
                await this.keep(entry.id); // missing or edited playlists are also kept permanently
            } catch (error) {
                if (!active() || (await this.currentOwner()) !== this.owner) break;
                const current = this.entries().find((item) => item.id === entry.id);
                if (!current) continue;
                const failures = (current.failures || 0) + 1;
                if (failures >= 5) await this.keep(entry.id);
                else await this.schedule({ ...current, failures });
                console.debug('Playlist expiry deferred', error);
            }
        }
        return deleted;
    }
}
