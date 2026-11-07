use crate::{State, catalog::Operation, guard};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    title: String,
    artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_seconds: Option<f64>,
}
impl Track {
    fn valid(&self) -> bool {
        !self.title.trim().is_empty()
            && !self.artist.trim().is_empty()
            && self.title.len() <= 800
            && self.artist.len() <= 800
            && self.source_id.as_ref().is_none_or(|id| {
                id.strip_prefix("spotify:track:").is_some_and(|id| {
                    id.len() == 22 && id.bytes().all(|c| c.is_ascii_alphanumeric())
                })
            })
            && self
                .duration_seconds
                .is_none_or(|duration| duration.is_finite() && (0.0..=86400.0).contains(&duration))
    }
    fn key(&self) -> String {
        self.source_id
            .clone()
            .unwrap_or_else(|| format!("{}|{}", self.artist, self.title))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    title: String,
    tracks: Vec<Row>,
    total: Option<usize>,
    reachable: bool,
}
#[derive(Deserialize)]
struct Row {
    #[serde(flatten)]
    track: Track,
    position: usize,
}

struct Job {
    id: String,
    owner: u64,
    revision: u64,
    url: String,
    title: String,
    tracks: HashMap<String, (usize, Track)>,
    total: Option<usize>,
    reachable: bool,
    started: Instant,
}
impl Job {
    fn new(
        id: String,
        owner: u64,
        revision: u64,
        url: String,
        initial: Value,
    ) -> Result<Self, String> {
        let tracks: Vec<Track> = serde_json::from_value(initial["tracks"].clone())
            .map_err(|_| "Invalid Spotify tracks")?;
        let title = initial["title"]
            .as_str()
            .filter(|title| title.len() <= 800)
            .ok_or("Invalid Spotify title")?
            .to_string();
        if initial["platform"] != "spotify"
            || tracks.len() > 500
            || tracks.iter().any(|track| !track.valid())
            || id.len() < 16
            || id.len() > 64
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("Invalid Spotify import".into());
        }
        Ok(Self {
            id,
            owner,
            revision,
            url,
            title,
            tracks: tracks
                .into_iter()
                .enumerate()
                .map(|(i, track)| (track.key(), (i + 1, track)))
                .collect(),
            total: initial["expectedTracks"]
                .as_u64()
                .filter(|n| (1..=1_000_000).contains(n))
                .map(|n| n as usize),
            reachable: false,
            started: Instant::now(),
        })
    }
    fn observe(&mut self, page: Snapshot) -> Result<(), String> {
        if page.tracks.len() > 500
            || page.title.len() > 800
            || page.tracks.iter().any(|row| {
                !row.track.valid()
                    || row.position == 0
                    || row.position > 1_000_000
                    || row.track.source_id.is_none()
            })
        {
            return Err("Invalid Spotify page".into());
        }
        self.reachable |= page.reachable;
        if !page.title.trim().is_empty() {
            self.title = page.title;
        }
        self.total = page
            .total
            .filter(|n| (1..=1_000_000).contains(n))
            .or(self.total);
        for row in page.tracks {
            let legacy = format!("{}|{}", row.track.artist, row.track.title);
            self.tracks.remove(&legacy);
            let key = row.track.key();
            if self.tracks.len() < 500 || self.tracks.contains_key(&key) {
                self.tracks.insert(key, (row.position, row.track));
            }
        }
        Ok(())
    }
    fn result(&self) -> Value {
        let mut ordered: Vec<_> = self.tracks.values().collect();
        ordered.sort_by_key(|(position, _)| *position);
        let limit = ordered.len() >= 500 && self.total.is_none_or(|total| total > 500);
        let partial = limit || !self.total.is_some_and(|total| ordered.len() >= total);
        let mut result = json!({"platform": "spotify", "title": self.title, "tracks": ordered.iter().map(|(_, track)| track).collect::<Vec<_>>(),
            "readTracks": ordered.len(), "pagesRead": ordered.len().div_ceil(50).max(1), "partial": partial });
        if let Some(total) = self.total {
            result["expectedTracks"] = json!(total);
        }
        if partial {
            result["partialReason"] = json!(if limit { "limit" } else { "authorization" });
        }
        result
    }
}

