# Android migration — approved execution plan

The user approved the complete plan on 2026-11-19 without pauses between modules.

1. Start from Windows 0.2.15 on `android-0.2.15`; restore and replace the fixture-only Android shell.
2. Reuse the portable Rust catalogue, sources, storage, relay, ad blocking and listening integrations. Keep OS-specific behaviour behind target guards.
3. Move real audio and queue ownership to Android Media3/ExoPlayer with a foreground session service; keep a single service-owned catalogue WebView.
4. Bundle the existing wave, feedback and importer implementations with Android player/queue adapters. Record runtime PCM evidence with separate provenance.
5. Add mobile controls, native equalizer presets, local settings and ten-size responsive checks. Test Android-specific lifecycle/queue/Keystore/audio boundaries.
6. Build APKs and run remote emulator checks; keep physical-device and live-account limitations explicit. Do not run the user's unstable local emulators.

## First Rust unit: `src/validation.ts`

`rust-anything` analyse → bridge → record → port → build → diff → bench → shadow → gate executed. Behaviour matched all 139 recorded cases, including additional Unicode/control-character/URL cases. Final gate passed (format, Clippy, tests, no unsafe Rust in the port, API and behaviour checks).

The tiny validation benchmark was **slower** through WebAssembly than the JavaScript baseline (about 0.06× on the generated invalid-input mix). Therefore existing JavaScript callers remain unchanged. Android calls the native Rust validation in its already-required playback-stream request, avoiding an additional JS/WASM boundary. No application-wide performance improvement is claimed from this unit.

Generated test cases, the wrapper, shadow adapter and native crate are retained in `rust/validation-rs`. Native Android audio/service code is an OS integration, not claimed as another gated TypeScript-to-Rust unit.
