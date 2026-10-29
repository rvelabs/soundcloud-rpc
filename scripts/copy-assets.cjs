const { cp, mkdir, readdir, rm } = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');
async function main() {
    await build({
        entryPoints: [path.join(root, 'src', 'preload.ts')],
        outfile: path.join(root, 'tsc', 'preload.js'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2020',
        external: ['electron'],
        sourcemap: true,
        legalComments: 'none',
    });
    const wave = path.join(root, 'tsc', 'wave');
    await mkdir(wave, { recursive: true });
    await cp(path.join(root, 'src', 'header'), path.join(root, 'tsc', 'header'), { recursive: true });
    await mkdir(path.join(root, 'tsc', 'settings'), { recursive: true });
    for (const name of ['settings.js', 'settings.css'])
        await cp(path.join(root, 'src', 'settings', name), path.join(root, 'tsc', 'settings', name));
    for (const name of await readdir(path.join(root, 'src', 'wave')))
        if (/\.(html|css|js)$/.test(name) && !/\.test\.js$/.test(name))
            await cp(path.join(root, 'src', 'wave', name), path.join(wave, name));
    for (const name of [
        'home.html',
        'home.js',
        'home.css',
        'homePreload.js',
        'homePreload.js.map',
        'metadata.html',
        'metadata.js',
        'nativeMetadata.js',
        'nativeMetadata.js.map',
    ])
        await rm(path.join(wave, name), { force: true });
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
