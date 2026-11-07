use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    sync::watch,
    time::Instant,
};

const CLIENT_ID: &str = "1090770350251458592";

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub enabled: bool,
    pub show_button: bool,
    pub show_icon: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            enabled: true,
            show_button: true,
            show_icon: false,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Track {
    pub title: String,
    pub author: String,
    pub url: String,
    pub artwork: String,
    pub playing: bool,
    pub elapsed: f64,
    pub duration: f64,
}
impl Track {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.title.len() > 1200
            || self.url.len() > 2048
            || self.author.len() > 1200
            || self.artwork.len() > 2048
            || !crate::catalog::track_url(&self.url)
            || !self.elapsed.is_finite()
            || !self.duration.is_finite()
            || self.elapsed < 0.0
            || self.duration < 0.0
            || self.duration > 86400.0
            || self.elapsed > 86400.0
            || (self.duration > 0.0 && self.elapsed > self.duration + 10.0)
        {
            return Err("Invalid playback presence".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Update {
    options: Options,
    activity: Value,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    connected: bool,
    active: bool,
    acknowledged: u64,
    last_error: Option<String>,
    last_type: Option<u64>,
}

pub struct Presence {
    update: watch::Sender<Update>,
    diagnostics: Arc<Mutex<Diagnostics>>,
    track: Mutex<(Option<Track>, u64)>,
}
impl Presence {
    pub fn new(options: Options, run: bool) -> Arc<Self> {
        let (update, receiver) = watch::channel(Update {
            options,
            activity: Value::Null,
        });
        let service = Arc::new(Self {
            update,
            diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
            track: Mutex::new((None, 0)),
        });
        if run {
            tauri::async_runtime::spawn(worker(receiver, service.diagnostics.clone()));
        }
        service
    }
    pub fn set(&self, track: Option<Track>) -> Result<(), String> {
        if let Some(track) = &track {
            track.validate()?;
        }
        let mut current = self.track.lock().unwrap();
        *current = (
            track,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        );
        let options = self.update.borrow().options.clone();
        self.publish(current.0.as_ref(), options, current.1);
        Ok(())
    }
    pub fn configure(&self, options: Options) {
        let current = self.track.lock().unwrap();
        self.publish(current.0.as_ref(), options, current.1);
    }
    fn publish(&self, track: Option<&Track>, options: Options, observed_at: u64) {
        let activity = activity(track, &options, observed_at);
        self.update.send_replace(Update { options, activity });
    }
    pub fn diagnostics(&self) -> Value {
        let mut value = serde_json::to_value(&*self.diagnostics.lock().unwrap()).unwrap();
        value["enabled"] = json!(self.update.borrow().options.enabled);
        value
    }
}

fn activity(track: Option<&Track>, options: &Options, now: u64) -> Value {
    let Some(track) = track.filter(|t| {
        options.enabled && t.playing && !t.title.trim().is_empty() && !t.author.trim().is_empty()
    }) else {
        return Value::Null;
    };
    let text = |value: &str| {
        let s: String = value.chars().take(126).collect();
        if s.chars().count() < 2 { s + "⠀" } else { s }
    };
    let mut value = json!({"type": 2, "name": "SoundCloud", "details": text(&track.title), "state": text(&track.author), "status_display_type": 1, "instance": false});
    if track.duration > 0.0 {
        let start = now.saturating_sub((track.elapsed * 1000.0) as u64);
        value["timestamps"] =
            json!({"start":start, "end":start.saturating_add((track.duration * 1000.0) as u64)});
    }
    let mut assets = json!({});
    if url::Url::parse(&track.artwork).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.host_str()
                .is_some_and(|h| h == "sndcdn.com" || h.ends_with(".sndcdn.com"))
    }) {
        assets["large_image"] = json!(track.artwork.replace("50x50.", "500x500."));
        assets["large_text"] = json!(text(&track.title));
    }
    if options.show_icon {
        assets["small_image"] = json!("soundcloud-logo");
        assets["small_text"] = json!("SoundCloud");
    }
    value["assets"] = assets;
    if options.show_button {
        value["buttons"] = json!([{"label":"Listen on SoundCloud", "url":track.url}]);
    }
    value
}

async fn write_frame<W: AsyncWrite + Unpin>(
    pipe: &mut W,
    opcode: u32,
    body: &[u8],
) -> Result<(), String> {
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&opcode.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(body);
    tokio::time::timeout(Duration::from_secs(3), pipe.write_all(&frame))
        .await
        .map_err(|_| "Discord write timeout")?
        .map_err(|_| "Discord disconnected".to_string())
}
async fn read_frame<R: AsyncRead + Unpin>(pipe: &mut R) -> Result<(u32, Vec<u8>), String> {
    let mut header = [0u8; 8];
    pipe.read_exact(&mut header)
        .await
        .map_err(|_| "Discord disconnected")?;
    let opcode = u32::from_le_bytes(header[..4].try_into().unwrap());
    let size = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
    if size > 65536 {
        return Err("Discord frame exceeds limit".into());
    }
    let mut body = vec![0; size];
    pipe.read_exact(&mut body)
        .await
        .map_err(|_| "Incomplete Discord frame")?;
    Ok((opcode, body))
}

async fn reply<S: AsyncRead + AsyncWrite + Unpin>(
    pipe: &mut S,
    nonce: Option<&str>,
) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let (opcode, body) = read_frame(pipe).await?;
            if opcode == 3 {
                write_frame(pipe, 4, &body).await?;
                continue;
            }
            if opcode != 1 {
                return Err("Discord closed RPC connection".into());
            }
            let value: Value =
                serde_json::from_slice(&body).map_err(|_| "Invalid Discord response")?;
            if value["evt"] == "ERROR" {
                return Err(format!(
                    "Discord rejected activity ({})",
                    value["data"]["code"]
                ));
            }
            if nonce.map_or(value["evt"] == "READY", |nonce| value["nonce"] == nonce) {
                return Ok(value);
            }
        }
    })
    .await
    .map_err(|_| "Discord reply timeout")?
}

