use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use url::Url;

#[derive(Clone, Default)]
struct Context {
    client: String,
    authorization: String,
    revision: u64,
    owner: u64,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Me,
    Likes {
        owner: u64,
        offset: Option<u32>,
    },
    Related {
        id: u64,
        offset: Option<u32>,
    },
    Search {
        query: String,
    },
    Tracks {
        ids: Vec<u64>,
    },
    Resolve {
        url: String,
    },
    Radio {
        path: String,
        params: BTreeMap<String, String>,
    },
    CreatePlaylist {
        title: String,
        tracks: Vec<u64>,
    },
    UpdatePlaylist {
        id: u64,
        title: String,
        tracks: Vec<u64>,
    },
    Playlist {
        id: u64,
    },
    CleanupPlaylist {
        id: u64,
    },
}

type PreparedRequest = (
    reqwest::Method,
    String,
    Vec<(String, String)>,
    Option<Value>,
);

impl Operation {
    fn request(&self) -> Result<PreparedRequest, String> {
        let id = |value: u64| {
            if value > 0 && value < (1u64 << 53) {
                Ok(value)
            } else {
                Err("Invalid track or account ID".to_string())
            }
        };
        let mut params = vec![("limit".into(), "50".into())];
        let path = match self {
            Self::UpdatePlaylist {
                id: playlist,
                title,
                tracks,
            } => {
                id(*playlist)?;
                Self::CreatePlaylist {
                    title: title.clone(),
                    tracks: tracks.clone(),
                }
                .request()?;
                return Ok((
                    reqwest::Method::PUT,
                    format!("/playlists/{playlist}"),
                    Vec::new(),
                    Some(json!({"playlist": {"title": title.trim(), "tracks": tracks}})),
                ));
            }
            Self::Playlist { id: playlist } => {
                id(*playlist)?;
                format!("/playlists/{playlist}")
            }
            Self::CleanupPlaylist { id: playlist } => {
                id(*playlist)?;
                return Ok((
                    reqwest::Method::DELETE,
                    format!("/playlists/{playlist}"),
                    Vec::new(),
                    None,
                ));
            }
            Self::Radio { path, params } => {
                crate::radio::validate(path, params)?;
                return Ok((
                    reqwest::Method::GET,
                    path.clone(),
                    params.clone().into_iter().collect(),
                    None,
                ));
            }
            Self::Me => "/me".into(),
            Self::Likes { owner, offset } => {
                id(*owner)?;
                params.push(("offset".into(), offset.unwrap_or(0).min(5000).to_string()));
                format!("/users/{owner}/likes")
            }
            Self::Related { id: track, offset } => {
                id(*track)?;
                params.push(("offset".into(), offset.unwrap_or(0).min(500).to_string()));
                format!("/tracks/{track}/related")
            }
            Self::Search { query } => {
                if query.trim().is_empty() || query.len() > 600 {
                    return Err("Invalid search query".into());
                }
                params.push(("q".into(), query.trim().into()));
                "/search/tracks".into()
            }
            Self::Tracks { ids } => {
                if ids.is_empty() || ids.len() > 50 {
                    return Err("Invalid batch size".into());
                }
                for track in ids {
                    id(*track)?;
                }
                params.push((
                    "ids".into(),
                    ids.iter().map(u64::to_string).collect::<Vec<_>>().join(","),
                ));
                "/tracks".into()
            }
            Self::Resolve { url } => {
                if !track_url(url) {
                    return Err("Invalid SoundCloud track URL".into());
                }
                params.push(("url".into(), url.clone()));
                "/resolve".into()
            }
            Self::CreatePlaylist { title, tracks } => {
                if title.trim().is_empty()
                    || title.chars().count() > 100
                    || tracks.is_empty()
                    || tracks.len() > 500
                {
                    return Err("A playlist requires a title and 1–500 available tracks".into());
                }
                for track in tracks {
                    id(*track)?;
                }
                return Ok((
                    reqwest::Method::POST,
                    "/playlists".into(),
                    Vec::new(),
                    Some(json!({"playlist": {
                        "title": title.trim(), "sharing": "private", "tracks": tracks
                    }})),
                ));
            }
        };
        Ok((reqwest::Method::GET, path, params, None))
    }
}

pub fn track_url(input: &str) -> bool {
    let Ok(url) = Url::parse(input) else {
        return false;
    };
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    url.scheme() == "https"
        && url.host_str() == Some("soundcloud.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.~-".contains(&c))
        })
}

