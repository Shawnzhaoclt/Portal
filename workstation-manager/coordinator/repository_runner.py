from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any


# The portable build places the coordinator package beside this runner. During
# source development, reuse the Portal package without duplicating it.
_RUNNER_DIRECTORY = Path(__file__).resolve().parent
_PACKAGED_PYTHON = _RUNNER_DIRECTORY / "python"
_DEVELOPMENT_PYTHON = _RUNNER_DIRECTORY.parent.parent / "python"
for _candidate in (_PACKAGED_PYTHON, _DEVELOPMENT_PYTHON):
    if (_candidate / "portal" / "app" / "sync").is_dir():
        sys.path.insert(0, str(_candidate))
        break

from portal.app.sync.coordinator import bootstrap_shared_store
from portal.app.sync.membership import load_membership
from portal.app.sync.models import Identity, SyncPaths
from portal.app.sync.snapshot import load_snapshot_pointer, snapshot_file, validate_snapshot
from portal.app.sync.storage import require_shared_root, sqlite_readonly_uri


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {path}.")
    return value


def _expand(value: str, *, settings_path: Path, data_root: str) -> Path:
    settings_path = settings_path.resolve()
    app_root = settings_path.parent.parent
    replacements = {
        "${PORTAL_APP_ROOT}": str(app_root),
        "${PORTAL_DATA_ROOT}": str(app_root),
        "${PORTAL_SHARED_DATA_ROOT}": data_root,
        "${PORTAL_BUSINESS_NETWORK_ROOT}": str(Path(data_root) / "portal" / "data"),
    }
    for token, replacement in replacements.items():
        value = value.replace(token, replacement)
    value = os.path.expandvars(value)
    candidate = Path(value)
    return candidate if candidate.is_absolute() else (settings_path.parent / candidate).resolve()


def _configured_paths(settings_path: Path, network_root_override: str | None = None) -> tuple[Path, Path]:
    settings = _read_json(settings_path)
    data_root = str(settings.get("shared", {}).get("dataRoot", "")).strip()
    network_root = (network_root_override or str(settings.get("businessSync", {}).get("networkRoot", "")).strip()).strip()
    system_database = str(settings.get("system", {}).get("database", "")).strip()
    if not data_root or not network_root or not system_database:
        raise ValueError(
            "Portal settings must define shared.dataRoot, businessSync.networkRoot, and system.database."
        )
    return (
        _expand(network_root, settings_path=settings_path, data_root=data_root),
        _expand(system_database, settings_path=settings_path, data_root=data_root),
    )


def _save_network_root(settings_path: Path, network_root: str) -> None:
    settings = _read_json(settings_path)
    business_sync = settings.get("businessSync")
    if not isinstance(business_sync, dict):
        raise ValueError("Portal settings must define a businessSync object.")
    business_sync["networkRoot"] = network_root
    settings_path.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _members(system_database: Path) -> list[Identity]:
    if not system_database.is_file():
        raise ValueError(f"The configured system database was not found: {system_database}")
    with sqlite3.connect(sqlite_readonly_uri(system_database), uri=True) as connection:
        rows = connection.execute(
            """
            SELECT id, employee_id, email
            FROM SYS_USERS
            WHERE is_active = 1
              AND deleted_at IS NULL
              AND COALESCE(employee_id, '') <> ''
            ORDER BY id
            """
        ).fetchall()
    return [Identity(str(row[0]), str(row[1]), str(row[2] or "")) for row in rows]


def _status(network_root: Path, system_database: Path) -> dict[str, Any]:
    paths = SyncPaths(network_root)
    result: dict[str, Any] = {
        "network_root": str(network_root),
        "protocol_root": str(paths.protocol_root),
        "system_database": str(system_database),
        "shared_available": False,
        "initialized": False,
        "membership_count": 0,
        "snapshot_id": "",
        "snapshot_epoch_id": "",
    }
    require_shared_root(network_root)
    result["shared_available"] = True
    if not paths.membership_current.is_file() or not paths.snapshots_current.is_file():
        return result
    membership = load_membership(paths.protocol_root)
    pointer = load_snapshot_pointer(paths.protocol_root)
    result.update(
        {
            "initialized": True,
            "membership_count": len(membership.members),
            "snapshot_id": pointer.snapshot_id,
            "snapshot_epoch_id": pointer.snapshot_epoch_id,
        }
    )
    return result


def _validate(network_root: Path, system_database: Path) -> dict[str, Any]:
    result = _status(network_root, system_database)
    if not result["initialized"]:
        return {**result, "valid": False, "message": "The shared repository has not been initialized."}
    paths = SyncPaths(network_root)
    membership = load_membership(paths.protocol_root)
    pointer = load_snapshot_pointer(paths.protocol_root)
    validate_snapshot(snapshot_file(paths.protocol_root, pointer), pointer)
    required_directories = (
        paths.protocol_root / "membership" / "releases",
        paths.protocol_root / "users",
        paths.protocol_root / "snapshots",
        paths.protocol_root / "activity" / "epochs",
        paths.save_mutex_root,
    )
    missing = [str(path) for path in required_directories if not path.is_dir()]
    if missing:
        return {**result, "valid": False, "message": "Required repository directories are missing.", "missing": missing}
    return {
        **result,
        "valid": True,
        "message": f"Validated membership release {membership.release_id} and the active snapshot.",
    }


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portal workstation repository task runner")
    parser.add_argument("--task", choices=("repository.status", "repository.validate", "repository.bootstrap"), required=True)
    parser.add_argument("--portal-settings", type=Path, required=True)
    parser.add_argument("--network-root", default="")
    return parser.parse_args()


def main() -> int:
    args = _parse_arguments()
    try:
        configured_network_root = args.network_root.strip()
        network_root, system_database = _configured_paths(
            args.portal_settings,
            configured_network_root or None,
        )
        if args.task == "repository.status":
            result = _status(network_root, system_database)
        elif args.task == "repository.validate":
            result = _validate(network_root, system_database)
        else:
            members = _members(system_database)
            result = bootstrap_shared_store(network_root, members)
            if configured_network_root:
                _save_network_root(args.portal_settings, configured_network_root)
            result["initialized"] = True
            result["message"] = "The shared repository was initialized."
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as error:  # Safe task boundary; diagnostic tracebacks stay out of the UI.
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
