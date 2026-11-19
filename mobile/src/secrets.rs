use std::path::Path;

pub fn save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    crate::host::secret(path, Some(bytes)).map(|_| ())
}

pub fn load(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    crate::host::secret(path, None).map(Some)
}
