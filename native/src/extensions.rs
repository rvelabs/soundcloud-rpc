use crate::{sandbox::Plugin, storage::Store};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    id: String,
    name: String,
    author: String,
    version: String,
    description: String,
    kind: &'static str,
    enabled: bool,
    error: Option<String>,
}
struct File {
    info: Info,
    source: String,
    hash: String,
}
struct Active {
    plugin: Plugin,
    code: Option<String>,
    hash: String,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    enabled: BTreeSet<String>,
    theme: Option<String>,
}

pub struct Extensions {
    root: PathBuf,
    store: Arc<Store>,
    files: Mutex<BTreeMap<String, File>>,
    active: Mutex<BTreeMap<String, Active>>,
    config: Mutex<Config>,
    last_track: Mutex<Option<Value>>,
    operation: tokio::sync::Mutex<()>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    refresh_revision: AtomicU64,
    dark: AtomicBool,
}

fn identity(path: &Path) -> Option<String> {
    let id = path.file_stem()?.to_str()?;
    (!id.is_empty()
        && id.len() <= 120
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)))
    .then(|| id.to_string())
}
fn cleanup_key(id: &str) -> String {
    id.replace('-', "_")
}
fn tag(source: &str, name: &str) -> String {
    source
        .lines()
        .take(80)
        .find_map(|line| {
            let line = line
                .trim()
                .trim_start_matches('/')
                .trim_start_matches('*')
                .trim();
            line.strip_prefix(&format!("@{name} "))
                .map(|value| value.trim().chars().take(200).collect())
        })
        .unwrap_or_default()
}