#[derive(Default, Serialize)]
pub struct Metrics {
    pub requests: u64,
    pub cache_hits: u64,
    pub errors: u64,
    pub last_status: u16,
}

pub struct Catalog {
    context: Mutex<Context>,
    client: reqwest::Client,
    cache: Mutex<crate::cache::ResponseCache>,
    metrics: Mutex<Metrics>,
    all: Arc<Semaphore>,
    background: Arc<Semaphore>,
    cooldown: Mutex<Option<Instant>>,
    created_playlists: Mutex<HashMap<u64, u64>>,
}

impl Catalog {
    pub fn new(proxy: Option<&str>) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("SoundCloudNative/0.1");
        if let Some(proxy) = proxy {
            builder = builder.proxy(reqwest::Proxy::https(proxy).map_err(|_| "Invalid proxy")?);
        }
        Ok(Self {
            context: Mutex::new(Context::default()),
            client: builder.build().map_err(|e| e.to_string())?,
            cache: Mutex::new(crate::cache::ResponseCache::new(32 * 1024 * 1024)),
            metrics: Mutex::new(Metrics::default()),
            all: Arc::new(Semaphore::new(10)),
            background: Arc::new(Semaphore::new(8)),
            cooldown: Mutex::new(None),
            created_playlists: Mutex::new(HashMap::new()),
        })
    }

    pub fn observe(&self, address: &str, authorization: &str) {
        let Ok(url) = Url::parse(address) else {
            return;
        };
        if url.scheme() != "https" || url.host_str() != Some("api-v2.soundcloud.com") {
            return;
        }
        let client = url
            .query_pairs()
            .find(|(key, _)| key == "client_id")
            .map(|(_, value)| value.into_owned());
        let mut context = self.context.lock().unwrap();
        if let Some(client) = client.filter(|s| {
            s.len() >= 16 && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric())
        }) {
            context.client = client;
        }
        let auth = authorization.trim();
        if auth.len() <= 1024
            && (auth.starts_with("OAuth ") || auth.starts_with("Bearer "))
            && !auth.contains(['\r', '\n'])
            && context.authorization != auth
        {
            context.authorization = auth.into();
            context.revision += 1;
            context.owner = 0;
            self.cache.lock().unwrap().clear();
        }
    }

    pub fn reset(&self) {
        let mut context = self.context.lock().unwrap();
        context.authorization.clear();
        context.revision += 1;
        context.owner = 0;
        self.cache.lock().unwrap().clear();
    }

    pub fn diagnostics(&self) -> Value {
        let context = self.context.lock().unwrap();
        let cache = self.cache.lock().unwrap();
        json!({"ready": !context.client.is_empty(), "authenticated": !context.authorization.is_empty(), "revision": context.revision,
            "cacheEntries": cache.len(), "cacheEstimatedBytes": cache.bytes(), "metrics": *self.metrics.lock().unwrap()})
    }

    pub fn permits_profile(&self, key: &str) -> bool {
        if key == "settings" {
            return true;
        }
        let context = self.context.lock().unwrap();
        context.owner > 0
            && (key == format!("wave-{}", context.owner)
                || key == format!("import-{}", context.owner))
    }

    pub async fn validate_profile(&self, key: &str) -> Result<(), String> {
        if key != "settings" && self.context.lock().unwrap().owner == 0 {
            self.execute(Operation::Me, false).await?;
        }
        if self.permits_profile(key) {
            Ok(())
        } else {
            Err("Profile belongs to another SoundCloud account".into())
        }
    }

    pub async fn execute_scoped(
        &self,
        operation: Operation,
        background: bool,
        owner: Option<u64>,
    ) -> Result<Value, String> {
        if matches!(
            operation,
            Operation::CreatePlaylist { .. } | Operation::UpdatePlaylist { .. }
        ) && owner.is_none()
        {
            return Err("Playlist writes require an expected SoundCloud account".into());
        }
        if let Some(owner) = owner {
            let user = self.execute(Operation::Me, false).await?;
            if user["id"].as_u64() != Some(owner) {
                return Err("SoundCloud account changed".into());
            }
            if let Operation::UpdatePlaylist { id, .. } = &operation {
                let playlist = self.execute(Operation::Playlist { id: *id }, false).await?;
                if playlist["user"]["id"].as_u64() != Some(owner) {
                    return Err("Playlist belongs to another SoundCloud account".into());
                }
            }
        }
        self.execute_checked(operation, background, owner).await
    }

    pub async fn execute(&self, operation: Operation, background: bool) -> Result<Value, String> {
        self.execute_checked(operation, background, None).await
    }

    async fn execute_checked(
        &self,
        operation: Operation,
        background: bool,
        owner: Option<u64>,
    ) -> Result<Value, String> {
        let (method, path, params, body) = operation.request()?;
        let mutation = method != reqwest::Method::GET;
        let cacheable = !mutation
            && !matches!(&operation, Operation::Playlist { .. })
            && !(path.starts_with("/users/") && path.ends_with("/playlists"));
        let method_name = method.as_str().to_string();
        let context = self.context.lock().unwrap().clone();
        if owner.is_some_and(|owner| context.owner != owner) {
            return Err("SoundCloud account changed".into());
        }
        if let Operation::CleanupPlaylist { id } = &operation
            && self.created_playlists.lock().unwrap().get(id) != Some(&context.owner)
        {
            return Err("Cleanup only permits playlists created by this running client".into());
        }
        if context.client.is_empty() {
            return Err("Open SoundCloud and sign in so its API context becomes available".into());
        }
        if (mutation
            || path == "/me"
            || path.starts_with("/me/")
            || path == "/stream"
            || path == "/mixed-selections"
            || path.ends_with("/likes"))
            && context.authorization.is_empty()
        {
            return Err("Sign in to SoundCloud first".into());
        }
        let mut url = Url::parse("https://api-v2.soundcloud.com").unwrap();
        url.set_path(&path);
        url.query_pairs_mut()
            .extend_pairs(&params)
            .append_pair("client_id", &context.client);
        let key = format!("{}:{}", context.revision, url);
        if cacheable && let Some(value) = self.cache.lock().unwrap().get(&key) {
            self.metrics.lock().unwrap().cache_hits += 1;
            return Ok(value);
        }
        if self
            .cooldown
            .lock()
            .unwrap()
            .is_some_and(|until| Instant::now() < until)
        {
            return Err("SoundCloud rate limit: wait before retrying".into());
        }
        let _background = if background {
            Some(
                self.background
                    .acquire()
                    .await
                    .map_err(|_| "Shutting down")?,
            )
        } else {
            None
        };
        let _permit = self.all.acquire().await.map_err(|_| "Shutting down")?;
        if self
            .cooldown
            .lock()
            .unwrap()
            .is_some_and(|until| Instant::now() < until)
        {
            return Err("SoundCloud rate limit: wait before retrying".into());
        }
        if self.context.lock().unwrap().revision != context.revision {
            return Err("Account changed".into());
        }
        if mutation {
            self.cache.lock().unwrap().clear();
        }
        let mut request = self
            .client
            .request(method, url)
            .header("Accept", "application/json")
            .header("Origin", "https://soundcloud.com");
        if !context.authorization.is_empty() {
            request = request.header("Authorization", &context.authorization);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        self.metrics.lock().unwrap().requests += 1;
        let response = request.send().await.map_err(|_| {
            self.metrics.lock().unwrap().errors += 1;
            "SoundCloud network request failed".to_string()
        })?;
        let status = response.status();
        self.metrics.lock().unwrap().last_status = status.as_u16();
        if !status.is_success() {
            self.metrics.lock().unwrap().errors += 1;
            if status.as_u16() == 429 {
                let delay = response
                    .headers()
                    .get("retry-after")
                    .and_then(|s| s.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(30)
                    .clamp(1, 3600);
                *self.cooldown.lock().unwrap() = Some(Instant::now() + Duration::from_secs(delay));
            }
            if status.as_u16() == 401 {
                let mut current = self.context.lock().unwrap();
                if current.revision == context.revision {
                    current.authorization.clear();
                    current.revision += 1;
                    current.owner = 0;
                    self.cache.lock().unwrap().clear();
                }
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(Ok(chunk)) = stream.next().await {
                if bytes.len() + chunk.len() > 16384 {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            let detail = if bytes.len() < 65536 {
                serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .and_then(|value| {
                        value["message"]
                            .as_str()
                            .or_else(|| value["error"].as_str())
                            .or_else(|| value["errors"][0]["error_message"].as_str())
                            .map(str::to_string)
                    })
            } else {
                None
            };
            let detail = detail
                .map(|text| {
                    (if context.authorization.is_empty() {
                        text
                    } else {
                        text.replace(&context.authorization, "[redacted]")
                    })
                    .chars()
                    .take(240)
                    .collect::<String>()
                })
                .unwrap_or_else(|| "no API error message".into());
            return Err(format!(
                "SoundCloud HTTP {} ({method_name} {path}): {detail}",
                status.as_u16()
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Incomplete SoundCloud response")?;
            if bytes.len() + chunk.len() > 8_000_000 {
                return Err("SoundCloud response too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = if bytes.is_empty() && mutation {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| "Invalid SoundCloud JSON")?
        };
        {
            let mut current = self.context.lock().unwrap();
            if current.revision != context.revision {
                return Err("Account changed".into());
            }
            if path == "/me"
                && let Some(owner) = value["id"].as_u64()
            {
                current.owner = owner;
            }
        }
        let mut cache = self.cache.lock().unwrap();
        if matches!(operation, Operation::CreatePlaylist { .. }) {
            if let Some(id) = value["id"]
                .as_u64()
                .or_else(|| value["playlist"]["id"].as_u64())
            {
                self.created_playlists
                    .lock()
                    .unwrap()
                    .insert(id, context.owner);
            }
        } else if let Operation::CleanupPlaylist { id } = operation {
            self.created_playlists.lock().unwrap().remove(&id);
        }
        if mutation {
            cache.clear();
        } else if cacheable {
            cache.insert(key, value.clone());
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn playlist_writes_require_scope_before_network_and_reject_a_stale_owner() {
        let catalog = Catalog::new(None).unwrap();
        let write = || Operation::CreatePlaylist {
            title: "Import".into(),
            tracks: vec![7],
        };
        assert!(catalog.execute_scoped(write(), true, None).await.is_err());
        assert!(
            catalog
                .execute_checked(write(), true, Some(8))
                .await
                .is_err()
        );
        assert_eq!(catalog.metrics.lock().unwrap().requests, 0);
        let (method, path, _, _) = Operation::UpdatePlaylist {
            id: 12,
            title: "Import".into(),
            tracks: vec![7, 8],
        }
        .request()
        .unwrap();
        assert_eq!(method, reqwest::Method::PUT);
        assert_eq!(path, "/playlists/12");
    }
    #[test]
    fn fixed_requests_do_not_accept_arbitrary_urls() {
        for url in [
            "http://soundcloud.com/a/b",
            "https://soundcloud.com.evil.test/a/b",
            "https://soundcloud.com/a/b?q=x",
            "https://x@soundcloud.com/a/b",
            "https://soundcloud.com/a/b/c",
        ] {
            assert!(!track_url(url));
        }
        assert!(track_url("https://soundcloud.com/artist-1/track_2"));
        assert!(Operation::Tracks { ids: vec![0] }.request().is_err());
        assert!(
            Operation::CreatePlaylist {
                title: "Partial".into(),
                tracks: vec![7]
            }
            .request()
            .is_ok()
        );
        assert!(
            Operation::CreatePlaylist {
                title: "Empty".into(),
                tracks: vec![]
            }
            .request()
            .is_err()
        );
    }
    #[test]
    fn context_never_exposes_credentials_in_diagnostics() {
        let catalog = Catalog::new(None).unwrap();
        catalog.observe(
            "https://evil.test/?client_id=0123456789abcdef",
            "OAuth secret",
        );
        assert_eq!(catalog.diagnostics()["ready"], false);
        catalog.observe(
            "https://api-v2.soundcloud.com/me?client_id=0123456789abcdef",
            "OAuth private-token",
        );
        assert_eq!(catalog.diagnostics()["authenticated"], true);
        assert!(!catalog.diagnostics().to_string().contains("private-token"));
        catalog.reset();
        assert_eq!(catalog.diagnostics()["authenticated"], false);
    }

    #[test]
    fn account_profiles_are_not_shared_between_logins() {
        let catalog = Catalog::new(None).unwrap();
        assert!(catalog.permits_profile("settings"));
        assert!(!catalog.permits_profile("wave-42"));
        catalog.context.lock().unwrap().owner = 42;
        assert!(catalog.permits_profile("wave-42"));
        assert!(catalog.permits_profile("import-42"));
        assert!(!catalog.permits_profile("wave-43"));
        catalog.reset();
        assert!(!catalog.permits_profile("import-42"));
    }

    #[test]
    fn playlist_contract_uses_api_v2_numeric_track_ids() {
        let (method, path, _, body) = Operation::CreatePlaylist {
            title: "Found tracks".into(),
            tracks: vec![7, 11],
        }
        .request()
        .unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/playlists");
        assert_eq!(
            body.unwrap(),
            json!({"playlist": {"title": "Found tracks", "sharing": "private", "tracks": [7, 11]}})
        );
    }
}
