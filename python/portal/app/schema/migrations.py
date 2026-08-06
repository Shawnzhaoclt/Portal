"""Trusted, packaged schema migrations for the Portal business database.

Migration definitions in ``system.db`` name a handler from this module.  They never
contain arbitrary SQL that may be executed from a network share.  Straightforward
compatible changes may use the tightly validated declarative operations below;
rebuilds, drops, and GeoPackage changes require an explicitly registered handler.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections.abc import Callable
from typing import Any


class MigrationError(RuntimeError):
    """Raised when a registered schema migration cannot safely be applied."""


MigrationHandler = Callable[[sqlite3.Connection, dict[str, Any]], None]
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SQLITE_TYPES = {"TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC"}


def _quoted_identifier(name: str) -> str:
    if not _IDENTIFIER.fullmatch(name):
        raise MigrationError(f"Unsupported SQLite identifier: {name!r}")
    return f'"{name}"'


def baseline(connection: sqlite3.Connection, specification: dict[str, Any]) -> None:
    """Record that an existing database is now under schema management."""
    if specification:
        raise MigrationError("The baseline migration does not accept a specification.")


def registered_physical_schema(
    connection: sqlite3.Connection,
    specification: dict[str, Any],
) -> None:
    """Reconcile every registered business entity with typed physical storage."""
    unknown = set(specification) - {"catalog_hash"}
    if unknown:
        raise MigrationError(
            "The registered physical schema handler received unsupported settings: "
            + ", ".join(sorted(unknown))
        )
    from portal.app.sync.physical_entities import (
        initialize_physical_schema,
        validate_physical_registry,
    )

    validate_physical_registry()
    initialize_physical_schema(connection)


def compatible_sqlite(connection: sqlite3.Connection, specification: dict[str, Any]) -> None:
    """Apply a narrow, validated subset of additive SQLite changes.

    Supported operations are intentionally limited to ``add_column`` and
    ``create_index``.  Destructive changes must use a dedicated trusted handler so
    the required data transformation is reviewable in source control.
    """
    operations = specification.get("operations")
    if not isinstance(operations, list):
        raise MigrationError("Compatible migrations require an operations list.")

    for operation in operations:
        if not isinstance(operation, dict):
            raise MigrationError("Migration operations must be objects.")
        kind = operation.get("kind")
        table = _quoted_identifier(str(operation.get("table", "")))
        if kind == "add_column":
            column = _quoted_identifier(str(operation.get("column", "")))
            sqlite_type = str(operation.get("sqlite_type", "TEXT")).upper()
            if sqlite_type not in _SQLITE_TYPES:
                raise MigrationError(f"Unsupported SQLite column type: {sqlite_type!r}")
            nullable = bool(operation.get("nullable", True))
            default = operation.get("default")
            clause = f"ALTER TABLE {table} ADD COLUMN {column} {sqlite_type}"
            if not nullable:
                if default is None:
                    raise MigrationError("A non-null added column needs a default value.")
                clause += " NOT NULL"
            if default is not None:
                clause += " DEFAULT " + _literal(default)
            existing = {
                row[1] for row in connection.execute(f"PRAGMA table_info({table})")
            }
            if operation["column"] not in existing:
                connection.execute(clause)
        elif kind == "create_index":
            index_name = _quoted_identifier(str(operation.get("index", "")))
            columns = operation.get("columns")
            if not isinstance(columns, list) or not columns:
                raise MigrationError("An index operation needs at least one column.")
            quoted_columns = ", ".join(_quoted_identifier(str(column)) for column in columns)
            unique = "UNIQUE " if bool(operation.get("unique", False)) else ""
            connection.execute(f"CREATE {unique}INDEX IF NOT EXISTS {index_name} ON {table} ({quoted_columns})")
        else:
            raise MigrationError(f"Unsupported compatible migration operation: {kind!r}")


def _identifier(name: object) -> str:
    value = str(name or "")
    if not _IDENTIFIER.fullmatch(value):
        raise MigrationError(f"Unsupported SQLite identifier: {value!r}")
    return value


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? COLLATE NOCASE",
        (table,),
    ).fetchone() is not None


def _column_names(connection: sqlite3.Connection, table: str) -> set[str]:
    quoted = _quoted_identifier(table)
    return {str(row[1]).lower() for row in connection.execute(f"PRAGMA table_info({quoted})")}


def _index_names(connection: sqlite3.Connection, table: str) -> set[str]:
    quoted = _quoted_identifier(table)
    return {str(row[1]).lower() for row in connection.execute(f"PRAGMA index_list({quoted})")}


def alembic_structural(
    connection: sqlite3.Connection,
    specification: dict[str, Any],
) -> None:
    """Apply reviewed structural operations through Alembic on Portal's copy."""
    unknown = set(specification) - {"operations"}
    if unknown:
        raise MigrationError(
            "The Alembic schema handler received unsupported settings: "
            + ", ".join(sorted(unknown))
        )
    operations = specification.get("operations")
    if not isinstance(operations, list) or not operations:
        raise MigrationError("Alembic structural migrations require an operations list.")

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import Column, create_engine, text as sql_text
    from sqlalchemy.pool import NullPool
    from sqlalchemy.types import BLOB, INTEGER, NUMERIC, REAL, TEXT

    type_by_name = {
        "TEXT": TEXT,
        "INTEGER": INTEGER,
        "REAL": REAL,
        "BLOB": BLOB,
        "NUMERIC": NUMERIC,
    }

    class _PortalSQLiteConnection:
        """Let SQLAlchemy issue DDL without owning Portal's sqlite3 transaction."""

        def __init__(self, raw_connection: sqlite3.Connection) -> None:
            self._raw_connection = raw_connection

        def __getattr__(self, name: str) -> Any:
            return getattr(self._raw_connection, name)

        def commit(self) -> None:
            pass

        def rollback(self) -> None:
            pass

        def close(self) -> None:
            pass

    engine = create_engine(
        "sqlite://",
        creator=lambda: _PortalSQLiteConnection(connection),
        poolclass=NullPool,
    )
    sqlalchemy_connection = engine.connect()
    alembic = Operations(MigrationContext.configure(sqlalchemy_connection))
    try:
        for operation in operations:
            if not isinstance(operation, dict):
                raise MigrationError("Alembic migration operations must be objects.")
            kind = str(operation.get("kind") or "")
            if kind == "add_table":
                table = _identifier(operation.get("table"))
                if _table_exists(connection, table):
                    continue
                alembic.create_table(
                    table,
                    Column("global_id", TEXT(), primary_key=True, nullable=False),
                    Column("record_revision", TEXT(), nullable=False),
                    Column("deleted", INTEGER(), nullable=False, server_default=sql_text("0")),
                    Column(
                        "conflict_state",
                        TEXT(),
                        nullable=False,
                        server_default=sql_text("'none'"),
                    ),
                    Column("selected_operation_id", TEXT(), nullable=True),
                )
            elif kind == "rename_table":
                old_table = _identifier(operation.get("old_table"))
                new_table = _identifier(operation.get("new_table"))
                old_exists = _table_exists(connection, old_table)
                new_exists = _table_exists(connection, new_table)
                if not old_exists and new_exists:
                    continue
                if not old_exists:
                    raise MigrationError(f"Table to rename was not found: {old_table}.")
                if new_exists:
                    raise MigrationError(f"Rename target already exists: {new_table}.")
                alembic.rename_table(old_table, new_table)
            elif kind == "add_column":
                table = _identifier(operation.get("table"))
                column = _identifier(operation.get("column"))
                if not _table_exists(connection, table):
                    raise MigrationError(f"Table was not found: {table}.")
                if column.lower() in _column_names(connection, table):
                    continue
                sqlite_type = str(operation.get("sqlite_type") or "TEXT").upper()
                type_factory = type_by_name.get(sqlite_type)
                if type_factory is None:
                    raise MigrationError(f"Unsupported SQLite column type: {sqlite_type!r}")
                nullable = bool(operation.get("nullable", True))
                default = operation.get("default")
                if not nullable and default is None:
                    raise MigrationError("A non-null added column needs a default value.")
                alembic.add_column(
                    table,
                    Column(
                        column,
                        type_factory(),
                        nullable=nullable,
                        server_default=(
                            sql_text(_literal(default)) if default is not None else None
                        ),
                    ),
                )
            elif kind == "rename_column":
                table = _identifier(operation.get("table"))
                old_column = _identifier(operation.get("old_column"))
                new_column = _identifier(operation.get("new_column"))
                if not _table_exists(connection, table):
                    raise MigrationError(f"Table was not found: {table}.")
                columns = _column_names(connection, table)
                if old_column.lower() not in columns and new_column.lower() in columns:
                    continue
                if old_column.lower() not in columns:
                    raise MigrationError(
                        f"Field to rename was not found: {table}.{old_column}."
                    )
                if new_column.lower() in columns:
                    raise MigrationError(
                        f"Rename target already exists: {table}.{new_column}."
                    )
                alembic.alter_column(
                    table,
                    old_column,
                    new_column_name=new_column,
                )
            elif kind == "create_index":
                table = _identifier(operation.get("table"))
                index = _identifier(operation.get("index"))
                columns = operation.get("columns")
                if not isinstance(columns, list) or not columns:
                    raise MigrationError("An index operation needs at least one column.")
                normalized_columns = [_identifier(column) for column in columns]
                if not _table_exists(connection, table):
                    raise MigrationError(f"Table was not found: {table}.")
                if index.lower() in _index_names(connection, table):
                    continue
                available_columns = _column_names(connection, table)
                missing_columns = [
                    column for column in normalized_columns
                    if column.lower() not in available_columns
                ]
                if missing_columns:
                    raise MigrationError(
                        f"Index {index} references missing fields: {', '.join(missing_columns)}."
                    )
                alembic.create_index(
                    index,
                    table,
                    normalized_columns,
                    unique=bool(operation.get("unique", False)),
                )
            elif kind == "drop_index":
                table = _identifier(operation.get("table"))
                index = _identifier(operation.get("index"))
                if not _table_exists(connection, table):
                    raise MigrationError(f"Table was not found: {table}.")
                if index.lower() not in _index_names(connection, table):
                    continue
                alembic.drop_index(index, table_name=table)
            else:
                raise MigrationError(f"Unsupported Alembic migration operation: {kind!r}")
    finally:
        sqlalchemy_connection.close()
        engine.dispose()


