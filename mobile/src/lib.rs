#[path = "../../native/src/adblock.rs"]
mod adblock;
#[path = "../../native/src/cache.rs"]
mod cache;
#[path = "../../native/src/catalog.rs"]
mod catalog;
mod host;
#[path = "../../native/src/http.rs"]
mod http;
#[path = "../../native/src/listening.rs"]
mod listening;
#[path = "../../native/src/network.rs"]
mod network;
#[path = "../../native/src/preferences.rs"]
mod preferences;
mod presence;
#[path = "../../native/src/radio.rs"]
mod radio;
#[path = "../../native/src/relay.rs"]
mod relay;
#[path = "../../native/src/requests.rs"]
mod requests;
#[cfg(target_os = "android")]
mod secrets;
#[cfg(windows)]
#[path = "../../native/src/secrets.rs"]
mod secrets;
#[path = "../../native/src/source.rs"]
mod source;
#[path = "../../native/src/storage.rs"]
mod storage;
#[path = "../../native/src/worker_setup.rs"]
mod worker_setup;

// MainActivity owns the Android lifecycle and calls the real JNI entry points in host.
