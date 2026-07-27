use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime as StdSystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::ffi::c_void;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagerSettings {
    sync_directory: String,
    sync_settings_file: String,
    #[serde(default)]
    portal_settings_file: Option<String>,
    #[serde(default)]
    coordinator_directory: Option<String>,
    #[serde(default)]
    python_executable: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncRun {
    status: String,
    started_at: String,
    finished_at: String,
    duration: String,
    details: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStatus {
    scheduler_running: bool,
    start_allowed: bool,
    status_text: String,
    next_run_text: String,
    published_database: String,
    latest_result: String,
    log_directory: String,
    runs: Vec<SyncRun>,
}

struct SyncPaths {
    sync_script: PathBuf,
    sync_settings: PathBuf,
    python_executable: String,
    manifest: PathBuf,
    database: PathBuf,
    log_directory: PathBuf,
    run_history: PathBuf,
    scheduler_state: PathBuf,
    allowed_start_minute: u16,
    first_run_minute: u16,
    last_run_minute: u16,
    interval_minutes: u16,
}

struct RepositoryPaths {
    runner: PathBuf,
    portal_settings: PathBuf,
    python_executable: String,
}

struct PortalReleasePaths {
    portable_root: PathBuf,
    release_root: PathBuf,
    portal_exe: PathBuf,
    system_db: PathBuf,
    updater: PathBuf,
    version_file: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalReleaseStatus {
    portable_root: String,
    release_root: String,
    package_version: String,
    current_release_version: Option<String>,
    current_update_mode: Option<String>,
    bootstrap_version: Option<String>,
    portal_exe: String,
    system_db: String,
}

fn parse_clock(value: Option<&str>, fallback: u16) -> u16 {
    let Some(value) = value else {
        return fallback;
    };
    let Some((hours, minutes)) = value.split_once(':') else {
        return fallback;
    };
    let Ok(hours) = hours.parse::<u16>() else {
        return fallback;
    };
    let Ok(minutes) = minutes.parse::<u16>() else {
        return fallback;
    };
    if hours < 24 && minutes < 60 {
        hours * 60 + minutes
    } else {
        fallback
    }
}

fn configuration_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("PORTAL_WORKSTATION_MANAGER_CONFIG") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(executable) = env::current_exe() {
        if let Some(directory) = executable.parent() {
            let portable = directory
                .join("config")
                .join("workstation-manager.settings.json");
            if portable.is_file() {
                return Ok(portable);
            }
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("config")
        .join("workstation-manager.settings.json");
    if development.is_file() {
        return Ok(development);
    }
    Err("The workstation manager settings file was not found.".to_string())
}

fn expand_environment_tokens(value: &str) -> String {
    let mut expanded = value.to_string();
    for (name, replacement) in env::vars() {
        expanded = expanded.replace(&format!("${{{name}}}"), &replacement);
        expanded = expanded.replace(&format!("%{name}%"), &replacement);
    }
    expanded
}

fn resolve_configured_path(value: &str, base_directory: &Path) -> PathBuf {
    let candidate = PathBuf::from(expand_environment_tokens(value));
    if candidate.is_absolute() {
        candidate
    } else {
        base_directory.join(candidate)
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_str(text.trim_start_matches(['\u{feff}', '\0', ' ', '\t', '\r', '\n']))
        .map_err(|error| format!("Invalid JSON in {}: {error}", path.display()))
}

fn manager_settings() -> Result<(ManagerSettings, PathBuf), String> {
    let path = configuration_path()?;
    let settings = serde_json::from_value(read_json(&path)?)
        .map_err(|error| format!("Invalid workstation manager settings: {error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| {
            "The workstation manager settings path has no parent directory.".to_string()
        })?
        .to_path_buf();
    Ok((settings, parent))
}

fn repository_paths() -> Result<RepositoryPaths, String> {
    let (settings, config_directory) = manager_settings()?;
    let coordinator_directory = settings
        .coordinator_directory
        .as_deref()
        .map(|value| resolve_configured_path(value, &config_directory))
        .unwrap_or_else(|| config_directory.join("..\\coordinator"));
    let portal_settings_value = settings.portal_settings_file.as_deref().ok_or_else(|| {
        "The workstation manager settings must define portalSettingsFile for repository tasks."
            .to_string()
    })?;
    Ok(RepositoryPaths {
        runner: coordinator_directory.join("repository_runner.py"),
        portal_settings: resolve_configured_path(portal_settings_value, &config_directory),
        python_executable: expand_environment_tokens(&settings
            .python_executable
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "python.exe".to_string())),
    })
}

fn portal_release_paths() -> Result<PortalReleasePaths, String> {
    let repository = repository_paths()?;
    if !repository.portal_settings.is_file() {
        return Err(format!(
            "The Portal settings file was not found: {}",
            repository.portal_settings.display()
        ));
    }
    let settings = read_json(&repository.portal_settings)?;
    let config_directory = repository
        .portal_settings
        .parent()
        .ok_or_else(|| "The Portal settings file has no parent directory.".to_string())?;
    let portable_root = config_directory
        .parent()
        .ok_or_else(|| "The Portal settings file is not under a config directory.".to_string())?
        .to_path_buf();
    let shared_root = settings
        .pointer("/shared/dataRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let release_value = settings
        .pointer("/updates/releaseRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Portal settings must define updates.releaseRoot.".to_string())?;
    let expanded = expand_environment_tokens(release_value)
        .replace("${PORTAL_APP_ROOT}", &portable_root.display().to_string())
        .replace("${PORTAL_SHARED_DATA_ROOT}", shared_root);
    if expanded.contains("${") {
        return Err("Portal releaseRoot contains an unresolved configuration token.".to_string());
    }
    let release_root = resolve_configured_path(&expanded, config_directory);
    let paths = PortalReleasePaths {
        portable_root: portable_root.clone(),
        release_root,
        portal_exe: portable_root.join("Portal.exe"),
        system_db: portable_root.join("config").join("system.db"),
        updater: portable_root.join("runtime").join("PortalUpdater.exe"),
        version_file: portable_root.join("VERSION"),
    };
    for required in [&paths.portal_exe, &paths.system_db, &paths.updater, &paths.version_file] {
        if !required.is_file() {
            return Err(format!("The Portal release source is missing {}", required.display()));
        }
    }
    Ok(paths)
}

fn release_version_from_file(path: &Path) -> Result<String, String> {
    let version = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?
        .trim()
        .to_string();
    if !is_semantic_version(&version) {
        return Err(format!("The Portal VERSION file is not semantic version text: {version}"));
    }
    Ok(version)
}

fn is_semantic_version(value: &str) -> bool {
    let core = value.trim().split_once('-').map_or(value.trim(), |(left, _)| left);
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|character| character.is_ascii_digit()))
}

fn version_parts(value: &str) -> Option<Vec<u64>> {
    if !is_semantic_version(value) {
        return None;
    }
    value
        .trim()
        .split_once('-')
        .map_or(value.trim(), |(left, _)| left)
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    match (version_parts(candidate), version_parts(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => false,
    }
}

fn manifest_string(path: &Path, name: &str) -> Option<String> {
    read_json(path)
        .ok()
        .and_then(|value| value.get(name).and_then(Value::as_str).map(str::to_string))
}

fn portal_release_status_value() -> Result<PortalReleaseStatus, String> {
    let paths = portal_release_paths()?;
    let package_version = release_version_from_file(&paths.version_file)?;
    let current_manifest = paths.release_root.join("portal-release.json");
    let bootstrap_manifest = paths.release_root.join("portal-bootstrap.json");
    Ok(PortalReleaseStatus {
        portable_root: paths.portable_root.display().to_string(),
        release_root: paths.release_root.display().to_string(),
        package_version,
        current_release_version: manifest_string(&current_manifest, "version"),
        current_update_mode: manifest_string(&current_manifest, "updateMode"),
        bootstrap_version: manifest_string(&bootstrap_manifest, "version"),
        portal_exe: paths.portal_exe.display().to_string(),
        system_db: paths.system_db.display().to_string(),
    })
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Could not hash {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_json_replace(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The release manifest has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create release directory: {error}"))?;
    let temporary = path.with_extension("json.part");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(value)
            .map_err(|error| format!("Could not serialize release manifest: {error}"))?,
    )
    .map_err(|error| format!("Could not write release manifest: {error}"))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace release manifest: {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not activate release manifest: {error}"))
}

fn create_release_zip(source: &Path, archive: &Path) -> Result<(), String> {
    let temporary = archive.with_extension("part.zip");
    let _ = fs::remove_file(&temporary);
    let status = Command::new("tar.exe")
        .args(["-a", "-c", "-f"])
        .arg(&temporary)
        .arg("-C")
        .arg(source)
        .arg(".")
        .status()
        .map_err(|error| format!("Windows tar.exe could not create the Portal release ZIP: {error}"))?;
    if !status.success() {
        return Err("Windows tar.exe could not create the Portal release ZIP.".to_string());
    }
    if archive.exists() {
        fs::remove_file(archive)
            .map_err(|error| format!("Could not replace existing Portal ZIP: {error}"))?;
    }
    fs::rename(&temporary, archive)
        .map_err(|error| format!("Could not publish Portal release ZIP: {error}"))
}

fn installer_batch() -> &'static str {
    "@echo off\r\nsetlocal\r\nset \"RELEASE_ROOT=%~dp0\"\r\nif \"%RELEASE_ROOT:~-1%\"==\"\\\" set \"RELEASE_ROOT=%RELEASE_ROOT:~0,-1%\"\r\n\r\nif not exist \"%RELEASE_ROOT%\\PortalUpdater.exe\" (\r\n  echo PortalUpdater.exe was not found beside this downloader.\r\n  pause\r\n  exit /b 1\r\n)\r\n\r\n\"%RELEASE_ROOT%\\PortalUpdater.exe\" --bootstrap --manifest \"portal-bootstrap.json\" --release-root \"%RELEASE_ROOT%\" --restart\r\nif errorlevel 1 (\r\n  echo.\r\n  echo Portal download failed. Review the message above and contact the Portal developer if the issue continues.\r\n  pause\r\n  exit /b 1\r\n)\r\n\r\necho.\r\necho Storm Water Asset Intelligence Portal is ready to use.\r\necho A Desktop shortcut has been created and Portal is starting.\r\nmsg \"%USERNAME%\" \"Storm Water Asset Intelligence Portal is ready to use.\" >nul 2>&1\r\n"
}

fn emit_release_progress(app: &AppHandle, message: &str) {
    let _ = app.emit("portal-release-progress", message);
}

fn publish_portal_release_value(
    app: &AppHandle,
    update_mode: &str,
    requested_version: Option<String>,
) -> Result<PortalReleaseStatus, String> {
    emit_release_progress(app, "Validating the Portal package and release configuration.");
    if !matches!(update_mode, "system-db" | "portal-exe" | "full") {
        return Err("Update type must be system-db, portal-exe, or full.".to_string());
    }
    let paths = portal_release_paths()?;
    let package_version = release_version_from_file(&paths.version_file)?;
    let version = requested_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&package_version)
        .to_string();
    if !is_semantic_version(&version) {
        return Err("Release version must use semantic version format, such as 0.2.1.".to_string());
    }
    if update_mode == "full" && version != package_version {
        return Err(format!(
            "A full release must use the packaged VERSION ({package_version}). Rebuild Portal before publishing this version."
        ));
    }
    emit_release_progress(app, "Preparing the shared release directory.");
    fs::create_dir_all(&paths.release_root)
        .map_err(|error| format!("Could not create shared release folder: {error}"))?;
    if let Some(current) = manifest_string(&paths.release_root.join("portal-release.json"), "version") {
        if !version_is_newer(&version, &current) {
            return Err(format!(
                "Release version {version} must be newer than the current shared release {current}."
            ));
        }
    }

    let payload = match update_mode {
        "system-db" => {
            emit_release_progress(app, "Copying the system database to the shared release folder.");
            let destination = paths.release_root.join(format!("system-{version}.db"));
            fs::copy(&paths.system_db, &destination)
                .map_err(|error| format!("Could not publish system.db: {error}"))?;
            destination
        }
        "portal-exe" => {
            emit_release_progress(app, "Copying Portal.exe to the shared release folder.");
            let destination = paths.release_root.join(format!("Portal-{version}.exe"));
            fs::copy(&paths.portal_exe, &destination)
                .map_err(|error| format!("Could not publish Portal.exe: {error}"))?;
            destination
        }
        "full" => {
            emit_release_progress(app, "Creating the full portable ZIP. This can take a few minutes.");
            let destination = paths.release_root.join(format!("Portal-Desktop-{version}.zip"));
            create_release_zip(&paths.portable_root, &destination)?;
            destination
        }
        _ => unreachable!(),
    };
    emit_release_progress(app, "Verifying the release payload and calculating its checksum.");
    let payload_size = fs::metadata(&payload)
        .map_err(|error| format!("Could not inspect release payload: {error}"))?
        .len();
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "version": version,
        "updateMode": update_mode,
        "payload": {
            "file": payload.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
            "sha256": file_sha256(&payload)?,
            "size": payload_size,
        },
        "publishedAtUnixSeconds": StdSystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
    });
    emit_release_progress(app, "Publishing the release manifest.");
    write_json_replace(&paths.release_root.join("portal-release.json"), &manifest)?;
    if update_mode == "full" {
        emit_release_progress(app, "Refreshing the first-time installation bundle.");
        write_json_replace(&paths.release_root.join("portal-bootstrap.json"), &manifest)?;
    }
    emit_release_progress(app, "Refreshing the Portal updater and installer.");
    fs::copy(&paths.updater, paths.release_root.join("PortalUpdater.exe"))
        .map_err(|error| format!("Could not publish PortalUpdater.exe: {error}"))?;
    let legacy_installer = paths.release_root.join("Install-Portal.bat");
    if legacy_installer.exists() {
        fs::remove_file(&legacy_installer)
            .map_err(|error| format!("Could not remove legacy Install-Portal.bat: {error}"))?;
    }
    fs::write(paths.release_root.join("Download-Portal.bat"), installer_batch())
        .map_err(|error| format!("Could not publish Download-Portal.bat: {error}"))?;
    emit_release_progress(app, "Release published successfully.");
    portal_release_status_value()
}

fn sync_paths() -> Result<SyncPaths, String> {
    let (settings, config_directory) = manager_settings()?;
    let sync_directory = resolve_configured_path(&settings.sync_directory, &config_directory);
    let source_settings_path = sync_directory.join(&settings.sync_settings_file);
    let source_settings = read_json(&source_settings_path)?;
    let source_python_executable = source_settings
        .get("pythonExecutable")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_environment_tokens);
    let database_value = source_settings
        .get("sqliteDatabase")
        .or_else(|| source_settings.get("outputDatabase"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "Source-sync settings do not define sqliteDatabase or outputDatabase.".to_string()
        })?;
    let database = resolve_configured_path(database_value, &sync_directory);
    let log_directory = source_settings
        .get("syncLogsDirectory")
        .and_then(Value::as_str)
        .map(|value| resolve_configured_path(value, &sync_directory))
        .unwrap_or_else(|| database.parent().unwrap_or(&sync_directory).join("logs"));
    let manifest = source_settings
        .get("sqliteManifest")
        .and_then(Value::as_str)
        .map(|value| resolve_configured_path(value, &sync_directory))
        .unwrap_or_else(|| {
            let name = database
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("portal_sources");
            database
                .parent()
                .unwrap_or(&sync_directory)
                .join(format!("{name}.current.json"))
        });
    let run_history = source_settings
        .get("syncStatusFile")
        .and_then(Value::as_str)
        .map(|value| resolve_configured_path(value, &sync_directory))
        .unwrap_or_else(|| log_directory.join("portal-sync-status.json"));
    let schedule = source_settings.get("schedule").unwrap_or(&Value::Null);
    Ok(SyncPaths {
        sync_script: sync_directory.join("sync_portal_sources.py"),
        sync_settings: source_settings_path,
        python_executable: source_python_executable.unwrap_or_else(|| {
            expand_environment_tokens(
                &settings
                    .python_executable
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "python.exe".to_string()),
            )
        }),
        manifest,
        database,
        log_directory: log_directory.clone(),
        run_history,
        scheduler_state: source_settings
            .get("schedulerStateFile")
            .and_then(Value::as_str)
            .map(|value| resolve_configured_path(value, &sync_directory))
            .unwrap_or_else(|| log_directory.join("portal-sync-scheduler.json")),
        allowed_start_minute: parse_clock(
            schedule.get("allowedStartTime").and_then(Value::as_str),
            7 * 60,
        ),
        first_run_minute: parse_clock(
            schedule.get("firstRunTime").and_then(Value::as_str),
            7 * 60 + 30,
        ),
        last_run_minute: parse_clock(
            schedule.get("lastRunTime").and_then(Value::as_str),
            16 * 60 + 30,
        ),
        interval_minutes: schedule
            .get("intervalMinutes")
            .and_then(Value::as_u64)
            .filter(|value| (1..=u16::MAX as u64).contains(value))
            .map(|value| value as u16)
            .unwrap_or(5),
    })
}

