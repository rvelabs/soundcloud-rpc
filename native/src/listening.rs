use crate::{presence::Track, secrets, storage::Store};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;

const LIMIT: usize = 512;
const API: &str = "https://ws.audioscrobbler.com/2.0/";
fn wall() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn scope() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    lastfm_enabled: bool,
    webhook_enabled: bool,
    webhook_trigger: u8,
    parse_title: bool,
    api_key: String,
    api_secret: String,
    session_key: String,
    username: String,
    webhook_url: String,
    lastfm_scope: String,
    webhook_scope: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            lastfm_enabled: false,
            webhook_enabled: false,
            webhook_trigger: 50,
            parse_title: true,
            api_key: String::new(),
            api_secret: String::new(),
            session_key: String::new(),
            username: String::new(),
            webhook_url: String::new(),
            lastfm_scope: scope(),
            webhook_scope: scope(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub lastfm_enabled: bool,
    pub webhook_enabled: bool,
    pub webhook_trigger: u8,
    pub parse_title: bool,
    pub api_key: String,
    pub api_secret: Option<String>,
    pub webhook_url: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
enum Kind {
    Scrobble,
    Webhook,
    NowPlaying,
}

#[derive(Clone, Serialize, Deserialize)]
struct Delivery {
    id: String,
    scope: String,
    kind: Kind,
    artist: String,
    track: String,
    duration: f64,
    url: String,
    artwork: String,
    timestamp: u64,
    queued_at: u64,
    next_at: u64,
    attempts: u8,
}
impl Delivery {
    fn valid(&self) -> bool {
        self.id.len() <= 100
            && self.scope.len() <= 100
            && self.artist.len() <= 1200
            && self.track.len() <= 1200
            && self.artwork.len() <= 2048
            && crate::catalog::track_url(&self.url)
            && self.duration.is_finite()
            && (0.0..=86400.0).contains(&self.duration)
    }
}

struct Current {
    frame: Track,
    at: Instant,
    started: u64,
    played: f64,
    id: String,
    scrobbled: bool,
    webhook: bool,
    rate: f64,
}

struct Engine {
    config: Config,
    current: Option<Current>,
    pending: Vec<Delivery>,
    now_playing: Option<Delivery>,
    revision: u64,
    saved: u64,
    last_error: Option<&'static str>,
    delivered: u64,
    auth: Option<(String, Instant)>,
    config_revision: u64,
    blocked: [bool; 2],
    cooldown: [u64; 2],
}

pub fn normalize(title: &str, author: &str, enabled: bool) -> (String, String) {
    let title = title.lines().next().unwrap_or("").trim();
    let invalid = |s: &str| {
        let mut last = '\0';
        let mut run = 0;
        s.is_empty()
            || s.starts_with(['-', '–', '—', '―'])
            || s.ends_with(['-', '–', '—', '―'])
            || s.chars().any(|c| {
                run = if c == last { run + 1 } else { 1 };
                last = c;
                run >= 5
            })
            || s.chars()
                .zip(s.chars().skip(1))
                .any(|(a, b)| "-–—―".contains(a) && "-–—―".contains(b))
    };
    if enabled {
        static SEPARATOR: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        if let Some(found) = SEPARATOR
            .get_or_init(|| regex::Regex::new(r"(\s+[-–—―]+\s+|[-–—―]{2,})").unwrap())
            .find(title)
        {
            let a = title[..found.start()].trim();
            let t = title[found.end()..].trim();
            if !invalid(a) && !invalid(t) {
                return (a.into(), t.into());
            }
        }
    }
    (
        if author.is_empty() {
            "Unknown Artist"
        } else {
            author
        }
        .into(),
        if title.is_empty() {
            "Unknown Track"
        } else {
            title
        }
        .into(),
    )
}

impl Engine {
    fn new(config: Config, pending: Vec<Delivery>) -> Self {
        let mut engine = Self {
            config,
            current: None,
            pending,
            now_playing: None,
            revision: 0,
            saved: 0,
            last_error: None,
            delivered: 0,
            auth: None,
            config_revision: 0,
            blocked: [false; 2],
            cooldown: [0; 2],
        };
        engine.prune(wall());
        engine
    }
    fn active(&self) -> bool {
        (self.config.lastfm_enabled && !self.config.session_key.is_empty() && !self.blocked[0])
            || (self.config.webhook_enabled
                && !self.config.webhook_url.is_empty()
                && !self.blocked[1])
    }
    fn accepts(&self, entry: &Delivery) -> bool {
        if entry.kind == Kind::Webhook {
            entry.scope == self.config.webhook_scope
        } else {
            entry.scope == self.config.lastfm_scope
        }
    }
    fn enabled(&self, entry: &Delivery) -> bool {
        self.accepts(entry)
            && !self.blocked[usize::from(entry.kind == Kind::Webhook)]
            && if entry.kind == Kind::Webhook {
                self.config.webhook_enabled && !self.config.webhook_url.is_empty()
            } else {
                self.config.lastfm_enabled && !self.config.session_key.is_empty()
            }
    }
    fn prune(&mut self, now: u64) {
        let before = self.pending.len();
        let config = &self.config;
        self.pending.retain(|entry| {
            entry.valid()
                && entry.attempts < 12
                && now.saturating_sub(entry.queued_at) < 7 * 86400
                && if entry.kind == Kind::Webhook {
                    entry.scope == config.webhook_scope
                } else {
                    entry.scope == config.lastfm_scope
                }
        });
        if self.pending.len() > LIMIT {
            self.pending.drain(..self.pending.len() - LIMIT);
        }
        if before != self.pending.len() {
            self.revision += 1;
        }
    }
    #[cfg(test)]
    fn observe(&mut self, frame: Option<Track>, at: Instant, now: u64) {
        self.observe_at_rate(frame, at, now, 1.0);
    }
    fn observe_at_rate(&mut self, frame: Option<Track>, at: Instant, now: u64, rate: f64) {
        let Some(frame) = frame else {
            self.current = None;
            self.now_playing = None;
            return;
        };
        let same = self.current.as_ref().is_some_and(|old| {
            old.frame.url == frame.url
                && !(old.frame.duration > 0.0
                    && old.frame.elapsed >= old.frame.duration - 3.0
                    && frame.elapsed <= 3.0)
        });
        let ping = !same
            || self.current.as_ref().is_some_and(|old| {
                frame.playing
                    && (!old.frame.playing
                        || old.frame.title != frame.title
                        || old.frame.author != frame.author)
            });
        if !same {
            self.current = Some(Current {
                frame: frame.clone(),
                at,
                started: now,
                played: 0.0,
                id: scope(),
                scrobbled: false,
                webhook: false,
                rate,
            });
        }
        let current = self.current.as_mut().unwrap();
        if same && current.frame.playing {
            let elapsed = at.saturating_duration_since(current.at).as_secs_f64();
            let moved = frame.elapsed - current.frame.elapsed;
            if elapsed > 0.0
                && elapsed <= 15.0
                && moved > 0.0
                && moved <= elapsed * current.rate.max(rate) + 1.5
            {
                current.played += elapsed.min(moved / current.rate);
            }
        }
        current.at = at;
        current.rate = rate;
        current.frame = frame;
        let (artist, track) = normalize(
            &current.frame.title,
            &current.frame.author,
            self.config.parse_title,
        );
        let entry = |kind: Kind, entry_scope: &str| Delivery {
            id: format!(
                "{}-{}",
                current.id,
                if kind == Kind::Webhook {
                    "webhook"
                } else if kind == Kind::Scrobble {
                    "lastfm"
                } else {
                    "presence"
                }
            ),
            scope: entry_scope.into(),
            kind,
            artist: artist.clone(),
            track: track.clone(),
            duration: current.frame.duration,
            url: current.frame.url.clone(),
            artwork: current.frame.artwork.clone(),
            timestamp: current.started,
            queued_at: now,
            next_at: now,
            attempts: 0,
        };
        if current.frame.playing
            && ping
            && self.config.lastfm_enabled
            && !self.config.session_key.is_empty()
        {
            self.now_playing = Some(entry(Kind::NowPlaying, &self.config.lastfm_scope));
        }
        if !current.frame.playing {
            self.now_playing = None;
        }
        let mut queued = Vec::new();
        if !current.scrobbled
            && current.frame.duration > 30.0
            && current.played >= (current.frame.duration / 2.0).min(240.0)
            && self.config.lastfm_enabled
            && !self.config.session_key.is_empty()
        {
            queued.push(entry(Kind::Scrobble, &self.config.lastfm_scope));
            current.scrobbled = true;
        }
        if !current.webhook
            && current.frame.duration > 0.0
            && current.played
                >= current.frame.duration * f64::from(self.config.webhook_trigger) / 100.0
            && self.config.webhook_enabled
            && !self.config.webhook_url.is_empty()
        {
            queued.push(entry(Kind::Webhook, &self.config.webhook_scope));
            current.webhook = true;
        }
        if !queued.is_empty() {
            self.pending.extend(queued);
            self.revision += 1;
        }
        self.prune(now);
    }
}

pub struct Listening {
    engine: Mutex<Engine>,
    path: PathBuf,
    store: Arc<Store>,
    client: reqwest::Client,
    wake: Notify,
    closed: AtomicBool,
}

fn api_signature(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut md5 = Md5::new();
    for (key, value) in params {
        md5.update(key.as_bytes());
        md5.update(value.as_bytes());
    }
    md5.update(secret.as_bytes());
    format!("{:x}", md5.finalize())
}

async fn lastfm(
    client: &reqwest::Client,
    config: &Config,
    method: &str,
    fields: &[(&str, String)],
    session: bool,
) -> Result<Value, &'static str> {
    let mut params = BTreeMap::from([
        ("method".into(), method.into()),
        ("api_key".into(), config.api_key.clone()),
    ]);
    if session {
        params.insert("sk".into(), config.session_key.clone());
    }
    for (key, value) in fields {
        params.insert((*key).into(), value.clone());
    }
    let signature = api_signature(&params, &config.api_secret);
    params.insert("api_sig".into(), signature);
    params.insert("format".into(), "json".into());
    let response = client
        .post(API)
        .form(&params)
        .send()
        .await
        .map_err(|_| "Last.fm is unreachable")?;
    if [401, 403].contains(&response.status().as_u16()) {
        return Err("Last.fm rejected credentials");
    }
    if !response.status().is_success() {
        return Err("Last.fm HTTP request failed");
    }
    crate::http::json(response, 128000)
        .await
        .map_err(|_| "Last.fm returned invalid data")
}

