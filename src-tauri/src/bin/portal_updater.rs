#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    #[serde(default)]
    installation_payload: Option<ReleasePayload>,
    #[serde(default)]
    preserve_paths: Vec<String>,
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
    let bootstrap = arguments.contains_key("bootstrap");
    install_release(&release_root, &install_root, &manifest, bootstrap)?;

    if bootstrap {
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
    validate_payload(&manifest.payload, "payload")?;
    if let Some(payload) = &manifest.installation_payload {
        validate_payload(payload, "installationPayload")?;
    }
    if !manifest.preserve_paths.is_empty() && manifest.preserve_paths != ["data".to_string()] {
        return Err("Release manifest preservePaths may contain only data.".to_string());
    }
    Ok(manifest)
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
    write_update_state(install_root, manifest, applied_mode)?;
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
    let packaged_system_database = staged_config.join("system.db");
    if packaged_system_database.is_file() {
        replace_file(&packaged_system_database, &config_root.join("system.db"))?;
        mark_read_only(&config_root.join("system.db"));
    }
    copy_remaining_packaged_config(&staged_config, &config_root)?;
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
) -> Result<(), String> {
    let directory = install_root.join("config");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Portal configuration directory: {error}"))?;
    let destination = directory.join("update-state.json");
    let temporary = directory.join(".update-state.next");
    let contents = serde_json::json!({
        "version": manifest.version,
        "updateMode": applied_mode,
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

#[cfg(test)]
mod tests {
    use super::{
        copy_remaining_packaged_config, ensure_update_target_is_not_user_data,
        merge_managed_settings,
    };
    use std::{env, fs, process, time::SystemTime};

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
