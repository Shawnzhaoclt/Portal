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

from portal.app.schema.sqlite_types import normalize_sqlite_declared_type


class MigrationError(RuntimeError):
    """Raised when a registered schema migration cannot safely be applied."""


MigrationHandler = Callable[[sqlite3.Connection, dict[str, Any]], None]
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


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
            try:
                sqlite_type = normalize_sqlite_declared_type(
                    operation.get("sqlite_type", "TEXT")
                )
            except ValueError as error:
                raise MigrationError(str(error)) from error
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
    from sqlalchemy.types import INTEGER, TEXT, UserDefinedType

    class _SQLiteDeclaredType(UserDefinedType):
        """Compile an allowlisted type name exactly as selected in Manager."""

        cache_ok = True

        def __init__(self, declared_type: str) -> None:
            self.declared_type = declared_type

        def get_col_spec(self, **_kwargs: Any) -> str:
            return self.declared_type

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
                try:
                    sqlite_type = normalize_sqlite_declared_type(
                        operation.get("sqlite_type")
                    )
                except ValueError as error:
                    raise MigrationError(str(error)) from error
                nullable = bool(operation.get("nullable", True))
                default = operation.get("default")
                if not nullable and default is None:
                    raise MigrationError("A non-null added column needs a default value.")
                alembic.add_column(
                    table,
                    Column(
                        column,
                        _SQLiteDeclaredType(sqlite_type),
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


def _split_top_level_definitions(body: str) -> list[str]:
    """Split a CREATE TABLE body into its comma-separated top-level definitions."""
    definitions: list[str] = []
    depth = 0
    quote: str | None = None
    current: list[str] = []
    index = 0
    while index < len(body):
        character = body[index]
        if quote is not None:
            current.append(character)
            if character == quote:
                # Doubled quote characters escape themselves inside an identifier
                # or string literal and must not close the quoted region.
                if index + 1 < len(body) and body[index + 1] == quote:
                    current.append(body[index + 1])
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if character in "\"'`":
            quote = character
            current.append(character)
        elif character == "[":
            quote = "]"
            current.append(character)
        elif character == "(":
            depth += 1
            current.append(character)
        elif character == ")":
            depth -= 1
            current.append(character)
        elif character == "," and depth == 0:
            definitions.append("".join(current))
            current = []
        else:
            current.append(character)
        index += 1
    if "".join(current).strip():
        definitions.append("".join(current))
    return definitions


def _split_definition_name(definition: str) -> tuple[str, str, str] | None:
    """Split a column definition into its leading space, name token, and remainder."""
    text = definition.strip()
    if not text:
        return None
    leading = definition[: len(definition) - len(definition.lstrip())]
    if text[0] in "\"'`[":
        closing = "]" if text[0] == "[" else text[0]
        end = text.find(closing, 1)
        if end == -1:
            return None
        return leading, text[: end + 1], text[end + 1 :].strip()
    name_token = text.split(None, 1)[0]
    return leading, name_token, text[len(name_token) :].strip()


def _definition_column_name(definition: str) -> str | None:
    """Return the column name a table definition declares, or None for constraints."""
    parts = _split_definition_name(definition)
    if parts is None:
        return None
    _leading, name_text, _remainder = parts
    if name_text[0] in "\"'`[":
        return name_text[1:-1]
    if name_text.upper() in {"CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"}:
        return None
    return name_text


def _retyped_table_sql(
    create_sql: str,
    table: str,
    column: str,
    sqlite_type: str,
    rebuild_table: str,
) -> tuple[str, bool]:
    """Rewrite a CREATE TABLE statement so one column declares a new type.

    Only the named column's declared type is replaced.  Every other constraint in
    the original statement is preserved verbatim so a rebuild cannot silently drop
    a CHECK, UNIQUE, or FOREIGN KEY clause.
    """
    open_paren = create_sql.find("(")
    close_paren = create_sql.rfind(")")
    if open_paren == -1 or close_paren <= open_paren:
        raise MigrationError(f"Could not parse the CREATE TABLE statement for {table}.")
    body = create_sql[open_paren + 1 : close_paren]
    definitions = _split_top_level_definitions(body)

    matched = False
    already_correct = False
    rewritten: list[str] = []
    for definition in definitions:
        if _definition_column_name(definition) != column:
            rewritten.append(definition)
            continue
        if matched:
            raise MigrationError(f"Column {table}.{column} is declared more than once.")
        matched = True
        parts = _split_definition_name(definition)
        if parts is None:
            raise MigrationError(f"Could not parse the definition of {table}.{column}.")
        leading, name_text, remainder = parts
        # The declared type is the token run before the first column constraint.
        constraint_start = re.search(
            r"\b(PRIMARY|NOT|NULL|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|GENERATED|AS)\b",
            remainder,
            re.IGNORECASE,
        )
        constraints = remainder[constraint_start.start():] if constraint_start else ""
        existing_type = (remainder[: constraint_start.start()] if constraint_start else remainder).strip()
        if existing_type.upper() == sqlite_type.upper():
            already_correct = True
        rewritten.append(
            f"{leading}{name_text} {sqlite_type}" + (f" {constraints}" if constraints else "")
        )

    if not matched:
        raise MigrationError(f"Column to retype was not found: {table}.{column}.")

    header = f'CREATE TABLE "{rebuild_table}" ('
    return header + ",".join(rewritten) + ")", already_correct


def rebuild_table_columns(
    connection: sqlite3.Connection,
    specification: dict[str, Any],
) -> None:
    """Retype registered columns by rebuilding their table in place.

    SQLite cannot change a column's declared type with ALTER TABLE, so a registered
    type change is applied with the documented rebuild procedure: create a replacement
    table from the original statement with only the target column's type changed, copy
    every row through an explicit CAST, then swap the tables and restore the indexes.
    The original CHECK, UNIQUE, and FOREIGN KEY clauses are carried over untouched.
    """
    unknown = set(specification) - {"operations"}
    if unknown:
        raise MigrationError(
            "The table rebuild handler received unsupported settings: "
            + ", ".join(sorted(unknown))
        )
    operations = specification.get("operations")
    if not isinstance(operations, list) or not operations:
        raise MigrationError("Table rebuild migrations require an operations list.")

    # Foreign keys cannot be disabled inside the migration transaction, so defer
    # their enforcement to commit while the replacement table is swapped in.
    connection.execute("PRAGMA defer_foreign_keys=ON")

    for operation in operations:
        if not isinstance(operation, dict):
            raise MigrationError("Table rebuild operations must be objects.")
        kind = str(operation.get("kind") or "")
        if kind != "retype_column":
            raise MigrationError(f"Unsupported table rebuild operation: {kind!r}")
        table = _identifier(operation.get("table"))
        column = _identifier(operation.get("column"))
        try:
            sqlite_type = normalize_sqlite_declared_type(operation.get("sqlite_type"))
        except ValueError as error:
            raise MigrationError(str(error)) from error
        if not _table_exists(connection, table):
            raise MigrationError(f"Table was not found: {table}.")
        if column.lower() not in _column_names(connection, table):
            raise MigrationError(f"Column to retype was not found: {table}.{column}.")

        row = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=? COLLATE NOCASE",
            (table,),
        ).fetchone()
        create_sql = str(row[0] or "") if row is not None else ""
        if not create_sql:
            raise MigrationError(f"Could not read the CREATE TABLE statement for {table}.")

        rebuild_table = f"{table}__portal_rebuild"
        if _table_exists(connection, rebuild_table):
            raise MigrationError(f"A previous rebuild left {rebuild_table} behind.")
        rebuild_sql, already_correct = _retyped_table_sql(
            create_sql, table, column, sqlite_type, rebuild_table
        )
        if already_correct:
            continue

        column_order = [str(item[1]) for item in connection.execute(
            f"PRAGMA table_info({_quoted_identifier(table)})"
        )]
        indexes = [
            str(index_row[0])
            for index_row in connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? COLLATE NOCASE "
                "AND sql IS NOT NULL",
                (table,),
            )
        ]

        selected = ", ".join(
            f"CAST({_quoted_identifier(name)} AS {sqlite_type})"
            if name.lower() == column.lower()
            else _quoted_identifier(name)
            for name in column_order
        )
        target_columns = ", ".join(_quoted_identifier(name) for name in column_order)

        # Rows are staged outside the main schema, then reinserted only after the
        # replacement table carries the original name.  Dropping a parent table
        # records a deferred foreign key violation for every dependent child row,
        # and that violation clears only when the parent rows return under the
        # referenced table name.
        stash_table = f"{table}__portal_rebuild_rows"
        connection.execute(f'DROP TABLE IF EXISTS temp."{stash_table}"')
        connection.execute(
            f'CREATE TEMP TABLE "{stash_table}" AS SELECT * FROM {_quoted_identifier(table)}'
        )
        connection.execute(rebuild_sql)
        connection.execute(f"DROP TABLE {_quoted_identifier(table)}")
        # The legacy rename avoids rewriting references in other objects, which is
        # required while the original table is briefly absent.
        connection.execute("PRAGMA legacy_alter_table=ON")
        try:
            connection.execute(
                f"ALTER TABLE {_quoted_identifier(rebuild_table)} RENAME TO {_quoted_identifier(table)}"
            )
        finally:
            connection.execute("PRAGMA legacy_alter_table=OFF")
        connection.execute(
            f"INSERT INTO {_quoted_identifier(table)} ({target_columns}) "
            f'SELECT {selected} FROM temp."{stash_table}"'
        )
        connection.execute(f'DROP TABLE temp."{stash_table}"')
        for index_sql in indexes:
            connection.execute(index_sql)

    violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise MigrationError(
            f"The table rebuild left {len(violations)} foreign key violation(s)."
        )


