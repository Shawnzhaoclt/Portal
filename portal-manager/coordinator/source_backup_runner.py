from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
from typing import Any


REQUIRED_FILES = (
    "backup_duckdb_files.py",
    "backup_duckdb_files.json",
    "clone_sqlserver_to_duckdb.py",
    "clone_sqlserver_to_duckdb.json",
    "clone_spatial_data_warehouse_to_duckdb.py",
    "clone_spatial_data_warehouse_to_duckdb.json",
    "export_arcgis_layer_to_parquet.py",
    "send_machine_online_heartbeat.ps1",
    "send_stm_risk_data_notification.ps1",
)
VALID_ACTIONS = {"check", "workflow", "refresh", "backup", "heartbeat", "map_tiles"}
MAX_RECENT_LOGS = 10


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Configuration file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object in {path}")
    return value


def _expand_path(value: str, base: Path) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(value))
    candidate = Path(expanded)
    return candidate if candidate.is_absolute() else (base / candidate).resolve()


def _manager_configuration(path: Path) -> tuple[dict[str, Any], Path, Path]:
    settings = _read_json(path)
    base = path.resolve().parent
    scripts_value = str(settings.get("sourceBackupDirectory") or "../source-backup")
    scripts_directory = _expand_path(scripts_value, base)
    local_app_data = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    state_directory = local_app_data / "PortalManager" / "source-backup"
    return settings, scripts_directory, state_directory


def _map_tiles_configuration(
    settings: dict[str, Any],
    manager_settings: Path,
) -> tuple[Path, Path, Path]:
    manager_base = manager_settings.resolve().parent
    directory = _expand_path(str(settings.get("mapTilesDirectory") or "../map-tiles"), manager_base)
    builder_value = str(settings.get("mapTilesBuilder") or "build_pmtiles_from_duckdb.py")
    settings_value = str(settings.get("mapTilesSettingsFile") or "pmtiles.settings.json")
    builder = _expand_path(builder_value, directory)
    config = _expand_path(settings_value, directory)
    return directory, builder, config


def _map_tiles_missing_files(builder: Path, config: Path) -> list[str]:
    candidates = [builder, builder.parent / "pmtiles_v3.py", config]
    return [str(path) for path in candidates if not path.is_file()]


def _expand_map_tiles_output(value: str, config: dict[str, Any], base: Path) -> Path:
    shared_root = os.path.expandvars(os.path.expanduser(str(config.get("sharedDataRoot") or "")))
    expanded = value.replace("${PORTAL_SHARED_DATA_ROOT}", shared_root)
    return _expand_path(expanded, base)


def _safe_map_tiles_summary(directory: Path, builder: Path, config_path: Path) -> dict[str, Any]:
    config = _read_json(config_path)
    defaults = config.get("defaults") if isinstance(config.get("defaults"), dict) else {}
    progress_value = str(defaults.get("progressFile") or "").strip()
    if progress_value:
        progress_path = _expand_map_tiles_output(progress_value, config, config_path.parent)
    else:
        local_app_data = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        progress_path = local_app_data / "PortalManager" / "map-tiles" / "progress.json"
    try:
        progress = _read_json(progress_path)
    except RuntimeError:
        progress = {}
    tilesets: list[dict[str, Any]] = []
    for item in config.get("tilesets", []):
        if not isinstance(item, dict) or not bool(item.get("enabled", True)):
            continue
        output_value = str(item.get("output") or "").strip()
        output = _expand_map_tiles_output(output_value, config, config_path.parent) if output_value else None
        manifest = output.with_suffix(output.suffix + ".manifest.json") if output else None
        tilesets.append(
            {
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or item.get("id") or ""),
                "output": str(output) if output else "",
                "available": bool(output and output.is_file()),
                "size_bytes": output.stat().st_size if output and output.is_file() else 0,
                "manifest": str(manifest) if manifest and manifest.is_file() else "",
            }
        )
    return {
        "map_tiles_directory": str(directory),
        "map_tiles_builder": str(builder),
        "map_tiles_settings_file": str(config_path),
        "map_tiles_progress_file": str(progress_path),
        "map_tiles_progress": progress,
        "map_tiles_tileset_count": len(tilesets),
        "map_tiles_output_count": sum(1 for item in tilesets if item["available"]),
        "map_tiles_outputs": tilesets,
    }


