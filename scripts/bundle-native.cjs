const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { signingEnvironment } = require('./native-signing.cjs');
const root = path.resolve(__dirname, '..');
const packageCli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const localCli = fs.existsSync(packageCli)
    ? packageCli
    : path.resolve(root, '../rust-tools/tauri-cli/node_modules/@tauri-apps/cli/tauri.js');
const cli = process.env.SOUNDCLOUD_TAURI_CLI || localCli;
if (!fs.existsSync(cli)) throw Error('Install @tauri-apps/cli@2 and set SOUNDCLOUD_TAURI_CLI to its tauri.js path');
const result = cp.spawnSync(
    process.execPath,
    [cli, 'build', '--ci', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis'],
    {
        cwd: path.join(root, 'native'),
        env: signingEnvironment(),
        windowsHide: true,
        stdio: 'inherit',
    },
);
process.exitCode = result.status ?? 1;
if (result.status === 0) {
    require('./prepare-native-update.cjs');
    require('./check-native-package.cjs');
}
