use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use url::Url;

const PAGE: &str = "https://rvelabs.github.io/soundcloud-rpc/join/";
const CONFIG: &str = "https://rvelabs.github.io/soundcloud-rpc/listen-together.json";
fn part(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}

#[derive(Clone, PartialEq, Eq)]
pub struct Invite {
    room: String,
    invite: String,
}
impl Invite {
    pub fn parse(value: &str) -> Result<Self, String> {
        if value.len() > 512 {
            return Err("invalid-invite".into());
        }
        let url = Url::parse(value).map_err(|_| "invalid-invite")?;
        let query = if url.scheme() == "scwave"
            && url.host_str() == Some("join")
            && url.path().is_empty()
            && url.fragment().is_none()
        {
            url.query().ok_or("invalid-invite")?
        } else if url.as_str().starts_with(PAGE)
            && url.origin().ascii_serialization() == "https://rvelabs.github.io"
            && url.path() == "/soundcloud-rpc/join/"
            && url.query().is_none()
        {
            url.fragment().ok_or("invalid-invite")?
        } else {
            return Err("invalid-invite".into());
        };
        if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
            return Err("invalid-invite".into());
        }
        let pairs: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
        if pairs.len() != 2 {
            return Err("invalid-invite".into());
        }
        let room = pairs
            .iter()
            .find(|(key, _)| key == "room")
            .map(|(_, value)| value.to_string())
            .ok_or("invalid-invite")?;
        let invite = pairs
            .iter()
            .find(|(key, _)| key == "invite")
            .map(|(_, value)| value.to_string())
            .ok_or("invalid-invite")?;
        if !part(&room, 24) || !part(&invite, 43) {
            return Err("invalid-invite".into());
        }
        Ok(Self { room, invite })
    }
    pub fn link(&self) -> String {
        format!("{PAGE}#room={}&invite={}", self.room, self.invite)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Playback {
    pub track_url: String,
    pub title: String,
    pub author: String,
    pub position_ms: f64,
    pub duration_ms: f64,
    pub playing: bool,
}
impl Playback {
    fn valid(&self) -> bool {
        crate::catalog::track_url(&self.track_url)
            && self.title.chars().count() <= 200
            && self.author.chars().count() <= 200
            && self.position_ms.is_finite()
            && self.position_ms >= 0.0
            && self.duration_ms.is_finite()
            && self.duration_ms > 0.0
            && self.duration_ms <= 86_400_000.0
            && self.position_ms <= self.duration_ms + 10_000.0
    }
    fn advanced(&self, elapsed: Duration) -> Self {
        let mut next = self.clone();
        if next.playing {
            next.position_ms =
                (next.position_ms + elapsed.as_secs_f64() * 1000.0).min(next.duration_ms);
        }
        next
    }
}
#[derive(Clone)]
struct Observed {
    playback: Playback,
    at: Instant,
}
#[derive(Clone)]
struct Ticket {
    invite: Invite,
    key: String,
    endpoint: String,
    hosting: bool,
}
struct State {
    mode: &'static str,
    phase: &'static str,
    participants: u64,
    error: Option<&'static str>,
    remote: Option<Observed>,
    revision: u64,
    expires: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            mode: "idle",
            phase: "idle",
            participants: 0,
            error: None,
            remote: None,
            revision: 0,
            expires: 0,
        }
    }
}
type Changed = Arc<dyn Fn() + Send + Sync>;
pub struct Together {
    state: Mutex<State>,
    ticket: Mutex<Option<Ticket>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    epoch: AtomicU64,
    playback: watch::Sender<Option<Observed>>,
    client: reqwest::Client,
    endpoint: Mutex<Option<String>>,
    test: bool,
    callback: Mutex<Option<Changed>>,
    presence: Arc<crate::presence::Presence>,
    last_invite: Mutex<Option<(Invite, Instant)>>,
}
fn endpoint(value: &str, test: bool) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "service-not-configured")?;
    let local = test && url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    if !(local
        || url.scheme() == "https"
            && url.port().is_none()
            && url
                .host_str()
                .is_some_and(|h| h != "localhost" && h.contains('.')))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("service-not-configured".into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
impl Together {
    pub fn new(
        presence: Arc<crate::presence::Presence>,
        test_endpoint: Option<String>,
    ) -> Result<Arc<Self>, String> {
        let (playback, _) = watch::channel(None);
        let test = test_endpoint.is_some();
        let configured = if let Some(value) = test_endpoint {
            Some(endpoint(&value, true)?)
        } else {
            serde_json::from_str::<Value>(include_str!("../../docs/listen-together.json"))
                .ok()
                .and_then(|value| {
                    value["endpoint"]
                        .as_str()
                        .and_then(|text| endpoint(text, false).ok())
                })
        };
        Ok(Arc::new(Self {
            state: Mutex::new(State::default()),
            ticket: Mutex::new(None),
            task: Mutex::new(None),
            epoch: AtomicU64::new(0),
            playback,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(7))
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "service-unavailable")?,
            endpoint: Mutex::new(configured),
            test,
            callback: Mutex::new(None),
            presence,
            last_invite: Mutex::new(None),
        }))
    }
    pub fn callback(&self, callback: Changed) {
        *self.callback.lock().unwrap() = Some(callback);
    }
    fn changed(&self) {
        let callback = self.callback.lock().unwrap().clone();
        if let Some(callback) = callback {
            callback();
        }
    }
    pub fn active(&self) -> bool {
        self.state.lock().unwrap().mode != "idle"
    }
    pub fn status(&self) -> Value {
        let state = self.state.lock().unwrap();
        let stale = state.mode == "following"
            && state
                .remote
                .as_ref()
                .is_some_and(|value| value.at.elapsed() > Duration::from_secs(45));
        let remote = state.remote.as_ref().map(|value| {
            let age = if stale {
                value.at.elapsed().min(Duration::from_secs(45))
            } else {
                value.at.elapsed()
            };
            let mut next = value.playback.advanced(age);
            if stale {
                next.playing = false;
            }
            next
        });
        let invite = self
            .ticket
            .lock()
            .unwrap()
            .as_ref()
            .filter(|t| t.hosting && state.mode == "hosting")
            .map(|t| t.invite.link());
        json!({"mode":state.mode,"phase":if stale{"waiting"}else{state.phase},"participants":state.participants,"error":state.error,
            "remote":remote,"revision":state.revision,"expiresAt":state.expires,"inviteUrl":invite})
    }
    pub fn observe(&self, playback: Playback) -> Result<(), String> {
        if !playback.valid() {
            return Err("invalid-playback".into());
        }
        self.playback.send_replace(Some(Observed {
            playback,
            at: Instant::now(),
        }));
        Ok(())
    }
    async fn resolve_endpoint(&self) -> Result<String, String> {
        if let Some(value) = self.endpoint.lock().unwrap().clone() {
            return Ok(value);
        }
        let response = self
            .client
            .get(CONFIG)
            .send()
            .await
            .map_err(|_| "service-not-configured")?;
        if !response.status().is_success() {
            return Err("service-not-configured".into());
        }
        let value = crate::http::json(response, 4096)
            .await
            .map_err(|_| "service-not-configured")?;
        if value["version"] != 1 {
            return Err("service-not-configured".into());
        }
        let value = endpoint(value["endpoint"].as_str().unwrap_or(""), self.test)?;
        *self.endpoint.lock().unwrap() = Some(value.clone());
        Ok(value)
    }
    fn cancel(&self) -> (u64, Option<Ticket>) {
        let generation = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        let ticket = self.ticket.lock().unwrap().take();
        *self.state.lock().unwrap() = State::default();
        self.presence.set_invite(None);
        self.changed();
        (generation, ticket)
    }
    async fn close_ticket(&self, ticket: Option<Ticket>) {
        if let Some(ticket) = ticket.filter(|t| t.hosting) {
            let _ = self
                .client
                .post(format!(
                    "{}/v1/rooms/{}/end",
                    ticket.endpoint, ticket.invite.room
                ))
                .bearer_auth(&ticket.key)
                .timeout(Duration::from_millis(1500))
                .send()
                .await;
        }
    }
    pub async fn leave(&self) {
        let (_, ticket) = self.cancel();
        self.close_ticket(ticket).await;
    }
    pub fn shutdown(&self) {
        self.cancel();
        *self.callback.lock().unwrap() = None;
    }
    pub fn open(self: &Arc<Self>, value: &str) -> Result<(), String> {
        let invite = Invite::parse(value)?;
        {
            let mut last = self.last_invite.lock().unwrap();
            if last.as_ref().is_some_and(|(previous, at)| {
                previous == &invite && at.elapsed() < Duration::from_secs(2)
            }) {
                return Ok(());
            }
            *last = Some((invite.clone(), Instant::now()));
        }
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = service.start(Some(invite)).await;
        });
        Ok(())
    }
    pub async fn start(self: &Arc<Self>, invite: Option<Invite>) -> Result<Value, String> {
        let (generation, old) = self.cancel();
        self.close_ticket(old).await;
        if self.epoch.load(Ordering::Acquire) != generation {
            return Err("cancelled".into());
        }
        {
            let mut state = self.state.lock().unwrap();
            state.mode = if invite.is_some() {
                "following"
            } else {
                "hosting"
            };
            state.phase = "connecting";
        }
        self.changed();
        let result = async {
            let endpoint = self.resolve_endpoint().await?;
            let (ticket, expires) = if let Some(invite) = invite {
                let key = invite.invite.clone();
                (
                    Ticket {
                        invite,
                        key,
                        endpoint,
                        hosting: false,
                    },
                    0,
                )
            } else {
                let response = self
                    .client
                    .post(format!("{endpoint}/v1/rooms"))
                    .json(&json!({"version":1}))
                    .send()
                    .await
                    .map_err(|_| "service-unavailable")?;
                if !response.status().is_success() {
                    return Err(if response.status() == 429 {
                        "rate-limit"
                    } else {
                        "service-unavailable"
                    }
                    .into());
                }
                let value = crate::http::json(response, 4096)
                    .await
                    .map_err(|_| "service-unavailable")?;
                let room = value["room"].as_str().unwrap_or("").to_string();
                let invite = value["invite"].as_str().unwrap_or("").to_string();
                let key = value["hostKey"].as_str().unwrap_or("").to_string();
                if !part(&room, 24) || !part(&invite, 43) || !part(&key, 43) {
                    return Err("service-unavailable".into());
                }
                (
                    Ticket {
                        invite: Invite { room, invite },
                        key,
                        endpoint,
                        hosting: true,
                    },
                    value["expiresAt"].as_u64().unwrap_or(0),
                )
            };
            if self.epoch.load(Ordering::Acquire) != generation {
                self.close_ticket(Some(ticket)).await;
                return Err("cancelled".into());
            }
            *self.ticket.lock().unwrap() = Some(ticket.clone());
            self.state.lock().unwrap().expires = expires;
            let service = self.clone();
            let task = tauri::async_runtime::spawn(async move {
                service.run(ticket, generation).await;
            });
            *self.task.lock().unwrap() = Some(task);
            Ok(self.status())
        }
        .await;
        if let Err(error) = &result
            && self.epoch.load(Ordering::Acquire) == generation
        {
            let mut state = self.state.lock().unwrap();
            state.mode = "idle";
            state.phase = "error";
            state.error = Some(if error == "service-not-configured" {
                "service-not-configured"
            } else if error == "rate-limit" {
                "rate-limit"
            } else {
                "service-unavailable"
            });
            drop(state);
            self.changed();
        }
        result
    }
    async fn run(self: Arc<Self>, ticket: Ticket, generation: u64) {
        let deadline = Instant::now() + Duration::from_secs(6 * 3600);
        let mut disconnected = Instant::now();
        let mut sequence = 0_u64;
        let mut terminal = None;
        let mut playback = self.playback.subscribe();
        while self.epoch.load(Ordering::Acquire) == generation && Instant::now() < deadline {
            let connected: Result<(), &'static str> = async {
                let mut url=Url::parse(&format!("{}/v1/rooms/{}/socket",ticket.endpoint,ticket.invite.room)).map_err(|_|"connection")?;
                let _=url.set_scheme(if url.scheme()=="http"{"ws"}else{"wss"});
                let mut request=url.as_str().into_client_request().map_err(|_|"connection")?;
                request.headers_mut().insert("Authorization",format!("Bearer {}",ticket.key).parse().map_err(|_|"connection")?);
                let mut config=WebSocketConfig::default();config.max_message_size=Some(8192);config.max_frame_size=Some(8192);
                let connection=tokio::time::timeout(Duration::from_secs(8),connect_async_with_config(request,Some(config),false)).await.map_err(|_|"connection")?;
                let (mut socket,_)=connection.map_err(|error|match error {
                    tokio_tungstenite::tungstenite::Error::Http(response) if response.status()==403=>"invalid-invite",
                    tokio_tungstenite::tungstenite::Error::Http(response) if response.status()==410=>"expired",
                    tokio_tungstenite::tungstenite::Error::Http(response) if response.status()==409=>"room-full",
                    _=>"connection",
                })?;
                let mut heartbeat=tokio::time::interval(Duration::from_secs(15)); heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let mut last_send=Instant::now()-Duration::from_secs(1);
                loop {
                    tokio::select! {
                        _=heartbeat.tick()=>{
                            let observed=self.playback.borrow().clone();
                            if ticket.hosting { if let Some(observed)=observed {
                                sequence+=1; let mut value=serde_json::to_value(observed.playback.advanced(observed.at.elapsed())).map_err(|_|"connection")?;
                                value["type"]=json!("state");value["seq"]=json!(sequence); socket.send(Message::Text(value.to_string().into())).await.map_err(|_|"connection")?;
                                last_send=Instant::now();
                            } } else { socket.send(Message::Text("{\"type\":\"ping\"}".into())).await.map_err(|_|"connection")?; }
                        },
                        changed=playback.changed(),if ticket.hosting=>{
                            if changed.is_err(){return Err("ended");}
                            heartbeat.reset_after(Duration::from_millis(500).saturating_sub(last_send.elapsed()));
                        },
                        message=socket.next()=>{
                            let message=message.ok_or("connection")?.map_err(|_|"connection")?;
                            if let Message::Text(message)=message {
                                let value:Value=serde_json::from_str(&message).map_err(|_|"connection")?;
                                let kind=value["type"].as_str().unwrap_or("");
                                if kind=="ended" { return Err("ended"); }
                                let mut state=self.state.lock().unwrap();
                                if self.epoch.load(Ordering::Acquire)!=generation {return Err("ended");}
                                if kind=="welcome" { state.phase=if value["active"]==true || ticket.hosting{"connected"}else{"waiting"}; state.participants=value["participants"].as_u64().unwrap_or(1);state.expires=value["expiresAt"].as_u64().unwrap_or(0);disconnected=Instant::now(); }
                                if kind=="participants" {state.participants=value["count"].as_u64().unwrap_or(1);}
                                if kind=="host-away" { state.phase="waiting";if let Some(remote)=state.remote.as_mut(){remote.playback=remote.playback.advanced(remote.at.elapsed());remote.playback.playing=false;remote.at=Instant::now();} }
                                if !ticket.hosting && (kind=="state" || kind=="welcome") && value["active"]==true && !value["state"].is_null() {
                                    let frame=&value["state"];
                                    let parsed=Playback{track_url:frame["trackUrl"].as_str().unwrap_or("").into(),title:frame["title"].as_str().unwrap_or("").into(),author:frame["author"].as_str().unwrap_or("").into(),position_ms:frame["positionMs"].as_f64().unwrap_or(-1.0),duration_ms:frame["durationMs"].as_f64().unwrap_or(-1.0),playing:frame["playing"].as_bool().unwrap_or(false)};
                                    let revision=frame["revision"].as_u64().unwrap_or(0);
                                    if parsed.valid() && revision>state.revision {
                                        let age=value["serverNow"].as_u64().unwrap_or(0).saturating_sub(frame["observedAt"].as_u64().unwrap_or(0)).min(60_000);
                                        state.remote=Some(Observed{playback:parsed.advanced(Duration::from_millis(age)),at:Instant::now()});state.revision=revision;state.phase="connected";state.error=None;
                                    }
                                }
                                drop(state);
                                if ticket.hosting && kind=="welcome" { self.presence.set_invite(Some(ticket.invite.link())); }
                                if kind!="pong" { self.changed(); }
                            } else if let Message::Close(_)=message { return Err("connection"); }
                        }
                    }
                    if self.epoch.load(Ordering::Acquire)!=generation { return Err("ended"); }
                }
            }.await;
            if self.epoch.load(Ordering::Acquire) != generation {
                return;
            }
            if let Err(error) = connected
                && error != "connection"
            {
                if error != "ended" {
                    terminal = Some(error);
                }
                break;
            }
            if disconnected.elapsed() > Duration::from_secs(90) {
                terminal = Some("service-unavailable");
                break;
            }
            {
                let mut state = self.state.lock().unwrap();
                state.phase = "reconnecting";
                if let Some(remote) = state.remote.as_mut() {
                    remote.playback = remote.playback.advanced(remote.at.elapsed());
                    remote.playback.playing = false;
                    remote.at = Instant::now();
                }
            }
            self.changed();
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        if self.epoch.load(Ordering::Acquire) == generation {
            self.presence.set_invite(None);
            let mut state = self.state.lock().unwrap();
            state.mode = "idle";
            state.phase = if terminal.is_some() { "error" } else { "ended" };
            state.error = terminal;
            state.remote = None;
            drop(state);
            self.changed();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invitation_is_data_and_never_an_arbitrary_endpoint_or_launch_command() {
        let invite = Invite {
            room: "a".repeat(24),
            invite: "b".repeat(43),
        };
        assert!(Invite::parse(&invite.link()).is_ok());
        assert!(
            Invite::parse(&format!(
                "scwave://join?room={}&invite={}",
                invite.room, invite.invite
            ))
            .is_ok()
        );
        for url in [
            "scwave://join?room=x&invite=y",
            "https://evil.example/join/#room=x&invite=y",
            "scwave://join?room=x&invite=y&server=http://localhost",
        ] {
            assert!(Invite::parse(url).is_err());
        }
        assert!(endpoint("http://127.0.0.1:5000", false).is_err());
        assert!(endpoint("http://127.0.0.1:5000", true).is_ok());
        assert!(endpoint("https://example.com/?token=private", false).is_err());
    }
    #[tokio::test]
    #[ignore = "requires SC_TOGETHER_TEST_URL; creates and closes its own isolated room"]
    async fn two_native_clients_share_live_playback() {
        let endpoint = std::env::var("SC_TOGETHER_TEST_URL").expect("test service URL");
        let host = Together::new(
            crate::presence::Presence::new(Default::default(), false),
            Some(endpoint.clone()),
        )
        .unwrap();
        let guest = Together::new(
            crate::presence::Presence::new(Default::default(), false),
            Some(endpoint),
        )
        .unwrap();
        let first = Playback {
            track_url: "https://soundcloud.com/test/native-one".into(),
            title: "Native one".into(),
            author: "Fixture".into(),
            position_ms: 12000.0,
            duration_ms: 180000.0,
            playing: true,
        };
        host.observe(first.clone()).unwrap();
        let created = host.start(None).await.unwrap();
        guest
            .start(Some(
                Invite::parse(created["inviteUrl"].as_str().unwrap()).unwrap(),
            ))
            .await
            .unwrap();
        async fn until(service: &Together, predicate: impl Fn(&Value) -> bool) {
            let end = Instant::now() + Duration::from_secs(15);
            while !predicate(&service.status()) && Instant::now() < end {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert!(
                predicate(&service.status()),
                "live room state did not arrive"
            );
        }
        until(&guest, |s| s["remote"]["trackUrl"] == first.track_url).await;
        assert!(guest.status()["remote"]["positionMs"].as_f64().unwrap() >= 12000.0);
        assert!(
            !host
                .status()
                .to_string()
                .contains(&host.ticket.lock().unwrap().as_ref().unwrap().key)
        );
        host.observe(Playback {
            playing: false,
            position_ms: 19000.0,
            ..first.clone()
        })
        .unwrap();
        until(&guest, |s| s["remote"]["playing"] == false).await;
        let paused = guest.status()["remote"]["positionMs"].clone();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(guest.status()["remote"]["positionMs"], paused);
        host.observe(Playback {
            track_url: "https://soundcloud.com/test/native-two".into(),
            position_ms: 3000.0,
            ..first
        })
        .unwrap();
        until(&guest, |s| {
            s["remote"]["trackUrl"] == "https://soundcloud.com/test/native-two"
        })
        .await;
        host.leave().await;
        until(&guest, |s| s["phase"] == "ended").await;
        guest.leave().await;
    }
}