def _python_executable(settings: dict[str, Any]) -> str:
    configured = str(
        settings.get("sourceBackupPythonExecutable")
        or settings.get("pythonExecutable")
        or sys.executable
    )
    return os.path.expandvars(os.path.expanduser(configured))


def _timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _populate_duration(run: dict[str, Any]) -> bool:
    existing = run.get("duration_seconds")
    if isinstance(existing, (int, float)) and not isinstance(existing, bool) and existing >= 0:
        return False
    started_value = str(run.get("started_at") or "").strip()
    finished_value = str(run.get("finished_at") or "").strip()
    if not started_value or not finished_value:
        return False
    try:
        started = datetime.fromisoformat(started_value)
        finished = datetime.fromisoformat(finished_value)
        elapsed = (finished - started).total_seconds()
    except (TypeError, ValueError):
        return False
    run["duration_seconds"] = round(max(0.0, elapsed), 3)
    return True


def _configured_environment_value(name: str) -> str:
    value = os.environ.get(name, "")
    if value or os.name != "nt" or not name:
        return value
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _value_type = winreg.QueryValueEx(key, name)
            return str(value)
    except (FileNotFoundError, OSError):
        return ""


def _hydrate_source_credentials(scripts_directory: Path) -> None:
    clone = _read_json(scripts_directory / "clone_sqlserver_to_duckdb.json")
    databases = clone.get("databases") if isinstance(clone.get("databases"), dict) else {}
    for database in databases.values():
        if not isinstance(database, dict) or database.get("auth_method") != "sql_server":
            continue
        name = str(database.get("password_env") or "")
        value = _configured_environment_value(name)
        if name and value:
            os.environ[name] = value


