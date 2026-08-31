use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{SystemTime as StdSystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const PORTAL_TASK_PREFIX: &str = "StormWater Portal";
const SOURCE_SYNC_TASK_NAME: &str = "StormWater Portal Source Data Sync";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagerSettings {
    sync_directory: String,
    sync_settings_file: String,
    #[serde(default)]
    portal_settings_file: Option<String>,
    #[serde(default)]
    portal_release_settings_file: Option<String>,
    #[serde(default)]
    coordinator_directory: Option<String>,
    #[serde(default)]
    python_executable: Option<String>,
    #[serde(default)]
    portal_python_worker: Option<String>,
    #[serde(default)]
    source_backup_directory: Option<String>,
    #[serde(default)]
    source_backup_runner: Option<String>,
    #[serde(default)]
    source_backup_python_executable: Option<String>,
    #[serde(default)]
    source_backup_daily_time: Option<String>,
    #[serde(default)]
    source_backup_weekday: Option<String>,
    #[serde(default)]
    source_backup_heartbeat_day: Option<String>,
    #[serde(default)]
    source_backup_heartbeat_time: Option<String>,
    #[serde(default)]
    source_backup_workflow_task_name: Option<String>,
    #[serde(default)]
    source_backup_heartbeat_task_name: Option<String>,
    #[serde(default)]
    data_publication_directory: Option<String>,
    #[serde(default)]
    data_publication_script: Option<String>,
    #[serde(default)]
    data_publication_settings_file: Option<String>,
    #[serde(default)]
    release_test_machines: Vec<String>,
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
    scheduled_task_registered: bool,
    scheduled_task_name: String,
    scheduled_task_time: String,
    scheduled_task_minute: u16,
    interval_minutes: u16,
    scheduled_task_state: String,
    status_text: String,
    next_run_text: String,
    published_database: String,
    latest_result: String,
    log_directory: String,
    sync_settings_file: String,
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
    release_portal_settings: Option<PathBuf>,
    python_executable: String,
}

struct SourceBackupPaths {
    manager_settings: PathBuf,
    scripts_directory: PathBuf,
    runner: PathBuf,
    python_executable: String,
    daily_minute: u16,
    backup_weekday: String,
    heartbeat_day: String,
    heartbeat_minute: u16,
    workflow_task_name: String,
    heartbeat_task_name: String,
}

fn normalize_managed_task_name(configured: Option<String>, default_name: &str) -> String {
    let candidate = configured
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_name.to_string());
    if candidate.starts_with(PORTAL_TASK_PREFIX) {
        candidate
    } else {
        format!("{PORTAL_TASK_PREFIX} {candidate}")
    }
}

struct PortalReleasePaths {
    portable_root: PathBuf,
    release_root: PathBuf,
    portal_exe: PathBuf,
    system_db: PathBuf,
    updater: PathBuf,
    remover: PathBuf,
    version_file: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalReleaseStatus {
    portable_root: String,
    release_root: String,
    release_version: String,
    published: bool,
    current_update_mode: Option<String>,
    portal_exe: String,
    system_db: String,
    manager_system_db_writable: bool,
    desktop_catalog_protection: String,
    channel: String,
    published_version: Option<String>,
    allowed_machines: Vec<String>,
    configured_test_machines: Vec<String>,
}

struct PortalRuntimePaths {
    worker: Option<PathBuf>,
    worker_script: PathBuf,
    python_executable: String,
    application_root: PathBuf,
    config_file: PathBuf,
    system_database: PathBuf,
    data_root: PathBuf,
    windows_email: String,
}

struct PortalPythonWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_request_id: u64,
}

impl PortalPythonWorker {
    fn call(&mut self, job: &str, request: &Value) -> Result<Value, String> {
        self.next_request_id += 1;
        let request_id = self.next_request_id;
        let message = serde_json::json!({
            "id": request_id,
            "job": job,
            "request": request,
        });
        serde_json::to_writer(&mut self.stdin, &message)
            .map_err(|error| format!("Could not encode the Portal command request: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("Could not send the Portal command request: {error}"))?;

        let mut response_line = String::new();
        let bytes_read = self
            .stdout
            .read_line(&mut response_line)
            .map_err(|error| format!("Could not read the Portal command response: {error}"))?;
        if bytes_read == 0 {
            let status = self
                .child
                .try_wait()
                .ok()
                .flatten()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            return Err(format!(
                "The Portal Python worker closed its response stream (status {status})."
            ));
        }

        let response: Value = serde_json::from_str(response_line.trim())
            .map_err(|error| format!("The Portal Python worker returned invalid JSON: {error}"))?;
        if response.get("id").and_then(Value::as_u64) != Some(request_id) {
            return Err(
                "The Portal Python worker returned a response for the wrong request.".to_string(),
            );
        }
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("The Portal Python command failed.")
                .to_string());
        }
        response.get("result").cloned().ok_or_else(|| {
            "The Portal Python worker response did not include a result.".to_string()
        })
    }
}

impl Drop for PortalPythonWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static PORTAL_PYTHON_WORKER: OnceLock<Mutex<Option<PortalPythonWorker>>> = OnceLock::new();

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

fn required_clock(value: &str, label: &str) -> Result<String, String> {
    let minutes = parse_clock(Some(value), u16::MAX);
    if minutes == u16::MAX {
        return Err(format!(
            "{label} must use HH:MM format with a valid 24-hour time."
        ));
    }
    Ok(format!("{:02}:{:02}", minutes / 60, minutes % 60))
}

fn required_weekday(value: &str, label: &str) -> Result<String, String> {
    let weekday = value.trim().to_uppercase();
    if matches!(
        weekday.as_str(),
        "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT"
    ) {
        Ok(weekday)
    } else {
        Err(format!("{label} must be a valid weekday."))
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
    let release_portal_settings = settings
        .portal_release_settings_file
        .as_deref()
        .map(|value| resolve_configured_path(value, &config_directory));
    Ok(RepositoryPaths {
        runner: coordinator_directory.join("repository_runner.py"),
        portal_settings: resolve_configured_path(portal_settings_value, &config_directory),
        release_portal_settings,
        python_executable: expand_environment_tokens(
            &settings
                .python_executable
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "python.exe".to_string()),
        ),
    })
}

fn source_backup_paths() -> Result<SourceBackupPaths, String> {
    let settings_path = configuration_path()?;
    let settings: ManagerSettings = serde_json::from_value(read_json(&settings_path)?)
        .map_err(|error| format!("Invalid workstation manager settings: {error}"))?;
    let config_directory = settings_path.parent().ok_or_else(|| {
        "The workstation manager settings path has no parent directory.".to_string()
    })?;
    let scripts_directory = settings
        .source_backup_directory
        .as_deref()
        .map(|value| resolve_configured_path(value, config_directory))
        .unwrap_or_else(|| config_directory.join(r"..\source-backup"));
    let runner = settings
        .source_backup_runner
        .as_deref()
        .map(|value| resolve_configured_path(value, config_directory))
        .unwrap_or_else(|| config_directory.join(r"..\coordinator\source_backup_runner.py"));
    let python_executable = expand_environment_tokens(
        &settings
            .source_backup_python_executable
            .or(settings.python_executable)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "python.exe".to_string()),
    );
    Ok(SourceBackupPaths {
        manager_settings: settings_path,
        scripts_directory,
        runner,
        python_executable,
        daily_minute: parse_clock(settings.source_backup_daily_time.as_deref(), 1),
        backup_weekday: settings
            .source_backup_weekday
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "SAT".to_string())
            .to_uppercase(),
        heartbeat_day: settings
            .source_backup_heartbeat_day
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "SUN".to_string())
            .to_uppercase(),
        heartbeat_minute: parse_clock(settings.source_backup_heartbeat_time.as_deref(), 20 * 60),
        workflow_task_name: normalize_managed_task_name(
            settings.source_backup_workflow_task_name,
            "Source Backup Workflow",
        ),
        heartbeat_task_name: normalize_managed_task_name(
            settings.source_backup_heartbeat_task_name,
            "Machine Heartbeat",
        ),
    })
}

fn publish_system_catalog(system_database: &Path, environment: &str) -> Result<Value, String> {
    let settings_path = configuration_path()?;
    let settings: ManagerSettings = serde_json::from_value(read_json(&settings_path)?)
        .map_err(|error| format!("Invalid workstation manager settings: {error}"))?;
    let config_directory = settings_path.parent().ok_or_else(|| {
        "The workstation manager settings path has no parent directory.".to_string()
    })?;
    let publication_directory = settings
        .data_publication_directory
        .as_deref()
        .map(|value| resolve_configured_path(value, config_directory))
        .unwrap_or_else(|| config_directory.join(r"..\data-publication"));
    let publication_script = resolve_configured_path(
        settings
            .data_publication_script
            .as_deref()
            .unwrap_or("publish_data_versions.py"),
        &publication_directory,
    );
    let publication_settings = resolve_configured_path(
        settings
            .data_publication_settings_file
            .as_deref()
            .unwrap_or("publication.settings.json"),
        &publication_directory,
    );
    for required in [&publication_script, &publication_settings] {
        if !required.is_file() {
            return Err(format!(
                "The Portal data-publication file was not found: {}",
                required.display()
            ));
        }
    }
    let python_executable = expand_environment_tokens(
        &settings
            .source_backup_python_executable
            .or(settings.python_executable)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "python.exe".to_string()),
    );
    let arguments = vec![
        publication_script.display().to_string(),
        "--config".to_string(),
        publication_settings.display().to_string(),
        "--producer".to_string(),
        "system-catalog".to_string(),
        "--stage-source".to_string(),
        format!("system.catalog={}", system_database.display()),
        "--environment".to_string(),
        environment.to_string(),
    ];
    let output = run_hidden(&python_executable, &arguments)?;
    serde_json::from_str(output.trim())
        .map_err(|error| format!("The system catalog publisher returned invalid output: {error}"))
}

