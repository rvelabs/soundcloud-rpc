use crate::{relay, storage::Store};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
    stage: &'static str,
    success: bool,
    http_status: Option<u16>,
    elapsed_ms: u128,
    error: Option<&'static str>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    success: bool,
    elapsed_ms: u128,
    checked_at: u64,
    stages: Vec<Stage>,
    route: &'static str,
}
pub struct Network {
    store: Arc<Store>,
    config: Option<relay::Config>,
    server: Mutex<Option<relay::Server>>,
    report: Mutex<Option<Report>>,
    started: Instant,
    deadline: AtomicU64,
    ready: AtomicBool,
    recovered: AtomicBool,
}

fn asset_url(text: &str) -> Option<url::Url> {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(||regex::Regex::new(r#"https://[A-Za-z0-9./_?=&%~-]+\.sndcdn\.com/[A-Za-z0-9./_?=&%~-]+\.js(?:\?[A-Za-z0-9=&%_.~-]+)?"#).unwrap()).find(text).and_then(|found|url::Url::parse(found.as_str()).ok()).filter(|url|url.scheme()=="https"&&url.port().is_none()&&url.username().is_empty()&&url.password().is_none()&&url.host_str().is_some_and(|host|host.ends_with(".sndcdn.com")))
}

impl Network {
    pub fn new(store: Arc<Store>, config: Option<relay::Config>) -> Arc<Self> {
        Arc::new(Self {
            store,
            config,
            server: Mutex::new(None),
            report: Mutex::new(None),
            started: Instant::now(),
            deadline: AtomicU64::new(30000),
            ready: AtomicBool::new(false),
            recovered: AtomicBool::new(false),
        })
    }
    pub async fn route(&self) -> Option<u16> {
        let config = self.config.as_ref().filter(|config| config.mode != "off")?;
        let force = self.store.get("settings-route")["forceRelayUntil"]
            .as_u64()
            .is_some_and(|until| until > now());
        if config.mode != "on" && !force {
            let report = probe(None).await;
            if report.success {
                *self.report.lock().unwrap() = Some(report);
                return None;
            }
            *self.report.lock().unwrap() = Some(report);
        }
        match relay::serve(config.clone()).await {
            Ok(server) => {
                let port = server.port;
                *self.server.lock().unwrap() = Some(server);
                Some(port)
            }
            Err(_) => None,
        }
    }
    pub fn navigation(&self, url: &url::Url) {
        if url.scheme() == "https" && url.host_str() == Some("soundcloud.com") {
            self.deadline.store(
                self.started.elapsed().as_millis() as u64 + 30000,
                Ordering::Release,
            );
            self.ready.store(false, Ordering::Release);
        }
    }
    pub fn ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::Release);
    }
    pub fn reconfigured(&self) -> Result<(), String> {
        self.recovered.store(true, Ordering::Release);
        self.store.set("settings-route".into(), json!({}))
    }
    pub fn recover(&self) -> Result<bool, String> {
        if self.server.lock().unwrap().is_some()
            || self.ready.load(Ordering::Acquire)
            || self.started.elapsed().as_millis() < (self.deadline.load(Ordering::Acquire) as u128)
            || self.recovered.load(Ordering::Acquire)
            || !self
                .config
                .as_ref()
                .is_some_and(|config| config.mode == "auto")
        {
            return Ok(false);
        }
        let previous = self.store.get("settings-route")["lastRecovery"]
            .as_u64()
            .unwrap_or(0);
        if now().saturating_sub(previous) < 300 {
            return Ok(false);
        }
        self.store.set(
            "settings-route".into(),
            json!({"forceRelayUntil":now()+900,"lastRecovery":now()}),
        )?;
        self.store.flush()?;
        self.recovered.store(true, Ordering::Release);
        Ok(true)
    }
    pub async fn check(&self, config: relay::Config) -> Result<Report, String> {
        let server = relay::serve(config).await?;
        let report = probe(Some(server.port)).await;
        *self.report.lock().unwrap() = Some(report.clone());
        Ok(report)
    }
    pub fn snapshot(&self) -> Value {
        json!({"route":if self.server.lock().unwrap().is_some(){"relay"}else{"direct"},"ready":self.ready.load(Ordering::Acquire),"lastProbe":*self.report.lock().unwrap()})
    }
}