fn run_hidden(command: &str, arguments: &[String]) -> Result<String, String> {
    let mut process = Command::new(command);
    process.args(arguments);
    #[cfg(target_os = "windows")]
    process.creation_flags(CREATE_NO_WINDOW);
    let output = process
        .output()
        .map_err(|error| format!("Could not start {command}: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if details.is_empty() {
            format!("{command} exited with {}.", output.status)
        } else {
            details
        })
    }
}

#[derive(Deserialize)]
struct SchedulerState {
    pid: u32,
    status: String,
}

fn scheduler_state(paths: &SyncPaths) -> Option<SchedulerState> {
    let value = read_json(&paths.scheduler_state).ok()?;
    serde_json::from_value(value).ok()
}

fn process_exists(process_id: u32) -> bool {
    run_hidden(
        "tasklist.exe",
        &[
            "/FI".to_string(),
            format!("PID eq {process_id}"),
            "/FO".to_string(),
            "CSV".to_string(),
            "/NH".to_string(),
        ],
    )
    .map(|output| output.contains(&process_id.to_string()) && !output.contains("No tasks are running"))
    .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn scheduler_mutex_held() -> bool {
    const SYNCHRONIZE: u32 = 0x0010_0000;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenMutexW(desired_access: u32, inherit_handle: i32, name: *const u16) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    let mutex_name: Vec<u16> = "Global\\PortalWorkstationDataSync"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // The Python scheduler owns this named mutex for its entire lifetime.
    let handle = unsafe { OpenMutexW(SYNCHRONIZE, 0, mutex_name.as_ptr()) };
    if handle.is_null() {
        return false;
    }
    unsafe {
        CloseHandle(handle);
    }
    true
}

#[cfg(not(target_os = "windows"))]
fn scheduler_mutex_held() -> bool {
    false
}

fn scheduler_running(paths: &SyncPaths) -> bool {
    scheduler_state(paths)
        .map(|state| state.status.eq_ignore_ascii_case("running") && process_exists(state.pid))
        .unwrap_or_else(scheduler_mutex_held)
}

struct SourceCommand {
    executable: String,
    arguments: Vec<String>,
}

fn command_supports_pyodbc(executable: &str, prefix: &[String]) -> bool {
    let mut arguments = prefix.to_vec();
    arguments.extend(["-c".to_string(), "import pyodbc".to_string()]);
    run_hidden(executable, &arguments).is_ok()
}

fn source_sync_command(paths: &SyncPaths) -> Result<SourceCommand, String> {
    let scheduler_args = vec![
        paths.sync_script.display().to_string(),
        "--config".to_string(),
        paths.sync_settings.display().to_string(),
        "--schedule".to_string(),
        "--non-interactive".to_string(),
    ];

    if command_supports_pyodbc(&paths.python_executable, &[]) {
        return Ok(SourceCommand {
            executable: paths.python_executable.clone(),
            arguments: scheduler_args,
        });
    }
    if let Ok(configured_python) = env::var("PORTAL_SYNC_PYTHON") {
        if !configured_python.trim().is_empty() && command_supports_pyodbc(&configured_python, &[]) {
            return Ok(SourceCommand {
                executable: configured_python,
                arguments: scheduler_args,
            });
        }
    }
    if command_supports_pyodbc("python.exe", &[]) {
        return Ok(SourceCommand {
            executable: "python.exe".to_string(),
            arguments: scheduler_args,
        });
    }
    for environment in ["portal", "geo_remote", "base"] {
        let prefix = vec![
            "run".to_string(),
            "--no-capture-output".to_string(),
            "-n".to_string(),
            environment.to_string(),
            "python".to_string(),
        ];
        if command_supports_pyodbc("conda.exe", &prefix) {
            let mut arguments = prefix;
            arguments.extend(scheduler_args);
            return Ok(SourceCommand {
                executable: "conda.exe".to_string(),
                arguments,
            });
        }
    }
    Err("Python with pyodbc was not found. Set PORTAL_SYNC_PYTHON to an approved Python runtime or make Conda available on PATH.".to_string())
}

fn coordinator_command(paths: &RepositoryPaths) -> Result<SourceCommand, String> {
    let mut candidates = Vec::new();
    if let Ok(configured_python) = env::var("PORTAL_COORDINATOR_PYTHON") {
        if !configured_python.trim().is_empty() {
            candidates.push(configured_python);
        }
    }
    candidates.push(paths.python_executable.clone());
    candidates.push("python.exe".to_string());

    for candidate in candidates {
        if command_supports_pyodbc(&candidate, &[]) || run_hidden(&candidate, &["--version".to_string()]).is_ok() {
            return Ok(SourceCommand {
                executable: candidate,
                arguments: Vec::new(),
            });
        }
    }

    for environment in ["portal", "geo_remote", "base"] {
        let prefix = vec![
            "run".to_string(),
            "--no-capture-output".to_string(),
            "-n".to_string(),
            environment.to_string(),
            "python".to_string(),
        ];
        if run_hidden("conda.exe", &[prefix.clone(), vec!["--version".to_string()]].concat()).is_ok() {
            return Ok(SourceCommand {
                executable: "conda.exe".to_string(),
                arguments: prefix,
            });
        }
    }
    Err("An approved Python runtime was not found for repository tasks. Configure pythonExecutable or PORTAL_COORDINATOR_PYTHON.".to_string())
}

fn coordinator_error(details: &str) -> String {
    serde_json::from_str::<Value>(details)
        .ok()
        .and_then(|payload| payload.get("error").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| details.to_string())
}

fn repository_task(task: &str, network_root: Option<&str>) -> Result<Value, String> {
    let paths = repository_paths()?;
    if !paths.runner.is_file() {
        return Err(format!("The repository coordinator was not found: {}", paths.runner.display()));
    }
    if !paths.portal_settings.is_file() {
        return Err(format!("The Portal settings file was not found: {}", paths.portal_settings.display()));
    }
    let command = coordinator_command(&paths)?;
    let mut arguments = command.arguments;
    arguments.extend([
        paths.runner.display().to_string(),
        "--task".to_string(),
        task.to_string(),
        "--portal-settings".to_string(),
        paths.portal_settings.display().to_string(),
    ]);
    if let Some(network_root) = network_root {
        arguments.push("--network-root".to_string());
        arguments.push(network_root.to_string());
    }
    let output = run_hidden(&command.executable, &arguments).map_err(|error| coordinator_error(&error))?;
    let payload = output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .ok_or_else(|| "The repository coordinator returned an invalid response.".to_string())?;
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The repository task failed.")
            .to_string());
    }
    payload
        .get("result")
        .cloned()
        .ok_or_else(|| "The repository coordinator returned no result.".to_string())
}

