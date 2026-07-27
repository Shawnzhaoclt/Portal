use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    schema_version: u32,
    version: String,
    update_mode: String,
    payload: ReleasePayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleasePayload {
    file: String,
    sha256: String,
    size: u64,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Portal update failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments();
    let release_root = required_path(&arguments, "release-root")?;
    let install_root = arguments
        .get("install-root")
        .map(PathBuf::from)
        .unwrap_or(default_install_root()?);
    let restart = arguments.contains_key("restart");

    if let Some(value) = arguments.get("wait-pid") {
        let process_id = value
            .parse::<u32>()
            .map_err(|_| format!("Invalid --wait-pid value: {value}"))?;
        wait_for_process(process_id)?;
    }

    let manifest_name = arguments
        .get("manifest")
        .map(String::as_str)
        .unwrap_or("portal-release.json");
    let manifest = read_manifest(&release_root, manifest_name)?;
    if arguments.contains_key("bootstrap") && manifest.update_mode != "full" {
        return Err("Initial Portal installation requires a full release bundle.".to_string());
    }
    install_release(&release_root, &install_root, &manifest)?;

    if arguments.contains_key("bootstrap") {
        create_desktop_shortcut(&install_root)?;
    }
    if restart {
        Command::new(installed_application_root(&install_root).join("Portal.exe"))
            .spawn()
            .map_err(|error| format!("Could not restart Portal: {error}"))?;
    }
    Ok(())
}

fn installed_application_root(install_root: &Path) -> PathBuf {
    let application_root = install_root.join("app");
    if application_root.is_dir() {
        application_root
    } else {
        install_root.to_path_buf()
    }
}

fn parse_arguments() -> HashMap<String, String> {
    let mut values = HashMap::new();
    let mut arguments = env::args().skip(1).peekable();
    while let Some(argument) = arguments.next() {
        if !argument.starts_with("--") {
            continue;
        }
        let key = argument.trim_start_matches("--").to_string();
        if matches!(key.as_str(), "bootstrap" | "restart") {
            values.insert(key, "true".to_string());
        } else if let Some(value) = arguments.next() {
            values.insert(key, value);
        }
    }
    values
}

fn required_path(arguments: &HashMap<String, String>, key: &str) -> Result<PathBuf, String> {
    let value = arguments
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .map(|value| value.trim_matches('"'))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("--{key} must point to an accessible directory."))?;
    let path = PathBuf::from(value);
    if path.is_dir() {
        Ok(path)
    } else {
        Err(format!("--{key} must point to an accessible directory."))
    }
}

fn default_install_root() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "LOCALAPPDATA is not available for this Windows user.".to_string())?;
    Ok(PathBuf::from(local_app_data).join("StormWaterPortal"))
}

fn read_manifest(release_root: &Path, manifest_name: &str) -> Result<ReleaseManifest, String> {
    let manifest_file = Path::new(manifest_name);
    if manifest_file.components().count() != 1 || manifest_file.file_name().is_none() {
        return Err("--manifest must be a file name, not a path.".to_string());
    }
    let manifest_path = release_root.join(manifest_file);
    let contents = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read {}: {error}", manifest_path.display()))?;
    let manifest: ReleaseManifest =
        serde_json::from_str(contents.trim_start_matches('\u{feff}'))
            .map_err(|error| format!("Release manifest is not valid JSON: {error}"))?;
    if manifest.schema_version != 1 || manifest.version.trim().is_empty() {
        return Err("Release manifest has an unsupported schema or empty version.".to_string());
    }
    if !matches!(
        manifest.update_mode.as_str(),
        "system-db" | "portal-exe" | "full"
    ) {
        return Err("Release manifest has an unsupported updateMode.".to_string());
    }
    if manifest.payload.sha256.len() != 64
        || !manifest
            .payload
            .sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err("Release manifest contains an invalid archive SHA-256 value.".to_string());
    }
    let payload_path = Path::new(&manifest.payload.file);
    if payload_path.components().count() != 1 || payload_path.file_name().is_none() {
        return Err("Release manifest payload.file must be a file name, not a path.".to_string());
    }
    Ok(manifest)
}

fn install_release(
    release_root: &Path,
    install_root: &Path,
    manifest: &ReleaseManifest,
) -> Result<(), String> {
    // User-owned state never lives under the replaceable application folder.
    // Create it if needed, but never copy, clear, or replace its contents.
    ensure_user_data_directory(install_root)?;
    let payload_source = release_root.join(&manifest.payload.file);
    if !payload_source.is_file() {
        return Err(format!(
            "Release payload was not found: {}",
            payload_source.display()
        ));
    }
    let metadata = fs::metadata(&payload_source)
        .map_err(|error| format!("Could not inspect release payload: {error}"))?;
    if metadata.len() != manifest.payload.size {
        return Err("Release payload size does not match portal-release.json.".to_string());
    }

    match manifest.update_mode.as_str() {
        "system-db" => install_single_file(
            &payload_source,
            &install_root.join("config").join("system.db"),
            &manifest.payload.sha256,
        ),
        "portal-exe" => install_single_file(
            &payload_source,
            &installed_application_root(install_root).join("Portal.exe"),
            &manifest.payload.sha256,
        ),
        "full" => install_full_release(&payload_source, install_root, manifest),
        _ => Err("Release manifest has an unsupported updateMode.".to_string()),
    }?;

    // Older portable builds included an empty app\\data folder. It is not part of
    // the distribution contract and must not shadow the user-owned data directory.
    remove_packaged_application_data(install_root)?;
    ensure_user_data_directory(install_root)?;
    write_update_state(install_root, manifest)?;
    if manifest.update_mode == "system-db" {
        mark_read_only(&install_root.join("config").join("system.db"));
    }
    Ok(())
}

