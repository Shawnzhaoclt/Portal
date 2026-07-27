from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .errors import CorruptArtifact, ProtocolViolation
from .models import COORDINATOR_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION, Operation, PackageReference, canonical_json, utc_now
from .storage import sha256_file, sqlite_readonly_uri

APPLICATION_ID = 0x504F5053  # POPS: Portal operation package SQLite
MAX_PACKAGE_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class PackageManifest:
    package_id: str
    actor_id: str
    user_id: str
    employee_number: str
    first_seq: int
    last_seq: int
    operation_count: int
    tx_id: str
    previous_package_id: str | None
    previous_package_sha256: str | None
    previous_package_path: str | None
    previous_first_seq: int | None
    previous_last_seq: int | None
    previous_size_bytes: int | None
    created_at_utc: str


def build_package(
    path: Path,
    *,
    actor_id: str,
    user_id: str,
    employee_number: str,
    operations: Sequence[Operation],
    previous: PackageReference | None,
) -> PackageManifest:
    if not operations:
        raise ProtocolViolation("Cannot build an empty operation package.")
    expected_sequences = list(range(operations[0].actor_seq, operations[-1].actor_seq + 1))
    if [operation.actor_seq for operation in operations] != expected_sequences:
        raise ProtocolViolation("Operation package sequences must be continuous.")
    tx_ids = {operation.tx_id for operation in operations}
    if len(tx_ids) != 1 or {operation.actor_id for operation in operations} != {actor_id}:
        raise ProtocolViolation("An operation package cannot split transactions or actors.")
    package_id = str(uuid.uuid4())
    manifest = PackageManifest(
        package_id=package_id,
        actor_id=actor_id,
        user_id=user_id,
        employee_number=employee_number,
        first_seq=operations[0].actor_seq,
        last_seq=operations[-1].actor_seq,
        operation_count=len(operations),
        tx_id=operations[0].tx_id,
        previous_package_id=previous.package_id if previous else None,
        previous_package_sha256=previous.sha256 if previous else None,
        previous_package_path=previous.relative_path if previous else None,
        previous_first_seq=previous.first_seq if previous else None,
        previous_last_seq=previous.last_seq if previous else None,
        previous_size_bytes=previous.size_bytes if previous else None,
        created_at_utc=utc_now(),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.execute(f"PRAGMA application_id={APPLICATION_ID}")
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.executescript(
            """
            CREATE TABLE package_manifest (
                singleton INTEGER PRIMARY KEY CHECK (singleton=1),
                protocol_version INTEGER NOT NULL,
                schema_version INTEGER NOT NULL,
                coordinator_version TEXT NOT NULL,
                package_id TEXT NOT NULL UNIQUE,
                actor_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                employee_number TEXT NOT NULL,
                first_seq INTEGER NOT NULL,
                last_seq INTEGER NOT NULL,
                operation_count INTEGER NOT NULL,
                tx_id TEXT NOT NULL,
                previous_package_id TEXT,
                previous_package_sha256 TEXT,
                previous_package_path TEXT,
                previous_first_seq INTEGER,
                previous_last_seq INTEGER,
                previous_size_bytes INTEGER,
                created_at_utc TEXT NOT NULL
            );
            CREATE TABLE package_operation (
                actor_seq INTEGER PRIMARY KEY,
                operation_id TEXT NOT NULL UNIQUE,
                tx_id TEXT NOT NULL,
                tx_index INTEGER NOT NULL,
                tx_count INTEGER NOT NULL,
                actor_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                operation_type TEXT NOT NULL,
                base_record_revision TEXT,
                values_json TEXT NOT NULL,
                geometry BLOB,
                created_at_utc TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT INTO package_manifest VALUES (
                1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            (
                PROTOCOL_VERSION,
                SCHEMA_VERSION,
                COORDINATOR_VERSION,
                manifest.package_id,
                manifest.actor_id,
                manifest.user_id,
                manifest.employee_number,
                manifest.first_seq,
                manifest.last_seq,
                manifest.operation_count,
                manifest.tx_id,
                manifest.previous_package_id,
                manifest.previous_package_sha256,
                manifest.previous_package_path,
                manifest.previous_first_seq,
                manifest.previous_last_seq,
                manifest.previous_size_bytes,
                manifest.created_at_utc,
            ),
        )
        connection.executemany(
            """
            INSERT INTO package_operation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    operation.actor_seq,
                    operation.operation_id,
                    operation.tx_id,
                    operation.tx_index,
                    operation.tx_count,
                    operation.actor_id,
                    operation.user_id,
                    operation.entity_type,
                    operation.entity_id,
                    operation.operation_type,
                    operation.base_record_revision,
                    canonical_json(dict(operation.values)),
                    operation.geometry,
                    operation.created_at_utc,
                )
                for operation in operations
            ],
        )
        connection.commit()
        result = connection.execute("PRAGMA quick_check").fetchone()[0]
        if result != "ok":
            raise CorruptArtifact(f"New operation package failed SQLite quick_check: {result}")
    finally:
        connection.close()
    return manifest


