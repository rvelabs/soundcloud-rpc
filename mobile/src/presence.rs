use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Track {
    pub title: String,
    pub author: String,
    pub url: String,
    pub artwork: String,
    pub playing: bool,
    pub elapsed: f64,
    pub duration: f64,
}

impl Track {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.title.len() > 1200 || self.author.len() > 1200 || self.artwork.len() > 2048
            || !crate::catalog::track_url(&self.url)
            || !self.elapsed.is_finite() || !self.duration.is_finite()
            || !(0.0..=86400.0).contains(&self.elapsed)
            || !(0.0..=86400.0).contains(&self.duration)
            || (self.duration > 0.0 && self.elapsed > self.duration + 10.0)
        {
            return Err("Invalid Android playback metadata".into());
        }
        Ok(())
    }
}