def _literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    raise MigrationError(f"Unsupported SQLite default value: {value!r}")


HANDLERS: dict[str, MigrationHandler] = {
    "baseline": baseline,
    "alembic_structural": alembic_structural,
    "compatible_sqlite": compatible_sqlite,
    "registered_physical_schema": registered_physical_schema,
    # Legacy names remain readable for already-published catalogs. They are
    # never emitted by new catalog or migration metadata.
    "baseline_v1": baseline,
    "compatible_sqlite_v1": compatible_sqlite,
}


def handler_checksum(name: str) -> str:
    handler = HANDLERS.get(name)
    if handler is None:
        raise MigrationError(f"Unknown packaged migration handler: {name!r}")
    code = handler.__code__.co_code
    canonical = b"portal-schema-handler-v1\x00" + name.encode("utf-8") + b"\x00" + code
    return hashlib.sha256(canonical).hexdigest()


def run_handler(name: str, connection: sqlite3.Connection, spec_json: str) -> None:
    handler = HANDLERS.get(name)
    if handler is None:
        raise MigrationError(f"Unknown packaged migration handler: {name!r}")
    try:
        specification = json.loads(spec_json or "{}")
    except json.JSONDecodeError as error:
        raise MigrationError(f"Invalid migration specification: {error}") from error
    if not isinstance(specification, dict):
        raise MigrationError("Migration specification must be a JSON object.")
    handler(connection, specification)
