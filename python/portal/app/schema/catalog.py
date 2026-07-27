from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any


RESOURCE_ID = "SYS"
SCHEMA_RELEASE_ID = "portal-coordinator-v1"
SCHEMA_VERSION = 1
BASELINE_MIGRATION_ID = "PORTAL_COORDINATOR_BASELINE_001"
BASELINE_HANDLER = "baseline_v1"

BUSINESS_TABLES = (
    # Business resources are materialized as synchronized entities.  Resource
    # payloads, including the CCTV report aggregate, live in ``body_json`` and
    # are only changed by DataCoordinator operations.
    ("sw_sync_entity", "sync_entity", "tombstone", 10),
)


def _readonly_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)


def _logical_type(sqlite_type: str) -> str:
    normalized = sqlite_type.upper()
    if "INT" in normalized:
        return "integer"
    if any(token in normalized for token in ("REAL", "FLOA", "DOUB", "DEC")):
        return "number"
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
                    "reducer_policy": "coordinator_entity_v1",
                    "dependency_order": dependency_order,
                    "fields": columns,
                    "indexes": indexes,
                }
            )
    return catalog


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
            resource_id TEXT NOT NULL,
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


def register_business_schema(system_database: Path, business_database: Path) -> dict[str, Any]:
    """Register the current allowlisted business schema in the packaged system database."""
    catalog = _business_catalog(business_database)
    catalog_hash = _catalog_hash(catalog)
    system_database = system_database.resolve()
    system_database.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(system_database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        _create_registry_tables(connection)
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "UPDATE SYS_SCHEMA_RELEASES SET status = 'deprecated' WHERE release_id <> ? AND status = 'active'",
            (SCHEMA_RELEASE_ID,),
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
            (SCHEMA_RELEASE_ID, SCHEMA_VERSION, catalog_hash),
        )
        connection.execute("DELETE FROM SYS_SCHEMA_INDEXES WHERE release_id = ?", (SCHEMA_RELEASE_ID,))
        connection.execute("DELETE FROM SYS_SCHEMA_FIELDS WHERE release_id = ?", (SCHEMA_RELEASE_ID,))
        connection.execute("DELETE FROM SYS_SCHEMA_TABLES WHERE release_id = ?", (SCHEMA_RELEASE_ID,))

        for table in catalog:
            connection.execute(
                """
                INSERT INTO SYS_SCHEMA_TABLES (
                    release_id, table_id, resource_id, physical_table, table_kind, sync_enabled,
                    edit_policy, delete_policy, replication_profile, reducer_policy, dependency_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    SCHEMA_RELEASE_ID,
                    table["table_id"],
                    RESOURCE_ID,
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
                        SCHEMA_RELEASE_ID,
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
                        SCHEMA_RELEASE_ID,
                        table["table_id"],
                        index["index_id"],
                        index["physical_name"],
                        int(index["unique_flag"]),
                        json.dumps(index["columns"], separators=(",", ":")),
                        index["origin"],
                    ),
                )

        connection.execute(
            """
            INSERT INTO SYS_SCHEMA_MIGRATIONS (
                migration_id, from_release_id, to_release_id, migration_order, migration_kind,
                handler_name, spec_json, handler_checksum, destructive, active
            ) VALUES (?, NULL, ?, 1, 'baseline', ?, '{}', ?, 0, 1)
            ON CONFLICT(migration_id) DO UPDATE SET
                to_release_id = excluded.to_release_id,
                migration_order = excluded.migration_order,
                migration_kind = excluded.migration_kind,
                handler_name = excluded.handler_name,
                spec_json = excluded.spec_json,
                handler_checksum = excluded.handler_checksum,
                destructive = excluded.destructive,
                active = excluded.active
            """,
            (BASELINE_MIGRATION_ID, SCHEMA_RELEASE_ID, BASELINE_HANDLER, _handler_checksum(BASELINE_HANDLER)),
        )

    return {
        "release_id": SCHEMA_RELEASE_ID,
        "schema_version": SCHEMA_VERSION,
        "catalog_hash": catalog_hash,
        "registered_tables": [table["physical_table"] for table in catalog],
        "field_count": sum(len(table["fields"]) for table in catalog),
        "index_count": sum(len(table["indexes"]) for table in catalog),
        "migration_id": BASELINE_MIGRATION_ID,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Register Portal business tables in system.db.")
    parser.add_argument("--system-database", type=Path, required=True)
    parser.add_argument("--business-database", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(register_business_schema(args.system_database, args.business_database), indent=2))


if __name__ == "__main__":
    main()
