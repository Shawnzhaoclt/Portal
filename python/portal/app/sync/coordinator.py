from __future__ import annotations

import hashlib
import os
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from .errors import (
    ConfigurationError,
    CorruptArtifact,
    ProtocolViolation,
    SnapshotRequired,
)
from .local_store import LocalStore
from .membership import MembershipRelease, load_membership, membership_payload
from .models import (
    ActorHead,
    COORDINATOR_VERSION,
    Identity,
    Mutation,
    Operation,
    PackageReference,
    PROTOCOL_VERSION,
    PYTHON_RUNTIME_VERSION,
    SCHEMA_VERSION,
    SyncPaths,
    canonical_json,
    utc_now,
)
from .operation_package import PackageManifest, build_package, read_package
from .snapshot import (
    SnapshotPointer,
    create_empty_snapshot,
    install_snapshot,
    load_snapshot_pointer,
    snapshot_file,
    validate_snapshot,
)
from .storage import (
    FileRangeLock,
    actor_lock_offset,
    atomic_replace_json,
    publish_immutable_file,
    publish_immutable_json,
    read_json,
    record_locks,
    require_shared_root,
    sha256_file,
)


@dataclass(frozen=True)
class ActorRegistration:
    actor_id: str
    user_id: str
    employee_number: str
    snapshot_epoch_id: str
    actor_root_relative_path: str


@dataclass(frozen=True)
class CommitResult:
    tx_id: str
    package_id: str
    actor_id: str
    first_seq: int
    last_seq: int
    head_generation: int
    affected_records: tuple[tuple[str, str], ...]


