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
from portal.app.sync.errors import LockTimeout
from portal.app.sync.membership import load_membership
from portal.app.sync.models import Identity, SyncPaths
from portal.app.sync.snapshot import load_snapshot_pointer, snapshot_file, validate_snapshot
from portal.app.sync.storage import FileRangeLock, atomic_replace_bytes, read_json, sqlite_readonly_uri


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


def _settings_payload_with_network_root(settings_path: Path, network_root: str) -> bytes:
    settings = _read_json(settings_path)
    business_sync = settings.get("businessSync")
    if not isinstance(business_sync, dict):
        raise ValueError(f"Portal settings must define a businessSync object: {settings_path}")
    business_sync["networkRoot"] = network_root
    return (json.dumps(settings, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _save_network_root(settings_paths: list[Path], network_root: Path) -> list[str]:
    unique_paths: list[Path] = []
    for path in settings_paths:
        resolved = path.resolve()
        if resolved not in unique_paths:
            unique_paths.append(resolved)
    if not unique_paths:
        raise ValueError("No Portal settings file was supplied.")

    original_values: dict[Path, bytes] = {}
    replacement_values: dict[Path, bytes] = {}
    for path in unique_paths:
        if not path.is_file():
            raise ValueError(f"Portal settings were not found: {path}")
        original_values[path] = path.read_bytes()
        replacement_values[path] = _settings_payload_with_network_root(path, str(network_root))

    replaced: list[Path] = []
    try:
        for path in unique_paths:
            atomic_replace_bytes(path, replacement_values[path])
            replaced.append(path)
        for path in unique_paths:
            configured_root, _system_database = _configured_paths(path)
            if configured_root.resolve() != network_root.resolve():
                raise RuntimeError(f"The saved repository path could not be verified in {path}.")
    except Exception:
        for path in reversed(replaced):
            try:
                atomic_replace_bytes(path, original_values[path])
            except Exception:
                pass
        raise
    return [str(path) for path in unique_paths]


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


def _issue(severity: str, code: str, message: str, path: Path | None = None) -> dict[str, str]:
    result = {"severity": severity, "code": code, "message": message}
    if path is not None:
        result["path"] = str(path)
    return result


def _nearest_existing_parent(path: Path) -> Path | None:
    candidate = path
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate if candidate.is_dir() else None


def _can_initialize(paths: SyncPaths) -> bool:
    if paths.protocol_root.exists():
        return paths.protocol_root.is_dir() and not any(paths.protocol_root.iterdir())
    return _nearest_existing_parent(paths.network_root) is not None


def _probe_lock(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"path": str(path), "exists": False, "available": False, "state": "missing"}
    try:
        with FileRangeLock(path, exclusive=True, timeout_seconds=0.05):
            return {"path": str(path), "exists": True, "available": True, "state": "available"}
    except LockTimeout:
        return {"path": str(path), "exists": True, "available": False, "state": "in_use"}
    except Exception as error:
        return {
            "path": str(path),
            "exists": True,
            "available": False,
            "state": "error",
            "message": str(error),
        }


def _lock_status(paths: SyncPaths) -> dict[str, Any]:
    save_mutex_count = len(list(paths.save_mutex_root.glob("stripe-*.lck"))) if paths.save_mutex_root.is_dir() else 0
    return {
        "epoch_transition": _probe_lock(paths.epoch_lock),
        "actor_publication": {
            "path": str(paths.actor_lock),
            "exists": paths.actor_lock.is_file(),
            "state": "ready" if paths.actor_lock.is_file() else "missing",
        },
        "save_mutex_count": save_mutex_count,
        "expected_save_mutex_count": 256,
    }


def _safe_protocol_child(protocol_root: Path, relative_path: str) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute():
        raise ValueError("An active-writer path cannot be absolute.")
    root = protocol_root.resolve()
    result = (root / relative).resolve()
    result.relative_to(root)
    return result


def _active_writers(
    paths: SyncPaths,
    snapshot_epoch_id: str,
    members: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    registry = paths.epoch_registry(snapshot_epoch_id)
    if not registry.is_dir():
        return [], [_issue("error", "epoch_registry_missing", "The active snapshot epoch registry is missing.", registry)]
    writers: list[dict[str, Any]] = []
    issues: list[dict[str, str]] = []
    seen: set[str] = set()
    for registration_path in sorted(registry.glob("actor-*.active.json")):
        try:
            value = read_json(registration_path)
            actor_id = str(value["actor_id"])
            user_id = str(value["user_id"])
            employee_number = str(value["employee_number"])
            epoch_id = str(value["snapshot_epoch_id"])
            actor_relative = str(value["actor_root_relative_path"])
            if actor_id in seen:
                raise ValueError("Duplicate actor registration.")
            seen.add(actor_id)
            if epoch_id != snapshot_epoch_id:
                raise ValueError("Registration belongs to another snapshot epoch.")
            member = members.get(user_id)
            if not member or str(member.get("employee_number", "")) != employee_number:
                raise ValueError("Registration is not valid in the current membership release.")
            expected_relative = f"users/emp-{employee_number}/actors/actor-{actor_id}"
            if actor_relative.replace("\\", "/") != expected_relative:
                raise ValueError("Registration contains a non-canonical actor path.")
            actor_root = _safe_protocol_child(paths.protocol_root, actor_relative)
            head_path = actor_root / "head.json"
            state = "registered"
            generation = 0
            highest_sequence = 0
            if head_path.is_file():
                head = read_json(head_path)
                if str(head.get("actor_id", "")) != actor_id:
                    raise ValueError("The actor head does not match its registration.")
                generation = int(head.get("generation", 0))
                highest_sequence = int(head.get("highest_published_seq", 0))
                state = "healthy"
            else:
                issues.append(_issue("error", "actor_head_missing", f"Active writer {actor_id} has no committed head.", head_path))
                state = "missing_head"
            writers.append(
                {
                    "actor_id": actor_id,
                    "user_id": user_id,
                    "employee_number": employee_number,
                    "generation": generation,
                    "highest_published_seq": highest_sequence,
                    "state": state,
                    "registration_path": str(registration_path),
                }
            )
        except Exception as error:
            issues.append(_issue("error", "active_writer_invalid", f"{registration_path.name}: {error}", registration_path))
    return writers, issues


def _status(network_root: Path, system_database: Path) -> dict[str, Any]:
    network_root = network_root.expanduser()
    paths = SyncPaths(network_root)
    issues: list[dict[str, str]] = []
    result: dict[str, Any] = {
        "network_root": str(network_root),
        "protocol_root": str(paths.protocol_root),
        "system_database": str(system_database),
        "shared_available": network_root.is_dir(),
        "initialized": False,
        "can_initialize": _can_initialize(paths),
        "membership_count": 0,
        "membership_release_id": "",
        "membership_generation": 0,
        "snapshot_id": "",
        "snapshot_epoch_id": "",
        "snapshot_path": "",
        "snapshot_size_bytes": 0,
        "active_writer_count": 0,
        "active_writers": [],
        "locks": _lock_status(paths),
        "issues": issues,
        "validation_performed": False,
    }
    if not network_root.is_dir():
        issues.append(_issue("warning", "shared_root_unavailable", "The selected shared repository path does not exist yet.", network_root))
        result["message"] = "The selected path is unavailable. It can be initialized when its parent location is accessible."
        return result

    membership_exists = paths.membership_current.is_file()
    snapshot_exists = paths.snapshots_current.is_file()
    if not membership_exists and not snapshot_exists:
        if paths.protocol_root.exists() and any(paths.protocol_root.iterdir()):
            issues.append(_issue("error", "partial_repository", "The protocol folder contains files but has no current membership or snapshot pointers.", paths.protocol_root))
        result["message"] = "The shared location is available but has not been initialized."
        return result
    if not membership_exists or not snapshot_exists:
        missing = paths.membership_current if not membership_exists else paths.snapshots_current
        issues.append(_issue("error", "current_pointer_missing", "The repository is partially initialized and a required current pointer is missing.", missing))
        result["can_initialize"] = False
        result["message"] = "The repository requires repair before it can be used."
        return result

    try:
        membership = load_membership(paths.protocol_root)
        pointer = load_snapshot_pointer(paths.protocol_root)
        snapshot_path = snapshot_file(paths.protocol_root, pointer)
        active_writers, writer_issues = _active_writers(paths, pointer.snapshot_epoch_id, dict(membership.members))
        issues.extend(writer_issues)
        result.update(
            {
                "initialized": True,
                "can_initialize": False,
                "membership_count": len(membership.members),
                "membership_release_id": membership.release_id,
                "membership_generation": membership.generation,
                "snapshot_id": pointer.snapshot_id,
                "snapshot_epoch_id": pointer.snapshot_epoch_id,
                "snapshot_path": str(snapshot_path),
                "snapshot_size_bytes": pointer.size_bytes,
                "active_writer_count": len(active_writers),
                "active_writers": active_writers,
                "message": "Repository pointers and current membership were loaded.",
            }
        )
    except Exception as error:
        issues.append(_issue("error", "repository_metadata_invalid", str(error), paths.protocol_root))
        result["message"] = "The repository metadata could not be loaded."
    return result


def _validate(network_root: Path, system_database: Path) -> dict[str, Any]:
    result = _status(network_root, system_database)
    issues = list(result["issues"])
    result["validation_performed"] = True
    if not result["initialized"]:
        return {**result, "valid": False, "message": "The selected repository is not initialized or requires repair."}
    paths = SyncPaths(network_root)
    required_directories = (
        paths.protocol_root / "membership" / "releases",
        paths.protocol_root / "users",
        paths.protocol_root / "snapshots",
        paths.protocol_root / "activity" / "epochs",
        paths.save_mutex_root,
        paths.protocol_root / "audit" / "reports",
        paths.protocol_root / "maintenance" / "reports",
        paths.protocol_root / "quarantine",
        paths.protocol_root / "archive",
    )
    for path in required_directories:
        if not path.is_dir():
            issues.append(_issue("error", "required_directory_missing", "A required repository directory is missing.", path))
    if not paths.epoch_lock.is_file():
        issues.append(_issue("error", "epoch_lock_missing", "The epoch-transition lock file is missing.", paths.epoch_lock))
    if not paths.actor_lock.is_file():
        issues.append(_issue("error", "actor_lock_missing", "The actor-publication lock file is missing.", paths.actor_lock))
    mutex_count = len(list(paths.save_mutex_root.glob("stripe-*.lck"))) if paths.save_mutex_root.is_dir() else 0
    if mutex_count != 256:
        issues.append(_issue("error", "save_mutex_count_invalid", f"Expected 256 save mutex files but found {mutex_count}.", paths.save_mutex_root))
    try:
        membership = load_membership(paths.protocol_root)
        pointer = load_snapshot_pointer(paths.protocol_root)
        validate_snapshot(snapshot_file(paths.protocol_root, pointer), pointer)
    except Exception as error:
        issues.append(_issue("error", "artifact_validation_failed", str(error), paths.protocol_root))
    valid = not any(issue["severity"] == "error" for issue in issues)
    return {
        **result,
        "issues": issues,
        "valid": valid,
        "message": (
            f"Validated membership release {membership.release_id}, repository layout, active writers, locks, and the active snapshot."
            if valid
            else "Repository validation found issues that require attention."
        ),
    }


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portal workstation repository task runner")
    parser.add_argument(
        "--task",
        choices=("repository.status", "repository.inspect", "repository.validate", "repository.configure", "repository.bootstrap"),
        required=True,
    )
    parser.add_argument("--portal-settings", type=Path, required=True)
    parser.add_argument("--release-portal-settings", type=Path)
    parser.add_argument("--network-root", default="")
    parser.add_argument("--confirmation", default="")
    return parser.parse_args()


def _require_path_confirmation(network_root: Path, confirmation: str) -> None:
    expected = os.path.normcase(os.path.normpath(str(network_root)))
    supplied = os.path.normcase(os.path.normpath(confirmation.strip())) if confirmation.strip() else ""
    if supplied != expected:
        raise ValueError("Type the complete selected repository path to confirm this operation.")


def _settings_paths(args: argparse.Namespace) -> list[Path]:
    result = [args.portal_settings]
    if args.release_portal_settings and args.release_portal_settings.is_file():
        result.append(args.release_portal_settings)
    return result


def main() -> int:
    args = _parse_arguments()
    try:
        configured_network_root = args.network_root.strip()
        network_root, system_database = _configured_paths(
            args.portal_settings,
            configured_network_root or None,
        )
        if args.task in {"repository.status", "repository.inspect"}:
            result = _status(network_root, system_database)
        elif args.task == "repository.validate":
            result = _validate(network_root, system_database)
        elif args.task == "repository.configure":
            _require_path_confirmation(network_root, args.confirmation)
            validation = _validate(network_root, system_database)
            if not validation.get("valid"):
                raise ValueError("Only a fully validated initialized repository can be selected.")
            configured_files = _save_network_root(_settings_paths(args), network_root)
            result = {
                **validation,
                "configured_files": configured_files,
                "message": f"The validated repository path was saved to {len(configured_files)} Portal settings file(s).",
            }
        else:
            _require_path_confirmation(network_root, args.confirmation)
            preflight = _status(network_root, system_database)
            if preflight["initialized"]:
                raise ValueError("The selected repository is already initialized. Use Configure to select it.")
            if not preflight["can_initialize"]:
                raise ValueError("The selected path is not empty or its parent location is unavailable; it cannot be initialized safely.")
            members = _members(system_database)
            bootstrap_result = bootstrap_shared_store(network_root, members)
            configured_files = _save_network_root(_settings_paths(args), network_root)
            result = {
                **_validate(network_root, system_database),
                **bootstrap_result,
                "configured_files": configured_files,
                "initialized": True,
                "message": f"The shared repository was initialized, validated, and saved to {len(configured_files)} Portal settings file(s).",
            }
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as error:  # Safe task boundary; diagnostic tracebacks stay out of the UI.
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