async fn connect() -> Result<NamedPipeClient, String> {
    for index in 0..10 {
        if let Ok(mut pipe) = ClientOptions::new().open(format!(r"\\?\pipe\discord-ipc-{index}")) {
            write_frame(
                &mut pipe,
                0,
                &serde_json::to_vec(&json!({"v":1,"client_id":CLIENT_ID})).unwrap(),
            )
            .await?;
            reply(&mut pipe, None).await?;
            return Ok(pipe);
        }
    }
    Err("Discord desktop is not available".into())
}

async fn worker(mut receiver: watch::Receiver<Update>, diagnostics: Arc<Mutex<Diagnostics>>) {
    let mut pipe = None;
    let mut last_send = Instant::now() - Duration::from_secs(10);
    let mut retry_at = Instant::now();
    let mut nonce = 0u64;
    loop {
        let update = receiver.borrow_and_update().clone();
        if pipe.is_none() && (!update.options.enabled || update.activity.is_null()) {
            if receiver.changed().await.is_err() {
                return;
            }
            continue;
        }
        let deadline = if pipe.is_none() {
            retry_at
        } else {
            last_send + Duration::from_secs(2)
        };
        if Instant::now() < deadline {
            tokio::select! { _ = tokio::time::sleep_until(deadline) => {}, changed = receiver.changed() => { if changed.is_err() { return; } } }
            continue;
        }
        let result = async {
            if pipe.is_none() { pipe = Some(connect().await?); diagnostics.lock().unwrap().connected = true; }
            nonce += 1;
            let nonce = nonce.to_string();
            let activity = receiver.borrow_and_update().activity.clone();
            let command = json!({"cmd":"SET_ACTIVITY", "nonce":nonce, "args":{"pid":std::process::id(), "activity":activity}});
            let connection = pipe.as_mut().unwrap();
            write_frame(connection, 1, &serde_json::to_vec(&command).unwrap()).await?;
            let acknowledged = reply(connection, Some(&nonce)).await?;
            let mut state = diagnostics.lock().unwrap();
            state.active = !activity.is_null(); state.acknowledged += 1; state.last_type = acknowledged["data"]["type"].as_u64(); state.last_error = None;
            Ok::<(), String>(())
        }.await;
        last_send = Instant::now();
        if let Err(error) = result {
            pipe = None;
            retry_at = Instant::now() + Duration::from_secs(15);
            let mut state = diagnostics.lock().unwrap();
            state.connected = false;
            state.active = false;
            state.last_error = Some(error);
        }
        if pipe.is_some() {
            if !receiver.borrow().options.enabled {
                pipe = None;
                diagnostics.lock().unwrap().connected = false;
            }
            if receiver.borrow().activity.is_null() {
                if receiver.changed().await.is_err() {
                    return;
                }
            } else {
                tokio::select! { _ = tokio::time::sleep(Duration::from_secs(30)) => {}, changed = receiver.changed() => { if changed.is_err() { return; } } }
            }
        } else {
            tokio::select! { _ = tokio::time::sleep_until(retry_at) => {}, changed = receiver.changed() => { if changed.is_err() { return; } } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track() -> Track {
        Track {
            title: "Song".into(),
            author: "Artist".into(),
            url: "https://soundcloud.com/artist/song".into(),
            artwork: "https://i1.sndcdn.com/art-t50x50.jpg".into(),
            playing: true,
            elapsed: 10.0,
            duration: 100.0,
        }
    }
    #[test]
    fn listening_pause_bounds_and_timestamps() {
        let mut track = track();
        let options = Options::default();
        let playing = activity(Some(&track), &options, 100000);
        assert_eq!(playing["type"], 2);
        assert_eq!(playing["timestamps"]["start"], 90000);
        assert_eq!(playing["timestamps"]["end"], 190000);
        track.playing = false;
        assert!(activity(Some(&track), &options, 100000).is_null());
        track.duration = f64::INFINITY;
        assert!(track.validate().is_err());
        track = self::track();
        track.url = "https://evil.test/a/b".into();
        assert!(track.validate().is_err());
    }
    #[tokio::test]
    async fn fragmented_frames_ping_and_nonce_matching() {
        let (mut client, mut server) = tokio::io::duplex(128);
        let peer = tokio::spawn(async move {
            write_frame(&mut server, 3, b"ping").await.unwrap();
            let (opcode, pong) = read_frame(&mut server).await.unwrap();
            assert_eq!(opcode, 4);
            assert_eq!(pong, b"ping");
            write_frame(&mut server, 1, br#"{"nonce":"other","data":{}}"#)
                .await
                .unwrap();
            write_frame(&mut server, 1, br#"{"nonce":"wanted","data":{"type":2}}"#)
                .await
                .unwrap();
        });
        assert_eq!(
            reply(&mut client, Some("wanted")).await.unwrap()["data"]["type"],
            2
        );
        peer.await.unwrap();
    }
    #[test]
    fn changing_options_preserves_playback_timestamps() {
        let service = Presence::new(Options::default(), false);
        *service.track.lock().unwrap() = (Some(track()), 500000);
        service.configure(Options {
            show_button: false,
            ..Options::default()
        });
        assert_eq!(
            service.update.borrow().activity["timestamps"]["start"],
            490000
        );
        assert!(service.update.borrow().activity["buttons"].is_null());
        service.configure(Options {
            enabled: false,
            ..Options::default()
        });
        assert!(service.update.borrow().activity.is_null());
    }
}