fn windows_user_email() -> Result<String, String> {
    if let Some(configured) = env::var_os("PORTAL_WINDOWS_EMAIL") {
        let email = configured.to_string_lossy().trim().to_lowercase();
        if email.contains('@') {
            return Ok(email);
        }
    }

    let output = run_hidden("whoami.exe", &["/upn".to_string()])?;
    let email = output.trim().to_lowercase();
    if !email.contains('@') {
        return Err(
            "Windows did not return a valid email address for the signed-in account.".to_string(),
        );
    }
    Ok(email)
}

fn manager_data_root() -> Result<PathBuf, String> {
    let root = if let Some(configured) = env::var_os("PORTAL_MANAGER_DATA_ROOT") {
        PathBuf::from(configured)
    } else if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        PathBuf::from(local_app_data).join("PortalManager")
    } else {
        return Err("LOCALAPPDATA is not available for Portal Manager data.".to_string());
    };
    for directory in [
        root.clone(),
        root.join("data"),
        root.join("data").join("backups"),
        root.join("data").join("inbox"),
        root.join("data").join("outbox"),
        root.join("logs"),
        root.join("temp"),
    ] {
        fs::create_dir_all(&directory).map_err(|error| {
            format!(
                "Could not create manager data directory {}: {error}",
                directory.display()
            )
        })?;
    }
    Ok(root)
}

fn set_system_database_writable(path: &Path, writable: bool) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Could not read the Portal system database at {}: {error}",
            path.display()
        )
    })?;
    let mut permissions = metadata.permissions();
    permissions.set_readonly(!writable);
    fs::set_permissions(path, permissions).map_err(|error| {
        format!(
            "Could not update access for the Portal system database at {}: {error}",
            path.display()
        )
    })
}

fn portal_runtime_paths() -> Result<PortalRuntimePaths, String> {
    let (manager, manager_config_directory) = manager_settings()?;
    let application_root = manager_config_directory
        .parent()
        .ok_or_else(|| {
            "The workstation manager settings are not under a portable application folder."
                .to_string()
        })?
        .to_path_buf();
    let portal_settings_value = manager.portal_settings_file.as_deref().ok_or_else(|| {
        "The workstation manager settings must define portalSettingsFile for Portal runtime tasks."
            .to_string()
    })?;
    let config_file = resolve_configured_path(portal_settings_value, &manager_config_directory);
    if !config_file.is_file() {
        return Err(format!(
            "The Portal settings file was not found: {}",
            config_file.display()
        ));
    }
    let worker_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("python")
        .join("portal")
        .join("ipc")
        .join("portal_worker.py");
    let configured_worker = manager
        .portal_python_worker
        .as_deref()
        .map(|value| {
            let expanded = expand_environment_tokens(value).replace(
                "${PORTAL_APP_ROOT}",
                &application_root.display().to_string(),
            );
            resolve_configured_path(&expanded, &manager_config_directory)
        })
        .filter(|path| path.is_file());
    let packaged_worker = || {
        let executable_name = if cfg!(target_os = "windows") {
            "portal-python.exe"
        } else {
            "portal-python"
        };
        let packaged = application_root
            .join("runtime")
            .join("portal-python")
            .join(executable_name);
        packaged.is_file().then_some(packaged)
    };
    let worker = if cfg!(debug_assertions) && worker_script.is_file() {
        None
    } else {
        configured_worker.or_else(packaged_worker)
    };
    let python_executable = expand_environment_tokens(
        &manager
            .python_executable
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "python.exe".to_string()),
    );
    let system_database = manager_config_directory.join("system.db");
    if !system_database.is_file() {
        return Err(format!(
            "The Portal system database was not found: {}",
            system_database.display()
        ));
    }
    let data_root = manager_data_root()?;
    let windows_email = windows_user_email()?;
    Ok(PortalRuntimePaths {
        worker,
        worker_script,
        python_executable,
        application_root,
        config_file,
        system_database,
        data_root,
        windows_email,
    })
}

fn spawn_portal_python_worker() -> Result<PortalPythonWorker, String> {
    let paths = portal_runtime_paths()?;
    set_system_database_writable(&paths.system_database, true)?;
    let mut command = if let Some(worker) = paths.worker {
        let mut command = Command::new(worker);
        command.arg("--serve");
        command
    } else {
        if !paths.worker_script.is_file() {
            return Err(format!(
                "The Portal Python worker was not found at {} and its source script is unavailable.",
                paths.worker_script.display()
            ));
        }
        let mut command = Command::new(&paths.python_executable);
        command.arg(&paths.worker_script).arg("--serve");
        command
    };
    command
        .env("PORTAL_MANAGER_MODE", "1")
        .env("PORTAL_DESKTOP_MODE", "1")
        .env("PORTAL_APP_ROOT", &paths.application_root)
        .env("PORTAL_DATA_ROOT", &paths.data_root)
        .env("PORTAL_CONFIG_FILE", &paths.config_file)
        .env("PORTAL_WINDOWS_EMAIL", &paths.windows_email)
        .env("PORTAL_SYSTEM_DB", &paths.system_database)
        .env("PORTAL_MANAGEMENT_DB", &paths.system_database)
        .env("PORTAL_SYSTEM_DB_WRITE_ENABLED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(format!("Could not start the Portal Python worker: {error}")),
    };
    let stdin = child.stdin.take().ok_or_else(|| {
        let _ = child.kill();
        "Could not open the Portal Python worker input stream.".to_string()
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        "Could not open the Portal Python worker output stream.".to_string()
    })?;
    Ok(PortalPythonWorker {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_request_id: 0,
    })
}

fn run_portal_python_job(job: &str, request: &Value) -> Result<Value, String> {
    let paths = portal_runtime_paths()?;
    set_system_database_writable(&paths.system_database, true)?;
    let worker_state = PORTAL_PYTHON_WORKER.get_or_init(|| Mutex::new(None));
    let mut worker = worker_state
        .lock()
        .map_err(|_| "The Portal Python worker lock is unavailable.".to_string())?;
    if worker.is_none() {
        *worker = Some(spawn_portal_python_worker()?);
    }
    let result = worker
        .as_mut()
        .expect("Portal Python worker initialized")
        .call(job, request);
    if result.is_err() {
        *worker = None;
    }
    result
}

fn run_portal_python_request(request: &Value) -> Result<Value, String> {
    run_portal_python_job("request", request)
}

fn close_portal_python_worker() -> Result<(), String> {
    let worker_state = PORTAL_PYTHON_WORKER.get_or_init(|| Mutex::new(None));
    let mut worker = worker_state
        .lock()
        .map_err(|_| "The Portal Python worker lock is unavailable.".to_string())?;
    *worker = None;
    Ok(())
}

fn portal_management_session_value() -> Result<Value, String> {
    let response = run_portal_python_request(&serde_json::json!({
        "method": "POST",
        "path": "/api/auth/desktop-login",
        "query": {},
        "headers": {},
        "body": null,
    }))?;
    let status = response
        .get("status")
        .and_then(Value::as_u64)
        .unwrap_or(500);
    if status != 200 {
        let detail = response
            .get("error")
            .map(|value| value.to_string())
            .unwrap_or_else(|| {
                "The signed-in Windows account is not an active Portal user.".to_string()
            });
        return Err(format!("Portal Administration sign-in failed: {detail}"));
    }
    response
        .get("data")
        .cloned()
        .ok_or_else(|| "Portal Administration sign-in did not return a session.".to_string())
}

fn manager_startup_session_value() -> Result<Value, String> {
    let session = portal_management_session_value()?;
    let token = session
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Portal Manager did not receive an authorization token.".to_string())?;
    let user = session
        .get("user")
        .ok_or_else(|| "Portal Manager sign-in did not return a user.".to_string())?;
    let roles = user
        .get("roles")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let role = if roles.contains(&"system_admin")
        || user.get("is_system_admin").and_then(Value::as_bool) == Some(true)
    {
        "system_admin"
    } else if roles.contains(&"admin")
        || user.get("is_admin").and_then(Value::as_bool) == Some(true)
    {
        "admin"
    } else {
        return Err(
            "Access denied. Only active Portal Admin and System Admin accounts may use Portal Manager."
                .to_string(),
        );
    };
    let response = run_portal_python_request(&serde_json::json!({
        "method": "POST",
        "path": "/api/auth/switch-role",
        "query": {},
        "headers": {"Authorization": format!("Bearer {token}")},
        "body": {"role": role},
    }))?;
    let status = response
        .get("status")
        .and_then(Value::as_u64)
        .unwrap_or(500);
    if status != 200 {
        let detail = response
            .get("error")
            .map(|value| value.to_string())
            .unwrap_or_else(|| {
                "The Windows account could not be assigned an elevated Portal role.".to_string()
            });
        return Err(format!("Portal Manager authorization failed: {detail}"));
    }
    response
        .get("data")
        .cloned()
        .ok_or_else(|| "Portal Manager authorization did not return a session.".to_string())
}

