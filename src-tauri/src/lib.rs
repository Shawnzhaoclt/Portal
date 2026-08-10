use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::http::{header, Request as HttpRequest, Response as HttpResponse, StatusCode};
use tauri::Manager;

mod business_sync;

#[cfg(target_os = "windows")]
use std::os::windows::{ffi::OsStrExt, process::CommandExt};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::SYSTEMTIME;
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::SystemInformation::GetLocalTime;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Shell::ShellExecuteW;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const MAINTENANCE_SPLASH_DURATION: Duration = Duration::from_secs(15);
const MAINTENANCE_MONITOR_INTERVAL: Duration = Duration::from_secs(5);
const MAX_EXCEL_EXPORT_BYTES: usize = 100 * 1024 * 1024;

fn is_scheduled_maintenance_hour(hour: u16) -> bool {
    hour >= 22 || hour < 5
}

#[cfg(target_os = "windows")]
fn local_hour() -> Option<u16> {
    let mut local_time: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut local_time) };
    Some(local_time.wHour)
}

#[cfg(not(target_os = "windows"))]
fn local_hour() -> Option<u16> {
    None
}

fn start_maintenance_exit_monitor(app: tauri::AppHandle) {
    thread::spawn(move || {
        if local_hour().is_some_and(is_scheduled_maintenance_hour) {
            // The renderer displays the 15-second countdown. Keep the native
            // fallback one monitor interval behind it so the host cannot exit
            // before a runtime transition has shown the complete countdown.
            thread::sleep(MAINTENANCE_SPLASH_DURATION + MAINTENANCE_MONITOR_INTERVAL);
            app.exit(0);
            return;
        }

        loop {
            thread::sleep(MAINTENANCE_MONITOR_INTERVAL);
            if local_hour().is_some_and(is_scheduled_maintenance_hour) {
                thread::sleep(MAINTENANCE_SPLASH_DURATION + MAINTENANCE_MONITOR_INTERVAL);
                app.exit(0);
                return;
            }
        }
    });
}

fn configure_system_database_access(system_database: &Path) -> Result<(), String> {
    let metadata = fs::metadata(system_database).map_err(|error| {
        format!(
            "Could not read the Portal system database at {}: {error}",
            system_database.display()
        )
    })?;
    let mut permissions = metadata.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(system_database, permissions).map_err(|error| {
        format!(
            "Could not set access for the Portal system database at {}: {error}",
            system_database.display()
        )
    })?;
    Ok(())
}

#[derive(Clone, Debug)]
struct WindowsIdentity {
    email: String,
    username: String,
    employee_id: String,
    account: String,
}

impl WindowsIdentity {
    fn display_value(&self) -> String {
        [
            self.email.as_str(),
            self.account.as_str(),
            self.username.as_str(),
            self.employee_id.as_str(),
        ]
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .unwrap_or("unresolved Windows account")
        .to_string()
    }
}

fn normalize_windows_identity(value: &str) -> String {
    value.trim().to_lowercase()
}

fn windows_account_component(value: &str) -> String {
    value
        .trim()
        .rsplit_once('\\')
        .map(|(_, component)| component)
        .unwrap_or(value.trim())
        .rsplit_once('/')
        .map(|(_, component)| component)
        .unwrap_or_else(|| value.trim())
        .to_string()
}

