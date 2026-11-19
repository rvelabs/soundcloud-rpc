use crate::{adblock, catalog::{Catalog, Operation}, listening, network, presence, relay, requests, storage};
use base64::{Engine, engine::general_purpose::STANDARD};
use jni::{JNIEnv, objects::{GlobalRef, JClass, JString, JValue}, sys::jstring};
use serde_json::{Value, json};
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}};

struct Host {
    catalog: Arc<Catalog>,
    store: Arc<storage::Store>,
    blocker: Arc<adblock::AdBlock>,
    sources: crate::source::Clients,
    requests: requests::Requests,
    active: AtomicBool,
    listening: Arc<listening::Listening>,
    config: Mutex<Option<relay::Config>>,
    worker: crate::worker_setup::Setup,
    network: Arc<network::Network>,
    port: Option<u16>,
}

static HOST: OnceLock<Mutex<Option<Arc<Host>>>> = OnceLock::new();
static JAVA: OnceLock<(jni::JavaVM, GlobalRef)> = OnceLock::new();
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
fn host() -> Result<Arc<Host>, String> {
    HOST.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Android host lock unavailable")?
        .clone().ok_or_else(|| "SoundCloud is still starting".into())
}

fn init(directory: PathBuf) -> Result<Value, String> {
    let mut slot = HOST.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Android host lock unavailable")?;
    if let Some(existing) = slot.as_ref() { return Ok(json!({"port":existing.port})); }
    let store = Arc::new(storage::Store::open(&directory)?);
    let config = crate::secrets::load(&directory.join("native-connection.dat"))?
        .map(|data| serde_json::from_slice::<relay::Config>(&data).map_err(|_| "Invalid stored connection")).transpose()?;
    let network = network::Network::new(store.clone(), config.clone());
    let port = tauri::async_runtime::block_on(network.route());
    let proxy = port.map(|port| format!("http://127.0.0.1:{port}"));
    let catalog = Arc::new(Catalog::new(proxy.as_deref())?);
    let settings: crate::preferences::Preferences = serde_json::from_value(store.get("settings-client")).unwrap_or_default();
    let blocker = adblock::AdBlock::new(&directory, settings.ad_blocker)?;
    blocker.attached(true);
    let listening = listening::Listening::new(&directory, store.clone())?;
    listening.start();
    let state = Arc::new(Host {
        catalog, store: store.clone(), blocker: blocker.clone(), sources: crate::source::client()?,
        requests: requests::Requests::default(), active: AtomicBool::new(false), listening,
        config: Mutex::new(config), worker: crate::worker_setup::Setup::new(&directory)?, network, port,
    });
    tauri::async_runtime::spawn(async move {
        loop {
            store.changed.notified().await;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let store = store.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || store.flush()).await;
        }
    });
    tauri::async_runtime::spawn(async move { let _ = blocker.refresh(false).await; });
    *slot = Some(state);
    Ok(json!({"port":port}))
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key].as_str().ok_or_else(|| format!("Missing {key}"))
}

