use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

#[derive(Clone, Debug)]
pub(crate) struct BusinessSyncPaths {
    pub network_root: PathBuf,
    pub master_manifest: PathBuf,
    pub master_versions_root: PathBuf,
    pub submission_inbox_root: PathBuf,
    pub submission_processed_root: PathBuf,
    pub submission_rejected_root: PathBuf,
    pub conflict_open_root: PathBuf,
    pub conflict_resolved_root: PathBuf,
    pub conflict_archive_root: PathBuf,
    pub lock_root: PathBuf,
    pub backup_root: PathBuf,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BusinessMasterManifest {
    schema_version: u32,
    database_version: String,
    database_file: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    published_by: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalMasterSource<'a> {
    schema_version: u32,
    database_version: &'a str,
    database_file: &'a str,
    sha256: &'a str,
    published_at: &'a str,
    published_by: &'a str,
    downloaded_at_unix: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BusinessSyncStatus {
    pub configured: bool,
    pub network_available: bool,
    pub manifest_available: bool,
    pub local_database_exists: bool,
    pub local_database: String,
    pub network_root: String,
    pub master_manifest: String,
    pub master_version: Option<String>,
    pub master_database: Option<String>,
    pub message: String,
}

fn setting<'a>(payload: &'a serde_json::Value, section: &str, name: &str) -> Option<&'a str> {
    payload.get(section)?.get(name)?.as_str().map(str::trim)
}

fn expand_path(
    value: &str,
    app_root: &Path,
    data_root: &Path,
    shared_root: &str,
    network_root: &str,
) -> PathBuf {
    let expanded = value
        .replace("${PORTAL_APP_ROOT}", &app_root.to_string_lossy())
        .replace("${PORTAL_DATA_ROOT}", &data_root.to_string_lossy())
        .replace("${PORTAL_SHARED_DATA_ROOT}", shared_root)
        .replace("${PORTAL_BUSINESS_NETWORK_ROOT}", network_root);
    PathBuf::from(expanded)
}

pub(crate) fn load_paths(
    config_path: &Path,
    app_root: &Path,
    data_root: &Path,
) -> Result<Option<BusinessSyncPaths>, String> {
    let content = fs::read_to_string(config_path)
        .map_err(|error| format!("Could not read {}: {error}", config_path.display()))?;
    let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Portal settings are invalid at {}: {error}",
            config_path.display()
        )
    })?;
    let configured_root = env::var("PORTAL_BUSINESS_NETWORK_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| setting(&payload, "businessSync", "networkRoot").map(str::to_string));
    let Some(network_root_value) = configured_root else {
        return Ok(None);
    };
    let shared_root = env::var("PORTAL_SHARED_DATA_ROOT")
        .ok()
        .or_else(|| setting(&payload, "shared", "dataRoot").map(str::to_string))
        .unwrap_or_default();
    let network_root = expand_path(
        &network_root_value,
        app_root,
        data_root,
        &shared_root,
        &network_root_value,
    );
    let path = |name: &str, fallback: &str| {
        let raw = setting(&payload, "businessSync", name).unwrap_or(fallback);
        expand_path(
            raw,
            app_root,
            data_root,
            &shared_root,
            &network_root.to_string_lossy(),
        )
    };
    Ok(Some(BusinessSyncPaths {
        network_root: network_root.clone(),
        master_manifest: path(
            "masterManifest",
            "${PORTAL_BUSINESS_NETWORK_ROOT}/master/current.json",
        ),
        master_versions_root: path(
            "masterVersionsRoot",
            "${PORTAL_BUSINESS_NETWORK_ROOT}/master/versions",
        ),
        submission_inbox_root: path(
            "submissionInboxRoot",
            "${PORTAL_BUSINESS_NETWORK_ROOT}/submissions/inbox",
        ),
        submission_processed_root: path(
            "submissionProcessedRoot",
            "${PORTAL_BUSINESS_NETWORK_ROOT}/submissions/processed",
        ),
        submission_rejected_root: path(
            "submissionRejectedRoot",
            "${PORTAL_BUSINESS_NETWORK_ROOT}/submissions/rejected",
        ),
        conflict_open_root: path(
            "conflictOpenRoot",
            "${PORTAL_BUSINESS_NETWORK_ROOT}/conflicts/open",
        ),
        conflict_resolved_root: path(
            "conflictResolvedRoot",
            "${PORTAL_BUSINESS_NETWORK_ROOT}/conflicts/resolved",
        ),
        conflict_archive_root: path(
            "conflictArchiveRoot",
            "${PORTAL_BUSINESS_NETWORK_ROOT}/conflicts/archive",
        ),
        lock_root: path("lockRoot", "${PORTAL_BUSINESS_NETWORK_ROOT}/locks"),
        backup_root: path("backupRoot", "${PORTAL_BUSINESS_NETWORK_ROOT}/backups"),
    }))
}