#[derive(Default)]
pub struct Imports {
    job: Mutex<Option<Job>>,
    relay: tokio::sync::Mutex<Option<crate::relay::Server>>,
}

fn allowed(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && [
            Some("open.spotify.com"),
            Some("accounts.spotify.com"),
            Some("challenge.spotify.com"),
        ]
        .contains(&url.host_str())
}
fn source_url(input: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(input).map_err(|_| "Invalid Spotify URL")?;
    let parts: Vec<_> = url.path().split('/').collect();
    if !allowed(&url)
        || url.host_str() != Some("open.spotify.com")
        || url.query().is_some()
        || url.fragment().is_some()
        || parts.len() != 3
        || !["playlist", "album"].contains(&parts[1])
        || parts[2].len() != 22
        || !parts[2].bytes().all(|c| c.is_ascii_alphanumeric())
    {
        return Err("Use a Spotify playlist or album URL".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn spotify_open(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    id: String,
    owner: u64,
    url: String,
    initial: Value,
) -> Result<(), String> {
    guard(&window, &state)?;
    let url = source_url(&url)?;
    if state.catalog.execute(Operation::Me, false).await?["id"].as_u64() != Some(owner) {
        return Err("SoundCloud account changed".into());
    }
    let revision = state.catalog.diagnostics()["revision"]
        .as_u64()
        .ok_or("Account unavailable")?;
    let job = Job::new(id.clone(), owner, revision, url.to_string(), initial)?;
    {
        let mut current = state.spotify.job.lock().unwrap();
        if current.is_some() {
            return Err("A Spotify import is already running".into());
        }
        *current = Some(job);
    }
    let result = async {
        let port = if let Some(port) = state.relay_port {
            Some(port)
        } else {
            let mut relay = state.spotify.relay.lock().await;
            if relay.is_none() {
                let connection = state.connection.lock().unwrap().clone();
                if let Some(config) = connection.filter(|config| config.mode != "off") {
                    *relay = Some(crate::relay::serve(config).await?);
                }
            }
            relay.as_ref().map(|server| server.port)
        };
        let mut args = "--autoplay-policy=user-gesture-required --mute-audio".to_string();
        if let Some(port) = port {
            args.push_str(&format!(
                " --proxy-pac-url=http://127.0.0.1:{port}/proxy.pac"
            ));
        }
        let script = format!(
            "window.__nativeSpotifyJobId={};{}",
            serde_json::to_string(&id).unwrap(),
            include_str!("../assets/spotifyReader.js")
        );
        WebviewWindowBuilder::new(&app, "spotify-import", WebviewUrl::External(url))
            .title("Spotify · SoundCloud")
            .inner_size(1050.0, 780.0)
            .visible(false)
            .data_directory(state.profile.join("Spotify").join(owner.to_string()))
            .additional_browser_args(&args)
            .initialization_script(script)
            .on_navigation(allowed)
            .build()
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(())
    }
    .await;
    if result.is_err() {
        state.spotify.job.lock().unwrap().take();
    } else {
        let state = state.inner().clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(390)).await;
            close(&state, &app, &id);
        });
    }
    result
}

#[tauri::command]
pub async fn spotify_page(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    id: String,
    snapshot: Snapshot,
) -> Result<(), String> {
    let url = window.url().map_err(|_| "Spotify page unavailable")?;
    if window.label() != "spotify-import"
        || !allowed(&url)
        || url.host_str() != Some("open.spotify.com")
    {
        return Err("Spotify reader is unavailable on this page".into());
    }
    let mut current = state.spotify.job.lock().unwrap();
    let job = current
        .as_mut()
        .filter(|job| job.id == id && job.started.elapsed() < Duration::from_secs(390))
        .ok_or("Spotify import expired")?;
    job.observe(snapshot)
}