fn run_whoami(arguments: &[&str]) -> Option<String> {
    let mut command = Command::new("whoami.exe");
    command.args(arguments);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn windows_identity() -> Result<WindowsIdentity, String> {
    let email = [
        env::var("PORTAL_WINDOWS_EMAIL").ok(),
        env::var("USERPRINCIPALNAME").ok(),
        run_whoami(&["/upn"]),
    ]
    .into_iter()
    .flatten()
    .map(|value| normalize_windows_identity(&value))
    .find(|value| value.contains('@'))
    .unwrap_or_default();

    let account = [env::var("PORTAL_WINDOWS_ACCOUNT").ok(), run_whoami(&[]), {
        let domain = env::var("USERDOMAIN").unwrap_or_default();
        let username = env::var("USERNAME").unwrap_or_default();
        (!domain.trim().is_empty() && !username.trim().is_empty())
            .then(|| format!("{domain}\\{username}"))
    }]
    .into_iter()
    .flatten()
    .map(|value| normalize_windows_identity(&value))
    .find(|value| !value.is_empty())
    .unwrap_or_default();

    let username = [
        env::var("PORTAL_WINDOWS_USERNAME").ok(),
        env::var("USERNAME").ok(),
        (!account.is_empty()).then(|| windows_account_component(&account)),
    ]
    .into_iter()
    .flatten()
    .map(|value| normalize_windows_identity(&value))
    .find(|value| !value.is_empty())
    .unwrap_or_default();

    let employee_id = env::var("PORTAL_WINDOWS_EMPLOYEE_ID")
        .ok()
        .map(|value| normalize_windows_identity(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| username.clone());

    if email.is_empty() && username.is_empty() && employee_id.is_empty() && account.is_empty() {
        return Err(
            "Windows did not return an email, employee ID, or username for the signed-in account."
                .to_string(),
        );
    }

    Ok(WindowsIdentity {
        email,
        username,
        employee_id,
        account,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopContext {
    application_name: &'static str,
    application_version: String,
    runtime: &'static str,
    user_name: String,
    user_domain: String,
    device_name: String,
    data_root: String,
    cache_root: String,
    log_root: String,
    python_worker_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStartupSession {
    shared_data_root: String,
    windows_email: String,
    session: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalUpdateCheck {
    available: bool,
    current_version: String,
    release_version: Option<String>,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortalReleaseManifest {
    schema_version: u32,
    version: String,
    update_mode: String,
    payload: PortalReleasePayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortalReleasePayload {
    file: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PythonHealth {
    ok: bool,
    worker: String,
    python_version: String,
    executable: String,
}

struct PythonWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_request_id: u64,
}

impl PythonWorker {
    fn call(
        &mut self,
        job: &str,
        request: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.next_request_id += 1;
        let request_id = self.next_request_id;
        let message = serde_json::json!({
            "id": request_id,
            "job": job,
            "request": request,
        });
        serde_json::to_writer(&mut self.stdin, &message)
            .map_err(|error| format!("Could not encode the Python worker request: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("Could not send the request to Python: {error}"))?;

        let mut response_line = String::new();
        let bytes_read = self
            .stdout
            .read_line(&mut response_line)
            .map_err(|error| format!("Could not read the Python worker response: {error}"))?;
        if bytes_read == 0 {
            let status = self
                .child
                .try_wait()
                .ok()
                .flatten()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            return Err(format!(
                "The Python worker closed its response stream (status {status})."
            ));
        }

        let response: serde_json::Value = serde_json::from_str(response_line.trim())
            .map_err(|error| format!("Python worker returned invalid JSON: {error}"))?;
        if response.get("id").and_then(serde_json::Value::as_u64) != Some(request_id) {
            return Err("Python worker returned a response for the wrong request.".to_string());
        }
        if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            return Err(response
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Python worker command failed.")
                .to_string());
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| "Python worker response did not include a result.".to_string())
    }
}

impl Drop for PythonWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static PYTHON_WORKER: OnceLock<Mutex<Option<PythonWorker>>> = OnceLock::new();

fn spawn_python_worker() -> Result<PythonWorker, String> {
    let worker = python_worker_path()?;
    let data_root = local_data_root()?;
    initialize_local_directories(&data_root)?;
    let application_root = installation_root()?;
    let system_database = system_database_path()?;
    let config_file = portal_config_path()?;
    let business_database =
        business_sync::local_business_database_path(&config_file, &application_root, &data_root)?;
    let windows_identity = windows_identity()?;
    configure_system_database_access(&system_database)?;
    let business_sync = business_sync::load_paths(&config_file, &application_root, &data_root)?;
    let mut command = Command::new(&worker);
    command
        .arg("--serve")
        .env("PORTAL_DESKTOP_MODE", "1")
        .env("PORTAL_APP_ROOT", &application_root)
        .env("PORTAL_DATA_ROOT", &data_root)
        .env("PORTAL_CONFIG_FILE", config_file)
        .env("PORTAL_WINDOWS_EMAIL", &windows_identity.email)
        .env("PORTAL_WINDOWS_USERNAME", &windows_identity.username)
        .env("PORTAL_WINDOWS_EMPLOYEE_ID", &windows_identity.employee_id)
        .env("PORTAL_WINDOWS_ACCOUNT", &windows_identity.account)
        .env("PORTAL_SYSTEM_DB", &system_database)
        .env("PORTAL_SYSTEM_DB_WRITE_ENABLED", "0")
        .env("PORTAL_BUSINESS_DB", business_database)
        .env("PORTAL_MANAGEMENT_DB", &system_database)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(paths) = business_sync.as_ref() {
        for (name, value) in business_sync::environment(paths) {
            command.env(name, value);
        }
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", worker.display()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open the Python worker input stream.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not open the Python worker output stream.".to_string())?;
    Ok(PythonWorker {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_request_id: 0,
    })
}

fn run_python_job(job: &str, request: &serde_json::Value) -> Result<serde_json::Value, String> {
    let worker_state = PYTHON_WORKER.get_or_init(|| Mutex::new(None));
    let mut worker = worker_state
        .lock()
        .map_err(|_| "The Python worker lock is unavailable.".to_string())?;
    if worker.is_none() {
        *worker = Some(spawn_python_worker()?);
    }

    let result = worker
        .as_mut()
        .expect("Python worker initialized")
        .call(job, request);
    if result.is_err() {
        *worker = None;
    }
    result
}

fn protocol_request(request: &HttpRequest<Vec<u8>>) -> serde_json::Value {
    let mut query = serde_json::Map::new();
    if let Some(raw_query) = request.uri().query() {
        for (key, value) in url::form_urlencoded::parse(raw_query.as_bytes()) {
            let key = key.into_owned();
            let value = serde_json::Value::String(value.into_owned());
            match query.get_mut(&key) {
                Some(serde_json::Value::Array(values)) => values.push(value),
                Some(existing) => {
                    let first = existing.take();
                    *existing = serde_json::Value::Array(vec![first, value]);
                }
                None => {
                    query.insert(key, value);
                }
            }
        }
    }
    let headers = request
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| {
                (
                    name.as_str().to_string(),
                    serde_json::Value::String(value.to_string()),
                )
            })
        })
        .collect::<serde_json::Map<String, serde_json::Value>>();
    let body = if request.body().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(request.body()).unwrap_or_else(|_| {
            serde_json::Value::String(String::from_utf8_lossy(request.body()).into_owned())
        })
    };

    serde_json::json!({
        "method": request.method().as_str(),
        "path": request.uri().path(),
        "query": query,
        "headers": headers,
        "body": body,
    })
}

fn response_builder(
    status: u16,
    media_type: Option<&str>,
    extra_headers: Option<&serde_json::Map<String, serde_json::Value>>,
) -> tauri::http::response::Builder {
    let mut builder = HttpResponse::builder().status(status);
    if let Some(media_type) = media_type {
        builder = builder.header(header::CONTENT_TYPE, media_type);
    }
    if let Some(headers) = extra_headers {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                builder = builder.header(name, value);
            }
        }
    }
    builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
}

const INITIAL_MEDIA_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

fn file_response_range(
    range_header: Option<&str>,
    file_size: u64,
    is_media: bool,
) -> (u64, u64, u16) {
    let last_byte = file_size.saturating_sub(1);
    if file_size == 0 {
        return (0, 0, StatusCode::OK.as_u16());
    }

    let parsed_range = range_header
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.split(',').next())
        .and_then(|value| value.trim().split_once('-'));

    if let Some((start_text, end_text)) = parsed_range {
        let start_text = start_text.trim();
        let end_text = end_text.trim();

        if start_text.is_empty() {
            // Suffix ranges such as bytes=-524288 are commonly used to read an
            // MP4 moov box stored at the end of a large inspection video.
            let suffix_length = end_text.parse::<u64>().unwrap_or(1).max(1);
            let start = file_size.saturating_sub(suffix_length.min(file_size));
            return (start, last_byte, StatusCode::PARTIAL_CONTENT.as_u16());
        }

        let start = start_text.parse::<u64>().unwrap_or(0).min(last_byte);
        let end = if end_text.is_empty() {
            if is_media {
                start
                    .saturating_add(INITIAL_MEDIA_CHUNK_BYTES - 1)
                    .min(last_byte)
            } else {
                last_byte
            }
        } else {
            end_text.parse::<u64>().unwrap_or(last_byte).min(last_byte)
        };
        return (start, end.max(start), StatusCode::PARTIAL_CONTENT.as_u16());
    }

    if is_media && file_size > INITIAL_MEDIA_CHUNK_BYTES {
        return (
            0,
            INITIAL_MEDIA_CHUNK_BYTES - 1,
            StatusCode::PARTIAL_CONTENT.as_u16(),
        );
    }

    (0, last_byte, StatusCode::OK.as_u16())
}

fn file_protocol_response(
    request: &HttpRequest<Vec<u8>>,
    envelope: &serde_json::Value,
) -> Result<HttpResponse<Vec<u8>>, String> {
    let path = envelope
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Python file response did not include a path.".to_string())?;
    let mut file = File::open(path).map_err(|error| format!("Could not open {path}: {error}"))?;
    let file_size = file
        .metadata()
        .map_err(|error| format!("Could not inspect {path}: {error}"))?
        .len();
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    // Media elements sometimes issue their initial metadata request without a
    // Range header. Returning the whole file in that case turns a small video
    // probe into a multi-hundred-megabyte SMB read. Supply a normal first range
    // instead; Chromium will request subsequent ranges while it plays or seeks.
    let is_media = envelope
        .get("mediaType")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|media_type| {
            media_type.starts_with("video/") || media_type.starts_with("audio/")
        });
    let (start, end, status) = file_response_range(range_header, file_size, is_media);
    let length = if file_size == 0 { 0 } else { end - start + 1 };
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("Could not seek {path}: {error}"))?;
    let mut bytes = Vec::with_capacity(length.min(16 * 1024 * 1024) as usize);
    file.take(length)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {path}: {error}"))?;

    let mut builder = response_builder(
        status,
        envelope
            .get("mediaType")
            .and_then(serde_json::Value::as_str),
        envelope
            .get("headers")
            .and_then(serde_json::Value::as_object),
    )
    .header(header::ACCEPT_RANGES, "bytes")
    .header(header::CONTENT_LENGTH, bytes.len().to_string());
    if status == StatusCode::PARTIAL_CONTENT.as_u16() {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{file_size}"),
        );
    }
    builder.body(bytes).map_err(|error| error.to_string())
}

