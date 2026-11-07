use std::path::Path;
use windows::{
    Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    },
    core::PCWSTR,
};

pub fn save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "Could not encrypt native settings")?;
        let encrypted = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut _,
        )));
        let temporary = path.with_extension("dat.tmp");
        let mut file =
            std::fs::File::create(&temporary).map_err(|_| "Could not save encrypted settings")?;
        use std::io::Write;
        file.write_all(&encrypted)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save encrypted settings")?;
        drop(file);
        crate::storage::replace(&temporary, path)
            .map_err(|_| "Could not commit encrypted settings".to_string())
    }
}

pub fn load(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read native connection settings".into()),
    };
    unprotect(&bytes).map(Some)
}

pub(crate) fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > 16000 {
        return Err("Invalid encrypted settings".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "Windows could not decrypt connection settings")?;
        let decrypted = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut _,
        )));
        Ok(decrypted)
    }
}
