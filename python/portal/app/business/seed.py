from __future__ import annotations

import argparse
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path


REPORT_TABLES = (
    "RPT5W1C0_reports",
    "RPT5W1C0_pipes",
    "RPT5W1C0_distance_groups",
    "RPT5W1C0_observations",
    "RPT5W1C0_report_events",
)


def build_desktop_system_seed(source: Path, system_target: Path) -> None:
    """Create the read-only system seed without legacy mutable report tables.

    Report state now lives only in the synchronized ``stormwater.db`` entity store.
    The build must never manufacture a writable business database outside the data
    coordinator or leave the former report tables in ``system.db``.
    """
    if not source.is_file():
        raise FileNotFoundError(f"Management database seed was not found: {source}")
    system_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, system_target)

    with closing(sqlite3.connect(system_target)) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        for table_name in reversed(REPORT_TABLES):
            connection.execute(f'DROP TABLE IF EXISTS "{table_name}"')
        connection.commit()
        connection.execute("VACUUM")

    # Register the coordinator-owned entity schema from a clean local-store
    # template.  The temporary database is never shipped; real stormwater.db
    # instances are installed from the verified shared snapshot by the
    # DataCoordinator.
    catalog_database = system_target.with_suffix(".catalog.db")
    try:
        from portal.app.schema.catalog import register_business_schema
        from portal.app.sync.local_store import SCHEMA_SQL

        # This is only a disposable catalog template.  Avoid WAL mode here so
        # Windows can remove it immediately after the registry is generated.
        with closing(sqlite3.connect(catalog_database)) as connection:
            connection.executescript(SCHEMA_SQL)
            connection.execute(
                "INSERT OR IGNORE INTO sw_sync_install_state(singleton) VALUES (1)"
            )
        register_business_schema(system_target, catalog_database)
    finally:
        for artifact in (
            catalog_database,
            catalog_database.with_name(catalog_database.name + "-wal"),
            catalog_database.with_name(catalog_database.name + "-shm"),
        ):
            artifact.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the read-only Portal system database seed.")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--system", type=Path, required=True)
    args = parser.parse_args()
    build_desktop_system_seed(args.source.resolve(), args.system.resolve())


if __name__ == "__main__":
    main()
