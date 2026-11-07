use serde_json::{Value, json};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Rect, WebviewBuilder, WebviewUrl};

#[derive(Default)]
pub struct Panel {
    visible: AtomicBool,
    operation: tokio::sync::Mutex<()>,
    last_bounds: Mutex<Option<[u32; 4]>>,
}

fn geometry(width: u32, height: u32, scale: f64) -> [u32; 4] {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let panel_width = width.min((540.0 * scale).round() as u32);
    let player = (56.0 * scale).round() as u32;
    [
        width - panel_width,
        0,
        panel_width,
        height.saturating_sub(player).max(1),
    ]
}
impl Panel {
    fn parent(app: &tauri::AppHandle) -> Result<tauri::Window, String> {
        app.get_window("main")
            .or_else(|| app.get_window("smoke"))
            .ok_or("SoundCloud window unavailable".into())
    }
    fn viewport(
        parent: &tauri::Window,
        app: &tauri::AppHandle,
    ) -> Result<PhysicalSize<u32>, String> {
        let size = parent
            .inner_size()
            .map_err(|_| "Window bounds unavailable")?;
        if size.width > 0 && size.height > 0 {
            return Ok(size);
        }
        let bounds = app
            .get_webview(parent.label())
            .and_then(|view| view.bounds().ok())
            .ok_or("Main viewport unavailable")?;
        Ok(bounds.size.to_physical(
            parent
                .scale_factor()
                .map_err(|_| "Window scale unavailable")?,
        ))
    }
    fn layout(&self, app: &tauri::AppHandle, force: bool) -> Result<(), String> {
        let Some(view) = app.get_webview("settings") else {
            return Ok(());
        };
        let parent = Self::parent(app)?;
        let size = Self::viewport(&parent, app)?;
        let bounds = geometry(
            size.width,
            size.height,
            parent
                .scale_factor()
                .map_err(|_| "Window scale unavailable")?,
        );
        let mut previous = self.last_bounds.lock().unwrap();
        if !force && *previous == Some(bounds) {
            return Ok(());
        }
        view.set_bounds(Rect {
            position: PhysicalPosition::new(bounds[0] as i32, bounds[1] as i32).into(),
            size: PhysicalSize::new(bounds[2], bounds[3]).into(),
        })
        .map_err(|_| "Could not position settings panel")?;
        *previous = Some(bounds);
        Ok(())
    }
    async fn show_locked(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let parent = Self::parent(app)?;
        if app.get_webview("settings").is_none() {
            let smoke = app.state::<std::sync::Arc<crate::State>>().smoke;
            let view = parent
                .add_child(
                    WebviewBuilder::new("settings", WebviewUrl::App("settings.html".into()))
                        .focused(false)
                        .initialization_script(format!("window.__SC_SETTINGS_TEST={smoke};"))
                        .on_navigation(|url| {
                            url.host_str() == Some("tauri.localhost")
                                && url.path() == "/settings.html"
                        }),
                    PhysicalPosition::new(0, 0),
                    PhysicalSize::new(1, 1),
                )
                .map_err(|_| "Could not create embedded settings panel")?;
            crate::webview::accelerators(&view, app.clone())
                .map_err(|_| "Could not register settings shortcut")?;
        }
        self.layout(app, true)?;
        let view = app
            .get_webview("settings")
            .ok_or("Settings panel unavailable")?;
        view.show().map_err(|_| "Could not show settings")?;
        self.visible.store(true, Ordering::Release);
        if !app.state::<std::sync::Arc<crate::State>>().smoke {
            let _ = view.set_focus();
        }
        Ok(())
    }
    fn hide_locked(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if let Some(view) = app.get_webview("settings") {
            view.hide().map_err(|_| "Could not hide settings")?;
        }
        self.visible.store(false, Ordering::Release);
        if let Some(view) = app.get_webview("main") {
            let _ = view.set_focus();
        }
        Ok(())
    }
    pub async fn show(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        self.show_locked(app).await
    }
    pub async fn toggle(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        if self.visible.load(Ordering::Acquire) {
            self.hide_locked(app)
        } else {
            self.show_locked(app).await
        }
    }
    pub async fn hide(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        self.hide_locked(app)
    }
    pub fn resized(&self, app: &tauri::AppHandle) {
        if let Ok(parent) = Self::parent(app)
            && !parent.is_minimized().unwrap_or(true)
            && let Ok(size) = parent.inner_size()
            && size.width > 0
            && size.height > 0
            && let Some(view) = app.get_webview(parent.label())
        {
            let _ = view.set_bounds(Rect {
                position: PhysicalPosition::new(0, 0).into(),
                size: size.into(),
            });
        }
        if self.visible.load(Ordering::Acquire) {
            let _ = self.layout(app, false);
        }
    }
    pub fn diagnostics(&self, app: &tauri::AppHandle) -> Value {
        let parent = Self::parent(app).ok();
        let size = parent
            .as_ref()
            .and_then(|window| Self::viewport(window, app).ok());
        let scale = parent
            .as_ref()
            .and_then(|window| window.scale_factor().ok())
            .unwrap_or(1.0);
        let actual = app
            .get_webview("settings")
            .and_then(|view| view.bounds().ok())
            .map(|bounds| {
                let position = bounds.position.to_physical::<i32>(scale);
                let size = bounds.size.to_physical::<u32>(scale);
                [
                    position.x,
                    position.y,
                    size.width as i32,
                    size.height as i32,
                ]
            });
        json!({"visible":self.visible.load(Ordering::Acquire),"bounds":*self.last_bounds.lock().unwrap(),"actualBounds":actual,"parentSize":size.map(|size|[size.width,size.height]),"parent":app.get_webview("settings").map(|view|view.window().label().to_string()),"windows":app.windows().len(),"webviews":app.webviews().len()})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn panel_stays_on_the_right_inside_the_client_and_above_the_player() {
        for scale in [1.0, 1.25, 1.5, 2.0, 3.0] {
            for (width, height) in [(800, 600), (1280, 850), (3840, 2160)] {
                let [x, y, w, h] = geometry(width, height, scale);
                assert_eq!(x + w, width);
                assert_eq!(y, 0);
                assert!(w <= width && h < height);
                assert!(w as f64 <= 540.0 * scale + 1.0);
                assert_eq!(height - h, (56.0 * scale) as u32);
            }
        }
    }
}
