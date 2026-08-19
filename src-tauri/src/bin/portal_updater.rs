#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// Windows Defender, Explorer, and the terminated Python worker can briefly
// retain a handle under the installed app directory after Portal exits. Give
// those handles enough time to close before treating activation as failed.
const ACTIVATION_RETRY_ATTEMPTS: usize = 120;
const ACTIVATION_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    schema_version: u32,
    version: String,
    update_mode: String,
    payload: ReleasePayload,
    #[serde(default)]
    installation_payload: Option<ReleasePayload>,
    #[serde(default)]
    preserve_paths: Vec<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    allowed_machines: Vec<String>,
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
        let arguments = parse_arguments();
        if let Some(install_root) = update_install_root(&arguments) {
            append_update_log(
                &install_root,
                "ERROR",
                &format!("Portal update failed: {error}"),
            );
        }
        eprintln!("Portal update failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments();
    let launch_directory = env::current_dir()
        .map_err(|error| format!("Could not determine the updater launch directory: {error}"))?;
    let release_root = absolute_path_from(
        &launch_directory,
        &required_path(&arguments, "release-root")?,
    );
    let install_root = absolute_path_from(
        &launch_directory,
        &arguments
            .get("install-root")
            .map(PathBuf::from)
            .unwrap_or(default_install_root()?),
    );
    relocate_updater_working_directory()?;
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
    let requested_channel = normalize_channel(
        arguments
            .get("channel")
            .map(String::as_str)
            .unwrap_or("production"),
    )?;
    validate_release_target(&manifest, &requested_channel, &machine_name())?;
    let bootstrap = arguments.contains_key("bootstrap");
    append_update_log(
        &install_root,
        "INFO",
        &format!(
            "Starting Portal {} update in {} mode on the {} channel.",
            manifest.version,
            if bootstrap {
                "bootstrap"
            } else {
                manifest.update_mode.as_str()
            },
            requested_channel,
        ),
    );
    install_release(
        &release_root,
        &install_root,
        &manifest,
        bootstrap,
        &requested_channel,
    )?;
    append_update_log(
        &install_root,
        "INFO",
        &format!("Portal {} update completed successfully.", manifest.version),
    );

    if bootstrap {
        create_desktop_shortcut(&install_root)?;
    }
    if restart {
        let application_root = installed_application_root(&install_root);
        Command::new(application_root.join("Portal.exe"))
            .current_dir(&application_root)
            .spawn()
            .map_err(|error| format!("Could not restart Portal: {error}"))?;
    }
    Ok(())
}

