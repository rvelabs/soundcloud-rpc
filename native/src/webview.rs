use crate::catalog::Catalog;
use std::sync::Arc;
use tauri::WebviewWindow;
use webview2_com::{
    AcceleratorKeyPressedEventHandler, Microsoft::Web::WebView2::Win32::*,
    WebResourceRequestedEventHandler, take_pwstr,
};
use windows::core::{PWSTR, w};

pub fn observe(window: &WebviewWindow, catalog: Arc<Catalog>) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let core = webview.controller().CoreWebView2()?;
                core.AddWebResourceRequestedFilter(
                    w!("https://api-v2.soundcloud.com/*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                )?;
                core.AddWebResourceRequestedFilter(
                    w!("https://api-auth.soundcloud.com/sign-out*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                )?;
                core.AddWebResourceRequestedFilter(
                    w!("https://api.soundcloud.com/sign-out*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                )?;
                let mut token = 0;
                core.add_WebResourceRequested(
                    &WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                        if let (Some(sender), Some(args)) = (sender, args) {
                            let mut source = PWSTR::null();
                            sender.Source(&mut source)?;
                            let source = take_pwstr(source);
                            if !source.starts_with("https://soundcloud.com/") {
                                return Ok(());
                            }
                            let request = args.Request()?;
                            let mut uri = PWSTR::null();
                            request.Uri(&mut uri)?;
                            let uri = take_pwstr(uri);
                            if uri.contains("/sign-out") {
                                catalog.reset();
                                return Ok(());
                            }
                            let headers = request.Headers()?;
                            let mut value = PWSTR::null();
                            let authorization =
                                if headers.GetHeader(w!("Authorization"), &mut value).is_ok() {
                                    take_pwstr(value)
                                } else {
                                    String::new()
                                };
                            catalog.observe(&uri, &authorization);
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
                Ok(())
            })()
        };
        if let Err(error) = result {
            eprintln!("WebView2 request observer failed: {error}");
        }
    })
}

pub fn accelerators(window: &tauri::Webview, app: tauri::AppHandle) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let mut token = 0;
                webview.controller().add_AcceleratorKeyPressed(
                    &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut key = 0;
                            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP;
                            args.VirtualKey(&mut key)?;
                            args.KeyEventKind(&mut kind)?;
                            if key == 0x70
                                && [
                                    COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
                                    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
                                ]
                                .contains(&kind)
                            {
                                args.SetHandled(true)?;
                                let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                                args.PhysicalKeyStatus(&mut status)?;
                                if status.WasKeyDown.as_bool() {
                                    return Ok(());
                                }
                                let app = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = crate::show_settings(&app).await;
                                });
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
                Ok(())
            })()
        };
        if result.is_err() {
            eprintln!("Native settings keyboard shortcut could not be installed");
        }
    })
}
