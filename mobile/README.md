# SoundCloud for Android

Android port based on Windows 0.2.15. Android 8.0+ (API 26), ARM64 phones. This branch is separate from the published Windows client.

- Rust reuses catalogue requests, source import routing, encrypted settings, ad blocking, Last.fm and durable profiles.
- The existing recommendation, feedback, track-wave and playlist matching code is bundled with Android adapters to preserve its behaviour.
- Media3 ExoPlayer owns playback and the queue inside a foreground `MediaSessionService`. The activity attaches to the service-owned WebView; closing the screen does not own or destroy playback.
- A bounded PCM processor analyses 30 seconds of decoded audio. Measurements carry their own `android-pcm-v1` provenance and feed the existing listening evidence and cache.
- The preset equalizer uses Android's native audio effect. Presets are mapped to the band's supported frequencies; hardware support varies by device.
- Public playlist import reuses the existing parsers and supports partial results. Optional Spotify sign-in uses a temporary browser after consent. CSV/TXT uses Android's document picker.
- Credentials are entered only on service pages. Integration and connection settings run in a local asset origin isolated from SoundCloud scripts; secrets use Android Keystore.
- Discord RPC and Windows taskbar/tray integrations are excluded.

## Build

Install JDK 21+, Rust with `aarch64-linux-android` (or `x86_64-linux-android` for remote emulator tests), Android SDK 36, build tools 36.0.0 and NDK 27.2.12479018. Set `ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME` and add Rust/Java to PATH.

```powershell
npm ci --ignore-scripts
npm ci --prefix mobile
node scripts/build-mobile.cjs
./mobile/build-preview.ps1 -Target aarch64
```

On other hosts, run `npm run android:build -- --target aarch64 --split-per-abi` inside `mobile`. Open `mobile/gen/android` in Android Studio. Tauri's build command generates the machine-specific Gradle configuration. The Windows build script handles systems where creating symlinks is disabled.

Debug APK: `mobile/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`. A debug signature is for testing and is not a production release key.

## Checks

```powershell
node node_modules/typescript/bin/tsc -p mobile/tsconfig.json
node scripts/build-mobile.cjs
node mobile/check-layout.cjs
./mobile/gen/android/gradlew.bat -p mobile/gen/android :app:lintArm64Debug -x :app:rustBuildArm64Debug
```

The layout check uses the packaged bundles, a local SoundCloud-shaped fixture and a mocked native transport. It checks ten portrait/landscape viewports (320–873 px), not a real SoundCloud account. `BROWSER_PATH` can point to Chrome/Chromium instead of Edge. Screenshots and results go to `build-android-validation/layout`.

Android instrumentation checks cover the JNI/Keystore round trip and authentication failure, unchanged PCM audio and the 30-second threshold, stale/cancelled queue commits and two track transitions with the display off. `.github/workflows/android.yml` builds an ARM64 APK and runs these checks on a remote x86_64 emulator. No local emulator or virtualization is needed.

Actual account sign-in, service CAPTCHA, region-dependent endpoints, headphone/Bluetooth routing, native equalizer availability and manufacturer battery restrictions still need verification on physical devices. A fixture passing does not establish those properties.

User theme/plugin files, multiple isolated browser-account profiles and an Android APK updater are not yet exposed in this preview. Built-in speed controls, native equalizer presets, wave settings and the existing import functionality are included. Connection changes currently require a full process restart.