fn local_protocol_response(request: HttpRequest<Vec<u8>>) -> HttpResponse<Vec<u8>> {
    let result = run_python_job("request", &protocol_request(&request));
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            return response_builder(500, Some("text/plain; charset=utf-8"), None)
                .body(error.into_bytes())
                .expect("valid local protocol error response")
        }
    };
    let status = response
        .get("status")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(200) as u16;
    match response.get("kind").and_then(serde_json::Value::as_str) {
        Some("file") => file_protocol_response(&request, &response).unwrap_or_else(|error| {
            response_builder(500, Some("text/plain; charset=utf-8"), None)
                .body(error.into_bytes())
                .expect("valid file error response")
        }),
        Some("binary") => {
            let bytes = response
                .get("bytes")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(serde_json::Value::as_u64)
                        .map(|value| value as u8)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            response_builder(
                status,
                response
                    .get("mediaType")
                    .and_then(serde_json::Value::as_str),
                response
                    .get("headers")
                    .and_then(serde_json::Value::as_object),
            )
            .body(bytes)
            .expect("valid binary response")
        }
        Some("error") => {
            let error = response
                .get("error")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            response_builder(status, Some("application/json"), None)
                .body(
                    serde_json::to_vec(&serde_json::json!({ "detail": error })).unwrap_or_default(),
                )
                .expect("valid command error response")
        }
        _ => response_builder(status, Some("application/json"), None)
            .body(
                serde_json::to_vec(response.get("data").unwrap_or(&serde_json::Value::Null))
                    .unwrap_or_default(),
            )
            .expect("valid JSON response"),
    }
}

fn local_data_root() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "LOCALAPPDATA is not available for the current Windows user.".to_string())?;
    Ok(PathBuf::from(local_app_data).join("StormWaterPortal"))
}

