"""Safe workstation maintenance tasks for the shared business repository.

This runner is intentionally small and auditable.  It never opens a Portal
Desktop replica and never accepts arbitrary SQL.  Every mutating task operates
only on the configured shared repository and writes a compact seven-day task
history for the Workstation Manager UI.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import uuid
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable


_RUNNER_DIRECTORY = Path(__file__).resolve().parent
_PACKAGED_PYTHON = _RUNNER_DIRECTORY / "python"
_DEVELOPMENT_PYTHON = _RUNNER_DIRECTORY.parent.parent / "python"
for _candidate in (_PACKAGED_PYTHON, _DEVELOPMENT_PYTHON):
    if (_candidate / "portal" / "app" / "sync").is_dir():
        sys.path.insert(0, str(_candidate))
        break

from portal.app.schema.shared_publisher import SharedSchemaPublisher
from portal.app.sync.models import ActorHead, PackageReference, SyncPaths, utc_now
from portal.app.sync.operation_package import read_package
from portal.app.sync.snapshot import (
    SnapshotPointer,
    install_snapshot,
    load_snapshot_pointer,
    snapshot_file,
    validate_snapshot,
)
from portal.app.sync.storage import (
    FileRangeLock,
    atomic_replace_bytes,
    publish_immutable_file,
    publish_immutable_json,
    read_json,
    require_shared_root,
    sha256_file,
    sqlite_readonly_uri,
)


LOG_RETENTION_DAYS = 7
SNAPSHOT_RETENTION_COUNT = 5
OPERATION_ONLINE_RETENTION_DAYS = 7
BACKUP_RETENTION_DAYS = 90
RETENTION_TASK_NAME = "StormWater Portal Business Retention"
NIGHTLY_TASK_NAME = "StormWater Portal Nightly Business Maintenance"
WEEKDAY_SCHTASK_CODES = {
    "monday": "MON",
    "tuesday": "TUE",
    "wednesday": "WED",
    "thursday": "THU",
    "friday": "FRI",
    "saturday": "SAT",
    "sunday": "SUN",
}


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


def _configured_paths(settings_path: Path) -> tuple[Path, Path, Path]:
    settings = _read_json(settings_path)
    data_root = str(settings.get("shared", {}).get("dataRoot", "")).strip()
    business_sync = settings.get("businessSync", {})
    network_root = str(business_sync.get("networkRoot", "")).strip()
    backup_root = str(business_sync.get("backupRoot", "")).strip()
    system_database = str(settings.get("system", {}).get("database", "")).strip()
    if not data_root or not network_root or not backup_root or not system_database:
        raise ValueError(
            "Portal settings must define shared.dataRoot, system.database, and businessSync networkRoot/backupRoot."
        )
    return (
        _expand(network_root, settings_path=settings_path, data_root=data_root),
        _expand(system_database, settings_path=settings_path, data_root=data_root),
        _expand(backup_root, settings_path=settings_path, data_root=data_root),
    )


def _retention_options(settings_path: Path) -> dict[str, Any]:
    """Read the workstation-controlled business retention policy.

    Values below the documented seven-day / five-snapshot floor are rejected
    rather than silently weakening the recovery guarantees.
    """

    settings = _read_json(settings_path)
    maintenance = settings.get("maintenance", {})
    if not isinstance(maintenance, dict):
        raise ValueError("Portal settings maintenance section must be an object.")
    value = maintenance.get("businessRetention", {})
    if not isinstance(value, dict):
        raise ValueError("Portal settings maintenance.businessRetention must be an object.")
    schedule = value.get("schedule", {})
    if not isinstance(schedule, dict):
        raise ValueError("Business retention schedule must be an object.")
    online_days = int(value.get("operationOnlineDays", OPERATION_ONLINE_RETENTION_DAYS))
    snapshot_count = int(value.get("verifiedSnapshotCount", SNAPSHOT_RETENTION_COUNT))
    backup_days = int(value.get("backupRetentionDays", BACKUP_RETENTION_DAYS))
    if online_days < OPERATION_ONLINE_RETENTION_DAYS:
        raise ValueError("Business operation retention cannot be less than seven days.")
    if snapshot_count < SNAPSHOT_RETENTION_COUNT:
        raise ValueError("Business snapshot retention cannot be less than five verified snapshots.")
    if backup_days != BACKUP_RETENTION_DAYS:
        raise ValueError("Business backup retention is fixed at ninety days.")
    day_of_week = str(schedule.get("dayOfWeek", "Friday")).strip() or "Friday"
    run_time = str(schedule.get("time", "21:00")).strip() or "21:00"
    weekday_key = day_of_week.lower()
    if weekday_key not in WEEKDAY_SCHTASK_CODES:
        raise ValueError("Business retention schedule must use a valid weekday.")
    try:
        datetime.strptime(run_time, "%H:%M")
    except ValueError as error:
        raise ValueError("Business retention schedule time must use HH:MM local time.") from error
    return {
        # Retention is opt-in for a new deployment. The deployed settings file
        # must explicitly enable it before a scheduled task can archive data.
        "enabled": bool(value.get("enabled", False)),
        "automatic_enabled": bool(value.get("automaticEnabled", False)),
        "online_days": online_days,
        "snapshot_count": snapshot_count,
        "backup_days": backup_days,
        "day_of_week": weekday_key.title(),
        "weekday_code": WEEKDAY_SCHTASK_CODES[weekday_key],
        "time": run_time,
    }


def _nightly_options(settings_path: Path) -> dict[str, Any]:
    """Read the daily shared-snapshot and backup policy."""

    settings = _read_json(settings_path)
    maintenance = settings.get("maintenance", {})
    if not isinstance(maintenance, dict):
        raise ValueError("Portal settings maintenance section must be an object.")
    value = maintenance.get("nightlyBusinessMaintenance", {})
    if not isinstance(value, dict):
        raise ValueError("Portal settings maintenance.nightlyBusinessMaintenance must be an object.")
    schedule = value.get("schedule", {})
    if not isinstance(schedule, dict):
        raise ValueError("Nightly business maintenance schedule must be an object.")
    run_time = str(schedule.get("time", "02:00")).strip() or "02:00"
    try:
        datetime.strptime(run_time, "%H:%M")
    except ValueError as error:
        raise ValueError("Nightly business maintenance time must use HH:MM local time.") from error
    return {
        "enabled": bool(value.get("enabled", True)),
        "automatic_enabled": bool(value.get("automaticEnabled", True)),
        "time": run_time,
    }


def _task_scheduler_state(result: subprocess.CompletedProcess[str]) -> str:
    """Normalize a Task Scheduler query into the UI's three task states."""

    if result.returncode != 0:
        return "Not registered"
    output = f"{result.stdout}\n{result.stderr}".casefold()
    return "Running" if "running" in output else "Ready"


def _scheduled_batch_command(batch_name: str) -> str:
    """Return a short Task Scheduler command for a packaged coordinator batch.

    Task Scheduler limits its /TR action to 261 characters.  Do not embed the
    Python executable, runner, and Portal settings paths in that field: those
    paths can readily exceed the limit in a portable deployment.  The batch
    launcher resolves those values at run time from the manager configuration.
    """

    launcher = Path(__file__).resolve().parent / batch_name
    if not launcher.is_file():
        raise RuntimeError(f"Scheduled task launcher was not found: {launcher}")
    command = f'cmd.exe /d /c ""{launcher}""'
    if len(command) > 261:
        raise RuntimeError(
            "The scheduled-task launcher path is too long for Windows Task Scheduler. "
            "Move the Portal Workstation Manager to a shorter local path."
        )
    return command


def _retention_schedule_status(settings_path: Path, options: dict[str, Any]) -> dict[str, Any]:
    """Return the state of the per-user Windows retention task.

    Task Scheduler is only a timer.  The coordinator still checks the policy
    and current weekday before it performs any archive action.
    """

    if os.name != "nt":
        return {
            "task_name": RETENTION_TASK_NAME,
            "registered": False,
            "state": "Not registered",
            "automatic_enabled": options["automatic_enabled"],
            "schedule": f"{options['day_of_week']} {options['time']} local time",
            "message": "Automatic retention is available only on Windows workstations.",
        }
    result = subprocess.run(
        ["schtasks.exe", "/Query", "/TN", RETENTION_TASK_NAME, "/FO", "LIST"],
        capture_output=True,
        text=True,
        check=False,
    )
    state = _task_scheduler_state(result)
    return {
        "task_name": RETENTION_TASK_NAME,
        "registered": state != "Not registered",
        "state": state,
        "automatic_enabled": options["automatic_enabled"],
        "schedule": f"{options['day_of_week']} {options['time']} local time",
        "message": (
            "The Windows task is registered for the current user."
            if state != "Not registered"
            else "The Windows task has not been registered for the current user."
        ),
    }