async fn call(command: &str, args: Value) -> Result<Value, String> {
    let state = host()?;
    match command {
        "resource" => {
            let url = field(&args, "url")?;
            state.catalog.observe(url, args["authorization"].as_str().unwrap_or(""));
            let decision = state.blocker.decide(url, args["source"].as_str().unwrap_or(""),
                args["kind"].as_str().unwrap_or("other"), args["method"].as_str().unwrap_or("GET"));
            Ok(match decision {
                adblock::Decision::Allow => Value::Null,
                adblock::Decision::Empty => json!({"mime":"application/json", "body":STANDARD.encode(b"{}")}),
                adblock::Decision::SilentAudio => json!({"mime":"audio/wav", "body":STANDARD.encode(adblock::silence())}),
            })
        }
        "catalog_request" => {
            let request: Operation = serde_json::from_value(args["request"].clone()).map_err(|_| "Invalid catalogue request")?;
            state.catalog.execute_scoped(request, args["background"] == true, args["expectedOwner"].as_u64()).await
        }
        #[cfg(target_os = "android")]
        "playback_stream" => {
            let mut result = state.catalog.playback(field(&args, "url")?.into(), args["owner"].as_u64()).await?;
            let track = &result["track"];
            result["metadata"] = validation_rs::port::validate_track_info(json!({
                "title":track["title"], "author":track["user"]["username"], "url":track["permalink_url"],
                "artwork":track["artwork_url"], "elapsed":"0:00", "duration":"0:00"
            }))?.ok_or("Invalid track metadata")?;
            Ok(result)
        }
        "wave_sample" => state.catalog.wave_sample(field(&args, "url")?.into(),
            args["expectedOwner"].as_u64().ok_or("Sign in to SoundCloud")?).await,
        "profile_load" | "profile_save" | "profile_flush" => {
            let key = field(&args, "key")?;
            state.catalog.validate_profile(key).await?;
            match command {
                "profile_load" => Ok(state.store.get(key)),
                "profile_save" => { state.store.set(key.into(), args["value"].clone())?; Ok(Value::Null) }
                _ => { state.store.flush()?; Ok(Value::Null) }
            }
        }
        "wave_active" => { state.active.store(args["active"] == true, Ordering::Relaxed); Ok(Value::Null) }
        "monitor_ready" => Ok(Value::Null),
        "worker_setup_action" => {
            match field(&args, "action")? {
                "authorize" => Ok(json!({"accounts":state.worker.authorize(field(&args,"token")?.into()).await?})),
                "deploy" => {
                    let existing = state.config.lock().unwrap().clone();
                    let config = state.worker.deploy(field(&args,"account")?, existing, |_| {}).await?;
                    crate::secrets::save(&DIRECTORY.get().ok_or("Profile unavailable")?.join("native-connection.dat"),
                        &serde_json::to_vec(&config).map_err(|_| "Invalid connection")?)?;
                    let response = json!({"endpoint":config.endpoint,"hasKey":true,"mode":config.mode});
                    *state.config.lock().unwrap() = Some(config);
                    Ok(response)
                }
                "probe" => {
                    let config = state.config.lock().unwrap().clone().ok_or("Save the Worker connection first")?;
                    serde_json::to_value(state.network.check(config).await?).map_err(|_| "Invalid diagnostics".into())
                }
                "diagnostics" => Ok(json!({"version":env!("CARGO_PKG_VERSION"),"connection":state.network.snapshot(),"catalog":state.catalog.diagnostics()})),
                _ => Err("Unknown Worker operation".into())
            }
        }
        "navigation" => {
            let url = url::Url::parse(field(&args, "url")?).map_err(|_| "Invalid navigation")?;
            if url.host_str() == Some("soundcloud.com") {
                state.network.navigation(&url);
                if url.path() == "/sign-out" { state.catalog.reset(); }
            }
            Ok(Value::Null)
        }
        "native_diagnostics" => Ok(json!({
            "host":"Rust + Android WebView", "version":env!("CARGO_PKG_VERSION"), "catalog":state.catalog.diagnostics(),
            "connection":state.network.snapshot(), "adblock":state.blocker.snapshot(),
            "waveActive":state.active.load(Ordering::Relaxed), "integrations":state.listening.status(false)
        })),
        "source_request" => {
            let id = field(&args, "id")?;
            let cancelled = state.requests.register(id)?;
            let request = crate::source::read(&state.sources, field(&args, "url")?,
                args["method"].as_str().unwrap_or("GET"), args["body"].as_str().map(String::from), state.config.lock().unwrap().clone());
            let result = tokio::select! {
                result = request => result,
                _ = cancelled => Err("Request cancelled".into()),
            };
            state.requests.complete(id);
            result
        }
        "source_cancel" => { state.requests.cancel(field(&args, "id")?.into()); Ok(Value::Null) }
        "client_options" => {
            let mut preferences: crate::preferences::Preferences = serde_json::from_value(state.store.get("settings-client")).unwrap_or_default();
            if !args["options"].is_null() {
                preferences = serde_json::from_value(args["options"].clone()).map_err(|_| "Invalid preferences")?;
                preferences.validate()?;
                state.blocker.set_enabled(preferences.ad_blocker);
                state.store.set("settings-client".into(), serde_json::to_value(&preferences).map_err(|_| "Invalid preferences")?)?;
            }
            serde_json::to_value(preferences).map_err(|_| "Invalid preferences".into())
        }
        "analysis_reset" => {
            state.store.reset_wave(args["owner"].as_u64().ok_or("Sign in first")?)?;
            Ok(Value::Null)
        }
        "adblock_action" => {
            if args["action"] == "update" { let _ = state.blocker.refresh(true).await; }
            Ok(state.blocker.snapshot())
        }
        "listening_status" => Ok(state.listening.status(false)),
        "listening_options" => {
            if !args["options"].is_null() {
                state.listening.configure(serde_json::from_value(args["options"].clone()).map_err(|_| "Invalid listening settings")?)?;
            }
            Ok(state.listening.status(true))
        }
        "listening_update" => {
            let track: Option<presence::Track> = serde_json::from_value(args["track"].clone()).map_err(|_| "Invalid listening frame")?;
            state.listening.observe(track, args["playbackRate"].as_f64().unwrap_or(1.0))?;
            Ok(Value::Null)
        }
        "lastfm_action" => match field(&args, "action")? {
            "authorize" => Ok(json!({"url":state.listening.authorize().await?})),
            "finish" => { state.listening.finish().await?; Ok(state.listening.status(true)) }
            "disconnect" => { state.listening.disconnect("lastfm")?; Ok(state.listening.status(true)) }
            "disconnectWebhook" => { state.listening.disconnect("webhook")?; Ok(state.listening.status(true)) }
            _ => Err("Unknown Last.fm operation".into())
        },
        "connection_load" => {
            let config = state.config.lock().unwrap();
            Ok(json!({"mode":config.as_ref().map_or("off",|c|c.mode.as_str()),
                "endpoint":config.as_ref().map_or("",|c|c.endpoint.as_str()),
                "hasKey":config.as_ref().is_some_and(|c|!c.key.is_empty()),"relayActive":state.port.is_some()}))
        }
        "connection_save" => {
            let endpoint = field(&args, "endpoint")?.trim();
            let mode = field(&args, "mode")?;
            if !["off","auto","on"].contains(&mode) { return Err("Invalid connection mode".into()); }
            if mode != "off" { relay::endpoint(endpoint)?; }
            let existing = state.config.lock().unwrap().clone();
            let key = args["key"].as_str().filter(|key| !key.is_empty())
                .or_else(|| existing.as_ref().map(|config| config.key.as_str())).unwrap_or("");
            if mode != "off" && (!(32..=256).contains(&key.len()) || !key.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))) {
                return Err("Invalid Worker key".into());
            }
            let directory = DIRECTORY.get().ok_or("Android data directory unavailable")?;
            crate::secrets::save(&directory.join("native-connection.dat"),
                &serde_json::to_vec(&relay::Config { endpoint:endpoint.into(), key:key.into(), mode:mode.into() }).map_err(|_| "Invalid connection")?)?;
            *state.config.lock().unwrap() = Some(relay::Config { endpoint:endpoint.into(), key:key.into(), mode:mode.into() });
            Ok(Value::Null)
        }
        "flush" => { state.listening.checkpoint(false)?; state.store.flush()?; Ok(Value::Null) }
        _ => Err(format!("Unsupported Android command: {command}")),
    }
}

