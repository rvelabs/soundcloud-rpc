use adblock::{
    Engine,
    lists::{FilterSet, ParseOptions, RuleTypes},
    request::Request,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const BUNDLED: &str = include_str!("../assets/adblock-easylist.txt");
const SOURCE: &str = "https://easylist.to/easylist/easylist.txt";
const LIMIT: usize = 4_000_000;
const MAX_AGE: Duration = Duration::from_secs(4 * 86400);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Decision {
    Allow,
    Empty,
    SilentAudio,
}

struct Rules {
    engine: Engine,
    count: usize,
    compile_ms: u128,
}
#[derive(Default)]
struct Status {
    source: &'static str,
    rules: usize,
    compile_ms: u128,
    error: Option<&'static str>,
    last_host: String,
}
pub struct AdBlock {
    enabled: AtomicBool,
    attached: AtomicBool,
    updating: AtomicBool,
    checked: AtomicU64,
    blocked: AtomicU64,
    rules: Mutex<Rules>,
    status: Mutex<Status>,
    cache: PathBuf,
}

fn compile(text: String) -> Result<Rules, String> {
    if text.len() > LIMIT
        || !text.starts_with("[Adblock Plus")
        || text.lines().take(120001).count() > 120000
    {
        return Err("Invalid ad blocking list".into());
    }
    let count = text
        .lines()
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with(['!', '['])
                && !line.contains("##")
                && !line.contains("#@#")
        })
        .count();
    if count < 1000 {
        return Err("Ad blocking list is incomplete".into());
    }
    let started = Instant::now();
    let mut set = FilterSet::new(false);
    set.add_filter_list(
        text,
        ParseOptions {
            rule_types: RuleTypes::NetworkOnly,
            ..Default::default()
        },
    );
    Ok(Rules {
        engine: Engine::new_with_filter_set(set),
        count,
        compile_ms: started.elapsed().as_millis(),
    })
}
fn cached(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > LIMIT as u64 {
        return None;
    }
    let mut text = String::new();
    file.take(LIMIT as u64 + 1).read_to_string(&mut text).ok()?;
    (text.len() <= LIMIT).then_some(text)
}
fn domain(host: &str, root: &str) -> bool {
    host == root
        || host
            .strip_suffix(root)
            .is_some_and(|prefix| prefix.ends_with('.'))
}
fn protected(host: &str, path: &str, kind: &str) -> bool {
    kind == "document"
        || ["captcha-delivery.com", "datadome.co", "recaptcha.net"]
            .iter()
            .any(|root| domain(host, root))
        || (domain(host, "soundcloud.com")
            && [
                "/me",
                "/users",
                "/tracks",
                "/playlists",
                "/search",
                "/resolve",
                "/oauth",
                "/connect",
                "/sign-in",
                "/sign-out",
                "/stream",
                "/mixed-selections",
            ]
            .iter()
            .any(|prefix| {
                path == *prefix
                    || path
                        .strip_prefix(prefix)
                        .is_some_and(|rest| rest.starts_with('/'))
            }))
}
impl AdBlock {
    pub fn new(profile: &Path, enabled: bool) -> Result<Arc<Self>, String> {
        let cache = profile.join("adblock-easylist.txt");
        let loaded = cached(&cache).and_then(|text| compile(text).ok());
        let source = if loaded.is_some() { "cache" } else { "bundled" };
        let rules = loaded
            .map(Ok)
            .unwrap_or_else(|| compile(BUNDLED.to_owned()))?;
        let status = Status {
            source,
            rules: rules.count,
            compile_ms: rules.compile_ms,
            ..Default::default()
        };
        Ok(Arc::new(Self {
            enabled: AtomicBool::new(enabled),
            attached: AtomicBool::new(false),
            updating: AtomicBool::new(false),
            checked: AtomicU64::new(0),
            blocked: AtomicU64::new(0),
            rules: Mutex::new(rules),
            status: Mutex::new(status),
            cache,
        }))
    }
    pub fn attached(&self, value: bool) {
        self.attached.store(value, Ordering::Release);
    }
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }
    pub fn snapshot(&self) -> Value {
        let status = self.status.lock().unwrap();
        json!({"enabled":self.enabled.load(Ordering::Acquire), "attached":self.attached.load(Ordering::Acquire), "updating":self.updating.load(Ordering::Acquire), "rules":status.rules, "source":status.source, "compileMs":status.compile_ms, "checked":self.checked.load(Ordering::Relaxed), "blocked":self.blocked.load(Ordering::Relaxed), "lastBlockedHost":status.last_host, "error":status.error})
    }
    pub fn decide(&self, target: &str, source: &str, kind: &str, method: &str) -> Decision {
        if !self.enabled.load(Ordering::Acquire) || target.len() > 8192 {
            return Decision::Allow;
        }
        let Ok(source) = url::Url::parse(source) else {
            return Decision::Allow;
        };
        if source.scheme() != "https" || source.host_str() != Some("soundcloud.com") {
            return Decision::Allow;
        }
        let Ok(url) = url::Url::parse(target) else {
            return Decision::Allow;
        };
        if !["http", "https"].contains(&url.scheme()) {
            return Decision::Allow;
        }
        let host = url.host_str().unwrap_or("");
        if protected(host, url.path(), kind) {
            return Decision::Allow;
        }
        self.checked.fetch_add(1, Ordering::Relaxed);
        let first_party_ad = domain(host, "soundcloud.com")
            && (host == "promoted.soundcloud.com"
                || ["/audio-ad", "/audio-ads", "/promoted"]
                    .iter()
                    .any(|prefix| {
                        url.path() == *prefix
                            || url
                                .path()
                                .strip_prefix(prefix)
                                .is_some_and(|rest| rest.starts_with('/'))
                    }));
        let audio_payload = kind == "media"
            || (kind == "xmlhttprequest"
                && [".mp3", ".aac", ".ogg", ".m4a", ".wav"]
                    .iter()
                    .any(|suffix| url.path().ends_with(suffix)));
        let audio_ad = audio_payload
            && ((domain(host, "sndcdn.com") && url.path().starts_with("/audio/"))
                || (domain(host, "p-cdn.us") && url.path().starts_with("/public/")));
        let matched = first_party_ad
            || audio_ad
            || Request::new(target, source.as_str(), kind, method).is_ok_and(|request| {
                self.rules
                    .lock()
                    .unwrap()
                    .engine
                    .check_network_request(&request)
                    .should_block()
            });
        if !matched {
            return Decision::Allow;
        }
        self.blocked.fetch_add(1, Ordering::Relaxed);
        self.status.lock().unwrap().last_host = host.to_owned();
        if kind == "media" || audio_ad {
            Decision::SilentAudio
        } else {
            Decision::Empty
        }
    }
    pub async fn refresh(self: &Arc<Self>, force: bool) -> Result<(), String> {
        if !force
            && (!self.enabled.load(Ordering::Acquire)
                || self
                    .cache
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|at| at.elapsed().ok())
                    .is_some_and(|age| age < MAX_AGE))
        {
            return Ok(());
        }
        if self.updating.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let result = async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .https_only(true)
                .build()
                .map_err(|_| "Filter update client unavailable")?;
            let response = client
                .get(SOURCE)
                .send()
                .await
                .map_err(|_| "Filter update unavailable; existing rules retained")?;
            if !response.status().is_success() {
                return Err("Filter server rejected update; existing rules retained".to_string());
            }
            let text = String::from_utf8(crate::http::bytes(response, LIMIT).await?)
                .map_err(|_| "Invalid filter encoding")?;
            let compiled = text.clone();
            let rules = tauri::async_runtime::spawn_blocking(move || compile(compiled))
                .await
                .map_err(|_| "Filter compilation failed")??;
            let temporary = self.cache.with_extension("tmp");
            std::fs::write(&temporary, text).map_err(|_| "Could not save filter cache")?;
            std::fs::rename(&temporary, &self.cache)
                .map_err(|_| "Could not replace filter cache")?;
            let count = rules.count;
            let compile_ms = rules.compile_ms;
            *self.rules.lock().unwrap() = rules;
            let mut status = self.status.lock().unwrap();
            status.rules = count;
            status.compile_ms = compile_ms;
            status.source = "updated";
            status.error = None;
            Ok(())
        }
        .await;
        if result.is_err() {
            self.status.lock().unwrap().error =
                Some("Update unavailable; existing rules remain active");
        }
        self.updating.store(false, Ordering::Release);
        result
    }
}