fn absolute_path_from(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

fn relocate_updater_working_directory() -> Result<(), String> {
    let working_directory = env::temp_dir().join("StormWaterPortal-Updater");
    fs::create_dir_all(&working_directory)
        .map_err(|error| format!("Could not prepare the Portal updater workspace: {error}"))?;
    env::set_current_dir(&working_directory).map_err(|error| {
        format!(
            "Could not move the Portal updater outside the installed application folder: {error}"
        )
    })
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

fn update_install_root(arguments: &HashMap<String, String>) -> Option<PathBuf> {
    arguments
        .get("install-root")
        .map(PathBuf::from)
        .or_else(|| default_install_root().ok())
}

fn append_update_log(install_root: &Path, level: &str, message: &str) {
    let directory = install_root.join("data").join("logs");
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("portal-updater.log"))
    else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let normalized = message.replace(['\r', '\n'], " ");
    let _ = writeln!(log, "{timestamp} [{level}] {normalized}");
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
    if !matches!(manifest.schema_version, 1 | 2) || manifest.version.trim().is_empty() {
        return Err("Release manifest has an unsupported schema or empty version.".to_string());
    }
    if manifest.schema_version == 1
        && (manifest.channel.is_some() || !manifest.allowed_machines.is_empty())
    {
        return Err("Release manifest schema 1 cannot define channel targeting.".to_string());
    }
    if manifest.schema_version == 2 {
        let channel = manifest
            .channel
            .as_deref()
            .ok_or_else(|| "Release manifest schema 2 must define channel.".to_string())?;
        normalize_channel(channel)?;
        if channel == "test" && manifest.allowed_machines.is_empty() {
            return Err("A test release must target at least one computer.".to_string());
        }
    }
    if !matches!(
        manifest.update_mode.as_str(),
        "system-db" | "portal-exe" | "full"
    ) {
        return Err("Release manifest has an unsupported updateMode.".to_string());
    }
    validate_payload(&manifest.payload, "payload")?;
    if let Some(payload) = &manifest.installation_payload {
        validate_payload(payload, "installationPayload")?;
    }
    if !manifest.preserve_paths.is_empty() && manifest.preserve_paths != ["data".to_string()] {
        return Err("Release manifest preservePaths may contain only data.".to_string());
    }
    Ok(manifest)
}

fn normalize_channel(value: &str) -> Result<String, String> {
    let channel = value.trim().to_ascii_lowercase();
    if matches!(channel.as_str(), "production" | "test") {
        Ok(channel)
    } else {
        Err("Portal update channel must be production or test.".to_string())
    }
}

fn machine_name() -> String {
    env::var("COMPUTERNAME").unwrap_or_default()
}

fn validate_release_target(
    manifest: &ReleaseManifest,
    requested_channel: &str,
    current_machine: &str,
) -> Result<(), String> {
    let manifest_channel = manifest.channel.as_deref().unwrap_or("production");
    if manifest_channel != requested_channel {
        return Err(format!(
            "The requested {requested_channel} channel contains a {manifest_channel} release manifest."
        ));
    }
    if requested_channel == "test"
        && !manifest
            .allowed_machines
            .iter()
            .any(|allowed| allowed.trim().eq_ignore_ascii_case(current_machine.trim()))
    {
        return Err(format!(
            "This computer ({current_machine}) is not authorized for the Portal test channel."
        ));
    }
    Ok(())
}

fn validate_payload(payload: &ReleasePayload, field: &str) -> Result<(), String> {
    if payload.sha256.len() != 64
        || !payload
            .sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(format!(
            "Release manifest contains an invalid {field} SHA-256 value."
        ));
    }
    let payload_path = Path::new(&payload.file);
    if payload_path.components().count() != 1 || payload_path.file_name().is_none() {
        return Err(format!(
            "Release manifest {field}.file must be a file name, not a path."
        ));
    }
    Ok(())
}

fn install_release(
    release_root: &Path,
    install_root: &Path,
    manifest: &ReleaseManifest,
    bootstrap: bool,
    channel: &str,
) -> Result<(), String> {
    // User-owned state never lives under the replaceable application folder.
    // Create it if needed, but never copy, clear, or replace its contents.
    ensure_user_data_directory(install_root)?;
    let (applied_mode, payload) = if bootstrap {
        match manifest.installation_payload.as_ref() {
            Some(payload) => ("full", payload),
            None if manifest.update_mode == "full" => ("full", &manifest.payload),
            None => return Err(
                "Initial Portal installation requires installationPayload in portal-release.json."
                    .to_string(),
            ),
        }
    } else {
        (manifest.update_mode.as_str(), &manifest.payload)
    };
    let payload_source = release_root.join(&payload.file);
    if !payload_source.is_file() {
        return Err(format!(
            "Release payload was not found: {}",
            payload_source.display()
        ));
    }
    let metadata = fs::metadata(&payload_source)
        .map_err(|error| format!("Could not inspect release payload: {error}"))?;
    if metadata.len() != payload.size {
        return Err("Release payload size does not match portal-release.json.".to_string());
    }

    ensure_update_target_is_not_user_data(install_root, &install_root.join("app"))?;
    ensure_update_target_is_not_user_data(install_root, &install_root.join("config"))?;
    match applied_mode {
        "system-db" => install_single_file(
            &payload_source,
            &install_root.join("config").join("system.db"),
            &payload.sha256,
        ),
        "portal-exe" => install_single_file(
            &payload_source,
            &installed_application_root(install_root).join("Portal.exe"),
            &payload.sha256,
        ),
        "full" => install_full_release(
            &payload_source,
            install_root,
            &manifest.version,
            &payload.sha256,
            bootstrap,
        ),
        _ => Err("Release manifest has an unsupported updateMode.".to_string()),
    }?;

    // Older portable builds included an empty app\\data folder. It is not part of
    // the distribution contract and must not shadow the user-owned data directory.
    remove_packaged_application_data(install_root)?;
    ensure_user_data_directory(install_root)?;
    write_update_state(install_root, manifest, applied_mode, channel)?;
    write_update_channel(install_root, channel)?;
    if applied_mode == "system-db" {
        mark_read_only(&install_root.join("config").join("system.db"));
    }
    Ok(())
}