impl Listening {
    pub fn new(profile: &std::path::Path, store: Arc<Store>) -> Result<Arc<Self>, String> {
        let path = profile.join("native-listening.dat");
        let config = secrets::load(&path)?
            .map(|data| serde_json::from_slice(&data))
            .transpose()
            .map_err(|_| "Invalid listening settings")?
            .unwrap_or_default();
        let pending = serde_json::from_value(store.get("settings-delivery")).unwrap_or_default();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(4))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("SoundCloudNative")
            .build()
            .map_err(|_| "Could not create listening transport")?;
        Ok(Arc::new(Self {
            engine: Mutex::new(Engine::new(config, pending)),
            path,
            store,
            client,
            wake: Notify::new(),
            closed: AtomicBool::new(false),
        }))
    }
    pub fn start(self: &Arc<Self>) {
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            service.worker().await;
        });
    }
    pub fn observe(&self, track: Option<Track>, rate: f64) -> Result<(), String> {
        if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
            return Err("Invalid playback speed".into());
        }
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if let Some(track) = &track {
            track.validate()?;
        }
        self.engine
            .lock()
            .unwrap()
            .observe_at_rate(track, Instant::now(), wall(), rate);
        self.wake.notify_one();
        Ok(())
    }
    pub fn checkpoint(&self, stop: bool) -> Result<(), String> {
        if stop {
            self.closed.store(true, Ordering::Release);
            self.wake.notify_one();
        }
        let engine = self.engine.lock().unwrap();
        if engine.revision != engine.saved {
            self.store.set(
                "settings-delivery".into(),
                serde_json::to_value(&engine.pending).map_err(|_| "Invalid pending deliveries")?,
            )?;
        }
        Ok(())
    }
    pub fn status(&self, local: bool) -> Value {
        let engine = self.engine.lock().unwrap();
        let config = &engine.config;
        if !local {
            return json!({"enabled": engine.active(), "pending": engine.pending.len(), "error": engine.last_error, "delivered": engine.delivered});
        }
        json!({"enabled":engine.active(),"lastfmEnabled":config.lastfm_enabled,"webhookEnabled":config.webhook_enabled,"webhookTrigger":config.webhook_trigger,"parseTitle":config.parse_title,
            "apiKey":config.api_key,"hasSecret":!config.api_secret.is_empty(),"connected":!config.session_key.is_empty(),"username":config.username,"hasWebhookUrl":!config.webhook_url.is_empty(),"pending":engine.pending.len(),"delivered":engine.delivered,"error":engine.last_error,"authPending":engine.auth.as_ref().is_some_and(|(_, at)| at.elapsed() < Duration::from_secs(600))})
    }
    fn commit_config(&self, config: Config, revision: u64) -> Result<(), String> {
        let mut engine = self.engine.lock().unwrap();
        if engine.config_revision != revision {
            return Err("Integration settings changed; retry the operation".into());
        }
        secrets::save(
            &self.path,
            &serde_json::to_vec(&config).map_err(|_| "Invalid listening settings")?,
        )?;
        engine.config = config;
        engine.config_revision += 1;
        engine.auth = None;
        engine.current = None;
        engine.now_playing = None;
        engine.blocked = [false; 2];
        engine.cooldown = [0; 2];
        engine.prune(wall());
        self.wake.notify_one();
        Ok(())
    }
    pub fn configure(&self, options: Options) -> Result<(), String> {
        if options.webhook_trigger > 100 {
            return Err("Webhook threshold must be 0–100%".into());
        }
        let (mut config, revision) = {
            let engine = self.engine.lock().unwrap();
            (engine.config.clone(), engine.config_revision)
        };
        if !options.api_key.is_empty() && !hex_key(&options.api_key) {
            return Err("Last.fm API key must contain 32 hexadecimal characters".into());
        }
        if let Some(secret) = options.api_secret.filter(|s| !s.is_empty()) {
            if !hex_key(&secret) {
                return Err("Last.fm shared secret must contain 32 hexadecimal characters".into());
            }
            if secret != config.api_secret {
                config.session_key.clear();
                config.username.clear();
                config.lastfm_scope = scope();
            }
            config.api_secret = secret;
        }
        if config.api_key != options.api_key {
            config.session_key.clear();
            config.username.clear();
            config.lastfm_scope = scope();
        }
        config.api_key = options.api_key;
        if let Some(url) = options.webhook_url.filter(|s| !s.is_empty()) {
            if !webhook_url(&url) {
                return Err("Use an HTTPS webhook URL without credentials".into());
            }
            if url != config.webhook_url {
                config.webhook_scope = scope();
            }
            config.webhook_url = url;
        }
        config.lastfm_enabled = options.lastfm_enabled;
        config.webhook_enabled = options.webhook_enabled;
        config.webhook_trigger = options.webhook_trigger;
        config.parse_title = options.parse_title;
        self.commit_config(config, revision)
    }
    pub async fn authorize(&self) -> Result<String, String> {
        let config = self.engine.lock().unwrap().config.clone();
        if !hex_key(&config.api_key) || !hex_key(&config.api_secret) {
            return Err("Save your Last.fm API key and shared secret first".into());
        }
        let result = lastfm(&self.client, &config, "auth.getToken", &[], false).await?;
        let token = result["token"]
            .as_str()
            .filter(|value| hex_key(value))
            .ok_or("Last.fm did not return an authorization token")?
            .to_string();
        let mut engine = self.engine.lock().unwrap();
        if engine.config.lastfm_scope != config.lastfm_scope {
            return Err("Last.fm settings changed".into());
        }
        engine.auth = Some((token.clone(), Instant::now()));
        Ok(format!(
            "https://www.last.fm/api/auth/?api_key={}&token={token}",
            config.api_key
        ))
    }
    pub async fn finish(&self) -> Result<(), String> {
        let (mut config, token, revision) = {
            let engine = self.engine.lock().unwrap();
            let (token, _) = engine
                .auth
                .as_ref()
                .filter(|(_, at)| at.elapsed() < Duration::from_secs(600))
                .ok_or("Start Last.fm sign-in again")?;
            (engine.config.clone(), token.clone(), engine.config_revision)
        };
        let data = lastfm(
            &self.client,
            &config,
            "auth.getSession",
            &[("token", token)],
            false,
        )
        .await?;
        let key = data["session"]["key"]
            .as_str()
            .filter(|key| hex_key(key))
            .ok_or("Approve access on Last.fm, then press Finish sign-in")?
            .to_string();
        {
            let engine = self.engine.lock().unwrap();
            if engine.config.lastfm_scope != config.lastfm_scope {
                return Err("Last.fm settings changed".into());
            }
        }
        config.session_key = key;
        config.username = data["session"]["name"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(100)
            .collect();
        config.lastfm_scope = scope();
        config.lastfm_enabled = true;
        self.commit_config(config, revision)
    }
    pub fn disconnect(&self, kind: &str) -> Result<(), String> {
        let (mut config, revision) = {
            let engine = self.engine.lock().unwrap();
            (engine.config.clone(), engine.config_revision)
        };
        match kind {
            "lastfm" => {
                config.lastfm_enabled = false;
                config.session_key.clear();
                config.username.clear();
                config.lastfm_scope = scope();
            }
            "webhook" => {
                config.webhook_enabled = false;
                config.webhook_url.clear();
                config.webhook_scope = scope();
            }
            _ => return Err("Unknown integration".into()),
        }
        self.commit_config(config, revision)
    }
    async fn worker(self: Arc<Self>) {
        loop {
            if self.closed.load(Ordering::Acquire) {
                return;
            }
            let snapshot = {
                let mut engine = self.engine.lock().unwrap();
                engine.prune(wall());
                (engine.revision, engine.saved, engine.pending.clone())
            };
            if snapshot.0 != snapshot.1 {
                let store = self.store.clone();
                let entries = snapshot.2;
                let saved = tauri::async_runtime::spawn_blocking(move || {
                    store.set(
                        "settings-delivery".into(),
                        serde_json::to_value(entries).map_err(|_| "Invalid pending deliveries")?,
                    )?;
                    store.flush()
                })
                .await;
                if !matches!(saved, Ok(Ok(()))) {
                    self.engine.lock().unwrap().last_error =
                        Some("Could not save pending deliveries; sending is paused");
                    tokio::select! { _ = self.wake.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(30)) => {} }
                    continue;
                }
                self.engine.lock().unwrap().saved = snapshot.0;
            }
            let task = {
                let engine = self.engine.lock().unwrap();
                let ready = |entry: &&Delivery| {
                    engine.enabled(entry)
                        && entry
                            .next_at
                            .max(engine.cooldown[usize::from(entry.kind == Kind::Webhook)])
                            <= wall()
                };
                engine
                    .now_playing
                    .as_ref()
                    .filter(ready)
                    .or_else(|| engine.pending.iter().find(ready))
                    .map(|entry| (entry.clone(), engine.config.clone()))
            };
            if let Some((entry, config)) = task {
                let outcome = self.deliver(&entry, &config).await;
                if self.closed.load(Ordering::Acquire) {
                    return;
                }
                let mut engine = self.engine.lock().unwrap();
                if !engine.accepts(&entry) {
                    continue;
                }
                if outcome == Outcome::Blocked {
                    engine.blocked[usize::from(entry.kind == Kind::Webhook)] = true;
                    engine.now_playing = None;
                    engine.last_error =
                        Some("Integration credentials were rejected; reconnect or update the URL");
                    continue;
                }
                if outcome == Outcome::Retry {
                    engine.cooldown[usize::from(entry.kind == Kind::Webhook)] =
                        wall() + (2u64.pow(u32::from(entry.attempts.min(8))) * 4).min(300);
                }
                let retry = outcome == Outcome::Retry
                    && entry.attempts
                        < if entry.kind == Kind::NowPlaying {
                            2
                        } else {
                            11
                        };
                if let Some(index) = engine.pending.iter().position(|item| item.id == entry.id) {
                    if retry {
                        engine.pending[index].attempts += 1;
                        engine.pending[index].next_at = wall()
                            + (2u64.pow(u32::from(engine.pending[index].attempts.min(8))) * 2)
                                .min(300);
                    } else {
                        engine.pending.remove(index);
                        if outcome == Outcome::Sent {
                            engine.delivered += 1;
                        }
                    }
                    engine.revision += 1;
                }
                if engine
                    .now_playing
                    .as_ref()
                    .is_some_and(|item| item.id == entry.id)
                {
                    if retry {
                        let item = engine.now_playing.as_mut().unwrap();
                        item.attempts += 1;
                        item.next_at = wall() + 5;
                    } else {
                        engine.now_playing = None;
                    }
                }
                engine.last_error = match outcome {
                    Outcome::Sent => None,
                    Outcome::Retry => Some("Delivery temporarily unavailable; it will retry"),
                    Outcome::Drop | Outcome::Blocked => {
                        Some("Service rejected a delivery; check the integration settings")
                    }
                };
                continue;
            }
            let delay = {
                let engine = self.engine.lock().unwrap();
                engine
                    .pending
                    .iter()
                    .chain(engine.now_playing.iter())
                    .filter(|entry| engine.enabled(entry))
                    .map(|entry| {
                        entry
                            .next_at
                            .max(engine.cooldown[usize::from(entry.kind == Kind::Webhook)])
                            .saturating_sub(wall())
                            .max(1)
                    })
                    .min()
            };
            if let Some(delay) = delay {
                tokio::select! { _ = self.wake.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
            } else {
                self.wake.notified().await;
            }
        }
    }
    async fn deliver(&self, entry: &Delivery, config: &Config) -> Outcome {
        if entry.kind == Kind::Webhook {
            let timestamp = time::OffsetDateTime::from_unix_timestamp(entry.timestamp as i64)
                .ok()
                .and_then(|time| {
                    time.format(&time::format_description::well_known::Rfc3339)
                        .ok()
                })
                .unwrap_or_default();
            let result = self.client.post(&config.webhook_url).header("Idempotency-Key", &entry.id).json(&json!({"eventId":entry.id,"timestamp":timestamp,"artist":entry.artist,"track":entry.track,"duration":entry.duration,"originUrl":entry.url,"trackArt":entry.artwork})).send().await;
            return match result {
                Ok(response) if response.status().is_success() => Outcome::Sent,
                Ok(response) if [401, 403].contains(&response.status().as_u16()) => {
                    Outcome::Blocked
                }
                Ok(response)
                    if response.status().is_server_error()
                        || [408, 429].contains(&response.status().as_u16()) =>
                {
                    Outcome::Retry
                }
                Ok(_) => Outcome::Drop,
                Err(_) => Outcome::Retry,
            };
        }
        let method = if entry.kind == Kind::Scrobble {
            "track.scrobble"
        } else {
            "track.updateNowPlaying"
        };
        let mut fields = vec![
            ("artist", entry.artist.clone()),
            ("track", entry.track.clone()),
        ];
        if entry.kind == Kind::Scrobble {
            fields.push(("timestamp", entry.timestamp.to_string()));
        }
        match lastfm(&self.client, config, method, &fields, true).await {
            Ok(data) if data["error"].is_null() => Outcome::Sent,
            Ok(data) if [11, 16, 29].contains(&data["error"].as_u64().unwrap_or(0)) => {
                Outcome::Retry
            }
            Ok(data) if [4, 9, 10, 13, 26].contains(&data["error"].as_u64().unwrap_or(0)) => {
                Outcome::Blocked
            }
            Ok(_) => Outcome::Drop,
            Err("Last.fm rejected credentials") => Outcome::Blocked,
            Err(_) => Outcome::Retry,
        }
    }
}

