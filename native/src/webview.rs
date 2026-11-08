use crate::catalog::Catalog;
use std::sync::Arc;
use tauri::WebviewWindow;
use webview2_com::{
    AcceleratorKeyPressedEventHandler, Microsoft::Web::WebView2::Win32::*,
    WebResourceRequestedEventHandler, take_pwstr,
};
use windows::{
    Win32::UI::Shell::SHCreateMemStream,
    core::{HSTRING, Interface, PWSTR, w},
};

fn response(
    environment: &ICoreWebView2Environment,
    bytes: &[u8],
    status: i32,
    mime: &str,
) -> windows::core::Result<ICoreWebView2WebResourceResponse> {
    unsafe {
        let stream = SHCreateMemStream(Some(bytes));
        environment.CreateWebResourceResponse(stream.as_ref(), status, w!("Filtered"), &HSTRING::from(format!("Content-Type: {mime}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nContent-Length: {}\r\n", bytes.len())))
    }
}
fn resource_type(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
    match context {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "document",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH
        | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST => "xmlhttprequest",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        _ => "other",
    }
}

pub fn observe(
    window: &WebviewWindow,
    catalog: Arc<Catalog>,
    blocker: Arc<crate::adblock::AdBlock>,
    smoke: bool,
) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let core = webview.controller().CoreWebView2()?;
                let environment = core.cast::<ICoreWebView2_2>()?.Environment()?;
                for pattern in [w!("https://*"), w!("http://*")] {
                    if let Ok(modern) = core.cast::<ICoreWebView2_22>() {
                        modern.AddWebResourceRequestedFilterWithRequestSourceKinds(
                            pattern,
                            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                        )?;
                    } else {
                        core.AddWebResourceRequestedFilter(
                            pattern,
                            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                        )?;
                    }
                }
                let mut token = 0;
                let filtering = blocker.clone();
                core.add_WebResourceRequested(
                    &WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                        if let (Some(sender), Some(args)) = (sender, args) {
                            let mut source = PWSTR::null();
                            sender.Source(&mut source)?;
                            let source = take_pwstr(source);
                            let request = args.Request()?;
                            let mut uri = PWSTR::null();
                            request.Uri(&mut uri)?;
                            let uri = take_pwstr(uri);
                            let parsed = url::Url::parse(&uri).ok();
                            let fixture = smoke
                                && parsed.as_ref().is_some_and(|url| {
                                    url.path() == "/__native_adblock_fixture"
                                        || url
                                            .query_pairs()
                                            .any(|(key, _)| key == "__native_adblock_fixture")
                                });
                            let mut method = PWSTR::null();
                            request.Method(&mut method)?;
                            let method = take_pwstr(method);
                            let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER;
                            args.ResourceContext(&mut context)?;
                            let mut kind = resource_type(context);
                            if kind == "document" {
                                let mut destination = PWSTR::null();
                                if request
                                    .Headers()?
                                    .GetHeader(w!("Sec-Fetch-Dest"), &mut destination)
                                    .is_ok()
                                    && take_pwstr(destination) == "iframe"
                                {
                                    kind = "subdocument";
                                }
                            }
                            let decision = filtering.decide(
                                &uri,
                                if fixture {
                                    "https://soundcloud.com/__native_adblock_fixture"
                                } else {
                                    &source
                                },
                                kind,
                                &method,
                            );
                            match decision {
                                crate::adblock::Decision::Empty => {
                                    args.SetResponse(&response(
                                        &environment,
                                        &[],
                                        204,
                                        "text/plain",
                                    )?)?;
                                    return Ok(());
                                }
                                crate::adblock::Decision::SilentAudio => {
                                    args.SetResponse(&response(
                                        &environment,
                                        &crate::adblock::silence(),
                                        200,
                                        "audio/wav",
                                    )?)?;
                                    return Ok(());
                                }
                                crate::adblock::Decision::Allow => {}
                            }
                            if fixture {
                                let document = parsed
                                    .as_ref()
                                    .is_some_and(|url| url.path() == "/__native_adblock_fixture");
                                let (body, mime) = if document {
                                    (
                                        include_bytes!("../assets/adblock-fixture.html").to_vec(),
                                        "text/html",
                                    )
                                } else if kind == "media" {
                                    (crate::adblock::silence(), "audio/wav")
                                } else {
                                    (b"{\"fixture\":true,\"id\":7}".to_vec(), "application/json")
                                };
                                args.SetResponse(&response(&environment, &body, 200, mime)?)?;
                                return Ok(());
                            }
                            if !source.starts_with("https://soundcloud.com/") {
                                return Ok(());
                            }
                            let Some(parsed) = parsed else {
                                return Ok(());
                            };
                            let host = parsed.host_str().unwrap_or("");
                            if [
                                "api-auth.soundcloud.com",
                                "api.soundcloud.com",
                                "api-v2.soundcloud.com",
                            ]
                            .contains(&host)
                                && parsed.path() == "/sign-out"
                            {
                                catalog.reset();
                                return Ok(());
                            }
                            if host != "api-v2.soundcloud.com" {
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
                blocker.attached(true);
                Ok(())
            })()
        };
        if let Err(error) = result {
            blocker.attached(false);
            eprintln!("WebView2 request observer failed: {error}");
        }
        if !smoke {
            let navigation = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.Navigate(w!("https://soundcloud.com/")))
            };
            if let Err(error) = navigation {
                eprintln!("SoundCloud initial navigation failed: {error}");
            }
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
