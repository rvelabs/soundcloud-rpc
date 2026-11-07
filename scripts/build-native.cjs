const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
Promise.all(
    ['index', 'smoke', 'settings', 'spotifyReader'].map((entry) =>
        esbuild.build({
            entryPoints: [path.join(root, `native/frontend/${entry}.ts`)],
            outfile: path.join(root, `native/assets/${entry === 'index' ? 'inject' : entry}.js`),
            bundle: true,
            platform: 'browser',
            target: 'chrome120',
            minify: true,
            legalComments: 'none',
            loader: { '.css': 'text' },
            plugins: [
                {
                    name: 'soundcloud-wave-ui',
                    setup(build) {
                        build.onResolve({ filter: /^soundcloud-builtin-plugin$/ }, () => ({
                            path: 'builtin',
                            namespace: 'soundcloud-builtin-plugin',
                        }));
                        build.onLoad({ filter: /.*/, namespace: 'soundcloud-builtin-plugin' }, () => ({
                            contents:
                                'const module={exports:{}};' +
                                fs.readFileSync(path.join(root, 'plugins/playback-speed.js'), 'utf8') +
                                ';export default module.exports;',
                            loader: 'js',
                        }));
                        build.onResolve({ filter: /^soundcloud-wave-ui$/ }, () => ({
                            path: 'inline',
                            namespace: 'soundcloud-wave-ui',
                        }));
                        build.onLoad({ filter: /.*/, namespace: 'soundcloud-wave-ui' }, () => ({
                            contents: `export function installWaveUI() { ${fs.readFileSync(path.join(root, 'src/wave/inline.js'), 'utf8')} }`,
                            loader: 'js',
                        }));
                    },
                },
            ],
            alias: {
                'node:util': path.join(root, 'native/frontend/equal.ts'),
                electron: path.join(root, 'native/frontend/platform.ts'),
            },
        }),
    ),
).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