fn install_full_release(
    archive_source: &Path,
    install_root: &Path,
    manifest: &ReleaseManifest,
) -> Result<(), String> {
    let token = unique_token();
    let temporary_archive = env::temp_dir().join(format!("Portal-release-{token}.zip"));
    fs::copy(archive_source, &temporary_archive)
        .map_err(|error| format!("Could not copy the Portal release locally: {error}"))?;
    verify_sha256(&temporary_archive, &manifest.payload.sha256)?;

    let parent = install_root
        .parent()
        .ok_or_else(|| "The Portal install directory does not have a parent path.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Portal install parent: {error}"))?;
    let staging = parent.join(format!(".StormWaterPortal-app-next-{token}"));
    let backup = parent.join(".StormWaterPortal-app-previous");
    remove_if_exists(&staging)?;
    extract_zip(&temporary_archive, &staging)?;
    let _ = fs::remove_file(&temporary_archive);
    remove_if_exists(&staging.join("data"))?;
    validate_release_layout(&staging, &manifest.version)?;

    let config_root = install_root.join("config");
    fs::create_dir_all(&config_root)
        .map_err(|error| format!("Could not create Portal configuration directory: {error}"))?;
    let staged_config = staging.join("config");
    let settings = config_root.join("portal.settings.json");
    let packaged_settings = staged_config.join("portal.settings.json");
    if !settings.is_file() && packaged_settings.is_file() {
        replace_file(&packaged_settings, &settings)?;
    }
    let packaged_system_database = staged_config.join("system.db");
    if packaged_system_database.is_file() {
        replace_file(&packaged_system_database, &config_root.join("system.db"))?;
        mark_read_only(&config_root.join("system.db"));
    }
    if staged_config.exists() {
        fs::remove_dir_all(&staged_config)
            .map_err(|error| format!("Could not remove staged Portal configuration: {error}"))?;
    }

    remove_if_exists(&backup)?;
    let application_root = install_root.join("app");
    if application_root.exists() {
        fs::rename(&application_root, &backup).map_err(|error| {
            format!("Could not prepare the existing Portal application for replacement: {error}")
        })?;
    }
    if let Err(error) = fs::rename(&staging, &application_root) {
        if backup.exists() {
            let _ = fs::rename(&backup, &application_root);
        }
        return Err(format!("Could not activate the Portal update: {error}"));
    }
    let _ = fs::remove_dir_all(&backup);
    cleanup_legacy_root_payload(install_root);
    Ok(())
}

fn ensure_user_data_directory(install_root: &Path) -> Result<(), String> {
    let data_root = install_root.join("data");
    fs::create_dir_all(&data_root).map_err(|error| {
        format!(
            "Could not create or access the Portal user data directory {}: {error}",
            data_root.display()
        )
    })
}

fn remove_packaged_application_data(install_root: &Path) -> Result<(), String> {
    remove_if_exists(&install_root.join("app").join("data"))
}

fn cleanup_legacy_root_payload(install_root: &Path) {
    for file in ["Portal.exe", "README.txt", "VERSION", "manifest.json"] {
        let _ = fs::remove_file(install_root.join(file));
    }
    let legacy_runtime = install_root.join("runtime");
    if legacy_runtime.is_dir() {
        let _ = fs::remove_dir_all(legacy_runtime);
    }
}

fn install_single_file(source: &Path, target: &Path, expected_sha256: &str) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "The Portal update target does not have a parent path.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Portal update directory: {error}"))?;
    let temporary = parent.join(format!(
        ".{}.next",
        target.file_name().unwrap_or_default().to_string_lossy()
    ));
    let backup = parent.join(format!(
        ".{}.previous",
        target.file_name().unwrap_or_default().to_string_lossy()
    ));
    remove_if_exists(&temporary)?;
    remove_if_exists(&backup)?;
    fs::copy(source, &temporary)
        .map_err(|error| format!("Could not copy Portal update payload: {error}"))?;
    verify_sha256(&temporary, expected_sha256)?;
    clear_read_only(target);
    if target.exists() {
        fs::rename(target, &backup).map_err(|error| {
            format!("Could not prepare existing Portal file for replacement: {error}")
        })?;
    }
    if let Err(error) = fs::rename(&temporary, target) {
        if backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        return Err(format!("Could not activate Portal file update: {error}"));
    }
    let _ = fs::remove_file(&backup);
    Ok(())
}

fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| {
        "The Portal replacement target does not have a parent directory.".to_string()
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Portal replacement directory: {error}"))?;
    let temporary = parent.join(format!(
        ".{}.next",
        target.file_name().unwrap_or_default().to_string_lossy()
    ));
    let backup = parent.join(format!(
        ".{}.previous",
        target.file_name().unwrap_or_default().to_string_lossy()
    ));
    remove_if_exists(&temporary)?;
    remove_if_exists(&backup)?;
    fs::copy(source, &temporary)
        .map_err(|error| format!("Could not stage Portal replacement file: {error}"))?;
    clear_read_only(target);
    if target.exists() {
        fs::rename(target, &backup)
            .map_err(|error| format!("Could not prepare Portal replacement file: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, target) {
        if backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        return Err(format!(
            "Could not activate Portal replacement file: {error}"
        ));
    }
    let _ = fs::remove_file(&backup);
    Ok(())
}

fn clear_read_only(path: &Path) {
    if path.exists() {
        let _ = Command::new("attrib.exe").arg("-R").arg(path).status();
    }
}

fn mark_read_only(path: &Path) {
    if path.exists() {
        let _ = Command::new("attrib.exe").arg("+R").arg(path).status();
    }
}

fn write_update_state(install_root: &Path, manifest: &ReleaseManifest) -> Result<(), String> {
    let directory = install_root.join("config");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Portal configuration directory: {error}"))?;
    let destination = directory.join("update-state.json");
    let temporary = directory.join(".update-state.next");
    let contents = serde_json::json!({
        "version": manifest.version,
        "updateMode": manifest.update_mode,
    });
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&contents)
            .map_err(|error| format!("Could not serialize Portal update state: {error}"))?,
    )
    .map_err(|error| format!("Could not save Portal update state: {error}"))?;
    if destination.exists() {
        clear_read_only(&destination);
        fs::remove_file(&destination)
            .map_err(|error| format!("Could not replace Portal update state: {error}"))?;
    }
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Could not activate Portal update state: {error}"))
}

fn extract_zip(archive_path: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create update staging folder: {error}"))?;
    let result = Command::new("tar.exe")
        .arg("-xf")
        .arg(archive_path)
        .arg("-C")
        .arg(destination)
        .status()
        .map_err(|error| format!("Windows tar.exe could not unpack the release ZIP: {error}"))?;
    if !result.success() {
        return Err(
            "Windows tar.exe could not unpack the verified Portal release ZIP.".to_string(),
        );
    }
    Ok(())
}

fn validate_release_layout(root: &Path, expected_version: &str) -> Result<(), String> {
    for path in [
        root.join("Portal.exe"),
        root.join("VERSION"),
        root.join("config").join("system.db"),
        root.join("runtime")
            .join("portal-python")
            .join("portal-python.exe"),
        root.join("runtime").join("PortalUpdater.exe"),
    ] {
        if !path.is_file() {
            return Err(format!(
                "Release is missing required file: {}",
                path.display()
            ));
        }
    }
    let version = fs::read_to_string(root.join("VERSION"))
        .map_err(|error| format!("Could not read packaged VERSION file: {error}"))?;
    if version.trim() != expected_version {
        return Err("Release ZIP version does not match portal-release.json.".to_string());
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not hash release archive: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash release archive: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let actual = format!("{:x}", digest.finalize());
    if !actual.eq_ignore_ascii_case(expected) {
        return Err("Release ZIP SHA-256 does not match portal-release.json.".to_string());
    }
    Ok(())
}

fn wait_for_process(process_id: u32) -> Result<(), String> {
    for _ in 0..120 {
        let output = Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {process_id}"), "/NH"])
            .output()
            .map_err(|error| format!("Could not wait for Portal to exit: {error}"))?;
        let text = String::from_utf8_lossy(&output.stdout);
        if !text.contains(&process_id.to_string()) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("Portal did not exit in time for the update.".to_string())
}

fn create_desktop_shortcut(install_root: &Path) -> Result<(), String> {
    let desktop = env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|root| root.join("Desktop"))
        .ok_or_else(|| "USERPROFILE is not available for this Windows user.".to_string())?;
    fs::create_dir_all(&desktop)
        .map_err(|error| format!("Could not access the Desktop folder: {error}"))?;
    let shortcut = desktop.join("Storm Water Portal.lnk");
    let application_root = installed_application_root(install_root);
    let target = application_root.join("Portal.exe");
    let quote = |value: &str| value.replace('\'', "''");
    let command = format!(
        "$shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut('{}'); $shortcut.TargetPath='{}'; $shortcut.WorkingDirectory='{}'; $shortcut.IconLocation='{},0'; $shortcut.Save()",
        quote(&shortcut.display().to_string()),
        quote(&target.display().to_string()),
        quote(&application_root.display().to_string()),
        quote(&target.display().to_string()),
    );
    let result = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .status()
        .map_err(|error| format!("Could not create the Desktop shortcut: {error}"))?;
    if !result.success() {
        return Err("Windows could not create the Portal Desktop shortcut.".to_string());
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
    } else if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
    }
    Ok(())
}

fn unique_token() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}-{timestamp}", std::process::id())
}
