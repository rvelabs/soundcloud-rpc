#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod adblock;
mod cache;
mod catalog;
mod extensions;
mod http;
mod listening;
mod migration;
mod network;
mod preferences;
mod presence;
mod radio;
mod relay;
mod requests;
mod sandbox;
mod secrets;
mod settings_panel;
mod source;
mod spotify;
mod storage;
mod taskbar;
mod updates;
mod webview;
mod worker_setup;

use catalog::{Catalog, Operation};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use storage::Store;
use tauri::{
    Manager, Webview, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tokio::sync::Notify;

struct State {
    adblock: Arc<adblock::AdBlock>,
    taskbar: Arc<taskbar::Taskbar>,
    settings_panel: settings_panel::Panel,
    accounts: accounts::Accounts,
    catalog: Arc<Catalog>,
    store: Arc<Store>,
    active: AtomicBool,
    monitor: AtomicBool,
    discovery_deadline: AtomicU64,
    wake: Notify,
    started: Instant,
    smoke: bool,
    probe: bool,
    profile: PathBuf,
    connection: std::sync::Mutex<Option<relay::Config>>,
    relay_port: Option<u16>,
    source_client: source::Clients,
    source_requests: requests::Requests,
    spotify: spotify::Imports,
    presence: Arc<presence::Presence>,
    listening: Arc<listening::Listening>,
    extensions: Arc<extensions::Extensions>,
    updates: Arc<updates::Updates>,
    network: Arc<network::Network>,
    worker_setup: worker_setup::Setup,
    account_report: Option<PathBuf>,
}

#[tauri::command]
async fn account_result(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    report: Value,
    finished: bool,
) -> Result<(), String> {
    guard(&window, &state)?;
    let directory = state
        .account_report
        .as_ref()
        .ok_or("Account check is disabled")?;
    let bytes = serde_json::to_vec_pretty(&report).map_err(|_| "Invalid account report")?;
    if bytes.len() > 200000 {
        return Err("Account report is too large".into());
    }
    std::fs::write(
        directory.join(if finished {
            "account-result.json"
        } else {
            "account-progress.json"
        }),
        bytes,
    )
    .map_err(|_| "Cannot save account check")?;
    if finished {
        app.exit(if report["success"] == true { 0 } else { 1 });
    }
    Ok(())
}

#[tauri::command]
async fn taskbar_exercise(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    action: String,
) -> Result<(), String> {
    guard(&window, &state)?;
    if !state.smoke {
        return Err("Fixture is disabled".into());
    }
    state.taskbar.exercise(&action)
}
#[tauri::command]
async fn taskbar_update(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    playback: taskbar::Playback,
) -> Result<(), String> {
    guard(&window, &state)?;
    state.taskbar.update(playback);
    Ok(())
}

#[tauri::command]
async fn presence_update(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    track: Option<presence::Track>,
) -> Result<(), String> {
    guard(&window, &state)?;
    if let Some(track) = &track {
        track.validate()?;
        state.extensions.track(track);
    }
    state.presence.set(track)
}

#[tauri::command]
async fn listening_update(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    track: Option<presence::Track>,
    playback_rate: Option<f64>,
) -> Result<(), String> {
    guard(&window, &state)?;
    state.listening.observe(track, playback_rate.unwrap_or(1.0))
}

#[tauri::command]
async fn listening_status(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<Value, String> {
    guard(&window, &state)?;
    Ok(state.listening.status(false))
}

#[tauri::command]
async fn listening_options(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<Value, String> {
    settings_guard(&window)?;
    Ok(state.listening.status(true))
}

#[tauri::command]
async fn accounts_options(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<Value, String> {
    settings_guard(&window)?;
    Ok(state.accounts.status())
}
#[tauri::command]
async fn accounts_action(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    action: String,
    id: Option<String>,
    name: Option<String>,
) -> Result<Value, String> {
    settings_guard(&window)?;
    if action == "select" {
        state.listening.checkpoint(false)?;
        state.store.flush()?;
    }
    let result = state
        .accounts
        .change(&action, id.as_deref(), name.as_deref())?;
    if action == "select" {
        app.restart();
    }
    Ok(result)
}

#[tauri::command]
async fn client_options(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    options: Option<preferences::Preferences>,
) -> Result<preferences::Preferences, String> {
    if options.is_some() || window.label() == "settings" {
        settings_guard(&window)?;
    } else {
        guard(&window, &state)?;
    }
    if let Some(options) = options {
        options.validate()?;
        state.store.set(
            "settings-client".into(),
            serde_json::to_value(&options).map_err(|_| "Invalid preferences")?,
        )?;
        state.adblock.set_enabled(options.ad_blocker);
        if let Some(main) = app.get_webview("main") {
            let _ = main.set_zoom(options.zoom);
        }
        refresh_page_settings(&app);
    }
    Ok(serde_json::from_value(state.store.get("settings-client")).unwrap_or_default())
}
#[tauri::command]
async fn analysis_reset(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    settings_guard(&window)?;
    if state.smoke || state.probe || state.account_report.is_some() {
        return Err("Learning reset is unavailable in read-only diagnostics".into());
    }
    let user = state.catalog.execute(Operation::Me, false).await?;
    let owner = user["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or("Sign in to SoundCloud first")?;
    let key = format!("wave-{owner}");
    state.catalog.validate_profile(&key).await?;
    let account = state.accounts.status();
    migration::import_wave(
        &state.store,
        &owner.to_string(),
        account["current"].as_str().unwrap_or("default"),
    )?;
    state.store.reset_wave(owner)?;
    state.active.store(false, Ordering::Release);
    app.restart()
}

#[tauri::command]
async fn adblock_action(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    action: String,
) -> Result<Value, String> {
    settings_guard(&window)?;
    match action.as_str() {
        "status" => {}
        "refresh" => {
            let _ = state.adblock.refresh(true).await;
        }
        _ => return Err("Unknown ad blocker action".into()),
    }
    Ok(state.adblock.snapshot())
}
#[tauri::command]
async fn extensions_theme(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    dark: bool,
) -> Result<(), String> {
    guard(&window, &state)?;
    state.extensions.theme_changed(dark);
    Ok(())
}

#[tauri::command]
async fn extensions_apply(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    guard(&window, &state)?;
    state.extensions.apply(&app)
}

#[tauri::command]
async fn extensions_options(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<Value, String> {
    settings_guard(&window)?;
    Ok(state.extensions.status())
}

#[tauri::command]
async fn updates_status(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<updates::Snapshot, String> {
    guard(&window, &state)?;
    Ok(state.updates.snapshot())
}

#[tauri::command]
async fn updates_options(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<updates::Snapshot, String> {
    settings_guard(&window)?;
    Ok(state.updates.snapshot())
}

#[tauri::command]
async fn worker_setup_action(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    action: String,
    token: Option<String>,
    account: Option<String>,
) -> Result<Value, String> {
    settings_guard(&window)?;
    match action.as_str() {
        "authorize" => Ok(
            json!({"accounts":state.worker_setup.authorize(token.ok_or("Enter a Cloudflare API token")?).await?}),
        ),
        "deploy" => {
            let existing = state.connection.lock().unwrap().clone();
            let handle = app.clone();
            let config=state.worker_setup.deploy(&account.ok_or("Select a Cloudflare account")?,existing,move|message|{if let Some(window)=handle.get_webview("settings"){let _=window.eval(format!("window.dispatchEvent(new CustomEvent('native-worker-progress',{{detail:{}}}))",json!(message)));}}).await?;
            secrets::save(
                &state.profile.join("native-connection.dat"),
                &serde_json::to_vec(&config).map_err(|_| "Invalid Worker configuration")?,
            )?;
            let endpoint = config.endpoint.clone();
            *state.connection.lock().unwrap() = Some(config);
            state.network.ready(true);
            Ok(json!({"endpoint":endpoint,"hasKey":true,"mode":"auto"}))
        }
        "dashboard" => {
            open_external("https://dash.cloudflare.com/profile/api-tokens")?;
            Ok(Value::Null)
        }
        "files" => {
            let path = state.worker_setup.export_files(&state.profile)?;
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer.exe")
                .arg(path)
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|_| "Could not open Worker folder")?;
            Ok(Value::Null)
        }
        "probe" => {
            let config = state
                .connection
                .lock()
                .unwrap()
                .clone()
                .ok_or("Save the Worker address and key first")?;
            Ok(serde_json::to_value(state.network.check(config).await?)
                .map_err(|_| "Invalid connection report")?)
        }
        "diagnostics" => Ok(
            json!({"version":env!("CARGO_PKG_VERSION"),"connection":state.network.snapshot(),"catalog":state.catalog.diagnostics(),"adblock":state.adblock.snapshot()}),
        ),
        _ => Err("Unknown Worker setup action".into()),
    }
}

#[tauri::command]
async fn updates_action(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    action: String,
    mode: Option<updates::Mode>,
) -> Result<updates::Snapshot, String> {
    settings_guard(&window)?;
    match action.as_str() {
        "check" => state.updates.check(&app, true).await?,
        "download" => state.updates.download(&app).await?,
        "install" => state.updates.install(&app)?,
        "mode" => state
            .updates
            .mode(mode.ok_or("Select an update mode")?, &app)?,
        "notes" => open_external("https://github.com/rvelabs/soundcloud-rpc/releases")?,
        _ => return Err("Unknown update action".into()),
    }
    Ok(state.updates.snapshot())
}

#[tauri::command]
async fn extensions_action(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    action: String,
    id: Option<String>,
    enabled: Option<bool>,
) -> Result<Value, String> {
    settings_guard(&window)?;
    match action.as_str() {
        "toggle" => {
            state
                .extensions
                .toggle(
                    id.as_deref().ok_or("Select a plugin")?,
                    enabled.ok_or("Choose enabled or disabled")?,
                    &app,
                )
                .await?
        }
        "theme" => state
            .extensions
            .theme(id.filter(|id| !id.is_empty()), &app)?,
        "refresh" => state.extensions.refresh(&app).await?,
        "plugins" | "themes" => state.extensions.folder(&action)?,
        _ => return Err("Unknown extension action".into()),
    }
    Ok(state.extensions.status())
}

fn refresh_page_settings(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview("main") {
        let _ = window.eval("void window.__soundcloudNative?.settingsChanged()");
    }
}

#[tauri::command]
async fn listening_save(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    options: listening::Options,
) -> Result<Value, String> {
    settings_guard(&window)?;
    let service = state.listening.clone();
    tauri::async_runtime::spawn_blocking(move || service.configure(options))
        .await
        .map_err(|_| "Could not save integration settings")??;
    refresh_page_settings(&app);
    Ok(state.listening.status(true))
}

#[tauri::command]
async fn lastfm_action(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    action: String,
) -> Result<Value, String> {
    settings_guard(&window)?;
    match action.as_str() {
        "authorize" => {
            let url = state.listening.authorize().await?;
            open_external(&url)?;
        }
        "finish" => state.listening.finish().await?,
        "disconnect" => state.listening.disconnect("lastfm")?,
        "disconnectWebhook" => state.listening.disconnect("webhook")?,
        _ => return Err("Unknown integration action".into()),
    }
    refresh_page_settings(&app);
    Ok(state.listening.status(true))
}

fn open_external(url: &str) -> Result<(), String> {
    let address = url::Url::parse(url).map_err(|_| "Invalid external URL")?;
    if address.scheme() != "https"
        || address.host_str().is_none()
        || !address.username().is_empty()
        || address.password().is_some()
    {
        return Err("Only HTTPS links are allowed".into());
    }
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer.exe")
        .arg(address.as_str())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|_| "Could not open the browser")?;
    Ok(())
}

#[tauri::command]
async fn presence_options(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    options: Option<presence::Options>,
) -> Result<Value, String> {
    settings_guard(&window)?;
    if let Some(options) = options {
        state.store.set(
            "settings-discord".into(),
            serde_json::to_value(&options).map_err(|_| "Invalid Discord options")?,
        )?;
        state.presence.configure(options);
    }
    Ok(
        json!({"options": serde_json::from_value::<presence::Options>(state.store.get("settings-discord")).unwrap_or_default(), "diagnostics": state.presence.diagnostics()}),
    )
}

fn guard(window: &Webview, state: &State) -> Result<(), String> {
    let url = window.url().map_err(|_| "WebView URL unavailable")?;
    if window.label() == "main"
        && url.scheme() == "https"
        && url.host_str() == Some("soundcloud.com")
        && url.port().is_none()
    {
        return Ok(());
    }
    if state.smoke
        && window.label() == "smoke"
        && ["tauri", "http", "https"].contains(&url.scheme())
        && [Some("tauri.localhost"), Some("localhost")].contains(&url.host_str())
    {
        return Ok(());
    }
    Err("Native command is unavailable on this page".into())
}

#[tauri::command]
async fn catalog_request(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    request: Operation,
    background: bool,
    expected_owner: Option<u64>,
) -> Result<Value, String> {
    guard(&window, &state)?;
    state
        .catalog
        .execute_scoped(request, background, expected_owner)
        .await
}

#[tauri::command]
async fn profile_load(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    key: String,
) -> Result<Value, String> {
    guard(&window, &state)?;
    state.catalog.validate_profile(&key).await?;
    if let Some(owner) = key.strip_prefix("wave-") {
        let account = state.accounts.status();
        migration::import_wave(
            &state.store,
            owner,
            account["current"].as_str().unwrap_or("default"),
        )?;
    }
    Ok(state.store.get(&key))
}

#[tauri::command]
async fn profile_save(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    key: String,
    value: Value,
) -> Result<(), String> {
    guard(&window, &state)?;
    state.catalog.validate_profile(&key).await?;
    state.store.set(key, value)
}

#[tauri::command]
async fn profile_flush(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    key: String,
) -> Result<(), String> {
    guard(&window, &state)?;
    state.catalog.validate_profile(&key).await?;
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || store.flush())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn source_request(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    url: String,
    method: String,
    body: Option<String>,
    id: String,
) -> Result<Value, String> {
    guard(&window, &state)?;
    let connection = state.connection.lock().unwrap().clone();
    let cancelled = state.source_requests.register(&id)?;
    let result = tokio::select! {
        result = source::read(&state.source_client, &url, &method, body, connection) => result,
        _ = cancelled => Err("Request cancelled".into()),
    };
    state.source_requests.complete(&id);
    result
}

#[tauri::command]
async fn source_cancel(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    id: String,
) -> Result<(), String> {
    guard(&window, &state)?;
    if id.len() > 64 {
        return Err("Invalid request ID".into());
    }
    state.source_requests.cancel(id);
    Ok(())
}

#[tauri::command]
async fn wave_active(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    active: bool,
) -> Result<(), String> {
    guard(&window, &state)?;
    state.active.store(active, Ordering::Release);
    state.wake.notify_one();
    Ok(())
}

#[tauri::command]
async fn monitor_ready(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    ready: bool,
) -> Result<(), String> {
    guard(&window, &state)?;
    state.monitor.store(ready, Ordering::Release);
    state.network.ready(ready);
    if !ready {
        state.discovery_deadline.store(
            state.started.elapsed().as_millis() as u64 + 120000,
            Ordering::Release,
        );
        state.wake.notify_one();
    }
    Ok(())
}

#[tauri::command]
async fn native_diagnostics(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<Value, String> {
    guard(&window, &state)?;
    Ok(
        json!({ "version": env!("CARGO_PKG_VERSION"), "host": "Rust + WebView2", "electron": false,
        "uptimeSeconds": state.started.elapsed().as_secs(), "waveActive": state.active.load(Ordering::Acquire), "adblock":state.adblock.snapshot(),
        "nativeMonitor": state.monitor.load(Ordering::Acquire), "catalog": state.catalog.diagnostics(), "relayActive": state.relay_port.is_some(), "discord":state.presence.diagnostics(), "taskbar":state.taskbar.diagnostics(),"integrations":state.listening.status(false), "updates":state.updates.snapshot(), "connection":state.network.snapshot() }),
    )
}

fn settings_guard(window: &Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "Settings URL unavailable")?;
    if window.label() == "settings"
        && ["main", "smoke"].contains(&window.window().label())
        && ["http", "https", "tauri"].contains(&url.scheme())
        && url.host_str() == Some("tauri.localhost")
        && url.path() == "/settings.html"
    {
        Ok(())
    } else {
        Err("Only the local settings panel may change connection settings".into())
    }
}

#[tauri::command]
async fn open_settings(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    guard(&window, &state)?;
    show_settings(&app).await
}

async fn show_settings(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<State>>();
    state.settings_panel.toggle(app).await
}
#[tauri::command]
async fn close_settings(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    settings_guard(&window)?;
    state.settings_panel.hide(&app).await
}

#[tauri::command]
async fn connection_load(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<Value, String> {
    settings_guard(&window)?;
    let connection = state.connection.lock().unwrap();
    Ok(
        json!({"endpoint": connection.as_ref().map(|c| c.endpoint.as_str()).unwrap_or(""), "hasKey": connection.as_ref().is_some_and(|c| !c.key.is_empty()),
        "mode": connection.as_ref().map(|c| c.mode.as_str()).unwrap_or("off"), "relayActive": state.relay_port.is_some()}),
    )
}

#[tauri::command]
async fn interface_language(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
) -> Result<String, String> {
    settings_guard(&window)?;
    let settings = state.store.get("settings");
    Ok(settings["language"]
        .as_str()
        .filter(|language| ["auto", "ru", "en"].contains(language))
        .unwrap_or("auto")
        .to_string())
}

#[tauri::command]
async fn connection_save(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    endpoint: String,
    key: String,
    mode: String,
) -> Result<(), String> {
    settings_guard(&window)?;
    if !["off", "auto", "on"].contains(&mode.as_str()) {
        return Err("Invalid connection mode".into());
    }
    let mut connection = state.connection.lock().unwrap();
    let key = if key.is_empty() {
        connection
            .as_ref()
            .map(|c| c.key.clone())
            .unwrap_or_default()
    } else {
        key
    };
    if mode != "off" {
        relay::endpoint(&endpoint)?;
        if !(32..=256).contains(&key.len())
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            return Err("Enter the Worker key (32–256 characters)".into());
        }
    }
    let config = relay::Config {
        endpoint,
        key,
        mode,
    };
    secrets::save(
        &state.profile.join("native-connection.dat"),
        &serde_json::to_vec(&config).map_err(|e| e.to_string())?,
    )?;
    *connection = Some(config);
    state.network.reconfigured()?;
    Ok(())
}

#[tauri::command]
async fn restart_native(window: Webview, app: tauri::AppHandle) -> Result<(), String> {
    settings_guard(&window)?;
    app.restart()
}

#[tauri::command]
async fn settings_test_result(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    report: Value,
) -> Result<(), String> {
    settings_guard(&window)?;
    if !state.smoke {
        return Err("Fixture is disabled".into());
    }
    let bytes = serde_json::to_vec(&report).map_err(|_| "Invalid fixture report")?;
    if bytes.len() > 10000 {
        return Err("Report too large".into());
    }
    std::fs::write(state.profile.join("settings-result.json"), bytes)
        .map_err(|_| "Could not save fixture report".into())
}
#[tauri::command]
async fn smoke_settings(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    open: bool,
    action: Option<String>,
) -> Result<Value, String> {
    guard(&window, &state)?;
    if !state.smoke {
        return Err("Fixture is disabled".into());
    }
    if open {
        state.settings_panel.show(&app).await?;
    }
    match action.as_deref() {
        Some("close") => {
            if let Some(view) = app.get_webview("settings") {
                view.eval("document.getElementById('settings-close').click()")
                    .map_err(|_| "Could not exercise panel close")?;
            }
        }
        Some("resize") => {
            window
                .window()
                .set_size(tauri::LogicalSize::new(1000.0, 760.0))
                .map_err(|_| "Could not resize fixture")?;
        }
        Some(_) => return Err("Unknown fixture action".into()),
        None => {}
    }
    let path = state.profile.join("settings-result.json");
    if path.exists() {
        let mut report: Value = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| "Could not read fixture report")?,
        )
        .map_err(|_| "Invalid fixture report")?;
        report["panel"] = state.settings_panel.diagnostics(&app);
        Ok(report)
    } else {
        Ok(Value::Null)
    }
}

#[tauri::command]
async fn smoke_result(
    window: Webview,
    state: tauri::State<'_, Arc<State>>,
    app: tauri::AppHandle,
    report: Value,
) -> Result<(), String> {
    guard(&window, &state)?;
    if !(state.smoke && window.label() == "smoke" || state.probe && window.label() == "main") {
        return Err("Integration fixture is disabled".into());
    }
    if serde_json::to_vec(&report)
        .map_err(|e| e.to_string())?
        .len()
        > 100_000
    {
        return Err("Integration report too large".into());
    }
    let mut report = report;
    report["adblock"] = state.adblock.snapshot();
    report["nativeWindowVisible"] = json!(window.window().is_visible().map_err(|e| e.to_string())?);
    report["nativeWindowMinimized"] =
        json!(window.window().is_minimized().map_err(|e| e.to_string())?);
    std::fs::write(
        state.profile.join("smoke-result.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if state.smoke && report["success"] == true {
        state
            .store
            .set("settings-client".into(), json!({"minimizeToTray":true}))?;
        window.window().close().map_err(|error| error.to_string())?;
    } else {
        app.exit(if report["success"] == true { 0 } else { 1 });
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("SoundCloud native failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--prepare-electron-migration") {
        let profile = args
            .windows(2)
            .find(|pair| pair[0] == "--profile")
            .map(|pair| PathBuf::from(&pair[1]))
            .unwrap_or(
                PathBuf::from(std::env::var("LOCALAPPDATA")?)
                    .join("io.rvelabs.soundcloud.native.preview"),
            );
        let source = args
            .windows(2)
            .find(|pair| pair[0] == "--migration-source")
            .map(|pair| PathBuf::from(&pair[1]))
            .unwrap_or(PathBuf::from(std::env::var("APPDATA")?).join("soundcloud-rpc"));
        let store = Store::open(&profile)?;
        let mut report = migration::stage(&store, &source)?;
        if let Some(pair) = args
            .windows(2)
            .find(|pair| pair[0] == "--migration-bind-owner")
        {
            if !args.iter().any(|arg| arg == "--profile")
                || pair[1].parse::<u64>().unwrap_or(0) == 0
            {
                return Err(
                    "Migration verification requires an isolated profile and a numeric owner"
                        .into(),
                );
            }
            migration::import_wave(
                &store,
                &pair[1],
                report["partition"].as_str().unwrap_or("default"),
            )?;
            report = store.get("settings-electron-migration");
        }
        if let Some(pair) = args.windows(2).find(|pair| pair[0] == "--report-file") {
            std::fs::write(&pair[1], serde_json::to_vec_pretty(&report)?)?;
        }
        return Ok(());
    }
    let smoke = args.iter().any(|arg| arg == "--smoke-test");
    let probe = args.iter().any(|arg| arg == "--probe");
    let taste_audit = args.iter().any(|arg| arg == "--taste-audit");
    let account_check = taste_audit || args.iter().any(|arg| arg == "--account-check");
    let account_quick = args.iter().any(|arg| arg == "--account-quick");
    let account_report = if account_check {
        Some(PathBuf::from(
            args.windows(2)
                .find(|pair| pair[0] == "--report-dir")
                .ok_or("Account checks require --report-dir")?[1]
                .clone(),
        ))
    } else {
        None
    };
    let profile_override = args
        .windows(2)
        .find(|args| args[0] == "--profile")
        .map(|args| PathBuf::from(&args[1]));
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            catalog_request,
            profile_load,
            profile_save,
            profile_flush,
            wave_active,
            monitor_ready,
            native_diagnostics,
            source_request,
            source_cancel,
            spotify::spotify_open,
            spotify::spotify_state,
            spotify::spotify_page,
            spotify::spotify_show,
            spotify::spotify_close,
            smoke_result,
            smoke_settings,
            settings_test_result,
            open_settings,
            close_settings,
            connection_load,
            interface_language,
            connection_save,
            restart_native,
            taskbar_update,
            taskbar_exercise,
            presence_update,
            presence_options,
            listening_update,
            listening_status,
            listening_options,
            extensions_apply,
            extensions_theme,
            client_options,
            adblock_action,
            analysis_reset,
            accounts_options,
            accounts_action,
            extensions_options,
            extensions_action,
            updates_status,
            updates_options,
            updates_action,
            worker_setup_action,
            listening_save,
            lastfm_action,
            account_result
        ]);
    let app = builder.setup(move |app| {
        let profile = profile_override.clone().unwrap_or(app.path().app_local_data_dir()?);
        if (smoke || probe || taste_audit) && profile_override.is_none() { return Err("Integration tests require an isolated --profile directory".into()); }
        let root_store=Arc::new(Store::open(&profile)?);
        if profile_override.is_none() && !smoke && !probe && !account_check && let Ok(roaming)=std::env::var("APPDATA") && let Err(error)=migration::stage(&root_store,&PathBuf::from(roaming).join("soundcloud-rpc")) {eprintln!("Previous SoundCloud data migration deferred: {error}");}
        let accounts=accounts::Accounts::new(&profile,root_store.clone())?;
        let profile=accounts.profile()?;
        let original_store=if accounts.status()["current"]=="default"{root_store.clone()}else{Arc::new(Store::open(&profile)?)};
        let store = if let Some(directory) = &account_report { std::fs::create_dir_all(directory)?; Arc::new(original_store.fork(directory)?) } else { original_store };
        let connection: Option<relay::Config> = if account_check { None } else { secrets::load(&profile.join("native-connection.dat"))?.map(|bytes| serde_json::from_slice(&bytes)).transpose()? };
        let network = network::Network::new(store.clone(), connection.clone());
        let relay_port = if !smoke && !account_check { tauri::async_runtime::block_on(network.route()) } else { None };
        let proxy = relay_port.map(|port| format!("http://127.0.0.1:{port}"));
        let catalog = Arc::new(Catalog::new(proxy.as_deref())?);
        let presence = presence::Presence::new(serde_json::from_value(store.get("settings-discord")).unwrap_or_default(), !smoke);
        let listening = listening::Listening::new(account_report.as_deref().unwrap_or(&profile), store.clone())?;
        if !smoke && !probe && !account_check { listening.start(); }
        let extensions = extensions::Extensions::new(account_report.as_deref().unwrap_or(&profile), store.clone())?;
        let updates = updates::Updates::new(store.clone());
        let client_preferences:preferences::Preferences=serde_json::from_value(store.get("settings-client")).unwrap_or_default();
        let adblock = adblock::AdBlock::new(account_report.as_deref().unwrap_or(&profile), client_preferences.ad_blocker)?;
        let state = Arc::new(State { adblock:adblock.clone(),taskbar:Arc::new(taskbar::Taskbar::default()),settings_panel:settings_panel::Panel::default(),accounts, catalog: catalog.clone(), store: store.clone(), active: AtomicBool::new(false), monitor: AtomicBool::new(false), discovery_deadline: AtomicU64::new(120000), wake: Notify::new(), started: Instant::now(), smoke, probe, profile: profile.clone(), connection: std::sync::Mutex::new(connection), relay_port, source_client: source::client()?, source_requests: requests::Requests::default(), spotify: spotify::Imports::default(), presence, listening, extensions: extensions.clone(), updates: updates.clone(), network: network.clone(), worker_setup: worker_setup::Setup::new(account_report.as_deref().unwrap_or(&profile))?, account_report: account_report.clone() });
        app.manage(state.clone());
        if !smoke && !probe && !account_check { updates.start(app.handle().clone()); }
        let url = if smoke { WebviewUrl::App("smoke.html".into()) } else { WebviewUrl::External("about:blank".parse()?) };
        let mut browser_args = "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows".to_string();
        if let Some(port) = relay_port { browser_args.push_str(&format!(" --proxy-pac-url=http://127.0.0.1:{port}/proxy.pac")); }
        let mut window_builder = WebviewWindowBuilder::new(app, if smoke { "smoke" } else { "main" }, url)
            .title("SoundCloud").inner_size(1280.0, 850.0).min_inner_size(800.0, 600.0)
            .data_directory(profile.join("WebView2"))
            .additional_browser_args(&browser_args)
            .on_navigation({ let state = state.clone(); move |url| {
                if url.scheme()=="https" && url.host_str()==Some("soundcloud.com") {state.network.navigation(url);state.monitor.store(false,Ordering::Release);state.discovery_deadline.store(state.started.elapsed().as_millis() as u64 + 120000,Ordering::Release);state.wake.notify_one();}
                url.scheme()=="https" || url.scheme()=="about" || url.host_str()==Some("tauri.localhost")
            }});
        if !smoke {
            window_builder = window_builder.initialization_script(format!("window.__SC_NATIVE_PROBE={probe};window.__SC_NATIVE_ACCOUNT_CHECK={account_check};window.__SC_NATIVE_TASTE_AUDIT={taste_audit};window.__SC_NATIVE_CHECK_QUICK={account_quick};{}", include_str!("../assets/inject.js")));
        }
        if smoke {
            window_builder = window_builder.initialization_script(format!("window.__scSmokeErrors=[];addEventListener('error',e=>window.__scSmokeErrors.push(e.message||e.target?.src||'resource error'),true);const start=()=>{{ {} }};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{{once:true}});else start();", include_str!("../assets/smoke.js")));
        }
        if smoke || probe || account_check { window_builder = window_builder.visible(false); }
        let window = window_builder.build()?;
        window.as_ref().set_auto_resize(false)?;
        window.on_window_event({let handle=app.handle().clone();let state=state.clone();move|event|{if matches!(event,tauri::WindowEvent::Resized(_)|tauri::WindowEvent::ScaleFactorChanged{..}){state.settings_panel.resized(&handle);}}});
        webview::accelerators(window.as_ref(),app.handle().clone())?;
        window.set_zoom(client_preferences.zoom)?;
        if !smoke && !probe && !account_check{preferences::restore(&window.as_ref().window(),&store);}
        if smoke { window.minimize()?; window.hide()?; }
        if account_check { window.minimize()?; window.hide()?; }
        window.as_ref().show()?;
        if !probe && !account_check && let Err(error) = state.taskbar.install(&window, app.handle().clone()) { eprintln!("{error}"); }
        webview::observe(&window, catalog, adblock.clone(), smoke)?;
        if !smoke && !probe && !account_check { tauri::async_runtime::spawn(async move { let _ = adblock.refresh(false).await; }); }
        if !smoke && !probe && !account_check { let app = app.handle().clone(); tauri::async_runtime::spawn(async move { let _ = extensions.refresh(&app).await; let _ = extensions.watch(app); }); }
        let host = app.handle().clone(); let state_loop = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let active = state_loop.active.load(Ordering::Acquire);
                let initializing = (!state_loop.monitor.load(Ordering::Acquire) || state_loop.probe) && state_loop.started.elapsed().as_millis() < state_loop.discovery_deadline.load(Ordering::Acquire) as u128;
                let interval = Duration::from_secs(if active || initializing { 3 } else { 15 });
                tokio::select! { _ = tokio::time::sleep(interval) => {}, _ = state_loop.wake.notified() => {} }
                if let Some(window) = host.get_webview("main") { if window.url().ok().is_some_and(|url|url.host_str()==Some("soundcloud.com")) && state_loop.network.recover().unwrap_or(false) {host.restart();} let _ = window.eval("void window.__soundcloudNative?.tick()"); }
            }
        });
        tauri::async_runtime::spawn(async move {
            loop {
                store.changed.notified().await;
                tokio::time::sleep(Duration::from_secs(1)).await;
                let store = store.clone();
                if let Err(error) = tauri::async_runtime::spawn_blocking(move || store.flush()).await.unwrap_or_else(|e| Err(e.to_string())) { eprintln!("Native profile persistence failed: {error}"); }
            }
        });
        if !smoke && !probe && !account_check {
            let show = MenuItem::with_id(app, "show", "SoundCloud", true, None::<&str>)?;
            let play = MenuItem::with_id(app, "toggle", "Play / Pause", true, None::<&str>)?;
            let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &play, &next, &exit])?;
            TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone()).menu(&menu).on_menu_event(|app, event| {
                let command = event.id.as_ref();
                if command == "exit" { if let Some(state) = app.try_state::<Arc<State>>() { state.updates.install_on_quit(app); } app.exit(0); }
                else if let Some(window) = app.get_webview("main") {
                    if command == "show" { let host=window.window();let _ = host.show(); let _ = host.unminimize(); let _ = window.set_focus(); }
                    else if ["toggle", "next"].contains(&command) { let _ = window.eval(format!("window.__soundcloudNative?.control({})", serde_json::to_string(command).unwrap())); }
                }
            }).build(app)?;
        } else {
            let app = app.handle().clone();
            let probe_window = window.clone(); let profile = account_report.clone().unwrap_or_else(|| profile.clone());
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(8)).await;
                let path = profile.join("webview-checkpoint.json");
                let _ = probe_window.eval_with_callback("JSON.stringify({path:location.pathname,ready:document.readyState,tauri:typeof window.__TAURI_INTERNALS__,phase:window.__scSmokePhase,error:window.__scSmokeError,errors:window.__scSmokeErrors})", move |value| { let _ = std::fs::write(&path, value); });
                tokio::time::sleep(Duration::from_secs(if account_check { 890 } else { 52 })).await; app.exit(2);
            });
        }
        window.on_window_event({ let window = window.clone();let state=state.clone();let app=app.handle().clone(); move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                preferences::remember(&window.as_ref().window(),&state.store);
                api.prevent_close();
                if state.smoke {
                    let path=state.profile.join("smoke-result.json");
                    if let Ok(bytes)=std::fs::read(&path) && let Ok(mut report)=serde_json::from_slice::<Value>(&bytes) {
                        report["closedThroughWindow"]=json!(true);
                        if let Ok(bytes)=serde_json::to_vec_pretty(&report) {let _=std::fs::write(path,bytes);}
                    }
                } else {state.updates.install_on_quit(&app);}
                app.exit(0);
            }
        }});
        Ok(())
    }).build(tauri::generate_context!())?;
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event
            && let Some(state) = app.try_state::<Arc<State>>()
        {
            if let Some(window) = app.get_webview("main") {
                preferences::remember(&window.window(), &state.store);
            }
            let _ = state.accounts.flush();
            state.extensions.stop();
            if let Err(error) = state.listening.checkpoint(true) {
                eprintln!("Listening checkpoint failed: {error}");
            }
            if let Err(error) = state.store.flush() {
                eprintln!("Native profile final save failed: {error}");
            }
        }
    });
    Ok(())
}
