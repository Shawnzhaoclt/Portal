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


def baseline_v1(connection: sqlite3.Connection, specification: dict[str, Any]) -> None:
    """Record that a pre-existing v1 database is now under schema management."""
    if specification:
        raise MigrationError("The v1 baseline migration does not accept a specification.")


def compatible_sqlite_v1(connection: sqlite3.Connection, specification: dict[str, Any]) -> None:
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
    "baseline_v1": baseline_v1,
    "compatible_sqlite_v1": compatible_sqlite_v1,
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