pub(crate) fn secret(path: &Path, data: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let (vm, class) = JAVA.get().ok_or("Android keystore is unavailable")?;
    let mut env = vm.attach_current_thread().map_err(|_| "Android keystore thread unavailable")?;
    let path = env.new_string(path.to_string_lossy()).map_err(|_| "Invalid secret path")?;
    let content = env.byte_array_from_slice(data.unwrap_or_default()).map_err(|_| "Secret is too large")?;
    let result = env.call_static_method(<&JClass>::from(class.as_obj()), "crypt",
        "(Ljava/lang/String;[BZ)[B", &[JValue::Object(path.as_ref()), JValue::Object(content.as_ref()), JValue::Bool(u8::from(data.is_some()))]);
    match result.and_then(|value| value.l()) {
        Ok(bytes) => env.convert_byte_array(jni::objects::JByteArray::from(bytes)).map_err(|_| "Android keystore returned invalid data".into()),
        Err(_) => { let _ = env.exception_clear(); Err("Android could not access encrypted settings".into()) }
    }
}

fn reply(env: &JNIEnv, result: Result<Value,String>) -> jstring {
    let value = match result { Ok(value)=>json!({"ok":value}), Err(error)=>json!({"error":error}) };
    match env.new_string(value.to_string()) { Ok(text)=>text.into_raw(), Err(_)=>std::ptr::null_mut() }
}

// SAFETY: Android supplies its current thread's valid JNIEnv, class and strings.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_rvelabs_soundcloud_android_RustBridge_nativeInit(
    mut env: JNIEnv, _class: JClass, directory: JString, secrets: JClass,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let vm = env.get_java_vm().map_err(|_| "JavaVM unavailable")?;
        let class = env.new_global_ref(secrets).map_err(|_| "Android keystore class unavailable")?;
        let _ = JAVA.set((vm,class));
        let directory: String = env.get_string(&directory).map_err(|_| "Invalid Android data directory")?.into();
        let directory = PathBuf::from(directory);
        let _ = DIRECTORY.set(directory.clone());
        init(directory)
    })).unwrap_or_else(|_| Err("Android could not initialize the native host".into()));
    reply(&env,result)
}

// SAFETY: Android supplies JNI arguments. Only main-frame SoundCloud messages reach this entry point.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_rvelabs_soundcloud_android_RustBridge_nativeCall(
    mut env: JNIEnv, _class: JClass, command: JString, arguments: JString,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let command: String = env.get_string(&command).map_err(|_| "Invalid command")?.into();
        let args: String = env.get_string(&arguments).map_err(|_| "Invalid request")?.into();
        if args.len() > 8_000_000 { return Err("Android request exceeds size limit".into()); }
        let value = serde_json::from_str(&args).map_err(|_| "Invalid request JSON")?;
        tauri::async_runtime::block_on(call(&command,value))
    })).unwrap_or_else(|_| Err("Android host recovered from an internal error".into()));
    reply(&env,result)
}
