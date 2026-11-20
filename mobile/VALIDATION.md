# Android verification — 2026-11-20

Runtime source: `52fc754f9d1bf317b2cf1b2334563a040bd24315`, branch `android-0.2.15`.

[GitHub Actions run 44643928445](https://github.com/rvelabs/soundcloud-rpc/actions/runs/44643928445) completed
successfully: ARM64 APK build, Android Lint and signature verification; x86_64 APK build and all five instrumentation
tests on an Android 16 / API 36 emulator. These are Android checks running on a remote Linux host, not tests of the
Linux desktop client. No local emulator, virtualization or computer-use was used.

| Check                                                               | Result                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Playback through the real JavaScript/native bridge, then screen off | First track starts; two natural transitions; third track keeps playing while the screen stays off                                       |
| Media3 audio pipeline                                               | Empty input/drain/end-of-stream handled; PCM bytes unchanged                                                                            |
| Runtime PCM analysis                                                | Requires 30 seconds; result belongs to its recording; a new recording starts a fresh measurement                                        |
| Queue ownership                                                     | Cancelled, expired and stale replacement requests do not change playback                                                                |
| Rust/JNI and Android Keystore                                       | Encrypted settings round trip through Rust; modified ciphertext is rejected                                                             |
| Shared TypeScript tests                                             | 494 passed                                                                                                                              |
| Native frontend tests                                               | 61 passed                                                                                                                               |
| TypeScript and ESLint                                               | Passed                                                                                                                                  |
| Android Lint                                                        | 0 errors; 46 warnings, principally dependency/template recommendations                                                                  |
| Responsive layout                                                   | 10 viewports: 320×568, 360×640, 375×812, 393×873, 412×915, 480×800, 600×960, 768×1024, 640×360, 873×393                                 |
| Responsive interactions                                             | Main player, local settings, wave settings, import and equalizer; no horizontal overflow, escaped dialogs or uncaught JavaScript errors |
| First rust-anything unit                                            | Final gate passed; all 139 recorded validation cases match the TypeScript reference                                                     |
| ARM64 package                                                       | APK v2 signature valid; ZIP and native ELF alignment checked for 16 KB pages; minSdk 26, targetSdk 36                                   |

## Resolved playback failure

Media3 calls audio processors with `AudioProcessor.EMPTY_BUFFER` before PCM arrives and while draining the pipeline. The
analyzer attempted to obtain a zero-sized output, reusing that same singleton, and then copied it into itself. Android
raised `IllegalArgumentException: The source buffer is this buffer`, stopping the player. The processor now ignores
empty input; the regression test exercises Media3's actual `AudioProcessingPipeline` rather than only feeding non-empty
buffers directly.

Measurements also carry a recording identity. A transition invalidates pending measurements so a result from the
previous recording cannot be applied to the next one.

## APK

Version: **0.2.15 Android preview**, ARM64, debug-signed for testing.

Local deliverable: `build-android/soundcloud-0.2.15-android-arm64.apk` (30,552,798 bytes).

SHA-256: `3A277A9FBFA4746DF1CB81295FF865FA59AD210497E17E2A97B24425330F87FA`.

The debug signature is a development certificate, not a production release key. No GitHub release or Windows push-update
was published.

## Limits of this verification

The responsive tests use the packaged product bundles, a local catalogue-shaped fixture and a mocked native transport.
The emulator playback test uses three local WAV fixtures through the real Android service and bridge. This verifies
buffering, playback and lifecycle behaviour; it does not prove live SoundCloud HLS availability in every region or live
account sign-in.

Real account sign-in/CAPTCHA, live Spotify continuation, Worker deployment, Last.fm delivery, headphones/Bluetooth,
hardware equalizer support, battery use and manufacturer background restrictions still need physical-device testing. No
physical Android device was attached, and no real account credentials or external integration deliveries were used in
CI.

This remains a preview rather than complete Windows feature parity. User theme/plugin files, multiple isolated
browser-account profiles and an Android APK updater are not exposed yet. Core wave/import/settings code is reused; the
recommendation engine has not been rewritten into an unverified replacement. Discord RPC and Windows tray/taskbar
integration are intentionally excluded from Android.
