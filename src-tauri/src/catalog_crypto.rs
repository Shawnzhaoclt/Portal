use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const KEY_BYTES: usize = 32;
const KEY_FILE_NAME: &str = "system-catalog.key";
const DPAPI_ENTROPY: &[u8] = b"Charlotte-Mecklenburg StormWaterPortal system catalog v1";

#[derive(Clone)]
pub struct CatalogKey {
    bytes: [u8; KEY_BYTES],
}

impl std::fmt::Debug for CatalogKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CatalogKey")
            .field("id", &self.id())
            .finish_non_exhaustive()
    }
}

impl CatalogKey {
    pub fn hex(&self) -> String {
        self.bytes
            .iter()
            .map(|value| format!("{value:02x}"))
            .collect()
    }

    pub fn id(&self) -> String {
        format!("{:x}", Sha256::digest(self.bytes))
    }

    #[cfg(test)]
    pub fn for_test(value: u8) -> Self {
        Self {
            bytes: [value; KEY_BYTES],
        }
    }
}

pub fn key_path(data_root: &Path) -> PathBuf {
    data_root.join("config").join(KEY_FILE_NAME)
}

#[cfg(target_os = "windows")]
fn random_key() -> Result<[u8; KEY_BYTES], String> {
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };

    let mut key = [0_u8; KEY_BYTES];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            key.as_mut_ptr(),
            key.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(format!(
            "Windows could not generate the system catalog encryption key (NTSTATUS {status:#x})."
        ));
    }
    Ok(key)
}

#[cfg(target_os = "windows")]
fn dpapi_protect(value: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let result = unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            &mut entropy,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 {
        return Err(format!(
            "Windows DPAPI could not protect the system catalog key: {}",
            std::io::Error::last_os_error()
        ));
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(protected)
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(value: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let result = unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            &mut entropy,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 {
        return Err(format!(
            "Windows DPAPI could not unlock the system catalog key for this Windows user: {}",
            std::io::Error::last_os_error()
        ));
    }
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(plaintext)
}

#[cfg(not(target_os = "windows"))]
fn random_key() -> Result<[u8; KEY_BYTES], String> {
    Err("The Desktop system catalog key requires Windows DPAPI.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn dpapi_protect(_value: &[u8]) -> Result<Vec<u8>, String> {
    Err("The Desktop system catalog key requires Windows DPAPI.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn dpapi_unprotect(_value: &[u8]) -> Result<Vec<u8>, String> {
    Err("The Desktop system catalog key requires Windows DPAPI.".to_string())
}

fn decode_key(protected: &[u8], path: &Path) -> Result<CatalogKey, String> {
    let plaintext = dpapi_unprotect(protected)?;
    let bytes: [u8; KEY_BYTES] = plaintext.try_into().map_err(|_| {
        format!(
            "The protected system catalog key has an invalid length: {}",
            path.display()
        )
    })?;
    Ok(CatalogKey { bytes })
}

pub fn load_or_create(data_root: &Path) -> Result<CatalogKey, String> {
    let path = key_path(data_root);
    if path.is_file() {
        return decode_key(
            &fs::read(&path)
                .map_err(|error| format!("Could not read {}: {error}", path.display()))?,
            &path,
        );
    }
    let key = CatalogKey {
        bytes: random_key()?,
    };
    let protected = dpapi_protect(&key.bytes)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(&protected)
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => decode_key(
            &fs::read(&path)
                .map_err(|read_error| format!("Could not read {}: {read_error}", path.display()))?,
            &path,
        ),
        Err(error) => Err(format!("Could not create {}: {error}", path.display())),
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::{env, process, time::SystemTime};

    #[test]
    fn dpapi_round_trip_preserves_catalog_key() {
        let key = random_key().expect("random key");
        let protected = dpapi_protect(&key).expect("protect key");
        assert_ne!(protected, key);
        assert_eq!(dpapi_unprotect(&protected).expect("unprotect key"), key);
    }

    #[test]
    fn protected_key_file_reloads_for_the_same_windows_user() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = env::temp_dir().join(format!("portal-catalog-key-{}-{unique}", process::id()));
        let first = load_or_create(&root).expect("create protected key");
        let protected = fs::read(key_path(&root)).expect("protected key file");
        assert_ne!(protected, first.bytes);
        let second = load_or_create(&root).expect("reload protected key");
        assert_eq!(first.id(), second.id());
        fs::remove_dir_all(root).expect("cleanup");
    }
}
