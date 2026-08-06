"""Safe, local schema installation and migration for Portal business databases."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sqlite3
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .migrations import MigrationError, handler_checksum, run_handler


class SchemaManagerError(RuntimeError):
    """Raised for a blocked schema operation or failed validation."""


@dataclass(frozen=True)
class Migration:
    migration_id: str
    from_release_id: str | None
    to_release_id: str
    migration_order: int
    migration_kind: str
    handler_name: str
    spec_json: str
    handler_digest: str
    destructive: bool


def _utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _readonly_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)


class SchemaManager:
    """Migrate a local business database through a validated temporary copy.

    The catalog is always read-only.  The current database is only replaced after the
    candidate copy has passed SQLite integrity checks and matches the target catalog.
    """

    def __init__(self, system_database: Path, business_database: Path) -> None:
        self.system_database = Path(system_database).resolve()
        self.business_database = Path(business_database).resolve()
        self.previous_database = self.business_database.with_suffix(self.business_database.suffix + ".previous")
        self.lock_path = self.business_database.with_suffix(self.business_database.suffix + ".schema.lock")

    def initialize(self) -> dict[str, Any]:
        """Register an existing compatible database at the current baseline release."""
        self._recover_if_needed()
        release = self._active_release()
        with self._exclusive_lock(), contextlib.closing(sqlite3.connect(self.business_database)) as connection:
            self._prepare_connection(connection)
            self._create_local_state_tables(connection)
            state = self._state(connection)
            if state is None:
                self._validate_physical_schema(connection, release["release_id"])
                migration = self._baseline_for(release["release_id"])
                self._verify_handler(migration)
                self._write_state(connection, release, "healthy", None)
                self._record_history(connection, migration, None, release["release_id"], "installed", {"mode": "baseline"})
                connection.commit()
        # The database connection and schema lock must be released before status
        # opens the file again.  This matters on Windows, where an early status
        # read can keep a temporary migration candidate locked during cleanup.
        return self.status()

    def status(self) -> dict[str, Any]:
        self._recover_if_needed()
        if not self.business_database.is_file():
            return {
                "database": str(self.business_database),
                "state": "missing",
                "installed_release_id": None,
                "rollback_available": self.previous_database.is_file(),
            }
        with contextlib.closing(sqlite3.connect(self.business_database)) as connection:
            self._prepare_connection(connection)
            self._create_local_state_tables(connection)
            state = self._state(connection)
        return {
            "database": str(self.business_database),
            "state": "unmanaged" if state is None else state["state"],
            "rollback_available": self.previous_database.is_file(),
            **(state or {}),
        }

    def validate(self, target_release_id: str | None = None) -> dict[str, Any]:
        self._recover_if_needed()
        target = self._release(target_release_id) if target_release_id else self._active_release()
        with contextlib.closing(sqlite3.connect(self.business_database)) as connection:
            self._prepare_connection(connection)
            self._create_local_state_tables(connection)
            state = self._state(connection)
            checks = self._validate_physical_schema(connection, target["release_id"])
            state_release = state["installed_release_id"] if state else None
            valid = state_release == target["release_id"]
            diagnostic = None if valid else f"Installed release is {state_release or 'unmanaged'}, expected {target['release_id']}."
            if state is not None:
                self._write_state(connection, target if valid else self._release(state_release), "healthy" if valid else "needs_migration", diagnostic)
            connection.commit()
        return {"valid": valid, "target_release_id": target["release_id"], "installed_release_id": state_release, "checks": checks, "diagnostic": diagnostic}

    def plan(self, target_release_id: str | None = None) -> dict[str, Any]:
        target = self._release(target_release_id) if target_release_id else self._active_release()
        current = self.status().get("installed_release_id")
        migrations = self._migration_path(current, target["release_id"])
        return {
            "from_release_id": current,
            "to_release_id": target["release_id"],
            "migrations": [migration.__dict__ for migration in migrations],
        }

    def migrate(self, target_release_id: str | None = None) -> dict[str, Any]:
        self._recover_if_needed()
        target = self._release(target_release_id) if target_release_id else self._active_release()
        plan = self.plan(target["release_id"])
        if not plan["migrations"]:
            return self.validate(target["release_id"])

        with self._exclusive_lock():
            candidate = self._copy_to_candidate()
            try:
                with contextlib.closing(sqlite3.connect(candidate)) as connection:
                    self._prepare_connection(connection)
                    self._create_local_state_tables(connection)
                    current = self._state(connection)
                    from_release = current["installed_release_id"] if current else None
                    for migration in self._migration_path(from_release, target["release_id"]):
                        self._verify_handler(migration)
                        started = _utc_now()
                        try:
                            connection.execute("BEGIN IMMEDIATE")
                            run_handler(migration.handler_name, connection, migration.spec_json)
                            release = self._release(migration.to_release_id)
                            self._validate_physical_schema(connection, release["release_id"])
                            self._write_state(connection, release, "healthy", None)
                            self._record_history(connection, migration, migration.from_release_id, migration.to_release_id, "applied", {"started_at": started})
                            connection.commit()
                        except Exception as error:
                            connection.rollback()
                            self._record_history(connection, migration, migration.from_release_id, migration.to_release_id, "failed", {"started_at": started, "error": str(error)})
                            connection.commit()
                            raise
                self._atomic_replace(candidate)
            except Exception:
                candidate.unlink(missing_ok=True)
                raise
        return self.validate(target["release_id"])

    def rollback(self) -> dict[str, Any]:
        """Restore the one local pre-migration backup retained beside the live database."""
        with self._exclusive_lock():
            if not self.previous_database.is_file():
                raise SchemaManagerError("No previous business database is available for rollback.")
            failed = self.business_database.with_suffix(self.business_database.suffix + ".failed")
            if failed.exists():
                failed.unlink()
            os.replace(self.business_database, failed)
            os.replace(self.previous_database, self.business_database)
        return self.status()

    def _active_release(self) -> dict[str, Any]:
        with contextlib.closing(_readonly_connection(self.system_database)) as connection:
            row = connection.execute(
                "SELECT release_id, schema_version, catalog_hash FROM SYS_SCHEMA_RELEASES WHERE status = 'active' ORDER BY schema_version DESC LIMIT 1"
            ).fetchone()
        if row is None:
            raise SchemaManagerError("The system schema catalog has no active release.")
        return {"release_id": row[0], "schema_version": row[1], "catalog_hash": row[2]}

    def _release(self, release_id: str | None) -> dict[str, Any]:
        if release_id is None:
            raise SchemaManagerError("A target schema release is required.")
        with contextlib.closing(_readonly_connection(self.system_database)) as connection:
            row = connection.execute(
                "SELECT release_id, schema_version, catalog_hash FROM SYS_SCHEMA_RELEASES WHERE release_id = ?", (release_id,)
            ).fetchone()
        if row is None:
            raise SchemaManagerError(f"Schema release was not found: {release_id}")
        return {"release_id": row[0], "schema_version": row[1], "catalog_hash": row[2]}

    def _baseline_for(self, release_id: str) -> Migration:
        migrations = self._migrations("from_release_id IS NULL AND to_release_id = ?", (release_id,))
        if len(migrations) != 1:
            raise SchemaManagerError(f"Release {release_id} must have exactly one baseline migration.")
        return migrations[0]

    def _migration_path(self, from_release_id: str | None, target_release_id: str) -> list[Migration]:
        if from_release_id == target_release_id:
            return []
        if from_release_id is None:
            return [self._baseline_for(target_release_id)]
        path: list[Migration] = []
        seen = {from_release_id}
        current = from_release_id
        while current != target_release_id:
            options = self._migrations("from_release_id = ?", (current,))
            if len(options) != 1:
                raise SchemaManagerError(f"No unambiguous migration path from {current} to {target_release_id}.")
            migration = options[0]
            if migration.to_release_id in seen:
                raise SchemaManagerError("A cycle exists in the schema migration catalog.")
            path.append(migration)
            seen.add(migration.to_release_id)
            current = migration.to_release_id
        return path

    def _migrations(self, where: str, values: tuple[Any, ...]) -> list[Migration]:
        with contextlib.closing(_readonly_connection(self.system_database)) as connection:
            rows = connection.execute(
                "SELECT migration_id, from_release_id, to_release_id, migration_order, migration_kind, handler_name, spec_json, handler_checksum, destructive "
                f"FROM SYS_SCHEMA_MIGRATIONS WHERE active = 1 AND {where} ORDER BY migration_order, migration_id",
                values,
            ).fetchall()
        return [Migration(*row[:-1], destructive=bool(row[-1])) for row in rows]

    def _verify_handler(self, migration: Migration) -> None:
        actual = handler_checksum(migration.handler_name)
        if actual != migration.handler_digest:
            raise SchemaManagerError(f"Migration handler checksum does not match catalog: {migration.migration_id}")

    def _prepare_connection(self, connection: sqlite3.Connection) -> None:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("PRAGMA busy_timeout=5000")

    def _create_local_state_tables(self, connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS SW_SCHEMA_INSTALL_STATE (
                singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
                installed_release_id TEXT NOT NULL,
                installed_schema_version INTEGER NOT NULL,
                catalog_hash TEXT NOT NULL,
                physical_fingerprint TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('healthy', 'needs_migration', 'migration_failed')),
                diagnostic TEXT,
                last_validated_at TEXT NOT NULL,
                last_migrated_at TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS SW_SCHEMA_MIGRATION_HISTORY (
                history_id TEXT NOT NULL PRIMARY KEY,
                migration_id TEXT NOT NULL,
                from_release_id TEXT,
                to_release_id TEXT NOT NULL,
                handler_name TEXT NOT NULL,
                handler_checksum TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('installed', 'applied', 'failed')),
                details_json TEXT NOT NULL,
                recorded_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS IX_SW_SCHEMA_MIGRATION_HISTORY_RECORDED
                ON SW_SCHEMA_MIGRATION_HISTORY (recorded_at DESC);
            """
        )

    def _state(self, connection: sqlite3.Connection) -> dict[str, Any] | None:
        row = connection.execute(
            "SELECT installed_release_id, installed_schema_version, catalog_hash, physical_fingerprint, state, diagnostic, last_validated_at, last_migrated_at, updated_at FROM SW_SCHEMA_INSTALL_STATE WHERE singleton = 1"
        ).fetchone()
        if row is None:
            return None
        keys = ("installed_release_id", "installed_schema_version", "catalog_hash", "physical_fingerprint", "state", "diagnostic", "last_validated_at", "last_migrated_at", "updated_at")
        return dict(zip(keys, row, strict=True))

    def _write_state(self, connection: sqlite3.Connection, release: dict[str, Any], state: str, diagnostic: str | None) -> None:
        fingerprint = self._physical_fingerprint(connection, release["release_id"])
        now = _utc_now()
        connection.execute(
            """
            INSERT INTO SW_SCHEMA_INSTALL_STATE (
                singleton, installed_release_id, installed_schema_version, catalog_hash, physical_fingerprint,
                state, diagnostic, last_validated_at, last_migrated_at, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
                installed_release_id = excluded.installed_release_id,
                installed_schema_version = excluded.installed_schema_version,
                catalog_hash = excluded.catalog_hash,
                physical_fingerprint = excluded.physical_fingerprint,
                state = excluded.state,
                diagnostic = excluded.diagnostic,
                last_validated_at = excluded.last_validated_at,
                last_migrated_at = excluded.last_migrated_at,
                updated_at = excluded.updated_at
            """,
            (release["release_id"], release["schema_version"], release["catalog_hash"], fingerprint, state, diagnostic, now, now if state == "healthy" else None, now),
        )

    def _record_history(self, connection: sqlite3.Connection, migration: Migration, from_release_id: str | None, to_release_id: str, status: str, details: dict[str, Any]) -> None:
        connection.execute(
            "INSERT INTO SW_SCHEMA_MIGRATION_HISTORY (history_id, migration_id, from_release_id, to_release_id, handler_name, handler_checksum, status, details_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), migration.migration_id, from_release_id, to_release_id, migration.handler_name, migration.handler_digest, status, json.dumps(details, sort_keys=True), _utc_now()),
        )

    def _validate_physical_schema(self, connection: sqlite3.Connection, release_id: str) -> dict[str, Any]:
        quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
        if quick_check != "ok":
            raise SchemaManagerError(f"SQLite quick_check failed: {quick_check}")
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_keys:
            raise SchemaManagerError(f"SQLite foreign key check failed for {len(foreign_keys)} row(s).")
        with contextlib.closing(_readonly_connection(self.system_database)) as catalog:
            expected_tables = catalog.execute(
                "SELECT table_id, physical_table FROM SYS_SCHEMA_TABLES WHERE release_id = ? AND active = 1 ORDER BY dependency_order", (release_id,)
            ).fetchall()
            expected_fields = catalog.execute(
                "SELECT table_id, physical_column, sqlite_type, nullable FROM SYS_SCHEMA_FIELDS WHERE release_id = ?", (release_id,)
            ).fetchall()
            expected_indexes = catalog.execute(
                "SELECT table_id, physical_name FROM SYS_SCHEMA_INDEXES WHERE release_id = ?", (release_id,)
            ).fetchall()
        table_map = dict(expected_tables)
        available = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        missing = sorted(set(table_map.values()) - available)
        if missing:
            raise SchemaManagerError(f"Business database is missing registered tables: {', '.join(missing)}")
        for table_id, column_name, sqlite_type, nullable in expected_fields:
            physical_table = table_map[table_id]
            columns = {row[1]: row for row in connection.execute(f'PRAGMA table_info("{physical_table}")')}
            actual = columns.get(column_name)
            if actual is None:
                raise SchemaManagerError(f"Missing required field {physical_table}.{column_name}.")
            actual_type = (actual[2] or "TEXT").upper()
            expected_not_null = not bool(nullable)
            if actual_type != sqlite_type.upper() or bool(actual[3]) != expected_not_null:
                raise SchemaManagerError(f"Field definition mismatch for {physical_table}.{column_name}.")
        for table_id, index_name in expected_indexes:
            physical_table = table_map[table_id]
            indexes = {row[1] for row in connection.execute(f'PRAGMA index_list("{physical_table}")')}
            if index_name not in indexes:
                raise SchemaManagerError(f"Missing required index {physical_table}.{index_name}.")
        from portal.app.sync.physical_entities import registered_generic_entity_count

        registered_generic_rows = registered_generic_entity_count(connection)
        if registered_generic_rows:
            raise SchemaManagerError(
                f"Business database still has {registered_generic_rows} registered row(s) in generic JSON storage."
            )
        return {
            "quick_check": quick_check,
            "foreign_key_errors": 0,
            "tables": len(expected_tables),
            "fields": len(expected_fields),
            "indexes": len(expected_indexes),
            "registered_generic_rows": 0,
        }

    def _physical_fingerprint(self, connection: sqlite3.Connection, release_id: str) -> str:
        with contextlib.closing(_readonly_connection(self.system_database)) as catalog:
            tables = [row[0] for row in catalog.execute("SELECT physical_table FROM SYS_SCHEMA_TABLES WHERE release_id = ? AND active = 1 ORDER BY dependency_order", (release_id,))]
        entries = []
        for table in tables:
            sql = connection.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
            indexes = connection.execute("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name", (table,)).fetchall()
            entries.append(
                {
                    "table": table,
                    "sql": sql[0] if sql else None,
                    "indexes": [tuple(index) for index in indexes],
                }
            )
        return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    def _copy_to_candidate(self) -> Path:
        candidate = self.business_database.with_name(f"{self.business_database.name}.{uuid.uuid4().hex}.migrating")
        with contextlib.closing(sqlite3.connect(self.business_database)) as source, contextlib.closing(sqlite3.connect(candidate)) as target:
            source.backup(target)
        return candidate

    def _atomic_replace(self, candidate: Path) -> None:
        if self.previous_database.exists():
            self.previous_database.unlink()
        os.replace(self.business_database, self.previous_database)
        try:
            os.replace(candidate, self.business_database)
        except Exception:
            os.replace(self.previous_database, self.business_database)
            raise

    def _recover_if_needed(self) -> None:
        if not self.business_database.exists() and self.previous_database.exists():
            os.replace(self.previous_database, self.business_database)

    @contextlib.contextmanager
    def _exclusive_lock(self) -> Iterator[None]:
        self.business_database.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError as error:
            raise SchemaManagerError(f"Another schema operation is already running: {self.lock_path}") from error
        try:
            os.write(descriptor, f"pid={os.getpid()} created_at={_utc_now()}\n".encode("utf-8"))
            yield
        finally:
            os.close(descriptor)
            self.lock_path.unlink(missing_ok=True)
