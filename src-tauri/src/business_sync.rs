use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

/// Paths passed to the Python Data Coordinator. Rust owns application startup
/// configuration only; it does not copy, validate, or mutate business data.
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

fn settings(config_path: &Path) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(config_path)
        .map_err(|error| format!("Could not read {}: {error}", config_path.display()))?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "Portal settings are invalid at {}: {error}",
            config_path.display()
        )
    })
}

pub(crate) fn local_business_database_path(
    config_path: &Path,
    app_root: &Path,
    data_root: &Path,
) -> Result<PathBuf, String> {
    let payload = settings(config_path)?;
    let configured = setting(&payload, "business", "database")
        .ok_or_else(|| "Portal settings must define business.database.".to_string())?;
    let shared_root = env::var("PORTAL_SHARED_DATA_ROOT")
        .ok()
        .or_else(|| setting(&payload, "shared", "dataRoot").map(str::to_string))
        .unwrap_or_default();
    let network_root = setting(&payload, "businessSync", "networkRoot").unwrap_or_default();
    Ok(expand_path(
        configured,
        app_root,
        data_root,
        &shared_root,
        network_root,
    ))
}

pub(crate) fn load_paths(
    config_path: &Path,
    app_root: &Path,
    data_root: &Path,
) -> Result<Option<BusinessSyncPaths>, String> {
    let payload = settings(config_path)?;
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
    let snapshot_pointer = paths
        .network_root
        .join("protocol-v1")
        .join("snapshots")
        .join("current.json");
    let manifest_available = snapshot_pointer.is_file();
    let pointer = if manifest_available {
        fs::read_to_string(&snapshot_pointer)
            .ok()
            .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
    } else {
        None
    };
    let master_version = pointer
        .as_ref()
        .and_then(|value| value.get("snapshot_id"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let master_database = pointer
        .as_ref()
        .and_then(|value| value.get("relative_path"))
        .and_then(|value| value.as_str())
        .map(|relative| {
            paths
                .network_root
                .join("protocol-v1")
                .join("snapshots")
                .join(relative)
                .display()
                .to_string()
        });
    let message = if !network_available {
        "The configured network data root is unavailable. Local data remains usable."
    } else if !manifest_available {
        "The network data root is available, but no active business snapshot has been published yet."
    } else if master_version.is_none() {
        "The active shared business snapshot metadata is invalid."
    } else {
        "The Python Data Coordinator manages the active shared business snapshot."
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