#[derive(PartialEq)]
enum Outcome {
    Sent,
    Retry,
    Drop,
    Blocked,
}
fn hex_key(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn webhook_url(value: &str) -> bool {
    value.len() <= 4096
        && url::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accelerated_playback_is_confirmed_without_inflating_actual_listening_time() {
        let mut engine = engine();
        let start = Instant::now();
        let timestamp = wall();
        for second in (0..=120).step_by(5) {
            engine.observe_at_rate(
                Some(frame(f64::from(second * 2), true)),
                start + Duration::from_secs(second as u64),
                timestamp + second as u64,
                2.0,
            );
            if second == 60 {
                assert!(engine.pending.is_empty());
            }
        }
        assert_eq!(engine.pending.len(), 2);
        assert!((engine.current.as_ref().unwrap().played - 120.0).abs() < 0.01);
    }
    #[tokio::test]
    async fn retries_webhooks_with_the_same_id_and_does_not_expose_saved_secrets() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = std::env::temp_dir().join(format!("sc-listening-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(&root).unwrap());
        let service = Listening::new(&root, store.clone()).unwrap();
        service
            .configure(Options {
                lastfm_enabled: false,
                webhook_enabled: true,
                webhook_trigger: 50,
                parse_title: true,
                api_key: String::new(),
                api_secret: None,
                webhook_url: Some("https://example.test/private-key".into()),
            })
            .unwrap();
        let public = service.status(false).to_string();
        assert!(!public.contains("private-key"));
        assert!(service.status(true).get("webhookUrl").is_none());
        let reopened = Listening::new(&root, store.clone()).unwrap();
        assert_eq!(
            reopened.engine.lock().unwrap().config.webhook_url,
            "https://example.test/private-key"
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for status in ["429 Too Many Requests", "204 No Content"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    assert!(bytes.len() < 20000);
                    if let Some(at) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..at]).to_lowercase();
                        let length: usize = header
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() >= at + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            requests
        });
        let mut engine = engine();
        engine.config.webhook_trigger = 0;
        engine.observe(Some(frame(0.0, true)), Instant::now(), wall());
        let delivery = engine
            .pending
            .iter()
            .find(|entry| entry.kind == Kind::Webhook)
            .unwrap()
            .clone();
        let config = Config {
            webhook_url: format!("http://{address}/hook"),
            ..engine.config
        };
        assert!(service.deliver(&delivery, &config).await == Outcome::Retry);
        assert!(service.deliver(&delivery, &config).await == Outcome::Sent);
        let requests = server.await.unwrap();
        for request in requests {
            assert!(
                request
                    .to_lowercase()
                    .contains(&format!("idempotency-key: {}", delivery.id))
            );
            let body = request.split("\r\n\r\n").nth(1).unwrap();
            let body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(body["artist"], "Artist");
            assert_eq!(body["track"], "Song");
            assert!(body["timestamp"].as_str().unwrap().contains('T'));
        }
        drop(reopened);
        drop(service);
        drop(store);
        std::fs::remove_file(root.join("native-listening.dat")).unwrap();
        std::fs::remove_file(root.join("native.lock")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    fn frame(position: f64, playing: bool) -> Track {
        Track {
            title: "Artist — Song".into(),
            author: "Uploader".into(),
            url: "https://soundcloud.com/artist/song".into(),
            artwork: String::new(),
            elapsed: position,
            duration: 240.0,
            playing,
        }
    }
    fn engine() -> Engine {
        Engine::new(
            Config {
                lastfm_enabled: true,
                session_key: "a".repeat(32),
                webhook_enabled: true,
                webhook_url: "https://example.test/hook".into(),
                ..Default::default()
            },
            Vec::new(),
        )
    }
    #[test]
    fn requires_confirmed_progress_and_deduplicates_both_services() {
        let mut engine = engine();
        let start = Instant::now();
        let timestamp = wall();
        for second in (0..=130).step_by(5) {
            engine.observe(
                Some(frame(f64::from(second), true)),
                start + Duration::from_secs(second as u64),
                timestamp + second as u64,
            );
        }
        assert_eq!(engine.pending.len(), 2);
        assert_eq!(engine.pending[0].artist, "Artist");
        assert_eq!(engine.pending[0].track, "Song");
        let saved = serde_json::to_value(&engine.pending).unwrap();
        let restarted = Engine::new(
            engine.config.clone(),
            serde_json::from_value(saved).unwrap(),
        );
        assert_eq!(restarted.pending.len(), 2);
        assert!(restarted.status_secret_free());
    }
    impl Engine {
        fn status_secret_free(&self) -> bool {
            !serde_json::to_string(&self.pending)
                .unwrap()
                .contains(&self.config.session_key)
        }
    }
    #[test]
    fn sleep_pause_seek_and_unknown_duration_do_not_invent_listening() {
        let mut engine = engine();
        let start = Instant::now();
        engine.observe(Some(frame(0.0, true)), start, 1000);
        engine.observe(
            Some(frame(1.0, false)),
            start + Duration::from_secs(3600),
            4600,
        );
        engine.observe(
            Some(frame(1.0, true)),
            start + Duration::from_secs(3601),
            4601,
        );
        engine.observe(
            Some(frame(180.0, true)),
            start + Duration::from_secs(3602),
            4602,
        );
        assert!(engine.pending.is_empty());
        engine.config.webhook_trigger = 0;
        let mut unknown = frame(0.0, true);
        unknown.duration = 0.0;
        unknown.url = "https://soundcloud.com/artist/new".into();
        engine.observe(Some(unknown), start + Duration::from_secs(3603), 4603);
        assert!(engine.pending.is_empty());
    }
    #[test]
    fn disconnect_and_credential_rotation_drop_old_scope_deliveries() {
        let mut engine = engine();
        let start = Instant::now();
        for second in (0..=120).step_by(5) {
            engine.observe(
                Some(frame(f64::from(second), true)),
                start + Duration::from_secs(second as u64),
                1000 + second as u64,
            );
        }
        engine.config.lastfm_scope = scope();
        engine.prune(1130);
        assert_eq!(engine.pending.len(), 1);
        assert!(engine.pending[0].kind == Kind::Webhook);
    }
    #[test]
    fn validates_urls_and_matches_the_lastfm_signature_contract() {
        assert!(webhook_url("https://example.test/hook?token=test"));
        assert!(!webhook_url("https://user:pass@example.test/"));
        assert!(!webhook_url("http://example.test/"));
        let fields = BTreeMap::from([
            ("api_key".into(), "key".into()),
            ("method".into(), "auth.getSession".into()),
            ("token".into(), "token".into()),
        ]);
        assert_eq!(
            api_signature(&fields, "secret"),
            format!(
                "{:x}",
                Md5::digest(b"api_keykeymethodauth.getSessiontokentokensecret")
            )
        );
        assert_eq!(
            normalize("not-a-parser-match", "Uploader", true),
            ("Uploader".into(), "not-a-parser-match".into())
        );
    }
}