impl Extensions {
    pub fn new(root: &Path, store: Arc<Store>) -> Result<Arc<Self>, String> {
        for folder in ["plugins", "themes"] {
            std::fs::create_dir_all(root.join(folder))
                .map_err(|_| "Could not create extensions folder")?;
        }
        let builtin = root.join("plugins/playback-speed.js");
        if !builtin.exists() {
            std::fs::write(&builtin, include_str!("../../plugins/playback-speed.js"))
                .map_err(|_| "Could not install the bundled playback-speed plugin")?;
        }
        let config = serde_json::from_value(store.get("settings-extensions")).unwrap_or_default();
        Ok(Arc::new(Self {
            root: root.into(),
            store,
            files: Mutex::new(BTreeMap::new()),
            active: Mutex::new(BTreeMap::new()),
            config: Mutex::new(config),
            last_track: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
            watcher: Mutex::new(None),
            refresh_revision: AtomicU64::new(0),
            dark: AtomicBool::new(true),
        }))
    }
    fn scan(&self) -> Result<BTreeMap<String, File>, String> {
        let root = self
            .root
            .canonicalize()
            .map_err(|_| "Extensions folder unavailable")?;
        let mut files = BTreeMap::new();
        let mut remaining = 8_000_000usize;
        for (folder, extension, kind, limit) in [
            ("plugins", "js", "plugin", 512000),
            ("themes", "css", "theme", 1_000_000),
        ] {
            let directory = self
                .root
                .join(folder)
                .canonicalize()
                .map_err(|_| "Extensions folder unavailable")?;
            if !directory.starts_with(&root) {
                return Err("Extensions folder must stay within the Native profile".into());
            }
            for entry in std::fs::read_dir(&directory)
                .map_err(|_| "Could not list extensions")?
                .take(256)
                .flatten()
            {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some(extension) {
                    continue;
                }
                let Some(id) = identity(&path) else {
                    continue;
                };
                let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                    continue;
                };
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > limit
                {
                    continue;
                }
                let Ok(file) = std::fs::File::open(&path) else {
                    continue;
                };
                let mut source = String::new();
                if file.take(limit + 1).read_to_string(&mut source).is_err() {
                    continue;
                }
                if source.len() > remaining {
                    continue;
                }
                if source.len() > limit as usize {
                    continue;
                }
                remaining -= source.len();
                let name = tag(&source, "name");
                let hash = format!("{:x}", Sha256::digest(source.as_bytes()));
                let key = format!("{kind}:{id}");
                files.insert(
                    key,
                    File {
                        info: Info {
                            id: id.clone(),
                            name: if name.is_empty() { id } else { name },
                            author: tag(&source, "author"),
                            version: tag(&source, "version"),
                            description: tag(&source, "description"),
                            kind,
                            enabled: false,
                            error: None,
                        },
                        source,
                        hash,
                    },
                );
            }
        }
        Ok(files)
    }
    fn persist(&self) -> Result<(), String> {
        self.store.set(
            "settings-extensions".into(),
            serde_json::to_value(&*self.config.lock().unwrap())
                .map_err(|_| "Invalid extensions settings")?,
        )
    }
    pub async fn refresh(self: &Arc<Self>, app: &tauri::AppHandle) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        let files = self.scan()?;
        let old = std::mem::take(&mut *self.active.lock().unwrap());
        for (_, active) in old {
            let _ = active.plugin.call("onDisable", Value::Null).await;
            active.plugin.stop();
        }
        *self.files.lock().unwrap() = files;
        let config = self.config.lock().unwrap().clone();
        for id in config.enabled {
            if let Err(error) = self.enable(&id, app).await {
                self.fail(&id, error, app);
            }
        }
        let mut saved = self.config.lock().unwrap();
        if saved.theme.as_ref().is_some_and(|id| {
            !self
                .files
                .lock()
                .unwrap()
                .contains_key(&format!("theme:{id}"))
        }) {
            saved.theme = None;
        }
        drop(saved);
        self.persist()?;
        self.apply(app)
    }
    async fn enable(self: &Arc<Self>, id: &str, app: &tauri::AppHandle) -> Result<(), String> {
        if self.active.lock().unwrap().contains_key(id) {
            return Ok(());
        }
        if self.active.lock().unwrap().len() >= 8 {
            return Err("At most eight plugins can run at once".into());
        }
        if self
            .active
            .lock()
            .unwrap()
            .keys()
            .any(|key| cleanup_key(key) == cleanup_key(id))
        {
            return Err("Another enabled plugin uses the same cleanup name".into());
        }
        let (source, hash) = {
            let files = self.files.lock().unwrap();
            let file = files
                .get(&format!("plugin:{id}"))
                .ok_or("Plugin not found")?;
            (file.source.clone(), file.hash.clone())
        };
        let host = Arc::downgrade(self);
        let failed_id = id.to_string();
        let handle = app.clone();
        let plugin = Plugin::new(source, move |error| {
            if let Some(host) = host.upgrade() {
                let id = failed_id.clone();
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _op = host.operation.lock().await;
                    host.fail(&id, error, &app);
                });
            }
        })?;
        plugin.call("onEnable", Value::Null).await?;
        if let Some(track) = self.last_track.lock().unwrap().clone() {
            plugin.notify("onTrackChange", track);
        }
        plugin.notify("onThemeChange", json!(self.dark.load(Ordering::Acquire)));
        let code = plugin.call("contentScript", Value::Null).await?;
        if !plugin.active() {
            return Err("Plugin stopped during activation".into());
        }
        self.active
            .lock()
            .unwrap()
            .insert(id.into(), Active { plugin, code, hash });
        if let Some(file) = self.files.lock().unwrap().get_mut(&format!("plugin:{id}")) {
            file.info.enabled = true;
            file.info.error = None;
        }
        self.config.lock().unwrap().enabled.insert(id.into());
        Ok(())
    }
    fn fail(&self, id: &str, error: String, app: &tauri::AppHandle) {
        if let Some(active) = self.active.lock().unwrap().remove(id) {
            active.plugin.stop();
        }
        if let Some(file) = self.files.lock().unwrap().get_mut(&format!("plugin:{id}")) {
            file.info.enabled = false;
            file.info.error = Some(error.chars().take(300).collect());
        }
        self.config.lock().unwrap().enabled.remove(id);
        let _ = self.persist();
        let _ = self.apply(app);
    }
    pub async fn toggle(
        self: &Arc<Self>,
        id: &str,
        enabled: bool,
        app: &tauri::AppHandle,
    ) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        if enabled {
            if let Err(error) = self.enable(id, app).await {
                self.fail(id, error.clone(), app);
                return Err(error);
            }
        } else {
            let active = self.active.lock().unwrap().remove(id);
            if let Some(active) = active {
                let _ = active.plugin.call("onDisable", Value::Null).await;
                active.plugin.stop();
            }
            self.config.lock().unwrap().enabled.remove(id);
            if let Some(file) = self.files.lock().unwrap().get_mut(&format!("plugin:{id}")) {
                file.info.enabled = false;
            }
        }
        self.persist()?;
        self.apply(app)
    }
    pub fn theme(&self, id: Option<String>, app: &tauri::AppHandle) -> Result<(), String> {
        if id.as_ref().is_some_and(|id| {
            !self
                .files
                .lock()
                .unwrap()
                .contains_key(&format!("theme:{id}"))
        }) {
            return Err("Theme not found".into());
        }
        self.config.lock().unwrap().theme = id;
        self.persist()?;
        self.apply(app)
    }
    pub fn status(&self) -> Value {
        let selected = self.config.lock().unwrap().theme.clone();
        let files = self.files.lock().unwrap();
        json!({"files":files.values().map(|file|file.info.clone()).collect::<Vec<_>>(),"theme":selected})
    }
    pub fn apply(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let Some(window) = app.get_webview("main") else {
            return Ok(());
        };
        let url = window.url().map_err(|_| "SoundCloud window unavailable")?;
        if url.scheme() != "https" || url.host_str() != Some("soundcloud.com") {
            return Ok(());
        }
        let scripts: Vec<_> = self
            .active
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, active)| active.plugin.active())
            .map(|(id, active)| (id.clone(), active.hash.clone(), active.code.clone()))
            .collect();
        let theme = self.config.lock().unwrap().theme.clone();
        let (css, hash) = {
            let files = self.files.lock().unwrap();
            theme
                .and_then(|id| files.get(&format!("theme:{id}")))
                .map(|file| (file.source.clone(), file.hash.clone()))
                .unwrap_or_default()
        };
        let ids: Vec<_> = scripts.iter().map(|(id, _, _)| id.clone()).collect();
        let mut code = format!(
            "(()=>{{const ids={};window.__nativePluginState??=new Map();for(const[id]of window.__nativePluginState)if(!ids.includes(id)){{try{{window['__scrpc_cleanup_'+id.replaceAll('-','_')]?.()}}catch{{}}window.__nativePluginState.delete(id)}}if(window.__nativeThemeHash!=={}){{if(window.__nativeThemeStyle)document.adoptedStyleSheets=document.adoptedStyleSheets.filter(s=>s!==window.__nativeThemeStyle);window.__nativeThemeHash={};window.__nativeThemeStyle=null;const css={};if(css){{const sheet=new CSSStyleSheet();sheet.replaceSync(css);document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];window.__nativeThemeStyle=sheet}}}}}})();",
            json!(ids),
            json!(hash),
            json!(hash),
            json!(css)
        );
        for (id, hash, source) in scripts {
            if let Some(source) = source {
                code.push_str(&format!("\n(()=>{{const id={},hash={};if(window.__nativePluginState.get(id)===hash)return;try{{window['__scrpc_cleanup_'+id.replaceAll('-','_')]?.();(()=>{{{source}\n}})();window.__nativePluginState.set(id,hash)}}catch(error){{console.error('Plugin page initialization failed',id)}}}})();",json!(id),json!(hash)));
            }
        }
        if let Some(settings) = app.get_webview("settings") {
            let _ = settings.eval("window.dispatchEvent(new Event('native-extensions-changed'))");
        }
        window
            .eval(code)
            .map_err(|_| "Could not apply extensions".to_string())
    }
    pub fn theme_changed(&self, dark: bool) {
        if self.dark.swap(dark, Ordering::AcqRel) == dark {
            return;
        }
        for active in self.active.lock().unwrap().values() {
            active.plugin.notify("onThemeChange", json!(dark));
        }
    }
    pub fn track(&self, track: &crate::presence::Track) {
        let clock = |value: f64| {
            let value = value.max(0.0) as u64;
            format!("{}:{:02}", value / 60, value % 60)
        };
        let value = json!({"title":track.title,"author":track.author,"url":track.url,"artwork":track.artwork,"isPlaying":track.playing,"elapsed":clock(track.elapsed),"duration":clock(track.duration)});
        let mut old = self.last_track.lock().unwrap();
        if old.as_ref().is_some_and(|old| {
            old["url"] == value["url"]
                && old["title"] == value["title"]
                && old["author"] == value["author"]
                && old["isPlaying"] == value["isPlaying"]
        }) {
            return;
        }
        *old = Some(value.clone());
        drop(old);
        for active in self.active.lock().unwrap().values() {
            active.plugin.notify("onTrackChange", value.clone());
        }
    }
    pub fn watch(self: &Arc<Self>, app: tauri::AppHandle) -> Result<(), String> {
        let host = Arc::downgrade(self);
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                if event.is_err() {
                    return;
                }
                if let Some(host) = host.upgrade() {
                    let revision = host.refresh_revision.fetch_add(1, Ordering::AcqRel) + 1;
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        if host.refresh_revision.load(Ordering::Acquire) == revision {
                            let _ = host.refresh(&app).await;
                        }
                    });
                }
            })
            .map_err(|_| "Could not watch extensions")?;
        for folder in ["plugins", "themes"] {
            watcher
                .watch(&self.root.join(folder), RecursiveMode::NonRecursive)
                .map_err(|_| "Could not watch extensions folder")?;
        }
        *self.watcher.lock().unwrap() = Some(watcher);
        Ok(())
    }
    pub fn folder(&self, kind: &str) -> Result<(), String> {
        if !["plugins", "themes"].contains(&kind) {
            return Err("Unknown extension folder".into());
        }
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(self.root.join(kind))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "Could not open extensions folder")?;
        Ok(())
    }
    pub fn stop(&self) {
        self.watcher.lock().unwrap().take();
        let workers = std::mem::take(&mut *self.active.lock().unwrap());
        for (_, active) in workers {
            active.plugin.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scanner_rejects_oversized_files_and_bounds_total_source_memory() {
        let root = std::env::temp_dir().join(format!("sc-extensions-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(&root).unwrap());
        let host = Extensions::new(&root, store.clone()).unwrap();
        let oversized = root.join("plugins/oversized.js");
        std::fs::write(&oversized, "x".repeat(512001)).unwrap();
        let themes: Vec<_> = (0..10)
            .map(|index| root.join(format!("themes/theme-{index}.css")))
            .collect();
        for path in &themes {
            std::fs::write(path, "x".repeat(999999)).unwrap();
        }
        let files = host.scan().unwrap();
        assert!(!files.contains_key("plugin:oversized"));
        assert!(files.contains_key("plugin:playback-speed"));
        assert!(files.values().map(|file| file.source.len()).sum::<usize>() <= 8_000_000);
        drop(host);
        drop(store);
        for path in themes {
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_file(oversized).unwrap();
        std::fs::remove_file(root.join("plugins/playback-speed.js")).unwrap();
        std::fs::remove_dir(root.join("plugins")).unwrap();
        std::fs::remove_dir(root.join("themes")).unwrap();
        std::fs::remove_file(root.join("native.lock")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn metadata_and_ids_are_bounded() {
        assert_eq!(
            tag(include_str!("../../plugins/playback-speed.js"), "name"),
            "Playback Speed"
        );
        assert!(identity(Path::new("a bad.js")).is_none());
        assert!(identity(Path::new("a.b.js")).is_none());
        assert_eq!(cleanup_key("playback-speed"), "playback_speed");
    }
}