fn read_manifest(path: &Path) -> Result<BusinessMasterManifest, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "Could not read business master manifest {}: {error}",
            path.display()
        )
    })?;
    let manifest: BusinessMasterManifest = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Business master manifest is invalid at {}: {error}",
            path.display()
        )
    })?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "Business master manifest {} uses unsupported schema version {}.",
            path.display(),
            manifest.schema_version
        ));
    }
    if manifest.database_file.trim().is_empty() {
        return Err(format!(
            "Business master manifest {} has no database file.",
            path.display()
        ));
    }
    Ok(manifest)
}

fn master_database_path(
    paths: &BusinessSyncPaths,
    manifest: &BusinessMasterManifest,
) -> Result<PathBuf, String> {
    let relative = Path::new(&manifest.database_file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("The business master database file must be a safe relative path.".to_string());
    }
    let versions_root = paths.master_versions_root.canonicalize().map_err(|error| {
        format!(
            "Could not access master versions folder {}: {error}",
            paths.master_versions_root.display()
        )
    })?;
    let source = versions_root
        .join(relative)
        .canonicalize()
        .map_err(|error| {
            format!(
                "Could not access published business database {}: {error}",
                versions_root.join(relative).display()
            )
        })?;
    if !source.starts_with(&versions_root) || !source.is_file() {
        return Err(
            "The published business database is outside the configured versions folder."
                .to_string(),
        );
    }
    Ok(source)
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| {
        format!(
            "Could not open {} for verification: {error}",
            path.display()
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not verify {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn verify_sqlite(path: &Path) -> Result<(), String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut header = [0_u8; 16];
    file.read_exact(&mut header).map_err(|error| {
        format!(
            "Could not read SQLite header from {}: {error}",
            path.display()
        )
    })?;
    if &header != SQLITE_HEADER {
        return Err(format!(
            "Published business database is not a valid SQLite file: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn initialize_from_master(
    paths: &BusinessSyncPaths,
    local_database: &Path,
) -> Result<bool, String> {
    if local_database.exists() || !paths.master_manifest.is_file() {
        return Ok(false);
    }
    let manifest = read_manifest(&paths.master_manifest)?;
    let source = master_database_path(paths, &manifest)?;
    verify_sqlite(&source)?;
    if !manifest.sha256.trim().is_empty() {
        let actual = sha256(&source)?;
        if !actual.eq_ignore_ascii_case(manifest.sha256.trim()) {
            return Err(format!(
                "Checksum mismatch for published business database {}.",
                source.display()
            ));
        }
    }
    let parent = local_database
        .parent()
        .ok_or_else(|| "Local business database has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let staging = parent.join("business.db.download");
    if staging.exists() {
        fs::remove_file(&staging)
            .map_err(|error| format!("Could not clear {}: {error}", staging.display()))?;
    }
    fs::copy(&source, &staging).map_err(|error| {
        format!(
            "Could not download {} to {}: {error}",
            source.display(),
            staging.display()
        )
    })?;
    verify_sqlite(&staging)?;
    fs::rename(&staging, local_database).map_err(|error| {
        format!(
            "Could not activate local business database {}: {error}",
            local_database.display()
        )
    })?;
    let downloaded_at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let source_record = LocalMasterSource {
        schema_version: manifest.schema_version,
        database_version: &manifest.database_version,
        database_file: &manifest.database_file,
        sha256: &manifest.sha256,
        published_at: &manifest.published_at,
        published_by: &manifest.published_by,
        downloaded_at_unix,
    };
    let record = serde_json::to_vec_pretty(&source_record)
        .map_err(|error| format!("Could not record business master source: {error}"))?;
    fs::write(parent.join("master-source.json"), record)
        .map_err(|error| format!("Could not write local master source metadata: {error}"))?;
    Ok(true)
}

pub(crate) fn status(
    paths: Option<&BusinessSyncPaths>,
    local_database: &Path,
) -> BusinessSyncStatus {
    let Some(paths) = paths else {
        return BusinessSyncStatus {
            configured: false,
            network_available: false,
            manifest_available: false,
            local_database_exists: local_database.is_file(),
            local_database: local_database.display().to_string(),
            network_root: String::new(),
            master_manifest: String::new(),
            master_version: None,
            master_database: None,
            message: "Business synchronization is not configured.".to_string(),
        };
    };
    let network_available = paths.network_root.is_dir();
    let manifest_available = paths.master_manifest.is_file();
    let manifest = if manifest_available {
        read_manifest(&paths.master_manifest).ok()
    } else {
        None
    };
    let master_version = manifest
        .as_ref()
        .map(|value| value.database_version.clone());
    let master_database = manifest
        .as_ref()
        .and_then(|value| master_database_path(paths, value).ok())
        .map(|value| value.display().to_string());
    let message = if !network_available {
        "The configured network data root is unavailable. Local data remains usable."
    } else if !manifest_available {
        "The network data root is available, but no business master has been published yet."
    } else if master_database.is_none() {
        "The business master manifest exists, but its database is unavailable or invalid."
    } else {
        "The published business master is available."
    };
    BusinessSyncStatus {
        configured: true,
        network_available,
        manifest_available,
        local_database_exists: local_database.is_file(),
        local_database: local_database.display().to_string(),
        network_root: paths.network_root.display().to_string(),
        master_manifest: paths.master_manifest.display().to_string(),
        master_version,
        master_database,
        message: message.to_string(),
    }
}

pub(crate) fn environment(paths: &BusinessSyncPaths) -> [(&'static str, &Path); 11] {
    [
        ("PORTAL_BUSINESS_NETWORK_ROOT", &paths.network_root),
        ("PORTAL_BUSINESS_MASTER_MANIFEST", &paths.master_manifest),
        (
            "PORTAL_BUSINESS_MASTER_VERSIONS_ROOT",
            &paths.master_versions_root,
        ),
        ("PORTAL_SUBMISSION_INBOX_ROOT", &paths.submission_inbox_root),
        (
            "PORTAL_SUBMISSION_PROCESSED_ROOT",
            &paths.submission_processed_root,
        ),
        (
            "PORTAL_SUBMISSION_REJECTED_ROOT",
            &paths.submission_rejected_root,
        ),
        ("PORTAL_CONFLICT_OPEN_ROOT", &paths.conflict_open_root),
        (
            "PORTAL_CONFLICT_RESOLVED_ROOT",
            &paths.conflict_resolved_root,
        ),
        ("PORTAL_CONFLICT_ARCHIVE_ROOT", &paths.conflict_archive_root),
        ("PORTAL_MERGE_LOCK_ROOT", &paths.lock_root),
        ("PORTAL_NETWORK_BACKUP_ROOT", &paths.backup_root),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        env::temp_dir().join(format!("portal-{name}-{}-{nonce}", std::process::id()))
    }

    fn test_paths(root: &Path) -> BusinessSyncPaths {
        BusinessSyncPaths {
            network_root: root.to_path_buf(),
            master_manifest: root.join("master").join("current.json"),
            master_versions_root: root.join("master").join("versions"),
            submission_inbox_root: root.join("submissions").join("inbox"),
            submission_processed_root: root.join("submissions").join("processed"),
            submission_rejected_root: root.join("submissions").join("rejected"),
            conflict_open_root: root.join("conflicts").join("open"),
            conflict_resolved_root: root.join("conflicts").join("resolved"),
            conflict_archive_root: root.join("conflicts").join("archive"),
            lock_root: root.join("locks"),
            backup_root: root.join("backups"),
        }
    }

    #[test]
    fn initializes_a_missing_local_database_from_the_published_master() {
        let root = test_root("master-copy");
        let paths = test_paths(&root);
        fs::create_dir_all(&paths.master_versions_root).unwrap();
        let source = paths.master_versions_root.join("business_000001.db");
        fs::write(&source, [SQLITE_HEADER.as_slice(), b"test-body"].concat()).unwrap();
        let manifest = BusinessMasterManifest {
            schema_version: 1,
            database_version: "000001".to_string(),
            database_file: "business_000001.db".to_string(),
            sha256: sha256(&source).unwrap(),
            published_at: "2026-07-20T20:00:00Z".to_string(),
            published_by: "test".to_string(),
        };
        fs::write(
            &paths.master_manifest,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let local = root.join("client").join("business.db");

        assert!(initialize_from_master(&paths, &local).unwrap());
        assert_eq!(fs::read(&local).unwrap(), fs::read(&source).unwrap());
        assert!(local.parent().unwrap().join("master-source.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn never_replaces_an_existing_local_database() {
        let root = test_root("existing-local");
        let paths = test_paths(&root);
        let local = root.join("client").join("business.db");
        fs::create_dir_all(local.parent().unwrap()).unwrap();
        fs::write(&local, b"local-work").unwrap();

        assert!(!initialize_from_master(&paths, &local).unwrap());
        assert_eq!(fs::read(&local).unwrap(), b"local-work");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_parent_directory_paths_in_manifests() {
        let root = test_root("unsafe-path");
        let paths = test_paths(&root);
        fs::create_dir_all(&paths.master_versions_root).unwrap();
        let manifest = BusinessMasterManifest {
            schema_version: 1,
            database_version: "000001".to_string(),
            database_file: "../business.db".to_string(),
            sha256: String::new(),
            published_at: String::new(),
            published_by: String::new(),
        };

        assert!(master_database_path(&paths, &manifest).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
