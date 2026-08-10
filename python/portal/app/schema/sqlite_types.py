"""SQLite declared types supported by Portal schema maintenance.

SQLite stores values using type affinity rather than enforcing the richer type
systems used by server databases.  This allowlist exposes the common SQL type
names that SQLite can declare consistently and that Portal can validate after a
migration.
"""

from __future__ import annotations


SQLITE_DECLARED_TYPE_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Text", ("TEXT", "CHAR", "VARCHAR", "NCHAR", "NVARCHAR", "CLOB")),
    (
        "Integer",
        ("INTEGER", "INT", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT"),
    ),
    ("Boolean", ("BOOLEAN",)),
    (
        "Numeric",
        ("REAL", "FLOAT", "DOUBLE", "DOUBLE PRECISION", "NUMERIC", "DECIMAL"),
    ),
    ("Date and time", ("DATE", "TIME", "DATETIME", "TIMESTAMP")),
    ("Binary", ("BLOB",)),
)

SQLITE_DECLARED_TYPES: tuple[str, ...] = tuple(
    declared_type
    for _, declared_types in SQLITE_DECLARED_TYPE_GROUPS
    for declared_type in declared_types
)
SQLITE_DECLARED_TYPE_SET = frozenset(SQLITE_DECLARED_TYPES)


def normalize_sqlite_declared_type(value: object, *, default: str = "TEXT") -> str:
    """Normalize and validate a Portal-managed SQLite declared type."""
    declared_type = " ".join(str(value or default).strip().upper().split())
    if declared_type not in SQLITE_DECLARED_TYPE_SET:
        raise ValueError(f"Unsupported SQLite column type: {declared_type!r}")
    return declared_type


def sqlite_logical_type(declared_type: object) -> str:
    """Map a declared SQLite type to Portal's portable logical type."""
    normalized = " ".join(str(declared_type or "TEXT").strip().upper().split())
    if normalized == "BOOLEAN":
        return "boolean"
    if "INT" in normalized:
        return "integer"
    if any(token in normalized for token in ("REAL", "FLOA", "DOUB", "DEC", "NUM")):
        return "number"
    if any(token in normalized for token in ("DATE", "TIME")):
        return "datetime"
    if "BLOB" in normalized:
        return "binary"
    return "text"
