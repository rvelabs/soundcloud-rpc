use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub minimize_to_tray: bool,
    pub zoom: f64,
    pub theme: String,
    pub navigation: bool,
    pub hide_promotions: bool,
    pub hide_events: bool,
    pub hide_artist_upsells: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            minimize_to_tray: false,
            zoom: 1.0,
            theme: "dark".into(),
            navigation: false,
            hide_promotions: true,
            hide_events: true,
            hide_artist_upsells: true,
        }
    }
}
impl Preferences {
    pub fn validate(&self) -> Result<(), String> {
        if !self.zoom.is_finite()
            || !(0.75..=1.5).contains(&self.zoom)
            || !["dark", "light", "auto"].contains(&self.theme.as_str())
        {
            return Err("Invalid client preferences".into());
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
struct Placement {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    maximized: bool,
}
pub fn remember(window: &tauri::Window, store: &crate::storage::Store) {
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    if let (Ok(size), Ok(position), Ok(scale)) = (
        window.inner_size(),
        window.outer_position(),
        window.scale_factor(),
    ) {
        let size = size.to_logical::<f64>(scale);
        let position = position.to_logical::<f64>(scale);
        let previous: Option<Placement> = serde_json::from_value(store.get("settings-window")).ok();
        let maximized = window.is_maximized().unwrap_or(false);
        let value = if maximized {
            if let Some(mut previous) = previous {
                previous.maximized = true;
                previous
            } else {
                return;
            }
        } else {
            Placement {
                width: size.width,
                height: size.height,
                x: position.x,
                y: position.y,
                maximized,
            }
        };
        if let Ok(value) = serde_json::to_value(value) {
            let _ = store.set("settings-window".into(), value);
        }
    }
}
pub fn restore(window: &tauri::Window, store: &crate::storage::Store) {
    let Ok(value) = serde_json::from_value::<Placement>(store.get("settings-window")) else {
        return;
    };
    if ![value.width, value.height, value.x, value.y]
        .iter()
        .all(|value| value.is_finite())
        || !(800.0..=3840.0).contains(&value.width)
        || !(600.0..=2160.0).contains(&value.height)
    {
        return;
    }
    let _ = window.set_size(tauri::LogicalSize::new(value.width, value.height));
    let on_screen = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .any(|monitor| {
            let position = monitor.position().to_logical::<f64>(monitor.scale_factor());
            let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
            value.x + value.width > position.x + 80.0
                && value.x < position.x + size.width - 80.0
                && value.y >= position.y - 5.0
                && value.y < position.y + size.height - 80.0
        });
    if on_screen {
        let _ = window.set_position(tauri::LogicalPosition::new(value.x, value.y));
    }
    if value.maximized {
        let _ = window.maximize();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_bounded_preferences() {
        let mut settings = Preferences::default();
        assert!(settings.validate().is_ok());
        settings.zoom = f64::NAN;
        assert!(settings.validate().is_err());
        settings.zoom = 1.0;
        settings.theme = "invalid".into();
        assert!(settings.validate().is_err());
        assert!(serde_json::from_str::<Preferences>(r#"{"unknown":true}"#).is_err());
    }
}