#[tauri::command]
pub async fn spotify_state(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<Value, String> {
    guard(&window, &state)?;
    let (owner, revision, address) = {
        let current = state.spotify.job.lock().unwrap();
        let job = current
            .as_ref()
            .filter(|job| job.id == id)
            .ok_or("Spotify import expired")?;
        (job.owner, job.revision, job.url.clone())
    };
    let current_revision = state.catalog.diagnostics()["revision"]
        .as_u64()
        .ok_or("Account unavailable")?;
    if current_revision != revision {
        if state.catalog.execute(Operation::Me, false).await?["id"].as_u64() != Some(owner) {
            return Err("SoundCloud account changed".into());
        }
        if let Some(job) = state
            .spotify
            .job
            .lock()
            .unwrap()
            .as_mut()
            .filter(|job| job.id == id)
        {
            job.revision = current_revision;
        }
    }
    let browser = app.get_webview_window("spotify-import");
    if let Some(browser) = &browser {
        let current = browser.url().map_err(|_| "Spotify page unavailable")?;
        if current.host_str() == Some("open.spotify.com")
            && !current.path().starts_with("/playlist/")
            && !current.path().starts_with("/album/")
        {
            browser
                .navigate(address.parse().map_err(|_| "Invalid Spotify URL")?)
                .map_err(|error| error.to_string())?;
        } else {
            let _ = browser.eval("void window.__nativeSpotifyRead?.()");
        }
    }
    let current = state.spotify.job.lock().unwrap();
    let job = current
        .as_ref()
        .filter(|job| job.id == id)
        .ok_or("Spotify import expired")?;
    Ok(json!({"playlist": job.result(), "reachable": job.reachable, "closed": browser.is_none()}))
}

#[tauri::command]
pub async fn spotify_show(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    guard(&window, &state)?;
    if !state
        .spotify
        .job
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|job| job.id == id)
    {
        return Err("Spotify import expired".into());
    }
    let browser = app
        .get_webview_window("spotify-import")
        .ok_or("Spotify window was closed")?;
    browser.show().map_err(|error| error.to_string())?;
    browser.set_focus().map_err(|error| error.to_string())?;
    let _ = browser.eval("document.querySelector('[data-testid=login-button]')?.click()");
    Ok(())
}

fn close(state: &State, app: &tauri::AppHandle, id: &str) {
    let mut current = state.spotify.job.lock().unwrap();
    if current.as_ref().is_some_and(|job| job.id == id) {
        if let Some(browser) = app.get_webview_window("spotify-import") {
            let _ = browser.destroy();
        }
        current.take();
    }
}

#[tauri::command]
pub async fn spotify_close(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    guard(&window, &state)?;
    close(&state, &app, &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(id: &str) -> Value {
        json!({"title": "Track", "artist": "Artist", "sourceId": format!("spotify:track:{id}")})
    }
    #[test]
    fn merges_virtualized_pages_and_never_marks_an_incomplete_list_complete() {
        let mut job = Job::new("request-000000001".into(), 7, 1, "https://open.spotify.com/playlist/1234567890123456789012".into(), json!({"platform":"spotify","title":"Import","tracks":[{"title":"Track","artist":"Artist"}],"expectedTracks":2})).unwrap();
        job.observe(serde_json::from_value(json!({"title":"Import","reachable":true,"total":2,"tracks":[{"position":1,"title":"Track","artist":"Artist","sourceId":"spotify:track:1234567890123456789012"}]})).unwrap()).unwrap();
        assert_eq!(job.result()["tracks"].as_array().unwrap().len(), 1);
        assert_eq!(job.result()["partial"], true);
        let mut row = track("1234567890123456789013");
        row["position"] = json!(2);
        job.observe(
            serde_json::from_value(
                json!({"title":"Import","reachable":true,"total":2,"tracks":[row]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(job.result()["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(job.result()["partial"], false);
    }
    #[test]
    fn rejects_unrelated_urls_and_malformed_rows() {
        for address in [
            "https://evil.test/playlist/1234567890123456789012",
            "https://open.spotify.com/account",
            "https://x@open.spotify.com/playlist/1234567890123456789012",
        ] {
            assert!(source_url(address).is_err());
        }
        assert!(source_url("https://open.spotify.com/album/1234567890123456789012").is_ok());
        let mut row: Track = serde_json::from_value(track("1234567890123456789012")).unwrap();
        assert!(row.valid());
        row.duration_seconds = Some(-1.0);
        assert!(!row.valid());
    }
}
