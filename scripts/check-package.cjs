const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const packed = path.resolve(root, process.argv[2] || 'build/win-unpacked');
const output = path.join(root, 'build-package-check', String(Date.now()));
const archive = path.join(packed, 'resources', 'app.asar');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const originalHash = digest(fs.readFileSync(archive));
const entries = asar.listPackage(archive).map((name) => name.replaceAll('\\', '/').replace(/^\//, ''));
const files = entries.filter(
    (name) => name.startsWith('tsc/') && !asar.statFile(archive, path.join(...name.split('/'))).files,
);
for (const name of files) {
    assert(!/\.test\.js(?:\.map)?$/.test(name), 'Test file in package: ' + name);
    assert(fs.existsSync(path.join(root, name)), 'Unexpected compiled file: ' + name);
    assert.equal(
        digest(asar.extractFile(archive, path.join(...name.split('/')))),
        digest(fs.readFileSync(path.join(root, name))),
        name,
    );
}
for (const name of [
    'storage/snapshotWorker.js',
    'services/pluginWorker.js',
    'settings/settings.js',
    'settings/settings.css',
])
    assert(files.includes('tsc/' + name), 'Missing runtime asset: ' + name);
assert(!entries.some((name) => /^tsc\/wave\/(home\.|homePreload\.|metadata\.|nativeMetadata\.)/.test(name)));
const relay = path.join(packed, 'resources', 'soundcloud-relay');
for (const name of ['protocol.mjs', 'worker.mjs', 'playlist-source.mjs', 'wrangler.toml'])
    assert.equal(
        digest(fs.readFileSync(path.join(relay, name))),
        digest(fs.readFileSync(path.join(root, 'cloudflare/soundcloud-relay', name))),
        'Relay asset: ' + name,
    );
assert.equal(
    digest(fs.readFileSync(path.join(relay, 'README.md'))),
    digest(fs.readFileSync(path.join(root, 'README.md'))),
);
async function main() {
    const copy = path.join(output, 'application');
    const stage = path.join(output, 'stage');
    fs.mkdirSync(output, { recursive: true });
    fs.cpSync(packed, copy, { recursive: true });
    asar.extractAll(archive, stage);
    const metadataFile = path.join(stage, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    metadata.main = 'qa-bootstrap.cjs';
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    fs.writeFileSync(
        path.join(stage, 'qa-bootstrap.cjs'),
        `require(${JSON.stringify(path.join(root, 'scripts/check-minimized-start.cjs'))});`,
    );
    const qaArchive = path.join(copy, 'resources', 'app.asar');
    fs.unlinkSync(qaArchive);
    await asar.createPackage(stage, qaArchive);
    const env = {
        ...process.env,
        WAVE_TEST_REPO: qaArchive,
        WAVE_TEST_OUTPUT: output,
        WAVE_TEST_GRACEFUL: '1',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(path.join(copy, 'SoundCloud.exe'), [], {
        cwd: root,
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(output, 'stdout.log'), result.stdout || '');
    fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr || '');
    assert.equal(result.status, 0, (result.stderr || result.error?.message || '').slice(-6000));
    const profile = fs.readdirSync(output).find((name) => name.startsWith('minimized-start-'));
    assert(profile, 'Isolated test profile created');
    assert(fs.existsSync(path.join(output, profile, 'library.key')), 'Storage encryption key created');
    assert.equal(
        fs
            .readFileSync(path.join(output, profile, 'library.data'))
            .subarray(0, 4)
            .toString(),
        'SC01',
    );
    const Conf = require('conf');
    const savedConfig = new Conf({ cwd: path.join(output, profile), encryptionKey: 'soundcloud-rpc-config' }).store;
    assert(!savedConfig.waveFeedbackV1_default, 'Legacy feedback removed after durable migration');
    assert.equal(digest(fs.readFileSync(archive)), originalHash, 'Release archive remains unchanged');
    const report = {
        version: metadata.version,
        compiledFilesVerified: files.length,
        minimizedPlayback: true,
        gracefulExit: true,
        durableMigration: true,
        originalArchiveHash: originalHash,
    };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output }));
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