fn schema_task(task: &str, confirmation: Option<&str>) -> Result<Value, String> {
    let paths = repository_paths()?;
    let runner = paths
        .runner
        .parent()
        .ok_or_else(|| "The coordinator directory could not be resolved.".to_string())?
        .join("schema_runner.py");
    if !runner.is_file() {
        return Err(format!("The schema coordinator was not found: {}", runner.display()));
    }
    if !paths.portal_settings.is_file() {
        return Err(format!("The Portal settings file was not found: {}", paths.portal_settings.display()));
    }
    let command = coordinator_command(&paths)?;
    let mut arguments = command.arguments;
    arguments.extend([
        runner.display().to_string(),
        "--task".to_string(),
        task.to_string(),
        "--portal-settings".to_string(),
        paths.portal_settings.display().to_string(),
    ]);
    if let Some(confirmation) = confirmation {
        arguments.push("--confirmation".to_string());
        arguments.push(confirmation.to_string());
    }
    let output = run_hidden(&command.executable, &arguments).map_err(|error| coordinator_error(&error))?;
    let payload = output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .ok_or_else(|| "The schema coordinator returned an invalid response.".to_string())?;
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The schema task failed.")
            .to_string());
    }
    payload
        .get("result")
        .cloned()
        .ok_or_else(|| "The schema coordinator returned no result.".to_string())
}