def _write_json_replace(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _process_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        completed = subprocess.run(
            ["tasklist.exe", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return completed.returncode == 0 and str(pid) in completed.stdout and "No tasks" not in completed.stdout
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _read_state(state_directory: Path) -> dict[str, Any]:
    state_path = state_directory / "status.json"
    try:
        state = _read_json(state_path)
    except RuntimeError:
        return {}
    changed = False
    if state.get("status") == "running" and not _process_is_running(int(state.get("pid") or 0)):
        state["status"] = "failed"
        state["finished_at"] = state.get("finished_at") or _timestamp()
        state["details"] = "The previous source-backup process ended without recording a final result."
        changed = True
    if _populate_duration(state):
        changed = True
    if changed:
        _write_json_replace(state_path, state)
    return state


def _safe_configuration_summary(scripts_directory: Path) -> dict[str, Any]:
    backup_path = scripts_directory / "backup_duckdb_files.json"
    clone_path = scripts_directory / "clone_sqlserver_to_duckdb.json"
    backup = _read_json(backup_path)
    clone = _read_json(clone_path)
    spatial_clone_path = scripts_directory / "clone_spatial_data_warehouse_to_duckdb.json"
    spatial_clone = _read_json(spatial_clone_path)
    backup_base = backup_path.parent
    clone_base = clone_path.parent
    source_directory = _expand_path(str(backup.get("duckdb_source_dir") or ""), backup_base)
    backup_directory = _expand_path(str(backup.get("backup_dir") or ""), backup_base)
    output_root = _expand_path(str(clone.get("output_root") or ""), clone_base)
    archive_prefix = str(backup.get("archive_prefix") or "duckdb_backup")
    archives: list[dict[str, Any]] = []
    archive_count = 0
    if backup_directory.is_dir():
        archive_files = sorted(
            backup_directory.glob(f"{archive_prefix}_*.zip"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        archive_count = len(archive_files)
        for archive in archive_files:
            stat = archive.stat()
            archives.append(
                {
                    "name": archive.name,
                    "path": str(archive),
                    "size_bytes": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec="seconds"),
                }
            )
    databases = clone.get("databases") if isinstance(clone.get("databases"), dict) else {}
    credential_issues: list[str] = []
    for key, database in databases.items():
        if not isinstance(database, dict) or database.get("auth_method") != "sql_server":
            continue
        password_environment = str(database.get("password_env") or "")
        if not database.get("password") and not (
            password_environment and _configured_environment_value(password_environment)
        ):
            credential_issues.append(
                f"{key}: set the {password_environment or 'configured password'} credential"
            )
    directory_sources = backup.get("directory_sources") if isinstance(backup.get("directory_sources"), list) else []
    recipients = (backup.get("email") or {}).get("to_addresses") if isinstance(backup.get("email"), dict) else []
    spatial_databases = spatial_clone.get("databases") if isinstance(spatial_clone.get("databases"), dict) else {}
    spatial_database = next(iter(spatial_databases.values()), {})
    spatial_output_root = _expand_path(str(spatial_clone.get("output_root") or ""), spatial_clone_path.parent)
    spatial_database_name = str(spatial_database.get("duckdb_name") or "")
    return {
        "scripts_directory": str(scripts_directory),
        "backup_settings_file": str(backup_path),
        "clone_settings_file": str(clone_path),
        "source_directory": str(source_directory),
        "backup_directory": str(backup_directory),
        "output_root": str(output_root),
        "retention_days": int(backup.get("retention_days") or 0),
        "database_count": len(databases),
        "refresh_ready": not credential_issues,
        "credential_issues": credential_issues,
        "directory_source_count": len(directory_sources),
        "notification_recipient_count": len(recipients or []),
        "create_filegdb": bool(clone.get("create_filegdb")),
        "spatial_warehouse_output_path": str(spatial_output_root / spatial_database_name),
        "spatial_warehouse_layer_count": len(spatial_clone.get("items") or []),
        "archive_count": archive_count,
        "archives": archives,
    }


def status(manager_settings: Path) -> dict[str, Any]:
    settings, scripts_directory, state_directory = _manager_configuration(manager_settings)
    missing = [name for name in REQUIRED_FILES if not (scripts_directory / name).is_file()]
    map_tiles_directory, map_tiles_builder, map_tiles_config = _map_tiles_configuration(
        settings,
        manager_settings,
    )
    map_tiles_missing = _map_tiles_missing_files(map_tiles_builder, map_tiles_config)
    result: dict[str, Any] = {
        "available": not missing,
        "missing_files": missing,
        "map_tiles_available": not map_tiles_missing,
        "map_tiles_missing_files": map_tiles_missing,
        "manager_settings_file": str(manager_settings.resolve()),
        "state_directory": str(state_directory),
        "log_directory": str(state_directory / "logs"),
        "backup_weekday": str(settings.get("sourceBackupWeekday") or "SAT").upper(),
        "state": _read_state(state_directory),
        "runs": [],
    }
    history_path = state_directory / "history.json"
    try:
        history = _read_json(history_path)
        if isinstance(history.get("runs"), list):
            original_count = len(history["runs"])
            trimmed = _trim_history(state_directory, history)
            history_changed = original_count != len(trimmed["runs"])
            for run in trimmed["runs"]:
                if isinstance(run, dict) and _populate_duration(run):
                    history_changed = True
            if history_changed:
                _write_json_replace(history_path, trimmed)
            result["runs"] = trimmed["runs"]
    except RuntimeError:
        pass
    if not missing:
        result.update(_safe_configuration_summary(scripts_directory))
    else:
        result["scripts_directory"] = str(scripts_directory)
    if not map_tiles_missing:
        result.update(_safe_map_tiles_summary(map_tiles_directory, map_tiles_builder, map_tiles_config))
    else:
        result["map_tiles_directory"] = str(map_tiles_directory)
        result["map_tiles_builder"] = str(map_tiles_builder)
        result["map_tiles_settings_file"] = str(map_tiles_config)
    return result


def _trim_history(state_directory: Path, history: dict[str, Any]) -> dict[str, Any]:
    runs = history.get("runs") if isinstance(history.get("runs"), list) else []
    retained = runs[:MAX_RECENT_LOGS]
    log_directory = (state_directory / "logs").resolve()
    for old_run in runs[MAX_RECENT_LOGS:]:
        if not isinstance(old_run, dict):
            continue
        log_value = old_run.get("log_path")
        if not log_value:
            continue
        log_path = Path(str(log_value)).resolve()
        try:
            log_path.relative_to(log_directory)
        except ValueError:
            continue
        log_path.unlink(missing_ok=True)
    history["runs"] = retained
    return history


def _append_history(state_directory: Path, run: dict[str, Any]) -> None:
    history_path = state_directory / "history.json"
    try:
        history = _read_json(history_path)
    except RuntimeError:
        history = {"runs": []}
    runs = history.get("runs") if isinstance(history.get("runs"), list) else []
    history["runs"] = [run, *runs]
    _write_json_replace(history_path, _trim_history(state_directory, history))


def _run_logged(command: list[str], log_file: Any, cwd: Path) -> None:
    display = " ".join(f'"{part}"' if " " in part else part for part in command[:2])
    print(f"Running: {display}", file=log_file, flush=True)
    completed = subprocess.run(
        command,
        cwd=cwd,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"{Path(command[1] if len(command) > 1 else command[0]).name} exited with code {completed.returncode}.")


def _send_workflow_notification(scripts_directory: Path, status_value: str, details: str, log_file: Any) -> None:
    script = scripts_directory / "send_stm_risk_data_notification.ps1"
    try:
        _run_logged(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
                "-Status",
                status_value,
                "-Details",
                details,
            ],
            log_file,
            scripts_directory,
        )
    except Exception as exc:
        print(f"Notification warning: {exc}", file=log_file, flush=True)


def run_action(manager_settings: Path, action: str) -> int:
    if action not in VALID_ACTIONS:
        raise RuntimeError(f"Unsupported source-backup action: {action}")
    settings, scripts_directory, state_directory = _manager_configuration(manager_settings)
    missing = [name for name in REQUIRED_FILES if not (scripts_directory / name).is_file()]
    map_tiles_directory, map_tiles_builder, map_tiles_config = _map_tiles_configuration(
        settings,
        manager_settings,
    )
    map_tiles_missing = _map_tiles_missing_files(map_tiles_builder, map_tiles_config)
    run_clock = datetime.now().astimezone()
    backup_weekday = str(settings.get("sourceBackupWeekday") or "SAT").upper()
    weekly_workflow_due = (
        action == "workflow" and run_clock.strftime("%a").upper() == backup_weekday
    )
    if action != "map_tiles" and missing:
        raise RuntimeError("Required source-backup files are missing: " + ", ".join(missing))
    if (action in {"check", "map_tiles"} or weekly_workflow_due) and map_tiles_missing:
        raise RuntimeError("Required PMTiles files are missing: " + ", ".join(map_tiles_missing))
    if action != "map_tiles":
        _hydrate_source_credentials(scripts_directory)

    state_directory.mkdir(parents=True, exist_ok=True)
    lock_path = state_directory / "run.lock"
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        previous = _read_state(state_directory)
        if _process_is_running(int(previous.get("pid") or 0)):
            raise RuntimeError("A source-backup task is already running.")
        lock_path.unlink(missing_ok=True)
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(lock_fd, str(os.getpid()).encode("ascii"))
    os.close(lock_fd)

    started_monotonic = time.perf_counter()
    started_at = run_clock.isoformat(timespec="seconds")
    run_id = run_clock.strftime("%Y%m%dT%H%M%S")
    log_directory = state_directory / "logs"
    log_directory.mkdir(parents=True, exist_ok=True)
    log_path = log_directory / f"source-backup-{run_id}-{action}.log"
    state = {
        "run_id": run_id,
        "action": action,
        "status": "running",
        "details": "Task started.",
        "started_at": started_at,
        "finished_at": "",
        "pid": os.getpid(),
        "log_path": str(log_path),
    }
    _write_json_replace(state_directory / "status.json", state)
    result = 0

    try:
        python_executable = _python_executable(settings)
        with log_path.open("w", encoding="utf-8", errors="replace") as log_file:
            print(f"Portal Manager source-backup task: {action}", file=log_file)
            print(f"Started: {started_at}", file=log_file)
            if action == "check":
                _safe_configuration_summary(scripts_directory)
                _run_logged(
                    [python_executable, str(scripts_directory / "clone_sqlserver_to_duckdb.py"), "--list"],
                    log_file,
                    scripts_directory,
                )
                _run_logged(
                    [
                        python_executable,
                        str(map_tiles_builder),
                        "--config",
                        str(map_tiles_config),
                        "--check",
                    ],
                    log_file,
                    map_tiles_directory,
                )
                details = "Source and PMTiles configuration are valid."
            elif action == "map_tiles":
                _run_logged(
                    [
                        python_executable,
                        str(map_tiles_builder),
                        "--config",
                        str(map_tiles_config),
                    ],
                    log_file,
                    map_tiles_directory,
                )
                details = "Portal PMTiles archives were generated successfully."
            elif action == "backup":
                _run_logged(
                    [python_executable, str(scripts_directory / "backup_duckdb_files.py")],
                    log_file,
                    scripts_directory,
                )
                details = "Source-data backup completed successfully."
            elif action == "refresh":
                _run_logged(
                    [python_executable, str(scripts_directory / "clone_sqlserver_to_duckdb.py")],
                    log_file,
                    scripts_directory,
                )
                _run_logged(
                    [
                        python_executable,
                        str(scripts_directory / "clone_spatial_data_warehouse_to_duckdb.py"),
                        "--continue-on-error",
                    ],
                    log_file,
                    scripts_directory,
                )
                details = (
                    "SQL Server source mirrors and the Spatial Data Warehouse mirror "
                    "were rebuilt successfully."
                )
            elif action == "heartbeat":
                _run_logged(
                    [
                        "powershell.exe",
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(scripts_directory / "send_machine_online_heartbeat.ps1"),
                        "-ConfigPath",
                        str(scripts_directory / "backup_duckdb_files.json"),
                    ],
                    log_file,
                    scripts_directory,
                )
                details = "Machine heartbeat notification was sent successfully."
            else:
                backup_performed = weekly_workflow_due
                if backup_performed:
                    _run_logged(
                        [python_executable, str(scripts_directory / "backup_duckdb_files.py")],
                        log_file,
                        scripts_directory,
                    )
                _run_logged(
                    [python_executable, str(scripts_directory / "clone_sqlserver_to_duckdb.py")],
                    log_file,
                    scripts_directory,
                )
                spatial_refresh_performed = False
                if backup_performed:
                    _run_logged(
                        [
                            python_executable,
                            str(scripts_directory / "clone_spatial_data_warehouse_to_duckdb.py"),
                            "--continue-on-error",
                        ],
                        log_file,
                        scripts_directory,
                    )
                    spatial_refresh_performed = True
                    _run_logged(
                        [
                            python_executable,
                            str(map_tiles_builder),
                            "--config",
                            str(map_tiles_config),
                        ],
                        log_file,
                        map_tiles_directory,
                    )
                if spatial_refresh_performed:
                    details = (
                        "Backup, SQL Server source refresh, and Spatial Data Warehouse refresh "
                        "completed successfully. Portal PMTiles archives were then rebuilt and validated."
                    )
                else:
                    details = (
                        f"Weekly backup was not due ({backup_weekday}); SQL Server source refresh "
                        "completed successfully. Spatial Data Warehouse refresh was skipped."
                    )
                _send_workflow_notification(scripts_directory, "SUCCESS", details, log_file)
            print(f"Completed: {_timestamp()}", file=log_file)
            print(details, file=log_file)
        state.update(status="succeeded", details=details, finished_at=_timestamp())
    except Exception as exc:
        result = 1
        details = str(exc)
        try:
            with log_path.open("a", encoding="utf-8", errors="replace") as log_file:
                print("\nTask failed:", file=log_file)
                traceback.print_exc(file=log_file)
                if action == "workflow":
                    _send_workflow_notification(scripts_directory, "FAILED", details, log_file)
        except Exception:
            pass
        state.update(status="failed", details=details, finished_at=_timestamp())
    finally:
        state["duration_seconds"] = round(max(0.0, time.perf_counter() - started_monotonic), 3)
        _write_json_replace(state_directory / "status.json", state)
        _append_history(state_directory, state)
        lock_path.unlink(missing_ok=True)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Portal Manager source backup and mirror coordinator.")
    parser.add_argument(
        "--manager-settings",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "config" / "workstation-manager.settings.json",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--status", action="store_true")
    group.add_argument("--action", choices=sorted(VALID_ACTIONS))
    args = parser.parse_args(argv)
    try:
        if args.status:
            print(json.dumps({"ok": True, "result": status(args.manager_settings)}))
            return 0
        return run_action(args.manager_settings, str(args.action))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
