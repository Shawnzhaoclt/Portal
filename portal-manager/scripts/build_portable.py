from __future__ import annotations

import argparse
import json
import shutil
import stat
import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PORTAL_ROOT = PROJECT_ROOT.parent
OUTPUT_DIRECTORY = PROJECT_ROOT / "dist" / "Portal-Manager"


def parse_args() -> None:
    parser = argparse.ArgumentParser(
        description=f"Build the portable manager at {OUTPUT_DIRECTORY}.",
    )
    parser.parse_args()


def copy_required(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"Required file was not found: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> int:
    parse_args()
    output_directory = OUTPUT_DIRECTORY.resolve()
    release_executable = PROJECT_ROOT / "src-tauri" / "target" / "release" / "portal-workstation-manager.exe"
    coordinator_source = PORTAL_ROOT / "python" / "portal"
    portal_settings_source = PORTAL_ROOT / "dist" / "Portal-Desktop" / "config" / "portal.settings.json"
    portal_system_database_source = PORTAL_ROOT / "dist" / "Portal-Desktop" / "config" / "system.db"
    portal_python_source = PORTAL_ROOT / "dist" / "Portal-Desktop" / "runtime" / "portal-python"
    sync_settings_source = PROJECT_ROOT / "sync" / "sync.settings.json"

    if not release_executable.is_file():
        raise FileNotFoundError("Build the standalone application first: pnpm tauri:build")
    if not (coordinator_source / "app" / "sync").is_dir() or not (coordinator_source / "app" / "schema").is_dir():
        raise FileNotFoundError(f"Coordinator package was not found: {coordinator_source}")
    if not portal_settings_source.is_file():
        raise FileNotFoundError(f"Portal settings were not found: {portal_settings_source}")
    if not portal_system_database_source.is_file():
        raise FileNotFoundError(f"Portal system database was not found: {portal_system_database_source}")
    if not (portal_python_source / "portal-python.exe").is_file():
        raise FileNotFoundError(
            "The packaged Portal Python worker was not found. Build Portal-Desktop before packaging PortalManager."
        )
    worker_help = subprocess.run(
        [str(portal_python_source / "portal-python.exe"), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    if worker_help.returncode != 0 or "management" not in worker_help.stdout:
        raise RuntimeError(
            "The packaged Portal Python worker does not include the Manager management job. "
            "Run pnpm desktop:portable before packaging PortalManager."
        )
    if not sync_settings_source.is_file():
        raise FileNotFoundError(f"Source-sync settings were not found: {sync_settings_source}")

    # Update in place so an already-running scheduler keeps its loaded Python
    # process and the deployed folder is never left partially deleted.
    output_directory.mkdir(parents=True, exist_ok=True)

    copy_required(release_executable, output_directory / "PortalManager.exe")

    config_directory = output_directory / "config"
    config_directory.mkdir(exist_ok=True)
    portable_settings = json.loads(
        (PROJECT_ROOT / "config" / "workstation-manager.settings.json").read_text(encoding="utf-8-sig")
    )
    # Keep the portable settings relative to the executable so the Manager
    # cannot fall back to an old workstation-manager build directory.
    portable_settings["syncDirectory"] = "../sync"
    portable_settings["syncSettingsFile"] = "sync.settings.json"
    portable_settings["portalSettingsFile"] = "portal.settings.json"
    portable_settings["portalReleaseSettingsFile"] = "../../../../dist/Portal-Desktop/config/portal.settings.json"
    portable_settings["portalPythonWorker"] = "../runtime/portal-python/portal-python.exe"
    (config_directory / "workstation-manager.settings.json").write_text(
        json.dumps(portable_settings, indent=2) + "\n",
        encoding="utf-8",
    )
    copy_required(portal_settings_source, config_directory / "portal.settings.json")
    manager_system_database = config_directory / "system.db"
    if not manager_system_database.is_file():
        copy_required(portal_system_database_source, manager_system_database)
    manager_system_database.chmod(manager_system_database.stat().st_mode | stat.S_IWRITE)

    coordinator_directory = output_directory / "coordinator"
    copy_required(PROJECT_ROOT / "coordinator" / "repository_runner.py", coordinator_directory / "repository_runner.py")
    copy_required(PROJECT_ROOT / "coordinator" / "schema_runner.py", coordinator_directory / "schema_runner.py")
    copy_required(PROJECT_ROOT / "coordinator" / "maintenance_runner.py", coordinator_directory / "maintenance_runner.py")
    for filename in (
        "run-business-retention.bat",
        "register-weekly-business-retention-task.bat",
        "remove-weekly-business-retention-task.bat",
        "run-nightly-business-maintenance.bat",
        "register-nightly-business-maintenance-task.bat",
        "remove-nightly-business-maintenance-task.bat",
    ):
        copy_required(PROJECT_ROOT / "coordinator" / filename, coordinator_directory / filename)

    shutil.copytree(
        portal_python_source,
        output_directory / "runtime" / "portal-python",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "*.log"),
    )
    coordinator_package = coordinator_directory / "python" / "portal"
    copy_required(coordinator_source / "__init__.py", coordinator_package / "__init__.py")
    copy_required(coordinator_source / "app" / "__init__.py", coordinator_package / "app" / "__init__.py")
    copy_required(
        coordinator_source / "app" / "management_runner.py",
        coordinator_package / "app" / "management_runner.py",
    )
    shutil.copytree(
        coordinator_source / "app" / "sync",
        coordinator_package / "app" / "sync",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "*.log"),
    )
    shutil.copytree(
        coordinator_source / "app" / "schema",
        coordinator_package / "app" / "schema",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "*.log"),
    )
    for cache_directory in coordinator_directory.rglob("__pycache__"):
        shutil.rmtree(cache_directory, ignore_errors=True)
    for compiled_file in coordinator_directory.rglob("*.py[co]"):
        compiled_file.unlink(missing_ok=True)

    sync_directory = output_directory / "sync"
    sync_directory.mkdir(exist_ok=True)
    for filename in (
        "start-source-sync.bat",
        "sync_portal_sources.py",
        "sync.settings.json",
        "sync.settings.template.json",
    ):
        copy_required(PROJECT_ROOT / "sync" / filename, sync_directory / filename)

    for obsolete_name in (
        "start_sync.bat",
        "stop_sync.bat",
        "sync_launcher.py",
        "start_sync_hidden.vbs",
        "stop_sync.vbs",
        "workstation_manager.ps1",
    ):
        (sync_directory / obsolete_name).unlink(missing_ok=True)

    (output_directory / "README.txt").write_text(
        "Portal Manager\n"
        "==========================\n\n"
        "Start the application by double-clicking:\n\n"
        "  PortalManager.exe\n\n"
        "The config, coordinator, and sync directories must remain beside the executable.\n"
        "config\\system.db is the authoritative Manager administration database.\n",
        encoding="utf-8",
    )
    print(f"Portable folder created at: {output_directory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
