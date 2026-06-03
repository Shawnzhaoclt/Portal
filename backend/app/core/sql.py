from __future__ import annotations

from fastapi import HTTPException


def bracket_identifier(identifier: str) -> str:
    if not identifier or "\x00" in identifier:
        raise HTTPException(status_code=400, detail=f"Invalid SQL identifier: {identifier!r}")

    return f"[{identifier.replace(']', ']]')}]"


def duck_identifier(identifier: str) -> str:
    if not identifier or "\x00" in identifier:
        raise HTTPException(status_code=400, detail=f"Invalid SQL identifier: {identifier!r}")

    escaped_identifier = identifier.replace('"', '""')
    return f'"{escaped_identifier}"'


def qualified_table_name(schema: str, table: str) -> str:
    return f"{bracket_identifier(schema)}.{bracket_identifier(table)}"
