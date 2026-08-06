from __future__ import annotations

import os
import shutil
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .errors import CorruptArtifact, ProtocolViolation
from .local_store import SCHEMA_SQL
from .models import (
    COORDINATOR_VERSION,
    PYTHON_RUNTIME_VERSION,
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
    utc_now,
)
from .physical_entities import initialize_physical_schema
from .storage import read_json, sha256_file, sqlite_readonly_uri


@dataclass(frozen=True)
class SnapshotPointer:
    snapshot_id: str
    snapshot_epoch_id: str
    relative_path: str
    sha256: str
    size_bytes: int
    replication_profile: str
    coverage: Mapping[str, int]
    log_floor: Mapping[str, int]
    coordinator_version: str = COORDINATOR_VERSION
    python_runtime_version: str = PYTHON_RUNTIME_VERSION


def load_snapshot_pointer(protocol_root: Path) -> SnapshotPointer:
    value = read_json(protocol_root / "snapshots" / "current.json")
    try:
        pointer = SnapshotPointer(
            snapshot_id=str(value["snapshot_id"]),
            snapshot_epoch_id=str(value["snapshot_epoch_id"]),
            relative_path=str(value["relative_path"]),
            sha256=str(value["sha256"]),
            size_bytes=int(value["size_bytes"]),
            replication_profile=str(value["replication_profile"]),
            coverage={str(key): int(item) for key, item in dict(value.get("coverage", {})).items()},
            log_floor={str(key): int(item) for key, item in dict(value.get("log_floor", {})).items()},
            coordinator_version=str(value["coordinator_version"]),
            python_runtime_version=str(value["python_runtime_version"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ProtocolViolation("The current snapshot pointer is malformed.") from error
    if int(value.get("protocol_version", -1)) != PROTOCOL_VERSION:
        raise ProtocolViolation("Snapshot protocol version is unsupported.")
    if int(value.get("schema_version", -1)) != SCHEMA_VERSION:
        raise ProtocolViolation("Snapshot schema version is unsupported.")
    if pointer.replication_profile != "all":
        raise ProtocolViolation("Only full mutable-data replication is supported in v1.")
    if pointer.coordinator_version != COORDINATOR_VERSION:
        raise ProtocolViolation("Snapshot coordinator version is unsupported.")
    if not pointer.snapshot_id or not pointer.snapshot_epoch_id:
        raise ProtocolViolation("Snapshot ID and epoch ID are required.")
    return pointer


def snapshot_file(protocol_root: Path, pointer: SnapshotPointer) -> Path:
    relative = Path(pointer.relative_path)
    if relative.is_absolute():
        raise ProtocolViolation("Snapshot relative path cannot be absolute.")
    root = (protocol_root / "snapshots").resolve()
    result = (root / relative).resolve()
    try:
        result.relative_to(root)
    except ValueError as error:
        raise ProtocolViolation("Snapshot path escapes the snapshot directory.") from error
    return result


def validate_snapshot(path: Path, pointer: SnapshotPointer) -> None:
    if not path.is_file() or path.stat().st_size != pointer.size_bytes:
        raise CorruptArtifact("The referenced snapshot is unavailable or incomplete.")
    if sha256_file(path) != pointer.sha256:
        raise CorruptArtifact("The referenced snapshot hash does not match its pointer.")
    connection = sqlite3.connect(sqlite_readonly_uri(path, immutable=True), uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.enable_load_extension(False)
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise CorruptArtifact("The referenced snapshot failed SQLite quick_check.")
        metadata = connection.execute(
            "SELECT * FROM sw_snapshot_metadata WHERE singleton=1"
        ).fetchone()
        if not metadata:
            raise CorruptArtifact("The referenced snapshot has no internal metadata.")
        if metadata["snapshot_id"] != pointer.snapshot_id:
            raise CorruptArtifact("Snapshot ID does not match internal metadata.")
        if metadata["snapshot_epoch_id"] != pointer.snapshot_epoch_id:
            raise CorruptArtifact("Snapshot epoch does not match internal metadata.")
        if metadata["replication_profile"] != "all":
            raise CorruptArtifact("Snapshot is not a full-replication snapshot.")
        if metadata["coordinator_version"] != pointer.coordinator_version:
            raise CorruptArtifact("Snapshot coordinator version does not match its pointer.")
        # The runtime version is diagnostic metadata. The protocol, schema, and
        # coordinator versions govern whether a snapshot is safe to consume.
        coverage_rows = connection.execute(
            "SELECT actor_id, highest_continuous_seq, log_floor "
            "FROM sw_snapshot_actor_coverage ORDER BY actor_id"
        ).fetchall()
        internal_coverage = {str(row[0]): int(row[1]) for row in coverage_rows}
        internal_log_floor = {str(row[0]): int(row[2]) for row in coverage_rows}
        if internal_coverage != dict(pointer.coverage):
            raise CorruptArtifact("Snapshot coverage does not match its pointer.")
        if internal_log_floor != dict(pointer.log_floor):
            raise CorruptArtifact("Snapshot log floor does not match its pointer.")
    except sqlite3.DatabaseError as error:
        raise CorruptArtifact("The referenced snapshot could not be validated.") from error
    finally:
        connection.close()


def install_snapshot(source: Path, destination: Path, pointer: SnapshotPointer) -> None:
    validate_snapshot(source, pointer)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.part")
    try:
        with source.open("rb") as input_stream, temporary.open("xb") as output_stream:
            shutil.copyfileobj(input_stream, output_stream, length=1024 * 1024)
            output_stream.flush()
            os.fsync(output_stream.fileno())
        validate_snapshot(temporary, pointer)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def create_empty_snapshot(
    path: Path,
    *,
    snapshot_id: str,
    snapshot_epoch_id: str,
    coverage: Mapping[str, int] | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.executescript(SCHEMA_SQL)
        # A fresh shared snapshot is also the source for a client's first
        # local stormwater.db. Keep the registered physical business tables
        # in that snapshot; there may be no local database yet.
        initialize_physical_schema(connection)
        connection.executescript(
            """
            CREATE TABLE sw_snapshot_metadata (
                singleton INTEGER PRIMARY KEY CHECK (singleton=1),
                snapshot_id TEXT NOT NULL,
                snapshot_epoch_id TEXT NOT NULL,
                protocol_version INTEGER NOT NULL,
                schema_version INTEGER NOT NULL,
                coordinator_version TEXT NOT NULL,
                python_runtime_version TEXT NOT NULL,
                replication_profile TEXT NOT NULL,
                created_at_utc TEXT NOT NULL
            );
            CREATE TABLE sw_snapshot_actor_coverage (
                actor_id TEXT PRIMARY KEY,
                highest_continuous_seq INTEGER NOT NULL,
                log_floor INTEGER NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT INTO sw_sync_install_state(singleton) VALUES (1)"
        )
        connection.execute(
            "INSERT INTO sw_snapshot_metadata VALUES (1, ?, ?, ?, ?, ?, ?, 'all', ?)",
            (
                snapshot_id,
                snapshot_epoch_id,
                PROTOCOL_VERSION,
                SCHEMA_VERSION,
                COORDINATOR_VERSION,
                PYTHON_RUNTIME_VERSION,
                utc_now(),
            ),
        )
        for actor_id, actor_seq in (coverage or {}).items():
            connection.execute(
                "INSERT INTO sw_snapshot_actor_coverage VALUES (?, ?, 0)",
                (actor_id, actor_seq),
            )
        connection.commit()
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise CorruptArtifact("New empty snapshot failed SQLite quick_check.")
    finally:
        connection.close()
