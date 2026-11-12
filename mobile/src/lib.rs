use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    Manager, Runtime,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    OpenCatalog,
    StartFixture,
    Status,
    Play,
    Pause,
    Previous,
    Next,
    Stop,
}

struct Android<R: Runtime>(PluginHandle<R>);

#[tauri::command]
async fn android_action<R: Runtime>(
    app: tauri::AppHandle<R>,
    action: Action,
) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<Android<R>>()
            .0
            .run_mobile_plugin_async("action", serde_json::json!({ "action": action }))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, action);
        Err("This application targets Android".into())
    }
}

fn platform<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-platform")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(Android(api.register_android_plugin(
                "io.rvelabs.soundcloud.android",
                "AndroidPlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(platform())
        .invoke_handler(tauri::generate_handler![android_action])
        .run(tauri::generate_context!())
        .expect("Cannot start SoundCloud");
}
