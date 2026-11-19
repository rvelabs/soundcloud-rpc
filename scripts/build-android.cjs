const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const mobile = path.join(root, 'mobile');
const project = path.join(mobile, 'gen/android');
const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : 'aarch64';
if (!['aarch64', 'x86_64'].includes(target)) throw new Error('Supported Android targets: aarch64, x86_64');
const release = args.includes('--release');
const profile = release ? 'release' : 'debug';
const windows = process.platform === 'win32';
const ndk = process.env.NDK_HOME;
if (!ndk || !fs.existsSync(ndk)) throw new Error('Set NDK_HOME to Android NDK 27.2.12479018');
const host = windows ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const bin = path.join(ndk, 'toolchains/llvm/prebuilt', host, 'bin');
const triple = `${target}-linux-android`;
const key = triple.replaceAll('-', '_');
const env = {
    ...process.env,
    [`CC_${key}`]: path.join(bin, `${triple}26-clang${windows ? '.cmd' : ''}`),
    [`AR_${key}`]: path.join(bin, `llvm-ar${windows ? '.exe' : ''}`),
    [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: path.join(bin, `${triple}26-clang${windows ? '.cmd' : ''}`),
    [`CARGO_TARGET_${key.toUpperCase()}_RUSTFLAGS`]:
        '-Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES -Clink-arg=-Wl,-z,max-page-size=16384',
    WRY_ANDROID_PACKAGE: 'io.rvelabs.soundcloud.android',
    WRY_ANDROID_LIBRARY: 'soundcloud_mobile_lib',
    WRY_ANDROID_KOTLIN_FILES_OUT_DIR: path.join(project, 'build/generated-wry'),
    TAURI_ANDROID_PROJECT_PATH: project,
};
function run(command, values, cwd = root) {
    const result = spawnSync(command, values, { cwd, env, stdio: 'inherit', shell: windows && /\.bat$/.test(command) });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
fs.mkdirSync(env.WRY_ANDROID_KOTLIN_FILES_OUT_DIR, { recursive: true });
run(process.execPath, [path.join(__dirname, 'build-mobile.cjs')]);
run('cargo', [
    'build',
    '--manifest-path',
    path.join(mobile, 'Cargo.toml'),
    '--lib',
    '--target',
    triple,
    ...(release ? ['--release'] : []),
]);
const version = JSON.parse(fs.readFileSync(path.join(mobile, 'tauri.conf.json'), 'utf8')).version;
const [major, minor, patch] = version.split('.').map(Number);
fs.writeFileSync(path.join(project, 'tauri.settings.gradle'), '// Android uses MainActivity and its own JNI bridge.\n');
fs.writeFileSync(
    path.join(project, 'app/tauri.build.gradle.kts'),
    '// No Tauri WebView activity or plugin runtime is used.\n',
);
fs.writeFileSync(
    path.join(project, 'app/tauri.properties'),
    `tauri.android.versionName=${version}\ntauri.android.versionCode=${major * 1000000 + minor * 1000 + patch}\n`,
);
const abi = target === 'aarch64' ? 'arm64-v8a' : 'x86_64';
const flavor = target === 'aarch64' ? 'Arm64' : 'X86_64';
const output = path.join(project, 'app/src/main/jniLibs', abi, 'libsoundcloud_mobile_lib.so');
fs.mkdirSync(path.dirname(output), { recursive: true });
// Replace any old build-system symlink with a regular packaged copy.
try {
    if (fs.lstatSync(output).isSymbolicLink()) fs.unlinkSync(output);
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
fs.copyFileSync(path.join(mobile, 'target', triple, profile, path.basename(output)), output);
run(path.join(bin, `llvm-strip${windows ? '.exe' : ''}`), ['--strip-unneeded', output]);
if (!args.includes('--native-only')) {
    const task = `:app:assemble${flavor}${release ? 'Release' : 'Debug'}`;
    run(path.join(project, windows ? 'gradlew.bat' : 'gradlew'), [
        '-p',
        project,
        task,
        '-PrustPrebuilt=true',
        `-ParchList=${flavor.toLowerCase()}`,
        `-PtargetList=${target}`,
        '--console=plain',
    ]);
}
