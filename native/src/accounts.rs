use crate::storage::Store;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Serialize, Deserialize)]
struct Account {
    id: String,
    name: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Registry {
    selected: String,
    items: Vec<Account>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            selected: "default".into(),
            items: vec![Account {
                id: "default".into(),
                name: "Main".into(),
            }],
        }
    }
}
fn valid_id(id: &str) -> bool {
    id == "default" || uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id)
}
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 100 && !name.chars().any(char::is_control)
}
impl Registry {
    fn validate(&self) -> bool {
        !self.items.is_empty()
            && self.items.len() <= 12
            && self
                .items
                .iter()
                .all(|account| valid_id(&account.id) && valid_name(&account.name))
            && self
                .items
                .iter()
                .map(|account| &account.id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == self.items.len()
            && self.items.iter().any(|account| account.id == self.selected)
            && self.items.iter().any(|account| account.id == "default")
    }
}
pub struct Accounts {
    root: PathBuf,
    store: Arc<Store>,
    registry: Mutex<Registry>,
    current: String,
}
impl Accounts {
    pub fn new(root: &Path, store: Arc<Store>) -> Result<Self, String> {
        let value = store.get("settings-accounts");
        let registry: Registry = if value.is_null() {
            Registry::default()
        } else {
            serde_json::from_value(value)
                .map_err(|_| "Invalid account registry; existing profiles were preserved")?
        };
        if !registry.validate() {
            return Err("Invalid account registry; existing profiles were preserved".into());
        }
        Ok(Self {
            root: root.into(),
            store,
            current: registry.selected.clone(),
            registry: Mutex::new(registry),
        })
    }
    pub fn profile(&self) -> Result<PathBuf, String> {
        if self.current == "default" {
            return Ok(self.root.clone());
        }
        let root = self
            .root
            .canonicalize()
            .map_err(|_| "Profile folder unavailable")?;
        let folder = root.join("accounts").join(&self.current);
        std::fs::create_dir_all(&folder).map_err(|_| "Could not create account profile")?;
        let path = folder
            .canonicalize()
            .map_err(|_| "Account profile unavailable")?;
        if !path.starts_with(&root) {
            return Err("Account profile must stay inside the Native data folder".into());
        }
        Ok(path)
    }
    pub fn status(&self) -> Value {
        let registry = self.registry.lock().unwrap();
        json!({"current":self.current,"selected":registry.selected,"items":registry.items})
    }
    pub fn change(
        &self,
        action: &str,
        id: Option<&str>,
        name: Option<&str>,
    ) -> Result<Value, String> {
        let mut current = self.registry.lock().unwrap();
        let mut next = current.clone();
        match action {
            "create" => {
                let name = name.ok_or("Enter an account name")?.trim();
                if !valid_name(name) || next.items.len() >= 12 {
                    return Err(
                        "Use a name up to 100 bytes; at most twelve profiles are supported".into(),
                    );
                }
                next.items.push(Account {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: name.into(),
                });
            }
            "rename" => {
                let account = next
                    .items
                    .iter_mut()
                    .find(|item| Some(item.id.as_str()) == id)
                    .ok_or("Account not found")?;
                let name = name.ok_or("Enter an account name")?.trim();
                if !valid_name(name) {
                    return Err("Invalid account name".into());
                }
                account.name = name.into();
            }
            "select" => {
                let id = id
                    .filter(|id| next.items.iter().any(|item| item.id == *id))
                    .ok_or("Account not found")?;
                next.selected = id.into();
            }
            _ => return Err("Unknown account action".into()),
        }
        self.store.set(
            "settings-accounts".into(),
            serde_json::to_value(&next).map_err(|_| "Invalid accounts")?,
        )?;
        self.store.flush()?;
        *current = next;
        drop(current);
        Ok(self.status())
    }
    pub fn flush(&self) -> Result<(), String> {
        self.store.flush()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_selection_and_keeps_profiles_separate() {
        let root = std::env::temp_dir().join(format!("sc-accounts-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(&root).unwrap());
        let accounts = Accounts::new(&root, store.clone()).unwrap();
        assert_eq!(accounts.profile().unwrap(), root);
        let value = accounts.change("create", None, Some("Second")).unwrap();
        let id = value["items"][1]["id"].as_str().unwrap();
        accounts.change("select", Some(id), None).unwrap();
        assert_eq!(accounts.status()["current"], "default");
        let restarted = Accounts::new(&root, store.clone()).unwrap();
        assert!(restarted.profile().unwrap().ends_with(id));
        assert!(accounts.change("select", Some("../escape"), None).is_err());
        assert!(
            accounts
                .change("rename", Some("default"), Some("\n"))
                .is_err()
        );
        let path = restarted.profile().unwrap();
        drop(restarted);
        drop(accounts);
        drop(store);
        std::fs::remove_dir(path).unwrap();
        std::fs::remove_dir(root.join("accounts")).unwrap();
        std::fs::remove_file(root.join("native-state.json")).unwrap();
        std::fs::remove_file(root.join("native.lock")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