class DataCoordinator:
    """Single in-process coordinator for formal local business-data saves."""

    def __init__(
        self,
        *,
        identity: Identity,
        database_path: Path,
        network_root: Path,
        lock_timeout_seconds: float = 5.0,
    ) -> None:
        self.identity = identity
        self.database_path = database_path
        self.paths = SyncPaths(network_root)
        self.store = LocalStore(database_path)
        self.lock_timeout_seconds = lock_timeout_seconds
        self.actor_id: str | None = None
        self._last_sync_monotonic: float | None = None
        self._read_sync_lock = threading.Lock()

    @classmethod
    def from_desktop_config(
        cls,
        identity: Identity,
        *,
        lock_timeout_seconds: float = 5.0,
    ) -> "DataCoordinator":
        from portal.app.core.desktop_config import configured_paths

        paths = configured_paths()
        database = paths.get("business_database", "").strip()
        network_root = paths.get("business_network_root", "").strip()
        if not database or not network_root:
            raise ConfigurationError(
                "The desktop settings must define business.database and businessSync.networkRoot."
            )
        return cls(
            identity=identity,
            database_path=Path(database),
            network_root=Path(network_root),
            lock_timeout_seconds=lock_timeout_seconds,
        )

    def initialize(self) -> dict[str, object]:
        require_shared_root(self.paths.network_root)
        membership = load_membership(self.paths.protocol_root)
        membership.member_for(self.identity)
        pointer = load_snapshot_pointer(self.paths.protocol_root)
        if not self.database_path.is_file():
            self._install_snapshot(pointer)
        else:
            self.store.initialize()
            installed = self.store.installed_snapshot()
            if not installed.get("installed_snapshot_id"):
                if self.store.has_unverified_business_state():
                    raise SnapshotRequired(
                        "The existing business database has no verified synchronization "
                        "baseline and contains unsynchronized business data. It was left "
                        "unchanged to prevent data loss; migrate it through maintenance "
                        "before using this desktop installation."
                    )
                self._archive_unverified_database()
                self._install_snapshot(pointer)
            elif self._snapshot_replacement_required(installed, pointer):
                self._install_replacement_snapshot(pointer)
        self.actor_id = self.store.ensure_actor(self.identity)
        self._ensure_shared_actor()
        self.recover()
        self.sync()
        return self.status()

    def _install_snapshot(self, pointer: SnapshotPointer) -> None:
        source = snapshot_file(self.paths.protocol_root, pointer)
        install_snapshot(source, self.database_path, pointer)
        self.store = LocalStore(self.database_path)
        self.store.record_snapshot_install(
            snapshot_id=pointer.snapshot_id,
            snapshot_hash=pointer.sha256,
            snapshot_epoch_id=pointer.snapshot_epoch_id,
            coverage=dict(pointer.coverage),
        )

    def _archive_unverified_database(self) -> Path:
        """Preserve a baseline-less legacy database before replacement."""
        return self._archive_database("unverified")

    def _archive_database(self, reason: str) -> Path:
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        recovery_root = self.database_path.parent / "recovery"
        recovery_root.mkdir(parents=True, exist_ok=True)
        archived = recovery_root / (
            f"{self.database_path.stem}.{reason}-{timestamp}{self.database_path.suffix}"
        )
        os.replace(self.database_path, archived)
        for suffix in ("-wal", "-shm"):
            source = Path(f"{self.database_path}{suffix}")
            if source.exists():
                os.replace(source, Path(f"{archived}{suffix}"))
        return archived

    @staticmethod
    def _snapshot_replacement_required(
        installed: dict[str, object], pointer: SnapshotPointer
    ) -> bool:
        return (
            installed.get("installed_snapshot_id") != pointer.snapshot_id
            or installed.get("installed_snapshot_sha256") != pointer.sha256
            or installed.get("installed_snapshot_epoch_id") != pointer.snapshot_epoch_id
        )

    def _install_replacement_snapshot(self, pointer: SnapshotPointer) -> None:
        if self.store.has_pending_outbox():
            raise SnapshotRequired(
                "A newer shared schema snapshot is available, but this desktop has "
                "unpublished local work. Synchronize or resolve that work before "
                "installing the replacement snapshot."
            )
        self._archive_database("superseded")
        self._install_snapshot(pointer)
        self.actor_id = None

    def status(self) -> dict[str, object]:
        result = self.store.status()
        result.update(
            {
                "network_root": str(self.paths.network_root),
                "protocol_root": str(self.paths.protocol_root),
                "user_id": self.identity.user_id,
                "employee_number": self.identity.employee_number,
            }
        )
        try:
            require_shared_root(self.paths.network_root)
            pointer = load_snapshot_pointer(self.paths.protocol_root)
            result.update(
                {
                    "shared_available": True,
                    "current_snapshot_id": pointer.snapshot_id,
                    "current_snapshot_epoch_id": pointer.snapshot_epoch_id,
                }
            )
        except Exception as error:
            result.update(
                {
                    "shared_available": False,
                    "shared_error": str(error),
                    "mode": "degraded_read_only",
                }
            )
        else:
            result["mode"] = "ready"
        return result

    def sync(self) -> dict[str, int]:
        self._require_initialized()
        require_shared_root(self.paths.network_root)
        membership = load_membership(self.paths.protocol_root)
        membership.member_for(self.identity)
        pointer = load_snapshot_pointer(self.paths.protocol_root)
        installed = self.store.installed_snapshot()
        if self._snapshot_replacement_required(installed, pointer):
            self._install_replacement_snapshot(pointer)
            self.actor_id = self.store.ensure_actor(self.identity)
            self._ensure_shared_actor()
            self._ensure_registration(pointer, membership)
            self.recover()
        result = self._sync_epoch(pointer, membership)
        self._last_sync_monotonic = time.monotonic()
        return result

    def sync_if_due(self, *, interval_seconds: float = 60.0) -> bool:
        """Refresh read data at most once per interval for a live desktop session.

        Formal saves still call ``sync`` inside the authoritative save barrier.
        A transient unavailable share leaves the installed local replica readable;
        it does not convert an ordinary report-list read into a hard failure.
        """
        now = time.monotonic()
        if (
            self._last_sync_monotonic is not None
            and now - self._last_sync_monotonic < interval_seconds
        ):
            return False
        with self._read_sync_lock:
            now = time.monotonic()
            if (
                self._last_sync_monotonic is not None
                and now - self._last_sync_monotonic < interval_seconds
            ):
                return False
            try:
                self.sync()
            except (ConfigurationError, SnapshotRequired):
                raise
            except Exception:
                # Degraded read-only mode retains the last verified local state.
                return False
            return True

    def commit(self, mutations: Sequence[Mutation]) -> CommitResult:
        actor_id = self._require_initialized()
        require_shared_root(self.paths.network_root)
        lock_keys = [mutation.record_lock_key for mutation in mutations]
        lock_keys.extend(
            f"unique:{key}" for mutation in mutations for key in mutation.unique_lock_keys
        )
        epoch_lock = FileRangeLock(
            self.paths.epoch_lock,
            exclusive=False,
            timeout_seconds=self.lock_timeout_seconds,
        )
        actor_lock = FileRangeLock(
            self.paths.actor_lock,
            offset=actor_lock_offset(actor_id),
            exclusive=True,
            timeout_seconds=self.lock_timeout_seconds,
        )
        with epoch_lock:
            membership = load_membership(self.paths.protocol_root)
            member = membership.member_for(self.identity)
            if not bool(member.get("can_edit", True)):
                raise ProtocolViolation("The current member does not have formal-save permission.")
            pointer = load_snapshot_pointer(self.paths.protocol_root)
            with actor_lock:
                self._ensure_registration(pointer, membership)
                self._sync_epoch(pointer, membership)
                with record_locks(
                    self.paths.save_mutex_root,
                    lock_keys,
                    timeout_seconds=self.lock_timeout_seconds,
                ):
                    second_pointer = load_snapshot_pointer(self.paths.protocol_root)
                    if second_pointer.snapshot_epoch_id != pointer.snapshot_epoch_id:
                        raise ProtocolViolation("The snapshot epoch changed during formal save.")
                    self._sync_epoch(second_pointer, membership)
                    self.store.validate_revisions(mutations)
                    current_head = self._read_own_head()
                    self._recover_uncommitted_outbox(current_head)
                    self.store.align_next_actor_seq(
                        actor_id, current_head.highest_published_seq + 1
                    )
                    tx_id, operations = self.store.prepare_operations(
                        self.identity, actor_id, mutations
                    )
                    return self._publish_transaction(
                        tx_id=tx_id,
                        operations=operations,
                        previous_head=current_head,
                        pointer=pointer,
                    )

    def recover(self) -> dict[str, object]:
        actor_id = self._require_initialized()
        head = self._read_own_head()
        registration = ActorRegistration(
            actor_id=actor_id,
            user_id=self.identity.user_id,
            employee_number=self.identity.employee_number,
            snapshot_epoch_id="recovery",
            actor_root_relative_path=self._actor_root_relative(),
        )
        self._sync_registration(registration, head=head)
        self._recover_uncommitted_outbox(head)
        self.store.align_next_actor_seq(actor_id, head.highest_published_seq + 1)
        return {
            "actor_id": actor_id,
            "head_generation": head.generation,
            "highest_published_seq": head.highest_published_seq,
        }

    def get_entity(self, entity_type: str, entity_id: str) -> dict[str, object] | None:
        self.sync_if_due()
        return self.store.get_entity(entity_type, entity_id)

    def list_entities(self, entity_type: str) -> list[dict[str, object]]:
        self.sync_if_due()
        return self.store.list_entities(entity_type)

    def query_entities(
        self,
        entity_type: str,
        *,
        filters: Mapping[str, object] | None = None,
        order_by: Sequence[tuple[str, bool]] | None = None,
        limit: int | None = None,
        offset: int = 0,
        include_deleted: bool = False,
    ) -> list[dict[str, object]]:
        self.sync_if_due()
        return self.store.query_entities(
            entity_type,
            filters=filters,
            order_by=order_by,
            limit=limit,
            offset=offset,
            include_deleted=include_deleted,
        )

    def count_entities(
        self,
        entity_type: str,
        *,
        filters: Mapping[str, object] | None = None,
        include_deleted: bool = False,
    ) -> int:
        self.sync_if_due()
        return self.store.count_entities(
            entity_type,
            filters=filters,
            include_deleted=include_deleted,
        )

    def _publish_transaction(
        self,
        *,
        tx_id: str,
        operations: Sequence[Operation],
        previous_head: ActorHead,
        pointer: SnapshotPointer,
    ) -> CommitResult:
        actor_id = self._require_initialized()
        runtime_outbox = self.database_path.parent / "sync-runtime" / "outbox"
        runtime_outbox.mkdir(parents=True, exist_ok=True)
        temporary_package = runtime_outbox / f"{tx_id}.opdb"
        try:
            manifest = build_package(
                temporary_package,
                actor_id=actor_id,
                user_id=self.identity.user_id,
                employee_number=self.identity.employee_number,
                operations=operations,
                previous=previous_head.package,
            )
            now = datetime.now(UTC)
            relative_path = Path("operations") / f"{now.year:04d}" / f"{now.month:02d}" / (
                f"{manifest.first_seq}-{manifest.last_seq}-{manifest.package_id}.opdb"
            )
            destination = self._actor_root() / relative_path
            package_hash, package_size = publish_immutable_file(
                temporary_package, destination
            )
            self.store.mark_outbox(
                tx_id,
                "packaged",
                package_id=manifest.package_id,
                package_path=relative_path.as_posix(),
            )
            published_manifest, published_operations = read_package(
                destination,
                expected_hash=package_hash,
                expected_size=package_size,
            )
            if published_manifest != manifest:
                raise CorruptArtifact("Published package metadata changed during publication.")
            reference = PackageReference(
                package_id=manifest.package_id,
                relative_path=relative_path.as_posix(),
                sha256=package_hash,
                size_bytes=package_size,
                first_seq=manifest.first_seq,
                last_seq=manifest.last_seq,
            )
            new_head = ActorHead(
                actor_id=actor_id,
                employee_number=self.identity.employee_number,
                generation=previous_head.generation + 1,
                highest_published_seq=manifest.last_seq,
                package=reference,
                updated_at_utc=utc_now(),
            )
            atomic_replace_json(self._head_path(), new_head.to_dict())
            committed_head = self._read_own_head()
            if committed_head != new_head:
                raise CorruptArtifact("Actor head read-back did not match the committed head.")
            self.store.mark_outbox(tx_id, "published")
            self.store.apply_package(
                package_id=manifest.package_id,
                actor_id=actor_id,
                first_seq=manifest.first_seq,
                last_seq=manifest.last_seq,
                package_hash=package_hash,
                relative_path=relative_path.as_posix(),
                operations=published_operations,
            )
            self.store.update_actor_head(new_head)
            self.store.record_observed_head(new_head)
            self.store.mark_outbox(tx_id, "applied")
            self._write_acknowledgement(pointer, new_head, latest_sync_result="success")
            return CommitResult(
                tx_id=tx_id,
                package_id=manifest.package_id,
                actor_id=actor_id,
                first_seq=manifest.first_seq,
                last_seq=manifest.last_seq,
                head_generation=new_head.generation,
                affected_records=tuple(
                    sorted({(item.entity_type, item.entity_id) for item in operations})
                ),
            )
        except Exception as error:
            try:
                self.store.mark_outbox(tx_id, "error", error_code=type(error).__name__)
            except Exception:
                pass
            raise
        finally:
            temporary_package.unlink(missing_ok=True)

    def _sync_epoch(
        self, pointer: SnapshotPointer, membership: MembershipRelease
    ) -> dict[str, int]:
        registrations = self._list_registrations(pointer, membership)
        active_actor_ids = {item.actor_id for item in registrations}
        for actor_id, covered_seq in pointer.coverage.items():
            if actor_id not in active_actor_ids and self.store.cursor(actor_id) < covered_seq:
                raise SnapshotRequired(
                    "The current snapshot covers an actor that is no longer in the active registry."
                )
        result: dict[str, int] = {}
        for registration in registrations:
            result[registration.actor_id] = self._sync_registration(
                registration, pointer=pointer
            )
        return result

    def _sync_registration(
        self,
        registration: ActorRegistration,
        *,
        head: ActorHead | None = None,
        pointer: SnapshotPointer | None = None,
    ) -> int:
        actor_root = self._safe_protocol_path(registration.actor_root_relative_path)
        current_head = head or self._read_head(actor_root / "head.json", registration)
        observed = self.store.observed_head(current_head.actor_id)
        if observed:
            old_generation = int(observed["generation"])
            old_seq = int(observed["highest_published_seq"])
            if current_head.generation < old_generation or current_head.highest_published_seq < old_seq:
                raise ProtocolViolation("An actor head regressed after it was previously observed.")
            old_package = observed.get("package_id")
            new_package = current_head.package.package_id if current_head.package else None
            if current_head.generation == old_generation and old_package != new_package:
                raise ProtocolViolation("An actor head generation was reused with different content.")
        cursor = self.store.cursor(current_head.actor_id)
        # A log floor is the highest sequence compacted into the current
        # snapshot. A replica behind it must install that snapshot before it
        # can safely follow the remaining online package chain.
        active_pointer = pointer or load_snapshot_pointer(self.paths.protocol_root)
        log_floor = int(active_pointer.log_floor.get(current_head.actor_id, 0))
        if cursor < log_floor:
            raise SnapshotRequired(
                "The local replica is behind the shared retention floor and must "
                "install the current shared snapshot before synchronizing."
            )
        if current_head.highest_published_seq <= cursor:
            self.store.record_observed_head(current_head)
            return cursor
        packages: list[tuple[PackageReference, PackageManifest, list]] = []
        reference = current_head.package
        expected_last = current_head.highest_published_seq
        while reference and reference.last_seq > cursor:
            if reference.last_seq != expected_last:
                raise ProtocolViolation("The actor package chain contains a sequence gap.")
            package_path = self._safe_actor_path(actor_root, reference.relative_path)
            manifest, operations = read_package(
                package_path,
                expected_hash=reference.sha256,
                expected_size=reference.size_bytes,
            )
            self._validate_reference(reference, manifest, current_head.actor_id)
            packages.append((reference, manifest, operations))
            expected_last = manifest.first_seq - 1
            if manifest.first_seq <= cursor + 1:
                break
            if not all(
                value is not None
                for value in (
                    manifest.previous_package_id,
                    manifest.previous_package_sha256,
                    manifest.previous_package_path,
                    manifest.previous_first_seq,
                    manifest.previous_last_seq,
                    manifest.previous_size_bytes,
                )
            ):
                raise ProtocolViolation("The actor package chain ended before the local cursor.")
            reference = PackageReference(
                package_id=str(manifest.previous_package_id),
                relative_path=str(manifest.previous_package_path),
                sha256=str(manifest.previous_package_sha256),
                size_bytes=int(manifest.previous_size_bytes),
                first_seq=int(manifest.previous_first_seq),
                last_seq=int(manifest.previous_last_seq),
            )
        packages.reverse()
        next_seq = cursor + 1
        for package_reference, manifest, operations in packages:
            if manifest.first_seq != next_seq:
                raise ProtocolViolation(
                    f"Actor sequence gap: expected {next_seq}, found {manifest.first_seq}."
                )
            self.store.apply_package(
                package_id=manifest.package_id,
                actor_id=manifest.actor_id,
                first_seq=manifest.first_seq,
                last_seq=manifest.last_seq,
                package_hash=package_reference.sha256,
                relative_path=(
                    Path(registration.actor_root_relative_path)
                    / package_reference.relative_path
                ).as_posix(),
                operations=operations,
            )
            next_seq = manifest.last_seq + 1
        if next_seq - 1 != current_head.highest_published_seq:
            raise ProtocolViolation("The actor package chain did not reach the committed head.")
        self.store.record_observed_head(current_head)
        return current_head.highest_published_seq

    def _list_registrations(
        self, pointer: SnapshotPointer, membership: MembershipRelease
    ) -> list[ActorRegistration]:
        root = self.paths.epoch_registry(pointer.snapshot_epoch_id)
        if not root.is_dir():
            raise ProtocolViolation("The current snapshot epoch registry is unavailable.")
        registrations: list[ActorRegistration] = []
        seen: set[str] = set()
        for path in sorted(root.glob("actor-*.active.json")):
            value = read_json(path)
            try:
                registration = ActorRegistration(
                    actor_id=str(value["actor_id"]),
                    user_id=str(value["user_id"]),
                    employee_number=str(value["employee_number"]),
                    snapshot_epoch_id=str(value["snapshot_epoch_id"]),
                    actor_root_relative_path=str(value["actor_root_relative_path"]),
                )
            except KeyError as error:
                raise ProtocolViolation("The active-writer registry contains a malformed entry.") from error
            if int(value.get("protocol_version", -1)) != PROTOCOL_VERSION:
                raise ProtocolViolation("Active-writer protocol version is unsupported.")
            if registration.snapshot_epoch_id != pointer.snapshot_epoch_id:
                raise ProtocolViolation("An active-writer entry belongs to another epoch.")
            if registration.actor_id in seen:
                raise ProtocolViolation("The active-writer registry contains a duplicate actor.")
            member = membership.members.get(registration.user_id)
            if not member or str(member.get("employee_number")) != registration.employee_number:
                raise ProtocolViolation("An active writer is not valid in current membership.")
            expected = self._actor_root_relative_for(
                registration.employee_number, registration.actor_id
            )
            if registration.actor_root_relative_path != expected:
                raise ProtocolViolation("An active-writer actor path is not canonical.")
            self._safe_protocol_path(registration.actor_root_relative_path)
            seen.add(registration.actor_id)
            registrations.append(registration)
        return registrations

    def _ensure_registration(
        self, pointer: SnapshotPointer, membership: MembershipRelease
    ) -> ActorRegistration:
        actor_id = self._require_initialized()
        membership.member_for(self.identity)
        registry = self.paths.epoch_registry(pointer.snapshot_epoch_id)
        registry.mkdir(parents=True, exist_ok=True)
        path = registry / f"actor-{actor_id}.active.json"
        expected = {
            "protocol_version": PROTOCOL_VERSION,
            "schema_version": SCHEMA_VERSION,
            "snapshot_epoch_id": pointer.snapshot_epoch_id,
            "membership_generation": membership.generation,
            "actor_id": actor_id,
            "user_id": self.identity.user_id,
            "employee_number": self.identity.employee_number,
            "actor_root_relative_path": self._actor_root_relative(),
        }
        if path.exists():
            value = read_json(path)
            for key, item in expected.items():
                if value.get(key) != item:
                    raise ProtocolViolation("Existing active-writer registration is inconsistent.")
        else:
            publish_immutable_json({**expected, "registered_at_utc": utc_now()}, path)
        visible = {item.actor_id: item for item in self._list_registrations(pointer, membership)}
        if actor_id not in visible:
            raise ProtocolViolation("Active-writer registration is not visible after publication.")
        return visible[actor_id]

    def _ensure_shared_actor(self) -> None:
        actor_id = self._require_initialized()
        employee_root = self.paths.employee_root(self.identity)
        employee_root.mkdir(parents=True, exist_ok=True)
        resolved_users_root = (self.paths.protocol_root / "users").resolve()
        try:
            employee_root.resolve().relative_to(resolved_users_root)
        except ValueError as error:
            raise ProtocolViolation("Employee synchronization directory escapes the users root.") from error
        identity_path = employee_root / "identity.json"
        expected_identity = {
            "protocol_version": PROTOCOL_VERSION,
            "schema_version": SCHEMA_VERSION,
            "user_id": self.identity.user_id,
            "employee_number": self.identity.employee_number,
            "email": self.identity.email,
        }
        if identity_path.exists():
            existing = read_json(identity_path)
            for key, item in expected_identity.items():
                if existing.get(key) != item:
                    raise ProtocolViolation("Shared employee identity does not match this user.")
        else:
            publish_immutable_json(
                {**expected_identity, "created_at_utc": utc_now()}, identity_path
            )
        self._actor_root().mkdir(parents=True, exist_ok=True)
        if self._head_path().exists():
            self._read_own_head()
        else:
            atomic_replace_json(
                self._head_path(),
                ActorHead.empty(actor_id, self.identity.employee_number).to_dict(),
            )

    def _read_own_head(self) -> ActorHead:
        registration = ActorRegistration(
            actor_id=self._require_initialized(),
            user_id=self.identity.user_id,
            employee_number=self.identity.employee_number,
            snapshot_epoch_id="own",
            actor_root_relative_path=self._actor_root_relative(),
        )
        return self._read_head(self._head_path(), registration)

    def _read_head(self, path: Path, registration: ActorRegistration) -> ActorHead:
        head = ActorHead.from_dict(read_json(path))
        if head.actor_id != registration.actor_id:
            raise ProtocolViolation("Actor head does not match its registry actor.")
        if head.employee_number != registration.employee_number:
            raise ProtocolViolation("Actor head employee number is inconsistent.")
        if head.package and head.highest_published_seq != head.package.last_seq:
            raise ProtocolViolation("Actor head does not end at its latest package range.")
        if head.package and head.generation < 1:
            raise ProtocolViolation("A non-empty actor head must have a positive generation.")
        return head

    def _validate_reference(
        self, reference: PackageReference, manifest: PackageManifest, actor_id: str
    ) -> None:
        if manifest.actor_id != actor_id:
            raise ProtocolViolation("Operation package actor does not match the actor head.")
        if manifest.package_id != reference.package_id:
            raise ProtocolViolation("Operation package ID does not match the actor head.")
        if manifest.first_seq != reference.first_seq or manifest.last_seq != reference.last_seq:
            raise ProtocolViolation("Operation package range does not match the actor head.")

    def _recover_uncommitted_outbox(self, head: ActorHead) -> None:
        rows = self.store.outbox_rows(
            ["prepared", "packaged", "published", "error", "orphaned"]
        )
        for row in rows:
            last_seq = int(row["last_seq"])
            if self.store.cursor(head.actor_id) >= last_seq:
                self.store.mark_outbox(str(row["tx_id"]), "applied")
            elif int(row["first_seq"]) > head.highest_published_seq:
                self.store.mark_outbox(str(row["tx_id"]), "orphaned")
            else:
                raise ProtocolViolation(
                    "A prepared local transaction overlaps committed actor history."
                )

    def _write_acknowledgement(
        self,
        pointer: SnapshotPointer,
        head: ActorHead,
        *,
        latest_sync_result: str,
    ) -> None:
        status = self.store.status()
        atomic_replace_json(
            self._actor_root() / "acknowledgement.json",
            {
                "protocol_version": PROTOCOL_VERSION,
                "schema_version": SCHEMA_VERSION,
                "actor_id": head.actor_id,
                "user_id": self.identity.user_id,
                "employee_number": self.identity.employee_number,
                "installed_snapshot_id": status.get("installed_snapshot_id"),
                "snapshot_epoch_id": pointer.snapshot_epoch_id,
                "head_generation": head.generation,
                "highest_published_seq": head.highest_published_seq,
                "latest_sync_result": latest_sync_result,
                "prepared_count": status.get("prepared_transactions", 0),
                "open_conflicts": status.get("open_conflicts", 0),
                "updated_at_utc": utc_now(),
            },
        )

    def _require_initialized(self) -> str:
        if self.actor_id:
            return self.actor_id
        try:
            self.actor_id = str(self.store.actor_row()["actor_id"])
        except Exception as error:
            raise ProtocolViolation("DataCoordinator has not been initialized.") from error
        return self.actor_id

    def _actor_root(self) -> Path:
        return self.paths.actor_root(self.identity, self._require_initialized())

    def _head_path(self) -> Path:
        return self._actor_root() / "head.json"

    def _actor_root_relative(self) -> str:
        return self._actor_root_relative_for(
            self.identity.employee_number, self._require_initialized()
        )

    @staticmethod
    def _actor_root_relative_for(employee_number: str, actor_id: str) -> str:
        return f"users/emp-{employee_number}/actors/actor-{actor_id}"

    def _safe_protocol_path(self, relative_path: str) -> Path:
        relative = Path(relative_path)
        if relative.is_absolute():
            raise ProtocolViolation("A protocol relative path cannot be absolute.")
        root = self.paths.protocol_root.resolve()
        result = (root / relative).resolve()
        try:
            result.relative_to(root)
        except ValueError as error:
            raise ProtocolViolation("A protocol path escapes the shared protocol root.") from error
        return result

    @staticmethod
    def _safe_actor_path(actor_root: Path, relative_path: str) -> Path:
        relative = Path(relative_path)
        if relative.is_absolute():
            raise ProtocolViolation("An actor package path cannot be absolute.")
        root = actor_root.resolve()
        result = (root / relative).resolve()
        try:
            result.relative_to(root)
        except ValueError as error:
            raise ProtocolViolation("An actor package path escapes its actor root.") from error
        return result


