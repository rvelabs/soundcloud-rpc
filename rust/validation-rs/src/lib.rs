//! JS bindings for `src/validation.ts`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use wasm_bindgen::prelude::*;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;
pub mod utf16;

/// `cleanTrackString`.
fn clean_track_string_inner(value: String, max_length: f64) -> Result<String, String> {
    let value = crate::js::from_json(&value)?;
    let out = port::clean_track_string(value, max_length)?;
    crate::js::to_json(&out)
}

#[wasm_bindgen(js_name = "cleanTrackString")]
pub fn clean_track_string(value: String, max_length: f64) -> Result<String, JsError> {
    clean_track_string_inner(value, max_length).map_err(|e| JsError::new(&e))
}

/// `cleanTrackUrl`.
fn clean_track_url_inner(value: String) -> Result<String, String> {
    let value = crate::js::from_json(&value)?;
    let out = port::clean_track_url(value)?;
    Ok(out)
}

#[wasm_bindgen(js_name = "cleanTrackUrl")]
pub fn clean_track_url(value: String) -> Result<String, JsError> {
    clean_track_url_inner(value).map_err(|e| JsError::new(&e))
}

/// `validateTrackInfo`.
fn validate_track_info_inner(data: String) -> Result<String, String> {
    let data = crate::js::from_json(&data)?;
    let out = port::validate_track_info(data)?;
    crate::js::to_json(&out)
}

#[wasm_bindgen(js_name = "validateTrackInfo")]
pub fn validate_track_info(data: String) -> Result<String, JsError> {
    validate_track_info_inner(data).map_err(|e| JsError::new(&e))
}

/// `validateTrackUpdatePayload`.
fn validate_track_update_payload_inner(payload: String) -> Result<String, String> {
    let payload = crate::js::from_json(&payload)?;
    let out = port::validate_track_update_payload(payload)?;
    crate::js::to_json(&out)
}

#[wasm_bindgen(js_name = "validateTrackUpdatePayload")]
pub fn validate_track_update_payload(payload: String) -> Result<String, JsError> {
    validate_track_update_payload_inner(payload).map_err(|e| JsError::new(&e))
}

// ---- the binary wire ------------------------------------------------------------------------

