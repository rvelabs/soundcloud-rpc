const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'native/tauri.conf.json'), 'utf8'));
if (config.plugins.updater.pubkey !== fs.readFileSync(path.join(root, 'native/updater.pub'), 'utf8').trim())
    throw Error('The embedded Native updater key does not match updater.pub');
const directory = path.join(root, 'build-native-release-' + config.version);
const name = `SoundCloud-${config.version}-x64-setup.exe`;
const file = path.join(directory, name);
const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim() !== `${hash}  ${name}`)
    throw Error('Native installer checksum mismatch');
const feed = JSON.parse(fs.readFileSync(path.join(directory, 'native-update.json'), 'utf8'));
const platform = feed.platforms['windows-x86_64'];
if (
    feed.version !== config.version ||
    feed.native !== true ||
    platform.signature !== fs.readFileSync(file + '.sig', 'utf8').trim() ||
    platform.url !== `https://github.com/rvelabs/soundcloud-rpc/releases/download/native-v${config.version}/${name}`
)
    throw Error('The Native feed does not match its signed package');
const result = cp.spawnSync(
    'cargo',
    [
        'test',
        '--locked',
        '--config',
        'native/.cargo/config.toml',
        '--manifest-path',
        'native/Cargo.toml',
        '--test',
        'release_signature',
        '--',
        '--ignored',
    ],
    {
        cwd: root,
        windowsHide: true,
        stdio: 'inherit',
        env: { ...process.env, SOUNDCLOUD_NATIVE_SIGNED_PACKAGE: file },
    },
);
if (result.error || result.status !== 0) throw Error('Native installer signature/version verification failed');
fs.writeFileSync(
    path.join(directory, 'signature-verification.json'),
    JSON.stringify(
        {
            version: config.version,
            sha256: hash,
            signatureValid: true,
            signedVersionMatches: true,
            tamperRejected: true,
            feedMatches: true,
        },
        null,
        2,
    ) + '\n',
);
process.stdout.write('Native package checksum, signature and signed version are valid.\n');