def _set_retention_schedule(
    settings_path: Path, options: dict[str, Any], *, enabled: bool
) -> dict[str, Any]:
    """Register or remove the current user's weekly retention task safely."""

    if os.name != "nt":
        raise RuntimeError("Automatic business retention can be scheduled only on Windows.")
    if enabled:
        if not options["enabled"]:
            raise ValueError("Business retention is disabled in portal settings.")
        if not options["automatic_enabled"]:
            raise ValueError("Set maintenance.businessRetention.automaticEnabled to true before enabling the task.")
        command = _scheduled_batch_command("run-business-retention.bat")
        result = subprocess.run(
            [
                "schtasks.exe",
                "/Create",
                "/TN",
                RETENTION_TASK_NAME,
                "/SC",
                "WEEKLY",
                "/D",
                str(options["weekday_code"]),
                "/ST",
                str(options["time"]),
                "/TR",
                command,
                "/F",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            message = (result.stderr or result.stdout).strip() or "Task Scheduler did not accept the retention task."
            raise RuntimeError(message)
    else:
        result = subprocess.run(
            ["schtasks.exe", "/Delete", "/TN", RETENTION_TASK_NAME, "/F"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 and "cannot find" not in (result.stderr or result.stdout).lower():
            message = (result.stderr or result.stdout).strip() or "Task Scheduler could not remove the retention task."
            raise RuntimeError(message)
    return _retention_schedule_status(settings_path, options)


def _nightly_schedule_status(settings_path: Path, options: dict[str, Any]) -> dict[str, Any]:
    """Return the state of the per-user Windows nightly maintenance task."""

    if os.name != "nt":
        return {
            "task_name": NIGHTLY_TASK_NAME,
            "registered": False,
            "state": "Not registered",
            "automatic_enabled": options["automatic_enabled"],
            "schedule": f"Daily {options['time']} local time",
            "message": "Nightly scheduling is available only on Windows workstations.",
        }
    result = subprocess.run(
        ["schtasks.exe", "/Query", "/TN", NIGHTLY_TASK_NAME, "/FO", "LIST"],
        capture_output=True,
        text=True,
        check=False,
    )
    state = _task_scheduler_state(result)
    return {
        "task_name": NIGHTLY_TASK_NAME,
        "registered": state != "Not registered",
        "state": state,
        "automatic_enabled": options["automatic_enabled"],
        "schedule": f"Daily {options['time']} local time",
        "message": (
            "The Windows task is registered for the current user."
            if state != "Not registered"
            else "The Windows task has not been registered for the current user."
        ),
    }


def _set_nightly_schedule(
    settings_path: Path, options: dict[str, Any], *, enabled: bool
) -> dict[str, Any]:
    """Register or remove the daily checkpoint and backup task."""

    if os.name != "nt":
        raise RuntimeError("Nightly business maintenance can be scheduled only on Windows.")
    if enabled:
        if not options["enabled"]:
            raise ValueError("Nightly business maintenance is disabled in portal settings.")
        if not options["automatic_enabled"]:
            raise ValueError(
                "Set maintenance.nightlyBusinessMaintenance.automaticEnabled to true before enabling the task."
            )
        command = _scheduled_batch_command("run-nightly-business-maintenance.bat")
        result = subprocess.run(
            [
                "schtasks.exe",
                "/Create",
                "/TN",
                NIGHTLY_TASK_NAME,
                "/SC",
                "DAILY",
                "/ST",
                str(options["time"]),
                "/TR",
                command,
                "/F",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            message = (result.stderr or result.stdout).strip() or "Task Scheduler did not accept the nightly maintenance task."
            raise RuntimeError(message)
    else:
        result = subprocess.run(
            ["schtasks.exe", "/Delete", "/TN", NIGHTLY_TASK_NAME, "/F"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 and "cannot find" not in (result.stderr or result.stdout).lower():
            message = (result.stderr or result.stdout).strip() or "Task Scheduler could not remove the nightly maintenance task."
            raise RuntimeError(message)
    return _nightly_schedule_status(settings_path, options)


def _event_path(paths: SyncPaths) -> Path:
    return paths.protocol_root / "maintenance" / "reports" / "workstation-manager-events.jsonl"


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _append_event(paths: SyncPaths, task: str, status: str, details: str) -> None:
    path = _event_path(paths)
    lock = path.with_suffix(".lck")
    cutoff = datetime.now(UTC) - timedelta(days=LOG_RETENTION_DAYS)
    event = {"recorded_at": utc_now(), "task": task, "status": status, "details": details}
    with FileRangeLock(lock, exclusive=True, timeout_seconds=15.0):
        previous: list[str] = []
        if path.is_file():
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                timestamp = _parse_timestamp(item.get("recorded_at")) if isinstance(item, dict) else None
                if timestamp and timestamp >= cutoff:
                    previous.append(json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        previous.append(json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        atomic_replace_bytes(path, ("\n".join(previous) + "\n").encode("utf-8"))


def _pointer_for_snapshot(path: Path) -> SnapshotPointer:
    with closing(sqlite3.connect(sqlite_readonly_uri(path, immutable=True), uri=True)) as connection:
        connection.execute("PRAGMA trusted_schema=OFF")
        metadata = connection.execute(
            "SELECT snapshot_id, snapshot_epoch_id, coordinator_version, python_runtime_version, replication_profile FROM sw_snapshot_metadata WHERE singleton=1"
        ).fetchone()
        if metadata is None:
            raise ValueError(f"Snapshot metadata is missing from {path}.")
        coverage_rows = connection.execute(
            "SELECT actor_id, highest_continuous_seq, log_floor FROM sw_snapshot_actor_coverage"
        ).fetchall()
    return SnapshotPointer(
        snapshot_id=str(metadata[0]),
        snapshot_epoch_id=str(metadata[1]),
        relative_path=path.name,
        sha256=sha256_file(path),
        size_bytes=path.stat().st_size,
        replication_profile=str(metadata[4]),
        coverage={str(row[0]): int(row[1]) for row in coverage_rows},
        log_floor={str(row[0]): int(row[2]) for row in coverage_rows},
        coordinator_version=str(metadata[2]),
        python_runtime_version=str(metadata[3]),
    )


def _snapshot_status(
    paths: SyncPaths, *, retention_count: int = SNAPSHOT_RETENTION_COUNT
) -> dict[str, Any]:
    require_shared_root(paths.network_root)
    pointer = load_snapshot_pointer(paths.protocol_root)
    active = snapshot_file(paths.protocol_root, pointer)
    validate_snapshot(active, pointer)
    snapshots = sorted(
        (item for item in (paths.protocol_root / "snapshots").glob("snapshot-*.db") if item.is_file()),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    return {
        "active_snapshot_id": pointer.snapshot_id,
        "active_snapshot_epoch_id": pointer.snapshot_epoch_id,
        "active_snapshot_path": str(active),
        "active_snapshot_size": pointer.size_bytes,
        "snapshot_count": len(snapshots),
        "retention_target": retention_count,
        "retention_candidates": max(0, len(snapshots) - retention_count),
        "snapshots": [
            {
                "name": item.name,
                "snapshot_id": _pointer_for_snapshot(item).snapshot_id,
                "path": str(item),
                "size_bytes": item.stat().st_size,
                "created_at": datetime.fromtimestamp(item.stat().st_mtime, tz=UTC).isoformat(),
                "is_active": item.resolve() == active.resolve(),
            }
            for item in snapshots
        ],
    }


def _snapshot_inventory(paths: SyncPaths) -> tuple[SnapshotPointer, list[dict[str, Any]]]:
    """Return every verified online snapshot, newest first.

    A malformed historical snapshot is reported to the retention plan instead
    of being silently deleted.  Only verified snapshots count toward the five
    snapshot recovery floor.
    """

    require_shared_root(paths.network_root)
    active_pointer = load_snapshot_pointer(paths.protocol_root)
    active_path = snapshot_file(paths.protocol_root, active_pointer)
    validate_snapshot(active_path, active_pointer)
    entries: list[dict[str, Any]] = []
    for path in (paths.protocol_root / "snapshots").glob("snapshot-*.db"):
        if not path.is_file():
            continue
        try:
            pointer = _pointer_for_snapshot(path)
            validate_snapshot(path, pointer)
        except Exception as error:
            entries.append(
                {
                    "path": path,
                    "name": path.name,
                    "valid": False,
                    "error": str(error),
                    "created_at": datetime.fromtimestamp(path.stat().st_mtime, tz=UTC),
                }
            )
            continue
        created_at = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
        try:
            with closing(sqlite3.connect(sqlite_readonly_uri(path, immutable=True), uri=True)) as connection:
                row = connection.execute(
                    "SELECT created_at_utc FROM sw_snapshot_metadata WHERE singleton=1"
                ).fetchone()
                parsed = _parse_timestamp(row[0] if row else None)
                if parsed is not None:
                    created_at = parsed
        except sqlite3.DatabaseError:
            pass
        entries.append(
            {
                "path": path,
                "name": path.name,
                "pointer": pointer,
                "valid": True,
                "created_at": created_at,
                "is_active": path.resolve() == active_path.resolve(),
            }
        )
    entries.sort(key=lambda item: item["created_at"], reverse=True)
    return active_pointer, entries


def _retention_selection(
    paths: SyncPaths, snapshot_count: int
) -> tuple[SnapshotPointer, list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    active_pointer, inventory = _snapshot_inventory(paths)
    errors = [f"{item['name']}: {item['error']}" for item in inventory if not item["valid"]]
    verified = [item for item in inventory if item["valid"]]
    active = next((item for item in verified if item.get("is_active")), None)
    if active is None:
        raise RuntimeError("The current snapshot is not present in the verified snapshot inventory.")
    retained = [active]
    for item in verified:
        if item["path"].resolve() == active["path"].resolve():
            continue
        if len(retained) >= snapshot_count:
            break
        retained.append(item)
    retained.sort(key=lambda item: item["created_at"], reverse=True)
    retained_paths = {item["path"].resolve() for item in retained}
    archive_candidates = [
        item for item in verified if item["path"].resolve() not in retained_paths
    ]
    return active_pointer, retained, archive_candidates, errors


def _backup_date_stamp() -> str:
    """Return the workstation-local date used to identify one weekly backup set."""

    return datetime.now().astimezone().strftime("%Y%m%d")


def _backup_path(
    backup_root: Path, pointer: SnapshotPointer, *, backup_date: str | None = None
) -> Path:
    date_stamp = backup_date or _backup_date_stamp()
    return backup_root / f"backup-{date_stamp}-{pointer.snapshot_id}-{pointer.sha256}.db"


def _matching_snapshot_backup_paths(
    backup_root: Path, pointer: SnapshotPointer
) -> list[Path]:
    return sorted(
        backup_root.glob(f"backup-*-{pointer.snapshot_id}-{pointer.sha256}.db"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )


def _verified_backup_exists(backup_root: Path, pointer: SnapshotPointer) -> bool:
    for candidate in _matching_snapshot_backup_paths(backup_root, pointer):
        try:
            observed = _pointer_for_snapshot(candidate)
            validate_snapshot(candidate, observed)
        except Exception:
            continue
        if _backup_matches_pointer(observed, pointer):
            return True
    return False


def _backup_matches_pointer(observed: SnapshotPointer, pointer: SnapshotPointer) -> bool:
    """Return whether a verified backup is an exact copy of the active snapshot.

    Recovery intentionally does not accept an older backup.  Replacing a
    corrupt active file with an exact copy preserves the pointer, epoch, and
    all operation coverage without silently rolling shared business data back.
    """

    return (
        observed.snapshot_id == pointer.snapshot_id
        and observed.snapshot_epoch_id == pointer.snapshot_epoch_id
        and observed.sha256 == pointer.sha256
        and observed.size_bytes == pointer.size_bytes
        and observed.replication_profile == pointer.replication_profile
        and dict(observed.coverage) == dict(pointer.coverage)
        and dict(observed.log_floor) == dict(pointer.log_floor)
        and observed.coordinator_version == pointer.coordinator_version
    )


def _find_verified_recovery_backup(
    backup_root: Path, pointer: SnapshotPointer
) -> Path | None:
    for candidate in _matching_snapshot_backup_paths(backup_root, pointer):
        try:
            observed = _pointer_for_snapshot(candidate)
            validate_snapshot(candidate, observed)
        except Exception:
            continue
        if _backup_matches_pointer(observed, pointer):
            return candidate
    return None


def _ensure_snapshot_backup(
    backup_root: Path, entry: dict[str, Any]
) -> dict[str, Any]:
    pointer = entry["pointer"]
    source = entry["path"]
    destination = _backup_path(backup_root, pointer)
    copied_hash, copied_size = publish_immutable_file(source, destination)
    observed = _pointer_for_snapshot(destination)
    validate_snapshot(destination, observed)
    if copied_hash != pointer.sha256 or copied_size != pointer.size_bytes:
        raise RuntimeError(f"Snapshot backup verification failed for {pointer.snapshot_id}.")
    return {
        "snapshot_id": pointer.snapshot_id,
        "path": str(destination),
        "sha256": copied_hash,
        "size_bytes": copied_size,
    }


def _retention_observation_path(paths: SyncPaths) -> Path:
    return paths.protocol_root / "maintenance" / "retention-observations.json"


def _observe_packages(
    paths: SyncPaths, packages: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Persist first workstation observation time for reachable online packages."""

    path = _retention_observation_path(paths)
    lock = path.with_suffix(".lck")
    now = utc_now()
    with FileRangeLock(lock, exclusive=True, timeout_seconds=30.0):
        raw: dict[str, Any] = {}
        if path.is_file():
            try:
                raw = _read_json(path)
            except Exception:
                raw = {}
        existing = raw.get("packages", {}) if isinstance(raw.get("packages", {}), dict) else {}
        observed: dict[str, dict[str, Any]] = {}
        for package in packages:
            key = str(package["observation_key"])
            prior = existing.get(key)
            if not isinstance(prior, dict) or prior.get("sha256") != package["sha256"]:
                prior = {
                    "actor_id": package["actor_id"],
                    "package_id": package["package_id"],
                    "sha256": package["sha256"],
                    "first_observed_at": now,
                }
            prior = dict(prior)
            prior["last_observed_at"] = now
            prior["first_seq"] = package["first_seq"]
            prior["last_seq"] = package["last_seq"]
            existing[key] = prior
            observed[key] = prior
        payload = {"version": 1, "updated_at": now, "packages": existing}
        atomic_replace_bytes(path, (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
    return observed


def _remove_retention_observations(paths: SyncPaths, keys: set[str]) -> None:
    if not keys:
        return
    path = _retention_observation_path(paths)
    lock = path.with_suffix(".lck")
    with FileRangeLock(lock, exclusive=True, timeout_seconds=30.0):
        if not path.is_file():
            return
        raw = _read_json(path)
        packages = raw.get("packages", {})
        if not isinstance(packages, dict):
            return
        for key in keys:
            packages.pop(key, None)
        raw["packages"] = packages
        raw["updated_at"] = utc_now()
        atomic_replace_bytes(path, (json.dumps(raw, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))


def _safe_actor_package_path(actor_root: Path, relative_path: str) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute():
        raise RuntimeError("An actor package path must be relative.")
    root = actor_root.resolve()
    result = (root / relative).resolve()
    try:
        result.relative_to(root)
    except ValueError as error:
        raise RuntimeError("An actor package path escapes its actor directory.") from error
    return result


def _reachable_online_packages(paths: SyncPaths, pointer: SnapshotPointer) -> list[dict[str, Any]]:
    """Read only committed package chains above the current log floor."""

    users_root = paths.protocol_root / "users"
    packages: list[dict[str, Any]] = []
    if not users_root.is_dir():
        return packages
    for head_path in sorted(users_root.glob("emp-*/actors/actor-*/head.json")):
        actor_root = head_path.parent
        head = ActorHead.from_dict(read_json(head_path))
        floor = int(pointer.log_floor.get(head.actor_id, 0))
        expected_last = head.highest_published_seq
        reference = head.package
        seen: set[str] = set()
        while reference and reference.last_seq > floor:
            if reference.package_id in seen:
                raise RuntimeError(f"Actor {head.actor_id} has a cyclic package chain.")
            seen.add(reference.package_id)
            if reference.last_seq != expected_last:
                raise RuntimeError(f"Actor {head.actor_id} package chain has a sequence gap.")
            package_path = _safe_actor_package_path(actor_root, reference.relative_path)
            if not package_path.is_file():
                raise RuntimeError(
                    f"Committed package {reference.package_id} is missing above the active log floor."
                )
            manifest, operations = read_package(
                package_path,
                expected_hash=reference.sha256,
                expected_size=reference.size_bytes,
            )
            if manifest.actor_id != head.actor_id or manifest.package_id != reference.package_id:
                raise RuntimeError(f"Actor {head.actor_id} package metadata does not match its head.")
            packages.append(
                {
                    "actor_id": head.actor_id,
                    "employee_number": head.employee_number,
                    "package_id": manifest.package_id,
                    "source_path": package_path,
                    "relative_path": reference.relative_path,
                    "sha256": reference.sha256,
                    "size_bytes": reference.size_bytes,
                    "first_seq": reference.first_seq,
                    "last_seq": reference.last_seq,
                    "operation_ids": [operation.operation_id for operation in operations],
                    "observation_key": f"{head.actor_id}:{manifest.package_id}",
                }
            )
            expected_last = reference.first_seq - 1
            if reference.first_seq <= floor + 1:
                break
            required = (
                manifest.previous_package_id,
                manifest.previous_package_sha256,
                manifest.previous_package_path,
                manifest.previous_first_seq,
                manifest.previous_last_seq,
                manifest.previous_size_bytes,
            )
            if any(value is None for value in required):
                raise RuntimeError(
                    f"Actor {head.actor_id} package chain ends before the active log floor."
                )
            reference = PackageReference(
                package_id=str(manifest.previous_package_id),
                relative_path=str(manifest.previous_package_path),
                sha256=str(manifest.previous_package_sha256),
                size_bytes=int(manifest.previous_size_bytes),
                first_seq=int(manifest.previous_first_seq),
                last_seq=int(manifest.previous_last_seq),
            )
    return packages


def _conflict_operation_ids(paths: SyncPaths, pointer: SnapshotPointer) -> set[str]:
    source = snapshot_file(paths.protocol_root, pointer)
    validate_snapshot(source, pointer)
    values: set[str] = set()
    with closing(sqlite3.connect(sqlite_readonly_uri(source, immutable=True), uri=True)) as connection:
        connection.execute("PRAGMA trusted_schema=OFF")
        rows = connection.execute(
            "SELECT candidate_operation_ids_json, selected_operation_id FROM sw_sync_conflict"
        ).fetchall()
    for candidate_json, selected_operation_id in rows:
        try:
            candidates = json.loads(str(candidate_json))
        except json.JSONDecodeError as error:
            raise RuntimeError("Conflict evidence is malformed; retention is blocked.") from error
        if not isinstance(candidates, list):
            raise RuntimeError("Conflict evidence is malformed; retention is blocked.")
        values.update(str(item) for item in candidates)
        if selected_operation_id:
            values.add(str(selected_operation_id))
    return values


def _snapshot_backup_missing(
    backup_root: Path, entries: list[dict[str, Any]]
) -> list[str]:
    return [
        str(entry["pointer"].snapshot_id)
        for entry in entries
        if not _verified_backup_exists(backup_root, entry["pointer"])
    ]


def _retention_plan(
    paths: SyncPaths, backup_root: Path, options: dict[str, Any]
) -> dict[str, Any]:
    active_pointer, retained_snapshots, archive_snapshots, snapshot_errors = _retention_selection(
        paths, int(options["snapshot_count"])
    )
    if len(retained_snapshots) < int(options["snapshot_count"]):
        snapshot_errors.append(
            f"Only {len(retained_snapshots)} verified online snapshots exist; {options['snapshot_count']} are required."
        )
    oldest = retained_snapshots[-1] if retained_snapshots else None
    packages = _reachable_online_packages(paths, active_pointer)
    observations = _observe_packages(paths, packages)
    protected_operations = _conflict_operation_ids(paths, active_pointer)
    cutoff = datetime.now(UTC) - timedelta(days=int(options["online_days"]))
    backup_missing = _snapshot_backup_missing(backup_root, retained_snapshots)
    by_actor: dict[str, list[dict[str, Any]]] = {}
    for package in packages:
        by_actor.setdefault(str(package["actor_id"]), []).append(package)

    eligible: list[dict[str, Any]] = []
    proposed_floor: dict[str, int] = {
        actor_id: int(sequence) for actor_id, sequence in active_pointer.log_floor.items()
    }
    blocked: list[str] = list(snapshot_errors)
    # A first archive run creates and verifies the retained-snapshot backups
    # before it publishes the new floor.  Missing backups are shown to the
    # operator, but are not a permanent eligibility blocker.
    if oldest is None:
        blocked.append("No verified retained snapshot is available.")
    else:
        oldest_pointer: SnapshotPointer = oldest["pointer"]
        for actor_id, actor_packages in by_actor.items():
            actor_packages.sort(key=lambda item: (int(item["first_seq"]), int(item["last_seq"])))
            current_floor = int(active_pointer.log_floor.get(actor_id, 0))
            actor_target = min(
                int(oldest_pointer.coverage.get(actor_id, current_floor)),
                int(active_pointer.coverage.get(actor_id, current_floor)),
            )
            expected_sequence = current_floor + 1
            for package in actor_packages:
                if int(package["first_seq"]) != expected_sequence:
                    blocked.append(
                        f"Actor {actor_id} has a non-continuous online package prefix at sequence {expected_sequence}."
                    )
                    break
                if int(package["last_seq"]) > actor_target:
                    break
                observation = observations.get(str(package["observation_key"]), {})
                first_observed = _parse_timestamp(observation.get("first_observed_at"))
                if first_observed is None or first_observed > cutoff:
                    break
                if any(item in protected_operations for item in package["operation_ids"]):
                    blocked.append(
                        f"Package {package['package_id']} is retained because a conflict references it."
                    )
                    break
                eligible.append(package)
                expected_sequence = int(package["last_seq"]) + 1
            proposed_floor[actor_id] = expected_sequence - 1

    return {
        "active_snapshot_id": active_pointer.snapshot_id,
        "active_snapshot_epoch_id": active_pointer.snapshot_epoch_id,
        "retention_target": int(options["snapshot_count"]),
        "operation_online_days": int(options["online_days"]),
        "automatic_enabled": bool(options["automatic_enabled"]),
        "automatic_schedule": f"{options['day_of_week']} {options['time']} local time",
        "retained_snapshots": [
            {"snapshot_id": item["pointer"].snapshot_id, "path": str(item["path"])}
            for item in retained_snapshots
        ],
        "snapshot_archive_candidates": [
            {"snapshot_id": item["pointer"].snapshot_id, "path": str(item["path"])}
            for item in archive_snapshots
        ],
        "snapshot_errors": snapshot_errors,
        "missing_snapshot_backups": backup_missing,
        "online_package_count": len(packages),
        "eligible_package_count": len(eligible),
        "eligible_packages": eligible,
        "proposed_log_floor": proposed_floor,
        "blocked_reasons": sorted(set(blocked)),
        "ready_to_archive": bool(eligible or archive_snapshots) and not snapshot_errors,
    }


def _archive_destination(paths: SyncPaths, package: dict[str, Any]) -> Path:
    return (
        paths.protocol_root
        / "archive"
        / "operations"
        / f"actor-{package['actor_id']}"
        / Path(str(package["relative_path"])).name
    )


def _operation_backup_destination(backup_root: Path, package: dict[str, Any]) -> Path:
    return (
        backup_root
        / "operations"
        / _backup_date_stamp()
        / f"actor-{package['actor_id']}"
        / Path(str(package["relative_path"])).name
    )


def _backup_artifacts(backup_root: Path) -> list[Path]:
    """Return immutable snapshot and operation backup files under the configured root."""

    if not backup_root.is_dir():
        return []
    return sorted(
        (
            item
            for item in backup_root.rglob("*")
            if item.is_file()
            and (
                (item.parent == backup_root and item.name.startswith("backup-") and item.suffix == ".db")
                or (item.suffix == ".opdb" and backup_root / "operations" in item.parents)
            )
        ),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )


def _prune_expired_backups(
    paths: SyncPaths,
    backup_root: Path,
    retained_snapshots: list[dict[str, Any]],
    retention_days: int,
) -> dict[str, Any]:
    """Remove only expired backup artifacts that are no longer protocol-critical.

    The active retained snapshots are protected regardless of age.  An
    operation backup may be removed only after its separately verified archive
    counterpart exists, preserving the recovery trail while enforcing the
    configured independent-backup retention window.
    """

    protected_snapshot_paths = {
        candidate.resolve()
        for item in retained_snapshots
        for candidate in _matching_snapshot_backup_paths(backup_root, item["pointer"])
    }
    cutoff = datetime.now(UTC) - timedelta(days=retention_days)
    deleted: list[str] = []
    skipped: list[str] = []

    for artifact in _backup_artifacts(backup_root):
        modified_at = datetime.fromtimestamp(artifact.stat().st_mtime, UTC)
        if modified_at >= cutoff:
            continue
        resolved = artifact.resolve()
        if resolved in protected_snapshot_paths:
            skipped.append(artifact.name)
            continue
        if artifact.suffix == ".opdb":
            relative = artifact.relative_to(backup_root / "operations")
            archive_relative = relative
            if relative.parts and len(relative.parts[0]) == 8 and relative.parts[0].isdigit():
                archive_relative = Path(*relative.parts[1:])
            archive_copy = paths.protocol_root / "archive" / "operations" / archive_relative
            try:
                backup_manifest, _ = read_package(artifact)
                archive_manifest, _ = read_package(archive_copy)
            except Exception:
                skipped.append(str(relative))
                continue
            if (
                backup_manifest.package_id != archive_manifest.package_id
                or sha256_file(artifact) != sha256_file(archive_copy)
            ):
                skipped.append(str(relative))
                continue
        artifact.unlink(missing_ok=True)
        deleted.append(str(artifact))

    return {
        "backup_retention_days": retention_days,
        "deleted_backup_count": len(deleted),
        "deleted_backups": deleted,
        "skipped_backup_count": len(skipped),
        "skipped_backups": skipped,
    }


def _verify_copy(source: Path, destination: Path, *, sha256: str, size_bytes: int) -> None:
    if not destination.is_file() or destination.stat().st_size != size_bytes:
        raise RuntimeError(f"Archived artifact is incomplete: {destination}")
    if sha256_file(destination) != sha256 or sha256_file(source) != sha256:
        raise RuntimeError(f"Archived artifact hash verification failed: {destination}")


def _ensure_retention_snapshot_baseline(
    paths: SyncPaths,
    system_database: Path,
    options: dict[str, Any],
) -> dict[str, Any]:
    """Publish one safe checkpoint per automatic run until retention is covered.

    Retention never archives online packages while the repository has fewer
    verified snapshots than the configured floor.  Each scheduled run creates
    at most one checkpoint, keeping the work bounded and auditable.
    """

    retention_lock = paths.protocol_root / "maintenance" / "retention.lck"
    with FileRangeLock(retention_lock, exclusive=True, timeout_seconds=60.0):
        active_pointer, retained_snapshots, _candidates, snapshot_errors = _retention_selection(
            paths, int(options["snapshot_count"])
        )
        if snapshot_errors:
            raise RuntimeError("Cannot create a retention baseline: " + " ".join(snapshot_errors))
        verified_count = len(retained_snapshots)
        if verified_count >= int(options["snapshot_count"]):
            return {
                "published_baseline_snapshot": False,
                "verified_snapshot_count": verified_count,
                "retention_target": int(options["snapshot_count"]),
            }

        publication = SharedSchemaPublisher(
            system_database, paths.network_root
        ).publish_retention_checkpoint(dict(active_pointer.log_floor))
        _current, updated_snapshots, _updated_candidates, updated_errors = _retention_selection(
            paths, int(options["snapshot_count"])
        )
        if updated_errors:
            raise RuntimeError(
                "The retention baseline checkpoint was published but could not be verified: "
                + " ".join(updated_errors)
            )
        return {
            "published_baseline_snapshot": True,
            "published_snapshot_id": publication["active_snapshot_id"],
            "previous_snapshot_id": publication["previous_snapshot_id"],
            "verified_snapshot_count": len(updated_snapshots),
            "retention_target": int(options["snapshot_count"]),
        }


def _archive_old_snapshots(
    paths: SyncPaths, backup_root: Path, retention_count: int
) -> list[str]:
    _active, retained, archive_candidates, errors = _retention_selection(paths, retention_count)
    if errors or len(retained) < retention_count:
        return []
    if _snapshot_backup_missing(backup_root, retained):
        return []
    archived: list[str] = []
    for item in archive_candidates:
        source: Path = item["path"]
        destination = paths.protocol_root / "archive" / "snapshots" / source.name
        copied_hash, copied_size = publish_immutable_file(source, destination)
        pointer: SnapshotPointer = item["pointer"]
        if copied_hash != pointer.sha256 or copied_size != pointer.size_bytes:
            raise RuntimeError(f"Snapshot archive verification failed for {pointer.snapshot_id}.")
        validate_snapshot(destination, _pointer_for_snapshot(destination))
        source.unlink(missing_ok=True)
        archived.append(pointer.snapshot_id)
    return archived


def _maintain_weekly_backups(
    paths: SyncPaths,
    backup_root: Path,
    options: dict[str, Any],
) -> dict[str, Any]:
    """Create the week's protected backups and enforce the 90-day window."""

    _active, retained, _candidates, errors = _retention_selection(
        paths, int(options["snapshot_count"])
    )
    if errors:
        raise RuntimeError("Cannot maintain backups until retained snapshots validate: " + " ".join(errors))
    backup_root.mkdir(parents=True, exist_ok=True)
    backups = [_ensure_snapshot_backup(backup_root, item) for item in retained]
    verification = _verify_backups(backup_root)
    if verification["invalid"]:
        raise RuntimeError("Weekly backup verification failed: " + "; ".join(verification["invalid"]))
    cleanup = _prune_expired_backups(
        paths,
        backup_root,
        retained,
        int(options["backup_days"]),
    )
    return {
        "snapshot_backup_count": len(backups),
        "verified_backup_count": verification["verified_count"],
        **cleanup,
    }


def _apply_retention(
    paths: SyncPaths,
    system_database: Path,
    backup_root: Path,
    options: dict[str, Any],
) -> dict[str, Any]:
    if not bool(options["enabled"]):
        raise RuntimeError("Business retention is disabled in portal settings.")
    retention_lock = paths.protocol_root / "maintenance" / "retention.lck"
    with FileRangeLock(retention_lock, exclusive=True, timeout_seconds=60.0):
        plan = _retention_plan(paths, backup_root, options)
        _active_pointer, retained, _candidates, _retained_errors = _retention_selection(
            paths, int(options["snapshot_count"])
        )
        backup_root.mkdir(parents=True, exist_ok=True)
        snapshot_backups = [
            _ensure_snapshot_backup(backup_root, item)
            for item in retained
        ]
        if not plan["ready_to_archive"]:
            backup_maintenance = _maintain_weekly_backups(paths, backup_root, options)
            return {
                **plan,
                **backup_maintenance,
                "archived_package_count": 0,
                "archived_snapshot_count": 0,
                "action": "Verified retained snapshot backups; no online data was eligible for archival.",
            }

        # Stage immutable snapshot backups and operation archive/backup copies
        # while all originals remain online.  No online artifact is removed at
        # this point, so a pre-commit crash leaves normal client recovery intact.
        active_pointer, retained, _candidates, _errors = _retention_selection(
            paths, int(options["snapshot_count"])
        )
        staged: list[dict[str, Any]] = []
        for package in plan["eligible_packages"]:
            source = Path(package["source_path"])
            archive_path = _archive_destination(paths, package)
            backup_path = _operation_backup_destination(backup_root, package)
            publish_immutable_file(source, archive_path)
            publish_immutable_file(source, backup_path)
            _verify_copy(source, archive_path, sha256=str(package["sha256"]), size_bytes=int(package["size_bytes"]))
            _verify_copy(source, backup_path, sha256=str(package["sha256"]), size_bytes=int(package["size_bytes"]))
            staged.append(
                {
                    "actor_id": package["actor_id"],
                    "package_id": package["package_id"],
                    "source_path": str(source),
                    "archive_path": str(archive_path),
                    "backup_path": str(backup_path),
                    "first_seq": package["first_seq"],
                    "last_seq": package["last_seq"],
                    "sha256": package["sha256"],
                }
            )

        publication = SharedSchemaPublisher(
            system_database, paths.network_root
        ).publish_retention_checkpoint(dict(plan["proposed_log_floor"]))
        current_pointer = load_snapshot_pointer(paths.protocol_root)
        current_snapshot = snapshot_file(paths.protocol_root, current_pointer)
        validate_snapshot(current_snapshot, current_pointer)
        current_entry = {
            "pointer": current_pointer,
            "path": current_snapshot,
        }
        snapshot_backups.append(_ensure_snapshot_backup(backup_root, current_entry))

        run_id = f"retention-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex}"
        archive_manifest = {
            "version": 1,
            "run_id": run_id,
            "created_at_utc": utc_now(),
            "previous_snapshot_id": plan["active_snapshot_id"],
            "active_snapshot_id": current_pointer.snapshot_id,
            "proposed_log_floor": dict(plan["proposed_log_floor"]),
            "snapshot_backups": snapshot_backups,
            "packages": staged,
        }
        publish_immutable_json(
            archive_manifest,
            paths.protocol_root / "archive" / "retention" / f"{run_id}.json",
        )

        removed: list[str] = []
        for package in plan["eligible_packages"]:
            source = Path(package["source_path"])
            archive_path = _archive_destination(paths, package)
            backup_path = _operation_backup_destination(backup_root, package)
            _verify_copy(source, archive_path, sha256=str(package["sha256"]), size_bytes=int(package["size_bytes"]))
            _verify_copy(source, backup_path, sha256=str(package["sha256"]), size_bytes=int(package["size_bytes"]))
            source.unlink()
            removed.append(str(package["package_id"]))

        _remove_retention_observations(
            paths, {str(item["observation_key"]) for item in plan["eligible_packages"]}
        )
        archived_snapshots = _archive_old_snapshots(
            paths, backup_root, int(options["snapshot_count"])
        )
        backup_maintenance = _maintain_weekly_backups(paths, backup_root, options)
        return {
            **_retention_plan(paths, backup_root, options),
            **backup_maintenance,
            "action": "Eligible online packages were archived; no permanent deletion was performed.",
            "retention_run_id": run_id,
            "published_snapshot_id": publication["active_snapshot_id"],
            "archived_package_count": len(removed),
            "archived_snapshot_count": len(archived_snapshots),
            "archived_packages": removed,
            "archived_snapshots": archived_snapshots,
        }


def _backup_status(paths: SyncPaths, backup_root: Path) -> dict[str, Any]:
    require_shared_root(paths.network_root)
    backups = _backup_artifacts(backup_root)
    snapshot_backups = [item for item in backups if item.suffix == ".db"]
    operation_backups = [item for item in backups if item.suffix == ".opdb"]
    result: dict[str, Any] = {
        "backup_root": str(backup_root),
        "backup_count": len(backups),
        "latest_backup": str(backups[0]) if backups else "",
        "snapshot_backup_count": len(snapshot_backups),
        "operation_backup_count": len(operation_backups),
        "backups": [
            {
                "name": item.name,
                "path": str(item),
                "size_bytes": item.stat().st_size,
                "modified_at": datetime.fromtimestamp(item.stat().st_mtime, UTC).isoformat(),
            }
            for item in backups
        ],
    }
    try:
        pointer = load_snapshot_pointer(paths.protocol_root)
        recovery_backup = _find_verified_recovery_backup(backup_root, pointer)
        result.update(
            {
                "active_snapshot_id": pointer.snapshot_id,
                "recovery_available": recovery_backup is not None,
                "recovery_backup_path": str(recovery_backup) if recovery_backup else "",
                "recovery_reason": (
                    "A verified matching snapshot backup is available."
                    if recovery_backup
                    else "No verified backup matches the active snapshot."
                ),
            }
        )
    except Exception as error:
        result.update(
            {
                "active_snapshot_id": "",
                "recovery_available": False,
                "recovery_backup_path": "",
                "recovery_reason": f"Recovery status could not be checked: {error}",
            }
        )
    return result


def _run_nightly_maintenance(
    paths: SyncPaths,
    system_database: Path,
    options: dict[str, Any],
    *,
    automatic: bool,
) -> dict[str, Any]:
    """Publish one verified checkpoint.

    The workstation never edits business rows.  The checkpoint publisher holds
    the shared epoch lock and replays all committed active-epoch operations
    before atomically replacing the snapshot pointer.  A concurrent save can
    make the optimistic snapshot ID stale; retrying once creates a useful
    nightly result without weakening that lock protocol.
    """

    if automatic and not options["enabled"]:
        return {"skipped": True, "reason": "Nightly business maintenance is disabled in portal settings."}
    if automatic and not options["automatic_enabled"]:
        return {"skipped": True, "reason": "Automatic nightly business maintenance is disabled in portal settings."}

    publication: dict[str, Any] | None = None
    last_error: Exception | None = None
    for _attempt in range(2):
        pointer = load_snapshot_pointer(paths.protocol_root)
        try:
            publication = SharedSchemaPublisher(system_database, paths.network_root).publish_checkpoint(pointer.snapshot_id)
            break
        except Exception as error:  # A concurrent checkpoint/save can change the pointer between reads.
            last_error = error
    if publication is None:
        raise RuntimeError(f"Nightly checkpoint could not be published: {last_error}")

    active_pointer = load_snapshot_pointer(paths.protocol_root)
    active_path = snapshot_file(paths.protocol_root, active_pointer)
    validate_snapshot(active_path, active_pointer)
    return {
        "skipped": False,
        "active_snapshot_id": active_pointer.snapshot_id,
        "previous_snapshot_id": publication.get("previous_snapshot_id", ""),
        "publication_kind": publication.get("publication_kind", "checkpoint"),
    }


def _verify_backups(backup_root: Path) -> dict[str, Any]:
    backups = _backup_artifacts(backup_root)
    verified = 0
    invalid: list[str] = []
    for backup in backups:
        try:
            if backup.suffix == ".db":
                validate_snapshot(backup, _pointer_for_snapshot(backup))
            else:
                read_package(backup)
            verified += 1
        except Exception as error:
            invalid.append(f"{backup.name}: {error}")
    return {"backup_root": str(backup_root), "backup_count": len(backups), "verified_count": verified, "invalid": invalid}


def _restore_corrupt_active_snapshot(
    paths: SyncPaths, backup_root: Path, confirmation: str
) -> dict[str, Any]:
    """Repair a missing or corrupt active snapshot from its exact backup copy.

    This is break-glass recovery, not time travel.  The current pointer is not
    changed and the backup must have identical snapshot identity, hash, epoch,
    and coverage.  Normal operation packages remain intact for later replay.
    """

    require_shared_root(paths.network_root)
    with FileRangeLock(paths.epoch_lock, exclusive=True, timeout_seconds=60.0):
        pointer = load_snapshot_pointer(paths.protocol_root)
        if confirmation.strip() != pointer.snapshot_id:
            raise ValueError("Type the active snapshot ID to restore it from its verified backup.")
        active_path = snapshot_file(paths.protocol_root, pointer)
        try:
            validate_snapshot(active_path, pointer)
        except Exception as active_error:
            corruption_reason = str(active_error)
        else:
            raise ValueError(
                "The active snapshot is already valid. Restore is available only to repair a missing or corrupt active snapshot."
            )

        backup_path = _find_verified_recovery_backup(backup_root, pointer)
        if backup_path is None:
            raise RuntimeError(
                "No verified backup exactly matches the active snapshot. Use a controlled schema/recovery procedure instead of restoring an older backup."
            )
        install_snapshot(backup_path, active_path, pointer)
        validate_snapshot(active_path, pointer)
        return {
            "active_snapshot_id": pointer.snapshot_id,
            "backup_path": str(backup_path),
            "active_path": str(active_path),
            "repaired_reason": corruption_reason,
        }


def _list_conflicts(paths: SyncPaths) -> dict[str, Any]:
    pointer = load_snapshot_pointer(paths.protocol_root)
    source = snapshot_file(paths.protocol_root, pointer)
    validate_snapshot(source, pointer)
    with closing(sqlite3.connect(sqlite_readonly_uri(source, immutable=True), uri=True)) as connection:
        connection.execute("PRAGMA trusted_schema=OFF")
        rows = connection.execute(
            "SELECT conflict_id, entity_type, entity_id, state, detected_at_utc, selected_operation_id "
            "FROM sw_sync_conflict ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, detected_at_utc DESC"
        ).fetchall()
    conflicts = [
        {
            "conflict_id": str(row[0]), "entity_type": str(row[1]), "entity_id": str(row[2]),
            "state": str(row[3]), "detected_at": str(row[4]), "selected_operation_id": str(row[5] or ""),
        }
        for row in rows
    ]
    return {"active_snapshot_id": pointer.snapshot_id, "open_count": sum(item["state"] == "open" for item in conflicts), "conflicts": conflicts}


def _export_conflicts(paths: SyncPaths) -> dict[str, Any]:
    result = _list_conflicts(paths)
    export_root = paths.protocol_root / "maintenance" / "reports"
    export_root.mkdir(parents=True, exist_ok=True)
    target = export_root / f"conflicts-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"
    with target.open("x", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=("conflict_id", "entity_type", "entity_id", "state", "detected_at", "selected_operation_id"))
        writer.writeheader()
        writer.writerows(result["conflicts"])
    return {**result, "export_path": str(target)}


def _list_events(paths: SyncPaths, selected_date: str) -> dict[str, Any]:
    path = _event_path(paths)
    events: list[dict[str, Any]] = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and str(event.get("recorded_at", "")).startswith(selected_date):
                events.append(event)
    events.sort(key=lambda item: str(item.get("recorded_at", "")), reverse=True)
    return {
        "log_path": str(path),
        "log_directory": str(path.parent),
        "retention_days": LOG_RETENTION_DAYS,
        "events": events,
    }


def _display_users(system_database: Path) -> dict[str, str]:
    """Resolve immutable operation user IDs to names without changing system data."""
    if not system_database.is_file():
        return {}
    try:
        with closing(sqlite3.connect(sqlite_readonly_uri(system_database, immutable=True), uri=True)) as connection:
            connection.execute("PRAGMA trusted_schema=OFF")
            rows = connection.execute(
                "SELECT id, first_name, last_name, email FROM SYS_USERS WHERE deleted_at IS NULL"
            ).fetchall()
    except sqlite3.DatabaseError:
        return {}
    result: dict[str, str] = {}
    for user_id, first_name, last_name, email in rows:
        display_name = " ".join(
            part for part in (str(first_name or "").strip(), str(last_name or "").strip()) if part
        )
        result[str(user_id)] = display_name or str(email or "").strip() or str(user_id)
    return result


def _local_operation_date(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone().date().isoformat()


def _list_activity(paths: SyncPaths, system_database: Path, selected_date: str) -> dict[str, Any]:
    try:
        datetime.strptime(selected_date, "%Y-%m-%d")
    except ValueError as error:
        raise ValueError("Selected date must use YYYY-MM-DD format.") from error

    users_root = paths.protocol_root / "users"
    user_names = _display_users(system_database)
    operations: list[dict[str, Any]] = []
    package_ids: set[str] = set()
    actor_ids: set[str] = set()
    skipped_package_count = 0
    package_paths: list[Path] = []
    if users_root.is_dir():
        package_paths.extend(
            path
            for path in users_root.glob("emp-*/actors/actor-*/operations/*/*/*.opdb")
            if path.is_file()
        )
    archive_root = paths.protocol_root / "archive" / "operations"
    if archive_root.is_dir():
        package_paths.extend(path for path in archive_root.rglob("*.opdb") if path.is_file())
    package_paths.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for package_path in package_paths:
        try:
            manifest, package_operations = read_package(package_path)
        except Exception:
            skipped_package_count += 1
            continue
        matching = [operation for operation in package_operations if _local_operation_date(operation.created_at_utc) == selected_date]
        if not matching:
            continue
        package_ids.add(manifest.package_id)
        actor_ids.add(manifest.actor_id)
        for operation in matching:
            operations.append(
                {
                    "operation_id": operation.operation_id,
                    "tx_id": operation.tx_id,
                    "actor_id": operation.actor_id,
                    "actor_seq": operation.actor_seq,
                    "user_id": operation.user_id,
                    "user_name": user_names.get(operation.user_id, operation.user_id),
                    "employee_number": manifest.employee_number,
                    "entity_type": operation.entity_type,
                    "entity_id": operation.entity_id,
                    "operation_type": operation.operation_type,
                    "created_at": operation.created_at_utc,
                    "package_id": manifest.package_id,
                    "package_path": str(package_path),
                }
            )
    operations.sort(
        key=lambda item: (str(item["created_at"]), str(item["actor_id"]), int(item["actor_seq"])),
        reverse=True,
    )
    return {
        "selected_date": selected_date,
        "operations": operations,
        "operation_count": len(operations),
        "package_count": len(package_ids),
        "actor_count": len(actor_ids),
        "skipped_package_count": skipped_package_count,
        "package_root": str(users_root),
    }


def _settings_status(settings_path: Path, network_root: Path, system_database: Path, backup_root: Path) -> dict[str, Any]:
    settings = _read_json(settings_path)
    return {
        "settings_path": str(settings_path),
        "network_root": str(network_root),
        "system_database": str(system_database),
        "backup_root": str(backup_root),
        "network_available": network_root.is_dir(),
        "system_database_available": system_database.is_file(),
        "python_version": sys.version.split()[0],
        "schema_version": settings.get("schemaVersion"),
    }


def _save_network_root(settings_path: Path, network_root: str) -> dict[str, Any]:
    value = _read_json(settings_path)
    business_sync = value.get("businessSync")
    if not isinstance(business_sync, dict):
        raise ValueError("Portal settings must define businessSync.")
    candidate = Path(network_root)
    if not candidate.is_dir():
        raise ValueError(f"The shared repository path is unavailable: {candidate}")
    business_sync["networkRoot"] = network_root
    settings_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"network_root": network_root}


def _save_retention_policy(
    settings_path: Path,
    operation_online_days: int,
    verified_snapshot_count: int,
) -> dict[str, Any]:
    if operation_online_days < OPERATION_ONLINE_RETENTION_DAYS:
        raise ValueError("Business operation retention cannot be less than seven days.")
    if verified_snapshot_count < SNAPSHOT_RETENTION_COUNT:
        raise ValueError("Business snapshot retention cannot be less than five verified snapshots.")

    value = _read_json(settings_path)
    maintenance = value.setdefault("maintenance", {})
    if not isinstance(maintenance, dict):
        raise ValueError("Portal settings maintenance section must be an object.")
    retention = maintenance.setdefault("businessRetention", {})
    if not isinstance(retention, dict):
        raise ValueError("Portal settings maintenance.businessRetention must be an object.")
    retention["operationOnlineDays"] = operation_online_days
    retention["verifiedSnapshotCount"] = verified_snapshot_count
    settings_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return _retention_options(settings_path)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portal workstation maintenance task runner")
    parser.add_argument(
        "--task",
        required=True,
        choices=(
            "snapshot.status", "snapshot.validate", "snapshot.publish", "snapshot.retention-plan",
            "snapshot.retention.apply", "snapshot.retention.run", "snapshot.retention.schedule.status",
            "snapshot.retention.schedule.enable", "snapshot.retention.schedule.disable",
            "snapshot.nightly.run", "snapshot.nightly.schedule.status",
            "snapshot.nightly.schedule.enable", "snapshot.nightly.schedule.disable",
            "backup.status", "backup.verify", "backup.restore-active",
            "conflict.list", "conflict.export", "log.list", "activity.list", "settings.status",
            "settings.update-network-root", "settings.update-retention-policy",
        ),
    )
    parser.add_argument("--portal-settings", type=Path, required=True)
    parser.add_argument("--confirmation", default="")
    parser.add_argument("--selected-date", default="")
    parser.add_argument("--network-root", default="")
    parser.add_argument("--operation-online-days", type=int)
    parser.add_argument("--verified-snapshot-count", type=int)
    parser.add_argument("--automatic", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    paths: SyncPaths | None = None
    try:
        network_root, system_database, backup_root = _configured_paths(args.portal_settings)
        paths = SyncPaths(network_root)
        retention_options = _retention_options(args.portal_settings)
        nightly_options = _nightly_options(args.portal_settings)
        task: str = args.task
        if task == "snapshot.status":
            result = _snapshot_status(paths, retention_count=int(retention_options["snapshot_count"]))
            result.update(
                {
                    "operation_online_days": retention_options["online_days"],
                    "automatic_enabled": retention_options["automatic_enabled"],
                    "automatic_schedule": f"{retention_options['day_of_week']} {retention_options['time']} local time",
                }
            )
        elif task == "snapshot.validate":
            result = {
                **_snapshot_status(paths, retention_count=int(retention_options["snapshot_count"])),
                "valid": True,
                "operation_online_days": retention_options["online_days"],
                "automatic_enabled": retention_options["automatic_enabled"],
                "automatic_schedule": f"{retention_options['day_of_week']} {retention_options['time']} local time",
            }
        elif task == "snapshot.publish":
            result = SharedSchemaPublisher(system_database, network_root).publish_checkpoint(args.confirmation)
            _append_event(paths, task, "Succeeded", f"Published snapshot {result['active_snapshot_id']}.")
        elif task == "snapshot.retention-plan":
            result = {
                **_snapshot_status(paths, retention_count=int(retention_options["snapshot_count"])),
                **_retention_plan(paths, backup_root, retention_options),
                "action": "This plan records first observations but does not archive data. Eligible packages remain online until a confirmed archive run publishes a replacement snapshot.",
            }
        elif task == "snapshot.retention.apply":
            pointer = load_snapshot_pointer(paths.protocol_root)
            if args.confirmation.strip() != pointer.snapshot_id:
                raise ValueError("Type the current active snapshot ID to archive eligible data.")
            result = _apply_retention(paths, system_database, backup_root, retention_options)
            _append_event(
                paths,
                task,
                "Succeeded",
                f"Archived {result['archived_package_count']} operation package(s) and {result['archived_snapshot_count']} snapshot(s).",
            )
        elif task == "snapshot.retention.run":
            if not args.automatic:
                raise ValueError("Automatic retention requires the --automatic flag.")
            if not retention_options["enabled"]:
                result = {"skipped": True, "reason": "Business retention is disabled in portal settings."}
            elif not retention_options["automatic_enabled"]:
                result = {"skipped": True, "reason": "Automatic business retention is disabled in portal settings."}
            elif datetime.now().strftime("%A").lower() != str(retention_options["day_of_week"]).lower():
                result = {"skipped": True, "reason": f"Automatic retention runs on {retention_options['day_of_week']}."}
            else:
                baseline = _ensure_retention_snapshot_baseline(
                    paths, system_database, retention_options
                )
                if baseline["published_baseline_snapshot"]:
                    backup_maintenance = _maintain_weekly_backups(
                        paths, backup_root, retention_options
                    )
                    result = {
                        **baseline,
                        **backup_maintenance,
                        "skipped": True,
                        "reason": "Published one verified baseline snapshot and maintained weekly backups. Online packages were not archived while the retention baseline is being formed.",
                    }
                    _append_event(
                        paths,
                        task,
                        "Succeeded",
                        f"Published verified baseline snapshot {baseline['published_snapshot_id']} ({baseline['verified_snapshot_count']}/{baseline['retention_target']}) and maintained backups.",
                    )
                else:
                    result = _apply_retention(paths, system_database, backup_root, retention_options)
                    _append_event(
                        paths,
                        task,
                        "Succeeded",
                        f"Archived {result['archived_package_count']} operation package(s) and {result['archived_snapshot_count']} snapshot(s).",
                    )
        elif task == "snapshot.retention.schedule.status":
            result = _retention_schedule_status(args.portal_settings, retention_options)
        elif task == "snapshot.retention.schedule.enable":
            result = _set_retention_schedule(args.portal_settings, retention_options, enabled=True)
            _append_event(paths, task, "Succeeded", f"Registered {RETENTION_TASK_NAME}.")
        elif task == "snapshot.retention.schedule.disable":
            result = _set_retention_schedule(args.portal_settings, retention_options, enabled=False)
            _append_event(paths, task, "Succeeded", f"Removed {RETENTION_TASK_NAME}.")
        elif task == "snapshot.nightly.run":
            result = _run_nightly_maintenance(
                paths,
                system_database,
                nightly_options,
                automatic=args.automatic,
            )
            if result.get("skipped"):
                _append_event(paths, task, "Skipped", str(result.get("reason", "Nightly maintenance was skipped.")))
            else:
                _append_event(
                    paths,
                    task,
                    "Succeeded",
                    f"Published verified checkpoint snapshot {result['active_snapshot_id']}.",
                )
        elif task == "snapshot.nightly.schedule.status":
            result = _nightly_schedule_status(args.portal_settings, nightly_options)
        elif task == "snapshot.nightly.schedule.enable":
            result = _set_nightly_schedule(args.portal_settings, nightly_options, enabled=True)
            _append_event(paths, task, "Succeeded", f"Registered {NIGHTLY_TASK_NAME}.")
        elif task == "snapshot.nightly.schedule.disable":
            result = _set_nightly_schedule(args.portal_settings, nightly_options, enabled=False)
            _append_event(paths, task, "Succeeded", f"Removed {NIGHTLY_TASK_NAME}.")
        elif task == "backup.status":
            result = _backup_status(paths, backup_root)
        elif task == "backup.verify":
            result = _verify_backups(backup_root)
            _append_event(paths, task, "Succeeded" if not result["invalid"] else "Failed", f"Verified {result['verified_count']} backup(s).")
        elif task == "backup.restore-active":
            result = _restore_corrupt_active_snapshot(paths, backup_root, args.confirmation)
            _append_event(
                paths,
                task,
                "Succeeded",
                f"Restored active snapshot {result['active_snapshot_id']} from verified backup {Path(result['backup_path']).name}.",
            )
        elif task == "conflict.list":
            result = _list_conflicts(paths)
        elif task == "conflict.export":
            result = _export_conflicts(paths)
            _append_event(paths, task, "Succeeded", f"Exported conflicts to {result['export_path']}.")
        elif task == "log.list":
            selected_date = args.selected_date or datetime.now().date().isoformat()
            result = _list_events(paths, selected_date)
        elif task == "activity.list":
            selected_date = args.selected_date or datetime.now().date().isoformat()
            result = _list_activity(paths, system_database, selected_date)
        elif task == "settings.status":
            result = _settings_status(args.portal_settings, network_root, system_database, backup_root)
        elif task == "settings.update-retention-policy":
            if args.operation_online_days is None or args.verified_snapshot_count is None:
                raise ValueError("Operation retention days and verified snapshot count are required.")
            result = _save_retention_policy(
                args.portal_settings,
                args.operation_online_days,
                args.verified_snapshot_count,
            )
            _append_event(
                paths,
                task,
                "Succeeded",
                f"Updated retention policy to {result['online_days']} online day(s) and {result['snapshot_count']} verified snapshot(s).",
            )
        else:
            if not args.network_root.strip():
                raise ValueError("A shared repository path is required.")
            result = _save_network_root(args.portal_settings, args.network_root.strip())
            _append_event(paths, task, "Succeeded", f"Updated the configured shared repository path to {result['network_root']}.")
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as error:
        if paths is not None and args.task not in {"snapshot.status", "snapshot.validate", "backup.status", "conflict.list", "log.list", "activity.list", "settings.status"}:
            try:
                _append_event(paths, args.task, "Failed", str(error))
            except Exception:
                pass
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
