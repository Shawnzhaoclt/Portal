use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

const PROGRESS_EVENT: &str = "portal-data-cache-progress";
const UPDATED_EVENT: &str = "portal-data-cache-updated";
const COPY_BUFFER_BYTES: usize = 8 * 1024 * 1024;
const PUBLICATION_LOCK_WAIT: Duration = Duration::from_secs(8);
const PUBLICATION_LOCK_POLL: Duration = Duration::from_millis(250);
const DEFAULT_MINIMUM_STARTUP_FREE_BYTES: u64 = 15 * 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
struct CacheConfig {
    enabled: bool,
    shared_root: PathBuf,
    remote_manifest: PathBuf,
    local_root: PathBuf,
    direct_network_source_ids: HashSet<String>,
    grace_period_days: u64,
    resume_partial_downloads: bool,
    retain_active_versions: usize,
    minimum_startup_free_bytes: u64,
    disk_safety_reserve_bytes: u64,
    staging_recovery_hours: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteManifest {
    manifest_schema_version: u32,
    publication_id: String,
    #[serde(default, rename = "publishedAtUtc")]
    _published_at_utc: String,
    #[serde(default, rename = "publishedAtEpoch")]
    _published_at_epoch: u64,
    #[serde(default)]
    sources: Vec<RemoteSource>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSource {
    id: String,
    #[serde(default)]
    producer: String,
    #[serde(default)]
    producer_release_id: String,
    display_name: String,
    source: String,
    format: String,
    version: String,
    published_at_utc: String,
    published_at_epoch: u64,
    size_bytes: u64,
    sha256: String,
    schema_fingerprint: String,
    #[serde(default)]
    update_class: String,
    activation_group: String,
    #[serde(default)]
    desktop_enabled: bool,
    #[serde(default)]
    required_at_startup: bool,
    #[serde(default = "default_priority")]
    priority: i64,
    #[serde(default = "default_true")]
    read_only: bool,
    #[serde(default)]
    minimum_app_version: String,
    #[serde(default)]
    maximum_app_version: String,
}

fn default_priority() -> i64 {
    100
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalManifest {
    #[serde(default = "local_schema_version")]
    schema_version: u32,
    #[serde(default)]
    remote_publication_id: String,
    #[serde(default)]
    last_checked_at_epoch: u64,
    #[serde(default)]
    offline: bool,
    #[serde(default)]
    last_error: String,
    #[serde(default)]
    sources: HashMap<String, LocalSource>,
}

fn local_schema_version() -> u32 {
    1
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSource {
    id: String,
    display_name: String,
    version: String,
    local_path: String,
    source: String,
    format: String,
    published_at_utc: String,
    published_at_epoch: u64,
    activated_at_epoch: u64,
    size_bytes: u64,
    sha256: String,
    schema_fingerprint: String,
    activation_group: String,
    read_only: bool,
    validation_state: String,
    #[serde(default)]
    producer: String,
    #[serde(default)]
    producer_release_id: String,
    #[serde(default)]
    update_class: String,
    #[serde(default)]
    required_at_startup: bool,
    #[serde(default)]
    validated_at_epoch: u64,
    #[serde(default)]
    local_modified_at_nanos: u128,
    #[serde(default)]
    observed_remote_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCacheProgress {
    phase: String,
    message: String,
    source_id: String,
    display_name: String,
    current_file_bytes: u64,
    current_file_size: u64,
    completed_bytes: u64,
    total_bytes: u64,
    completed_sources: usize,
    total_sources: usize,
    bytes_per_second: u64,
    eta_seconds: Option<u64>,
    background: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCacheStartupResult {
    enabled: bool,
    offline: bool,
    blocking_downloads: usize,
    background_downloads: usize,
    active_sources: usize,
    publication_id: String,
    local_manifest: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCacheUpdateCompleted {
    publication_id: String,
    updated_source_count: usize,
    updated_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCacheStatus {
    enabled: bool,
    offline: bool,
    active_sources: usize,
    publication_id: String,
    last_checked_at_epoch: u64,
    local_manifest: String,
    updating: bool,
    total_cache_bytes: u64,
    sources: Vec<DataCacheSourceStatus>,
    last_error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCacheSourceStatus {
    id: String,
    display_name: String,
    active_version: String,
    remote_version: String,
    published_at_utc: String,
    update_class: String,
    validation_state: String,
    validated_at_epoch: u64,
    size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum QueueKind {
    Current,
    Blocking,
    Background,
}

#[derive(Clone, Debug)]
struct ActivationGroup {
    id: String,
    sources: Vec<RemoteSource>,
    kind: QueueKind,
    priority: i64,
}

#[derive(Clone, Debug, Default)]
struct ManifestPathCache {
    modified_nanos: u128,
    sources: HashMap<String, PathBuf>,
    files: HashMap<String, PathBuf>,
    file_source_ids: HashMap<String, String>,
    file_versions: HashMap<String, String>,
}

static CACHE_RUN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static MANIFEST_PATH_CACHE: OnceLock<Mutex<ManifestPathCache>> = OnceLock::new();
static BACKGROUND_UPDATE_ACTIVE: AtomicBool = AtomicBool::new(false);

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid JSON in {}: {error}", path.display()))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let temporary = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("manifest"),
        std::process::id()
    ));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize cache metadata: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    replace_file(&temporary, path)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "Could not activate {}: {}",
            destination.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("Could not activate {}: {error}", destination.display()))
}

fn expand_setting_path(raw: &str, shared_root: &Path, data_root: &Path) -> Result<PathBuf, String> {
    let application_root = super::installation_root()?.display().to_string();
    let expanded = raw
        .replace("${PORTAL_APP_ROOT}", &application_root)
        .replace("${PORTAL_DATA_ROOT}", &data_root.display().to_string())
        .replace(
            "${PORTAL_SHARED_DATA_ROOT}",
            &shared_root.display().to_string(),
        );
    if expanded.contains("${") {
        return Err(format!(
            "The data-cache path contains an unresolved setting: {raw}"
        ));
    }
    Ok(PathBuf::from(expanded))
}

fn load_config() -> Result<CacheConfig, String> {
    let settings = super::load_client_settings()?;
    let shared_root = super::configured_shared_data_root(&settings)?;
    let data_root = super::local_data_root()?;
    let cache = settings.pointer("/dataCache");
    let enabled = cache
        .and_then(|value| value.get("enabled"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let remote_raw = cache
        .and_then(|value| value.get("remoteManifest"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("${PORTAL_SHARED_DATA_ROOT}/databases_local/portal-data.current.json");
    let local_raw = cache
        .and_then(|value| value.get("localRoot"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("${PORTAL_DATA_ROOT}/data/source-cache");
    let direct_network_source_ids = cache
        .and_then(|value| value.get("directNetworkSourceIds"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<HashSet<_>>();
    Ok(CacheConfig {
        enabled,
        remote_manifest: expand_setting_path(remote_raw, &shared_root, &data_root)?,
        local_root: expand_setting_path(local_raw, &shared_root, &data_root)?,
        direct_network_source_ids,
        shared_root,
        grace_period_days: cache
            .and_then(|value| value.get("gracePeriodDays"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(7),
        resume_partial_downloads: cache
            .and_then(|value| value.get("resumePartialDownloads"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        retain_active_versions: cache
            .and_then(|value| value.get("retainActiveVersions"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1)
            .max(1) as usize,
        minimum_startup_free_bytes: cache
            .and_then(|value| value.get("minimumStartupFreeBytes"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(DEFAULT_MINIMUM_STARTUP_FREE_BYTES),
        disk_safety_reserve_bytes: cache
            .and_then(|value| value.get("diskSafetyReserveBytes"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1024 * 1024 * 1024),
        staging_recovery_hours: cache
            .and_then(|value| value.get("stagingRecoveryHours"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(72),
    })
}

fn local_manifest_path(config: &CacheConfig) -> PathBuf {
    config.local_root.join("current.json")
}

fn load_local_manifest(config: &CacheConfig) -> LocalManifest {
    read_json(&local_manifest_path(config)).unwrap_or_else(|_| LocalManifest {
        schema_version: 1,
        ..LocalManifest::default()
    })
}

fn wait_for_publication_lock(remote_manifest: &Path) -> Result<(), String> {
    let lock = remote_manifest.with_extension(format!(
        "{}lock",
        remote_manifest
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!("{value}."))
            .unwrap_or_default()
    ));
    let started = Instant::now();
    while lock.exists() {
        if started.elapsed() >= PUBLICATION_LOCK_WAIT {
            return Err("The remote data publication is still being committed.".to_string());
        }
        thread::sleep(PUBLICATION_LOCK_POLL);
    }
    Ok(())
}

fn load_remote_manifest(config: &CacheConfig) -> Result<RemoteManifest, String> {
    wait_for_publication_lock(&config.remote_manifest)?;
    let manifest: RemoteManifest = read_json(&config.remote_manifest)?;
    if manifest.manifest_schema_version != 1 {
        return Err(format!(
            "Unsupported Portal data manifest schema: {}",
            manifest.manifest_schema_version
        ));
    }
    if manifest.sources.iter().any(|source| {
        source.id.trim().is_empty()
            || source.version.trim().is_empty()
            || source.sha256.len() != 64
            || source.source.trim().is_empty()
    }) {
        return Err("The Portal data manifest contains an incomplete source record.".to_string());
    }
    Ok(manifest)
}

fn modified_at_nanos(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0)
}

fn local_source_is_usable(config: &CacheConfig, source: &LocalSource) -> bool {
    let path = Path::new(&source.local_path);
    if !path.starts_with(&config.local_root) {
        return false;
    }
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() == source.size_bytes)
        .unwrap_or(false)
        && source.validation_state == "verified"
        && source.local_modified_at_nanos != 0
        && modified_at_nanos(path) == source.local_modified_at_nanos
}

fn classify_source(
    config: &CacheConfig,
    remote: &RemoteSource,
    local: Option<&LocalSource>,
    grace_days: u64,
) -> QueueKind {
    let Some(local) = local else {
        return QueueKind::Blocking;
    };
    if !local_source_is_usable(config, local) {
        return QueueKind::Blocking;
    }
    if local.version == remote.version && local.sha256 == remote.sha256 {
        return QueueKind::Current;
    }
    let grace_seconds = grace_days.saturating_mul(24 * 60 * 60);
    let remote_release_age = now_epoch().saturating_sub(remote.published_at_epoch);
    if remote_release_age > grace_seconds {
        QueueKind::Blocking
    } else {
        QueueKind::Background
    }
}

fn version_parts(value: &str) -> Vec<u64> {
    value
        .trim()
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .take_while(|part| part.chars().all(|character| character.is_ascii_digit()))
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left = version_parts(left);
    let right = version_parts(right);
    let length = left.len().max(right.len());
    (0..length)
        .map(|index| {
            left.get(index)
                .copied()
                .unwrap_or(0)
                .cmp(&right.get(index).copied().unwrap_or(0))
        })
        .find(|ordering| *ordering != std::cmp::Ordering::Equal)
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn source_is_compatible(source: &RemoteSource) -> bool {
    let current = option_env!("PORTAL_PACKAGE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    (source.minimum_app_version.is_empty()
        || compare_versions(current, &source.minimum_app_version) != std::cmp::Ordering::Less)
        && (source.maximum_app_version.is_empty()
            || compare_versions(current, &source.maximum_app_version)
                != std::cmp::Ordering::Greater)
}

fn build_groups(
    config: &CacheConfig,
    remote: &RemoteManifest,
    local: &LocalManifest,
    grace_days: u64,
) -> Result<Vec<ActivationGroup>, String> {
    let mut grouped: BTreeMap<String, Vec<RemoteSource>> = BTreeMap::new();
    for source in remote.sources.iter().filter(|source| {
        source.desktop_enabled && !config.direct_network_source_ids.contains(&source.id)
    }) {
        if !source_is_compatible(source) {
            if local
                .sources
                .get(&source.id)
                .is_some_and(|current| local_source_is_usable(config, current))
            {
                continue;
            }
            return Err(format!(
                "{} requires a different Portal application version. Update Portal before downloading this data release.",
                source.display_name
            ));
        }
        grouped
            .entry(source.activation_group.clone())
            .or_default()
            .push(source.clone());
    }
    let mut groups = grouped
        .into_iter()
        .map(|(id, mut sources)| {
            sources.sort_by_key(|source| source.priority);
            let classifications = sources
                .iter()
                .map(|source| {
                    classify_source(config, source, local.sources.get(&source.id), grace_days)
                })
                .collect::<Vec<_>>();
            let kind = if classifications.contains(&QueueKind::Blocking) {
                QueueKind::Blocking
            } else if classifications.contains(&QueueKind::Background) {
                QueueKind::Background
            } else {
                QueueKind::Current
            };
            let priority = sources
                .iter()
                .map(|source| source.priority)
                .min()
                .unwrap_or(100);
            ActivationGroup {
                id,
                sources,
                kind,
                priority,
            }
        })
        .collect::<Vec<_>>();
    groups.sort_by_key(|group| group.priority);
    Ok(groups)
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn remote_source_path(config: &CacheConfig, source: &RemoteSource) -> Result<PathBuf, String> {
    let relative = Path::new(&source.source);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("Source {} has an unsafe relative path.", source.id));
    }
    Ok(config.shared_root.join(relative))
}

fn destination_paths(
    config: &CacheConfig,
    source: &RemoteSource,
) -> Result<(PathBuf, PathBuf), String> {
    let file_name = Path::new(&source.source)
        .file_name()
        .ok_or_else(|| format!("Source {} has no file name.", source.id))?;
    let source_directory = safe_component(&source.id);
    let version_directory = safe_component(&source.version);
    let final_path = config
        .local_root
        .join("versions")
        .join(&source_directory)
        .join(&version_directory)
        .join(file_name);
    let staging_path = config
        .local_root
        .join("staging")
        .join(source_directory)
        .join(version_directory)
        .join(format!("{}.part", file_name.to_string_lossy()));
    Ok((final_path, staging_path))
}

fn emit_progress(app: &AppHandle, progress: &DataCacheProgress) {
    let _ = app.emit(PROGRESS_EVENT, progress);
}

fn validate_file_header(path: &Path, source_format: &str) -> Result<(), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Could not validate {}: {error}", path.display()))?;
    let mut header = [0_u8; 16];
    let read = file
        .read(&mut header)
        .map_err(|error| format!("Could not validate {}: {error}", path.display()))?;
    let format = source_format.to_ascii_lowercase();
    let valid = if format == "sqlite" {
        read >= 16 && &header == b"SQLite format 3\0"
    } else if format == "duckdb" {
        read >= 12 && &header[8..12] == b"DUCK"
    } else if format.starts_with("pmtiles") {
        read >= 7 && &header[..7] == b"PMTiles"
    } else if matches!(format.as_str(), "cog" | "geotiff" | "tiff") {
        read >= 4 && matches!(&header[..4], b"II*\0" | b"MM\0*" | b"II+\0" | b"MM\0+")
    } else if matches!(format.as_str(), "json" | "manifest") {
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(path).map_err(|error| error.to_string())?,
        )
        .is_ok()
    } else {
        read > 0
    };
    valid.then_some(()).ok_or_else(|| {
        format!(
            "Downloaded {} has an invalid {} header.",
            path.display(),
            source_format
        )
    })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut digest = Sha256::new();
    let mut file = File::open(path)
        .map_err(|error| format!("Could not verify {}: {error}", path.display()))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(target_os = "windows")]
fn available_disk_bytes(path: &Path) -> Result<u64, String> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available = 0_u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        return Err(format!(
            "Could not determine free disk space for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(available)
}

#[cfg(not(target_os = "windows"))]
fn available_disk_bytes(_path: &Path) -> Result<u64, String> {
    Ok(u64::MAX)
}

fn remaining_group_bytes(config: &CacheConfig, group: &ActivationGroup) -> u64 {
    group
        .sources
        .iter()
        .map(|source| {
            let Ok((_final_path, staging_path)) = destination_paths(config, source) else {
                return source.size_bytes;
            };
            let staged = fs::metadata(staging_path)
                .map(|metadata| metadata.len().min(source.size_bytes))
                .unwrap_or(0);
            source.size_bytes.saturating_sub(staged)
        })
        .sum()
}

fn format_size(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / GIB)
    } else {
        format!("{:.1} MB", bytes as f64 / MIB)
    }
}

fn validate_startup_disk_space(available: u64, required: u64, path: &Path) -> Result<(), String> {
    if available < required {
        return Err(format!(
            "Portal requires at least 15 GB of free disk space to run. The drive containing {} has only {} available. Free disk space and try again.",
            path.display(),
            format_size(available)
        ));
    }
    Ok(())
}

fn ensure_startup_disk_space(config: &CacheConfig) -> Result<(), String> {
    let available = available_disk_bytes(&config.local_root)?;
    validate_startup_disk_space(
        available,
        config.minimum_startup_free_bytes,
        &config.local_root,
    )
}

fn ensure_group_disk_space(config: &CacheConfig, group: &ActivationGroup) -> Result<(), String> {
    let remaining = remaining_group_bytes(config, group);
    if remaining == 0 {
        return Ok(());
    }
    let required = remaining.saturating_add(config.disk_safety_reserve_bytes);
    let available = available_disk_bytes(&config.local_root)?;
    if available < required {
        return Err(format!(
            "Not enough local disk space to update {}. {} is required and {} is available.",
            group.id,
            format_size(required),
            format_size(available)
        ));
    }
    Ok(())
}

fn copy_and_verify_source(
    app: &AppHandle,
    config: &CacheConfig,
    source: &RemoteSource,
    totals: &mut CopyTotals,
    background: bool,
) -> Result<PathBuf, String> {
    let remote_path = remote_source_path(config, source)?;
    let metadata = fs::metadata(&remote_path)
        .map_err(|error| format!("Could not read {}: {error}", remote_path.display()))?;
    if !metadata.is_file() || metadata.len() != source.size_bytes {
        return Err(format!(
            "The remote source changed after publication: {}",
            remote_path.display()
        ));
    }
    let (final_path, staging_path) = destination_paths(config, source)?;
    if let Some(parent) = staging_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }

    if fs::metadata(&final_path)
        .map(|metadata| metadata.is_file() && metadata.len() == source.size_bytes)
        .unwrap_or(false)
        && validate_file_header(&final_path, &source.format).is_ok()
        && sha256_file(&final_path)? == source.sha256.to_ascii_lowercase()
    {
        totals.copied_bytes = totals.copied_bytes.saturating_add(source.size_bytes);
        totals.completed_sources += 1;
        return Ok(final_path);
    }

    if !config.resume_partial_downloads {
        let _ = fs::remove_file(&staging_path);
    }
    if fs::metadata(&staging_path)
        .map(|metadata| metadata.len() > source.size_bytes)
        .unwrap_or(false)
    {
        let _ = fs::remove_file(&staging_path);
    }
    let mut resumed = if config.resume_partial_downloads {
        fs::metadata(&staging_path)
            .map(|value| value.len().min(source.size_bytes))
            .unwrap_or(0)
    } else {
        0
    };
    totals.copied_bytes = totals.copied_bytes.saturating_add(resumed);
    if resumed == source.size_bytes {
        // The completed partial is still verified below.
    } else {
        let mut input = File::open(&remote_path)
            .map_err(|error| format!("Could not open {}: {error}", remote_path.display()))?;
        input
            .seek(SeekFrom::Start(resumed))
            .map_err(|error| format!("Could not resume {}: {error}", remote_path.display()))?;
        let mut output = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(resumed == 0)
            .open(&staging_path)
            .map_err(|error| format!("Could not open {}: {error}", staging_path.display()))?;
        output
            .seek(SeekFrom::Start(resumed))
            .map_err(|error| format!("Could not resume {}: {error}", staging_path.display()))?;
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|error| format!("Could not read {}: {error}", remote_path.display()))?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("Could not write {}: {error}", staging_path.display()))?;
            resumed += read as u64;
            totals.copied_bytes += read as u64;
            let elapsed = totals.started.elapsed().as_secs_f64().max(0.001);
            let rate = (totals.copied_bytes as f64 / elapsed) as u64;
            let remaining = totals.total_bytes.saturating_sub(totals.copied_bytes);
            emit_progress(
                app,
                &DataCacheProgress {
                    phase: "downloading".to_string(),
                    message: format!("Downloading {}", source.display_name),
                    source_id: source.id.clone(),
                    display_name: source.display_name.clone(),
                    current_file_bytes: resumed,
                    current_file_size: source.size_bytes,
                    completed_bytes: totals.copied_bytes,
                    total_bytes: totals.total_bytes,
                    completed_sources: totals.completed_sources,
                    total_sources: totals.total_sources,
                    bytes_per_second: rate,
                    eta_seconds: (rate > 0).then_some(remaining / rate),
                    background,
                },
            );
        }
        output
            .sync_all()
            .map_err(|error| format!("Could not flush {}: {error}", staging_path.display()))?;
    }
    if fs::metadata(&staging_path)
        .map(|value| value.len())
        .unwrap_or(0)
        != source.size_bytes
    {
        return Err(format!(
            "The downloaded size does not match {}.",
            source.display_name
        ));
    }
    if let Err(error) = validate_file_header(&staging_path, &source.format) {
        let _ = fs::remove_file(&staging_path);
        return Err(error);
    }
    let actual = sha256_file(&staging_path)?;
    if actual != source.sha256.to_ascii_lowercase() {
        let _ = fs::remove_file(&staging_path);
        return Err(format!(
            "Checksum verification failed for {}.",
            source.display_name
        ));
    }
    if final_path.exists() {
        let mut permissions = fs::metadata(&final_path)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&final_path, permissions).map_err(|error| error.to_string())?;
    }
    replace_file(&staging_path, &final_path)?;
    if source.read_only {
        let mut permissions = fs::metadata(&final_path)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&final_path, permissions).map_err(|error| {
            format!("Could not make {} read-only: {error}", final_path.display())
        })?;
    }
    totals.completed_sources += 1;
    Ok(final_path)
}

struct CopyTotals {
    total_bytes: u64,
    copied_bytes: u64,
    total_sources: usize,
    completed_sources: usize,
    started: Instant,
}

fn local_source(remote: &RemoteSource, path: &Path) -> LocalSource {
    LocalSource {
        id: remote.id.clone(),
        display_name: remote.display_name.clone(),
        version: remote.version.clone(),
        local_path: path.display().to_string(),
        source: remote.source.clone(),
        format: remote.format.clone(),
        published_at_utc: remote.published_at_utc.clone(),
        published_at_epoch: remote.published_at_epoch,
        activated_at_epoch: now_epoch(),
        size_bytes: remote.size_bytes,
        sha256: remote.sha256.clone(),
        schema_fingerprint: remote.schema_fingerprint.clone(),
        activation_group: remote.activation_group.clone(),
        read_only: remote.read_only,
        validation_state: "verified".to_string(),
        producer: remote.producer.clone(),
        producer_release_id: remote.producer_release_id.clone(),
        update_class: remote.update_class.clone(),
        required_at_startup: remote.required_at_startup,
        validated_at_epoch: now_epoch(),
        local_modified_at_nanos: modified_at_nanos(path),
        observed_remote_version: remote.version.clone(),
    }
}

fn activate_group(
    app: &AppHandle,
    config: &CacheConfig,
    remote: &RemoteManifest,
    local: &mut LocalManifest,
    group: &ActivationGroup,
    totals: &mut CopyTotals,
    background: bool,
) -> Result<(), String> {
    let mut prepared = Vec::new();
    for source in &group.sources {
        let path = copy_and_verify_source(app, config, source, totals, background)?;
        prepared.push((source, path));
    }
    for (source, path) in prepared {
        local
            .sources
            .insert(source.id.clone(), local_source(source, &path));
    }
    local.remote_publication_id = remote.publication_id.clone();
    local.last_checked_at_epoch = now_epoch();
    local.offline = false;
    write_json_atomic(&local_manifest_path(config), local)?;
    refresh_environment(config, local);
    emit_progress(
        app,
        &DataCacheProgress {
            phase: "activating".to_string(),
            message: format!("Activated {}", group.id),
            source_id: String::new(),
            display_name: group.id.clone(),
            current_file_bytes: 0,
            current_file_size: 0,
            completed_bytes: totals.copied_bytes,
            total_bytes: totals.total_bytes,
            completed_sources: totals.completed_sources,
            total_sources: totals.total_sources,
            bytes_per_second: 0,
            eta_seconds: None,
            background,
        },
    );
    // Superseded files remain available for version-pinned resources until the
    // next process startup. This prevents PMTiles range requests from mixing
    // archives when a background activation completes.
    cleanup_versions(config, local, false);
    Ok(())
}

fn cleanup_versions(config: &CacheConfig, local: &LocalManifest, remove_superseded: bool) {
    if !remove_superseded {
        return;
    }
    let versions_root = config.local_root.join("versions");
    for source_id in &config.direct_network_source_ids {
        let source_root = versions_root.join(safe_component(source_id));
        if source_root.starts_with(&versions_root) {
            let _ = fs::remove_dir_all(source_root);
        }
    }
    for source in local.sources.values() {
        let source_root = versions_root.join(safe_component(&source.id));
        let active_version = safe_component(&source.version);
        let mut retained = 0_usize;
        let mut directories = fs::read_dir(&source_root)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .collect::<Vec<_>>();
        directories.sort_by_key(|entry| {
            std::cmp::Reverse(entry.metadata().and_then(|value| value.modified()).ok())
        });
        for entry in directories {
            let is_active = entry.file_name().to_string_lossy() == active_version;
            if is_active || retained < config.retain_active_versions.saturating_sub(1) {
                retained += (!is_active) as usize;
                continue;
            }
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn cleanup_abandoned_staging(config: &CacheConfig) {
    let staging_root = config.local_root.join("staging");
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(
            config.staging_recovery_hours.saturating_mul(60 * 60),
        ))
        .unwrap_or(UNIX_EPOCH);
    let mut directories = vec![staging_root.clone()];
    let mut visited = Vec::new();
    while let Some(directory) = directories.pop() {
        visited.push(directory.clone());
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                directories.push(path);
            } else if entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|modified| modified < cutoff)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
    visited.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in visited {
        if directory != staging_root {
            let _ = fs::remove_dir(directory);
        }
    }
}

fn refresh_environment(config: &CacheConfig, local: &LocalManifest) {
    let manifest = local_manifest_path(config);
    env::set_var("PORTAL_SOURCE_CACHE_MANIFEST", &manifest);
    if let Some(system) = local
        .sources
        .get("system.catalog")
        .filter(|source| local_source_is_usable(config, source))
    {
        env::set_var("PORTAL_SYSTEM_DB", &system.local_path);
    }
}

fn synchronize_groups(
    app: &AppHandle,
    config: &CacheConfig,
    remote: &RemoteManifest,
    mut local: LocalManifest,
    groups: Vec<ActivationGroup>,
    background: bool,
) -> Result<LocalManifest, String> {
    let total_sources = groups.iter().map(|group| group.sources.len()).sum();
    let total_bytes = groups
        .iter()
        .flat_map(|group| &group.sources)
        .map(|source| source.size_bytes)
        .sum();
    let mut totals = CopyTotals {
        total_bytes,
        copied_bytes: 0,
        total_sources,
        completed_sources: 0,
        started: Instant::now(),
    };
    for group in &groups {
        ensure_group_disk_space(config, group)?;
        activate_group(
            app,
            config,
            remote,
            &mut local,
            group,
            &mut totals,
            background,
        )?;
    }
    Ok(local)
}

pub fn startup(app: AppHandle) -> Result<DataCacheStartupResult, String> {
    let lock = CACHE_RUN_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "The Portal data-cache lock is unavailable.".to_string())?;
    let config = load_config()?;
    fs::create_dir_all(config.local_root.join("versions")).map_err(|error| error.to_string())?;
    fs::create_dir_all(config.local_root.join("staging")).map_err(|error| error.to_string())?;
    fs::create_dir_all(config.local_root.join("state")).map_err(|error| error.to_string())?;
    ensure_startup_disk_space(&config)?;
    let mut local = load_local_manifest(&config);
    let removed_direct_source = config
        .direct_network_source_ids
        .iter()
        .any(|source_id| local.sources.remove(source_id).is_some());
    cleanup_versions(&config, &local, true);
    if removed_direct_source {
        write_json_atomic(&local_manifest_path(&config), &local)?;
    }
    cleanup_abandoned_staging(&config);
    refresh_environment(&config, &local);
    if !config.enabled {
        return Ok(DataCacheStartupResult {
            enabled: false,
            offline: false,
            blocking_downloads: 0,
            background_downloads: 0,
            active_sources: local.sources.len(),
            publication_id: local.remote_publication_id,
            local_manifest: local_manifest_path(&config).display().to_string(),
            message: "Local source-data cache is disabled.".to_string(),
        });
    }

    let remote = match load_remote_manifest(&config) {
        Ok(remote) => remote,
        Err(error) => {
            let unusable_required = local.sources.values().any(|source| {
                source.required_at_startup && !local_source_is_usable(&config, source)
            });
            if unusable_required {
                return Err(format!(
                    "Portal cannot reach the authoritative data manifest and its required local catalog is unavailable.\n\n{error}"
                ));
            }
            local.offline = true;
            local.last_error = error.clone();
            local.last_checked_at_epoch = now_epoch();
            let _ = write_json_atomic(&local_manifest_path(&config), &local);
            refresh_environment(&config, &local);
            return Ok(DataCacheStartupResult {
                enabled: true,
                offline: true,
                blocking_downloads: 0,
                background_downloads: 0,
                active_sources: local.sources.len(),
                publication_id: local.remote_publication_id,
                local_manifest: local_manifest_path(&config).display().to_string(),
                message: format!("Using verified local data in offline mode. {error}"),
            });
        }
    };
    let groups = build_groups(&config, &remote, &local, config.grace_period_days)?;
    for source in &remote.sources {
        if let Some(active) = local.sources.get_mut(&source.id) {
            active.observed_remote_version = source.version.clone();
        }
    }
    let blocking = groups
        .iter()
        .filter(|group| group.kind == QueueKind::Blocking)
        .cloned()
        .collect::<Vec<_>>();
    let background = groups
        .iter()
        .filter(|group| group.kind == QueueKind::Background)
        .cloned()
        .collect::<Vec<_>>();
    let blocking_count = blocking.iter().map(|group| group.sources.len()).sum();
    let background_count = background.iter().map(|group| group.sources.len()).sum();
    if !blocking.is_empty() {
        local = synchronize_groups(&app, &config, &remote, local, blocking, false)?;
    }
    local.remote_publication_id = remote.publication_id.clone();
    local.last_checked_at_epoch = now_epoch();
    local.offline = false;
    local.last_error.clear();
    write_json_atomic(&local_manifest_path(&config), &local)?;
    refresh_environment(&config, &local);

    if !background.is_empty() {
        BACKGROUND_UPDATE_ACTIVE.store(true, Ordering::Release);
        let background_app = app.clone();
        let background_config = config.clone();
        let background_remote = remote.clone();
        let background_local = local.clone();
        let updated_source_ids = background
            .iter()
            .flat_map(|group| group.sources.iter().map(|source| source.id.clone()))
            .collect::<Vec<_>>();
        thread::spawn(move || {
            let mut completed_update = None;
            let lock = CACHE_RUN_LOCK.get_or_init(|| Mutex::new(()));
            if let Ok(_guard) = lock.lock() {
                if let Err(error) = synchronize_groups(
                    &background_app,
                    &background_config,
                    &background_remote,
                    background_local,
                    background,
                    true,
                ) {
                    let mut failed = load_local_manifest(&background_config);
                    failed.last_error = error.clone();
                    let _ = write_json_atomic(&local_manifest_path(&background_config), &failed);
                    emit_progress(
                        &background_app,
                        &DataCacheProgress {
                            phase: "error".to_string(),
                            message: error,
                            source_id: String::new(),
                            display_name: String::new(),
                            current_file_bytes: 0,
                            current_file_size: 0,
                            completed_bytes: 0,
                            total_bytes: 0,
                            completed_sources: 0,
                            total_sources: 0,
                            bytes_per_second: 0,
                            eta_seconds: None,
                            background: true,
                        },
                    );
                } else {
                    let mut completed = load_local_manifest(&background_config);
                    completed.last_error.clear();
                    let _ = write_json_atomic(&local_manifest_path(&background_config), &completed);
                    completed_update = Some(DataCacheUpdateCompleted {
                        publication_id: background_remote.publication_id.clone(),
                        updated_source_count: updated_source_ids.len(),
                        updated_source_ids,
                    });
                }
            }
            BACKGROUND_UPDATE_ACTIVE.store(false, Ordering::Release);
            if let Some(completed) = completed_update {
                let _ = background_app.emit(UPDATED_EVENT, completed);
            }
        });
    }
    Ok(DataCacheStartupResult {
        enabled: true,
        offline: false,
        blocking_downloads: blocking_count,
        background_downloads: background_count,
        active_sources: local.sources.len(),
        publication_id: remote.publication_id,
        local_manifest: local_manifest_path(&config).display().to_string(),
        message: if background_count > 0 {
            format!("Portal started with {background_count} source update(s) continuing in the background.")
        } else {
            "Portal source data is current.".to_string()
        },
    })
}

pub fn status() -> Result<DataCacheStatus, String> {
    let config = load_config()?;
    let local = load_local_manifest(&config);
    let mut sources = local
        .sources
        .values()
        .filter(|source| local_source_is_usable(&config, source))
        .map(|source| DataCacheSourceStatus {
            id: source.id.clone(),
            display_name: source.display_name.clone(),
            active_version: source.version.clone(),
            remote_version: source.observed_remote_version.clone(),
            published_at_utc: source.published_at_utc.clone(),
            update_class: source.update_class.clone(),
            validation_state: source.validation_state.clone(),
            validated_at_epoch: source.validated_at_epoch,
            size_bytes: source.size_bytes,
        })
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    Ok(DataCacheStatus {
        enabled: config.enabled,
        offline: local.offline,
        active_sources: sources.len(),
        publication_id: local.remote_publication_id,
        last_checked_at_epoch: local.last_checked_at_epoch,
        local_manifest: local_manifest_path(&config).display().to_string(),
        updating: BACKGROUND_UPDATE_ACTIVE.load(Ordering::Acquire),
        total_cache_bytes: sources.iter().map(|source| source.size_bytes).sum(),
        sources,
        last_error: local.last_error,
    })
}

pub fn is_enabled() -> bool {
    load_config().map(|config| config.enabled).unwrap_or(false)
}

fn manifest_paths() -> Result<ManifestPathCache, String> {
    let config = load_config()?;
    let path = local_manifest_path(&config);
    let modified_nanos = fs::metadata(&path)
        .and_then(|value| value.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let cache = MANIFEST_PATH_CACHE.get_or_init(|| Mutex::new(ManifestPathCache::default()));
    let mut cache = cache
        .lock()
        .map_err(|_| "The local source resolver is unavailable.".to_string())?;
    if cache.modified_nanos != modified_nanos {
        let local = load_local_manifest(&config);
        cache.sources.clear();
        cache.files.clear();
        cache.file_source_ids.clear();
        cache.file_versions.clear();
        for source in local
            .sources
            .values()
            .filter(|source| local_source_is_usable(&config, source))
        {
            let path = PathBuf::from(&source.local_path);
            cache.sources.insert(source.id.clone(), path.clone());
            if let Some(file_name) = path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
            {
                cache.files.insert(file_name.clone(), path);
                cache
                    .file_source_ids
                    .insert(file_name.clone(), source.id.clone());
                cache
                    .file_versions
                    .insert(file_name, source.version.clone());
            }
        }
        cache.modified_nanos = modified_nanos;
    }
    Ok(cache.clone())
}

#[allow(dead_code)]
pub fn resolve_source(source_id: &str) -> Result<Option<PathBuf>, String> {
    Ok(manifest_paths()?.sources.get(source_id).cloned())
}

#[allow(dead_code)]
pub fn resolve_file_name(file_name: &str) -> Result<Option<PathBuf>, String> {
    Ok(manifest_paths()?.files.get(file_name).cloned())
}

pub fn resolve_file_name_version(
    file_name: &str,
    version: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let requested = version.map(str::trim).filter(|value| !value.is_empty());
    let paths = manifest_paths()?;
    let Some(requested) = requested else {
        return Ok(paths.files.get(file_name).cloned());
    };
    if paths
        .file_versions
        .get(file_name)
        .is_some_and(|value| value == requested)
    {
        return Ok(paths.files.get(file_name).cloned());
    }
    let Some(source_id) = paths.file_source_ids.get(file_name) else {
        return Ok(None);
    };
    let config = load_config()?;
    let candidate = config
        .local_root
        .join("versions")
        .join(safe_component(source_id))
        .join(safe_component(requested))
        .join(Path::new(file_name).file_name().unwrap_or_default());
    Ok(candidate.is_file().then_some(candidate))
}

#[cfg(test)]
mod tests {
    use super::{
        build_groups, classify_source, modified_at_nanos, now_epoch, safe_component,
        validate_file_header, validate_startup_disk_space, CacheConfig, LocalManifest, LocalSource,
        QueueKind, RemoteManifest, RemoteSource, DEFAULT_MINIMUM_STARTUP_FREE_BYTES,
    };
    use std::collections::HashSet;
    use std::path::Path;
    use std::{env, fs, process, time::SystemTime};

    fn config(root: &Path) -> CacheConfig {
        CacheConfig {
            enabled: true,
            shared_root: root.to_path_buf(),
            remote_manifest: root.join("remote.json"),
            local_root: root.to_path_buf(),
            direct_network_source_ids: HashSet::new(),
            grace_period_days: 7,
            resume_partial_downloads: true,
            retain_active_versions: 1,
            minimum_startup_free_bytes: DEFAULT_MINIMUM_STARTUP_FREE_BYTES,
            disk_safety_reserve_bytes: 0,
            staging_recovery_hours: 72,
        }
    }

    fn remote(epoch: u64) -> RemoteSource {
        RemoteSource {
            id: "source.one".to_string(),
            producer: "producer".to_string(),
            producer_release_id: "release".to_string(),
            display_name: "Source one".to_string(),
            source: "source.db".to_string(),
            format: "duckdb".to_string(),
            version: "new".to_string(),
            published_at_utc: String::new(),
            published_at_epoch: epoch,
            size_bytes: 4,
            sha256: "a".repeat(64),
            schema_fingerprint: "schema".to_string(),
            update_class: "daily".to_string(),
            activation_group: "group".to_string(),
            desktop_enabled: true,
            required_at_startup: false,
            priority: 1,
            read_only: true,
            minimum_app_version: String::new(),
            maximum_app_version: String::new(),
        }
    }

    #[test]
    fn startup_requires_fifteen_gibibytes_free() {
        let root = Path::new(r"C:\Users\Portal\data\source-cache");
        let error = validate_startup_disk_space(
            DEFAULT_MINIMUM_STARTUP_FREE_BYTES - 1,
            DEFAULT_MINIMUM_STARTUP_FREE_BYTES,
            root,
        )
        .expect_err("space below the minimum must fail");
        assert!(error.contains("at least 15 GB"));
        assert!(validate_startup_disk_space(
            DEFAULT_MINIMUM_STARTUP_FREE_BYTES,
            DEFAULT_MINIMUM_STARTUP_FREE_BYTES,
            root,
        )
        .is_ok());
    }

    #[test]
    fn missing_local_source_is_blocking() {
        let root = env::temp_dir();
        assert_eq!(
            classify_source(&config(&root), &remote(100), None, 7),
            QueueKind::Blocking
        );
    }

    #[test]
    fn direct_network_source_is_not_downloaded() {
        let root = env::temp_dir();
        let mut cache_config = config(&root);
        cache_config
            .direct_network_source_ids
            .insert("portal.serving".to_string());
        let mut serving = remote(now_epoch());
        serving.id = "portal.serving".to_string();
        let manifest = RemoteManifest {
            manifest_schema_version: 1,
            publication_id: "publication".to_string(),
            _published_at_utc: String::new(),
            _published_at_epoch: now_epoch(),
            sources: vec![serving],
        };

        assert!(
            build_groups(&cache_config, &manifest, &LocalManifest::default(), 7,)
                .expect("groups")
                .is_empty()
        );
    }

    #[test]
    fn source_within_grace_is_background() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = env::temp_dir().join(format!("portal-cache-{unique}-{}", process::id()));
        fs::create_dir_all(&root).expect("test root");
        let path = root.join("source.db");
        fs::write(&path, b"data").expect("test source");
        let local = LocalSource {
            id: "source.one".to_string(),
            display_name: "Source one".to_string(),
            version: "old".to_string(),
            local_path: path.display().to_string(),
            source: "source.db".to_string(),
            format: "duckdb".to_string(),
            published_at_utc: String::new(),
            published_at_epoch: 100,
            activated_at_epoch: 100,
            size_bytes: 4,
            sha256: "b".repeat(64),
            schema_fingerprint: "schema".to_string(),
            activation_group: "group".to_string(),
            read_only: true,
            validation_state: "verified".to_string(),
            producer: "producer".to_string(),
            producer_release_id: "release".to_string(),
            update_class: "daily".to_string(),
            required_at_startup: false,
            validated_at_epoch: 100,
            local_modified_at_nanos: modified_at_nanos(&path),
            observed_remote_version: "new".to_string(),
        };
        assert_eq!(
            classify_source(&config(&root), &remote(now_epoch()), Some(&local), 7),
            QueueKind::Background
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn source_release_older_than_grace_is_blocking() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = env::temp_dir().join(format!("portal-cache-old-{unique}-{}", process::id()));
        fs::create_dir_all(&root).expect("test root");
        let path = root.join("source.db");
        fs::write(&path, b"data").expect("test source");
        let local = LocalSource {
            id: "source.one".to_string(),
            display_name: "Source one".to_string(),
            version: "old".to_string(),
            local_path: path.display().to_string(),
            source: "source.db".to_string(),
            format: "duckdb".to_string(),
            published_at_utc: String::new(),
            published_at_epoch: 100,
            activated_at_epoch: 100,
            size_bytes: 4,
            sha256: "b".repeat(64),
            schema_fingerprint: "schema".to_string(),
            activation_group: "group".to_string(),
            read_only: true,
            validation_state: "verified".to_string(),
            producer: "producer".to_string(),
            producer_release_id: "release".to_string(),
            update_class: "daily".to_string(),
            required_at_startup: false,
            validated_at_epoch: 100,
            local_modified_at_nanos: modified_at_nanos(&path),
            observed_remote_version: "new".to_string(),
        };
        let old_release = now_epoch().saturating_sub(8 * 24 * 60 * 60);
        assert_eq!(
            classify_source(&config(&root), &remote(old_release), Some(&local), 7),
            QueueKind::Blocking
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn big_tiff_header_is_accepted() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = env::temp_dir().join(format!("portal-cache-{unique}.tif"));
        fs::write(&path, b"II+\0\x08\0\0\0\xc8\0\0\0\0\0\0\0").expect("test BigTIFF");
        validate_file_header(&path, "cog").expect("valid BigTIFF");
        fs::remove_file(path).expect("cleanup");
    }

    #[test]
    fn logical_ids_are_safe_path_components() {
        assert_eq!(safe_component("map.core/storm"), "map.core_storm");
    }
}