def bootstrap_shared_store(
    network_root: Path,
    members: Iterable[Identity],
) -> dict[str, object]:
    """Create an empty protocol root for development or deployment maintenance."""

    member_list = list(members)
    if not member_list:
        raise ConfigurationError("At least one synchronization member is required.")
    if len({member.user_id for member in member_list}) != len(member_list):
        raise ConfigurationError("Synchronization member user IDs must be unique.")
    if len({member.employee_number for member in member_list}) != len(member_list):
        raise ConfigurationError("Synchronization member employee numbers must be unique.")
    paths = SyncPaths(network_root)
    network_root.mkdir(parents=True, exist_ok=True)
    protocol_root = paths.protocol_root
    if paths.membership_current.exists() or paths.snapshots_current.exists():
        raise ConfigurationError("The shared synchronization store is already initialized.")
    for directory in (
        protocol_root / "membership" / "releases",
        protocol_root / "users",
        protocol_root / "snapshots",
        protocol_root / "activity" / "epochs",
        paths.save_mutex_root,
        protocol_root / "audit" / "reports",
        protocol_root / "maintenance" / "reports",
        protocol_root / "quarantine",
        protocol_root / "archive",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    for lock_path in (paths.epoch_lock, paths.actor_lock):
        lock_path.touch(exist_ok=True)
    for index in range(256):
        (paths.save_mutex_root / f"stripe-{index:03d}.lck").touch(exist_ok=True)

    release_id = str(uuid.uuid4())
    release = membership_payload(
        member_list, generation=1, release_id=release_id, created_at_utc=utc_now()
    )
    release_bytes = (canonical_json(release) + "\n").encode("utf-8")
    release_hash = hashlib.sha256(release_bytes).hexdigest()
    release_name = f"00000001-{release_hash}.json"
    release_path = protocol_root / "membership" / "releases" / release_name
    publish_immutable_json(release, release_path)
    atomic_replace_json(
        paths.membership_current,
        {
            "protocol_version": PROTOCOL_VERSION,
            "coordinator_version": COORDINATOR_VERSION,
            "python_runtime_version": PYTHON_RUNTIME_VERSION,
            "generation": 1,
            "release_id": release_id,
            "relative_path": f"releases/{release_name}",
            "sha256": release_hash,
            "size_bytes": len(release_bytes),
            "updated_at_utc": utc_now(),
        },
    )

    snapshot_id = str(uuid.uuid4())
    snapshot_epoch_id = f"epoch-{uuid.uuid4()}"
    with tempfile.TemporaryDirectory(prefix="portal-sync-bootstrap-") as temporary:
        candidate = Path(temporary) / "snapshot.db"
        create_empty_snapshot(
            candidate,
            snapshot_id=snapshot_id,
            snapshot_epoch_id=snapshot_epoch_id,
        )
        snapshot_hash = sha256_file(candidate)
        snapshot_name = f"snapshot-{snapshot_id}-{snapshot_hash}.db"
        final_snapshot = protocol_root / "snapshots" / snapshot_name
        published_hash, published_size = publish_immutable_file(candidate, final_snapshot)
        validate_snapshot(
            final_snapshot,
            SnapshotPointer(
                snapshot_id=snapshot_id,
                snapshot_epoch_id=snapshot_epoch_id,
                relative_path=snapshot_name,
                sha256=published_hash,
                size_bytes=published_size,
                replication_profile="all",
                coverage={},
                log_floor={},
            ),
        )
    paths.epoch_registry(snapshot_epoch_id).mkdir(parents=True, exist_ok=True)
    atomic_replace_json(
        paths.snapshots_current,
        {
            "protocol_version": PROTOCOL_VERSION,
            "schema_version": SCHEMA_VERSION,
            "coordinator_version": COORDINATOR_VERSION,
            "python_runtime_version": PYTHON_RUNTIME_VERSION,
            "snapshot_id": snapshot_id,
            "snapshot_epoch_id": snapshot_epoch_id,
            "relative_path": snapshot_name,
            "sha256": published_hash,
            "size_bytes": published_size,
            "replication_profile": "all",
            "coverage": {},
            "log_floor": {},
            "created_at_utc": utc_now(),
        },
    )
    return {
        "network_root": str(network_root),
        "protocol_root": str(protocol_root),
        "membership_release_id": release_id,
        "snapshot_id": snapshot_id,
        "snapshot_epoch_id": snapshot_epoch_id,
        "members": len(member_list),
    }
