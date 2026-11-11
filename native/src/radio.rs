use std::collections::BTreeMap;

pub fn validate(path: &str, params: &BTreeMap<String, String>) -> Result<(), String> {
    let parts: Vec<_> = path.split('/').collect();
    let id = |text: &str| {
        text.parse::<u64>()
            .is_ok_and(|value| value > 0 && value < (1u64 << 53) && value.to_string() == text)
    };
    let allowed = match parts.as_slice() {
        ["", "me", "track_likes" | "playlist_likes", "ids"]
        | ["", "me", "mutings", "users", "ids"]
        | ["", "me", "play-history", "tracks"]
        | ["", "mixed-selections"]
        | ["", "stream"] => true,
        ["", "tracks", track, "related" | "playlists_without_albums"] => id(track),
        ["", "stations", urn, "tracks"] => urn
            .strip_prefix("soundcloud%3Atrack-stations%3A")
            .is_some_and(id),
        ["", "users", owner, "playlists" | "toptracks"] => id(owner),
        ["", "playlists", playlist] => id(playlist),
        ["", "system-playlists", urn] => urn
            .strip_prefix("soundcloud%3Asystem-playlists%3A")
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 160
                    && suffix
                        .replace("%3A", ":")
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_:-".contains(&c))
            }),
        _ => false,
    };
    if !allowed {
        return Err("Unsupported recommendation source".into());
    }
    for (key, value) in params {
        let valid = match key.as_str() {
            "limit" => value
                .parse::<u32>()
                .is_ok_and(|limit| (1..=200).contains(&limit)),
            "linked_partitioning" => value == "1",
            "representation" => value == "mini",
            "offset" | "cursor" => {
                !value.is_empty() && value.len() <= 2048 && !value.chars().any(char::is_control)
            }
            _ => false,
        };
        if !valid {
            return Err("Invalid recommendation pagination".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_bounded_read_sources_and_opaque_cursors() {
        let query = BTreeMap::from([
            ("limit".into(), "200".into()),
            ("offset".into(), "2026-11-01T12:30:00.000Z,7".into()),
        ]);
        for path in [
            "/me/track_likes/ids",
            "/me/mutings/users/ids",
            "/me/play-history/tracks",
            "/me/playlist_likes/ids",
            "/mixed-selections",
            "/stream",
            "/tracks/7/related",
            "/stations/soundcloud%3Atrack-stations%3A7/tracks",
            "/tracks/7/playlists_without_albums",
            "/playlists/12",
            "/users/2/playlists",
            "/users/2/toptracks",
            "/system-playlists/soundcloud%3Asystem-playlists%3Adiscover-12",
        ] {
            assert!(validate(path, &query).is_ok(), "{path}");
        }
    }

    #[test]
    fn rejects_other_routes_credentials_and_unbounded_queries() {
        for path in [
            "https://evil.test/me",
            "//evil.test/me",
            "/me",
            "/me/emails",
            "/tracks/0/related",
            "/tracks/01/related",
            "/stations/soundcloud%3Atrack-stations%3A07/tracks",
            "/stations/soundcloud%3Auser-stations%3A7/tracks",
            "/users/1/playlists?x=y",
            "/playlists/1/../2",
            "/system-playlists/soundcloud%3Asystem-playlists%3A..%2Fme",
        ] {
            assert!(validate(path, &BTreeMap::new()).is_err(), "{path}");
        }
        for (key, value) in [
            ("limit", "10000"),
            ("client_id", "stolen"),
            ("access_token", "x"),
            ("cursor", "\r\n"),
        ] {
            assert!(
                validate(
                    "/tracks/7/related",
                    &BTreeMap::from([(key.into(), value.into())])
                )
                .is_err()
            );
        }
    }
}
