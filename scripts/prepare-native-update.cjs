const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'native/tauri.conf.json'), 'utf8'));
const version = config.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Native release version must be a stable SemVer');
const bundle = path.join(
    root,
    `native/target/x86_64-pc-windows-msvc/release/bundle/nsis/${config.productName}_${version}_x64-setup.exe`,
);
const signature = fs.readFileSync(bundle + '.sig', 'utf8').trim();
if (!signature || signature.length > 4096) throw Error('Native updater signature is missing');
const output = path.join(root, 'build-native-release-' + version);
fs.mkdirSync(output, { recursive: true });
const name = `SoundCloud-${version}-x64-setup.exe`;
fs.copyFileSync(bundle, path.join(output, name));
fs.writeFileSync(path.join(output, name + '.sig'), signature + '\n');
const feed = {
    version,
    native: true,
    notes: 'SoundCloud for Windows.',
    pub_date: new Date().toISOString(),
    platforms: {
        'windows-x86_64': {
            signature,
            url: `https://github.com/rvelabs/soundcloud-rpc/releases/download/native-v${version}/${name}`,
        },
    },
};
for (const filename of [path.join(output, 'native-update.json'), path.join(root, 'docs/native-update.json')])
    fs.writeFileSync(filename, JSON.stringify(feed, null, 2) + '\n');
const hash = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), hash + '  ' + name + '\n');
process.stdout.write('Signed Native installer and update feed: ' + output + '\n');
