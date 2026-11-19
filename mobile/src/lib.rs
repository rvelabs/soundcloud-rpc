#[path = "../../native/src/adblock.rs"]
mod adblock;
#[path = "../../native/src/cache.rs"]
mod cache;
#[path = "../../native/src/catalog.rs"]
mod catalog;
#[path = "../../native/src/http.rs"]
mod http;
#[path = "../../native/src/listening.rs"]
mod listening;
#[path = "../../native/src/network.rs"]
mod network;
#[path = "../../native/src/preferences.rs"]
mod preferences;
#[path = "../../native/src/radio.rs"]
mod radio;
#[path = "../../native/src/relay.rs"]
mod relay;
#[path = "../../native/src/requests.rs"]
mod requests;
#[path = "../../native/src/storage.rs"]
mod storage;
#[path = "../../native/src/source.rs"]
mod source;
#[path = "../../native/src/worker_setup.rs"]
mod worker_setup;
mod host;
mod presence;
#[cfg(target_os = "android")]
mod secrets;
#[cfg(windows)]
#[path = "../../native/src/secrets.rs"]
mod secrets;

// The Android activity owns the lifecycle and calls the JNI entry points in host.
pub fn run() {}