def registered_physical_schema_rebuild(
    connection: sqlite3.Connection,
    specification: dict[str, Any],
) -> None:
    """Reconcile registered storage, including columns whose declared type changed.

    A single transition carries one handler, and neither ``registered_physical_schema``
    nor ``alembic_structural`` can retype a column.  This handler rebuilds the drifted
    columns, reconciles the registry so fields added by any skipped intermediate release
    are present, and finally applies the reviewed Alembic operations for the draft.  Each
    step is idempotent, so a transition may span several releases at once.
    """
    unknown = set(specification) - {"retype_operations", "operations", "catalog_hash"}
    if unknown:
        raise MigrationError(
            "The registered physical rebuild handler received unsupported settings: "
            + ", ".join(sorted(unknown))
        )
    retype_operations = specification.get("retype_operations") or []
    if not isinstance(retype_operations, list):
        raise MigrationError("Table retype operations must be a list.")
    structural_operations = specification.get("operations") or []
    if not isinstance(structural_operations, list):
        raise MigrationError("Structural migration operations must be a list.")

    if retype_operations:
        rebuild_table_columns(connection, {"operations": retype_operations})

    from portal.app.sync.physical_entities import (
        initialize_physical_schema,
        validate_physical_registry,
    )

    validate_physical_registry()
    initialize_physical_schema(connection)

    if structural_operations:
        alembic_structural(connection, {"operations": structural_operations})


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
    "rebuild_table_columns": rebuild_table_columns,
    "registered_physical_schema_rebuild": registered_physical_schema_rebuild,
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