pub fn silence() -> Vec<u8> {
    let samples = 2205u32;
    let mut bytes = Vec::with_capacity(44 + samples as usize * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + samples * 2).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&22050u32.to_le_bytes());
    bytes.extend_from_slice(&44100u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(samples * 2).to_le_bytes());
    bytes.resize(44 + samples as usize * 2, 0);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_audio_ads_without_matching_titles_or_normal_streams() {
        let path =
            std::env::temp_dir().join(format!("soundcloud-blocker-test-{}", uuid::Uuid::new_v4()));
        let blocker = AdBlock::new(&path, true).unwrap();
        let page = "https://soundcloud.com/you/likes";
        for (url, kind, expected) in [
            (
                "https://api-v2.soundcloud.com/audio-ads?client_id=private",
                "xmlhttprequest",
                Decision::Empty,
            ),
            (
                "https://promoted.soundcloud.com/",
                "xmlhttprequest",
                Decision::Empty,
            ),
            (
                "https://cf-media.sndcdn.com/audio/advert.mp3",
                "media",
                Decision::SilentAudio,
            ),
            (
                "https://cf-media.sndcdn.com/audio/advert.mp3",
                "xmlhttprequest",
                Decision::SilentAudio,
            ),
            (
                "https://cont-1.p-cdn.us/public/full-128kbps-mp3/ad.mp3",
                "media",
                Decision::SilentAudio,
            ),
            (
                "https://cf-media.sndcdn.com/track/stream.mp3",
                "media",
                Decision::Allow,
            ),
            (
                "https://api-v2.soundcloud.com/tracks/7?title=audio-ads",
                "xmlhttprequest",
                Decision::Allow,
            ),
            (
                "https://api-v2.soundcloud.com/me?client_id=private",
                "xmlhttprequest",
                Decision::Allow,
            ),
            (
                "https://geo.captcha-delivery.com/captcha/?ads=1",
                "subdocument",
                Decision::Allow,
            ),
            (
                "https://soundcloud.com/artist/audio-ads",
                "document",
                Decision::Allow,
            ),
            (
                "https://soundcloud.com.evil.test/audio-ads",
                "xmlhttprequest",
                Decision::Allow,
            ),
        ] {
            assert_eq!(blocker.decide(url, page, kind, "GET"), expected, "{url}");
        }
        assert_eq!(
            blocker.decide(
                "https://ad.doubleclick.net/pagead/ads",
                page,
                "script",
                "GET"
            ),
            Decision::Empty
        );
        assert_eq!(
            blocker.decide(
                "https://ad.doubleclick.net/pagead/ads",
                "https://example.com/",
                "script",
                "GET"
            ),
            Decision::Allow
        );
        blocker.set_enabled(false);
        assert_eq!(
            blocker.decide(
                "https://api-v2.soundcloud.com/audio-ads",
                page,
                "xmlhttprequest",
                "GET"
            ),
            Decision::Allow
        );
        assert!(!blocker.snapshot().to_string().contains("private"));
    }
    #[test]
    fn rejects_bad_cache_and_produces_decodable_short_audio() {
        assert!(compile("<html>blocked</html>".into()).is_err());
        assert!(compile("[Adblock Plus 2.0]\n||ads.example^".into()).is_err());
        let bytes = silence();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8,
            bytes.len()
        );
    }
}
