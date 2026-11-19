const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'mobile/gen/android/app/src/main/assets');
fs.mkdirSync(output, { recursive: true });
const resolve = (file) => path.join(root, file);
const options = {
    bundle: true, platform: 'browser', target: 'chrome110', minify: true, legalComments: 'none',
    loader: { '.css': 'text' },
    alias: { 'node:util': resolve('native/frontend/equal.ts'), electron: resolve('native/frontend/platform.ts') },
    plugins: [{
        name: 'android-platform',
        setup(build) {
            build.onResolve({ filter: /nativeQueueBridge$/ }, () => ({ path: resolve('mobile/frontend/nativeQueue.ts') }));
            build.onResolve({ filter: /nativePlayerBridge$/ }, () => ({ path: resolve('mobile/frontend/nativePlayer.ts') }));
            build.onResolve({ filter: /^soundcloud-wave-ui$/ }, () => ({ path: 'wave', namespace: 'android' }));
            build.onLoad({ filter: /.*/, namespace: 'android' }, () => ({
                contents: 'export function installWaveUI(){' + fs.readFileSync(resolve('src/wave/inline.js'), 'utf8') + '}',
                loader: 'js',
            }));
        },
    }],
};
Promise.all([
    esbuild.build({ ...options, entryPoints: [resolve('mobile/frontend/settings.ts')], outfile: path.join(output, 'android-settings.js') }),
    esbuild.build({ ...options, entryPoints: [resolve('src/import/spotifySnapshot.ts')], globalName: 'SoundCloudSpotify', format: 'iife', outfile: path.join(output, 'android-spotify.js') }),
    esbuild.build({ ...options, entryPoints: [resolve('mobile/frontend/bootstrap.ts')], outfile: path.join(output, 'android-bootstrap.js') }),
    esbuild.build({ ...options, entryPoints: [resolve('mobile/frontend/inject.ts')], outfile: path.join(output, 'android-inject.js') }),
]).then(() => {
    fs.copyFileSync(resolve('mobile/frontend/fixture.html'), path.join(output, 'android-fixture.html'));
    fs.copyFileSync(resolve('mobile/frontend/settings.html'), path.join(output, 'android-settings.html'));
}).catch((error) => { console.error(error); process.exitCode = 1; });
