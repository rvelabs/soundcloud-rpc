use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    time::{Instant, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use url::Url;

#[derive(Clone, Deserialize, Serialize)]
pub struct Config {
    pub endpoint: String,
    pub key: String,
    pub mode: String,
}

pub fn target(host: &str) -> bool {
    host.len() < 254
        && host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
        && [
            "soundcloud.com",
            "sndcdn.com",
            "spotify.com",
            "scdn.co",
            "spotifycdn.com",
            "spotifycdn.net",
        ]
        .iter()
        .any(|suffix| {
            host == *suffix
                || host
                    .strip_suffix(suffix)
                    .is_some_and(|prefix| prefix.ends_with('.'))
        })
}

pub fn endpoint(input: &str) -> Result<Url, String> {
    let mut url = Url::parse(input.trim()).map_err(|_| "Invalid Worker URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["/", "/tunnel", "/tunnel/"].contains(&url.path())
        || url.host_str().is_none_or(|host| {
            !host.contains('.')
                || host.ends_with(".local")
                || host.parse::<std::net::IpAddr>().is_ok()
        })
    {
        return Err("Use your HTTPS Cloudflare Worker URL without a key in the address".into());
    }
    url.set_scheme("wss").map_err(|_| "Invalid Worker URL")?;
    url.set_path("/tunnel");
    Ok(url)
}

pub struct Server {
    pub port: u16,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
pub async fn serve(config: Config) -> Result<Server, String> {
    let base = endpoint(&config.endpoint)?;
    if !(32..=256).contains(&config.key.len())
        || !config
            .key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("Invalid Worker key".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Could not start private relay")?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let limit = Arc::new(Semaphore::new(64));
    let key = Arc::new(config.key);
    let task = tauri::async_runtime::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let Ok(permit) = limit.clone().try_acquire_owned() else {
                continue;
            };
            let base = base.clone();
            let key = key.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let _ = tunnel(&mut stream, base, &key, port).await;
            });
        }
    });
    Ok(Server {
        port,
        task: Some(task),
    })
}