def read_package(
    path: Path,
    *,
    expected_hash: str | None = None,
    expected_size: int | None = None,
) -> tuple[PackageManifest, list[Operation]]:
    if not path.is_file():
        raise CorruptArtifact(f"Operation package is unavailable: {path}")
    if path.stat().st_size > MAX_PACKAGE_BYTES:
        raise CorruptArtifact(f"Operation package exceeds the permitted size: {path}")
    if expected_size is not None and path.stat().st_size != expected_size:
        raise CorruptArtifact(f"Operation package size mismatch: {path}")
    actual_hash = sha256_file(path)
    if expected_hash is not None and actual_hash.lower() != expected_hash.lower():
        raise CorruptArtifact(f"Operation package hash mismatch: {path}")
    connection = sqlite3.connect(sqlite_readonly_uri(path, immutable=True), uri=True)
    connection.row_factory = sqlite3.Row
    try:
        if connection.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID:
            raise CorruptArtifact(f"File is not a Portal operation package: {path}")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.enable_load_extension(False)
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise CorruptArtifact(f"Operation package failed SQLite quick_check: {path}")
        row = connection.execute("SELECT * FROM package_manifest WHERE singleton=1").fetchone()
        if not row:
            raise CorruptArtifact(f"Operation package manifest is missing: {path}")
        if row["protocol_version"] != PROTOCOL_VERSION or row["schema_version"] != SCHEMA_VERSION:
            raise ProtocolViolation("Operation package protocol or schema version is unsupported.")
        if row["coordinator_version"] != COORDINATOR_VERSION:
            raise ProtocolViolation("Operation package coordinator version is unsupported.")
        manifest = PackageManifest(
            package_id=row["package_id"],
            actor_id=row["actor_id"],
            user_id=row["user_id"],
            employee_number=row["employee_number"],
            first_seq=row["first_seq"],
            last_seq=row["last_seq"],
            operation_count=row["operation_count"],
            tx_id=row["tx_id"],
            previous_package_id=row["previous_package_id"],
            previous_package_sha256=row["previous_package_sha256"],
            previous_package_path=row["previous_package_path"],
            previous_first_seq=row["previous_first_seq"],
            previous_last_seq=row["previous_last_seq"],
            previous_size_bytes=row["previous_size_bytes"],
            created_at_utc=row["created_at_utc"],
        )
        rows = connection.execute("SELECT * FROM package_operation ORDER BY actor_seq").fetchall()
        operations = [
            Operation(
                operation_id=item["operation_id"],
                tx_id=item["tx_id"],
                tx_index=item["tx_index"],
                tx_count=item["tx_count"],
                actor_id=item["actor_id"],
                actor_seq=item["actor_seq"],
                user_id=item["user_id"],
                entity_type=item["entity_type"],
                entity_id=item["entity_id"],
                operation_type=item["operation_type"],
                base_record_revision=item["base_record_revision"],
                values=json.loads(item["values_json"]),
                geometry=item["geometry"],
                created_at_utc=item["created_at_utc"],
            )
            for item in rows
        ]
    except sqlite3.DatabaseError as error:
        raise CorruptArtifact(f"Could not validate operation package {path}.") from error
    finally:
        connection.close()
    if len(operations) != manifest.operation_count:
        raise CorruptArtifact("Operation package count does not match its manifest.")
    if not operations or operations[0].actor_seq != manifest.first_seq or operations[-1].actor_seq != manifest.last_seq:
        raise CorruptArtifact("Operation package sequence range does not match its manifest.")
    if [operation.actor_seq for operation in operations] != list(
        range(manifest.first_seq, manifest.last_seq + 1)
    ):
        raise CorruptArtifact("Operation package actor sequences are not continuous.")
    if any(operation.actor_id != manifest.actor_id for operation in operations):
        raise CorruptArtifact("Operation package contains a different actor.")
    if any(operation.user_id != manifest.user_id for operation in operations):
        raise CorruptArtifact("Operation package contains a different user.")
    if {operation.tx_id for operation in operations} != {manifest.tx_id}:
        raise CorruptArtifact("Operation package split or mixed business transactions.")
    if [operation.tx_index for operation in operations] != list(range(len(operations))):
        raise CorruptArtifact("Operation package transaction indexes are incomplete.")
    if any(operation.tx_count != len(operations) for operation in operations):
        raise CorruptArtifact("Operation package transaction counts are inconsistent.")
    return manifest, operations
