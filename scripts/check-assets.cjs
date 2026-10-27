const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = ['settings/settings.js', 'settings/settings.css'];
for (const folder of ['wave', 'header'])
    for (const name of fs.readdirSync(path.join(root, 'src', folder)))
        if (/\.(css|html|js)$/.test(name) && !/\.test\.js$/.test(name)) files.push(folder + '/' + name);
for (const file of files)
    assert(
        fs.readFileSync(path.join(root, 'src', file)).equals(fs.readFileSync(path.join(root, 'tsc', file))),
        `Stale asset: ${file}`,
    );
for (const file of ['wave/home.html', 'wave/home.js', 'wave/home.css', 'wave/metadata.html', 'wave/metadata.js'])
    assert(!fs.existsSync(path.join(root, 'tsc', file)), `Retired asset still copied: ${file}`);
for (const file of ['services/pluginWorker.js', 'storage/snapshotWorker.js', 'wave/playbackCoordinator.js'])
    assert(fs.existsSync(path.join(root, 'tsc', file)), `Runtime module missing: ${file}`);
console.log(JSON.stringify({ assetsVerified: files.length, workerEntries: 2, retiredAssetsAbsent: true }));
