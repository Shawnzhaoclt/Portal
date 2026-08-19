from __future__ import annotations

import hashlib
import os
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


_ORIGINAL_CONNECT = sqlite3.connect
_HOOK_INSTALLED = False


def _key_hex() -> str:
    value = os.getenv("PORTAL_SYSTEM_DB_KEY", "").strip().lower()
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise RuntimeError("The Desktop system catalog encryption key is unavailable or invalid.")
    return value


def _sqlcipher_dbapi():
    try:
        from sqlcipher3 import dbapi2 as sqlcipher
    except ImportError as error:
        raise RuntimeError(
            "The bundled Python runtime is missing SQLCipher support. Reinstall Portal Desktop."
        ) from error
    return sqlcipher


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _key_expression(key_hex: str) -> str:
    return f'"x\'{key_hex}\'"'


def _database_path(value: Any) -> Path | None:
    if isinstance(value, bytes):
        value = os.fsdecode(value)
    try:
        text = os.fspath(value)
    except TypeError:
        return None
    if not isinstance(text, str) or text == ":memory:":
        return None
    if text.startswith("file:"):
        parsed = urlsplit(text)
        path_text = unquote(parsed.path)
        if parsed.netloc:
            path_text = f"//{parsed.netloc}{path_text}"
        elif len(path_text) >= 3 and path_text[0] == "/" and path_text[2] == ":":
            path_text = path_text[1:]
        text = path_text
    try:
        return Path(text).expanduser().absolute()
    except (OSError, ValueError):
        return None


def _same_path(left: Path | None, right: Path) -> bool:
    if left is None:
        return False
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _configure_encrypted_connection(connection: Any, key_hex: str) -> None:
    connection.execute(f"PRAGMA key = {_key_expression(key_hex)}")
    # Touch the schema immediately. A missing/incorrect key must fail before a
    # caller can mistake the encrypted catalog for an empty SQLite database.
    connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
    if os.getenv("PORTAL_SYSTEM_DB_WRITE_ENABLED", "").strip() != "1":
        connection.execute("PRAGMA query_only = ON")


def _sqlcipher_connection_factory(sqlcipher: Any):
    """Return a SQLCipher connection compatible with sqlite3.Row callers.

    Portal modules use ``sqlite3.Row`` as their standard row factory. The
    sqlcipher3 extension provides a separate C-extension Row type and rejects
    sqlite3.Row when a SQLCipher cursor invokes it. Translate only that
    assignment on encrypted catalog connections; ordinary SQLite connections
    and stormwater.db remain untouched.
    """

    class SystemCatalogConnection(sqlcipher.Connection):
        def __setattr__(self, name: str, value: Any) -> None:
            if name == "row_factory" and value is sqlite3.Row:
                value = sqlcipher.Row
            super().__setattr__(name, value)

    return SystemCatalogConnection


def install_system_catalog_sqlcipher_hook() -> None:
    """Route only the Desktop system catalog through SQLCipher.

    Other SQLite databases (business snapshots, exports, and portal.serving)
    continue to use Python's standard sqlite3 module.
    """

    global _HOOK_INSTALLED
    if _HOOK_INSTALLED or os.getenv("PORTAL_SYSTEM_DB_ENCRYPTED", "").strip() != "1":
        return
    target_value = os.getenv("PORTAL_SYSTEM_DB", "").strip()
    if not target_value:
        raise RuntimeError("The encrypted Desktop system catalog path is not configured.")
    target = Path(target_value).expanduser().absolute()
    key_hex = _key_hex()
    sqlcipher = _sqlcipher_dbapi()
    connection_factory = _sqlcipher_connection_factory(sqlcipher)

    def secure_connect(database: Any, *args: Any, **kwargs: Any):
        if not _same_path(_database_path(database), target):
            return _ORIGINAL_CONNECT(database, *args, **kwargs)
        positional = list(args)
        if len(positional) >= 5:
            positional[4] = connection_factory
        else:
            kwargs = dict(kwargs)
            kwargs["factory"] = connection_factory
        connection = sqlcipher.connect(database, *positional, **kwargs)
        try:
            _configure_encrypted_connection(connection, key_hex)
            return connection
        except Exception:
            connection.close()
            raise

    sqlite3.connect = secure_connect
    sqlite3.dbapi2.connect = secure_connect
    _HOOK_INSTALLED = True


def encrypt_plaintext_system_catalog(source: str | Path, destination: str | Path) -> dict[str, Any]:
    """Create and verify a SQLCipher copy of a plaintext system catalog."""

    source_path = Path(source).expanduser().absolute()
    destination_path = Path(destination).expanduser().absolute()
    if not source_path.is_file():
        raise RuntimeError(f"The plaintext system catalog was not found: {source_path}")
    with source_path.open("rb") as handle:
        if handle.read(16) != b"SQLite format 3\0":
            raise RuntimeError(f"The source system catalog is not plaintext SQLite: {source_path}")
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    destination_path.unlink(missing_ok=True)
    plaintext_connection = sqlite3.connect(os.fspath(source_path))
    try:
        plaintext_check = plaintext_connection.execute("PRAGMA quick_check").fetchone()
        if not plaintext_check or str(plaintext_check[0]).casefold() != "ok":
            raise RuntimeError(f"Plaintext catalog quick_check failed: {plaintext_check}")
        source_object_count = int(
            plaintext_connection.execute(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
            ).fetchone()[0]
        )
    finally:
        plaintext_connection.close()
    key_hex = _key_hex()
    sqlcipher = _sqlcipher_dbapi()
    source_connection = sqlcipher.connect(os.fspath(source_path))
    try:
        source_connection.execute(
            f"ATTACH DATABASE {_sql_literal(os.fspath(destination_path))} AS encrypted "
            f"KEY {_key_expression(key_hex)}"
        )
        source_connection.execute("SELECT sqlcipher_export('encrypted')")
        source_connection.execute("DETACH DATABASE encrypted")
    except Exception:
        destination_path.unlink(missing_ok=True)
        raise
    finally:
        source_connection.close()

    connection = sqlcipher.connect(os.fspath(destination_path))
    try:
        _configure_encrypted_connection(connection, key_hex)
        cipher_integrity_errors = connection.execute("PRAGMA cipher_integrity_check").fetchall()
        if cipher_integrity_errors:
            raise RuntimeError(
                f"SQLCipher integrity check failed: {cipher_integrity_errors[:3]}"
            )
        object_count = int(
            connection.execute(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
            ).fetchone()[0]
        )
        if object_count != source_object_count:
            raise RuntimeError(
                "SQLCipher export did not preserve the complete system catalog schema."
            )
        cipher_version = str(connection.execute("PRAGMA cipher_version").fetchone()[0])
    except Exception:
        destination_path.unlink(missing_ok=True)
        raise
    finally:
        connection.close()

    with destination_path.open("rb") as handle:
        header = handle.read(16)
    if header == b"SQLite format 3\0":
        destination_path.unlink(missing_ok=True)
        raise RuntimeError("SQLCipher produced a plaintext SQLite header.")
    digest = hashlib.sha256(destination_path.read_bytes()).hexdigest()
    return {
        "status": "succeeded",
        "destination": str(destination_path),
        "sizeBytes": destination_path.stat().st_size,
        "sha256": digest,
        "objectCount": object_count,
        "cipherVersion": cipher_version,
    }
