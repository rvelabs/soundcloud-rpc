use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tokio::sync::Notify;

pub struct Store {
    path: PathBuf,
    entries: Mutex<Entries>,
    _lock: File,
    write: Mutex<()>,
    pub changed: Notify,
}

const PROFILE_LIMIT: usize = 20_000_000;
const ENTRY_LIMIT: usize = 8_000_000;

#[derive(Clone)]
struct Entries {
    values: BTreeMap<String, Value>,
    sizes: BTreeMap<String, usize>,
    bytes: usize,
}

impl Store {
    pub fn fork(&self, directory: &Path) -> Result<Self, String> {
        let fork = Self::open(directory)?;
        *fork.entries.lock().unwrap() = self.entries.lock().unwrap().clone();
        Ok(fork)
    }
    pub fn open(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        use std::os::windows::fs::OpenOptionsExt;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .share_mode(0)
            .open(directory.join("native.lock"))
            .map_err(|_| "This Native profile is already in use or cannot be locked".to_string())?;
        let path = directory.join("native-state.json");
        let entries: BTreeMap<String, Value> = match fs::read(&path) {
            Ok(bytes) if bytes.len() <= PROFILE_LIMIT => serde_json::from_slice(&bytes)
                .map_err(|_| "Native profile is damaged; it was not overwritten".to_string())?,
            Ok(_) => return Err("Native profile exceeds size limit".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error.to_string()),
        };
        let bytes = serde_json::to_vec(&entries)
            .map_err(|e| e.to_string())?
            .len();
        let sizes = entries
            .iter()
            .map(|(key, value)| {
                Ok((
                    key.clone(),
                    serde_json::to_vec(value).map_err(|e| e.to_string())?.len(),
                ))
            })
            .collect::<Result<_, String>>()?;
        Ok(Self {
            path,
            entries: Mutex::new(Entries {
                values: entries,
                sizes,
                bytes,
            }),
            _lock: lock,
            write: Mutex::new(()),
            changed: Notify::new(),
        })
    }
    pub fn get(&self, key: &str) -> Value {
        self.entries
            .lock()
            .unwrap()
            .values
            .get(key)
            .cloned()
            .unwrap_or(Value::Null)
    }
    pub fn set(&self, key: String, value: Value) -> Result<(), String> {
        if key.len() > 100
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            || !["wave-", "import-", "eq-", "settings"]
                .iter()
                .any(|prefix| key.starts_with(prefix))
        {
            return Err("Invalid profile key".into());
        }
        let size = serde_json::to_vec(&value).map_err(|e| e.to_string())?.len();
        if size > ENTRY_LIMIT {
            return Err("Profile entry too large".into());
        }
        let mut entries = self.entries.lock().unwrap();
        let old_size = entries.sizes.get(&key).copied();
        if entries.values.len() >= 20 && old_size.is_none() {
            return Err("Profile entry limit reached".into());
        }
        let bytes = entries.bytes - old_size.unwrap_or(0)
            + size
            + if old_size.is_none() {
                key.len() + 3 + usize::from(!entries.values.is_empty())
            } else {
                0
            };
        if bytes > PROFILE_LIMIT {
            return Err("Native profile quota exceeded; previous data was preserved".into());
        }
        entries.bytes = bytes;
        entries.sizes.insert(key.clone(), size);
        entries.values.insert(key, value);
        drop(entries);
        self.changed.notify_one();
        Ok(())
    }
    pub fn flush(&self) -> Result<(), String> {
        let _guard = self.write.lock().unwrap();
        let bytes =
            serde_json::to_vec(&self.entries.lock().unwrap().values).map_err(|e| e.to_string())?;
        if bytes.len() > PROFILE_LIMIT {
            return Err("Native profile quota exceeded".into());
        }
        let temporary = self.path.with_extension("json.tmp");
        let mut file = File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        replace(&temporary, &self.path).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
pub(crate) fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };
    let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_survives_replacement_and_refuses_path_keys() {
        let dir = std::env::temp_dir().join(format!("sc-native-store-{}", std::process::id()));
        let store = Store::open(&dir).unwrap();
        assert!(store.set("../token".into(), Value::Null).is_err());
        store
            .set("wave-123".into(), serde_json::json!({"history": [1]}))
            .unwrap();
        store.flush().unwrap();
        store
            .set("wave-123".into(), serde_json::json!({"history": [2]}))
            .unwrap();
        store.flush().unwrap();
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.get("wave-123")["history"][0], 2);
        drop(reopened);
        fs::remove_file(dir.join("native-state.json")).unwrap();
        fs::remove_file(dir.join("native.lock")).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn aggregate_quota_preserves_a_readable_profile() {
        let dir = std::env::temp_dir().join(format!("sc-native-quota-{}", std::process::id()));
        let store = Store::open(&dir).unwrap();
        for key in ["wave-1", "wave-2"] {
            store
                .set(key.into(), Value::String("x".repeat(7_000_000)))
                .unwrap();
        }
        assert!(
            store
                .set("wave-3".into(), Value::String("x".repeat(7_000_000)))
                .is_err()
        );
        store.set("wave-1".into(), json_value()).unwrap();
        store
            .set("wave-3".into(), Value::String("x".repeat(7_000_000)))
            .unwrap();
        store.flush().unwrap();
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.get("wave-1"), json_value());
        drop(reopened);
        fs::remove_file(dir.join("native-state.json")).unwrap();
        fs::remove_file(dir.join("native.lock")).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    fn json_value() -> Value {
        serde_json::json!({"history": [1, 2]})
    }

    #[test]
    fn profile_has_a_single_writer() {
        let dir = std::env::temp_dir().join(format!("sc-native-lock-{}", std::process::id()));
        let first = Store::open(&dir).unwrap();
        assert!(Store::open(&dir).is_err());
        drop(first);
        drop(Store::open(&dir).unwrap());
        fs::remove_file(dir.join("native.lock")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