async fn tunnel(stream: &mut TcpStream, mut base: Url, key: &str, port: u16) -> Result<(), String> {
    let mut header = Vec::new();
    let mut buffer = [0u8; 65536];
    let header_end = loop {
        let count = timeout(Duration::from_secs(8), stream.read(&mut buffer))
            .await
            .map_err(|_| "CONNECT timeout")?
            .map_err(|_| "CONNECT failed")?;
        if count == 0 {
            return Ok(());
        }
        header.extend_from_slice(&buffer[..count]);
        if let Some(end) = header.windows(4).position(|v| v == b"\r\n\r\n") {
            break end + 4;
        }
        if header.len() > 16384 {
            return Err("CONNECT header too large".into());
        }
    };
    let first = std::str::from_utf8(&header[..header_end])
        .map_err(|_| "Invalid CONNECT")?
        .lines()
        .next()
        .unwrap_or("");
    let fields: Vec<_> = first.split_whitespace().collect();
    if fields == ["GET", "/proxy.pac", "HTTP/1.1"] {
        let pac = format!(
            "function FindProxyForURL(url,host){{return /(^|\\.)(soundcloud\\.com|sndcdn\\.com|spotify\\.com|scdn\\.co|spotifycdn\\.com|spotifycdn\\.net)$/.test(host)?'PROXY 127.0.0.1:{port}':'DIRECT';}}"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{pac}",
            pac.len()
        );
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|_| "PAC client closed")?;
        return Ok(());
    }
    if fields.len() != 3 || fields[0] != "CONNECT" || !["HTTP/1.1", "HTTP/1.0"].contains(&fields[2])
    {
        let _ = stream
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            .await;
        return Ok(());
    }
    let host = fields[1]
        .strip_suffix(":443")
        .unwrap_or("")
        .to_ascii_lowercase();
    if !target(&host) {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
        return Ok(());
    }
    base.query_pairs_mut().append_pair("host", &host);
    let mut request = base
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid relay request")?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {key}")
            .parse()
            .map_err(|_| "Invalid Worker key")?,
    );
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(65536))
        .max_frame_size(Some(65536));
    let ws = timeout(
        Duration::from_secs(12),
        connect_async_with_config(request, Some(ws_config), true),
    )
    .await;
    let Ok(Ok((mut ws, _))) = ws else {
        let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
        return Err("Worker handshake failed".into());
    };
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(|_| "Client closed")?;
    let mut awaiting = false;
    if header_end < header.len() {
        ws.send(Message::Binary(header[header_end..].to_vec().into()))
            .await
            .map_err(|_| "Worker closed")?;
        awaiting = true;
    }
    let mut deadline = Instant::now() + Duration::from_secs(if awaiting { 15 } else { 120 });
    loop {
        tokio::select! {
            message = ws.next() => {
                match message {
                    Some(Ok(Message::Text(text))) if text == "ack" && awaiting => { awaiting = false; deadline = Instant::now() + Duration::from_secs(120); },
                    Some(Ok(Message::Binary(bytes))) => {
                        timeout(Duration::from_secs(15), stream.write_all(&bytes)).await.map_err(|_| "Client write timeout")?.map_err(|_| "Client closed")?;
                        ws.send(Message::Text("ack".into())).await.map_err(|_| "Worker closed")?;
                        if !awaiting { deadline = Instant::now() + Duration::from_secs(120); }
                    },
                    Some(Ok(Message::Ping(bytes))) => { ws.send(Message::Pong(bytes)).await.map_err(|_| "Worker closed")?; },
                    Some(Ok(Message::Pong(_))) => {},
                    _ => break,
                }
            },
            read = stream.read(&mut buffer), if !awaiting => {
                let count = read.map_err(|_| "Client closed")?; if count == 0 { break; }
                ws.send(Message::Binary(buffer[..count].to_vec().into())).await.map_err(|_| "Worker closed")?;
                awaiting = true; deadline = Instant::now() + Duration::from_secs(15);
            },
            _ = tokio::time::sleep_until(deadline) => { break; },
        }
    }
    let _ = ws.close(None).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_never_becomes_an_open_proxy() {
        for host in [
            "soundcloud.com.evil.test",
            "evil-soundcloud.com",
            "127.0.0.1",
            "localhost",
            "soundcloud.com:80",
        ] {
            assert!(!target(host));
        }
        assert!(target("cf-hls-media.sndcdn.com"));
        assert!(target("api-v2.soundcloud.com"));
        assert!(endpoint("https://sc.example.workers.dev").is_ok());
        assert!(endpoint("http://sc.example.workers.dev").is_err());
        assert!(endpoint("https://127.0.0.1").is_err());
    }

    #[tokio::test]
    async fn real_socket_roundtrip_and_acknowledgements() {
        let worker = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let worker_port = worker.local_addr().unwrap().port();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        let remote = tokio::spawn(async move {
            let (socket, _) = worker.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let packet = ws.next().await.unwrap().unwrap();
            assert_eq!(packet.into_data().as_ref(), b"encrypted-client-bytes");
            ws.send(Message::Text("ack".into())).await.unwrap();
            ws.send(Message::Binary(b"encrypted-server-bytes".to_vec().into()))
                .await
                .unwrap();
            assert_eq!(
                ws.next().await.unwrap().unwrap().into_text().unwrap(),
                "ack"
            );
        });
        let local = tokio::spawn(async move {
            let (mut socket, _) = proxy.accept().await.unwrap();
            tunnel(
                &mut socket,
                Url::parse(&format!("ws://127.0.0.1:{worker_port}/tunnel")).unwrap(),
                "test-key",
                proxy_port,
            )
            .await
            .unwrap();
        });
        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        client.write_all(b"CONNECT api-v2.soundcloud.com:443 HTTP/1.1\r\nHost: api-v2.soundcloud.com:443\r\n\r\n").await.unwrap();
        let mut response = [0u8; 39];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"HTTP/1.1 200 Connection Established\r\n\r\n");
        client.write_all(b"encrypted-client-bytes").await.unwrap();
        let mut received = [0u8; 22];
        client.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"encrypted-server-bytes");
        timeout(Duration::from_secs(5), remote)
            .await
            .unwrap()
            .unwrap();
        drop(client);
        timeout(Duration::from_secs(5), local)
            .await
            .unwrap()
            .unwrap();
    }
}
