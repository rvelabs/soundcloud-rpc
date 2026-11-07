use crate::{relay::Config, secrets};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Plan {
    account: String,
    name: String,
    secret: String,
    subdomain: String,
}
struct Session {
    token: String,
    expires: Instant,
    accounts: Vec<Account>,
    plan: Option<Plan>,
}
pub struct Setup {
    session: Arc<Mutex<Session>>,
    client: reqwest::Client,
    journal: PathBuf,
    operation: tokio::sync::Mutex<()>,
}

fn account_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn subdomain(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn valid_secret(value: &str) -> bool {
    (32..=256).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn plan(account: &str) -> Plan {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    Plan {
        account: account.into(),
        name: format!("soundcloud-wave-{suffix}"),
        subdomain: format!("wave-{suffix}"),
        secret: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
    }
}

impl Setup {
    pub fn new(profile: &Path) -> Result<Self, String> {
        let journal = profile.join("native-worker-plan.dat");
        let saved = secrets::load(&journal)
            .ok()
            .flatten()
            .and_then(|bytes| serde_json::from_slice::<Plan>(&bytes).ok())
            .filter(|plan| {
                account_id(&plan.account)
                    && subdomain(&plan.name)
                    && subdomain(&plan.subdomain)
                    && valid_secret(&plan.secret)
            });
        Ok(Self {
            session: Arc::new(Mutex::new(Session {
                token: String::new(),
                expires: Instant::now(),
                accounts: Vec::new(),
                plan: saved,
            })),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Could not create Cloudflare setup client")?,
            journal,
            operation: tokio::sync::Mutex::new(()),
        })
    }
    fn token(&self) -> Result<String, String> {
        let mut session = self.session.lock().unwrap();
        if session.token.is_empty() || Instant::now() >= session.expires {
            session.token.clear();
            session.accounts.clear();
            return Err("Cloudflare setup expired; connect your account again".into());
        }
        Ok(session.token.clone())
    }
    async fn api(
        &self,
        path: &str,
        method: reqwest::Method,
        body: Option<Value>,
        form: Option<reqwest::multipart::Form>,
    ) -> Result<Value, String> {
        let token = self.token()?;
        let mut request = self
            .client
            .request(
                method,
                format!("https://api.cloudflare.com/client/v4{path}"),
            )
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(form) = form {
            request = request.multipart(form);
        }
        let response = request
            .send()
            .await
            .map_err(|_| "Cloudflare did not respond; check the connection")?;
        let status = response.status();
        if status.as_u16() == 404 && path.ends_with("/workers/subdomain") {
            return Ok(Value::Null);
        }
        if [401, 403].contains(&status.as_u16()) {
            return Err("Cloudflare requires Account Settings: Read and Workers Scripts: Edit for the selected account".into());
        }
        if status.as_u16() == 429 {
            return Err("Cloudflare rate limit; retry later".into());
        }
        if !status.is_success() {
            return Err(format!(
                "Cloudflare did not confirm the operation (HTTP {})",
                status.as_u16()
            ));
        }
        let value = crate::http::json(response, 2_000_000).await?;
        if value["success"] != true {
            return Err("Cloudflare did not confirm the operation".into());
        }
        Ok(value["result"].clone())
    }
    pub async fn authorize(&self, token: String) -> Result<Vec<Account>, String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "Cloudflare setup is already running")?;
        let token = token.trim().to_string();
        if !(20..=256).contains(&token.len())
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        {
            return Err("Enter a Cloudflare API token, not a password or Global API Key".into());
        }
        {
            let mut session = self.session.lock().unwrap();
            session.token = token;
            session.expires = Instant::now() + Duration::from_secs(600);
            session.accounts.clear();
        }
        let expiry = self.session.lock().unwrap().expires;
        let session = Arc::downgrade(&self.session);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(600)).await;
            if let Some(session) = session.upgrade() {
                let mut session = session.lock().unwrap();
                if session.expires == expiry {
                    session.token.clear();
                    session.accounts.clear();
                }
            }
        });
        let mut accounts = Vec::new();
        for page in 1..=10 {
            let raw = self
                .api(
                    &format!("/accounts?per_page=50&page={page}"),
                    reqwest::Method::GET,
                    None,
                    None,
                )
                .await?;
            let batch: Vec<Account> =
                serde_json::from_value(raw).map_err(|_| "Invalid Cloudflare account list")?;
            let count = batch.len();
            accounts.extend(
                batch
                    .into_iter()
                    .filter(|item| account_id(&item.id) && item.name.len() <= 500),
            );
            if count < 50 {
                break;
            }
        }
        if accounts.is_empty() {
            self.session.lock().unwrap().token.clear();
            return Err("The token does not grant access to a Cloudflare account".into());
        }
        self.session.lock().unwrap().accounts = accounts.clone();
        Ok(accounts)
    }
    pub async fn deploy(
        &self,
        account: &str,
        existing: Option<Config>,
        progress: impl Fn(&str),
    ) -> Result<Config, String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "Cloudflare setup is already running")?;
        self.token()?;
        if !self
            .session
            .lock()
            .unwrap()
            .accounts
            .iter()
            .any(|item| item.id == account)
        {
            return Err("Select an authorized Cloudflare account".into());
        }
        let mut plan = {
            let session = self.session.lock().unwrap();
            session
                .plan
                .clone()
                .filter(|plan| plan.account == account)
                .unwrap_or_else(|| plan(account))
        };
        let base = format!("/accounts/{account}/workers");
        progress("Reading the workers.dev address…");
        let info = self
            .api(
                &format!("{base}/subdomain"),
                reqwest::Method::GET,
                None,
                None,
            )
            .await?;
        let domain = match info["subdomain"]
            .as_str()
            .filter(|domain| subdomain(domain))
        {
            Some(domain) => domain.to_string(),
            None => {
                progress("Creating your first workers.dev address…");
                let info = self
                    .api(
                        &format!("{base}/subdomain"),
                        reqwest::Method::PUT,
                        Some(json!({"subdomain":plan.subdomain})),
                        None,
                    )
                    .await?;
                info["subdomain"]
                    .as_str()
                    .filter(|domain| subdomain(domain))
                    .ok_or("Cloudflare did not confirm the workers.dev address")?
                    .to_string()
            }
        };
        if let Some(config) = existing.filter(|config| {
            valid_secret(&config.key) && crate::relay::endpoint(&config.endpoint).is_ok()
        }) && let Ok(url) = url::Url::parse(&config.endpoint)
        {
            let suffix = format!(".{domain}.workers.dev");
            if let Some(name) = url
                .host_str()
                .and_then(|host| host.strip_suffix(&suffix))
                .filter(|name| {
                    name.starts_with("soundcloud-wave-") && name.len() <= 63 && subdomain(name)
                })
            {
                plan.name = name.into();
                plan.secret = config.key;
            }
        }
        secrets::save(
            &self.journal,
            &serde_json::to_vec(&plan).map_err(|_| "Invalid Cloudflare setup plan")?,
        )?;
        self.session.lock().unwrap().plan = Some(plan.clone());
        progress("Uploading the Worker and its connection key…");
        let metadata = json!({"main_module":"worker.mjs","compatibility_date":"2026-10-22","bindings":[{"type":"secret_text","name":"RELAY_TOKEN","text":plan.secret}]});
        let mut form = reqwest::multipart::Form::new().part(
            "metadata",
            reqwest::multipart::Part::text(metadata.to_string())
                .mime_str("application/json")
                .unwrap(),
        );
        for (name, code) in modules() {
            form = form.part(
                name,
                reqwest::multipart::Part::text(code.to_string())
                    .file_name(name.to_string())
                    .mime_str("application/javascript+module")
                    .unwrap(),
            );
        }
        self.api(
            &format!("{base}/scripts/{}", plan.name),
            reqwest::Method::PUT,
            None,
            Some(form),
        )
        .await?;
        progress("Enabling the HTTPS address…");
        let enabled = self
            .api(
                &format!("{base}/scripts/{}/subdomain", plan.name),
                reqwest::Method::POST,
                Some(json!({"enabled":true,"previews_enabled":false})),
                None,
            )
            .await?;
        if enabled["enabled"] != true {
            return Err(
                "Cloudflare has not enabled the address yet. Retry; the same Worker will be reused"
                    .into(),
            );
        }
        self.session.lock().unwrap().token.clear();
        Ok(Config {
            endpoint: format!("https://{}.{}.workers.dev", plan.name, domain),
            key: plan.secret,
            mode: "auto".into(),
        })
    }
    pub fn export_files(&self, profile: &Path) -> Result<PathBuf, String> {
        let directory = profile.join("worker");
        std::fs::create_dir_all(&directory).map_err(|_| "Could not create Worker files folder")?;
        for (name, code) in modules() {
            std::fs::write(directory.join(name), code)
                .map_err(|_| "Could not export Worker module")?;
        }
        std::fs::write(directory.join("wrangler.toml"),"name = \"soundcloud-relay\"\nmain = \"worker.mjs\"\ncompatibility_date = \"2026-10-22\"\n").map_err(|_|"Could not export Worker configuration")?;
        std::fs::write(directory.join("README.txt"),"Deploy with Cloudflare Workers or Wrangler. Set the RELAY_TOKEN secret separately; the app never exports your key into these files. Use F1 to create or update the Worker automatically.\n").map_err(|_|"Could not export Worker instructions")?;
        Ok(directory)
    }
}
fn modules() -> [(&'static str, &'static str); 3] {
    [
        (
            "worker.mjs",
            include_str!("../../cloudflare/soundcloud-relay/worker.mjs"),
        ),
        (
            "protocol.mjs",
            include_str!("../../cloudflare/soundcloud-relay/protocol.mjs"),
        ),
        (
            "playlist-source.mjs",
            include_str!("../../cloudflare/soundcloud-relay/playlist-source.mjs"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plans_are_scoped_and_exported_modules_do_not_contain_keys() {
        let first = plan(&"a".repeat(32));
        let next = plan(&"a".repeat(32));
        assert_ne!(first.secret, next.secret);
        assert!(subdomain(&first.name));
        assert!(subdomain(&first.subdomain));
        assert!(account_id(&first.account));
        assert!(!subdomain("bad.host"));
        for (_, source) in modules() {
            assert!(!source.contains(&first.secret));
        }
        assert!(modules()[0].1.contains("cloudflare:sockets"));
    }
}
