"""Publish business-schema changes as verified shared synchronization snapshots.

This module is deliberately workstation-only.  It never mutates a Portal
Desktop replica in place.  A schema release is prepared from the active shared
snapshot, validated, and made authoritative only by atomically replacing the
shared snapshot pointer while the epoch transition lock is held.
"""

from __future__ import annotations

import sqlite3
import tempfile
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Literal

from portal.app.sync.coordinator import DataCoordinator
from portal.app.sync.membership import MembershipRelease, load_membership
from portal.app.sync.models import (
    COORDINATOR_VERSION,
    PYTHON_RUNTIME_VERSION,
    Identity,
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
    SyncPaths,
    utc_now,
)
from portal.app.sync.snapshot import (
    SnapshotPointer,
    load_snapshot_pointer,
    snapshot_file,
    validate_snapshot,
)
from portal.app.sync.storage import (
    FileRangeLock,
    atomic_replace_json,
    publish_immutable_file,
    read_json,
    require_shared_root,
    sha256_file,
    sqlite_readonly_uri,
)

from .manager import SchemaManager, SchemaManagerError


PublicationKind = Literal["baseline", "migration"]


class SharedSchemaPublisherError(RuntimeError):
    """Raised when a shared schema release cannot be safely published."""


class SharedSchemaPublisher:
    """Read, validate, and publish the schema of the shared business snapshot."""

    def __init__(self, system_database: Path, network_root: Path) -> None:
        self.system_database = Path(system_database).resolve()
        self.paths = SyncPaths(Path(network_root))

    def status(self) -> dict[str, Any]:
        require_shared_root(self.paths.network_root)
        pointer = load_snapshot_pointer(self.paths.protocol_root)
        source = snapshot_file(self.paths.protocol_root, pointer)
        validate_snapshot(source, pointer)
        manager = SchemaManager(self.system_database, source)
        active_release = manager._active_release()
        state, checks, diagnostic = self._inspect_snapshot(manager, source, active_release)
        return {
            "state": "healthy" if state and state.get("installed_release_id") == active_release["release_id"] and not diagnostic else "unmanaged" if state is None else "needs_migration",
            "diagnostic": diagnostic,
            "system_database": str(self.system_database),
            "network_root": str(self.paths.network_root),
            "protocol_root": str(self.paths.protocol_root),
            "active_snapshot_id": pointer.snapshot_id,
            "active_snapshot_epoch_id": pointer.snapshot_epoch_id,
            "active_snapshot_path": str(source),
            "snapshot_coverage_actors": len(pointer.coverage),
            "snapshot_created_at": self._snapshot_created_at(source),
            "target_release_id": active_release["release_id"],
            "target_schema_version": active_release["schema_version"],
            "target_catalog_hash": active_release["catalog_hash"],
            "catalog_hash": active_release["catalog_hash"],
            "rollback_available": False,
            "checks": checks,
            **(state or {"installed_release_id": None, "installed_schema_version": None}),
            "installed_catalog_hash": state.get("catalog_hash") if state else None,
        }

    def validate(self) -> dict[str, Any]:
        status = self.status()
        return {
            **status,
            "valid": status["state"] == "healthy",
        }

    def plan(self) -> dict[str, Any]:
        status = self.status()
        manager = SchemaManager(self.system_database, Path(status["active_snapshot_path"]))
        migrations = manager._migration_path(
            status.get("installed_release_id"), str(status["target_release_id"])
        )
        return {
            **status,
            "from_release_id": status.get("installed_release_id"),
            "to_release_id": status["target_release_id"],
            "migrations": [item.__dict__ for item in migrations],
        }

    def publish(self, kind: PublicationKind, confirmation: str) -> dict[str, Any]:
        require_shared_root(self.paths.network_root)
        if not self.system_database.is_file():
            raise SharedSchemaPublisherError(
                f"The system schema catalog is unavailable: {self.system_database}"
            )

        # Formal saves take this lock in shared mode.  A rare schema release holds
        # it exclusively, so no actor can publish against the old epoch mid-release.
        with FileRangeLock(
            self.paths.epoch_lock, exclusive=True, timeout_seconds=60.0
        ):
            membership = load_membership(self.paths.protocol_root)
            old_pointer = load_snapshot_pointer(self.paths.protocol_root)
            if confirmation.strip() != old_pointer.snapshot_id:
                raise SharedSchemaPublisherError(
                    "Type the active snapshot ID exactly to publish a shared schema change."
                )
            source = snapshot_file(self.paths.protocol_root, old_pointer)
            validate_snapshot(source, old_pointer)
            manager = SchemaManager(self.system_database, source)
            active_release = manager._active_release()
            state, _checks, _diagnostic = self._inspect_snapshot(manager, source, active_release)
            installed_release = state.get("installed_release_id") if state else None
            if kind == "baseline" and installed_release is not None:
                raise SharedSchemaPublisherError(
                    "The active snapshot is already managed. Use Publish migration instead."
                )
            if kind == "migration" and installed_release is None:
                raise SharedSchemaPublisherError(
                    "The active snapshot has no schema baseline. Publish the baseline first."
                )

            with tempfile.TemporaryDirectory(prefix="portal-schema-publish-") as temporary:
                candidate = Path(temporary) / "candidate.db"
                self._copy_snapshot(source, candidate)

                # Rebuild the candidate to every visible active actor head before
                # changing structure.  The exclusive epoch lock makes this exact.
                coverage = self._replay_active_epoch(candidate, old_pointer, membership)
                candidate_manager = SchemaManager(self.system_database, candidate)
                if kind == "baseline":
                    candidate_manager.initialize()
                else:
                    candidate_manager.migrate(active_release["release_id"])

                new_snapshot_id = str(uuid.uuid4())
                new_epoch_id = f"epoch-{uuid.uuid4()}"
                log_floor = {
                    actor_id: int(old_pointer.log_floor.get(actor_id, 0))
                    for actor_id in coverage
                }
                self._freeze_snapshot(
                    candidate,
                    snapshot_id=new_snapshot_id,
                    snapshot_epoch_id=new_epoch_id,
                    coverage=coverage,
                    log_floor=log_floor,
                )
                self._checkpoint(candidate)

                candidate_hash = sha256_file(candidate)
                candidate_size = candidate.stat().st_size
                new_pointer = SnapshotPointer(
                    snapshot_id=new_snapshot_id,
                    snapshot_epoch_id=new_epoch_id,
                    relative_path=f"snapshot-{new_snapshot_id}-{candidate_hash}.db",
                    sha256=candidate_hash,
                    size_bytes=candidate_size,
                    replication_profile="all",
                    coverage=coverage,
                    log_floor=log_floor,
                )
                validate_snapshot(candidate, new_pointer)
                destination = snapshot_file(self.paths.protocol_root, new_pointer)
                published_hash, published_size = publish_immutable_file(candidate, destination)
                if published_hash != new_pointer.sha256 or published_size != new_pointer.size_bytes:
                    raise SharedSchemaPublisherError("Published snapshot verification changed unexpectedly.")
                validate_snapshot(destination, new_pointer)
                self.paths.epoch_registry(new_epoch_id).mkdir(parents=True, exist_ok=True)
                atomic_replace_json(
                    self.paths.snapshots_current,
                    {
                        "protocol_version": PROTOCOL_VERSION,
                        "schema_version": SCHEMA_VERSION,
                        "coordinator_version": COORDINATOR_VERSION,
                        "python_runtime_version": PYTHON_RUNTIME_VERSION,
                        "snapshot_id": new_pointer.snapshot_id,
                        "snapshot_epoch_id": new_pointer.snapshot_epoch_id,
                        "relative_path": new_pointer.relative_path,
                        "sha256": new_pointer.sha256,
                        "size_bytes": new_pointer.size_bytes,
                        "replication_profile": "all",
                        "coverage": dict(new_pointer.coverage),
                        "log_floor": dict(new_pointer.log_floor),
                        "schema_release_id": active_release["release_id"],
                        "catalog_hash": active_release["catalog_hash"],
                        "created_at_utc": utc_now(),
                        "supersedes_snapshot_id": old_pointer.snapshot_id,
                    },
                )

        return {
            **self.status(),
            "published": True,
            "publication_kind": kind,
            "previous_snapshot_id": old_pointer.snapshot_id,
        }

    def publish_checkpoint(self, confirmation: str) -> dict[str, Any]:
        """Publish a verified snapshot without changing the approved schema.

        This is the workstation's normal snapshot action.  It deliberately uses
        the same epoch-transition lock and pointer commit sequence as a schema
        publication, so a checkpoint cannot miss an actor publication that was
        already visible when the transition started.
        """

        require_shared_root(self.paths.network_root)
        with FileRangeLock(
            self.paths.epoch_lock, exclusive=True, timeout_seconds=60.0
        ):
            membership = load_membership(self.paths.protocol_root)
            old_pointer = load_snapshot_pointer(self.paths.protocol_root)
            previous_pointer_payload = read_json(self.paths.snapshots_current)
            if confirmation.strip() != old_pointer.snapshot_id:
                raise SharedSchemaPublisherError(
                    "Type the active snapshot ID exactly to publish a checkpoint."
                )
            source = snapshot_file(self.paths.protocol_root, old_pointer)
            validate_snapshot(source, old_pointer)

            with tempfile.TemporaryDirectory(prefix="portal-snapshot-publish-") as temporary:
                candidate = Path(temporary) / "candidate.db"
                self._copy_snapshot(source, candidate)
                coverage = self._replay_active_epoch(candidate, old_pointer, membership)
                new_snapshot_id = str(uuid.uuid4())
                new_epoch_id = f"epoch-{uuid.uuid4()}"
                log_floor = {
                    actor_id: int(old_pointer.log_floor.get(actor_id, 0))
                    for actor_id in coverage
                }
                self._freeze_snapshot(
                    candidate,
                    snapshot_id=new_snapshot_id,
                    snapshot_epoch_id=new_epoch_id,
                    coverage=coverage,
                    log_floor=log_floor,
                )
                self._checkpoint(candidate)

                candidate_hash = sha256_file(candidate)
                candidate_size = candidate.stat().st_size
                new_pointer = SnapshotPointer(
                    snapshot_id=new_snapshot_id,
                    snapshot_epoch_id=new_epoch_id,
                    relative_path=f"snapshot-{new_snapshot_id}-{candidate_hash}.db",
                    sha256=candidate_hash,
                    size_bytes=candidate_size,
                    replication_profile="all",
                    coverage=coverage,
                    log_floor=log_floor,
                )
                validate_snapshot(candidate, new_pointer)
                destination = snapshot_file(self.paths.protocol_root, new_pointer)
                published_hash, published_size = publish_immutable_file(candidate, destination)
                if published_hash != new_pointer.sha256 or published_size != new_pointer.size_bytes:
                    raise SharedSchemaPublisherError("Published snapshot verification changed unexpectedly.")
                validate_snapshot(destination, new_pointer)
                self.paths.epoch_registry(new_epoch_id).mkdir(parents=True, exist_ok=True)

                # Replacing this one small pointer is the authority commit.
                # A checkpoint does not change an already-approved schema
                # release, so retain that pointer metadata if it exists.
                pointer_payload = {
                        "protocol_version": PROTOCOL_VERSION,
                        "schema_version": SCHEMA_VERSION,
                        "coordinator_version": COORDINATOR_VERSION,
                        "python_runtime_version": PYTHON_RUNTIME_VERSION,
                        "snapshot_id": new_pointer.snapshot_id,
                        "snapshot_epoch_id": new_pointer.snapshot_epoch_id,
                        "relative_path": new_pointer.relative_path,
                        "sha256": new_pointer.sha256,
                        "size_bytes": new_pointer.size_bytes,
                        "replication_profile": "all",
                        "coverage": dict(new_pointer.coverage),
                        "log_floor": dict(new_pointer.log_floor),
                        "created_at_utc": utc_now(),
                        "supersedes_snapshot_id": old_pointer.snapshot_id,
                }
                for key in ("schema_release_id", "catalog_hash"):
                    if key in previous_pointer_payload:
                        pointer_payload[key] = previous_pointer_payload[key]
                atomic_replace_json(self.paths.snapshots_current, pointer_payload)

        return {
            **self.status(),
            "published": True,
            "publication_kind": "checkpoint",
            "previous_snapshot_id": old_pointer.snapshot_id,
        }

    def publish_retention_checkpoint(
        self, requested_log_floor: dict[str, int]
    ) -> dict[str, Any]:
        """Publish a replacement snapshot that advances only safe log floors.

        Retention stages immutable archive and backup copies before calling this
        method.  The new pointer is the commit marker that lets clients replace
        an old replica before the corresponding online operation packages are
        removed.  This method intentionally has no schema-catalog dependency:
        compaction is a synchronization concern, not a schema change.
        """

        require_shared_root(self.paths.network_root)
        with FileRangeLock(
            self.paths.epoch_lock, exclusive=True, timeout_seconds=60.0
        ):
            membership = load_membership(self.paths.protocol_root)
            old_pointer = load_snapshot_pointer(self.paths.protocol_root)
            previous_pointer_payload = read_json(self.paths.snapshots_current)
            source = snapshot_file(self.paths.protocol_root, old_pointer)
            validate_snapshot(source, old_pointer)

            with tempfile.TemporaryDirectory(prefix="portal-retention-publish-") as temporary:
                candidate = Path(temporary) / "candidate.db"
                self._copy_snapshot(source, candidate)
                coverage = self._replay_active_epoch(candidate, old_pointer, membership)
                log_floor: dict[str, int] = {}
                for actor_id, covered_sequence in coverage.items():
                    prior_floor = int(old_pointer.log_floor.get(actor_id, 0))
                    requested_floor = int(requested_log_floor.get(actor_id, prior_floor))
                    if requested_floor < prior_floor:
                        raise SharedSchemaPublisherError(
                            f"Retention cannot lower log floor for actor {actor_id}."
                        )
                    if requested_floor > int(covered_sequence):
                        raise SharedSchemaPublisherError(
                            f"Retention log floor exceeds snapshot coverage for actor {actor_id}."
                        )
                    log_floor[actor_id] = requested_floor

                new_snapshot_id = str(uuid.uuid4())
                new_epoch_id = f"epoch-{uuid.uuid4()}"
                self._freeze_snapshot(
                    candidate,
                    snapshot_id=new_snapshot_id,
                    snapshot_epoch_id=new_epoch_id,
                    coverage=coverage,
                    log_floor=log_floor,
                )
                self._checkpoint(candidate)

                candidate_hash = sha256_file(candidate)
                candidate_size = candidate.stat().st_size
                new_pointer = SnapshotPointer(
                    snapshot_id=new_snapshot_id,
                    snapshot_epoch_id=new_epoch_id,
                    relative_path=f"snapshot-{new_snapshot_id}-{candidate_hash}.db",
                    sha256=candidate_hash,
                    size_bytes=candidate_size,
                    replication_profile="all",
                    coverage=coverage,
                    log_floor=log_floor,
                )
                validate_snapshot(candidate, new_pointer)
                destination = snapshot_file(self.paths.protocol_root, new_pointer)
                published_hash, published_size = publish_immutable_file(candidate, destination)
                if published_hash != new_pointer.sha256 or published_size != new_pointer.size_bytes:
                    raise SharedSchemaPublisherError(
                        "Published retention snapshot verification changed unexpectedly."
                    )
                validate_snapshot(destination, new_pointer)
                self.paths.epoch_registry(new_epoch_id).mkdir(parents=True, exist_ok=True)

                pointer_payload = {
                    "protocol_version": PROTOCOL_VERSION,
                    "schema_version": SCHEMA_VERSION,
                    "coordinator_version": COORDINATOR_VERSION,
                    "python_runtime_version": PYTHON_RUNTIME_VERSION,
                    "snapshot_id": new_pointer.snapshot_id,
                    "snapshot_epoch_id": new_pointer.snapshot_epoch_id,
                    "relative_path": new_pointer.relative_path,
                    "sha256": new_pointer.sha256,
                    "size_bytes": new_pointer.size_bytes,
                    "replication_profile": "all",
                    "coverage": dict(new_pointer.coverage),
                    "log_floor": dict(new_pointer.log_floor),
                    "created_at_utc": utc_now(),
                    "supersedes_snapshot_id": old_pointer.snapshot_id,
                }
                for key in ("schema_release_id", "catalog_hash"):
                    if key in previous_pointer_payload:
                        pointer_payload[key] = previous_pointer_payload[key]
                atomic_replace_json(self.paths.snapshots_current, pointer_payload)

        return {
            "published": True,
            "publication_kind": "retention",
            "previous_snapshot_id": old_pointer.snapshot_id,
            "active_snapshot_id": new_pointer.snapshot_id,
            "active_snapshot_epoch_id": new_pointer.snapshot_epoch_id,
            "coverage": dict(new_pointer.coverage),
            "log_floor": dict(new_pointer.log_floor),
        }

    def _inspect_snapshot(
        self,
        manager: SchemaManager,
        snapshot: Path,
        active_release: dict[str, Any],
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
        connection = sqlite3.connect(sqlite_readonly_uri(snapshot, immutable=True), uri=True)
        try:
            connection.execute("PRAGMA trusted_schema=OFF")
            tables = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            if "SW_SCHEMA_INSTALL_STATE" not in tables:
                return None, None, "No approved schema baseline has been published."
            row = connection.execute(
                "SELECT installed_release_id, installed_schema_version, catalog_hash, physical_fingerprint, state, diagnostic, last_validated_at, last_migrated_at, updated_at FROM SW_SCHEMA_INSTALL_STATE WHERE singleton=1"
            ).fetchone()
            if row is None:
                return None, None, "No approved schema baseline has been published."
            keys = (
                "installed_release_id",
                "installed_schema_version",
                "catalog_hash",
                "physical_fingerprint",
                "state",
                "diagnostic",
                "last_validated_at",
                "last_migrated_at",
                "updated_at",
            )
            state = dict(zip(keys, row, strict=True))
            try:
                checks = manager._validate_physical_schema(
                    connection, active_release["release_id"]
                )
            except SchemaManagerError as error:
                return state, None, str(error)
            diagnostic = None
            if state["installed_release_id"] != active_release["release_id"]:
                diagnostic = (
                    f"Published release is {state['installed_release_id']}; "
                    f"active catalog release is {active_release['release_id']}."
                )
            return state, checks, diagnostic
        finally:
            connection.close()

    def _replay_active_epoch(
        self,
        candidate: Path,
        pointer: SnapshotPointer,
        membership: MembershipRelease,
    ) -> dict[str, int]:
        # _sync_epoch is the existing Python reducer path.  The publisher uses a
        # maintenance identity only to host that reducer; it never registers or
        # publishes an actor for this identity.
        coordinator = DataCoordinator(
            identity=Identity("schema-publisher", "0"),
            database_path=candidate,
            network_root=self.paths.network_root,
            lock_timeout_seconds=60.0,
        )
        coordinator._sync_epoch(pointer, membership)
        coverage = dict(pointer.coverage)
        for registration in coordinator._list_registrations(pointer, membership):
            actor_root = coordinator._safe_protocol_path(
                registration.actor_root_relative_path
            )
            head = coordinator._read_head(actor_root / "head.json", registration)
            coverage[head.actor_id] = head.highest_published_seq
        return {actor_id: int(sequence) for actor_id, sequence in coverage.items()}

    @staticmethod
    def _copy_snapshot(source: Path, candidate: Path) -> None:
        with closing(sqlite3.connect(sqlite_readonly_uri(source, immutable=True), uri=True)) as input_connection, closing(sqlite3.connect(candidate)) as output_connection:
            input_connection.backup(output_connection)

    @staticmethod
    def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
        return connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone() is not None

    def _freeze_snapshot(
        self,
        candidate: Path,
        *,
        snapshot_id: str,
        snapshot_epoch_id: str,
        coverage: dict[str, int],
        log_floor: dict[str, int],
    ) -> None:
        with closing(sqlite3.connect(candidate)) as connection:
            connection.execute("PRAGMA foreign_keys=OFF")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.execute("BEGIN IMMEDIATE")
            # Clear only device-local identity and unpublished work.  Operation
            # history, received-package records, and cursors remain because the
            # Python reducer needs them to recompute an entity after its next
            # edit; deleting them would leave a visually correct snapshot that
            # cannot safely process a later update.
            for table in (
                "sw_sync_actor",
                "sw_sync_observed_head",
                "sw_sync_outbox_transaction",
            ):
                if self._table_exists(connection, table):
                    connection.execute(f'DELETE FROM "{table}"')
            if self._table_exists(connection, "sw_sync_install_state"):
                connection.execute(
                    "UPDATE sw_sync_install_state SET installed_snapshot_id=NULL, installed_snapshot_sha256=NULL, installed_snapshot_epoch_id=NULL, installed_at_utc=NULL, last_successful_sync_at_utc=NULL, last_error_code=NULL WHERE singleton=1"
                )
            if self._table_exists(connection, "sw_sync_cursor"):
                connection.execute("DELETE FROM sw_sync_cursor")
                for actor_id, sequence in sorted(coverage.items()):
                    connection.execute(
                        "INSERT INTO sw_sync_cursor(source_actor_id, highest_downloaded_seq, highest_terminal_seq, last_package_id, updated_at_utc) VALUES (?, ?, ?, NULL, ?)",
                        (actor_id, sequence, sequence, utc_now()),
                    )
            connection.execute(
                "UPDATE sw_snapshot_metadata SET snapshot_id=?, snapshot_epoch_id=?, protocol_version=?, schema_version=?, coordinator_version=?, python_runtime_version=?, replication_profile='all', created_at_utc=? WHERE singleton=1",
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
            connection.execute("DELETE FROM sw_snapshot_actor_coverage")
            for actor_id, sequence in sorted(coverage.items()):
                connection.execute(
                    "INSERT INTO sw_snapshot_actor_coverage(actor_id, highest_continuous_seq, log_floor) VALUES (?, ?, ?)",
                    (actor_id, sequence, int(log_floor.get(actor_id, 0))),
                )
            connection.commit()

    @staticmethod
    def _checkpoint(candidate: Path) -> None:
        with closing(sqlite3.connect(candidate)) as connection:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA synchronous=FULL")
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise SharedSchemaPublisherError("Candidate snapshot failed SQLite quick_check.")

    @staticmethod
    def _snapshot_created_at(snapshot: Path) -> str | None:
        connection = sqlite3.connect(sqlite_readonly_uri(snapshot, immutable=True), uri=True)
        try:
            row = connection.execute(
                "SELECT created_at_utc FROM sw_snapshot_metadata WHERE singleton=1"
            ).fetchone()
            return str(row[0]) if row else None
        finally:
            connection.close()
