use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct Requests(Mutex<Pending>);

#[derive(Default)]
struct Pending {
    active: HashMap<String, oneshot::Sender<()>>,
    cancelled: HashMap<String, Instant>,
}

impl Requests {
    pub fn register(&self, id: &str) -> Result<oneshot::Receiver<()>, String> {
        if id.len() > 64
            || id.len() < 16
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("Invalid request ID".into());
        }
        let mut pending = self.0.lock().unwrap();
        pending
            .cancelled
            .retain(|_, at| at.elapsed() < Duration::from_secs(30));
        if pending.cancelled.remove(id).is_some() {
            return Err("Request cancelled".into());
        }
        if pending.active.len() >= 20 || pending.active.contains_key(id) {
            return Err("Source request is already running or capacity is full".into());
        }
        let (tx, rx) = oneshot::channel();
        pending.active.insert(id.into(), tx);
        Ok(rx)
    }
    pub fn cancel(&self, id: String) {
        let mut pending = self.0.lock().unwrap();
        if let Some(sender) = pending.active.remove(&id) {
            let _ = sender.send(());
        }
        if pending.cancelled.len() < 100 {
            pending.cancelled.insert(id, Instant::now());
        }
    }
    pub fn complete(&self, id: &str) {
        self.0.lock().unwrap().active.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancels_before_and_after_registration_without_leaking_capacity() {
        let requests = Requests::default();
        requests.cancel("request-0000000001".into());
        assert!(requests.register("request-0000000001").is_err());
        let waiting = requests.register("request-0000000002").unwrap();
        requests.cancel("request-0000000002".into());
        waiting.await.unwrap();
        requests.complete("request-0000000002");
        for index in 0..30 {
            let id = format!("request-{index:016}");
            let _waiting = requests.register(&id).unwrap();
            requests.complete(&id);
        }
    }
}
