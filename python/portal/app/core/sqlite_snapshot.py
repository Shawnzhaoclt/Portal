from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from difflib import SequenceMatcher
from pathlib import Path
from re import sub
from typing import Iterator


class SQLiteSnapshotError(RuntimeError):
    """Raised when a published SQLite snapshot cannot be resolved."""


def _portal_datetime(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time()).isoformat(sep=" ")

    text = str(value).strip()
    if not text:
        return None
    normalized = sub(r"\s+", " ", text)
    try:
        return datetime.fromisoformat(normalized.replace("Z", "+00:00")).isoformat(sep=" ")
    except ValueError:
        pass
    for pattern in (
        "%m/%d/%Y %I:%M:%S %p",
        "%m/%d/%Y %I:%M %p",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y",
        "%Y%m%d",
    ):
        try:
            return datetime.strptime(normalized, pattern).isoformat(sep=" ")
        except ValueError:
            continue
    return None


def _portal_date(value: object) -> str | None:
    normalized = _portal_datetime(value)
    return normalized[:10] if normalized else None


def _portal_int(value: object) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError, OverflowError):
        return None


def _portal_float(value: object) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return float(str(value).strip())
    except (TypeError, ValueError, OverflowError):
        return None


def _portal_normalize(value: object) -> str:
    return sub(r"[^a-z0-9]+", "", str(value or "").casefold())


def _portal_similarity(left: object, right: object) -> float:
    return SequenceMatcher(
        None,
        str(left or "").casefold(),
        str(right or "").casefold(),
    ).ratio()


def configure_snapshot_connection(connection: sqlite3.Connection) -> None:
    connection.create_function("PORTAL_DATE", 1, _portal_date, deterministic=True)
    connection.create_function("PORTAL_DATETIME", 1, _portal_datetime, deterministic=True)
    connection.create_function("PORTAL_INT", 1, _portal_int, deterministic=True)
    connection.create_function("PORTAL_FLOAT", 1, _portal_float, deterministic=True)
    connection.create_function("PORTAL_NORMALIZE", 1, _portal_normalize, deterministic=True)
    connection.create_function("PORTAL_SIMILARITY", 2, _portal_similarity, deterministic=True)
    connection.execute("PRAGMA query_only = ON")


def resolve_sqlite_snapshot(manifest_path: str | Path) -> Path:
    """Resolve the immutable database referenced by a publication manifest."""
    # Keep mapped-drive paths mapped. Resolving G: to a UNC authority produces a
    # SQLite URI that Python's sqlite3 driver rejects on Windows.
    manifest = Path(manifest_path).expanduser().absolute()
    if not manifest.is_file():
        raise SQLiteSnapshotError(f"SQLite snapshot manifest was not found: {manifest}")

    try:
        payload = json.loads(manifest.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise SQLiteSnapshotError(
            f"SQLite snapshot manifest is invalid: {manifest}: {error}"
        ) from error

    if not isinstance(payload, dict) or payload.get("format") != "sqlite":
        raise SQLiteSnapshotError(
            f"SQLite snapshot manifest has an unsupported format: {manifest}"
        )

    database_value = payload.get("database")
    if not isinstance(database_value, str) or not database_value.strip():
        raise SQLiteSnapshotError(
            f"SQLite snapshot manifest does not identify a database: {manifest}"
        )

    database = Path(database_value.strip()).expanduser()
    if not database.is_absolute():
        database = manifest.parent / database
    database = database.absolute()
    if not database.is_file():
        raise SQLiteSnapshotError(f"Published SQLite snapshot was not found: {database}")
    return database


@contextmanager
def readonly_sqlite_snapshot(
    manifest_path: str | Path,
) -> Iterator[sqlite3.Connection]:
    """Open the current snapshot read-only and always close it after the operation."""
    connection = open_readonly_sqlite_snapshot(manifest_path)
    try:
        yield connection
    finally:
        connection.close()


def open_readonly_sqlite_snapshot(manifest_path: str | Path) -> sqlite3.Connection:
    """Open the current snapshot read-only; the caller owns and must close it."""
    database = resolve_sqlite_snapshot(manifest_path)
    connection = sqlite3.connect(
        f"{database.as_uri()}?mode=ro&immutable=1",
        uri=True,
        timeout=5,
    )
    try:
        configure_snapshot_connection(connection)
        return connection
    except Exception:
        connection.close()
        raise
