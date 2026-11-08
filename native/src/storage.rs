use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
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
    frozen: BTreeSet<String>,
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
                frozen: BTreeSet::new(),
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
        if entries.frozen.contains(&key) {
            return Err("My Wave was reset; restart SoundCloud before saving new learning".into());
        }
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
        write_atomic(&self.path, &bytes)
    }
    pub fn reset_wave(&self, owner: u64) -> Result<(), String> {
        if owner == 0 || owner >= (1u64 << 53) {
            return Err("Sign in to SoundCloud before resetting My Wave".into());
        }
        let _guard = self.write.lock().unwrap();
        let mut entries = self.entries.lock().unwrap();
        let key = format!("wave-{owner}");
        if entries.frozen.contains(&key) {
            return Err("My Wave is already reset; restart SoundCloud".into());
        }
        let previous = entries.values.get(&key).cloned().unwrap_or(Value::Null);
        let mut value = previous.as_object().cloned().unwrap_or_default();
        for prefix in [
            "waveAudioAnalysisV1_",
            "waveFeedbackV1_",
            "waveCandidatesV2_",
            "waveHistory_",
            "waveDecisionTraceV1_",
        ] {
            value.remove(&format!("{prefix}{owner}"));
        }
        value.insert(format!("waveLegacyMergedV1_{owner}"), Value::Bool(true));
        value.insert(format!("waveLearningResetV1_{owner}"), Value::Bool(true));
        let value = Value::Object(value);
        let mut next = entries.clone();
        next.sizes.insert(
            key.clone(),
            serde_json::to_vec(&value).map_err(|e| e.to_string())?.len(),
        );
        next.values.insert(key.clone(), value);
        let bytes = serde_json::to_vec(&next.values).map_err(|e| e.to_string())?;
        if bytes.len() > PROFILE_LIMIT || next.values.len() > 20 {
            return Err("Profile quota exceeded; previous learning retained".into());
        }
        let backup = self.path.with_file_name(format!("wave-reset-{owner}.json"));
        write_atomic(
            &backup,
            &serde_json::to_vec(&previous).map_err(|e| e.to_string())?,
        )?;
        write_atomic(&self.path, &bytes)?;
        next.bytes = bytes.len();
        next.frozen.insert(key);
        *entries = next;
        Ok(())
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    replace(&temporary, path).map_err(|e| e.to_string())
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
    fn learning_reset_is_durable_scoped_and_rejects_stale_writes() {
        let dir = std::env::temp_dir().join(format!("sc-reset-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir).unwrap();
        let old = serde_json::json!({
            "controls":{"mood":"calm"},"waveExcludedArtistsV1_7":["blocked"],
            "waveFeedbackV1_7":[{"kind":"dislike","track":{"features":{"energy":0.8}}}],
            "waveAudioAnalysisV1_7":[["track",{}]],"waveCandidatesV2_7":{"tracks":[{}]},
            "waveHistory_7":[{}],"waveDecisionTraceV1_7":[{}]
        });
        store.set("wave-7".into(), old.clone()).unwrap();
        store.set("wave-8".into(), old.clone()).unwrap();
        store
            .set("import-7".into(), serde_json::json!({"tracks":[42]}))
            .unwrap();
        store
            .set("settings".into(), serde_json::json!({"language":"ru"}))
            .unwrap();
        assert!(store.reset_wave(0).is_err());
        store.reset_wave(7).unwrap();
        let cleared = store.get("wave-7");
        assert!(cleared["waveFeedbackV1_7"].is_null());
        assert!(cleared["waveAudioAnalysisV1_7"].is_null());
        assert!(cleared["waveCandidatesV2_7"].is_null());
        assert!(cleared["waveHistory_7"].is_null());
        assert!(cleared["waveDecisionTraceV1_7"].is_null());
        assert_eq!(cleared["waveLegacyMergedV1_7"], true);
        assert_eq!(cleared["waveLearningResetV1_7"], true);
        assert_eq!(cleared["controls"], old["controls"]);
        assert_eq!(
            cleared["waveExcludedArtistsV1_7"],
            old["waveExcludedArtistsV1_7"]
        );
        assert_eq!(store.get("wave-8"), old);
        assert_eq!(store.get("import-7")["tracks"][0], 42);
        assert!(store.set("wave-7".into(), old.clone()).is_err());
        let backup: Value =
            serde_json::from_slice(&fs::read(dir.join("wave-reset-7.json")).unwrap()).unwrap();
        assert_eq!(backup, old);
        store.flush().unwrap();
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.get("wave-7"), cleared);
        assert_eq!(reopened.get("settings")["language"], "ru");
        reopened.set("wave-7".into(), cleared).unwrap();
    }

    #[test]
    fn reset_backup_failure_preserves_learning_and_writer() {
        let dir = std::env::temp_dir().join(format!("sc-reset-io-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir).unwrap();
        let old = serde_json::json!({"waveFeedbackV1_7":[1]});
        store.set("wave-7".into(), old.clone()).unwrap();
        store.flush().unwrap();
        fs::create_dir(dir.join("wave-reset-7.json.tmp")).unwrap();
        assert!(store.reset_wave(7).is_err());
        assert_eq!(store.get("wave-7"), old);
        store.set("wave-7".into(), old.clone()).unwrap();
        let disk: Value =
            serde_json::from_slice(&fs::read(dir.join("native-state.json")).unwrap()).unwrap();
        assert_eq!(disk["wave-7"], old);
    }

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
