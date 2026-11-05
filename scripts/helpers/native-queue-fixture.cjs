module.exports = function installNativeQueueFixture(ids) {
    const models = new Map();
    let current;
    const queue = {
        models: [],
        indexOf: (item) => queue.models.indexOf(item),
        remove(items) {
            queue.models = queue.models.filter((item) => !items.includes(item));
            render();
        },
    };
    window.fixtureApiCalls = { add: 0, play: 0, list: 0, dom: 0 };
    function Sound(slug) {
        this.slug = slug;
        this.held = 0;
    }
    Sound.prototype.resource_type = 'sound';
    Sound.prototype.get = function (key) {
        return {
            permalink_url: 'https://soundcloud.com/artist/' + this.slug,
            policy: 'ALLOW',
            state: 'finished',
            media: { transcodings: [] },
        }[key];
    };
    Sound.prototype.hold = function () {
        this.held++;
    };
    Sound.prototype.release = function () {
        this.held--;
        if (this.held < 0) throw Error('Unbalanced model lifetime');
    };
    Sound.prototype.isPlayable = () => true;
    Sound.prototype.isAd = () => false;
    Sound.prototype.isPlaying = function () {
        return current?.sound === this && !audio.paused;
    };
    Sound.prototype.fetch = async () => {};
    Sound.resolve = async (owner, slug) => {
        if (owner !== 'artist' || !ids.includes(slug)) throw Error('Unknown track');
        if (!models.has(slug)) models.set(slug, new Sound(slug));
        return models.get(slug);
    };
    function render() {
        const node = document.querySelector('.queue__itemsContainer');
        node.replaceChildren();
        for (const item of queue.models.slice(queue.indexOf(current) + 1)) {
            const row = document.createElement('li');
            row.className = 'queueItemView';
            const link = document.createElement('a');
            link.href = item.sound.get('permalink_url');
            link.textContent = item.sound.slug;
            const remove = document.createElement('button');
            remove.className = 'queueItemView__remove';
            remove.onclick = () => queue.remove([item]);
            row.append(link, remove);
            node.append(row);
        }
    }
    const manager = {
        getQueue() {
            fixtureApiCalls.list++;
            return queue;
        },
        getCurrentQueueItem: () => current,
        getCurrentSound: () => current?.sound,
        setCurrentItem(item) {
            current = item;
            playTrack(item.sound.slug);
            render();
        },
        addExplicitQueueItem(source, sound) {
            if (source !== sound) throw Error('Expected track source');
            fixtureApiCalls.add++;
            queue.models.push({ sound, explicit: true });
            render();
        },
        playSource(source, sound) {
            if (source !== sound) throw Error('Expected track source');
            fixtureApiCalls.play++;
            const future = queue.models
                .slice(queue.indexOf(current) + 1)
                .filter((item) => item.explicit && item.sound !== sound);
            current = { sound, explicit: false };
            queue.models = [current, ...future];
            playTrack(sound.slug);
            render();
        },
        playCurrent() {
            if (audio.paused) {
                void audio.play();
                document.querySelector('.playControls__play').classList.add('playing');
            }
        },
    };
    window.nextQueued = () => {
        const next = queue.models[queue.indexOf(current) + 1];
        if (next) {
            current = next;
            playTrack(next.sound.slug);
            render();
        }
    };
    for (const button of document.querySelectorAll('.playButton,.sc-button-more'))
        button.onclick = () => {
            fixtureApiCalls.dom++;
            throw Error('Legacy navigation unexpectedly used');
        };
    window.__scRpcModules = [
        {
            c: {
                sound: { exports: Sound },
                manager: { exports: manager },
                filters: { exports: { createSoundFilter: () => (sound) => sound.isPlayable() } },
                signup: { exports: { playWithSignupWall: (play) => play() } },
            },
            m: {},
        },
    ];
};