fn local_time_minutes() -> Option<u16> {
    local_time_seconds().map(|seconds| (seconds / 60) as u16)
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[allow(non_snake_case)]
struct SystemTime {
    wYear: u16,
    wMonth: u16,
    wDayOfWeek: u16,
    wDay: u16,
    wHour: u16,
    wMinute: u16,
    wSecond: u16,
    wMilliseconds: u16,
}

#[cfg(target_os = "windows")]
#[link(name = "Kernel32")]
extern "system" {
    fn GetLocalTime(system_time: *mut SystemTime);
}

#[cfg(target_os = "windows")]
fn local_time_seconds() -> Option<u32> {
    let mut time = SystemTime {
        wYear: 0,
        wMonth: 0,
        wDayOfWeek: 0,
        wDay: 0,
        wHour: 0,
        wMinute: 0,
        wSecond: 0,
        wMilliseconds: 0,
    };
    unsafe { GetLocalTime(&mut time) };
    if time.wHour < 24 && time.wMinute < 60 && time.wSecond < 60 {
        Some((time.wHour as u32) * 3600 + (time.wMinute as u32) * 60 + time.wSecond as u32)
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn local_time_seconds() -> Option<u32> {
    None
}

fn scheduler_start_allowed(paths: &SyncPaths) -> bool {
    let Some(now) = local_time_minutes() else {
        return false;
    };
    now >= paths.allowed_start_minute && now <= paths.last_run_minute
}

fn format_clock(total_minutes: u16) -> String {
    format!("{:02}:{:02}", total_minutes / 60, total_minutes % 60)
}

fn next_scheduled_run(paths: &SyncPaths) -> Option<u16> {
    let now = local_time_seconds()?;
    let first_run = paths.first_run_minute as u32 * 60;
    let last_run = paths.last_run_minute as u32 * 60;
    if first_run > last_run || now > last_run {
        return None;
    }
    if now <= first_run {
        return Some(paths.first_run_minute);
    }

    let interval_seconds = paths.interval_minutes as u32 * 60;
    let elapsed = now - first_run;
    let mut candidate = first_run + (elapsed / interval_seconds) * interval_seconds;
    if candidate < now {
        candidate += interval_seconds;
    }
    if candidate <= last_run {
        Some((candidate / 60) as u16)
    } else {
        None
    }
}

fn display_timestamp(value: Option<&str>) -> String {
    value
        .map(|text| text.replace('T', " ").trim_end_matches('Z').to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "-".to_string())
}

fn published_database(paths: &SyncPaths) -> String {
    if paths.manifest.is_file() {
        if let Ok(manifest) = read_json(&paths.manifest) {
            if let Some(path) = manifest.get("database").and_then(Value::as_str) {
                let candidate = resolve_configured_path(
                    path,
                    paths.manifest.parent().unwrap_or(Path::new(".")),
                );
                if candidate.is_file() {
                    return candidate.display().to_string();
                }
            }
        }
    }
    if paths.database.is_file() {
        paths.database.display().to_string()
    } else {
        "Not published".to_string()
    }
}

fn read_runs(path: &Path, selected_date: &str) -> Vec<SyncRun> {
    let Ok(payload) = read_json(path) else {
        return Vec::new();
    };
    payload
        .get("runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|run| {
                    let started = run.get("started_at").and_then(Value::as_str)?;
                    if !started.starts_with(selected_date) {
                        return None;
                    }
                    let duration = run
                        .get("duration_seconds")
                        .and_then(Value::as_f64)
                        .map(|value| format!("{value:.1} sec"))
                        .unwrap_or_else(|| "-".to_string());
                    Some(SyncRun {
                        status: run
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("-")
                            .to_string(),
                        started_at: display_timestamp(Some(started)),
                        finished_at: display_timestamp(
                            run.get("finished_at").and_then(Value::as_str),
                        ),
                        duration,
                        details: run
                            .get("details")
                            .and_then(Value::as_str)
                            .unwrap_or("-")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn sync_status(selected_date: String) -> Result<SyncStatus, String> {
    let paths = sync_paths()?;
    let running = scheduler_running(&paths);
    let start_allowed = scheduler_start_allowed(&paths);
    let runs = read_runs(&paths.run_history, &selected_date);
    let latest_result = runs
        .first()
        .map(|run| format!("{} - {}", run.status, run.finished_at))
        .unwrap_or_else(|| "No runs recorded".to_string());
    Ok(SyncStatus {
        scheduler_running: running,
        start_allowed,
        status_text: if running { "RUNNING" } else { "STOPPED" }.to_string(),
        next_run_text: next_scheduled_run(&paths)
            .map(|time| {
                format!(
                    "{} (every {} minute{})",
                    format_clock(time),
                    paths.interval_minutes,
                    if paths.interval_minutes == 1 { "" } else { "s" }
                )
            })
            .unwrap_or_else(|| {
                if start_allowed {
                    "No scheduled runs remain today".to_string()
                } else {
                    format!(
                        "Starts available {}-{}",
                        format_clock(paths.allowed_start_minute),
                        format_clock(paths.last_run_minute)
                    )
                }
            }),
        published_database: published_database(&paths),
        latest_result,
        log_directory: paths.log_directory.display().to_string(),
        runs,
    })
}

#[tauri::command]
fn start_scheduler() -> Result<(), String> {
    let paths = sync_paths()?;
    if !scheduler_start_allowed(&paths) {
        return Err(format!(
            "The scheduler can be started only from {} through {} local time.",
            format_clock(paths.allowed_start_minute),
            format_clock(paths.last_run_minute)
        ));
    }
    if !paths.sync_script.is_file() || !paths.sync_settings.is_file() {
        return Err(format!(
            "The source-sync script or its settings file was not found in {}.",
            paths.sync_script.parent().unwrap_or(Path::new(".")).display()
        ));
    }
    if scheduler_running(&paths) {
        return Ok(());
    }
    let command = source_sync_command(&paths)?;
    let mut process = Command::new(&command.executable);
    process.args(&command.arguments);
    #[cfg(target_os = "windows")]
    process.creation_flags(CREATE_NO_WINDOW);
    let child = process
        .spawn()
        .map_err(|error| format!("Could not start the registered source scheduler: {error}"))?;
    drop(child);
    Ok(())
}

#[tauri::command]
fn stop_scheduler() -> Result<(), String> {
    let paths = sync_paths()?;
    let Some(state) = scheduler_state(&paths) else {
        if scheduler_mutex_held() {
            return Err(
                "The active scheduler predates heartbeat tracking. Let it exit at its scheduled time, then start it again from this manager so future runs can be stopped here."
                    .to_string(),
            );
        }
        return Ok(());
    };
    if !process_exists(state.pid) {
        return Ok(());
    }
    run_hidden(
        "taskkill.exe",
        &[
            "/PID".to_string(),
            state.pid.to_string(),
            "/T".to_string(),
            "/F".to_string(),
        ],
    )
    .map(|_| ())
}

#[tauri::command]
fn repository_status() -> Result<Value, String> {
    repository_task("repository.status", None)
}

#[tauri::command]
fn validate_repository() -> Result<Value, String> {
    repository_task("repository.validate", None)
}

#[tauri::command]
fn bootstrap_repository(network_root: String) -> Result<Value, String> {
    repository_task("repository.bootstrap", Some(&network_root))
}

#[tauri::command]
fn portal_release_status() -> Result<PortalReleaseStatus, String> {
    portal_release_status_value()
}

#[tauri::command]
fn publish_portal_release(
    app: AppHandle,
    update_mode: String,
    release_version: Option<String>,
) -> Result<PortalReleaseStatus, String> {
    publish_portal_release_value(&app, &update_mode, release_version)
}

#[tauri::command]
fn schema_status() -> Result<Value, String> {
    schema_task("schema.status", None)
}

#[tauri::command]
fn validate_schema() -> Result<Value, String> {
    schema_task("schema.validate", None)
}

#[tauri::command]
fn plan_schema() -> Result<Value, String> {
    schema_task("schema.plan", None)
}

#[tauri::command]
fn initialize_schema(confirmation: String) -> Result<Value, String> {
    schema_task("schema.initialize", Some(&confirmation))
}

#[tauri::command]
fn migrate_schema(confirmation: String) -> Result<Value, String> {
    schema_task("schema.migrate", Some(&confirmation))
}

#[tauri::command]
fn rollback_schema(confirmation: String) -> Result<Value, String> {
    schema_task("schema.rollback", Some(&confirmation))
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("No path was supplied.".to_string());
    }
    let result = Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Could not open the path: {error}"))?;
    drop(result);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            sync_status,
            start_scheduler,
            stop_scheduler,
            repository_status,
            validate_repository,
            bootstrap_repository,
            portal_release_status,
            publish_portal_release,
            schema_status,
            validate_schema,
            plan_schema,
            initialize_schema,
            migrate_schema,
            rollback_schema,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Portal Workstation Manager");
}
