from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import re
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from portal.app.sync.local_store import LocalStore
from portal.app.sync.physical_entities import all_physical_specs, validate_physical_registry


BASELINE_HANDLER = "baseline"
PHYSICAL_SCHEMA_HANDLER = "registered_physical_schema"
COMPATIBLE_SQLITE_HANDLER = "compatible_sqlite"
ALEMBIC_SCHEMA_HANDLER = "alembic_structural"
_DRAFT_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_GENERATED_TABLE_ID = re.compile(r"^tbl_[0-9a-f]{32}$")
_DRAFT_PHYSICAL_TABLE = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")
_DRAFT_SQLITE_TYPES = {"TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC"}

BUSINESS_TABLES = tuple(
    (
        spec.table,
        spec.entity_type,
        "tombstone",
        spec.dependency_order,
    )
    for spec in all_physical_specs()
)


def dated_release_id(at: datetime | None = None) -> str:
    """Return the descriptive release name used for a dated schema publication.

    The day-of-year format keeps names sortable while avoiding opaque numeric
    version labels such as ``v1`` and ``v2``.
    """
    timestamp = at or datetime.now(timezone.utc)
    return f"portal-coordinator-{timestamp.year:04d}-{timestamp.timetuple().tm_yday:03d}"


def dated_migration_id(at: datetime | None = None) -> str:
    """Return the matching human-readable migration identifier."""
    timestamp = at or datetime.now(timezone.utc)
    return f"PORTAL_COORDINATOR_{timestamp.year:04d}_{timestamp.timetuple().tm_yday:03d}"


def _readonly_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)


def _logical_type(sqlite_type: str) -> str:
    normalized = sqlite_type.upper()
    if "INT" in normalized:
        return "integer"
    if any(token in normalized for token in ("REAL", "FLOA", "DOUB", "DEC")):
        return "number"
    if any(token in normalized for token in ("DATE", "TIME")):
        return "datetime"
    if "BLOB" in normalized:
        return "binary"
    return "text"


def _business_catalog(business_database: Path) -> list[dict[str, Any]]:
    if not business_database.is_file():
        raise FileNotFoundError(f"Business database was not found: {business_database}")

    with closing(_readonly_connection(business_database)) as connection:
        available = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        expected = {table_name for table_name, *_ in BUSINESS_TABLES}
        missing = sorted(expected - available)
        if missing:
            raise RuntimeError(f"The business database is missing registered tables: {', '.join(missing)}")

        catalog: list[dict[str, Any]] = []
        for physical_table, table_id, delete_policy, dependency_order in BUSINESS_TABLES:
            columns = []
            for ordinal, row in enumerate(connection.execute(f'PRAGMA table_info("{physical_table}")')):
                _, column_name, sqlite_type, not_null, default_value, primary_key = row
                columns.append(
                    {
                        "field_id": f"{table_id}.{column_name}",
                        "physical_column": column_name,
                        "logical_type": _logical_type(sqlite_type or "TEXT"),
                        "sqlite_type": sqlite_type or "TEXT",
                        "nullable": not bool(not_null),
                        "default_json": json.dumps(default_value) if default_value is not None else None,
                        "system_managed": bool(primary_key) or column_name in {"created_at", "updated_at"},
                        "sync_role": "primary_key" if primary_key else "business",
                        "conflict_policy": "coordinator_required",
                        "ordinal": ordinal,
                    }
                )

            indexes = []
            for row in connection.execute(f'PRAGMA index_list("{physical_table}")'):
                _, index_name, unique_flag, origin, _ = row
                if str(index_name).startswith("sqlite_autoindex"):
                    continue
                index_columns = [
                    index_row[2]
                    for index_row in connection.execute(f'PRAGMA index_info("{index_name}")')
                ]
                indexes.append(
                    {
                        "index_id": f"{table_id}.{index_name}",
                        "physical_name": index_name,
                        "unique_flag": bool(unique_flag),
                        "columns": index_columns,
                        "origin": origin,
                    }
                )

            catalog.append(
                {
                    "table_id": table_id,
                    "physical_table": physical_table,
                    "table_kind": "attribute",
                    "sync_enabled": True,
                    "edit_policy": "coordinator_only",
                    "delete_policy": delete_policy,
                    "replication_profile": "full",
                    "reducer_policy": "coordinator_entity",
                    "dependency_order": dependency_order,
                    "fields": columns,
                    "indexes": indexes,
                }
            )
    return catalog


def packaged_business_catalog() -> list[dict[str, Any]]:
    """Build the target catalog from the packaged physical-table registry.

    The active client database may legitimately be missing a newly introduced
    table or column.  It therefore cannot be the source of truth for the next
    schema release.  A temporary database initialized from the reviewed registry
    provides the canonical target for every current and future business entity.
    """
    validate_physical_registry()
    with tempfile.TemporaryDirectory(prefix="portal-schema-") as directory:
        database = Path(directory) / "stormwater.db"
        LocalStore(database).initialize()
        return _business_catalog(database)


