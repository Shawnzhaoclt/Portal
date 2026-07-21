use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
};
use tauri::http::{header, Request as HttpRequest, Response as HttpResponse, StatusCode};

mod business_sync;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Shell::ShellExecuteW;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn windows_user_email() -> Result<String, String> {
    if let Some(configured) = env::var_os("PORTAL_WINDOWS_EMAIL") {
        let email = configured.to_string_lossy().trim().to_lowercase();
        if email.contains('@') {
            return Ok(email);
        }
    }

    let mut command = Command::new("whoami.exe");
    command.arg("/upn");
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|error| {
        format!("Could not resolve the signed-in Windows account email: {error}")
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Windows did not return a user principal name for the signed-in account.".to_string()
        } else {
            format!("Windows could not resolve the signed-in account email: {detail}")
        });
    }

    let email = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_lowercase();
    if !email.contains('@') {
        return Err(
            "Windows did not return a valid email address for the signed-in account.".to_string(),
        );
    }
    Ok(email)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopContext {
    application_name: &'static str,
    application_version: &'static str,
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
    initialize_local_business_database(&data_root)?;
    let application_root = executable_root()?;
    let system_database = system_database_path()?;
    let config_file = portal_config_path()?;
    let windows_email = windows_user_email()?;
    let business_sync = business_sync::load_paths(&config_file, &application_root, &data_root)?;
    let mut command = Command::new(&worker);
    command
        .arg("--serve")
        .env("PORTAL_DESKTOP_MODE", "1")
        .env("PORTAL_APP_ROOT", &application_root)
        .env("PORTAL_DATA_ROOT", &data_root)
        .env("PORTAL_CONFIG_FILE", config_file)
        .env("PORTAL_WINDOWS_EMAIL", windows_email)
        .env("PORTAL_SYSTEM_DB", &system_database)
        .env(
            "PORTAL_BUSINESS_DB",
            data_root.join("data").join("business.db"),
        )
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
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.split_once('-'));
    let (start, end, status) = if let Some((start, end)) = range {
        let start = start
            .parse::<u64>()
            .unwrap_or(0)
            .min(file_size.saturating_sub(1));
        let end = if end.is_empty() {
            file_size.saturating_sub(1)
        } else {
            end.parse::<u64>()
                .unwrap_or(file_size.saturating_sub(1))
                .min(file_size.saturating_sub(1))
        };
        (start, end.max(start), StatusCode::PARTIAL_CONTENT.as_u16())
    } else {
        (0, file_size.saturating_sub(1), StatusCode::OK.as_u16())
    };
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
    Ok(PathBuf::from(local_app_data).join("Portal"))
}

fn initialize_local_directories(root: &Path) -> Result<(), String> {
    for directory in [
        root.to_path_buf(),
        root.join("config"),
        root.join("cache"),
        root.join("data"),
        root.join("data").join("backups"),
        root.join("downloads"),
        root.join("exports"),
        root.join("inbox"),
        root.join("logs"),
        root.join("outbox"),
        root.join("temp"),
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

fn executable_root() -> Result<PathBuf, String> {
    env::current_exe()
        .map_err(|error| format!("Could not resolve Portal.exe: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Portal.exe does not have a parent directory.".to_string())
}

fn portal_config_path() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("PORTAL_CONFIG_FILE") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
    }
    let portable = executable_root()?
        .join("config")
        .join("portal.settings.json");
    if portable.is_file() {
        return Ok(portable);
    }
    Err(
        "Portal settings were not found at config\\portal.settings.json beside Portal.exe."
            .to_string(),
    )
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
    let application_root = executable_root()?.display().to_string();
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

    let windows_email = windows_user_email()?;
    env::set_var("PORTAL_WINDOWS_EMAIL", &windows_email);
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
        return Err(format!(
            "The signed-in Windows account is not registered as an active Portal user:\n\n{windows_email}\n\nContact the Portal developer for assistance."
        ));
    }
    let session = response
        .get("data")
        .cloned()
        .ok_or_else(|| "Desktop sign-in did not return a Portal session.".to_string())?;
    Ok(DesktopStartupSession {
        shared_data_root: shared_root.display().to_string(),
        windows_email,
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
    app.exit(1);
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

fn system_database_path() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("PORTAL_SYSTEM_DB") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
    }

    let portable = executable_root()?.join("config").join("system.db");
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

fn initialize_local_business_database(root: &Path) -> Result<(), String> {
    let target = root.join("data").join("business.db");
    if target.is_file() {
        return Ok(());
    }

    let legacy = root
        .join("data")
        .join("business")
        .join("portal_business.sqlite3");
    if legacy.is_file() {
        fs::copy(&legacy, &target).map_err(|error| {
            format!(
                "Could not migrate {} to {}: {error}",
                legacy.display(),
                target.display()
            )
        })?;
        return Ok(());
    }

    let application_root = executable_root()?;
    let config_file = portal_config_path()?;
    if let Some(paths) = business_sync::load_paths(&config_file, &application_root, root)? {
        if business_sync::initialize_from_master(&paths, &target)? {
            return Ok(());
        }
    }

    let seed = executable_root()?.join("data").join("business.db");
    if seed.is_file() {
        fs::copy(&seed, &target).map_err(|error| {
            format!(
                "Could not initialize {} from {}: {error}",
                target.display(),
                seed.display()
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
async fn business_sync_status() -> Result<business_sync::BusinessSyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_root = local_data_root()?;
        let application_root = executable_root()?;
        let config_file = portal_config_path()?;
        let paths = business_sync::load_paths(&config_file, &application_root, &data_root)?;
        Ok(business_sync::status(
            paths.as_ref(),
            &data_root.join("data").join("business.db"),
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
        application_version: env!("CARGO_PKG_VERSION"),
        runtime: "tauri",
        user_name: env::var("USERNAME").unwrap_or_else(|_| "Windows user".to_string()),
        user_domain: env::var("USERDOMAIN").unwrap_or_default(),
        device_name: env::var("COMPUTERNAME").unwrap_or_default(),
        data_root: data_root.display().to_string(),
        cache_root: data_root.join("cache").display().to_string(),
        log_root: data_root.join("logs").display().to_string(),
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
        .register_uri_scheme_protocol("portal-data", |_context, request| {
            local_protocol_response(request)
        })
        .invoke_handler(tauri::generate_handler![
            desktop_startup_session,
            exit_application,
            desktop_context,
            client_settings,
            business_sync_status,
            open_external_url,
            python_health_check,
            python_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Portal desktop application");
}