async fn probe(port: Option<u16>) -> Report {
    let started = Instant::now();
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(if port.is_some() { 12 } else { 3 }))
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mozilla/5.0 SoundCloudNative");
    let builder = if let Some(port) = port {
        builder.proxy(reqwest::Proxy::https(format!("http://127.0.0.1:{port}")).unwrap())
    } else {
        builder
    };
    let client = match builder.build() {
        Ok(client) => client,
        Err(_) => {
            return Report {
                success: false,
                elapsed_ms: started.elapsed().as_millis(),
                checked_at: now(),
                stages: vec![Stage {
                    stage: "transport",
                    success: false,
                    http_status: None,
                    elapsed_ms: 0,
                    error: Some("Could not initialize the network transport"),
                }],
                route: if port.is_some() { "relay" } else { "direct" },
            };
        }
    };
    let website = async {
        let at = Instant::now();
        match client.get("https://soundcloud.com/").send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let text = crate::http::bytes(response, 500000)
                    .await
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                (
                    Stage {
                        stage: "website",
                        success: status == 200
                            && text.as_ref().is_some_and(|text| text.len() > 1000),
                        http_status: Some(status),
                        elapsed_ms: at.elapsed().as_millis(),
                        error: None,
                    },
                    text,
                )
            }
            Err(_) => (
                Stage {
                    stage: "website",
                    success: false,
                    http_status: None,
                    elapsed_ms: at.elapsed().as_millis(),
                    error: Some("Website connection failed"),
                },
                None,
            ),
        }
    };
    let api = async {
        let at = Instant::now();
        match client.get("https://api-v2.soundcloud.com/me").send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                Stage {
                    stage: "api",
                    success: status == 401
                        || status == 200
                            && response
                                .headers()
                                .get("content-type")
                                .and_then(|header| header.to_str().ok())
                                .is_some_and(|kind| kind.contains("application/json")),
                    http_status: Some(status),
                    elapsed_ms: at.elapsed().as_millis(),
                    error: None,
                }
            }
            Err(_) => Stage {
                stage: "api",
                success: false,
                http_status: None,
                elapsed_ms: at.elapsed().as_millis(),
                error: Some("API connection failed"),
            },
        }
    };
    let ((website, html), api) = tokio::join!(website, api);
    let mut stages = vec![website, api];
    if let Some(asset) = html.as_deref().and_then(asset_url) {
        let at = Instant::now();
        let asset = match client
            .get(asset)
            .header("Range", "bytes=0-1023")
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status().as_u16();
                let is_html = response
                    .headers()
                    .get("content-type")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|kind| kind.contains("text/html"));
                let mut stream = response.bytes_stream();
                let first = stream.next().await;
                Stage {
                    stage: "assets",
                    success: (200..300).contains(&status)
                        && !is_html
                        && matches!(first,Some(Ok(ref bytes))if!bytes.is_empty()),
                    http_status: Some(status),
                    elapsed_ms: at.elapsed().as_millis(),
                    error: None,
                }
            }
            Err(_) => Stage {
                stage: "assets",
                success: false,
                http_status: None,
                elapsed_ms: at.elapsed().as_millis(),
                error: Some("SoundCloud JavaScript is unreachable"),
            },
        };
        stages.push(asset);
    } else if stages[0].success {
        stages.push(Stage {
            stage: "assets",
            success: false,
            http_status: None,
            elapsed_ms: 0,
            error: Some("The page did not contain a SoundCloud script"),
        });
    }
    Report {
        success: stages.iter().all(|stage| stage.success),
        elapsed_ms: started.elapsed().as_millis(),
        checked_at: now(),
        stages,
        route: if port.is_some() { "relay" } else { "direct" },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_is_bounded_and_reconfiguration_clears_a_forced_route() {
        let root = std::env::temp_dir().join(format!("sc-route-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(&root).unwrap());
        let network = Network::new(
            store.clone(),
            Some(relay::Config {
                endpoint: "https://example.workers.dev".into(),
                key: "a".repeat(64),
                mode: "auto".into(),
            }),
        );
        network.deadline.store(0, Ordering::Release);
        network.ready(true);
        assert!(!network.recover().unwrap());
        network.ready(false);
        assert!(network.recover().unwrap());
        assert!(!network.recover().unwrap());
        assert!(
            store.get("settings-route")["forceRelayUntil"]
                .as_u64()
                .unwrap()
                > now()
        );
        let restarted = Network::new(store.clone(), network.config.clone());
        restarted.deadline.store(0, Ordering::Release);
        assert!(!restarted.recover().unwrap());
        network.reconfigured().unwrap();
        assert!(store.get("settings-route")["forceRelayUntil"].is_null());
        assert!(!network.recover().unwrap());
        drop(restarted);
        drop(network);
        drop(store);
        std::fs::remove_file(root.join("native-state.json")).unwrap();
        std::fs::remove_file(root.join("native.lock")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn only_soundcloud_assets_are_probed() {
        assert!(
            asset_url(r#"<script src="https://a-v2.sndcdn.com/assets/main-123.js"></script>"#)
                .is_some()
        );
        assert!(asset_url("https://evil.test/a.js").is_none());
        assert!(asset_url("https://a-v2.sndcdn.com.evil.test/main.js").is_none());
        assert!(asset_url("https://127.0.0.1/internal.js").is_none());
    }
}