fn initialize_local_directories(root: &Path) -> Result<(), String> {
    migrate_legacy_local_data(root)?;
    cleanup_legacy_portable_payload(root);
    for directory in [
        root.to_path_buf(),
        root.join("config"),
        root.join("data"),
        root.join("data").join("backups"),
        root.join("data").join("cache"),
        root.join("data").join("downloads"),
        root.join("data").join("exports"),
        root.join("data").join("inbox"),
        root.join("data").join("logs"),
        root.join("data").join("outbox"),
        root.join("data").join("temp"),
    ] {
        fs::create_dir_all(&directory).map_err(|error| {
            format!(
                "Could not create Portal directory {}: {error}",
                directory.display()
            )
        })?;
    }
    Ok(())
}

fn migrate_legacy_local_data(root: &Path) -> Result<(), String> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "LOCALAPPDATA is not available for the current Windows user.".to_string())?;
    fs::create_dir_all(root).map_err(|error| {
        format!(
            "Could not create Portal local root {}: {error}",
            root.display()
        )
    })?;

    let legacy_root = PathBuf::from(local_app_data).join("Portal");
    if legacy_root.is_dir() && legacy_root != root {
        migrate_directory_if_absent(&legacy_root.join("data"), &root.join("data"))?;
        for name in [
            "cache",
            "downloads",
            "exports",
            "inbox",
            "logs",
            "outbox",
            "temp",
        ] {
            migrate_directory_if_absent(&legacy_root.join(name), &root.join("data").join(name))?;
        }
    }

    for name in [
        "cache",
        "downloads",
        "exports",
        "inbox",
        "logs",
        "outbox",
        "temp",
    ] {
        migrate_directory_if_absent(&root.join(name), &root.join("data").join(name))?;
    }
    Ok(())
}