fn install_full_release(
    archive_source: &Path,
    install_root: &Path,
    version: &str,
    expected_sha256: &str,
    bootstrap: bool,
) -> Result<(), String> {
    let token = unique_token();
    let temporary_archive = env::temp_dir().join(format!("Portal-release-{token}.zip"));
    fs::copy(archive_source, &temporary_archive)
        .map_err(|error| format!("Could not copy the Portal release locally: {error}"))?;
    verify_sha256(&temporary_archive, expected_sha256)?;

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
    validate_release_layout(&staging, version)?;

    let config_root = install_root.join("config");
    fs::create_dir_all(&config_root)
        .map_err(|error| format!("Could not create Portal configuration directory: {error}"))?;
    let staged_config = staging.join("config");
    let settings = config_root.join("portal.settings.json");
    let packaged_settings = staged_config.join("portal.settings.json");
    if packaged_settings.is_file() {
        if bootstrap {
            replace_file(&packaged_settings, &settings)?;
        } else {
            merge_portal_settings(&settings, &packaged_settings)?;
        }
    }
    copy_remaining_packaged_config(&staged_config, &config_root)?;
    if staged_config.exists() {
        fs::remove_dir_all(&staged_config)
            .map_err(|error| format!("Could not remove staged Portal configuration: {error}"))?;
    }

    remove_if_exists(&backup)?;
    let application_root = install_root.join("app");
    if application_root.exists() {
        rename_with_retry(
            &application_root,
            &backup,
            "prepare the existing Portal application for replacement",
        )?;
    }
    if let Err(error) = rename_with_retry(&staging, &application_root, "activate the Portal update")
    {
        if backup.exists() {
            let _ = rename_with_retry(
                &backup,
                &application_root,
                "restore the previous Portal application",
            );
        }
        // A failed activation must not leave extracted release folders in the
        // installation parent. The release archive remains available for a
        // later retry, while these folders are only temporary staging data.
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = fs::remove_dir_all(&backup);
    cleanup_legacy_root_payload(install_root);
    Ok(())
}

fn copy_remaining_packaged_config(
    source_root: &Path,
    destination_root: &Path,
) -> Result<(), String> {
    if !source_root.is_dir() {
        return Ok(());
    }
    let mut pending = vec![source_root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Could not inspect packaged Portal configuration: {error}"))?
        {
            let entry = entry.map_err(|error| {
                format!("Could not inspect a packaged Portal configuration entry: {error}")
            })?;
            let source = entry.path();
            if source.is_dir() {
                pending.push(source);
                continue;
            }
            let relative = source.strip_prefix(source_root).map_err(|error| {
                format!("Could not resolve packaged Portal configuration path: {error}")
            })?;
            if matches!(
                relative.to_string_lossy().replace('\\', "/").as_str(),
                "portal.settings.json" | "system.db"
            ) {
                continue;
            }
            replace_file(&source, &destination_root.join(relative))?;
        }
    }
    Ok(())
}

fn merge_managed_settings(
    installed: &mut serde_json::Value,
    packaged: &serde_json::Value,
) -> Result<(), String> {
    let installed_object = installed
        .as_object_mut()
        .ok_or_else(|| "The installed Portal settings must be a JSON object.".to_string())?;
    let packaged_object = packaged
        .as_object()
        .ok_or_else(|| "The packaged Portal settings must be a JSON object.".to_string())?;
    for key in [
        "dataCache",
        "system",
        "risk",
        "dataSources",
        "aifSources",
        "maps",
        "externalServices",
    ] {
        if let Some(value) = packaged_object.get(key) {
            installed_object.insert(key.to_string(), value.clone());
        }
    }
    Ok(())
}

fn merge_portal_settings(installed_path: &Path, packaged_path: &Path) -> Result<(), String> {
    if !installed_path.is_file() {
        return replace_file(packaged_path, installed_path);
    }
    let installed_text = fs::read_to_string(installed_path).map_err(|error| {
        format!(
            "Could not read installed Portal settings at {}: {error}",
            installed_path.display()
        )
    })?;
    let packaged_text = fs::read_to_string(packaged_path).map_err(|error| {
        format!(
            "Could not read packaged Portal settings at {}: {error}",
            packaged_path.display()
        )
    })?;
    let mut installed: serde_json::Value =
        serde_json::from_str(installed_text.trim_start_matches('\u{feff}'))
            .map_err(|error| format!("Installed Portal settings are invalid: {error}"))?;
    let packaged: serde_json::Value =
        serde_json::from_str(packaged_text.trim_start_matches('\u{feff}'))
            .map_err(|error| format!("Packaged Portal settings are invalid: {error}"))?;
    merge_managed_settings(&mut installed, &packaged)?;
    let temporary = installed_path.with_file_name(".portal.settings.merged.json");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&installed)
            .map_err(|error| format!("Could not serialize merged Portal settings: {error}"))?,
    )
    .map_err(|error| format!("Could not stage merged Portal settings: {error}"))?;
    let result = replace_file(&temporary, installed_path);
    let _ = fs::remove_file(&temporary);
    result
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