thread_local! {
    static WIRE_IN: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    static WIRE_OUT: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// This module's memory, where `index.cjs` reads and writes the wire buffers.
#[wasm_bindgen(js_name = "rustAnythingWireMemory")]
pub fn rust_anything_wire_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// The address of an argument buffer of `len` bytes.
#[wasm_bindgen(js_name = "rustAnythingWireIn")]
pub fn rust_anything_wire_in(len: u32) -> u32 {
    WIRE_IN.with(|b| {
        let mut b = b.borrow_mut();
        b.resize(len as usize, 0);
        b.as_mut_ptr() as usize as u32
    })
}

/// The address of the last result.
#[wasm_bindgen(js_name = "rustAnythingWireOut")]
pub fn rust_anything_wire_out() -> u32 {
    WIRE_OUT.with(|b| b.borrow().as_ptr() as usize as u32)
}

/// Reads `len` argument bytes, runs `f`, and keeps its result for `rustAnythingWireOut`.
fn wire_io(
    len: u32,
    f: impl FnOnce(&mut wire::Reader, &mut wire::Writer) -> Result<(), String>,
) -> Result<u32, JsError> {
    let input = WIRE_IN.with(|b| std::mem::take(&mut *b.borrow_mut()));
    let mut w = wire::Writer::default();
    let result = f(
        &mut wire::Reader::new(&input[..(len as usize).min(input.len())]),
        &mut w,
    );
    WIRE_IN.with(|b| *b.borrow_mut() = input);
    match result {
        // A result of another shape than the TS type: JS runs the call through JSON.
        Err(e) if e.starts_with(wire::MISMATCH) => return Ok(u32::MAX),
        other => other.map_err(|e| JsError::new(&e))?,
    }
    let n = w.0.len();
    WIRE_OUT.with(|b| *b.borrow_mut() = w.0);
    Ok(u32::try_from(n).unwrap_or(u32::MAX))
}

static S_CLEAN_TRACK_STRING_0: wire::Schema = wire::Schema::Dyn;
static S_CLEAN_TRACK_STRING_OUT: wire::Schema = wire::Schema::Str16;

/// `cleanTrackString` over the binary wire.
#[wasm_bindgen(js_name = "cleanTrackStringWire")]
pub fn clean_track_string_wire(len: u32) -> Result<u32, JsError> {
    wire_io(len, |r, w| {
        let value: Value = wire::read_value(r, &S_CLEAN_TRACK_STRING_0)?;
        let max_length: f64 = r.f64()?;
        let out = &port::clean_track_string(value, max_length)?;
        wire::write_value(w, out, &S_CLEAN_TRACK_STRING_OUT)?;
        Ok(())
    })
}

static S_CLEAN_TRACK_URL_0: wire::Schema = wire::Schema::Dyn;

/// `cleanTrackUrl` over the binary wire.
#[wasm_bindgen(js_name = "cleanTrackUrlWire")]
pub fn clean_track_url_wire(len: u32) -> Result<u32, JsError> {
    wire_io(len, |r, w| {
        let value: Value = wire::read_value(r, &S_CLEAN_TRACK_URL_0)?;
        let out = &port::clean_track_url(value)?;
        w.string16(out);
        Ok(())
    })
}

static S_VALIDATE_TRACK_INFO_0: wire::Schema = wire::Schema::Dyn;
static S_VALIDATE_TRACK_INFO_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("title", wire::Schema::Str16),
    ("author", wire::Schema::Str16),
    ("artwork", wire::Schema::Str16),
    ("elapsed", wire::Schema::Str16),
    ("duration", wire::Schema::Str16),
    ("isPlaying", wire::Schema::Bool),
    ("isLiked", wire::Schema::Bool),
    ("url", wire::Schema::Str16),
]));

/// `validateTrackInfo` over the binary wire.
#[wasm_bindgen(js_name = "validateTrackInfoWire")]
pub fn validate_track_info_wire(len: u32) -> Result<u32, JsError> {
    wire_io(len, |r, w| {
        let data: Value = wire::read_value(r, &S_VALIDATE_TRACK_INFO_0)?;
        let out = &port::validate_track_info(data)?;
        match out {
            Some(x0) => {
                w.tag(1);
                wire::write_value(w, x0, S_VALIDATE_TRACK_INFO_OUT.inner())?;
            }
            None => w.tag(2),
        }
        Ok(())
    })
}

static S_VALIDATE_TRACK_UPDATE_PAYLOAD_0: wire::Schema = wire::Schema::Dyn;
static S_VALIDATE_TRACK_UPDATE_PAYLOAD_OUT: wire::Schema =
    wire::Schema::OptJs(&wire::Schema::Obj(&[
        (
            "data",
            wire::Schema::Obj(&[
                ("title", wire::Schema::Str16),
                ("author", wire::Schema::Str16),
                ("artwork", wire::Schema::Str16),
                ("elapsed", wire::Schema::Str16),
                ("duration", wire::Schema::Str16),
                ("isPlaying", wire::Schema::Bool),
                ("isLiked", wire::Schema::Bool),
                ("url", wire::Schema::Str16),
            ]),
        ),
        ("reason", wire::Schema::Str16),
    ]));

/// `validateTrackUpdatePayload` over the binary wire.
#[wasm_bindgen(js_name = "validateTrackUpdatePayloadWire")]
pub fn validate_track_update_payload_wire(len: u32) -> Result<u32, JsError> {
    wire_io(len, |r, w| {
        let payload: Value = wire::read_value(r, &S_VALIDATE_TRACK_UPDATE_PAYLOAD_0)?;
        let out = &port::validate_track_update_payload(payload)?;
        match out {
            Some(x0) => {
                w.tag(1);
                wire::write_value(w, x0, S_VALIDATE_TRACK_UPDATE_PAYLOAD_OUT.inner())?;
            }
            None => w.tag(2),
        }
        Ok(())
    })
}