fn migrate_directory_if_absent(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() || destination.exists() {
        return Ok(());
    }
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Portal migration destination does not have a parent: {}",
            destination.display()
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    fs::rename(source, destination).map_err(|error| {
        format!(
            "Could not migrate Portal data {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn cleanup_legacy_portable_payload(root: &Path) {
    let Ok(executable_directory) = executable_root() else {
        return;
    };
    if executable_directory != root.join("app") || !root.join("app").join("Portal.exe").is_file() {
        return;
    }

    for file in ["Portal.exe", "README.txt", "VERSION", "manifest.json"] {
        let _ = fs::remove_file(root.join(file));
    }
    let legacy_runtime = root.join("runtime");
    if legacy_runtime.is_dir() {
        let _ = fs::remove_dir_all(legacy_runtime);
    }
    // Portable releases before 0.1.0 created this empty folder under the
    // replaceable application payload. User-owned state is root\\data instead.
    let legacy_application_data = root.join("app").join("data");
    if legacy_application_data.is_dir() {
        let _ = fs::remove_dir_all(legacy_application_data);
    }
}

fn executable_root() -> Result<PathBuf, String> {
    env::current_exe()
        .map_err(|error| format!("Could not resolve Portal.exe: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Portal.exe does not have a parent directory.".to_string())
}

fn installation_root() -> Result<PathBuf, String> {
    let executable_directory = executable_root()?;
    if executable_directory
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("app"))
    {
        if let Some(parent) = executable_directory.parent() {
            return Ok(parent.to_path_buf());
        }
    }
    Ok(executable_directory)
}

fn packaged_application_version(root: &Path) -> Option<String> {
    fs::read_to_string(root.join("VERSION"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn installed_application_version() -> String {
    installation_root()
        .ok()
        .and_then(|root| packaged_application_version(&root))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn portal_config_path() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("PORTAL_CONFIG_FILE") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            migrate_local_settings_paths(&path)?;
            return Ok(path);
        }
    }
    let installed = installation_root()?
        .join("config")
        .join("portal.settings.json");
    if installed.is_file() {
        migrate_local_settings_paths(&installed)?;
        return Ok(installed);
    }
    Err(
        "Portal settings were not found at config\\portal.settings.json beside Portal.exe."
            .to_string(),
    )
}

fn migrate_local_settings_paths(path: &Path) -> Result<(), String> {
    let contents = fs::read_to_string(path).map_err(|error| {
        format!(
            "Could not read Portal settings at {}: {error}",
            path.display()
        )
    })?;
    let trimmed = contents.trim_start_matches(['\u{feff}', '\u{0000}', ' ', '\t', '\r', '\n']);
    let mut settings: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };

    let replacements = [
        ("/business/inboxRoot", "${PORTAL_DATA_ROOT}/data/inbox"),
        ("/business/outboxRoot", "${PORTAL_DATA_ROOT}/data/outbox"),
        (
            "/application/exportRoot",
            "${PORTAL_DATA_ROOT}/data/exports",
        ),
        ("/application/logRoot", "${PORTAL_DATA_ROOT}/data/logs"),
        ("/application/tempRoot", "${PORTAL_DATA_ROOT}/data/temp"),
    ];
    let mut changed = false;
    for (pointer, replacement) in replacements {
        if let Some(serde_json::Value::String(value)) = settings.pointer_mut(pointer) {
            let legacy_value = match pointer {
                "/business/inboxRoot" => "${PORTAL_DATA_ROOT}/inbox",
                "/business/outboxRoot" => "${PORTAL_DATA_ROOT}/outbox",
                "/application/exportRoot" => "${PORTAL_DATA_ROOT}/exports",
                "/application/logRoot" => "${PORTAL_DATA_ROOT}/logs",
                "/application/tempRoot" => "${PORTAL_DATA_ROOT}/temp",
                _ => unreachable!(),
            };
            if value == legacy_value {
                *value = replacement.to_string();
                changed = true;
            }
        }
    }
    if changed {
        let text = serde_json::to_string_pretty(&settings)
            .map_err(|error| format!("Could not update Portal settings: {error}"))?;
        fs::write(path, format!("{text}\n")).map_err(|error| {
            format!(
                "Could not update Portal settings at {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn load_client_settings() -> Result<serde_json::Value, String> {
    let path = portal_config_path()?;
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "Could not read Portal settings at {}: {error}",
            path.display()
        )
    })?;
    let text = String::from_utf8(bytes).map_err(|error| {
        format!(
            "Portal settings are not valid UTF-8 at {}: {error}",
            path.display()
        )
    })?;
    let payload = text.trim_start_matches(['\u{feff}', '\u{0000}', ' ', '\t', '\r', '\n']);
    serde_json::from_str(payload)
        .map_err(|error| format!("Portal settings are invalid at {}: {error}", path.display()))
}

#[tauri::command]
fn client_settings() -> Result<serde_json::Value, String> {
    load_client_settings()
}

fn configured_shared_data_root(settings: &serde_json::Value) -> Result<PathBuf, String> {
    let raw_root = settings
        .pointer("/shared/dataRoot")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Portal settings do not define shared.dataRoot.".to_string())?;
    let application_root = installation_root()?.display().to_string();
    let data_root = local_data_root()?.display().to_string();
    let expanded = raw_root
        .replace("${PORTAL_APP_ROOT}", &application_root)
        .replace("${PORTAL_DATA_ROOT}", &data_root);
    if expanded.contains("${") {
        return Err(format!(
            "The configured shared data root contains an unresolved setting: {raw_root}"
        ));
    }
    Ok(PathBuf::from(expanded))
}

fn configured_update_release_root(settings: &serde_json::Value) -> Result<Option<PathBuf>, String> {
    let Some(raw_root) = settings
        .pointer("/updates/releaseRoot")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let application_root = installation_root()?.display().to_string();
    let data_root = local_data_root()?.display().to_string();
    let shared_root = configured_shared_data_root(settings)?.display().to_string();
    let expanded = raw_root
        .replace("${PORTAL_APP_ROOT}", &application_root)
        .replace("${PORTAL_DATA_ROOT}", &data_root)
        .replace("${PORTAL_SHARED_DATA_ROOT}", &shared_root);
    if expanded.contains("${") {
        return Err(format!(
            "The configured Portal update root contains an unresolved setting: {raw_root}"
        ));
    }
    Ok(Some(PathBuf::from(expanded)))
}

fn parse_portal_release_manifest(path: &Path) -> Result<PortalReleaseManifest, String> {
    let contents = fs::read_to_string(path).map_err(|error| {
        format!(
            "Could not read Portal release manifest {}: {error}",
            path.display()
        )
    })?;
    let manifest: PortalReleaseManifest =
        serde_json::from_str(contents.trim_start_matches('\u{feff}'))
            .map_err(|error| format!("Portal release manifest is invalid: {error}"))?;
    if manifest.schema_version != 1 || manifest.version.trim().is_empty() {
        return Err(
            "Portal release manifest has an unsupported schema or empty version.".to_string(),
        );
    }
    if !matches!(
        manifest.update_mode.as_str(),
        "system-db" | "portal-exe" | "full"
    ) {
        return Err("Portal release manifest has an unsupported updateMode.".to_string());
    }
    if manifest.payload.sha256.len() != 64
        || !manifest
            .payload
            .sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(
            "Portal release manifest contains an invalid payload SHA-256 value.".to_string(),
        );
    }
    let payload = Path::new(&manifest.payload.file);
    if payload.components().count() != 1 || payload.file_name().is_none() {
        return Err(
            "Portal release manifest payload.file must be a file name, not a path.".to_string(),
        );
    }
    Ok(manifest)
}

fn version_components(value: &str) -> Option<Vec<u64>> {
    let normalized = value
        .trim()
        .split_once('-')
        .map_or(value.trim(), |(core, _)| core);
    let values = normalized
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (!values.is_empty()).then_some(values)
}

fn release_is_newer(candidate: &str, current: &str) -> bool {
    let Some(mut candidate_parts) = version_components(candidate) else {
        return false;
    };
    let Some(mut current_parts) = version_components(current) else {
        return false;
    };
    let length = candidate_parts.len().max(current_parts.len());
    candidate_parts.resize(length, 0);
    current_parts.resize(length, 0);
    candidate_parts > current_parts
}

fn installed_release_version() -> String {
    let fallback = env!("CARGO_PKG_VERSION").to_string();
    let Ok(root) = installation_root() else {
        return fallback;
    };
    let state_path = root.join("config").join("update-state.json");
    let Ok(contents) = fs::read_to_string(state_path) else {
        return fallback;
    };
    let Some(version) = serde_json::from_str::<serde_json::Value>(&contents)
        .ok()
        .and_then(|value| value.get("version")?.as_str().map(str::to_string))
    else {
        return fallback;
    };
    if version_components(&version).is_some() {
        version
    } else {
        fallback
    }
}

fn available_portal_update() -> Result<Option<(PathBuf, PortalReleaseManifest)>, String> {
    let settings = load_client_settings()?;
    let Some(release_root) = configured_update_release_root(&settings)? else {
        return Ok(None);
    };
    if !release_root.is_dir() {
        return Ok(None);
    }
    let manifest_path = release_root.join("portal-release.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let manifest = parse_portal_release_manifest(&manifest_path)?;
    let payload = release_root.join(&manifest.payload.file);
    if !payload.is_file() {
        return Err(format!(
            "Portal release payload is missing: {}",
            payload.display()
        ));
    }
    let size = fs::metadata(&payload)
        .map_err(|error| format!("Could not inspect Portal release payload: {error}"))?
        .len();
    if size != manifest.payload.size {
        return Err("Portal release payload size does not match the release manifest.".to_string());
    }
    Ok(Some((release_root, manifest)))
}

#[tauri::command]
fn check_portal_update() -> Result<PortalUpdateCheck, String> {
    let current_version = installed_release_version();
    let Some((_release_root, manifest)) = available_portal_update()? else {
        return Ok(PortalUpdateCheck {
            available: false,
            current_version,
            release_version: None,
            message: "No Portal update release is available.".to_string(),
        });
    };
    let available = release_is_newer(&manifest.version, &current_version);
    Ok(PortalUpdateCheck {
        available,
        current_version,
        release_version: Some(manifest.version.clone()),
        message: if available {
            format!("Portal {} is ready to install.", manifest.version)
        } else {
            "Portal is already up to date.".to_string()
        },
    })
}

#[tauri::command]
fn install_portal_update(app: tauri::AppHandle) -> Result<(), String> {
    let Some((release_root, manifest)) = available_portal_update()? else {
        return Err("No Portal update release is available.".to_string());
    };
    let current_version = installed_release_version();
    if !release_is_newer(&manifest.version, &current_version) {
        return Err("Portal is already up to date.".to_string());
    }
    let updater = executable_root()?.join("runtime").join("PortalUpdater.exe");
    if !updater.is_file() {
        return Err(
            "The bundled Portal updater was not found under runtime\\PortalUpdater.exe."
                .to_string(),
        );
    }
    let temporary_updater = env::temp_dir().join(format!(
        "PortalUpdater-{}-{}.exe",
        std::process::id(),
        manifest.version
    ));
    fs::copy(&updater, &temporary_updater)
        .map_err(|error| format!("Could not prepare Portal updater: {error}"))?;
    let mut command = Command::new(&temporary_updater);
    command
        .arg("--release-root")
        .arg(&release_root)
        .arg("--install-root")
        .arg(installation_root()?)
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .arg("--restart");
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map_err(|error| format!("Could not start Portal updater: {error}"))?;
    app.exit(0);
    Ok(())
}

fn verify_shared_data_root(shared_root: &Path) -> Result<(), String> {
    if !shared_root.is_dir() || fs::read_dir(shared_root).is_err() {
        return Err(format!(
            "The Portal shared data location is not accessible at:\n\n{}\n\nCheck that the configured shared drive is connected and accessible, then start Portal again.",
            shared_root.display()
        ));
    }
    Ok(())
}

fn startup_preflight() -> Result<DesktopStartupSession, String> {
    let settings = load_client_settings()?;
    let shared_root = configured_shared_data_root(&settings)?;
    let shared_root_check = shared_root.clone();
    let shared_check = thread::spawn(move || verify_shared_data_root(&shared_root_check));

    let windows_identity = windows_identity()?;
    env::set_var("PORTAL_WINDOWS_EMAIL", &windows_identity.email);
    env::set_var("PORTAL_WINDOWS_USERNAME", &windows_identity.username);
    env::set_var("PORTAL_WINDOWS_EMPLOYEE_ID", &windows_identity.employee_id);
    env::set_var("PORTAL_WINDOWS_ACCOUNT", &windows_identity.account);
    let login_result = run_python_job(
        "request",
        &serde_json::json!({
            "method": "POST",
            "path": "/api/auth/desktop-login",
            "query": {},
            "headers": {},
            "body": null
        }),
    );
    shared_check
        .join()
        .map_err(|_| "The shared data availability check stopped unexpectedly.".to_string())??;
    let response = login_result?;
    let status = response
        .get("status")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(500);
    if status != 200 {
        if status != 401 && status != 403 {
            let detail = response
                .get("error")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Portal could not initialize its local business data.");
            return Err(format!(
                "Portal authenticated the signed-in Windows account, but could not synchronize its business data:\n\n{detail}\n\nOpen Portal Manager > Maintenance > Repository to validate the shared repository, then retry."
            ));
        }
        return Err(format!(
            "The signed-in Windows account is not registered as an active Portal user:\n\n{}\n\nContact the Portal developer for assistance.",
            windows_identity.display_value()
        ));
    }
    let session = response
        .get("data")
        .cloned()
        .ok_or_else(|| "Desktop sign-in did not return a Portal session.".to_string())?;
    Ok(DesktopStartupSession {
        shared_data_root: shared_root.display().to_string(),
        windows_email: windows_identity.email,
        session,
    })
}

#[tauri::command]
async fn desktop_startup_session() -> Result<DesktopStartupSession, String> {
    tauri::async_runtime::spawn_blocking(startup_preflight)
        .await
        .map_err(|error| format!("Portal startup task failed: {error}"))?
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed =
        url::Url::parse(&url).map_err(|error| format!("The external URL is invalid: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Portal can open only HTTP or HTTPS links in the web browser.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let wide_url = url
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                wide_url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err(format!(
                "Windows could not open the link (error {}).",
                result as isize
            ));
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Opening external links is supported only by the Windows desktop build.".to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExcelExportRequest {
    file_name: String,
    bytes: Vec<u8>,
}

fn validated_excel_export_file_name(candidate: &str) -> Result<String, String> {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return Err("The Excel export file name is empty.".to_string());
    }

    let path = Path::new(candidate);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The Excel export file name is invalid.".to_string())?;
    if file_name != candidate || candidate.ends_with('.') || candidate.ends_with(' ') {
        return Err("The Excel export file name must not contain a folder path.".to_string());
    }
    if candidate.chars().any(|value| {
        value < ' ' || matches!(value, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return Err("The Excel export file name contains an invalid character.".to_string());
    }
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("xlsx"))
    {
        return Err("Portal can open only .xlsx exports in Excel.".to_string());
    }

    Ok(file_name.to_string())
}

fn save_excel_export(
    download_directory: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    fs::create_dir_all(download_directory).map_err(|error| {
        format!(
            "Could not create the Windows Downloads folder at {}: {error}",
            download_directory.display()
        )
    })?;

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Portal export");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("xlsx");

    for sequence in 0..10_000 {
        let candidate_name = if sequence == 0 {
            file_name.to_string()
        } else {
            format!("{stem} ({sequence}).{extension}")
        };
        let candidate = download_directory.join(candidate_name);
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create the Excel export at {}: {error}",
                    candidate.display()
                ))
            }
        };

        if let Err(error) = file.write_all(bytes) {
            drop(file);
            let _ = fs::remove_file(&candidate);
            return Err(format!(
                "Could not write the Excel export at {}: {error}",
                candidate.display()
            ));
        }
        return Ok(candidate);
    }

    Err("Could not choose an available Excel export file name in Downloads.".to_string())
}

#[cfg(target_os = "windows")]
fn open_excel_export(path: &Path) -> Result<(), String> {
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            std::ptr::null(),
            wide_path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(format!(
            "Windows could not open the exported workbook in Excel (error {}).",
            result as isize
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn open_excel_export(_path: &Path) -> Result<(), String> {
    Err("Opening Excel exports is supported only by the Windows desktop build.".to_string())
}

fn excel_export_download_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = app.path().download_dir() {
        return Ok(path);
    }

    if let Some(user_profile) = env::var_os("USERPROFILE").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(user_profile).join("Downloads"));
    }

    match (env::var_os("HOMEDRIVE"), env::var_os("HOMEPATH")) {
        (Some(home_drive), Some(home_path)) if !home_drive.is_empty() && !home_path.is_empty() => {
            let home = format!(
                "{}{}",
                home_drive.to_string_lossy(),
                home_path.to_string_lossy()
            );
            Ok(PathBuf::from(home).join("Downloads"))
        }
        _ => Err(
            "Windows could not locate a Downloads folder or determine the current user profile."
                .to_string(),
        ),
    }
}

#[tauri::command]
async fn save_and_open_excel_export(
    app: tauri::AppHandle,
    request: ExcelExportRequest,
) -> Result<String, String> {
    if request.bytes.is_empty() {
        return Err("The generated Excel workbook is empty.".to_string());
    }
    if request.bytes.len() > MAX_EXCEL_EXPORT_BYTES {
        return Err(format!(
            "The generated Excel workbook exceeds the {} MB export limit.",
            MAX_EXCEL_EXPORT_BYTES / (1024 * 1024)
        ));
    }

    let file_name = validated_excel_export_file_name(&request.file_name)?;
    let download_directory = excel_export_download_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = save_excel_export(&download_directory, &file_name, &request.bytes)?;
        open_excel_export(&path).map_err(|error| {
            format!(
                "The workbook was saved to {}, but it could not be opened. {error}",
                path.display()
            )
        })?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|error| format!("The Excel export task failed: {error}"))?
}

fn system_database_path() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("PORTAL_SYSTEM_DB") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
    }

    let portable = installation_root()?.join("config").join("system.db");
    if portable.is_file() {
        return Ok(portable);
    }

    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("python")
        .join("portal")
        .join("data")
        .join("portal_system.sqlite3");
    if development.is_file() {
        return Ok(development);
    }

    Err("The read-only Portal system database was not found at config\\system.db.".to_string())
}

