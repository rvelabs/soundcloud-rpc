use futures_util::StreamExt;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use url::Url;

pub fn allowed(url: &Url, method: &str) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    if ![
        "open.spotify.com",
        "music.yandex.ru",
        "api.music.yandex.ru",
        "music.youtube.com",
        "www.youtube.com",
    ]
    .contains(&host)
    {
        return false;
    }
    method == "GET"
        || method == "POST"
            && ((["music.youtube.com", "www.youtube.com"].contains(&host)
                && url.path() == "/youtubei/v1/browse")
                || host == "music.yandex.ru" && url.path().starts_with("/handlers/"))
}

pub struct Clients {
    direct: reqwest::Client,
    relay: reqwest::Client,
    country: tokio::sync::Mutex<Option<(Instant, Option<String>)>>,
}

pub fn client() -> Result<Clients, String> {
    let builder = || {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(5))
    };
    Ok(Clients {
        direct: builder().build().map_err(|e| e.to_string())?,
        relay: builder().no_proxy().build().map_err(|e| e.to_string())?,
        country: tokio::sync::Mutex::new(None),
    })
}

fn relay_first(mode: &str, yandex: bool, country: Option<&str>) -> bool {
    mode == "on" && !(yandex && country == Some("RU"))
}

impl Clients {
    async fn country(&self) -> Option<String> {
        let mut cached = self.country.lock().await;
        if let Some((at, country)) = cached.as_ref()
            && at.elapsed() < Duration::from_secs(if country.is_some() { 300 } else { 30 })
        {
            return country.clone();
        }
        let country = async {
            let response = self
                .relay
                .get("https://www.cloudflare.com/cdn-cgi/trace")
                .timeout(Duration::from_millis(700))
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.ok()?;
                if bytes.len() + chunk.len() > 8192 {
                    return None;
                }
                bytes.extend_from_slice(&chunk);
            }
            String::from_utf8_lossy(&bytes).lines().find_map(|line| {
                line.strip_prefix("loc=")
                    .filter(|value| {
                        value.len() == 2 && value.bytes().all(|c| c.is_ascii_uppercase())
                    })
                    .map(str::to_owned)
            })
        }
        .await;
        *cached = Some((Instant::now(), country.clone()));
        country
    }
}

pub async fn read(
    clients: &Clients,
    url: &str,
    method: &str,
    body: Option<String>,
    relay: Option<crate::relay::Config>,
) -> Result<Value, String> {
    let address = Url::parse(url).map_err(|_| "Invalid source URL")?;
    if !allowed(&address, method) || body.as_ref().is_some_and(|body| body.len() > 250_000) {
        return Err("Unsupported playlist source request".into());
    }
    let relay = relay.filter(|config| config.mode != "off");
    let yandex =
        [Some("music.yandex.ru"), Some("api.music.yandex.ru")].contains(&address.host_str());
    let country = if yandex && relay.is_some() {
        clients.country().await
    } else {
        None
    };
    let prefer_relay = relay
        .as_ref()
        .is_some_and(|config| relay_first(&config.mode, yandex, country.as_deref()));
    if prefer_relay
        && let Some(config) = &relay
        && let Ok(response) = read_relay(&clients.relay, config, url, method, body.clone()).await
        && let Ok(value) = collect(response).await
    {
        return Ok(value);
    }
    let mut request = clients
        .direct
        .request(
            if method == "POST" {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            address.clone(),
        )
        .header("Accept-Language", "ru-RU,ru;q=0.9,en;q=0.7")
        .header("User-Agent", "Mozilla/5.0");
    if relay.is_some() {
        request = request.timeout(Duration::from_secs(2));
    }
    if ["www.youtube.com", "music.youtube.com"].contains(&address.host_str().unwrap_or("")) {
        request = request.header("Cookie", "SOCS=CAI");
    }
    if address.host_str() == Some("music.yandex.ru") && address.path().starts_with("/handlers/") {
        request = request
            .header("Referer", "https://music.yandex.ru/")
            .header("X-Requested-With", "XMLHttpRequest");
    }
    if let Some(body) = &body {
        request = request
            .header("Content-Type", "application/json")
            .body(body.clone());
    }
    let direct = match request.send().await {
        Ok(response) => collect(response).await,
        Err(_) => Err(
            "Playlist source is unreachable. Try a CSV/TXT export or a configured relay.".into(),
        ),
    };
    if direct
        .as_ref()
        .is_ok_and(|value| value["status"].as_u64().is_some_and(|status| status < 400))
    {
        return direct;
    }
    if !prefer_relay
        && let Some(config) = &relay
        && let Ok(response) = read_relay(&clients.relay, config, url, method, body).await
    {
        return collect(response).await;
    }
    direct
}

async fn read_relay(
    client: &reqwest::Client,
    config: &crate::relay::Config,
    source: &str,
    method: &str,
    body: Option<String>,
) -> Result<reqwest::Response, String> {
    let mut endpoint = crate::relay::endpoint(&config.endpoint)?;
    endpoint
        .set_scheme("https")
        .map_err(|_| "Invalid Worker URL")?;
    endpoint.set_path("/playlist-source");
    endpoint.query_pairs_mut().append_pair("url", source);
    let mut request = client
        .request(
            if method == "POST" {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            endpoint,
        )
        .header("Authorization", format!("Bearer {}", config.key));
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Worker source request failed")?;
    if !response.status().is_success()
        || response
            .headers()
            .get("x-soundcloud-playlist-relay")
            .and_then(|value| value.to_str().ok())
            != Some("1")
    {
        return Err("Worker did not confirm public playlist support".into());
    }
    Ok(response)
}

async fn collect(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Playlist source connection interrupted")?;
        if bytes.len() + chunk.len() > 15_000_000 {
            return Err("Playlist source response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(json!({"status": status, "text": String::from_utf8_lossy(&bytes), "location": location}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn russian_yandex_bypasses_worker_without_disabling_other_routes() {
        assert!(!relay_first("on", true, Some("RU")));
        assert!(relay_first("on", true, Some("DE")));
        assert!(relay_first("on", true, None));
        assert!(relay_first("on", false, Some("RU")));
        assert!(!relay_first("off", false, Some("DE")));
    }
    #[test]
    fn source_routes_are_restricted() {
        for url in [
            "https://127.0.0.1/",
            "https://open.spotify.com.evil.test/",
            "http://music.yandex.ru/",
            "https://user:pass@open.spotify.com/playlist/a",
        ] {
            assert!(!allowed(&Url::parse(url).unwrap(), "GET"));
        }
        assert!(allowed(
            &Url::parse("https://music.youtube.com/youtubei/v1/browse").unwrap(),
            "POST"
        ));
        assert!(!allowed(
            &Url::parse("https://open.spotify.com/account/delete").unwrap(),
            "POST"
        ));
    }
}