def _catalog_hash(catalog: list[dict[str, Any]]) -> str:
    canonical = json.dumps(catalog, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _handler_checksum(handler: str) -> str:
    """Return the checksum of the packaged handler, not a share-provided script."""
    from .migrations import handler_checksum

    return handler_checksum(handler)


def _create_registry_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS SYS_SCHEMA_RELEASES (
            release_id TEXT NOT NULL PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            catalog_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'deprecated')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS SYS_SCHEMA_TABLES (
            release_id TEXT NOT NULL,
            table_id TEXT NOT NULL,
            physical_table TEXT NOT NULL,
            table_kind TEXT NOT NULL,
            sync_enabled INTEGER NOT NULL CHECK (sync_enabled IN (0, 1)),
            edit_policy TEXT NOT NULL,
            delete_policy TEXT NOT NULL,
            replication_profile TEXT NOT NULL,
            reducer_policy TEXT NOT NULL,
            dependency_order INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            PRIMARY KEY (release_id, table_id),
            UNIQUE (release_id, physical_table),
            FOREIGN KEY (release_id) REFERENCES SYS_SCHEMA_RELEASES (release_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS SYS_SCHEMA_FIELDS (
            release_id TEXT NOT NULL,
            table_id TEXT NOT NULL,
            field_id TEXT NOT NULL,
            physical_column TEXT NOT NULL,
            logical_type TEXT NOT NULL,
            sqlite_type TEXT NOT NULL,
            nullable INTEGER NOT NULL CHECK (nullable IN (0, 1)),
            default_json TEXT,
            system_managed INTEGER NOT NULL CHECK (system_managed IN (0, 1)),
            sync_role TEXT NOT NULL,
            conflict_policy TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            PRIMARY KEY (release_id, field_id),
            UNIQUE (release_id, table_id, physical_column),
            FOREIGN KEY (release_id, table_id) REFERENCES SYS_SCHEMA_TABLES (release_id, table_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS SYS_SCHEMA_INDEXES (
            release_id TEXT NOT NULL,
            table_id TEXT NOT NULL,
            index_id TEXT NOT NULL,
            physical_name TEXT NOT NULL,
            unique_flag INTEGER NOT NULL CHECK (unique_flag IN (0, 1)),
            columns_json TEXT NOT NULL,
            origin TEXT NOT NULL,
            PRIMARY KEY (release_id, index_id),
            FOREIGN KEY (release_id, table_id) REFERENCES SYS_SCHEMA_TABLES (release_id, table_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS SYS_SCHEMA_GEOMETRY (
            release_id TEXT NOT NULL,
            table_id TEXT NOT NULL,
            geometry_column TEXT NOT NULL,
            geometry_type TEXT NOT NULL,
            srs_id INTEGER NOT NULL,
            z_enabled INTEGER NOT NULL DEFAULT 0 CHECK (z_enabled IN (0, 1)),
            m_enabled INTEGER NOT NULL DEFAULT 0 CHECK (m_enabled IN (0, 1)),
            rtree_required INTEGER NOT NULL DEFAULT 0 CHECK (rtree_required IN (0, 1)),
            PRIMARY KEY (release_id, table_id, geometry_column),
            FOREIGN KEY (release_id, table_id) REFERENCES SYS_SCHEMA_TABLES (release_id, table_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS SYS_SCHEMA_MIGRATIONS (
            migration_id TEXT NOT NULL PRIMARY KEY,
            from_release_id TEXT,
            to_release_id TEXT NOT NULL,
            migration_order INTEGER NOT NULL,
            migration_kind TEXT NOT NULL CHECK (migration_kind IN ('baseline', 'compatible', 'rebuild', 'custom')),
            handler_name TEXT NOT NULL,
            spec_json TEXT NOT NULL DEFAULT '{}',
            handler_checksum TEXT NOT NULL,
            destructive INTEGER NOT NULL DEFAULT 0 CHECK (destructive IN (0, 1)),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            UNIQUE (from_release_id, to_release_id, migration_order),
            FOREIGN KEY (to_release_id) REFERENCES SYS_SCHEMA_RELEASES (release_id) ON DELETE CASCADE
        );
        """
    )
    schema_table_columns = {
        str(row[1]) for row in connection.execute('PRAGMA table_info("SYS_SCHEMA_TABLES")')
    }
    if "resource_id" in schema_table_columns:
        connection.execute("ALTER TABLE SYS_SCHEMA_TABLES DROP COLUMN resource_id")


def _available_release_identifiers(
    connection: sqlite3.Connection,
    publication_time: datetime,
    catalog_hash: str,
    requested_release_id: str | None,
    requested_migration_id: str | None,
) -> tuple[str, str, bool]:
    release_id = requested_release_id or dated_release_id(publication_time)
    migration_id = requested_migration_id or dated_migration_id(publication_time)
    row = connection.execute(
        "SELECT catalog_hash FROM SYS_SCHEMA_RELEASES WHERE release_id = ?",
        (release_id,),
    ).fetchone()
    if row is None:
        return release_id, migration_id, False
    if row[0] == catalog_hash:
        return release_id, migration_id, True
    if requested_release_id or requested_migration_id:
        raise ValueError(
            f"Schema release {release_id} already exists with different content."
        )

    suffix = publication_time.strftime("%H%M%S")
    candidate_release = f"{release_id}-{suffix}"
    candidate_migration = f"{migration_id}_{suffix}"
    sequence = 1
    while connection.execute(
        "SELECT 1 FROM SYS_SCHEMA_RELEASES WHERE release_id = ?",
        (candidate_release,),
    ).fetchone():
        candidate_release = f"{release_id}-{suffix}-{sequence:02d}"
        candidate_migration = f"{migration_id}_{suffix}_{sequence:02d}"
        sequence += 1
    return candidate_release, candidate_migration, False


def _upsert_migration(
    connection: sqlite3.Connection,
    *,
    migration_id: str,
    from_release_id: str | None,
    to_release_id: str,
    migration_kind: str,
    handler_name: str,
    specification: dict[str, Any],
    destructive: bool = False,
) -> None:
    connection.execute(
        """
        INSERT INTO SYS_SCHEMA_MIGRATIONS (
            migration_id, from_release_id, to_release_id, migration_order,
            migration_kind, handler_name, spec_json, handler_checksum,
            destructive, active
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(migration_id) DO UPDATE SET
            from_release_id = excluded.from_release_id,
            to_release_id = excluded.to_release_id,
            migration_order = excluded.migration_order,
            migration_kind = excluded.migration_kind,
            handler_name = excluded.handler_name,
            spec_json = excluded.spec_json,
            handler_checksum = excluded.handler_checksum,
            destructive = excluded.destructive,
            active = excluded.active
        """,
        (
            migration_id,
            from_release_id,
            to_release_id,
            migration_kind,
            handler_name,
            json.dumps(specification, sort_keys=True, separators=(",", ":")),
            _handler_checksum(handler_name),
            int(destructive),
        ),
    )


def register_business_schema(
    system_database: Path,
    business_database: Path,
    *,
    release_id: str | None = None,
    migration_id: str | None = None,
    registered_at: datetime | None = None,
    catalog_override: list[dict[str, Any]] | None = None,
    migration_handler: str = PHYSICAL_SCHEMA_HANDLER,
    migration_specification: dict[str, Any] | None = None,
    migration_kind: str | None = None,
    destructive: bool = False,
) -> dict[str, Any]:
    """Register the allowlisted business schema in the system database.

    New registrations use descriptive year/day-of-year identifiers. Optional
    identifiers are retained for controlled compatibility imports and tests.
    ``business_database`` remains in the public task contract for compatibility,
    but the reviewed physical registry is the source of truth. A workstation
    therefore does not need a mutable local business replica to register a
    release for the shared repository.
    """
    publication_time = registered_at or datetime.now(timezone.utc)
    catalog = catalog_override if catalog_override is not None else packaged_business_catalog()
    catalog_hash = _catalog_hash(catalog)
    system_database = system_database.resolve()
    system_database.parent.mkdir(parents=True, exist_ok=True)

    # sqlite3 connection context managers commit or roll back, but they do not
    # close the Windows file handle.  The catalog is later reopened read-only by
    # the schema manager, so explicitly close it once registration is complete.
    with closing(sqlite3.connect(system_database)) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        _create_registry_tables(connection)
        connection.execute("BEGIN IMMEDIATE")
        previous = connection.execute(
            """
            SELECT release_id, schema_version, catalog_hash
            FROM SYS_SCHEMA_RELEASES
            WHERE status = 'active'
            ORDER BY schema_version DESC
            LIMIT 1
            """
        ).fetchone()
        if (
            release_id is None
            and migration_id is None
            and previous is not None
            and previous[2] == catalog_hash
        ):
            existing_migrations = [
                str(row[0])
                for row in connection.execute(
                    """
                    SELECT migration_id
                    FROM SYS_SCHEMA_MIGRATIONS
                    WHERE to_release_id = ? AND active = 1
                    ORDER BY migration_order, migration_id
                    """,
                    (previous[0],),
                )
            ]
            connection.commit()
            return {
                "release_id": str(previous[0]),
                "schema_version": int(previous[1]),
                "catalog_hash": catalog_hash,
                "registered_tables": [table["physical_table"] for table in catalog],
                "field_count": sum(len(table["fields"]) for table in catalog),
                "index_count": sum(len(table["indexes"]) for table in catalog),
                "migration_id": existing_migrations[-1] if existing_migrations else None,
                "migration_ids": existing_migrations,
                "previous_release_id": str(previous[0]),
                "changed": False,
            }
        active_release_id, active_migration_id, unchanged = _available_release_identifiers(
            connection,
            publication_time,
            catalog_hash,
            release_id,
            migration_id,
        )
        previous_release_id = previous[0] if previous else None
        if unchanged and previous_release_id == active_release_id:
            schema_version = int(previous[1])
        else:
            schema_version = int(previous[1]) + 1 if previous else 1
        connection.execute(
            "UPDATE SYS_SCHEMA_RELEASES SET status = 'deprecated' WHERE release_id <> ? AND status = 'active'",
            (active_release_id,),
        )
        connection.execute(
            """
            INSERT INTO SYS_SCHEMA_RELEASES (release_id, schema_version, catalog_hash, status)
            VALUES (?, ?, ?, 'active')
            ON CONFLICT(release_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                catalog_hash = excluded.catalog_hash,
                status = excluded.status,
                updated_at = CURRENT_TIMESTAMP
            """,
            (active_release_id, schema_version, catalog_hash),
        )
        connection.execute("DELETE FROM SYS_SCHEMA_INDEXES WHERE release_id = ?", (active_release_id,))
        connection.execute("DELETE FROM SYS_SCHEMA_FIELDS WHERE release_id = ?", (active_release_id,))
        connection.execute("DELETE FROM SYS_SCHEMA_TABLES WHERE release_id = ?", (active_release_id,))

        for table in catalog:
            connection.execute(
                """
                INSERT INTO SYS_SCHEMA_TABLES (
                    release_id, table_id, physical_table, table_kind, sync_enabled,
                    edit_policy, delete_policy, replication_profile, reducer_policy, dependency_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    active_release_id,
                    table["table_id"],
                    table["physical_table"],
                    table["table_kind"],
                    int(table["sync_enabled"]),
                    table["edit_policy"],
                    table["delete_policy"],
                    table["replication_profile"],
                    table["reducer_policy"],
                    table["dependency_order"],
                ),
            )
            for field in table["fields"]:
                connection.execute(
                    """
                    INSERT INTO SYS_SCHEMA_FIELDS (
                        release_id, table_id, field_id, physical_column, logical_type, sqlite_type,
                        nullable, default_json, system_managed, sync_role, conflict_policy, ordinal
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        active_release_id,
                        table["table_id"],
                        field["field_id"],
                        field["physical_column"],
                        field["logical_type"],
                        field["sqlite_type"],
                        int(field["nullable"]),
                        field["default_json"],
                        int(field["system_managed"]),
                        field["sync_role"],
                        field["conflict_policy"],
                        field["ordinal"],
                    ),
                )

            for index in table["indexes"]:
                connection.execute(
                    """
                    INSERT INTO SYS_SCHEMA_INDEXES (
                        release_id, table_id, index_id, physical_name, unique_flag, columns_json, origin
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        active_release_id,
                        table["table_id"],
                        index["index_id"],
                        index["physical_name"],
                        int(index["unique_flag"]),
                        json.dumps(index["columns"], separators=(",", ":")),
                        index["origin"],
                    ),
                )

        baseline_migration_id = (
            active_migration_id
            if previous_release_id is None
            else f"{active_migration_id}_BASELINE"
        )
        _upsert_migration(
            connection,
            migration_id=baseline_migration_id,
            from_release_id=None,
            to_release_id=active_release_id,
            migration_kind="baseline",
            handler_name=BASELINE_HANDLER,
            specification={},
        )
        migration_ids = [baseline_migration_id]
        if previous_release_id and previous_release_id != active_release_id:
            transition_kind = migration_kind or (
                "custom" if migration_handler == ALEMBIC_SCHEMA_HANDLER else "compatible"
            )
            _upsert_migration(
                connection,
                migration_id=active_migration_id,
                from_release_id=previous_release_id,
                to_release_id=active_release_id,
                migration_kind=transition_kind,
                handler_name=migration_handler,
                specification=(
                    migration_specification
                    if migration_specification is not None
                    else {"catalog_hash": catalog_hash}
                ),
                destructive=destructive,
            )
            migration_ids.append(active_migration_id)
        connection.commit()

    return {
        "release_id": active_release_id,
        "schema_version": schema_version,
        "catalog_hash": catalog_hash,
        "registered_tables": [table["physical_table"] for table in catalog],
        "field_count": sum(len(table["fields"]) for table in catalog),
        "index_count": sum(len(table["indexes"]) for table in catalog),
        "migration_id": active_migration_id,
        "migration_ids": migration_ids,
        "previous_release_id": previous_release_id,
        "changed": not unchanged,
    }


def registered_business_catalog(
    system_database: Path,
    release_id: str | None = None,
) -> dict[str, Any]:
    """Return the editable catalog representation stored in ``system.db``."""
    with closing(_readonly_connection(Path(system_database))) as connection:
        release = connection.execute(
            """
            SELECT release_id, schema_version, catalog_hash
            FROM SYS_SCHEMA_RELEASES
            WHERE release_id = COALESCE(?, release_id) AND (? IS NOT NULL OR status='active')
            ORDER BY schema_version DESC
            LIMIT 1
            """,
            (release_id, release_id),
        ).fetchone()
        if release is None:
            raise ValueError("The system schema catalog has no matching release.")
        tables = []
        for row in connection.execute(
            """
            SELECT table_id, physical_table, table_kind, sync_enabled,
                   edit_policy, delete_policy, replication_profile, reducer_policy,
                   dependency_order, active
            FROM SYS_SCHEMA_TABLES
            WHERE release_id=? AND active=1
            ORDER BY dependency_order, physical_table
            """,
            (release[0],),
        ):
            table_id = str(row[0])
            fields = [
                {
                    "field_id": field[0],
                    "physical_column": field[1],
                    "logical_type": field[2],
                    "sqlite_type": field[3],
                    "nullable": bool(field[4]),
                    "default_json": field[5],
                    "system_managed": bool(field[6]),
                    "sync_role": field[7],
                    "conflict_policy": field[8],
                    "ordinal": int(field[9]),
                }
                for field in connection.execute(
                    """
                    SELECT field_id, physical_column, logical_type, sqlite_type,
                           nullable, default_json, system_managed, sync_role,
                           conflict_policy, ordinal
                    FROM SYS_SCHEMA_FIELDS
                    WHERE release_id=? AND table_id=?
                    ORDER BY ordinal, physical_column
                    """,
                    (release[0], table_id),
                )
            ]
            indexes = [
                {
                    "index_id": index[0],
                    "physical_name": index[1],
                    "unique_flag": bool(index[2]),
                    "columns": json.loads(index[3]),
                    "origin": index[4],
                }
                for index in connection.execute(
                    """
                    SELECT index_id, physical_name, unique_flag, columns_json, origin
                    FROM SYS_SCHEMA_INDEXES
                    WHERE release_id=? AND table_id=?
                    ORDER BY physical_name
                    """,
                    (release[0], table_id),
                )
            ]
            tables.append(
                {
                    "table_id": table_id,
                    "physical_table": row[1],
                    "table_kind": row[2],
                    "sync_enabled": bool(row[3]),
                    "edit_policy": row[4],
                    "delete_policy": row[5],
                    "replication_profile": row[6],
                    "reducer_policy": row[7],
                    "dependency_order": int(row[8]),
                    "fields": fields,
                    "indexes": indexes,
                }
            )
    return {
        "release_id": str(release[0]),
        "schema_version": int(release[1]),
        "catalog_hash": str(release[2]),
        "tables": tables,
    }


def _new_table_system_fields(table_id: str) -> list[dict[str, Any]]:
    definitions = (
        ("global_id", "TEXT", False, None, "primary_key"),
        ("record_revision", "TEXT", False, None, "system"),
        ("deleted", "INTEGER", False, 0, "system"),
        ("conflict_state", "TEXT", False, "none", "system"),
        ("selected_operation_id", "TEXT", True, None, "system"),
    )
    return [
        {
            "field_id": f"{table_id}.{column}",
            "physical_column": column,
            "logical_type": _logical_type(sqlite_type),
            "sqlite_type": sqlite_type,
            "nullable": nullable,
            "default_json": json.dumps(default) if default is not None else None,
            "system_managed": True,
            "sync_role": sync_role,
            "conflict_policy": "coordinator_required",
            "ordinal": ordinal,
            "draft": True,
        }
        for ordinal, (column, sqlite_type, nullable, default, sync_role) in enumerate(definitions)
    ]


def _validate_new_physical_table(name: str) -> None:
    if not _DRAFT_PHYSICAL_TABLE.fullmatch(name):
        raise ValueError(
            "Physical table names must use uppercase business-domain words separated by underscores."
        )


def apply_schema_draft(
    catalog: list[dict[str, Any]],
    operations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Validate and overlay typed, non-destructive schema draft operations."""
    if len(operations) > 200:
        raise ValueError("A schema draft cannot contain more than 200 changes.")
    result = deepcopy(catalog)
    table_by_id = {str(table["table_id"]): table for table in result}
    physical_tables = {
        str(table["physical_table"]).lower(): str(table["table_id"])
        for table in result
    }
    dependency_orders = {
        int(table["dependency_order"]): str(table["table_id"])
        for table in result
    }
    all_index_names = {
        str(index["physical_name"]).lower()
        for table in result
        for index in table["indexes"]
    }
    for position, operation in enumerate(operations, start=1):
        if not isinstance(operation, dict):
            raise ValueError(f"Draft change {position} must be an object.")
        kind = str(operation.get("kind") or "")
        table_id = str(operation.get("table_id") or "")
        if kind == "add_table":
            physical_table = str(operation.get("physical_table") or "").strip().upper()
            try:
                dependency_order = int(operation.get("dependency_order"))
            except (TypeError, ValueError) as error:
                raise ValueError("A new table needs an integer dependency order.") from error
            if not _GENERATED_TABLE_ID.fullmatch(table_id):
                raise ValueError("A new table requires an application-generated stable identity.")
            _validate_new_physical_table(physical_table)
            if table_id in table_by_id:
                raise ValueError(f"Stable table ID already exists: {table_id}.")
            if physical_table.lower() in physical_tables:
                raise ValueError(f"Physical table already exists: {physical_table}.")
            if dependency_order < 1:
                raise ValueError("Dependency order must be greater than zero.")
            if dependency_order in dependency_orders:
                raise ValueError(
                    f"Dependency order {dependency_order} is already used by "
                    f"{dependency_orders[dependency_order]}."
                )
            table = {
                "table_id": table_id,
                "physical_table": physical_table,
                "table_kind": "attribute",
                "sync_enabled": True,
                "edit_policy": "coordinator_only",
                "delete_policy": "tombstone",
                "replication_profile": "full",
                "reducer_policy": "coordinator_entity",
                "dependency_order": dependency_order,
                "fields": _new_table_system_fields(table_id),
                "indexes": [],
                "draft": True,
            }
            result.append(table)
            table_by_id[table_id] = table
            physical_tables[physical_table.lower()] = table_id
            dependency_orders[dependency_order] = table_id
            continue

        table = table_by_id.get(table_id)
        if table is None:
            raise ValueError(f"Draft change {position} references an unknown table: {table_id}.")
        if kind == "rename_table":
            physical_table = str(operation.get("physical_table") or "").strip().upper()
            _validate_new_physical_table(physical_table)
            current_name = str(table["physical_table"])
            owner = physical_tables.get(physical_table.lower())
            if owner is not None and owner != table_id:
                raise ValueError(f"Physical table already exists: {physical_table}.")
            if table.get("renamed_from"):
                raise ValueError(f"Table {table_id} is already renamed in this draft.")
            physical_tables.pop(current_name.lower(), None)
            physical_tables[physical_table.lower()] = table_id
            table["physical_table"] = physical_table
            table["renamed_from"] = current_name
            table["draft"] = True
        elif kind == "add_column":
            column = str(operation.get("column") or "").strip()
            if not _DRAFT_IDENTIFIER.fullmatch(column):
                raise ValueError(f"Invalid SQLite field name: {column!r}.")
            if any(str(field["physical_column"]).lower() == column.lower() for field in table["fields"]):
                raise ValueError(f"Field {table['physical_table']}.{column} already exists.")
            sqlite_type = str(operation.get("sqlite_type") or "TEXT").upper()
            if sqlite_type not in _DRAFT_SQLITE_TYPES:
                raise ValueError(f"Unsupported SQLite field type: {sqlite_type}.")
            nullable = bool(operation.get("nullable", True))
            default = operation.get("default")
            if not nullable and default is None:
                raise ValueError(f"Required field {table['physical_table']}.{column} needs a default value.")
            table["fields"].append(
                {
                    "field_id": f"{table_id}.{column}",
                    "physical_column": column,
                    "logical_type": _logical_type(sqlite_type),
                    "sqlite_type": sqlite_type,
                    "nullable": nullable,
                    "default_json": json.dumps(default) if default is not None else None,
                    "system_managed": False,
                    "sync_role": "business",
                    "conflict_policy": "coordinator_required",
                    "ordinal": len(table["fields"]),
                    "draft": True,
                }
            )
        elif kind == "rename_column":
            field_id = str(operation.get("field_id") or "")
            new_column = str(operation.get("column") or "").strip()
            if not _DRAFT_IDENTIFIER.fullmatch(new_column):
                raise ValueError(f"Invalid SQLite field name: {new_column!r}.")
            field = next(
                (item for item in table["fields"] if str(item["field_id"]) == field_id),
                None,
            )
            if field is None:
                raise ValueError(f"Unknown field ID for {table_id}: {field_id}.")
            if bool(field.get("system_managed")):
                raise ValueError("System-managed fields cannot be renamed.")
            if field.get("renamed_from"):
                raise ValueError(f"Field {field_id} is already renamed in this draft.")
            if any(
                item is not field
                and str(item["physical_column"]).lower() == new_column.lower()
                for item in table["fields"]
            ):
                raise ValueError(f"Field {table['physical_table']}.{new_column} already exists.")
            old_column = str(field["physical_column"])
            field["physical_column"] = new_column
            field["renamed_from"] = old_column
            field["draft"] = True
            for index in table["indexes"]:
                index["columns"] = [
                    new_column if column == old_column else column
                    for column in index["columns"]
                ]
        elif kind == "create_index":
            index_name = str(operation.get("index") or "").strip()
            if not _DRAFT_IDENTIFIER.fullmatch(index_name):
                raise ValueError(f"Invalid SQLite index name: {index_name!r}.")
            if index_name.lower() in all_index_names:
                raise ValueError(f"Index {index_name} already exists.")
            columns = operation.get("columns")
            if not isinstance(columns, list) or not columns:
                raise ValueError(f"Index {index_name} needs at least one field.")
            available = {str(field["physical_column"]) for field in table["fields"]}
            normalized_columns = [str(column) for column in columns]
            unknown = [column for column in normalized_columns if column not in available]
            if unknown:
                raise ValueError(f"Index {index_name} references unknown fields: {', '.join(unknown)}.")
            table["indexes"].append(
                {
                    "index_id": f"{table_id}.{index_name}",
                    "physical_name": index_name,
                    "unique_flag": bool(operation.get("unique", False)),
                    "columns": normalized_columns,
                    "origin": "c",
                    "draft": True,
                }
            )
            all_index_names.add(index_name.lower())
        elif kind == "drop_index":
            index_name = str(operation.get("index") or "").strip()
            index = next(
                (
                    item
                    for item in table["indexes"]
                    if str(item["physical_name"]).lower() == index_name.lower()
                    and not item.get("removed")
                ),
                None,
            )
            if index is None:
                raise ValueError(f"Index was not found on {table['physical_table']}: {index_name}.")
            if str(index.get("origin") or "c") != "c":
                raise ValueError("SQLite-managed constraint indexes cannot be dropped directly.")
            index["draft"] = True
            index["removed"] = True
            all_index_names.discard(index_name.lower())
        else:
            raise ValueError(f"Unsupported schema draft change: {kind or '<empty>'}.")
    return result


def apply_compatible_schema_draft(
    catalog: list[dict[str, Any]],
    operations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Backward-compatible name for the typed schema draft overlay."""
    return apply_schema_draft(catalog, operations)


def prepare_schema_migration_operations(
    catalog: list[dict[str, Any]],
    operations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Resolve stable table/field IDs to ordered physical Alembic operations."""
    apply_schema_draft(catalog, operations)
    tables = deepcopy(catalog)
    table_by_id = {str(table["table_id"]): table for table in tables}
    prepared_operations: list[dict[str, Any]] = []
    for operation in operations:
        kind = str(operation["kind"])
        table_id = str(operation["table_id"])
        if kind == "add_table":
            table = {
                "table_id": table_id,
                "physical_table": str(operation["physical_table"]).strip().upper(),
                "fields": _new_table_system_fields(table_id),
                "indexes": [],
            }
            table_by_id[table_id] = table
            prepared_operations.append(
                {"kind": kind, "table": str(table["physical_table"])}
            )
            continue

        table = table_by_id[table_id]
        physical_table = str(table["physical_table"])
        if kind == "rename_table":
            new_table = str(operation["physical_table"]).strip().upper()
            prepared_operations.append(
                {"kind": kind, "old_table": physical_table, "new_table": new_table}
            )
            table["physical_table"] = new_table
        elif kind == "rename_column":
            field_id = str(operation["field_id"])
            field = next(item for item in table["fields"] if str(item["field_id"]) == field_id)
            old_column = str(field["physical_column"])
            new_column = str(operation["column"])
            prepared_operations.append(
                {
                    "kind": kind,
                    "table": physical_table,
                    "old_column": old_column,
                    "new_column": new_column,
                }
            )
            field["physical_column"] = new_column
            for index in table["indexes"]:
                index["columns"] = [
                    new_column if column == old_column else column
                    for column in index["columns"]
                ]
        else:
            prepared = dict(operation)
            prepared["table"] = physical_table
            prepared.pop("table_id", None)
            prepared_operations.append(prepared)
            if kind == "add_column":
                table["fields"].append(
                    {
                        "field_id": f"{table_id}.{operation['column']}",
                        "physical_column": str(operation["column"]),
                    }
                )
            elif kind == "create_index":
                table["indexes"].append(
                    {
                        "physical_name": str(operation["index"]),
                        "columns": list(operation["columns"]),
                    }
                )
            elif kind == "drop_index":
                table["indexes"] = [
                    index
                    for index in table["indexes"]
                    if str(index["physical_name"]) != str(operation["index"])
                ]
    return prepared_operations


def schema_draft_catalog_for_registration(
    catalog: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Remove display-only draft markers before hashing and registration."""
    result = deepcopy(catalog)
    result = [table for table in result if not table.get("removed")]
    for table in result:
        table.pop("draft", None)
        table.pop("renamed_from", None)
        table["fields"] = [field for field in table.get("fields", []) if not field.get("removed")]
        table["indexes"] = [index for index in table.get("indexes", []) if not index.get("removed")]
        for field in table["fields"]:
            field.pop("draft", None)
            field.pop("renamed_from", None)
            field.pop("removed", None)
        for index in table["indexes"]:
            index.pop("draft", None)
            index.pop("removed", None)
    return result


def ensure_compatible_schema_transition(
    system_database: Path,
    *,
    from_release_id: str,
    from_schema_version: int,
    from_catalog_hash: str,
    migration_handler: str = PHYSICAL_SCHEMA_HANDLER,
    migration_specification: dict[str, Any] | None = None,
    migration_kind: str | None = None,
    destructive: bool = False,
) -> dict[str, Any]:
    """Register the active shared release as a predecessor of the packaged release."""
    system_database = Path(system_database).resolve()
    with closing(sqlite3.connect(system_database)) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        _create_registry_tables(connection)
        target = connection.execute(
            """
            SELECT release_id, schema_version, catalog_hash
            FROM SYS_SCHEMA_RELEASES
            WHERE status='active'
            ORDER BY schema_version DESC
            LIMIT 1
            """
        ).fetchone()
        if target is None:
            raise ValueError("The system schema catalog has no active target release.")
        target_release_id = str(target[0])
        if from_release_id == target_release_id:
            return {
                "from_release_id": from_release_id,
                "to_release_id": target_release_id,
                "changed": False,
            }
        connection.execute("BEGIN IMMEDIATE")
        existing_release = connection.execute(
            "SELECT schema_version, catalog_hash FROM SYS_SCHEMA_RELEASES WHERE release_id=?",
            (from_release_id,),
        ).fetchone()
        if existing_release is None:
            connection.execute(
                """
                INSERT INTO SYS_SCHEMA_RELEASES(
                    release_id, schema_version, catalog_hash, status
                ) VALUES (?, ?, ?, 'deprecated')
                """,
                (from_release_id, int(from_schema_version), from_catalog_hash),
            )
        elif str(existing_release[1]) != from_catalog_hash:
            raise ValueError(
                f"Schema release {from_release_id} is already registered with a different catalog hash."
            )
        outgoing = connection.execute(
            """
            SELECT migration_id, to_release_id
            FROM SYS_SCHEMA_MIGRATIONS
            WHERE from_release_id=? AND active=1
            """,
            (from_release_id,),
        ).fetchall()
        if outgoing and any(str(row[1]) != target_release_id for row in outgoing):
            # The caller supplies the release that is installed in the active
            # shared snapshot. Any route from that release to another target
            # is therefore an unpublished catalog draft and may be superseded.
            # Keep it for audit history, but ensure that planning can see only
            # the newly reviewed route.
            connection.execute(
                "UPDATE SYS_SCHEMA_MIGRATIONS SET active=0 WHERE from_release_id=? AND active=1",
                (from_release_id,),
            )
            outgoing = []
        if outgoing:
            if len(outgoing) != 1:
                raise ValueError(
                    f"Schema release {from_release_id} has multiple active migration routes."
                )
            migration_id = str(outgoing[0][0])
            _upsert_migration(
                connection,
                migration_id=migration_id,
                from_release_id=from_release_id,
                to_release_id=target_release_id,
                migration_kind=migration_kind or (
                    "custom" if migration_handler == ALEMBIC_SCHEMA_HANDLER else "compatible"
                ),
                handler_name=migration_handler,
                specification=(
                    migration_specification
                    if migration_specification is not None
                    else {"catalog_hash": str(target[2])}
                ),
                destructive=destructive,
            )
            connection.commit()
            return {
                "from_release_id": from_release_id,
                "to_release_id": target_release_id,
                "migration_id": migration_id,
                "changed": False,
            }
        digest = hashlib.sha256(
            f"{from_release_id}\0{target_release_id}".encode("utf-8")
        ).hexdigest()[:12].upper()
        transition_id = f"REGISTERED_PHYSICAL_{digest}"
        _upsert_migration(
            connection,
            migration_id=transition_id,
            from_release_id=from_release_id,
            to_release_id=target_release_id,
            migration_kind=migration_kind or (
                "custom" if migration_handler == ALEMBIC_SCHEMA_HANDLER else "compatible"
            ),
            handler_name=migration_handler,
            specification=(
                migration_specification
                if migration_specification is not None
                else {"catalog_hash": str(target[2])}
            ),
            destructive=destructive,
        )
        connection.commit()
    return {
        "from_release_id": from_release_id,
        "to_release_id": target_release_id,
        "migration_id": transition_id,
        "changed": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Register Portal business tables in system.db.")
    parser.add_argument("--system-database", type=Path, required=True)
    parser.add_argument("--business-database", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(register_business_schema(args.system_database, args.business_database), indent=2))


if __name__ == "__main__":
    main()
