const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executable = require('electron');
const directory = path.join(root, 'build-runtime-check', String(Date.now()));
fs.mkdirSync(directory, { recursive: true });
const scripts = process.argv.slice(2);
const checks = scripts.length
    ? scripts
    : [
          'check-native-queue.cjs',
          'check-wave-playback.cjs',
          'check-wave-handoff.cjs',
          'check-wave-native-healthy.cjs',
          'check-wave-user-next.cjs',
          'check-wave-mix.cjs',
          'check-wave-experience.cjs',
          'check-audio-analysis.cjs',
          'check-client-close-race.cjs',
          'check-minimized-start.cjs',
          'check-module-lifecycle.cjs',
          'check-import-interface.cjs',
          'check-source-pagination.cjs',
          'check-network-settings.cjs',
          'check-update-interface.cjs',
          'check-updater.cjs',
          'check-wave-placement.cjs',
      ];
const results = [];
for (const name of checks) {
    if (!/^check-[a-z-]+\.cjs$/.test(name)) throw new Error('Invalid runtime check name');
    const output = path.join(directory, name.replace(/\.cjs$/, ''));
    fs.mkdirSync(output, { recursive: true });
    const env = { ...process.env, WAVE_TEST_REPO: root, WAVE_TEST_OUTPUT: output };
    delete env.WAVE_TEST_LIVE;
    delete env.WAVE_TEST_CAPTURE_STALL;
    console.log('RUN ' + name);
    const headless =
        process.env.CI && process.platform === 'linux'
            ? ['--password-store=basic', '--disable-gpu', '--disable-dev-shm-usage']
            : [];
    const result = spawnSync(executable, [...headless, path.join(__dirname, name)], {
        cwd: root,
        env,
        windowsHide: true,
        timeout: 90000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(output, 'stdout.log'), result.stdout || '');
    fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr || '');
    const passed = result.status === 0 && !result.error;
    results.push({ name, passed, exitCode: result.status, error: result.error?.message });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
    if (!passed)
        console.error([result.stderr, result.stdout, result.error?.message].filter(Boolean).join('\n').slice(-6000));
}
fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
console.log(directory);
if (results.some((result) => !result.passed)) process.exitCode = 1;
