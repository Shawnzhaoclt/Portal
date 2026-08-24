"""GUI-facing task boundary for shared Portal schema publication."""

from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


_RUNNER_DIRECTORY = Path(__file__).resolve().parent
for _candidate in (_RUNNER_DIRECTORY / "python", _RUNNER_DIRECTORY.parent.parent / "python"):
    if (_candidate / "portal" / "app" / "schema").is_dir():
        sys.path.insert(0, str(_candidate))
        break

from portal.app.schema.catalog import (
    ALEMBIC_SCHEMA_HANDLER,
    apply_schema_draft,
    ensure_compatible_schema_transition,
    prepare_schema_migration_operations,
    register_business_schema,
    registered_business_catalog,
    schema_draft_catalog_for_registration,
)
from portal.app.schema.shared_publisher import SharedSchemaPublisher
from portal.app.schema.manager import SchemaManager
from portal.app.sync.storage import sqlite_readonly_uri


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object in {path}.")
    return payload


def _expand(value: str, *, settings_path: Path, data_root: str) -> Path:
    application_root = settings_path.resolve().parent.parent
    replacements = {
        "${PORTAL_APP_ROOT}": str(application_root),
        "${PORTAL_DATA_ROOT}": str(application_root),
        "${PORTAL_SHARED_DATA_ROOT}": data_root,
        "${PORTAL_BUSINESS_NETWORK_ROOT}": str(Path(data_root) / "portal" / "data"),
    }
    for token, replacement in replacements.items():
        value = value.replace(token, replacement)
    candidate = Path(os.path.expandvars(value))
    return candidate if candidate.is_absolute() else (settings_path.parent / candidate).resolve()


def _configured_paths(settings_path: Path) -> tuple[Path, Path, Path]:
    settings = _read_json(settings_path)
    data_root = str(settings.get("shared", {}).get("dataRoot", "")).strip()
    system_database = str(settings.get("system", {}).get("database", "")).strip()
    business_database = str(settings.get("business", {}).get("database", "")).strip()
    network_root = str(settings.get("businessSync", {}).get("networkRoot", "")).strip()
    if not data_root or not system_database or not business_database or not network_root:
        raise ValueError(
            "Portal settings must define shared.dataRoot, system.database, business.database, "
            "and businessSync.networkRoot."
        )
    return (
        _expand(system_database, settings_path=settings_path, data_root=data_root),
        _expand(business_database, settings_path=settings_path, data_root=data_root),
        _expand(network_root, settings_path=settings_path, data_root=data_root),
    )


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portal Workstation Manager schema task runner")
    parser.add_argument(
        "--task",
        choices=("schema.status", "schema.validate", "schema.plan", "schema.catalog", "schema.test-draft", "schema.register", "schema.initialize", "schema.migrate"),
        required=True,
    )
    parser.add_argument("--portal-settings", type=Path, required=True)
    parser.add_argument("--confirmation", default="")
    return parser.parse_args()


@contextmanager
def _writable_catalog(path: Path):
    """Temporarily unlock the approved packaged catalog for schema authoring.

    Portal clients receive ``system.db`` with the Windows read-only attribute set.
    Registering an approved schema is a workstation-only authoring operation, so it
    briefly removes that attribute and restores the original mode on every exit.
    """
    original_mode = path.stat().st_mode
    was_writable = bool(original_mode & stat.S_IWRITE)
    if not was_writable:
        path.chmod(original_mode | stat.S_IWRITE)
    try:
        yield
    finally:
        if not was_writable and path.exists():
            path.chmod(original_mode)


def _draft_path(settings_path: Path) -> Path:
    return settings_path.resolve().parent / "schema.draft.json"