#[tauri::command]
async fn business_sync_status() -> Result<business_sync::BusinessSyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_root = local_data_root()?;
        let application_root = installation_root()?;
        let config_file = portal_config_path()?;
        let paths = business_sync::load_paths(&config_file, &application_root, &data_root)?;
        Ok(business_sync::status(
            paths.as_ref(),
            &business_sync::local_business_database_path(
                &config_file,
                &application_root,
                &data_root,
            )?,
        ))
    })
    .await
    .map_err(|error| format!("Business synchronization status task failed: {error}"))?
}

fn python_worker_path() -> Result<PathBuf, String> {
    let executable_name = if cfg!(target_os = "windows") {
        "portal-python.exe"
    } else {
        "portal-python"
    };

    if let Ok(current_executable) = env::current_exe() {
        if let Some(directory) = current_executable.parent() {
            for portable_worker in [
                directory
                    .join("runtime")
                    .join("portal-python")
                    .join(executable_name),
                directory.join("runtime").join(executable_name),
                directory.join(executable_name),
            ] {
                if portable_worker.is_file() {
                    return Ok(portable_worker);
                }
            }
        }
    }

    let development_worker = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("python")
        .join("portal")
        .join("ipc")
        .join("dist")
        .join("portal-python")
        .join(executable_name);
    if development_worker.is_file() {
        return Ok(development_worker);
    }

    Err(format!(
        "The bundled Python worker was not found under the Portal runtime directory ({executable_name})."
    ))
}

