use crate::storage::Store;
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::{aead, pbkdf2};
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, num::NonZeroU32, path::Path};
use windows::{Win32::Security::Cryptography::*, core::PCWSTR};

const MARKER: &str = "settings-electron-migration";
const PENDING: &str = "settings-electron-import";
const PREFIXES: &[&str] = &[
    "waveAudioAnalysisV1_",
    "waveFeedbackV1_",
    "waveCandidatesV2_",
    "waveHistory_",
    "waveExcludedArtistsV1_",
    "waveLegacyMergedV1_",
];

fn read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file =
        std::fs::File::open(path).map_err(|_| "Previous SoundCloud data could not be read")?;
    if file
        .metadata()
        .map_err(|_| "Previous profile metadata unavailable")?
        .len()
        > limit
    {
        return Err("Previous SoundCloud data exceeds the migration limit".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Previous profile read failed")?;
    if bytes.len() as u64 > limit {
        return Err("Previous profile grew during migration".into());
    }
    Ok(bytes)
}
fn json(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|_| "Previous SoundCloud data is invalid".into())
}
fn gcm(key: &[u8], nonce: &[u8], mut ciphertext: Vec<u8>) -> Result<Vec<u8>, String> {
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key)
            .map_err(|_| "Invalid previous encryption key")?,
    );
    let nonce = aead::Nonce::try_assume_unique_for_key(nonce)
        .map_err(|_| "Invalid previous encryption nonce")?;
    let clear = key
        .open_in_place(nonce, aead::Aad::empty(), &mut ciphertext)
        .map_err(|_| "Previous SoundCloud data could not be authenticated")?;
    Ok(clear.to_vec())
}
fn config(bytes: &[u8]) -> Result<Value, String> {
    if bytes.first() == Some(&b'{') {
        return json(bytes);
    }
    if bytes.len() < 33 || bytes[16] != b':' {
        return Err("Unsupported previous settings format".into());
    }
    let mut key = [0; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA512,
        NonZeroU32::new(10000).unwrap(),
        String::from_utf8_lossy(&bytes[..16]).as_bytes(),
        b"soundcloud-rpc-config",
        &mut key,
    );
    let mut algorithm = BCRYPT_ALG_HANDLE::default();
    unsafe {
        BCryptOpenAlgorithmProvider(
            &mut algorithm,
            BCRYPT_AES_ALGORITHM,
            PCWSTR::null(),
            BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0),
        )
    }
    .ok()
    .map_err(|_| "Previous settings cipher unavailable")?;
    let mut handle = BCRYPT_KEY_HANDLE::default();
    let result = (|| {
        let mode: Vec<u8> = unsafe { BCRYPT_CHAIN_MODE_CBC.as_wide() }
            .iter()
            .chain(std::iter::once(&0))
            .flat_map(|v| v.to_le_bytes())
            .collect();
        unsafe { BCryptSetProperty(BCRYPT_HANDLE(algorithm.0), BCRYPT_CHAINING_MODE, &mode, 0) }
            .ok()
            .map_err(|_| "Previous settings cipher mode unavailable")?;
        unsafe { BCryptGenerateSymmetricKey(algorithm, &mut handle, None, &key, 0) }
            .ok()
            .map_err(|_| "Previous settings key unavailable")?;
        let mut iv = bytes[..16].to_vec();
        let mut clear = vec![0; bytes.len() - 17];
        let mut length = 0;
        unsafe {
            BCryptDecrypt(
                handle,
                Some(&bytes[17..]),
                None,
                Some(&mut iv),
                Some(&mut clear),
                &mut length,
                BCRYPT_BLOCK_PADDING,
            )
        }
        .ok()
        .map_err(|_| "Previous settings could not be decrypted")?;
        clear.truncate(length as usize);
        json(&clear)
    })();
    unsafe {
        if !handle.0.is_null() {
            let _ = BCryptDestroyKey(handle);
        }
        let _ = BCryptCloseAlgorithmProvider(algorithm, 0);
    }
    result
}
fn library(source: &Path) -> Result<Value, String> {
    let saved = json(&read(&source.join("library.key"), 16000)?)?;
    let encoded = saved["value"]
        .as_str()
        .ok_or("Previous library key is missing")?;
    let key = if saved["protected"] == true {
        let protected = STANDARD
            .decode(encoded)
            .map_err(|_| "Previous key encoding is invalid")?;
        let clear = if protected.starts_with(b"v10") {
            if protected.len() < 31 {
                return Err("Truncated previous library key".into());
            }
            let state = json(&read(&source.join("Local State"), 2_000_000)?)?;
            let master = STANDARD
                .decode(
                    state["os_crypt"]["encrypted_key"]
                        .as_str()
                        .ok_or("Previous Windows key missing")?,
                )
                .map_err(|_| "Previous Windows key encoding invalid")?;
            let master = crate::secrets::unprotect(
                master
                    .strip_prefix(b"DPAPI")
                    .ok_or("Unsupported previous Windows key")?,
            )?;
            gcm(&master, &protected[3..15], protected[15..].to_vec())?
        } else {
            crate::secrets::unprotect(&protected)?
        };
        STANDARD
            .decode(clear)
            .map_err(|_| "Previous decrypted key is invalid")?
    } else {
        STANDARD
            .decode(encoded)
            .map_err(|_| "Previous library key is invalid")?
    };
    let bytes = read(&source.join("library.data"), 24_000_000)?;
    if bytes.len() < 32 || &bytes[..4] != b"SC01" {
        return Err("Unsupported previous library format".into());
    }
    let mut sealed = bytes[32..].to_vec();
    sealed.extend_from_slice(&bytes[16..32]);
    json(&gcm(&key, &bytes[4..16], sealed)?)
}
pub fn stage(store: &Store, source: &Path) -> Result<Value, String> {
    if !store.get(MARKER).is_null() {
        return Ok(store.get(MARKER));
    }
    if !source.join("config.json").exists() && !source.join("library.data").exists() {
        return Ok(json!({"found":false}));
    }
    let settings = if source.join("config.json").exists() {
        config(&read(&source.join("config.json"), 4_000_000)?)?
    } else {
        json!({})
    };
    let data = if source.join("library.data").exists() {
        library(source)?
    } else {
        json!({})
    };
    let mut pending = Map::new();
    for (key, value) in settings
        .as_object()
        .into_iter()
        .chain(data.as_object())
        .flat_map(|v| v.iter())
    {
        if PREFIXES.iter().any(|prefix| key.starts_with(prefix)) || key.starts_with("waveControls_")
        {
            pending.insert(key.clone(), value.clone());
        }
    }
    let mut options = store.get("settings");
    if options.is_null() {
        options = json!({});
    }
    let options = options
        .as_object_mut()
        .ok_or("Existing settings must be an object")?;
    if !options.contains_key("language")
        && settings["waveInterfaceLanguage"]
            .as_str()
            .is_some_and(|v| ["ru", "en", "auto"].contains(&v))
    {
        options.insert("language".into(), settings["waveInterfaceLanguage"].clone());
    }
    if !options.contains_key("equalizer") && settings["equalizerSettingsV1"].is_object() {
        options.insert("equalizer".into(), settings["equalizerSettingsV1"].clone());
    }
    let fields = pending.len();
    if let Some(enabled) = settings["adBlocker"].as_bool() {
        let mut client = store
            .get("settings-client")
            .as_object()
            .cloned()
            .unwrap_or_default();
        if !client.contains_key("adBlocker") {
            client.insert("adBlocker".into(), json!(enabled));
            store.set("settings-client".into(), Value::Object(client))?;
        }
    }
    let report = json!({"found":true,"version":1,"fields":fields,"partition":settings["currentAccountId"].as_str().unwrap_or("default"),"boundOwner":null});
    store.set("settings".into(), Value::Object(options.clone()))?;
    store.set(PENDING.into(), Value::Object(pending))?;
    store.set(MARKER.into(), report.clone())?;
    store.flush()?;
    Ok(report)
}
pub fn import_wave(store: &Store, owner: &str, partition: &str) -> Result<(), String> {
    static IMPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _lock = IMPORT_LOCK
        .lock()
        .map_err(|_| "Migration lock unavailable")?;
    let mut report = store.get(MARKER);
    if report["found"] != true
        || report["boundOwner"].is_string()
        || report["partition"].as_str() != Some(partition)
    {
        return Ok(());
    }
    let pending = store.get(PENDING);
    let key = format!("wave-{owner}");
    let mut profile = store.get(&key).as_object().cloned().unwrap_or_default();
    for prefix in PREFIXES {
        let old = &pending[format!("{prefix}{partition}")];
        if old.is_null() {
            continue;
        }
        let target = format!("{prefix}{owner}");
        let existing = profile.get(&target);
        let merged = if prefix.contains("Feedback") {
            let mut events = BTreeMap::new();
            for event in old
                .as_array()
                .into_iter()
                .flatten()
                .chain(existing.and_then(Value::as_array).into_iter().flatten())
            {
                let identity =
                    json!([event["track"]["id"], event["kind"], event["at"]]).to_string();
                events.insert(identity, event.clone());
            }
            let mut events: Vec<_> = events.into_values().collect();
            events.sort_by(|a, b| {
                a["at"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&b["at"].as_f64().unwrap_or(0.0))
            });
            Value::Array(
                events
                    .into_iter()
                    .rev()
                    .take(5000)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect(),
            )
        } else if prefix.contains("AudioAnalysis") {
            let mut values = Map::new();
            for item in old
                .as_array()
                .into_iter()
                .flatten()
                .chain(existing.and_then(Value::as_array).into_iter().flatten())
            {
                if let Some(id) = item[0].as_str() {
                    let replace = values.get(id).is_none_or(|previous: &Value| {
                        item[1]["at"].as_f64().unwrap_or(0.0)
                            >= previous["at"].as_f64().unwrap_or(0.0)
                    });
                    if replace {
                        values.insert(id.into(), item[1].clone());
                    }
                }
            }
            let mut values: Vec<_> = values.into_iter().map(|(k, v)| json!([k, v])).collect();
            values.sort_by_key(|v| v[1]["at"].as_u64().unwrap_or(0));
            Value::Array(values.into_iter().rev().take(250).collect())
        } else if prefix.contains("ExcludedArtists") {
            let mut artists = Vec::new();
            for value in old
                .as_array()
                .into_iter()
                .flatten()
                .chain(existing.and_then(Value::as_array).into_iter().flatten())
            {
                if value.is_string() && !artists.contains(value) {
                    artists.push(value.clone());
                }
            }
            Value::Array(artists.into_iter().take(500).collect())
        } else {
            existing.cloned().unwrap_or_else(|| old.clone())
        };
        profile.insert(target, merged);
    }
    if !profile.contains_key("controls") && pending[format!("waveControls_{partition}")].is_object()
    {
        profile.insert(
            "controls".into(),
            pending[format!("waveControls_{partition}")].clone(),
        );
    }
    store.set(key, Value::Object(profile))?;
    store.flush()?;
    report["boundOwner"] = Value::String(owner.into());
    store.set(MARKER.into(), report)?;
    store.set(PENDING.into(), json!({}))?;
    store.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("soundcloud-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn seal(key: &[u8], nonce: [u8; 12], data: &[u8]) -> Vec<u8> {
        let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).unwrap());
        let mut bytes = data.to_vec();
        key.seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::empty(),
            &mut bytes,
        )
        .unwrap();
        bytes
    }
    fn write_library(source: &Path, protected: bool, value: Value) {
        let key = [7; 32];
        let encoded = STANDARD.encode(key);
        let saved = if protected {
            let master = [9; 32];
            let file = source.join("fixture-master.dat");
            crate::secrets::save(&file, &master).unwrap();
            let mut wrapped = b"DPAPI".to_vec();
            wrapped.extend(std::fs::read(&file).unwrap());
            std::fs::write(
                source.join("Local State"),
                json!({"os_crypt":{"encrypted_key":STANDARD.encode(wrapped)}}).to_string(),
            )
            .unwrap();
            let nonce = [1; 12];
            let mut encrypted = b"v10".to_vec();
            encrypted.extend_from_slice(&nonce);
            encrypted.extend(seal(&master, nonce, encoded.as_bytes()));
            STANDARD.encode(encrypted)
        } else {
            encoded
        };
        std::fs::write(
            source.join("library.key"),
            json!({"protected":protected,"value":saved}).to_string(),
        )
        .unwrap();
        let nonce = [2; 12];
        let sealed = seal(&key, nonce, value.to_string().as_bytes());
        let mut bytes = b"SC01".to_vec();
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&sealed[sealed.len() - 16..]);
        bytes.extend_from_slice(&sealed[..sealed.len() - 16]);
        std::fs::write(source.join("library.data"), bytes).unwrap();
    }
    #[test]
    fn decodes_the_exact_electron_conf_cbc_and_pbkdf2_format() {
        let encoded = "AwMDAwMDAwMDAwMDAwMDAzra1yDwjab1FggWRC2qRvDM9W4NTaF14JpXeI1cB0d3oIygIrg8oJvLvpQ8TXUTzotCI4DK+2Nx6EqAXNYopbmz9cOCXorxtQ56RR/FpeZ1pU/YaZ+KkAn94ZHYwFFu+ygYnAPAUK/XzpqtcMTae/CX";
        let decoded = config(&STANDARD.decode(encoded).unwrap()).unwrap();
        assert_eq!(decoded["waveControls_default"]["mood"], "calm");
        assert_eq!(decoded["waveInterfaceLanguage"], "ru");
    }
    #[test]
    fn reads_dpapi_chromium_v10_and_authenticated_library_without_modifying_the_source() {
        let source = directory();
        let expected = json!({"waveAudioAnalysisV1_default":[["track",{"at":2}]]});
        write_library(&source, true, expected.clone());
        let before = std::fs::read(source.join("library.data")).unwrap();
        assert_eq!(library(&source).unwrap(), expected);
        assert_eq!(std::fs::read(source.join("library.data")).unwrap(), before);
        let mut damaged = before;
        *damaged.last_mut().unwrap() ^= 1;
        std::fs::write(source.join("library.data"), damaged).unwrap();
        assert!(library(&source).is_err());
    }
    #[test]
    fn merges_old_and_new_feedback_and_measurements_once_in_the_matching_partition() {
        let source = directory();
        let destination = directory();
        let store = Store::open(&destination).unwrap();
        std::fs::write(source.join("config.json"),json!({"currentAccountId":"default","waveControls_default":{"mood":"calm"},"lastFmSecret":"never-copy"}).to_string()).unwrap();
        write_library(
            &source,
            false,
            json!({"waveFeedbackV1_default":[{"track":{"id":"old"},"kind":"like","at":1}],"waveAudioAnalysisV1_default":[["same",{"at":1,"features":{"bass":0.1}}],["old",{"at":1}]],"unrelatedCredential":"never-copy"}),
        );
        store.set("wave-7".into(),json!({"controls":{"mood":"happy"},"waveFeedbackV1_7":[{"track":{"id":"new"},"kind":"like","at":2}],"waveAudioAnalysisV1_7":[["same",{"at":2,"features":{"bass":0.8}}]]})).unwrap();
        assert_eq!(stage(&store, &source).unwrap()["fields"], 3);
        assert!(!store.get(PENDING).to_string().contains("never-copy"));
        import_wave(&store, "7", "other").unwrap();
        assert!(store.get(MARKER)["boundOwner"].is_null());
        import_wave(&store, "7", "default").unwrap();
        let merged = store.get("wave-7");
        assert_eq!(merged["waveFeedbackV1_7"].as_array().unwrap().len(), 2);
        assert_eq!(merged["controls"]["mood"], "happy");
        assert_eq!(
            merged["waveAudioAnalysisV1_7"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v[0] == "same")
                .unwrap()[1]["features"]["bass"],
            0.8
        );
        import_wave(&store, "8", "default").unwrap();
        assert!(store.get("wave-8").is_null());
        import_wave(&store, "7", "default").unwrap();
        assert_eq!(store.get("wave-7"), merged);
        store.flush().unwrap();
        drop(store);
        let reloaded = Store::open(&destination).unwrap();
        assert_eq!(reloaded.get("wave-7"), merged);
        assert!(source.join("library.data").exists());
    }
    #[test]
    fn authentication_failure_does_not_mark_migration_complete_or_overwrite_existing_data() {
        let source = directory();
        let destination = directory();
        let store = Store::open(&destination).unwrap();
        store.set("wave-7".into(), json!({"keep":true})).unwrap();
        write_library(&source, false, json!({"waveFeedbackV1_default":[]}));
        let mut data = std::fs::read(source.join("library.data")).unwrap();
        data[16] ^= 1;
        std::fs::write(source.join("library.data"), data).unwrap();
        assert!(stage(&store, &source).is_err());
        assert!(store.get(MARKER).is_null());
        assert_eq!(store.get("wave-7")["keep"], true);
    }
}