fn require_manager_system_admin() -> Result<(), String> {
    let session = portal_management_session_value()?;
    let token = session
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Portal Manager did not receive an authorization token.".to_string())?;
    let response = run_portal_python_request(&serde_json::json!({
        "method": "POST",
        "path": "/api/auth/switch-role",
        "query": {},
        "headers": {"Authorization": format!("Bearer {token}")},
        "body": {"role": "system_admin"},
    }))?;
    let status = response
        .get("status")
        .and_then(Value::as_u64)
        .unwrap_or(500);
    if status != 200 {
        let detail = response
            .get("error")
            .map(|value| value.to_string())
            .unwrap_or_else(|| {
                "The selected Portal role cannot publish system releases.".to_string()
            });
        return Err(format!(
            "System administrator authorization is required: {detail}"
        ));
    }
    Ok(())
}

fn portal_release_paths() -> Result<PortalReleasePaths, String> {
    let (settings, manager_config_directory) = manager_settings()?;
    let release_settings_value = settings
        .portal_release_settings_file
        .as_deref()
        .or(settings.portal_settings_file.as_deref())
        .ok_or_else(|| {
            "The workstation manager settings must define a Portal release settings file."
                .to_string()
        })?;
    let release_settings =
        resolve_configured_path(release_settings_value, &manager_config_directory);
    if !release_settings.is_file() {
        return Err(format!(
            "The Portal settings file was not found: {}",
            release_settings.display()
        ));
    }
    let portal_settings = read_json(&release_settings)?;
    let config_directory = release_settings
        .parent()
        .ok_or_else(|| "The Portal settings file has no parent directory.".to_string())?;
    let portable_root = config_directory
        .parent()
        .ok_or_else(|| "The Portal settings file is not under a config directory.".to_string())?
        .to_path_buf();
    let shared_root = portal_settings
        .pointer("/shared/dataRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let release_value = portal_settings
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
    let manager_system_db = manager_config_directory.join("system.db");
    let paths = PortalReleasePaths {
        portable_root: portable_root.clone(),
        release_root,
        portal_exe: portable_root.join("Portal.exe"),
        system_db: manager_system_db,
        updater: portable_root.join("runtime").join("PortalUpdater.exe"),
        remover: portable_root.join("Remove-Portal.bat"),
        version_file: portable_root.join("VERSION"),
    };
    for required in [
        &paths.portal_exe,
        &paths.system_db,
        &paths.updater,
        &paths.remover,
        &paths.version_file,
    ] {
        if !required.is_file() {
            return Err(format!(
                "The Portal release source is missing {}",
                required.display()
            ));
        }
    }
    Ok(paths)
}

/// Keep the plaintext catalog out of the release without stopping the publish.
///
/// Portal writes config/system.db as it runs, so any package that was launched
/// for verification holds one. It is a runtime file the desktop rebuilds from
/// the published catalog on its next start, so it is removed here rather than
/// treated as a reason to refuse the release. create_release_zip excludes the
/// same path, so an archive stays clean even when the file cannot be deleted.
fn exclude_plaintext_system_database(paths: &PortalReleasePaths) -> Result<bool, String> {
    set_system_database_writable(&paths.system_db, true)?;
    let packaged_database = paths.portable_root.join("config").join("system.db");
    if !packaged_database.exists() {
        return Ok(false);
    }
    if let Ok(metadata) = fs::metadata(&packaged_database) {
        // Portal leaves the catalog read-only, which would block the removal.
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        let _ = fs::set_permissions(&packaged_database, permissions);
    }
    let _ = fs::remove_file(&packaged_database);
    Ok(true)
}

fn release_version_from_file(path: &Path) -> Result<String, String> {
    let version = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?
        .trim()
        .to_string();
    if !is_semantic_version(&version) {
        return Err(format!(
            "The Portal VERSION file is not semantic version text: {version}"
        ));
    }
    Ok(version)
}

fn is_semantic_version(value: &str) -> bool {
    let core = value
        .trim()
        .split_once('-')
        .map_or(value.trim(), |(left, _)| left);
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
        })
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

fn normalize_release_channel(value: Option<&str>) -> Result<String, String> {
    let channel = value.unwrap_or("production").trim().to_ascii_lowercase();
    if matches!(channel.as_str(), "production" | "test") {
        Ok(channel)
    } else {
        Err("Portal release channel must be production or test.".to_string())
    }
}

fn release_channel_root(base: &Path, channel: &str) -> PathBuf {
    if channel == "test" {
        base.join("test")
    } else {
        base.to_path_buf()
    }
}

fn normalized_machine_names(values: Vec<String>) -> Result<Vec<String>, String> {
    let mut names = values
        .into_iter()
        .flat_map(|value| {
            value
                .split([',', ';', '\n', '\r'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_ascii_uppercase)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    for name in &names {
        if name.len() > 63
            || !name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
        {
            return Err(format!("Invalid test computer name: {name}"));
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}

fn portal_release_status_value(channel: Option<&str>) -> Result<PortalReleaseStatus, String> {
    let (settings, _) = manager_settings()?;
    let paths = portal_release_paths()?;
    let channel = normalize_release_channel(channel)?;
    let channel_root = release_channel_root(&paths.release_root, &channel);
    let release_version = release_version_from_file(&paths.version_file)?;
    let current_manifest = channel_root.join("portal-release.json");
    let published_version = manifest_string(&current_manifest, "version");
    let published = published_version.as_deref() == Some(release_version.as_str());
    let allowed_machines = if channel == "test" {
        read_json(&current_manifest)
            .ok()
            .and_then(|value| {
                value
                    .get("allowedMachines")
                    .and_then(Value::as_array)
                    .cloned()
            })
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect()
    } else {
        Vec::new()
    };
    let configured_test_machines = normalized_machine_names(settings.release_test_machines)
        .unwrap_or_else(|_| allowed_machines.clone());
    let manager_system_db_writable = !fs::metadata(&paths.system_db)
        .map_err(|error| format!("Could not inspect the authoritative system.db: {error}"))?
        .permissions()
        .readonly();
    Ok(PortalReleaseStatus {
        portable_root: paths.portable_root.display().to_string(),
        release_root: channel_root.display().to_string(),
        release_version,
        published,
        current_update_mode: published
            .then(|| manifest_string(&current_manifest, "updateMode"))
            .flatten(),
        portal_exe: paths.portal_exe.display().to_string(),
        system_db: paths.system_db.display().to_string(),
        manager_system_db_writable,
        desktop_catalog_protection: "SQLCipher with per-user Windows DPAPI key".to_string(),
        channel,
        published_version,
        allowed_machines,
        configured_test_machines,
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
        .args([
            "--exclude=data",
            "--exclude=./data",
            "--exclude=config/system.db",
            "--exclude=./config/system.db",
        ])
        .arg("-C")
        .arg(source)
        .arg(".")
        .status()
        .map_err(|error| {
            format!("Windows tar.exe could not create the Portal release ZIP: {error}")
        })?;
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

fn installer_batch(channel: &str) -> String {
    format!("@echo off\r\nsetlocal\r\nset \"RELEASE_ROOT=%~dp0\"\r\nif \"%RELEASE_ROOT:~-1%\"==\"\\\" set \"RELEASE_ROOT=%RELEASE_ROOT:~0,-1%\"\r\n\r\nif not exist \"%RELEASE_ROOT%\\PortalUpdater.exe\" (\r\n  echo PortalUpdater.exe was not found beside this downloader.\r\n  pause\r\n  exit /b 1\r\n)\r\n\r\n\"%RELEASE_ROOT%\\PortalUpdater.exe\" --bootstrap --manifest \"portal-release.json\" --release-root \"%RELEASE_ROOT%\" --channel \"{channel}\" --restart\r\nif errorlevel 1 (\r\n  echo.\r\n  echo Portal download failed. Review the message above and contact the Portal developer if the issue continues.\r\n  echo Diagnostic log: %LOCALAPPDATA%\\StormWaterPortal\\data\\logs\\portal-updater.log\r\n  pause\r\n  exit /b 1\r\n)\r\n\r\necho.\r\necho Storm Water Asset Intelligence Portal is ready to use.\r\necho A Desktop shortcut has been created and Portal is starting.\r\n")
}

fn release_payload(path: &Path) -> Result<Value, String> {
    Ok(serde_json::json!({
        "file": path.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
        "sha256": file_sha256(path)?,
        "size": fs::metadata(path)
            .map_err(|error| format!("Could not inspect release payload: {error}"))?
            .len(),
    }))
}

fn emit_release_progress(app: &AppHandle, message: &str) {
    let _ = app.emit("portal-release-progress", message);
}

fn publish_portal_release_value(
    app: &AppHandle,
    update_mode: &str,
    channel: &str,
    allowed_machines: Vec<String>,
) -> Result<PortalReleaseStatus, String> {
    emit_release_progress(
        app,
        "Validating the Portal package and release configuration.",
    );
    if !matches!(update_mode, "portal-exe" | "full") {
        return Err("Update type must be portal-exe or full.".to_string());
    }
    require_manager_system_admin()?;
    let paths = portal_release_paths()?;
    let channel = normalize_release_channel(Some(channel))?;
    let allowed_machines = normalized_machine_names(allowed_machines)?;
    if channel == "test" && allowed_machines.is_empty() {
        return Err("A test release must target at least one computer.".to_string());
    }
    save_release_test_machines(&allowed_machines)?;
    let release_root = release_channel_root(&paths.release_root, &channel);
    let version = release_version_from_file(&paths.version_file)?;
    if !is_semantic_version(&version) {
        return Err("Release version must use semantic version format, such as 0.2.1.".to_string());
    }
    if channel == "test" {
        let production_manifest = paths.release_root.join("portal-release.json");
        if let Some(production_version) = manifest_string(&production_manifest, "version") {
            if !version_is_newer(&version, &production_version) {
                return Err(format!(
                    "Test release {version} must be newer than production release {production_version}."
                ));
            }
        }
    }
    emit_release_progress(app, "Preparing the shared release directory.");
    fs::create_dir_all(&release_root)
        .map_err(|error| format!("Could not create shared release folder: {error}"))?;
    let current_manifest_path = release_root.join("portal-release.json");
    if let Some(current) = manifest_string(&current_manifest_path, "version") {
        let unified_manifest = read_json(&current_manifest_path)
            .ok()
            .is_some_and(|value| value.get("installationPayload").is_some());
        if unified_manifest && !version_is_newer(&version, &current) {
            return Err(format!(
                "Release version {version} must be newer than the current shared release {current}."
            ));
        }
    }

    // Every software release includes one complete installation/recovery artifact.
    // Existing clients may still apply the smaller executable-only update artifact.
    close_portal_python_worker()?;
    emit_release_progress(
        app,
        "Excluding the plaintext system catalog from the installation.",
    );
    if exclude_plaintext_system_database(&paths)? {
        emit_release_progress(
            app,
            "Removed the runtime system catalog left behind by a Portal session.",
        );
    }
    emit_release_progress(
        app,
        "Creating the complete installation package. This can take a few minutes.",
    );
    let installation_artifact = release_root.join(format!("Portal-Desktop-{version}.zip"));
    create_release_zip(&paths.portable_root, &installation_artifact)?;

    let update_artifact = match update_mode {
        "portal-exe" => {
            emit_release_progress(app, "Copying Portal.exe to the shared release folder.");
            let destination = release_root.join(format!("Portal-{version}.exe"));
            fs::copy(&paths.portal_exe, &destination)
                .map_err(|error| format!("Could not publish Portal.exe: {error}"))?;
            destination
        }
        "full" => installation_artifact.clone(),
        _ => unreachable!(),
    };
    emit_release_progress(
        app,
        "Verifying the release payload and calculating its checksum.",
    );
    let update_payload = release_payload(&update_artifact)?;
    let installation_payload = release_payload(&installation_artifact)?;
    let mut manifest = serde_json::json!({
        "schemaVersion": if channel == "test" { 2 } else { 1 },
        "version": version,
        "updateMode": update_mode,
        "payload": update_payload,
        "installationPayload": installation_payload,
        "preservePaths": ["data"],
        "publishedAtUnixSeconds": StdSystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
    });
    if channel == "test" {
        manifest["channel"] = Value::String("test".to_string());
        manifest["allowedMachines"] = serde_json::to_value(&allowed_machines)
            .map_err(|error| format!("Could not serialize test computer names: {error}"))?;
    }
    emit_release_progress(app, "Refreshing the Portal updater and installer.");
    fs::copy(&paths.updater, release_root.join("PortalUpdater.exe"))
        .map_err(|error| format!("Could not publish PortalUpdater.exe: {error}"))?;
    fs::copy(&paths.remover, release_root.join("Remove-Portal.bat"))
        .map_err(|error| format!("Could not publish Remove-Portal.bat: {error}"))?;
    let legacy_installer = release_root.join("Install-Portal.bat");
    if legacy_installer.exists() {
        fs::remove_file(&legacy_installer)
            .map_err(|error| format!("Could not remove legacy Install-Portal.bat: {error}"))?;
    }
    fs::write(
        release_root.join(if channel == "test" {
            "Download-Portal-Test.bat"
        } else {
            "Download-Portal.bat"
        }),
        installer_batch(&channel),
    )
    .map_err(|error| format!("Could not publish Download-Portal.bat: {error}"))?;
    emit_release_progress(app, "Publishing the release manifest.");
    write_json_replace(&release_root.join("portal-release.json"), &manifest)?;
    let legacy_bootstrap_manifest = release_root.join("portal-bootstrap.json");
    if legacy_bootstrap_manifest.exists() {
        fs::remove_file(&legacy_bootstrap_manifest).map_err(|error| {
            format!("Could not remove the legacy Portal bootstrap manifest: {error}")
        })?;
    }
    emit_release_progress(app, "Release published successfully.");
    portal_release_status_value(Some(&channel))
}

fn manifest_payload_info(manifest: &Value, field: &str) -> Result<(String, String, u64), String> {
    let payload = manifest
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("The test release manifest does not define {field}."))?;
    let file = payload
        .get("file")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("The test release manifest has an invalid {field}.file."))?;
    let candidate = Path::new(&file);
    if candidate.components().count() != 1 || candidate.file_name().is_none() {
        return Err(format!(
            "The test release manifest {field}.file must be a file name."
        ));
    }
    let sha256 = payload
        .get("sha256")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("The test release manifest has an invalid {field}.sha256."))?;
    let size = payload
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("The test release manifest has an invalid {field}.size."))?;
    Ok((file, sha256, size))
}

fn copy_verified_release_artifact(
    source_root: &Path,
    destination_root: &Path,
    file: &str,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<(), String> {
    let source = source_root.join(file);
    if !source.is_file() {
        return Err(format!(
            "The tested release artifact is missing: {}",
            source.display()
        ));
    }
    let size = fs::metadata(&source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?
        .len();
    if size != expected_size || !file_sha256(&source)?.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "The tested release artifact failed verification: {}",
            source.display()
        ));
    }
    let destination = destination_root.join(file);
    fs::copy(&source, &destination)
        .map_err(|error| format!("Could not promote {}: {error}", source.display()))?;
    if !file_sha256(&destination)?.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "The promoted release artifact failed verification: {}",
            destination.display()
        ));
    }
    Ok(())
}

