const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = path.resolve(root, '../rust-tools/native-signing');
const protectedKey = path.join(directory, 'updater.key.protected');
const publicKey = path.join(root, 'native/updater.pub');
function crypt(mode, input, output) {
    const script = `Add-Type -AssemblyName System.Security; $bytes=[IO.File]::ReadAllBytes($env:NATIVE_KEY_INPUT); if($env:NATIVE_KEY_MODE -eq 'protect') { $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes($env:NATIVE_KEY_OUTPUT,$result) } else { $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::OpenStandardOutput().Write($result,0,$result.Length) }`;
    const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, NATIVE_KEY_MODE: mode, NATIVE_KEY_INPUT: input, NATIVE_KEY_OUTPUT: output || '' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) throw Error('Windows could not protect/unprotect the Native update signing key');
    return result.stdout;
}
function initialize() {
    if (fs.existsSync(publicKey) || fs.existsSync(protectedKey)) {
        if (!fs.existsSync(publicKey) || !fs.existsSync(protectedKey))
            throw Error(
                'Native signing key is incomplete. Restore the existing key; automatic key rotation is disabled.',
            );
        return;
    }
    fs.mkdirSync(directory, { recursive: true });
    const stage = fs.mkdtempSync(path.join(directory, 'initialize-'));
    const plaintext = path.join(stage, 'updater.key');
    try {
        const packageCli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
        const cli =
            process.env.SOUNDCLOUD_TAURI_CLI ||
            (fs.existsSync(packageCli)
                ? packageCli
                : path.resolve(root, '../rust-tools/tauri-cli/node_modules/@tauri-apps/cli/tauri.js'));
        const generated = cp.spawnSync(
            process.execPath,
            [cli, 'signer', 'generate', '--ci', '--password', '', '--write-keys', plaintext],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        if (generated.status !== 0) throw Error('Tauri could not generate the Native signing key');
        const pub = fs.readFileSync(plaintext + '.pub');
        if (pub.length > 4096 || fs.statSync(plaintext).size > 16000) throw Error('Unexpected signing key format');
        crypt('protect', plaintext, protectedKey);
        fs.writeFileSync(publicKey, pub);
    } finally {
        for (const file of [plaintext, plaintext + '.pub']) if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(stage);
    }
}
function signingEnvironment() {
    if (process.env.TAURI_SIGNING_PRIVATE_KEY) return { ...process.env };
    if (!fs.existsSync(protectedKey))
        throw Error(
            'Native update signing key is unavailable. Supply TAURI_SIGNING_PRIVATE_KEY or restore the local protected key.',
        );
    return {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: crypt('unprotect', protectedKey).toString('utf8').trim(),
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    };
}
module.exports = { signingEnvironment };
if (require.main === module) {
    if (process.argv[2] !== 'initialize') throw Error('Use native-signing.cjs initialize');
    initialize();
    process.stdout.write('Native update signing key is ready; only the public key is in the repository.\n');
}
