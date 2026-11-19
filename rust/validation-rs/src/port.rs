//! Track metadata validation shared by the Android host.
#![forbid(unsafe_code)]
use serde_json::{Value, json};

fn whitespace(unit: u16) -> bool {
    matches!(unit, 9..=13 | 32 | 160 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

pub fn clean_track_string(value: Value, max_length: f64) -> Result<Value, String> {
    let Some(mut units) = crate::js::string_units(&value) else {
        return Ok(json!(""));
    };
    units.retain(|unit| *unit >= 32 && *unit != 127);
    let start = units
        .iter()
        .position(|unit| !whitespace(*unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !whitespace(*unit))
        .map_or(start, |end| end + 1);
    let units = &units[start..end];
    let length = if max_length.is_nan() {
        0
    } else if max_length < 0.0 {
        (units.len() as f64 + max_length.trunc()).clamp(0.0, units.len() as f64) as usize
    } else {
        max_length.trunc().min(units.len() as f64) as usize
    };
    Ok(crate::js::utf16_string(&units[..length]))
}

pub fn clean_track_url(value: Value) -> Result<String, String> {
    let raw = clean_track_string(value, 2048.0)?;
    let units = crate::js::string_units(&raw).unwrap_or_default();
    let text = String::from_utf16_lossy(&units);
    Ok(url::Url::parse(&text)
        .ok()
        .filter(|url| url.scheme() == "https")
        .map(|url| url.to_string())
        .unwrap_or_default())
}

pub fn validate_track_info(data: Value) -> Result<Option<Value>, String> {
    if !data.is_object()
        || crate::js::is_undefined(&data)
        || crate::js::as_number(&data).is_some()
        || crate::js::string_units(&data).is_some()
    {
        return Ok(None);
    }
    let mut result = serde_json::Map::new();
    for (key, length) in [("title", 300.0), ("author", 200.0)] {
        result.insert(key.into(), clean_track_string(data[key].clone(), length)?);
    }
    result.insert(
        "artwork".into(),
        json!(clean_track_url(data["artwork"].clone())?),
    );
    for key in ["elapsed", "duration"] {
        result.insert(key.into(), clean_track_string(data[key].clone(), 32.0)?);
    }
    for key in ["isPlaying", "isLiked"] {
        result.insert(key.into(), json!(data[key].as_bool().unwrap_or(false)));
    }
    result.insert("url".into(), json!(clean_track_url(data["url"].clone())?));
    Ok(Some(Value::Object(result)))
}

pub fn validate_track_update_payload(payload: Value) -> Result<Option<Value>, String> {
    if !payload.is_object() {
        return Ok(None);
    }
    let Some(data) = validate_track_info(payload["data"].clone())? else {
        return Ok(None);
    };
    let reason = payload["reason"]
        .as_str()
        .filter(|reason| {
            matches!(
                *reason,
                "playback-state-change"
                    | "track-change"
                    | "seek-change"
                    | "initial-state"
                    | "waveform-seek"
                    | "timeline-seek"
            )
        })
        .unwrap_or("track-change");
    Ok(Some(json!({"data":data, "reason":reason})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_utf16_boundaries_and_ecmascript_whitespace() {
        assert_eq!(
            clean_track_string(json!("  A😀B  "), 2.0).unwrap(),
            json!({"$utf16":[65,55357]})
        );
        assert_eq!(
            clean_track_string(json!("\u{0085}x\u{feff}"), -1.0).unwrap(),
            json!("\u{0085}")
        );
        assert_eq!(
            clean_track_url(json!("HTTPS://SOUNDCLOUD.COM:443/a/b")).unwrap(),
            "https://soundcloud.com/a/b"
        );
    }
}