fn promote_test_release_value(app: &AppHandle) -> Result<PortalReleaseStatus, String> {
    require_manager_system_admin()?;
    let paths = portal_release_paths()?;
    let test_root = release_channel_root(&paths.release_root, "test");
    let test_manifest_path = test_root.join("portal-release.json");
    let test_manifest = read_json(&test_manifest_path)?;
    if test_manifest.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || test_manifest.get("channel").and_then(Value::as_str) != Some("test")
    {
        return Err("The test channel does not contain a valid targeted test release.".to_string());
    }
    let version = test_manifest
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "The test release manifest does not define a version.".to_string())?;
    let update_mode = test_manifest
        .get("updateMode")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "The test release manifest does not define updateMode.".to_string())?;
    if !matches!(update_mode.as_str(), "portal-exe" | "full") {
        return Err("The test release updateMode is not supported.".to_string());
    }
    let production_manifest_path = paths.release_root.join("portal-release.json");
    if let Some(current) = manifest_string(&production_manifest_path, "version") {
        if !version_is_newer(&version, &current) {
            return Err(format!(
                "Test release {version} must be newer than production release {current}."
            ));
        }
    }
    emit_release_progress(app, "Verifying the tested release artifacts.");
    fs::create_dir_all(&paths.release_root)
        .map_err(|error| format!("Could not create production release folder: {error}"))?;
    let payload = manifest_payload_info(&test_manifest, "payload")?;
    let installation_payload = manifest_payload_info(&test_manifest, "installationPayload")?;
    copy_verified_release_artifact(
        &test_root,
        &paths.release_root,
        &payload.0,
        &payload.1,
        payload.2,
    )?;
    if installation_payload.0 != payload.0 {
        copy_verified_release_artifact(
            &test_root,
            &paths.release_root,
            &installation_payload.0,
            &installation_payload.1,
            installation_payload.2,
        )?;
    }
    for file in ["PortalUpdater.exe", "Remove-Portal.bat"] {
        let source = test_root.join(file);
        if !source.is_file() {
            return Err(format!("The tested release is missing {file}."));
        }
        fs::copy(&source, paths.release_root.join(file))
            .map_err(|error| format!("Could not promote {file}: {error}"))?;
    }
    fs::write(
        paths.release_root.join("Download-Portal.bat"),
        installer_batch("production"),
    )
    .map_err(|error| format!("Could not publish Download-Portal.bat: {error}"))?;
    let production_manifest = serde_json::json!({
        "schemaVersion": 1,
        "version": version,
        "updateMode": update_mode,
        "payload": test_manifest.get("payload").cloned().unwrap_or(Value::Null),
        "installationPayload": test_manifest.get("installationPayload").cloned().unwrap_or(Value::Null),
        "preservePaths": ["data"],
        "publishedAtUnixSeconds": StdSystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        "promotedFromTest": true,
    });
    emit_release_progress(app, "Promoting the tested manifest to production.");
    write_json_replace(&production_manifest_path, &production_manifest)?;
    emit_release_progress(app, "Tested release promoted to production successfully.");
    portal_release_status_value(Some("production"))
}

