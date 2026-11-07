use crate::storage::Store;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FEED: &str = "https://rvelabs.github.io/soundcloud-rpc/native-update.json";
#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Patch,
    Notify,
    Off,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    phase: &'static str,
    current_version: String,
    version: Option<String>,
    kind: Option<&'static str>,
    percent: u8,
    mode: Mode,
    install_supported: bool,
    error: Option<&'static str>,
}
struct Pending {
    update: Arc<Update>,
    bytes: Vec<u8>,
}
pub struct Updates {
    state: Mutex<Snapshot>,
    store: Arc<Store>,
    available: Mutex<Option<Arc<Update>>>,
    pending: Mutex<Option<Pending>>,
    operation: tokio::sync::Mutex<()>,
    wake: tokio::sync::Notify,
    cancel: tokio::sync::watch::Sender<u64>,
    notified: Mutex<BTreeSet<String>>,
}

fn kind(current: &str, next: &str) -> Option<&'static str> {
    let current = semver::Version::parse(current).ok()?;
    let next = semver::Version::parse(next).ok()?;
    if next <= current {
        return None;
    }
    Some(
        if current.major == next.major && current.minor == next.minor {
            "patch"
        } else {
            "larger"
        },
    )
}
fn native_url(address: &url::Url, version: &str) -> bool {
    address.scheme() == "https"
        && address.host_str() == Some("github.com")
        && address.port().is_none()
        && address.username().is_empty()
        && address.password().is_none()
        && address.query().is_none()
        && address.fragment().is_none()
        && address.path()
            == format!(
                "/rvelabs/soundcloud-rpc/releases/download/native-v{version}/SoundCloud-{version}-x64-setup.exe"
            )
}

