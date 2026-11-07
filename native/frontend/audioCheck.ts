import { Wave } from './wave';
import { Profile, invoke } from './bridge';
import { TaskbarBridge } from './taskbar';
import { AudioAnalysisCache } from '../../src/wave/audioAnalysisCache';
import { SoundCloudRecommender } from '../../src/wave/recommendation/soundcloudAdapter';
import { installAudioFeatureCapture } from '../../src/wave/audioFeatureCapture';
import type { WaveCandidate } from '../../src/wave/waveEngine';

export async function checkAudio(wave: Wave, media: HTMLAudioElement, getLiked: () => boolean): Promise<object> {
    const assert = (value: unknown, message: string) => {
        if (!value) throw Error(message);
    };
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const profile = new Profile('settings');
    await profile.load();
    const candidate: WaveCandidate = {
        url: 'https://soundcloud.com/test/track-34',
        title: 'Synthetic test tone',
        artist: 'Test',
        durationSeconds: 45,
        genre: 'house',
        source: 'personal',
        sourceRank: 0,
        playability: 'available',
        metadataChecked: true,
    };
    const recommender = new SoundCloudRecommender(profile, 'audio-smoke', async () => []);
    const analysis = new AudioAnalysisCache(profile, 'audio-smoke');
    Object.assign(wave, {
        active: false,
        recommender,
        profile,
        analysis,
        candidates: new Map([[candidate.url, candidate]]),
        current: undefined,
        refill: async () => {},
    });
    const page = window as unknown as { soundcloudAPI: object; __soundcloudNative: object };
    page.soundcloudAPI = {
        sendAudioFeatures: (value: unknown) => wave.audio(value),
        sendAudioAnalysisStatus: (value: unknown) => wave.audioStatus(value),
    };
    const commands: string[] = [];
    page.__soundcloudNative = {
        control: (action: string) => {
            commands.push(action);
            wave.control(action);
        },
    };
    const taskbar = new TaskbarBridge(undefined, () => 'en');
    const unbind = wave.events.on('track', (value) => taskbar.observe(value));
    const observe = (wave as unknown as { observe: (value: object) => void }).observe.bind(wave);
    const observeFrame = () => {
        const position = Math.floor(media.currentTime);
        observe({
            url: candidate.url,
            title: candidate.title,
            author: candidate.artist,
            isPlaying: !media.paused,
            isLiked: getLiked(),
            elapsed: `${Math.floor(position / 60)}:${String(position % 60).padStart(2, '0')}`,
            duration: '0:45',
        });
    };
    wave.events.emit('stats', { heard: 0, liked: 0 });
    assert(document.querySelector('.cw-kicker')?.textContent?.includes('0'), 'zero heard count is visible');
    const sampleRate = 16000,
        duration = 45,
        bytes = new Uint8Array(44 + sampleRate * duration * 2),
        view = new DataView(bytes.buffer);
    const text = (at: number, value: string) =>
        [...value].forEach((char, index) => (bytes[at + index] = char.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, bytes.length - 44, true);
    for (let index = 0; index < sampleRate * duration; index++)
        view.setInt16(
            44 + index * 2,
            Math.round(
                32767 *
                    (0.3 * Math.sin((2 * Math.PI * 120 * index) / sampleRate) +
                        0.1 * Math.sin((2 * Math.PI * 5000 * index) / sampleRate)),
            ),
            true,
        );
    const source = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const context = new AudioContext();
    const node = context.createMediaElementSource(media),
        silence = context.createGain();
    silence.gain.value = 0;
    node.connect(silence);
    silence.connect(context.destination);
    installAudioFeatureCapture();
    media.muted = false;
    media.src = source;
    observeFrame();
    await media.play();
    await context.resume();
    observeFrame();
    const timer = setInterval(observeFrame, 1000);
    try {
        const initialAnalysis = document.querySelector<HTMLElement>('.cw-analysis')!;
        assert(initialAnalysis.hidden, 'background measurement has no visible progress panel');
        await wait(150);
        await invoke('taskbar_exercise', { action: 'like' });
        await wait(150);
        observeFrame();
        let host = await invoke<{
            taskbar: {
                state: { liked: boolean; playing: boolean };
                native: { installed: boolean; registered: boolean; commands: number; error?: string };
            };
        }>('native_diagnostics');
        assert(
            host.taskbar.native.installed && host.taskbar.state.liked === getLiked(),
            'real Windows hook receives like state',
        );
        await invoke('taskbar_exercise', { action: 'toggle' });
        await wait(150);
        observeFrame();
        assert(media.paused, 'taskbar callback pauses the real media element');
        await invoke('taskbar_exercise', { action: 'toggle' });
        await wait(150);
        observeFrame();
        assert(!media.paused, 'taskbar callback resumes the real media element');
        const deadline = performance.now() + 37000;
        while (!analysis.get(candidate) && performance.now() < deadline) await wait(250);
        const features = analysis.get(candidate);
        assert(
            features?.source === 'media-element-v1' && features.sampleSeconds! >= 30,
            'at least 30 seconds of real audio are measured',
        );
        assert(
            features!.energy! > 0.1 && features!.energy! < 0.4 && features!.bass! > 0.2,
            'measured PCM energy and spectrum match the generated signal',
        );
        assert(
            context.state === 'running' && node.numberOfOutputs === 1 && !media.paused,
            'analysis releases its own tap without stopping the player graph',
        );
        assert(
            recommender.stats().heard === 1 && document.querySelector('.cw-kicker')?.textContent?.includes('1'),
            'heard count advances during confirmed playback',
        );
        const analysisLabel = document.querySelector<HTMLElement>('.cw-analysis')!;
        assert(
            !analysisLabel.hidden && analysisLabel.textContent?.includes('1'),
            'completed analysis count is visible',
        );
        assert(!analysisLabel.textContent?.includes('30'), 'background analysis does not expose a seconds progress');
        await profile.flush(true);
        const reopened = new Profile('settings');
        await reopened.load();
        assert(
            new AudioAnalysisCache(reopened, 'audio-smoke').get(candidate)?.source === 'media-element-v1',
            'measured audio survives durable save and reload',
        );
        assert(
            new SoundCloudRecommender(reopened, 'audio-smoke', async () => []).stats().heard === 1,
            'listening evidence survives reload',
        );
        const persistedTaste = new SoundCloudRecommender(reopened, 'audio-smoke', async () => []).diagnostics() as {
            measuredFeedback: number;
        };
        assert(persistedTaste.measuredFeedback > 0, 'measured sound participates in persisted preference events');
        host = await invoke<typeof host>('native_diagnostics');
        assert(
            host.taskbar.native.commands >= 3 &&
                commands.includes('like') &&
                commands.filter((command) => command === 'toggle').length === 2,
            'Win32 thumbnail command routing reaches native player actions',
        );
        return {
            learningOutsideWave: !wave.active,
            features,
            taskbar: host.taskbar,
            heard: recommender.stats().heard,
            measuredFeedback: persistedTaste.measuredFeedback,
        };
    } finally {
        clearInterval(timer);
        unbind();
        taskbar.clear();
        wave.stop();
        media.pause();
        node.disconnect();
        silence.disconnect();
        await context.close();
        URL.revokeObjectURL(source);
    }
}
