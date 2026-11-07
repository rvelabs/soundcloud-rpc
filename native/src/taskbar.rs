use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::{cell::Cell, rc::Rc};
use tauri::Manager;
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
        UI::{Shell::*, WindowsAndMessaging::*},
    },
    core::w,
};

const FIRST: u32 = 0xD710;
const UPDATE: u32 = WM_APP + 0x6A2;
const SUBCLASS: usize = 0x53435250;
#[derive(Clone, Copy, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Playback {
    pub available: bool,
    pub playing: bool,
    pub liked: bool,
    pub russian: bool,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    installed: bool,
    registered: bool,
    updates: u64,
    commands: u64,
    error: Option<String>,
}
#[derive(Default)]
pub struct Taskbar {
    hwnd: AtomicUsize,
    current: Mutex<Playback>,
    diagnostics: Mutex<Diagnostics>,
}
struct Host {
    app: tauri::AppHandle,
    shared: Arc<Taskbar>,
    shell: ITaskbarList3,
    icons: Vec<HICON>,
    created_message: u32,
    registered: Cell<bool>,
    rendering: Cell<bool>,
}
impl Drop for Host {
    fn drop(&mut self) {
        for icon in &self.icons {
            let _ = unsafe { DestroyIcon(*icon) };
        }
    }
}
fn command(id: u32) -> Option<&'static str> {
    match id.checked_sub(FIRST)? {
        0 => Some("like"),
        1 => Some("previous"),
        2 => Some("toggle"),
        3 => Some("next"),
        _ => None,
    }
}
fn icon_payload(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() < 6 || bytes[0..4] != [0, 0, 1, 0] {
        return None;
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    if count == 0 || count > 256 || bytes.len() < 6 + count * 16 {
        return None;
    }
    let entry = (0..count)
        .map(|index| &bytes[6 + index * 16..22 + index * 16])
        .min_by_key(|entry| {
            let size = if entry[0] == 0 {
                256
            } else {
                u32::from(entry[0])
            };
            size.abs_diff(32)
        })?;
    let size = u32::from_le_bytes(entry[8..12].try_into().ok()?) as usize;
    let offset = u32::from_le_bytes(entry[12..16].try_into().ok()?) as usize;
    bytes.get(offset..offset.checked_add(size)?)
}
impl Host {
    fn render(&self, hwnd: HWND) {
        if self.rendering.replace(true) {
            return;
        }
        let state = *self.shared.current.lock().unwrap();
        let labels = if state.russian {
            [
                if state.liked {
                    "Убрать лайк"
                } else {
                    "Нравится"
                },
                "Предыдущий",
                if state.playing {
                    "Пауза"
                } else {
                    "Слушать"
                },
                "Следующий",
            ]
        } else {
            [
                if state.liked { "Unlike" } else { "Like" },
                "Previous",
                if state.playing { "Pause" } else { "Play" },
                "Next",
            ]
        };
        let indices = [
            if state.liked { 1 } else { 0 },
            2,
            if state.playing { 4 } else { 3 },
            5,
        ];
        let buttons: Vec<_> = labels
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let mut button = THUMBBUTTON {
                    dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
                    iId: FIRST + index as u32,
                    hIcon: self.icons[indices[index]],
                    dwFlags: if state.available {
                        THBF_ENABLED
                    } else {
                        THBF_DISABLED
                    },
                    ..Default::default()
                };
                for (to, value) in button.szTip.iter_mut().zip(label.encode_utf16().take(259)) {
                    *to = value;
                }
                button
            })
            .collect();
        let result = unsafe {
            if self.registered.get() {
                self.shell.ThumbBarUpdateButtons(hwnd, &buttons)
            } else {
                self.shell.ThumbBarAddButtons(hwnd, &buttons)
            }
        };
        let mut diagnostics = self.shared.diagnostics.lock().unwrap();
        match result {
            Ok(()) => {
                self.registered.set(true);
                diagnostics.registered = true;
                diagnostics.updates += 1;
                diagnostics.error = None;
            }
            Err(error) => {
                diagnostics.error = Some(format!("Taskbar registration: {}", error.code()));
            }
        }
        self.rendering.set(false);
    }
}
unsafe extern "system" fn callback(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    let pointer = data as *const Host;
    unsafe { Rc::increment_strong_count(pointer) };
    let host = unsafe { Rc::from_raw(pointer) };
    if message == WM_NCDESTROY {
        host.shared.hwnd.store(0, Ordering::Release);
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(callback), SUBCLASS) };
        drop(unsafe { Rc::from_raw(pointer) });
        return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    }
    if message == host.created_message {
        host.registered.set(false);
        host.render(hwnd);
    }
    if message == UPDATE {
        host.render(hwnd);
        return LRESULT(0);
    }
    if message == WM_COMMAND
        && (wparam.0 >> 16) & 0xffff == THBN_CLICKED as usize
        && let Some(action) = command((wparam.0 & 0xffff) as u32)
        && host.shared.current.lock().unwrap().available
    {
        host.shared.diagnostics.lock().unwrap().commands += 1;
        if let Some(view) = host
            .app
            .get_webview("main")
            .or_else(|| host.app.get_webview("smoke"))
        {
            let _ = view.eval(format!(
                "window.__soundcloudNative?.control({})",
                json!(action)
            ));
        }
        return LRESULT(0);
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
impl Taskbar {
    pub fn install(
        self: &Arc<Self>,
        window: &tauri::WebviewWindow,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|_| "Window handle unavailable")?;
        let shell: ITaskbarList3 =
            unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) }
                .map_err(|_| "Windows taskbar is unavailable")?;
        unsafe { shell.HrInit() }.map_err(|_| "Could not initialize Windows taskbar")?;
        let mut icons = Vec::new();
        for bytes in [
            include_bytes!("../../assets/icons/heart.ico").as_slice(),
            include_bytes!("../../assets/icons/heart-filled.ico"),
            include_bytes!("../../assets/icons/backward.ico"),
            include_bytes!("../../assets/icons/play.ico"),
            include_bytes!("../../assets/icons/pause.ico"),
            include_bytes!("../../assets/icons/forward.ico"),
        ] {
            let icon = icon_payload(bytes)
                .ok_or("Invalid taskbar icon")
                .and_then(|image| {
                    unsafe {
                        CreateIconFromResourceEx(image, true, 0x30000, 32, 32, LR_DEFAULTCOLOR)
                    }
                    .map_err(|_| "Could not load taskbar icon")
                });
            match icon {
                Ok(icon) => icons.push(icon),
                Err(error) => {
                    for icon in icons {
                        let _ = unsafe { DestroyIcon(icon) };
                    }
                    return Err(error.into());
                }
            }
        }
        let host = Rc::new(Host {
            app,
            shared: self.clone(),
            shell,
            icons,
            created_message: unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) },
            registered: Cell::new(false),
            rendering: Cell::new(false),
        });
        let pointer = Rc::into_raw(host.clone()) as usize;
        if !unsafe { SetWindowSubclass(hwnd, Some(callback), SUBCLASS, pointer) }.as_bool() {
            drop(unsafe { Rc::from_raw(pointer as *const Host) });
            return Err("Could not attach taskbar controls".into());
        }
        self.hwnd.store(hwnd.0 as usize, Ordering::Release);
        self.diagnostics.lock().unwrap().installed = true;
        host.render(hwnd);
        Ok(())
    }
    pub fn update(&self, value: Playback) {
        let mut current = self.current.lock().unwrap();
        if *current == value {
            return;
        }
        *current = value;
        drop(current);
        let hwnd = self.hwnd.load(Ordering::Acquire);
        if hwnd != 0 {
            let _ =
                unsafe { PostMessageW(Some(HWND(hwnd as *mut _)), UPDATE, WPARAM(0), LPARAM(0)) };
        }
    }
    pub fn diagnostics(&self) -> Value {
        json!({"state":*self.current.lock().unwrap(),"native":*self.diagnostics.lock().unwrap()})
    }
    pub fn exercise(&self, action: &str) -> Result<(), String> {
        let id = (FIRST..FIRST + 4)
            .find(|id| command(*id) == Some(action))
            .ok_or("Unknown taskbar action")?;
        let hwnd = self.hwnd.load(Ordering::Acquire);
        if hwnd == 0 {
            return Err("Taskbar hook is unavailable".into());
        }
        unsafe {
            PostMessageW(
                Some(HWND(hwnd as *mut _)),
                WM_COMMAND,
                WPARAM(((THBN_CLICKED as usize) << 16) | id as usize),
                LPARAM(0),
            )
        }
        .map_err(|_| "Could not exercise taskbar command".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn buttons_dispatch_only_known_ids_and_icons_decode() {
        assert_eq!(command(FIRST), Some("like"));
        assert_eq!(command(FIRST + 2), Some("toggle"));
        assert_eq!(command(FIRST + 3), Some("next"));
        assert_eq!(command(FIRST - 1), None);
        assert_eq!(command(FIRST + 4), None);
        assert!(icon_payload(include_bytes!("../../assets/icons/play.ico")).is_some());
        assert!(icon_payload(&[0, 0, 1, 0, 255, 255]).is_none());
    }
    #[test]
    fn stores_playback_and_like_changes_without_an_idle_timer() {
        let taskbar = Taskbar::default();
        taskbar.update(Playback {
            available: true,
            playing: true,
            liked: false,
            russian: false,
        });
        assert_eq!(taskbar.diagnostics()["state"]["playing"], true);
        taskbar.update(Playback {
            available: true,
            playing: false,
            liked: true,
            russian: false,
        });
        assert_eq!(taskbar.diagnostics()["state"]["liked"], true);
        assert_eq!(taskbar.diagnostics()["state"]["playing"], false);
    }
}