impl Updates {
    pub fn new(store: Arc<Store>) -> Arc<Self> {
        let mode = serde_json::from_value(store.get("settings-updates")).unwrap_or_default();
        let supported = matches!(
            tauri::utils::platform::bundle_type(),
            Some(tauri::utils::config::BundleType::Nsis)
        );
        Arc::new(Self {
            state: Mutex::new(Snapshot {
                phase: "idle",
                current_version: env!("CARGO_PKG_VERSION").into(),
                version: None,
                kind: None,
                percent: 0,
                mode,
                install_supported: supported,
                error: None,
            }),
            store,
            available: Mutex::new(None),
            pending: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
            wake: tokio::sync::Notify::new(),
            cancel: tokio::sync::watch::channel(0).0,
            notified: Mutex::new(BTreeSet::new()),
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        self.state.lock().unwrap().clone()
    }
    fn publish(&self, app: &AppHandle) {
        if let Some(window) = app.get_webview("settings") {
            let _ = window.eval("window.dispatchEvent(new Event('native-update-changed'))");
        }
        let state = self.snapshot();
        if ["available", "ready"].contains(&state.phase) {
            let id = format!("{}:{}", state.version.as_deref().unwrap_or(""), state.phase);
            let mut notified = self.notified.lock().unwrap();
            if notified.insert(id) {
                while notified.len() > 40 {
                    if let Some(key) = notified.first().cloned() {
                        notified.remove(&key);
                    }
                }
                if let Some(window) = app.get_webview("main") {
                    let _ = window.eval(format!(
                        "window.__soundcloudNative?.updateNotice({})",
                        serde_json::to_string(&state).unwrap()
                    ));
                }
            }
        }
    }
    fn error(&self, message: &'static str, app: &AppHandle) {
        let mut state = self.state.lock().unwrap();
        state.phase = "error";
        state.error = Some(message);
        drop(state);
        self.publish(app);
    }
    pub fn mode(&self, mode: Mode, app: &AppHandle) -> Result<(), String> {
        self.store.set(
            "settings-updates".into(),
            serde_json::to_value(mode).unwrap(),
        )?;
        self.cancel
            .send_modify(|generation| *generation = generation.wrapping_add(1));
        {
            let mut state = self.state.lock().unwrap();
            state.mode = mode;
            if ["checking", "downloading"].contains(&state.phase) {
                state.phase = if self.available.lock().unwrap().is_some() {
                    "available"
                } else {
                    "idle"
                };
                state.percent = 0;
            }
            if mode == Mode::Off {
                state.phase = "idle";
                state.error = None;
                self.pending.lock().unwrap().take();
            }
        }
        self.wake.notify_one();
        self.publish(app);
        Ok(())
    }
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut delay = 30;
            loop {
                tokio::select! {_=tokio::time::sleep(Duration::from_secs(delay))=>{},_=host.wake.notified()=>{}}
                delay = 6 * 3600;
                if host.snapshot().mode != Mode::Off {
                    let _ = host.check(&app, false).await;
                }
            }
        });
    }
    pub async fn check(&self, app: &AppHandle, manual: bool) -> Result<(), String> {
        let operation = self.operation.lock().await;
        if self.snapshot().phase == "ready" {
            return Ok(());
        }
        if !manual && self.snapshot().mode == Mode::Off {
            return Ok(());
        }
        let mut cancelled = self.cancel.subscribe();
        let generation = *cancelled.borrow_and_update();
        {
            let mut state = self.state.lock().unwrap();
            state.phase = "checking";
            state.error = None;
        }
        self.publish(app);
        let handle = app.clone();
        let updater = app
            .updater_builder()
            .endpoints(vec![FEED.parse().unwrap()])
            .map_err(|_| "Invalid SoundCloud update endpoint")?
            .timeout(Duration::from_secs(20))
            .on_before_exit(move || {
                if let Some(state) = handle.try_state::<Arc<crate::State>>() {
                    let _ = state.listening.checkpoint(true);
                    let _ = state.store.flush();
                    state.extensions.stop();
                }
                handle.cleanup_before_exit();
            })
            .build()
            .map_err(|_| "Could not initialize SoundCloud updates")?;
        let result = tokio::select! {value=updater.check()=>value.map_err(|_|"SoundCloud update feed is unavailable"),_=cancelled.changed()=>return Ok(())};
        if generation != *self.cancel.borrow() {
            return Ok(());
        }
        let update = match result {
            Ok(value) => value,
            Err(message) => {
                self.error(message, app);
                return Err(message.into());
            }
        };
        let Some(update) = update else {
            self.state.lock().unwrap().phase = "current";
            self.publish(app);
            return Ok(());
        };
        let current = self.snapshot();
        let Some(kind) = kind(&current.current_version, &update.version) else {
            self.state.lock().unwrap().phase = "current";
            self.publish(app);
            return Ok(());
        };
        if !native_url(&update.download_url, &update.version) || update.raw_json["native"] != true {
            self.error("The update feed does not describe a Native package", app);
            return Err("SoundCloud updates cannot install Electron packages".into());
        }
        {
            let mut state = self.state.lock().unwrap();
            state.phase = "available";
            state.version = Some(update.version.clone());
            state.kind = Some(kind);
            state.percent = 0;
        }
        *self.available.lock().unwrap() = Some(Arc::new(update));
        self.publish(app);
        let automatic = current.mode == Mode::Patch && kind == "patch" && current.install_supported;
        drop(operation);
        if automatic {
            self.download(app).await?;
        }
        Ok(())
    }
    pub async fn download(&self, app: &AppHandle) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        if self.snapshot().phase == "ready" {
            return Ok(());
        }
        if !self.snapshot().install_supported {
            return Err("Use the installed SoundCloud build for automatic updates".into());
        }
        let update = self
            .available
            .lock()
            .unwrap()
            .clone()
            .ok_or("Check for a SoundCloud update first")?;
        let mut cancelled = self.cancel.subscribe();
        let generation = *cancelled.borrow_and_update();
        {
            let mut state = self.state.lock().unwrap();
            state.phase = "downloading";
            state.error = None;
        }
        self.publish(app);
        let size_limit = tokio::sync::Notify::new();
        let mut received = 0u64;
        let download = update.download(
            |bytes, total| {
                if generation != *self.cancel.borrow() {
                    size_limit.notify_one();
                    return;
                }
                received = received.saturating_add(bytes as u64);
                if received > 128 * 1024 * 1024
                    || total.is_some_and(|size| size > 128 * 1024 * 1024)
                {
                    size_limit.notify_one();
                    return;
                }
                let percent = total
                    .filter(|total| *total > 0)
                    .map(|total| (received * 100 / total).min(99) as u8)
                    .unwrap_or(0);
                let mut state = self.state.lock().unwrap();
                if state.percent != percent {
                    state.percent = percent;
                    drop(state);
                    self.publish(app);
                }
            },
            || {},
        );
        let bytes = tokio::select! {result=download=>result.map_err(|_|"Download or Native package signature verification failed"),_=size_limit.notified()=>Err("SoundCloud update exceeds the download size limit"),_=cancelled.changed()=>return Ok(())};
        if generation != *self.cancel.borrow() {
            return Ok(());
        }
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(message) => {
                self.error(message, app);
                return Err(message.into());
            }
        };
        if bytes.len() > 128 * 1024 * 1024 {
            self.error("SoundCloud update exceeds the download size limit", app);
            return Err("SoundCloud update exceeds the download size limit".into());
        }
        *self.pending.lock().unwrap() = Some(Pending { update, bytes });
        {
            let mut state = self.state.lock().unwrap();
            state.phase = "ready";
            state.percent = 100;
        }
        self.publish(app);
        Ok(())
    }
    pub fn install(&self, app: &AppHandle) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .unwrap()
            .take()
            .ok_or("Download and verify the SoundCloud update first")?;
        let result = (|| {
            if let Some(state) = app.try_state::<Arc<crate::State>>() {
                state.listening.checkpoint(false)?;
                state.store.flush()?;
            }
            pending
                .update
                .install(&pending.bytes)
                .map_err(|_| "Could not launch the Native installer".to_string())
        })();
        if let Err(error) = result {
            *self.pending.lock().unwrap() = Some(pending);
            {
                let mut state = self.state.lock().unwrap();
                state.phase = "ready";
                state.error =
                    Some("Could not safely start installation; your download is retained");
            }
            self.publish(app);
            return Err(error);
        }
        Ok(())
    }
    pub fn install_on_quit(&self, app: &AppHandle) {
        let state = self.snapshot();
        if state.phase == "ready" && state.mode == Mode::Patch && state.kind == Some("patch") {
            let _ = self.install(app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channels_never_cross_into_electron_or_allow_downgrades() {
        assert_eq!(kind("0.2.0", "0.2.1"), Some("patch"));
        assert_eq!(kind("0.2.1", "0.3.0"), Some("larger"));
        assert_eq!(kind("0.2.1", "0.2.0"), None);
        assert!(native_url(&"https://github.com/rvelabs/soundcloud-rpc/releases/download/native-v0.2.1/SoundCloud-0.2.1-x64-setup.exe".parse().unwrap(),"0.2.1"));
        for value in [
            "https://github.com/rvelabs/soundcloud-rpc/releases/download/v0.32.2/SoundCloud-setup.exe",
            "https://evil.test/rvelabs/soundcloud-rpc/releases/download/native-v0.2.1/SoundCloud-0.2.1-x64-setup.exe",
        ] {
            assert!(!native_url(&value.parse().unwrap(), "0.2.1"));
        }
    }
}
