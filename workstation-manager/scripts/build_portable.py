from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PORTAL_ROOT = PROJECT_ROOT.parent
OUTPUT_DIRECTORY = PROJECT_ROOT / "dist" / "Portal-Workstation-Manager"


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

    if not release_executable.is_file():
        raise FileNotFoundError("Build the standalone application first: pnpm tauri:build")
    if not (coordinator_source / "app" / "sync").is_dir() or not (coordinator_source / "app" / "schema").is_dir():
        raise FileNotFoundError(f"Coordinator package was not found: {coordinator_source}")

    # Update in place so an already-running scheduler keeps its loaded Python
    # process and the deployed folder is never left partially deleted.
    output_directory.mkdir(parents=True, exist_ok=True)

    copy_required(release_executable, output_directory / "PortalWorkstationManager.exe")

    config_directory = output_directory / "config"
    config_directory.mkdir(exist_ok=True)
    portable_settings = json.loads(
        (PROJECT_ROOT / "config" / "workstation-manager.settings.json").read_text(encoding="utf-8-sig")
    )
    portable_settings["portalSettingsFile"] = "../../../../dist/Portal-Desktop/config/portal.settings.json"
    (config_directory / "workstation-manager.settings.json").write_text(
        json.dumps(portable_settings, indent=2) + "\n",
        encoding="utf-8",
    )

    coordinator_directory = output_directory / "coordinator"
    copy_required(PROJECT_ROOT / "coordinator" / "repository_runner.py", coordinator_directory / "repository_runner.py")
    copy_required(PROJECT_ROOT / "coordinator" / "schema_runner.py", coordinator_directory / "schema_runner.py")
    coordinator_package = coordinator_directory / "python" / "portal"
    copy_required(coordinator_source / "__init__.py", coordinator_package / "__init__.py")
    copy_required(coordinator_source / "app" / "__init__.py", coordinator_package / "app" / "__init__.py")
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

    sync_directory = output_directory / "sync"
    sync_directory.mkdir(exist_ok=True)
    for filename in (
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
        "Portal Workstation Manager\n"
        "==========================\n\n"
        "Start the application by double-clicking:\n\n"
        "  PortalWorkstationManager.exe\n\n"
        "The config, coordinator, and sync directories must remain beside the executable.\n",
        encoding="utf-8",
    )
    print(f"Portable folder created at: {output_directory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