fn save_release_test_machines(machines: &[String]) -> Result<(), String> {
    let path = configuration_path()?;
    let mut settings = read_json(&path)?;
    settings["releaseTestMachines"] = serde_json::to_value(machines)
        .map_err(|error| format!("Could not serialize saved test computer names: {error}"))?;
    write_json_replace(&path, &settings)
        .map_err(|error| format!("Could not save test computer names: {error}"))
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
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if stderr.is_empty() { stdout } else { stderr };
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
    .map(|output| {
        output.contains(&process_id.to_string()) && !output.contains("No tasks are running")
    })
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

fn source_schedule_state() -> String {
    let output = run_hidden(
        "schtasks.exe",
        &[
            "/Query".to_string(),
            "/TN".to_string(),
            SOURCE_SYNC_TASK_NAME.to_string(),
            "/FO".to_string(),
            "LIST".to_string(),
        ],
    );
    let Ok(output) = output else {
        return "Not registered".to_string();
    };
    if output.to_lowercase().contains("running") {
        "Running".to_string()
    } else {
        "Ready".to_string()
    }
}

fn source_schedule_registered() -> bool {
    source_schedule_state() != "Not registered"
}

fn source_schedule_needs_migration() -> bool {
    let output = run_hidden(
        "schtasks.exe",
        &[
            "/Query".to_string(),
            "/TN".to_string(),
            SOURCE_SYNC_TASK_NAME.to_string(),
            "/FO".to_string(),
            "XML".to_string(),
        ],
    );
    let Ok(output) = output else {
        return false;
    };
    let normalized = output.to_ascii_lowercase();
    normalized.contains("start-source-sync.bat")
        || normalized.contains("<command>cmd.exe</command>")
}

fn windowless_python_executable(executable: &str) -> Option<String> {
    let candidate = Path::new(executable);
    let file_name = candidate.file_name()?.to_str()?;
    if file_name.eq_ignore_ascii_case("pythonw.exe") {
        return Some(candidate.display().to_string());
    }
    if !file_name.eq_ignore_ascii_case("python.exe") {
        return None;
    }
    let sibling = candidate.with_file_name("pythonw.exe");
    if sibling.is_file() {
        return Some(sibling.display().to_string());
    }
    None
}

fn source_sync_task_command(paths: &SyncPaths) -> Result<(String, Vec<String>), String> {
    let command = source_sync_command(paths)?;
    let executable = windowless_python_executable(&command.executable).ok_or_else(|| {
        format!(
            "A console-less Python runtime was not found beside {}. Configure pythonExecutable to a Python installation that contains pythonw.exe.",
            command.executable
        )
    })?;

    // The sync worker defaults to sync.settings.json beside its script. Keeping
    // the scheduled command short also avoids Task Scheduler's /TR limit.
    Ok((
        executable,
        vec![
            paths.sync_script.display().to_string(),
            "--schedule".to_string(),
            "--non-interactive".to_string(),
        ],
    ))
}

fn register_source_schedule_task(paths: &SyncPaths) -> Result<(), String> {
    let (executable, arguments) = source_sync_task_command(paths)?;
    let task_command = format!(
        "\"{}\" {}",
        executable,
        arguments
            .iter()
            .map(|argument| {
                if argument.contains(' ') || argument.contains('\\') {
                    format!("\"{argument}\"")
                } else {
                    argument.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    );
    run_hidden(
        "schtasks.exe",
        &[
            "/Create".to_string(),
            "/TN".to_string(),
            SOURCE_SYNC_TASK_NAME.to_string(),
            "/SC".to_string(),
            "DAILY".to_string(),
            "/ST".to_string(),
            format_clock(paths.allowed_start_minute),
            "/TR".to_string(),
            task_command,
            "/F".to_string(),
        ],
    )?;
    Ok(())
}

fn repair_source_schedule(paths: &SyncPaths) {
    if source_schedule_registered() && source_schedule_needs_migration() {
        let _ = register_source_schedule_task(paths);
    }
}

fn set_source_schedule(paths: &SyncPaths, enabled: bool) -> Result<(), String> {
    if !enabled {
        if source_schedule_registered() {
            run_hidden(
                "schtasks.exe",
                &[
                    "/Delete".to_string(),
                    "/TN".to_string(),
                    SOURCE_SYNC_TASK_NAME.to_string(),
                    "/F".to_string(),
                ],
            )?;
        }
        return Ok(());
    }

    register_source_schedule_task(paths)
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

    if let Some(windowless) = windowless_python_executable(&paths.python_executable) {
        if command_supports_pyodbc(&windowless, &[]) {
            return Ok(SourceCommand {
                executable: windowless,
                arguments: scheduler_args,
            });
        }
    }
    if command_supports_pyodbc(&paths.python_executable, &[]) {
        return Ok(SourceCommand {
            executable: paths.python_executable.clone(),
            arguments: scheduler_args,
        });
    }
    if let Ok(configured_python) = env::var("PORTAL_SYNC_PYTHON") {
        if let Some(windowless) = windowless_python_executable(&configured_python) {
            if command_supports_pyodbc(&windowless, &[]) {
                return Ok(SourceCommand {
                    executable: windowless,
                    arguments: scheduler_args,
                });
            }
        }
        if !configured_python.trim().is_empty() && command_supports_pyodbc(&configured_python, &[])
        {
            return Ok(SourceCommand {
                executable: configured_python,
                arguments: scheduler_args,
            });
        }
    }
    if command_supports_pyodbc("pythonw.exe", &[]) {
        return Ok(SourceCommand {
            executable: "pythonw.exe".to_string(),
            arguments: scheduler_args,
        });
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

fn source_sync_one_shot_command(paths: &SyncPaths, check: bool) -> Result<SourceCommand, String> {
    let mut command = source_sync_command(paths)?;
    let schedule_flag = command
        .arguments
        .iter_mut()
        .find(|argument| argument.as_str() == "--schedule")
        .ok_or_else(|| "The source-sync command did not include its schedule mode.".to_string())?;
    *schedule_flag = "--once".to_string();
    if check {
        command.arguments.push("--check".to_string());
    }
    Ok(command)
}

fn run_source_sync_once(check: bool) -> Result<Value, String> {
    let paths = sync_paths()?;
    if !paths.sync_script.is_file() || !paths.sync_settings.is_file() {
        return Err(format!(
            "The source-sync script or its settings file was not found in {}.",
            paths
                .sync_script
                .parent()
                .unwrap_or(Path::new("."))
                .display()
        ));
    }
    if scheduler_running(&paths) {
        return Err(
            "Stop the active source-data scheduler before running a one-shot source task."
                .to_string(),
        );
    }
    let command = source_sync_one_shot_command(&paths, check)?;
    let output = run_hidden(&command.executable, &command.arguments)?;
    let details = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(if check {
            "Source checks completed."
        } else {
            "Source publication completed."
        })
        .trim()
        .to_string();
    Ok(serde_json::json!({
        "status": "succeeded",
        "task": if check { "source.check" } else { "source.run" },
        "details": details,
        "published_database": published_database(&paths),
    }))
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
        if command_supports_pyodbc(&candidate, &[])
            || run_hidden(&candidate, &["--version".to_string()]).is_ok()
        {
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
        if run_hidden(
            "conda.exe",
            &[prefix.clone(), vec!["--version".to_string()]].concat(),
        )
        .is_ok()
        {
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
        .and_then(|payload| {
            payload
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| details.to_string())
}

fn repository_task(
    task: &str,
    network_root: Option<&str>,
    confirmation: Option<&str>,
) -> Result<Value, String> {
    let paths = repository_paths()?;
    if !paths.runner.is_file() {
        return Err(format!(
            "The repository coordinator was not found: {}",
            paths.runner.display()
        ));
    }
    if !paths.portal_settings.is_file() {
        return Err(format!(
            "The Portal settings file was not found: {}",
            paths.portal_settings.display()
        ));
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
    if let Some(release_portal_settings) = paths
        .release_portal_settings
        .as_ref()
        .filter(|path| path.is_file())
    {
        arguments.push("--release-portal-settings".to_string());
        arguments.push(release_portal_settings.display().to_string());
    }
    if let Some(network_root) = network_root {
        arguments.push("--network-root".to_string());
        arguments.push(network_root.to_string());
    }
    if let Some(confirmation) = confirmation {
        arguments.push("--confirmation".to_string());
        arguments.push(confirmation.to_string());
    }
    let output =
        run_hidden(&command.executable, &arguments).map_err(|error| coordinator_error(&error))?;
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
        return Err(format!(
            "The schema coordinator was not found: {}",
            runner.display()
        ));
    }
    if !paths.portal_settings.is_file() {
        return Err(format!(
            "The Portal settings file was not found: {}",
            paths.portal_settings.display()
        ));
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
    let output =
        run_hidden(&command.executable, &arguments).map_err(|error| coordinator_error(&error))?;
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

fn maintenance_task(
    task: &str,
    confirmation: Option<&str>,
    selected_date: Option<&str>,
    network_root: Option<&str>,
) -> Result<Value, String> {
    maintenance_task_with_extra(task, confirmation, selected_date, network_root, &[])
}

fn maintenance_task_with_extra(
    task: &str,
    confirmation: Option<&str>,
    selected_date: Option<&str>,
    network_root: Option<&str>,
    extra_arguments: &[(&str, String)],
) -> Result<Value, String> {
    let paths = repository_paths()?;
    let runner = paths
        .runner
        .parent()
        .ok_or_else(|| "The coordinator directory could not be resolved.".to_string())?
        .join("maintenance_runner.py");
    if !runner.is_file() {
        return Err(format!(
            "The workstation maintenance coordinator was not found: {}",
            runner.display()
        ));
    }
    if !paths.portal_settings.is_file() {
        return Err(format!(
            "The Portal settings file was not found: {}",
            paths.portal_settings.display()
        ));
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
    if let Some(selected_date) = selected_date {
        arguments.push("--selected-date".to_string());
        arguments.push(selected_date.to_string());
    }
    if let Some(network_root) = network_root {
        arguments.push("--network-root".to_string());
        arguments.push(network_root.to_string());
    }
    for (flag, value) in extra_arguments {
        arguments.push((*flag).to_string());
        arguments.push(value.clone());
    }
    let output =
        run_hidden(&command.executable, &arguments).map_err(|error| coordinator_error(&error))?;
    let payload = output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .ok_or_else(|| {
            "The workstation maintenance coordinator returned an invalid response.".to_string()
        })?;
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The workstation maintenance task failed.")
            .to_string());
    }
    payload
        .get("result")
        .cloned()
        .ok_or_else(|| "The workstation maintenance coordinator returned no result.".to_string())
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
        .map(str::to_string)
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
    // Migrate tasks created by older manager builds from the batch launcher to
    // the console-less Python worker. This keeps an existing installation
    // quiet without requiring the user to delete and recreate the task.
    repair_source_schedule(&paths);
    let running = scheduler_running(&paths);
    let start_allowed = scheduler_start_allowed(&paths);
    let scheduled_task_state = source_schedule_state();
    let scheduled_task_registered = scheduled_task_state != "Not registered";
    let runs = read_runs(&paths.run_history, &selected_date);
    let latest_result = runs
        .first()
        .map(|run| run.status.clone())
        .unwrap_or_else(|| "No runs recorded".to_string());
    Ok(SyncStatus {
        scheduler_running: running,
        start_allowed,
        scheduled_task_registered,
        scheduled_task_name: SOURCE_SYNC_TASK_NAME.to_string(),
        scheduled_task_time: format!(
            "Daily {} local time",
            format_clock(paths.allowed_start_minute)
        ),
        scheduled_task_minute: paths.allowed_start_minute,
        interval_minutes: paths.interval_minutes,
        scheduled_task_state,
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
        sync_settings_file: paths.sync_settings.display().to_string(),
        runs,
    })
}

#[tauri::command]
fn update_source_sync_interval(
    interval_minutes: u16,
    selected_date: String,
) -> Result<SyncStatus, String> {
    if !(1..=1440).contains(&interval_minutes) {
        return Err("The source-sync interval must be between 1 and 1440 minutes.".to_string());
    }

    let paths = sync_paths()?;
    if scheduler_running(&paths) {
        return Err(
            "Stop the serving data scheduler before changing the synchronization interval."
                .to_string(),
        );
    }

    let mut settings = read_json(&paths.sync_settings)?;
    let schedule = settings
        .get_mut("schedule")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "The source-sync settings do not contain a schedule object.".to_string())?;
    schedule.insert("intervalMinutes".to_string(), Value::from(interval_minutes));
    write_json_replace(&paths.sync_settings, &settings)
        .map_err(|error| format!("Could not save source-sync settings: {error}"))?;

    sync_status(selected_date)
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
            paths
                .sync_script
                .parent()
                .unwrap_or(Path::new("."))
                .display()
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
fn run_source_sync() -> Result<Value, String> {
    run_source_sync_once(false)
}

#[tauri::command]
fn check_source_sync() -> Result<Value, String> {
    run_source_sync_once(true)
}

#[tauri::command]
fn enable_source_scheduler_schedule() -> Result<(), String> {
    let paths = sync_paths()?;
    set_source_schedule(&paths, true)
}

#[tauri::command]
fn disable_source_scheduler_schedule() -> Result<(), String> {
    let paths = sync_paths()?;
    set_source_schedule(&paths, false)
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

fn source_backup_runner_arguments(paths: &SourceBackupPaths) -> Vec<String> {
    vec![
        paths.runner.display().to_string(),
        "--manager-settings".to_string(),
        paths.manager_settings.display().to_string(),
    ]
}

fn source_backup_runner_result(paths: &SourceBackupPaths) -> Result<Value, String> {
    if !paths.runner.is_file() {
        return Err(format!(
            "The source-backup coordinator was not found: {}",
            paths.runner.display()
        ));
    }
    if !paths.scripts_directory.is_dir() {
        return Err(format!(
            "The Portal Manager source-backup directory was not found: {}",
            paths.scripts_directory.display()
        ));
    }
    let mut arguments = source_backup_runner_arguments(paths);
    arguments.push("--status".to_string());
    let output = run_hidden(&paths.python_executable, &arguments)?;
    let payload = output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .ok_or_else(|| "The source-backup coordinator returned an invalid response.".to_string())?;
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The source-backup coordinator status check failed.")
            .to_string());
    }
    payload
        .get("result")
        .cloned()
        .ok_or_else(|| "The source-backup coordinator returned no status.".to_string())
}

fn scheduled_task_field(output: &str, label: &str) -> String {
    output
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case(label)
                .then(|| value.trim().to_string())
        })
        .unwrap_or_default()
}

fn source_backup_task_status(task_name: &str, runner: &Path) -> Value {
    let output = run_hidden(
        "schtasks.exe",
        &[
            "/Query".to_string(),
            "/TN".to_string(),
            task_name.to_string(),
            "/FO".to_string(),
            "LIST".to_string(),
            "/V".to_string(),
        ],
    );
    let Ok(output) = output else {
        return serde_json::json!({
            "task_name": task_name,
            "registered": false,
            "managed": false,
            "state": "Not registered",
            "next_run": "",
            "last_run": "",
            "last_result": "",
        });
    };
    let xml = run_hidden(
        "schtasks.exe",
        &[
            "/Query".to_string(),
            "/TN".to_string(),
            task_name.to_string(),
            "/FO".to_string(),
            "XML".to_string(),
        ],
    )
    .unwrap_or_default()
    .to_ascii_lowercase();
    let runner_name = runner
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("source_backup_runner.py")
        .to_ascii_lowercase();
    serde_json::json!({
        "task_name": task_name,
        "registered": true,
        "managed": xml.contains(&runner_name),
        "state": scheduled_task_field(&output, "Status"),
        "next_run": scheduled_task_field(&output, "Next Run Time"),
        "last_run": scheduled_task_field(&output, "Last Run Time"),
        "last_result": scheduled_task_field(&output, "Last Result"),
    })
}

#[tauri::command]
fn source_backup_status() -> Result<Value, String> {
    let paths = source_backup_paths()?;
    let mut status = source_backup_runner_result(&paths)?;
    let object = status
        .as_object_mut()
        .ok_or_else(|| "The source-backup status was not a JSON object.".to_string())?;
    object.insert(
        "workflow_schedule".to_string(),
        source_backup_task_status(&paths.workflow_task_name, &paths.runner),
    );
    object.insert(
        "heartbeat_schedule".to_string(),
        source_backup_task_status(&paths.heartbeat_task_name, &paths.runner),
    );
    object.insert(
        "daily_schedule".to_string(),
        Value::String(format!(
            "Daily {} local time",
            format_clock(paths.daily_minute)
        )),
    );
    object.insert(
        "weekly_backup_schedule".to_string(),
        Value::String(format!(
            "{} during the daily workflow",
            paths.backup_weekday
        )),
    );
    object.insert(
        "heartbeat_schedule_label".to_string(),
        Value::String(format!(
            "{} {} local time",
            paths.heartbeat_day,
            format_clock(paths.heartbeat_minute)
        )),
    );
    object.insert(
        "workflow_time".to_string(),
        Value::String(format_clock(paths.daily_minute)),
    );
    object.insert(
        "backup_weekday".to_string(),
        Value::String(paths.backup_weekday.clone()),
    );
    object.insert(
        "heartbeat_day".to_string(),
        Value::String(paths.heartbeat_day.clone()),
    );
    object.insert(
        "heartbeat_time".to_string(),
        Value::String(format_clock(paths.heartbeat_minute)),
    );
    Ok(status)
}

#[tauri::command]
fn run_source_backup(action: String) -> Result<Value, String> {
    if !matches!(
        action.as_str(),
        "check" | "workflow" | "refresh" | "backup" | "heartbeat" | "map_tiles"
    ) {
        return Err(format!("Unsupported source-backup action: {action}"));
    }
    let paths = source_backup_paths()?;
    let current = source_backup_runner_result(&paths)?;
    if current
        .get("state")
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        == Some("running")
    {
        return Err("A source-backup task is already running.".to_string());
    }
    let mut arguments = source_backup_runner_arguments(&paths);
    arguments.extend(["--action".to_string(), action.clone()]);
    let mut process = Command::new(&paths.python_executable);
    process
        .args(&arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    process.creation_flags(CREATE_NO_WINDOW);
    let child = process
        .spawn()
        .map_err(|error| format!("Could not start the source-backup task: {error}"))?;
    let process_id = child.id();
    drop(child);
    Ok(serde_json::json!({
        "status": "started",
        "action": action,
        "process_id": process_id,
    }))
}

fn quote_task_argument(value: &str) -> String {
    if value.contains(' ') || value.contains('\\') {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

fn register_source_backup_task(paths: &SourceBackupPaths, schedule: &str) -> Result<(), String> {
    let (task_name, action, schedule_kind, day, minute) = match schedule {
        "workflow" => (
            &paths.workflow_task_name,
            "workflow",
            "DAILY",
            None,
            paths.daily_minute,
        ),
        "heartbeat" => (
            &paths.heartbeat_task_name,
            "heartbeat",
            "WEEKLY",
            Some(paths.heartbeat_day.as_str()),
            paths.heartbeat_minute,
        ),
        _ => return Err(format!("Unsupported source-backup schedule: {schedule}")),
    };
    let executable = windowless_python_executable(&paths.python_executable)
        .unwrap_or_else(|| paths.python_executable.clone());
    // The runner resolves config/workstation-manager.settings.json relative to
    // itself. Omitting the settings path keeps Task Scheduler's /TR command
    // safely below its Windows length limit.
    let runner_arguments = vec![
        paths.runner.display().to_string(),
        "--action".to_string(),
        action.to_string(),
    ];
    let task_command = format!(
        "\"{}\" {}",
        executable,
        runner_arguments
            .iter()
            .map(|argument| quote_task_argument(argument))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let mut arguments = vec![
        "/Create".to_string(),
        "/TN".to_string(),
        task_name.to_string(),
        "/SC".to_string(),
        schedule_kind.to_string(),
        "/ST".to_string(),
        format_clock(minute),
        "/TR".to_string(),
        task_command,
        "/F".to_string(),
    ];
    if let Some(day) = day {
        arguments.extend(["/D".to_string(), day.to_string()]);
    }
    run_hidden("schtasks.exe", &arguments).map(|_| ())
}

#[tauri::command]
fn set_source_backup_schedule(schedule: String, enabled: bool) -> Result<Value, String> {
    let paths = source_backup_paths()?;
    let task_name = match schedule.as_str() {
        "workflow" => &paths.workflow_task_name,
        "heartbeat" => &paths.heartbeat_task_name,
        _ => return Err(format!("Unsupported source-backup schedule: {schedule}")),
    };
    if enabled {
        register_source_backup_task(&paths, &schedule)?;
    } else if source_backup_task_status(task_name, &paths.runner)
        .get("registered")
        .and_then(Value::as_bool)
        == Some(true)
    {
        run_hidden(
            "schtasks.exe",
            &[
                "/Delete".to_string(),
                "/TN".to_string(),
                task_name.to_string(),
                "/F".to_string(),
            ],
        )?;
    }
    source_backup_status()
}

#[tauri::command]
fn save_source_backup_schedule(
    workflow_time: String,
    backup_weekday: String,
    heartbeat_day: String,
    heartbeat_time: String,
) -> Result<Value, String> {
    let workflow_time = required_clock(&workflow_time, "Daily workflow time")?;
    let backup_weekday = required_weekday(&backup_weekday, "Archive weekday")?;
    let heartbeat_day = required_weekday(&heartbeat_day, "Heartbeat weekday")?;
    let heartbeat_time = required_clock(&heartbeat_time, "Heartbeat time")?;
    let paths = source_backup_paths()?;
    let workflow_registered = source_backup_task_status(&paths.workflow_task_name, &paths.runner)
        .get("registered")
        .and_then(Value::as_bool)
        == Some(true);
    let heartbeat_registered = source_backup_task_status(&paths.heartbeat_task_name, &paths.runner)
        .get("registered")
        .and_then(Value::as_bool)
        == Some(true);

    let mut settings = read_json(&paths.manager_settings)?;
    let object = settings
        .as_object_mut()
        .ok_or_else(|| "The workstation manager settings must be a JSON object.".to_string())?;
    object.insert(
        "sourceBackupDailyTime".to_string(),
        Value::String(workflow_time),
    );
    object.insert(
        "sourceBackupWeekday".to_string(),
        Value::String(backup_weekday),
    );
    object.insert(
        "sourceBackupHeartbeatDay".to_string(),
        Value::String(heartbeat_day),
    );
    object.insert(
        "sourceBackupHeartbeatTime".to_string(),
        Value::String(heartbeat_time),
    );
    write_json_replace(&paths.manager_settings, &settings)
        .map_err(|error| format!("Could not save source-backup schedule settings: {error}"))?;

    let updated_paths = source_backup_paths()?;
    if workflow_registered {
        register_source_backup_task(&updated_paths, "workflow")?;
    }
    if heartbeat_registered {
        register_source_backup_task(&updated_paths, "heartbeat")?;
    }
    source_backup_status()
}

#[tauri::command]
fn repository_status() -> Result<Value, String> {
    repository_task("repository.status", None, None)
}

#[tauri::command]
fn validate_repository(network_root: Option<String>) -> Result<Value, String> {
    repository_task("repository.validate", network_root.as_deref(), None)
}

#[tauri::command]
fn inspect_repository(network_root: String) -> Result<Value, String> {
    repository_task("repository.inspect", Some(&network_root), None)
}

#[tauri::command]
fn configure_repository(network_root: String, confirmation: String) -> Result<Value, String> {
    repository_task(
        "repository.configure",
        Some(&network_root),
        Some(&confirmation),
    )
}

#[tauri::command]
fn bootstrap_repository(network_root: String, confirmation: String) -> Result<Value, String> {
    repository_task(
        "repository.bootstrap",
        Some(&network_root),
        Some(&confirmation),
    )
}

#[tauri::command]
fn browse_repository_folder(initial_path: Option<String>) -> Result<Option<String>, String> {
    let script = "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select the Portal shared repository root'; if ($args[0] -and (Test-Path -LiteralPath $args[0] -PathType Container)) { $dialog.SelectedPath = $args[0] }; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }";
    let output = run_hidden(
        "powershell.exe",
        &[
            "-NoProfile".to_string(),
            "-STA".to_string(),
            "-Command".to_string(),
            script.to_string(),
            initial_path.unwrap_or_default(),
        ],
    )?;
    let selected = output.trim();
    Ok((!selected.is_empty()).then(|| selected.to_string()))
}

#[tauri::command]
fn portal_release_status(channel: Option<String>) -> Result<PortalReleaseStatus, String> {
    portal_release_status_value(channel.as_deref())
}

#[tauri::command]
fn publish_system_catalog_data(environment: Option<String>) -> Result<Value, String> {
    require_manager_system_admin()?;
    // The same channel vocabulary as software releases: production or test.
    let environment = normalize_release_channel(environment.as_deref())?;
    // Flush pending catalog writes before copying the authoritative database.
    close_portal_python_worker()?;
    let paths = portal_release_paths()?;
    let publication = publish_system_catalog(&paths.system_db, &environment)?;
    let message = if environment == "test" {
        "The system catalog was published to the TEST data tree. Only desktops pointed at the test data root will activate it."
    } else {
        "The system catalog was published as Portal data. Desktop encrypts it with SQLCipher during local activation."
    };
    Ok(serde_json::json!({
        "status": "succeeded",
        "message": message,
        "environment": environment,
        "publication": publication
    }))
}

#[tauri::command]
fn publish_portal_release(
    app: AppHandle,
    update_mode: String,
    channel: String,
    allowed_machines: Vec<String>,
) -> Result<PortalReleaseStatus, String> {
    publish_portal_release_value(&app, &update_mode, &channel, allowed_machines)
}

#[tauri::command]
fn save_portal_release_test_machines(machines: Vec<String>) -> Result<PortalReleaseStatus, String> {
    require_manager_system_admin()?;
    let machines = normalized_machine_names(machines)?;
    save_release_test_machines(&machines)?;
    portal_release_status_value(Some("test"))
}

#[tauri::command]
fn promote_test_release(app: AppHandle) -> Result<PortalReleaseStatus, String> {
    promote_test_release_value(&app)
}

#[tauri::command]
fn schema_status() -> Result<Value, String> {
    schema_task("schema.status", None)
}

#[tauri::command]
fn schema_catalog() -> Result<Value, String> {
    schema_task("schema.catalog", None)
}

fn schema_draft_path() -> Result<PathBuf, String> {
    let paths = repository_paths()?;
    let parent = paths.portal_settings.parent().ok_or_else(|| {
        "The Portal settings file has no parent directory for the schema draft.".to_string()
    })?;
    Ok(parent.join("schema.draft.json"))
}

#[tauri::command]
fn save_schema_draft(base_release_id: String, operations: Value) -> Result<Value, String> {
    if !operations.is_array() {
        return Err("Schema draft operations must be an array.".to_string());
    }
    let path = schema_draft_path()?;
    let previous = fs::read(&path).ok();
    write_json_replace(
        &path,
        &serde_json::json!({
            "base_release_id": base_release_id,
            "operations": operations,
        }),
    )?;
    match schema_task("schema.catalog", None) {
        Ok(result) => Ok(result),
        Err(error) => {
            if let Some(contents) = previous {
                let _ = fs::write(&path, contents);
            } else {
                let _ = fs::remove_file(&path);
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn discard_schema_draft() -> Result<Value, String> {
    let path = schema_draft_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| {
            format!("Could not discard schema draft {}: {error}", path.display())
        })?;
    }
    schema_task("schema.catalog", None)
}

#[tauri::command]
fn test_schema_draft() -> Result<Value, String> {
    schema_task("schema.test-draft", None)
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
fn register_schema() -> Result<Value, String> {
    schema_task("schema.register", None)
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
fn maintenance_snapshot_status() -> Result<Value, String> {
    maintenance_task("snapshot.status", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_validate() -> Result<Value, String> {
    maintenance_task("snapshot.validate", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_publish(confirmation: String) -> Result<Value, String> {
    maintenance_task("snapshot.publish", Some(&confirmation), None, None)
}

#[tauri::command]
fn maintenance_snapshot_retention_plan() -> Result<Value, String> {
    maintenance_task("snapshot.retention-plan", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_retention_apply(confirmation: String) -> Result<Value, String> {
    maintenance_task("snapshot.retention.apply", Some(&confirmation), None, None)
}

#[tauri::command]
fn maintenance_snapshot_retention_schedule_status() -> Result<Value, String> {
    maintenance_task("snapshot.retention.schedule.status", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_retention_schedule_enable() -> Result<Value, String> {
    maintenance_task("snapshot.retention.schedule.enable", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_retention_schedule_disable() -> Result<Value, String> {
    maintenance_task("snapshot.retention.schedule.disable", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_nightly_run() -> Result<Value, String> {
    maintenance_task("snapshot.nightly.run", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_nightly_schedule_status() -> Result<Value, String> {
    maintenance_task("snapshot.nightly.schedule.status", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_nightly_schedule_enable() -> Result<Value, String> {
    maintenance_task("snapshot.nightly.schedule.enable", None, None, None)
}

#[tauri::command]
fn maintenance_snapshot_nightly_schedule_disable() -> Result<Value, String> {
    maintenance_task("snapshot.nightly.schedule.disable", None, None, None)
}

#[tauri::command]
fn maintenance_backup_status() -> Result<Value, String> {
    maintenance_task("backup.status", None, None, None)
}

#[tauri::command]
fn maintenance_backup_verify() -> Result<Value, String> {
    maintenance_task("backup.verify", None, None, None)
}

#[tauri::command]
fn maintenance_backup_restore_active(confirmation: String) -> Result<Value, String> {
    maintenance_task("backup.restore-active", Some(&confirmation), None, None)
}

#[tauri::command]
fn maintenance_conflict_list() -> Result<Value, String> {
    maintenance_task("conflict.list", None, None, None)
}

#[tauri::command]
fn maintenance_conflict_export() -> Result<Value, String> {
    maintenance_task("conflict.export", None, None, None)
}

#[tauri::command]
fn maintenance_log_list(selected_date: String) -> Result<Value, String> {
    maintenance_task("log.list", None, Some(&selected_date), None)
}

#[tauri::command]
fn maintenance_activity_list(selected_date: String) -> Result<Value, String> {
    maintenance_task("activity.list", None, Some(&selected_date), None)
}

#[tauri::command]
fn maintenance_settings_status() -> Result<Value, String> {
    maintenance_task("settings.status", None, None, None)
}

#[tauri::command]
fn maintenance_update_network_root(network_root: String) -> Result<Value, String> {
    maintenance_task(
        "settings.update-network-root",
        None,
        None,
        Some(&network_root),
    )
}

#[tauri::command]
fn maintenance_update_retention_policy(
    operation_online_days: i64,
    verified_snapshot_count: i64,
) -> Result<Value, String> {
    maintenance_task_with_extra(
        "settings.update-retention-policy",
        None,
        None,
        None,
        &[
            ("--operation-online-days", operation_online_days.to_string()),
            (
                "--verified-snapshot-count",
                verified_snapshot_count.to_string(),
            ),
        ],
    )
}

#[tauri::command]
fn portal_management_session() -> Result<Value, String> {
    portal_management_session_value()
}

#[tauri::command]
fn manager_startup_session() -> Result<Value, String> {
    manager_startup_session_value()
}

#[tauri::command]
fn python_request(request: Value) -> Result<Value, String> {
    run_portal_python_request(&request)
}

#[tauri::command]
fn management_request(mut request: Value) -> Result<Value, String> {
    let paths = portal_runtime_paths()?;
    let object = request
        .as_object_mut()
        .ok_or_else(|| "The management request must be a JSON object.".to_string())?;
    object.insert(
        "_settings_path".to_string(),
        Value::String(paths.config_file.to_string_lossy().to_string()),
    );
    run_portal_python_job("management", &request)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("No path was supplied.".to_string());
    }
    let candidate = PathBuf::from(&path);
    if !candidate.exists() {
        return Err(format!(
            "The configured path is not available: {}",
            candidate.display()
        ));
    }
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("Could not resolve {}: {error}", candidate.display()))?;
    let mut command = Command::new("explorer.exe");
    if resolved.is_file() {
        command.arg("/select,").arg(&resolved);
    } else {
        command.arg(&resolved);
    }
    let result = command
        .spawn()
        .map_err(|error| format!("Could not open the path: {error}"))?;
    drop(result);
    Ok(())
}

#[tauri::command]
fn open_file_location(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("No file path was supplied.".to_string());
    }
    let candidate = PathBuf::from(&path);
    if !candidate.is_file() {
        return Err(format!(
            "The file is not available: {}",
            candidate.display()
        ));
    }
    let result = Command::new("explorer.exe")
        .arg("/select,")
        .arg(&candidate)
        .spawn()
        .map_err(|error| format!("Could not open Explorer for the file: {error}"))?;
    drop(result);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let (Some(icon), Some(window)) = (
                app.default_window_icon().cloned(),
                app.get_webview_window("main"),
            ) {
                window.set_icon(icon)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sync_status,
            update_source_sync_interval,
            start_scheduler,
            run_source_sync,
            check_source_sync,
            stop_scheduler,
            enable_source_scheduler_schedule,
            disable_source_scheduler_schedule,
            source_backup_status,
            run_source_backup,
            set_source_backup_schedule,
            save_source_backup_schedule,
            repository_status,
            validate_repository,
            inspect_repository,
            configure_repository,
            bootstrap_repository,
            browse_repository_folder,
            portal_release_status,
            publish_system_catalog_data,
            publish_portal_release,
            save_portal_release_test_machines,
            promote_test_release,
            schema_status,
            schema_catalog,
            save_schema_draft,
            discard_schema_draft,
            test_schema_draft,
            validate_schema,
            plan_schema,
            register_schema,
            initialize_schema,
            migrate_schema,
            maintenance_snapshot_status,
            maintenance_snapshot_validate,
            maintenance_snapshot_publish,
            maintenance_snapshot_retention_plan,
            maintenance_snapshot_retention_apply,
            maintenance_snapshot_retention_schedule_status,
            maintenance_snapshot_retention_schedule_enable,
            maintenance_snapshot_retention_schedule_disable,
            maintenance_snapshot_nightly_run,
            maintenance_snapshot_nightly_schedule_status,
            maintenance_snapshot_nightly_schedule_enable,
            maintenance_snapshot_nightly_schedule_disable,
            maintenance_backup_status,
            maintenance_backup_verify,
            maintenance_backup_restore_active,
            maintenance_conflict_list,
            maintenance_conflict_export,
            maintenance_log_list,
            maintenance_activity_list,
            maintenance_settings_status,
            maintenance_update_network_root,
            maintenance_update_retention_policy,
            portal_management_session,
            manager_startup_session,
            python_request,
            management_request,
            open_path,
            open_file_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running Portal Manager");
}

#[cfg(test)]
mod tests {
    use super::{
        create_release_zip, display_timestamp, exclude_plaintext_system_database,
        normalized_machine_names, release_channel_root, PortalReleasePaths,
    };
    use std::{env, fs, process, process::Command, time::SystemTime};

    #[test]
    fn a_packaged_system_database_is_excluded_instead_of_blocking() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("test time")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "portal-manager-release-test-{}-{unique}",
            process::id()
        ));
        let manager_database = root.join("manager").join("system.db");
        let desktop_database = root.join("desktop").join("config").join("system.db");
        fs::create_dir_all(manager_database.parent().expect("manager parent"))
            .expect("manager directory");
        fs::create_dir_all(desktop_database.parent().expect("desktop parent"))
            .expect("desktop directory");
        fs::write(&manager_database, b"authoritative-system-catalog")
            .expect("authoritative database");

        let paths = PortalReleasePaths {
            portable_root: root.join("desktop"),
            release_root: root.join("release"),
            portal_exe: root.join("desktop").join("Portal.exe"),
            system_db: manager_database.clone(),
            updater: root
                .join("desktop")
                .join("runtime")
                .join("PortalUpdater.exe"),
            remover: root.join("desktop").join("Remove-Portal.bat"),
            version_file: root.join("desktop").join("VERSION"),
        };

        assert!(!exclude_plaintext_system_database(&paths).expect("release without database"));
        assert!(!fs::metadata(&manager_database)
            .expect("manager metadata")
            .permissions()
            .readonly());

        // A catalog left behind by a Portal session is removed, and the release
        // carries on instead of failing.
        fs::write(&desktop_database, b"plaintext catalog").expect("desktop database");
        let mut readonly = fs::metadata(&desktop_database)
            .expect("desktop metadata")
            .permissions();
        readonly.set_readonly(true);
        fs::set_permissions(&desktop_database, readonly).expect("read-only catalog");
        assert!(exclude_plaintext_system_database(&paths).expect("catalog excluded"));
        assert!(!desktop_database.exists());

        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn test_release_targets_are_normalized_and_deduplicated() {
        assert_eq!(
            normalized_machine_names(vec![
                " test-pc-02,TEST-PC-01 ".to_string(),
                "test-pc-01".to_string()
            ])
            .expect("valid names"),
            vec!["TEST-PC-01".to_string(), "TEST-PC-02".to_string()]
        );
        assert!(normalized_machine_names(vec!["bad\\computer".to_string()]).is_err());
        let root = std::path::Path::new(r"G:\PortalRelease");
        assert_eq!(release_channel_root(root, "production"), root);
        assert_eq!(release_channel_root(root, "test"), root.join("test"));
    }

    #[test]
    fn complete_release_archive_excludes_the_data_sync_directory() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("test time")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "portal-manager-archive-test-{}-{unique}",
            process::id()
        ));
        let source = root.join("source");
        let archive = root.join("Portal-Desktop-test.zip");
        fs::create_dir_all(source.join("data")).expect("data directory");
        fs::create_dir_all(source.join("config")).expect("config directory");
        fs::write(source.join("Portal.exe"), b"portal").expect("application file");
        fs::write(
            source.join("config").join("system.db"),
            b"user-specific catalog",
        )
        .expect("runtime catalog");
        fs::write(source.join("data").join("keep-me.db"), b"user data").expect("data file");

        create_release_zip(&source, &archive).expect("release archive");
        let listing = Command::new("tar.exe")
            .args(["-t", "-f"])
            .arg(&archive)
            .output()
            .expect("archive listing");
        assert!(listing.status.success());
        let entries = String::from_utf8_lossy(&listing.stdout).replace('\\', "/");
        assert!(entries.contains("Portal.exe"));
        assert!(!entries.contains("config/system.db"));
        assert!(!entries.contains("data/"));
        assert!(!entries.contains("keep-me.db"));

        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn synchronization_timestamps_remain_parseable_for_os_formatting() {
        assert_eq!(
            display_timestamp(Some("2026-08-06T16:10:20.831727-04:00")),
            "2026-08-06T16:10:20.831727-04:00"
        );
        assert_eq!(
            display_timestamp(Some("2026-08-06T16:10:20Z")),
            "2026-08-06T16:10:20Z"
        );
        assert_eq!(display_timestamp(None), "-");
    }
}