def _operations_hash(operations: list[dict[str, Any]]) -> str:
    canonical = json.dumps(operations, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _write_json_replace(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _load_draft(settings_path: Path, catalog: dict[str, Any]) -> dict[str, Any]:
    path = _draft_path(settings_path)
    if not path.is_file():
        operations: list[dict[str, Any]] = []
        base_release_id = str(catalog["release_id"])
        last_test = None
    else:
        payload = _read_json(path)
        base_release_id = str(payload.get("base_release_id") or "")
        if base_release_id != str(catalog["release_id"]):
            raise ValueError(
                "The schema draft was created from a different release. Discard it or refresh it before continuing."
            )
        raw_operations = payload.get("operations")
        if not isinstance(raw_operations, list):
            raise ValueError("The schema draft must contain an operations list.")
        operations = [dict(item) if isinstance(item, dict) else item for item in raw_operations]
        last_test = payload.get("last_test") if isinstance(payload.get("last_test"), dict) else None
    tables = apply_schema_draft(catalog["tables"], operations)
    return {
        **catalog,
        "base_release_id": base_release_id,
        "draft_path": str(path),
        "draft_exists": path.is_file(),
        "dirty": bool(operations),
        "operations": operations,
        "operations_hash": _operations_hash(operations),
        "last_test": last_test,
        "test_passed": bool(
            last_test
            and last_test.get("passed") is True
            and last_test.get("operations_hash") == _operations_hash(operations)
        ),
        "tables": tables,
        "table_count": len(tables),
        "field_count": sum(len(table["fields"]) for table in tables),
        "index_count": sum(
            sum(1 for index in table["indexes"] if not index.get("removed"))
            for table in tables
        ),
    }


def _migration_operations(
    tables: list[dict[str, Any]], operations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    return prepare_schema_migration_operations(tables, operations)


REBUILD_SCHEMA_HANDLER = "registered_physical_schema_rebuild"


def _physical_type_drift(
    snapshot: Path, tables: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Return the retype operations a snapshot needs to match the registered catalog.

    A registered type change cannot be applied with ALTER TABLE, so the physical
    database keeps its original column type until the table is rebuilt. Comparing the
    catalog against the published snapshot surfaces exactly which columns drifted.
    """
    operations: list[dict[str, Any]] = []
    # The published snapshot normally lives on a UNC share, which SQLite rejects unless
    # the URI is built to keep the server name out of the authority component.
    with closing(
        sqlite3.connect(sqlite_readonly_uri(snapshot, immutable=True), uri=True)
    ) as connection:
        available = {
            str(row[0]).lower()
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        for table in tables:
            physical_table = str(table["physical_table"])
            if physical_table.lower() not in available:
                continue
            actual = {
                str(row[1]): str(row[2] or "TEXT").upper()
                for row in connection.execute(f'PRAGMA table_info("{physical_table}")')
            }
            for field in table.get("fields", []):
                column = str(field["physical_column"])
                expected = str(field["sqlite_type"]).upper()
                if column in actual and actual[column] != expected:
                    operations.append(
                        {
                            "kind": "retype_column",
                            "table": physical_table,
                            "column": column,
                            "sqlite_type": expected,
                        }
                    )
    return operations


def _test_draft(
    settings_path: Path,
    system_database: Path,
    network_root: Path,
) -> dict[str, Any]:
    active_catalog = registered_business_catalog(system_database)
    draft = _load_draft(settings_path, active_catalog)
    operations = list(draft["operations"])
    if not operations:
        raise ValueError("Add at least one schema operation before testing the draft.")
    migration_operations = _migration_operations(active_catalog["tables"], operations)
    publisher = SharedSchemaPublisher(system_database, network_root)
    status = publisher.status()
    drift_operations = _physical_type_drift(
        Path(str(status["active_snapshot_path"])), active_catalog["tables"]
    )
    affected_table_ids = {str(item["table_id"]) for item in operations}
    affected_tables = sorted(
        str(table["physical_table"])
        for table in draft["tables"]
        if str(table["table_id"]) in affected_table_ids
    )
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="portal-schema-draft-test-") as directory:
        root = Path(directory)
        test_system = root / "system.db"
        test_business = root / "stormwater.db"
        shutil.copy2(system_database, test_system)
        shutil.copy2(Path(str(status["active_snapshot_path"])), test_business)
        test_system.chmod(test_system.stat().st_mode | stat.S_IWRITE)
        test_business.chmod(test_business.stat().st_mode | stat.S_IWRITE)
        registration = register_business_schema(
            test_system,
            test_business,
            catalog_override=schema_draft_catalog_for_registration(draft["tables"]),
            migration_handler=(
                REBUILD_SCHEMA_HANDLER if drift_operations else ALEMBIC_SCHEMA_HANDLER
            ),
            migration_specification=(
                {
                    "retype_operations": drift_operations,
                    "operations": migration_operations,
                }
                if drift_operations
                else {"operations": migration_operations}
            ),
        )
        # Register collapses the route from the published release to the new target so a
        # superseded intermediate migration cannot be replayed. Mirror that here, or the
        # test would plan a different path than the publish it is meant to rehearse.
        installed_release_id = status.get("installed_release_id")
        if installed_release_id and str(installed_release_id) != registration["release_id"]:
            ensure_compatible_schema_transition(
                test_system,
                from_release_id=str(installed_release_id),
                from_schema_version=int(status.get("installed_schema_version") or 1),
                from_catalog_hash=str(status.get("installed_catalog_hash") or "unknown"),
                migration_handler=(
                    REBUILD_SCHEMA_HANDLER if drift_operations else ALEMBIC_SCHEMA_HANDLER
                ),
                migration_specification=(
                    {
                        "retype_operations": drift_operations,
                        "operations": migration_operations,
                    }
                    if drift_operations
                    else {"operations": migration_operations}
                ),
                migration_kind="rebuild" if drift_operations else None,
            )

        manager = SchemaManager(test_system, test_business)
        plan = manager.plan()
        result = manager.migrate()
        with closing(sqlite3.connect(test_business)) as connection:
            row_counts = {
                table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
                for table in affected_tables
            }
    report = {
        "passed": True,
        "operations_hash": draft["operations_hash"],
        "tested_release_id": registration["release_id"],
        "source_snapshot_id": status["active_snapshot_id"],
        "migration_count": len(plan.get("migrations", [])),
        "affected_tables": affected_tables,
        "row_counts": row_counts,
        "checks": result.get("checks", {}),
        "duration_seconds": round(time.perf_counter() - started, 3),
    }
    _write_json_replace(
        _draft_path(settings_path),
        {
            "base_release_id": draft["base_release_id"],
            "operations": operations,
            "last_test": report,
        },
    )
    return _load_draft(settings_path, active_catalog)


def main() -> int:
    args = _arguments()
    try:
        system_database, business_database, network_root = _configured_paths(args.portal_settings)
        if args.task == "schema.catalog":
            result = _load_draft(
                args.portal_settings,
                registered_business_catalog(system_database),
            )
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
            return 0
        if args.task == "schema.test-draft":
            result = _test_draft(
                args.portal_settings,
                system_database,
                network_root,
            )
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
            return 0
        if args.task == "schema.register":
            active_catalog = registered_business_catalog(system_database)
            draft = _load_draft(args.portal_settings, active_catalog)
            draft_operations = list(draft["operations"])
            if draft_operations and not draft["test_passed"]:
                raise ValueError(
                    "Test the current schema draft successfully before registering its release."
                )
            migration_operations = _migration_operations(
                active_catalog["tables"], draft_operations
            )
            with _writable_catalog(system_database):
                registration = register_business_schema(
                    system_database,
                    business_database,
                    catalog_override=(
                        schema_draft_catalog_for_registration(draft["tables"])
                        if draft_operations
                        else None
                    ),
                    migration_handler=(
                        ALEMBIC_SCHEMA_HANDLER
                        if draft_operations
                        else "registered_physical_schema"
                    ),
                    migration_specification=(
                        {"operations": migration_operations}
                        if draft_operations
                        else None
                    ),
                )
                publisher = SharedSchemaPublisher(system_database, network_root)
                shared_status = publisher.status()
                transition = None
                installed_release_id = shared_status.get("installed_release_id")
                # A registered type change never reaches the published snapshot through
                # ALTER TABLE, so repair that drift with an explicit table rebuild as part
                # of the same transition that applies the draft.
                drift_operations = _physical_type_drift(
                    Path(str(shared_status["active_snapshot_path"])),
                    registered_business_catalog(system_database)["tables"],
                )
                if installed_release_id and installed_release_id != shared_status.get("target_release_id"):
                    transition = ensure_compatible_schema_transition(
                        system_database,
                        from_release_id=str(installed_release_id),
                        from_schema_version=int(shared_status.get("installed_schema_version") or 1),
                        from_catalog_hash=str(shared_status.get("installed_catalog_hash") or "unknown"),
                        migration_handler=(
                            REBUILD_SCHEMA_HANDLER
                            if drift_operations
                            else ALEMBIC_SCHEMA_HANDLER
                            if draft_operations
                            else "registered_physical_schema"
                        ),
                        migration_specification=(
                            {
                                "retype_operations": drift_operations,
                                "operations": migration_operations,
                            }
                            if drift_operations
                            else {"operations": migration_operations}
                            if draft_operations
                            else None
                        ),
                        migration_kind="rebuild" if drift_operations else None,
                    )
            if draft_operations:
                _draft_path(args.portal_settings).unlink(missing_ok=True)
            result = {
                **registration,
                "draft_changes_registered": len(draft_operations),
                "shared_installed_release_id": installed_release_id,
                "transition": transition,
            }
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
            return 0
        publisher = SharedSchemaPublisher(system_database, network_root)
        if args.task == "schema.status":
            result = publisher.status()
        elif args.task == "schema.validate":
            result = publisher.validate()
        elif args.task == "schema.plan":
            result = publisher.plan()
        elif args.task == "schema.initialize":
            result = publisher.publish("baseline", args.confirmation)
        else:
            result = publisher.publish("migration", args.confirmation)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