#[tauri::command]
fn desktop_context() -> Result<DesktopContext, String> {
    let data_root = local_data_root()?;
    initialize_local_directories(&data_root)?;

    Ok(DesktopContext {
        application_name: "Storm Water Asset Intelligence Portal",
        application_version: installed_application_version(),
        runtime: "tauri",
        user_name: env::var("USERNAME").unwrap_or_else(|_| "Windows user".to_string()),
        user_domain: env::var("USERDOMAIN").unwrap_or_default(),
        device_name: env::var("COMPUTERNAME").unwrap_or_default(),
        data_root: data_root.display().to_string(),
        cache_root: data_root.join("data").join("cache").display().to_string(),
        log_root: data_root.join("data").join("logs").display().to_string(),
        python_worker_available: python_worker_path().is_ok(),
    })
}

#[tauri::command]
async fn python_health_check() -> Result<PythonHealth, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response = run_python_job("health", &serde_json::json!({}))?;
        serde_json::from_value::<PythonHealth>(response)
            .map_err(|error| format!("Python health response was invalid: {error}"))
    })
    .await
    .map_err(|error| format!("Python worker task failed: {error}"))?
}

#[tauri::command]
async fn python_request(request: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_python_job("request", &request))
        .await
        .map_err(|error| format!("Python request task failed: {error}"))?
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
            start_maintenance_exit_monitor(app.handle().clone());
            Ok(())
        })
        .register_uri_scheme_protocol("portal-data", |_context, request| {
            local_protocol_response(request)
        })
        .invoke_handler(tauri::generate_handler![
            desktop_startup_session,
            exit_application,
            check_portal_update,
            install_portal_update,
            desktop_context,
            client_settings,
            business_sync_status,
            open_external_url,
            save_and_open_excel_export,
            python_health_check,
            python_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Portal desktop application");
}

#[cfg(test)]
mod tests {
    use super::{
        configure_system_database_access, file_response_range, is_scheduled_maintenance_hour,
        packaged_application_version, save_excel_export, validated_excel_export_file_name,
        INITIAL_MEDIA_CHUNK_BYTES,
    };
    use std::{env, fs, process, time::SystemTime};

    #[test]
    fn scheduled_maintenance_spans_ten_pm_through_five_am() {
        assert!(is_scheduled_maintenance_hour(22));
        assert!(is_scheduled_maintenance_hour(23));
        assert!(is_scheduled_maintenance_hour(0));
        assert!(is_scheduled_maintenance_hour(4));
        assert!(!is_scheduled_maintenance_hour(5));
        assert!(!is_scheduled_maintenance_hour(21));
    }

    #[test]
    fn desktop_system_database_is_always_read_only() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("test time")
            .as_nanos();
        let database = env::temp_dir().join(format!(
            "portal-desktop-system-db-test-{}-{unique}.db",
            process::id()
        ));
        fs::write(&database, b"published-system-catalog").expect("test database");

        configure_system_database_access(&database).expect("read-only configuration");

        assert!(fs::metadata(&database)
            .expect("database metadata")
            .permissions()
            .readonly());
        let mut permissions = fs::metadata(&database)
            .expect("cleanup metadata")
            .permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&database, permissions).expect("cleanup permissions");
        fs::remove_file(database).expect("test cleanup");
    }

    #[test]
    fn packaged_version_comes_from_the_portable_version_file() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("test time")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "portal-desktop-version-test-{}-{unique}",
            process::id()
        ));
        fs::create_dir_all(&root).expect("test root");
        fs::write(root.join("VERSION"), b"2.4.1\r\n").expect("test version");

        assert_eq!(
            packaged_application_version(&root).as_deref(),
            Some("2.4.1")
        );

        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn excel_export_file_name_must_be_a_local_xlsx_name() {
        assert_eq!(
            validated_excel_export_file_name("Pending AIFs.xlsx").as_deref(),
            Ok("Pending AIFs.xlsx")
        );
        assert!(validated_excel_export_file_name("folder/report.xlsx").is_err());
        assert!(validated_excel_export_file_name("report.pdf").is_err());
    }

    #[test]
    fn excel_export_uses_a_new_name_instead_of_overwriting() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("test time")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "portal-desktop-export-test-{}-{unique}",
            process::id()
        ));

        let first = save_excel_export(&root, "Portal Report.xlsx", b"first").expect("first export");
        let second =
            save_excel_export(&root, "Portal Report.xlsx", b"second").expect("second export");

        assert_eq!(
            first.file_name().and_then(|value| value.to_str()),
            Some("Portal Report.xlsx")
        );
        assert_eq!(
            second.file_name().and_then(|value| value.to_str()),
            Some("Portal Report (1).xlsx")
        );
        assert_eq!(fs::read(first).expect("first bytes"), b"first");
        assert_eq!(fs::read(second).expect("second bytes"), b"second");

        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[test]
    fn media_open_ended_range_is_limited_to_one_chunk() {
        let file_size = 656_352_868;
        assert_eq!(
            file_response_range(Some("bytes=0-"), file_size, true),
            (0, INITIAL_MEDIA_CHUNK_BYTES - 1, 206)
        );
        assert_eq!(
            file_response_range(Some("bytes=312000000-"), file_size, true,),
            (
                312_000_000,
                312_000_000 + INITIAL_MEDIA_CHUNK_BYTES - 1,
                206,
            )
        );
    }

    #[test]
    fn media_suffix_range_reads_the_end_of_the_video() {
        let file_size = 656_352_868;
        assert_eq!(
            file_response_range(Some("bytes=-524288"), file_size, true),
            (file_size - 524_288, file_size - 1, 206)
        );
    }

    #[test]
    fn non_media_open_ended_range_keeps_download_semantics() {
        let file_size = 10_000_000;
        assert_eq!(
            file_response_range(Some("bytes=200-"), file_size, false),
            (200, file_size - 1, 206)
        );
    }
}