fn ensure_update_target_is_not_user_data(install_root: &Path, target: &Path) -> Result<(), String> {
    let protected_root = install_root.join("data");
    if target == protected_root || target.starts_with(&protected_root) {
        return Err(format!(
            "Portal updates are not permitted to modify the data-sync folder {}.",
            protected_root.display()
        ));
    }
    Ok(())
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

fn write_update_state(
    install_root: &Path,
    manifest: &ReleaseManifest,
    applied_mode: &str,
    channel: &str,
) -> Result<(), String> {
    let directory = install_root.join("config");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Portal configuration directory: {error}"))?;
    let destination = directory.join("update-state.json");
    let temporary = directory.join(".update-state.next");
    let contents = serde_json::json!({
        "version": manifest.version,
        "updateMode": applied_mode,
        "channel": channel,
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

fn write_update_channel(install_root: &Path, channel: &str) -> Result<(), String> {
    let directory = install_root.join("data").join("settings");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Portal update settings directory: {error}"))?;
    let destination = directory.join("update-channel.json");
    let temporary = directory.join(".update-channel.next");
    let contents = serde_json::json!({
        "schemaVersion": 1,
        "channel": normalize_channel(channel)?,
    });
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&contents)
            .map_err(|error| format!("Could not serialize Portal update channel: {error}"))?,
    )
    .map_err(|error| format!("Could not save Portal update channel: {error}"))?;
    if destination.exists() {
        fs::remove_file(&destination)
            .map_err(|error| format!("Could not replace Portal update channel: {error}"))?;
    }
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Could not activate Portal update channel: {error}"))
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

#[cfg(test)]
mod tests {
    use super::{
        absolute_path_from, copy_remaining_packaged_config, ensure_update_target_is_not_user_data,
        merge_managed_settings, normalize_channel, retry_io_operation, validate_release_layout,
        validate_release_target, write_update_channel, ReleaseManifest, ReleasePayload,
    };
    use std::{
        env, fs, io, process,
        sync::atomic::{AtomicUsize, Ordering},
        time::{Duration, SystemTime},
    };

    #[test]
    fn transient_activation_failures_are_retried() {
        let calls = AtomicUsize::new(0);
        retry_io_operation(4, Duration::ZERO, || {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            if call < 2 {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated Windows file lock",
                ))
            } else {
                Ok(())
            }
        })
        .expect("retry succeeds");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn targeted_test_release_accepts_only_allowlisted_computers() {
        let manifest = ReleaseManifest {
            schema_version: 2,
            version: "1.2.3".to_string(),
            update_mode: "full".to_string(),
            payload: ReleasePayload {
                file: "Portal-Desktop-1.2.3.zip".to_string(),
                sha256: "0".repeat(64),
                size: 1,
            },
            installation_payload: None,
            preserve_paths: vec!["data".to_string()],
            channel: Some("test".to_string()),
            allowed_machines: vec!["PORTAL-TEST-01".to_string()],
        };
        assert!(validate_release_target(&manifest, "test", "portal-test-01").is_ok());
        assert!(validate_release_target(&manifest, "test", "OTHER-PC").is_err());
        assert!(validate_release_target(&manifest, "production", "PORTAL-TEST-01").is_err());
    }

    #[test]
    fn updater_persists_channel_under_user_data() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("test time")
            .as_nanos();
        let root = env::temp_dir().join(format!("portal-channel-test-{}-{unique}", process::id()));
        write_update_channel(&root, "test").expect("write channel");
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("data/settings/update-channel.json")).expect("channel file"),
        )
        .expect("channel JSON");
        assert_eq!(
            value.get("channel").and_then(serde_json::Value::as_str),
            Some("test")
        );
        assert_eq!(
            normalize_channel(" Production ").as_deref(),
            Ok("production")
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn updater_paths_are_resolved_before_the_working_directory_changes() {
        let base = std::path::Path::new("C:/PortalRelease");
        assert_eq!(
            absolute_path_from(base, std::path::Path::new("payload")),
            base.join("payload")
        );
        assert_eq!(
            absolute_path_from(base, std::path::Path::new("D:/PortalInstall")),
            std::path::PathBuf::from("D:/PortalInstall")
        );
    }

    #[test]
    fn managed_settings_are_refreshed_while_user_paths_are_preserved() {
        let mut installed = serde_json::json!({
            "shared": {"dataRoot": "G:/custom"},
            "dataCache": {"enabled": false},
            "business": {"database": "local.db"}
        });
        let packaged = serde_json::json!({
            "shared": {"dataRoot": "G:/template"},
            "dataCache": {"enabled": true, "minimumStartupFreeBytes": 16106127360_u64},
            "dataSources": {"systemCatalog": "system.catalog"},
            "business": {"database": "template.db"}
        });
        merge_managed_settings(&mut installed, &packaged).expect("merge");
        assert_eq!(
            installed.pointer("/shared/dataRoot"),
            Some(&serde_json::json!("G:/custom"))
        );
        assert_eq!(
            installed.pointer("/business/database"),
            Some(&serde_json::json!("local.db"))
        );
        assert_eq!(
            installed.pointer("/dataCache/enabled"),
            Some(&serde_json::json!(true))
        );
        assert_eq!(
            installed.pointer("/dataCache/minimumStartupFreeBytes"),
            Some(&serde_json::json!(16106127360_u64))
        );
        assert_eq!(
            installed.pointer("/dataSources/systemCatalog"),
            Some(&serde_json::json!("system.catalog"))
        );
    }

    #[test]
    fn remaining_packaged_configuration_replaces_corresponding_files() {
        let token = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = env::temp_dir().join(format!("portal-updater-{token}-{}", process::id()));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("nested")).expect("source");
        fs::create_dir_all(&destination).expect("destination");
        fs::write(source.join("project.toml"), "new project").expect("project");
        fs::write(source.join("nested").join("style.json"), "new style").expect("style");
        fs::write(source.join("portal.settings.json"), "packaged settings").expect("settings");
        fs::write(source.join("system.db"), "packaged catalog").expect("catalog");
        fs::write(destination.join("project.toml"), "old project").expect("old project");
        fs::write(
            destination.join("portal.settings.json"),
            "installed settings",
        )
        .expect("installed settings");
        copy_remaining_packaged_config(&source, &destination).expect("copy");
        assert_eq!(
            fs::read_to_string(destination.join("project.toml")).expect("project result"),
            "new project"
        );
        assert_eq!(
            fs::read_to_string(destination.join("nested").join("style.json"))
                .expect("style result"),
            "new style"
        );
        assert_eq!(
            fs::read_to_string(destination.join("portal.settings.json")).expect("settings result"),
            "installed settings"
        );
        assert!(!destination.join("system.db").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn updater_targets_cannot_enter_the_data_sync_directory() {
        let install_root = std::path::Path::new("C:/Users/test/AppData/Local/StormWaterPortal");
        assert!(
            ensure_update_target_is_not_user_data(install_root, &install_root.join("app")).is_ok()
        );
        assert!(
            ensure_update_target_is_not_user_data(install_root, &install_root.join("config"))
                .is_ok()
        );
        assert!(
            ensure_update_target_is_not_user_data(install_root, &install_root.join("data"))
                .is_err()
        );
        assert!(ensure_update_target_is_not_user_data(
            install_root,
            &install_root.join("data").join("source-cache")
        )
        .is_err());
    }

    #[test]
    fn full_release_layout_does_not_require_a_plaintext_system_database() {
        let token = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = env::temp_dir().join(format!("portal-updater-layout-{token}-{}", process::id()));
        fs::create_dir_all(root.join("runtime").join("portal-python")).expect("python runtime");
        fs::create_dir_all(root.join("runtime").join("duckdb").join("extensions"))
            .expect("duckdb extensions");
        fs::write(root.join("Portal.exe"), b"portal").expect("portal executable");
        fs::write(root.join("VERSION"), b"0.1.1\n").expect("version");
        fs::write(
            root.join("runtime")
                .join("portal-python")
                .join("portal-python.exe"),
            b"python",
        )
        .expect("python worker");
        fs::write(root.join("runtime").join("PortalUpdater.exe"), b"updater").expect("updater");
        fs::write(
            root.join("runtime")
                .join("duckdb")
                .join("extensions")
                .join("spatial.duckdb_extension"),
            b"spatial",
        )
        .expect("spatial extension");

        assert!(!root.join("config").join("system.db").exists());
        validate_release_layout(&root, "0.1.1")
            .expect("encrypted catalog releases must not package plaintext system.db");
        fs::remove_dir_all(root).expect("cleanup");
    }
}

fn validate_release_layout(root: &Path, expected_version: &str) -> Result<(), String> {
    if root.join("config").join("system.db").exists() {
        return Err(
            "Release contains plaintext config/system.db; the Desktop catalog must be activated as SQLCipher."
                .to_string(),
        );
    }
    for path in [
        root.join("Portal.exe"),
        root.join("VERSION"),
        root.join("runtime")
            .join("portal-python")
            .join("portal-python.exe"),
        root.join("runtime").join("PortalUpdater.exe"),
        root.join("runtime")
            .join("duckdb")
            .join("extensions")
            .join("spatial.duckdb_extension"),
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
    let application_root = installed_application_root(install_root);
    let target = application_root.join("Portal.exe");
    if !target.is_file() {
        return Err(format!(
            "The installed Portal executable was not found at {}.",
            target.display()
        ));
    }

    // Resolve the Windows known Desktop folder instead of assuming that it is
    // %USERPROFILE%\\Desktop. Enterprise folder redirection and OneDrive can
    // place the real Desktop somewhere else.
    let quote = |value: &str| value.replace('\'', "''");
    let command = format!(
        "$desktop=[Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop); if ([string]::IsNullOrWhiteSpace($desktop)) {{ throw 'Windows did not return a Desktop folder.' }}; New-Item -ItemType Directory -Force -Path $desktop | Out-Null; $shortcutPath=Join-Path $desktop 'Storm Water Portal.lnk'; $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut($shortcutPath); $shortcut.TargetPath='{}'; $shortcut.WorkingDirectory='{}'; $shortcut.IconLocation='{},0'; $shortcut.Description='Storm Water Asset Intelligence Portal'; $shortcut.Save()",
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

fn retry_io_operation<F>(attempts: usize, delay: Duration, mut operation: F) -> io::Result<()>
where
    F: FnMut() -> io::Result<()>,
{
    let attempts = attempts.max(1);
    let mut last_error = None;
    for attempt in 0..attempts {
        match operation() {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < attempts {
                    thread::sleep(delay);
                }
            }
        }
    }
    Err(last_error.expect("retry operation must run at least once"))
}

fn rename_with_retry(source: &Path, destination: &Path, action: &str) -> Result<(), String> {
    retry_io_operation(ACTIVATION_RETRY_ATTEMPTS, ACTIVATION_RETRY_DELAY, || {
        fs::rename(source, destination)
    })
    .map_err(|error| {
        format!("Could not {action} after waiting for Windows file locks to clear: {error}")
    })
}

fn unique_token() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}-{timestamp}", std::process::id())
}
