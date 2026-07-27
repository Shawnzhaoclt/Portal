from __future__ import annotations

import hashlib
import json
import platform
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

from .errors import IdentityRejected, ProtocolViolation

PROTOCOL_VERSION = 1
SCHEMA_VERSION = 1
COORDINATOR_VERSION = "0.1.0"
PYTHON_RUNTIME_VERSION = platform.python_version()
_EMPLOYEE_NUMBER = re.compile(r"^[0-9]{1,20}$")
_OPERATION_TYPES = {
    "insert_entity",
    "update_fields",
    "update_geometry",
    "update_entity",
    "delete_entity",
    "restore_entity",
    "transfer_owner",
    "resolve_conflict",
    "append_event",
    "protocol_noop",
}


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def output_revision(operation_id: str) -> str:
    return f"sha256:{sha256_bytes(('operation:' + operation_id).encode('utf-8'))}"


@dataclass(frozen=True)
class Identity:
    user_id: str
    employee_number: str
    email: str = ""

    def __post_init__(self) -> None:
        if not self.user_id.strip():
            raise IdentityRejected("The synchronization user ID is empty.")
        if not _EMPLOYEE_NUMBER.fullmatch(self.employee_number):
            raise IdentityRejected(
                "Employee number must contain 1 to 20 ASCII digits.",
                details={"employee_number": self.employee_number},
            )

    @property
    def employee_directory(self) -> str:
        return f"emp-{self.employee_number}"


@dataclass(frozen=True)
class Mutation:
    entity_type: str
    entity_id: str
    operation_type: str
    base_record_revision: str | None
    values: Mapping[str, Any] = field(default_factory=dict)
    geometry: bytes | None = None
    unique_lock_keys: Sequence[str] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if not self.entity_type.strip() or not self.entity_id.strip():
            raise ProtocolViolation("Mutation entity type and ID are required.")
        if self.operation_type not in _OPERATION_TYPES:
            raise ProtocolViolation(f"Unsupported operation type: {self.operation_type}")
        try:
            canonical_json(dict(self.values))
        except (TypeError, ValueError) as error:
            raise ProtocolViolation("Mutation values must be canonical JSON values.") from error

    @property
    def record_lock_key(self) -> str:
        return f"record:{self.entity_type}:{self.entity_id}"


@dataclass(frozen=True)
class Operation:
    operation_id: str
    tx_id: str
    tx_index: int
    tx_count: int
    actor_id: str
    actor_seq: int
    user_id: str
    entity_type: str
    entity_id: str
    operation_type: str
    base_record_revision: str | None
    values: Mapping[str, Any]
    geometry: bytes | None
    created_at_utc: str

    @classmethod
    def from_mutation(
        cls,
        mutation: Mutation,
        *,
        tx_id: str,
        tx_index: int,
        tx_count: int,
        actor_id: str,
        actor_seq: int,
        user_id: str,
    ) -> "Operation":
        return cls(
            operation_id=str(uuid.uuid4()),
            tx_id=tx_id,
            tx_index=tx_index,
            tx_count=tx_count,
            actor_id=actor_id,
            actor_seq=actor_seq,
            user_id=user_id,
            entity_type=mutation.entity_type,
            entity_id=mutation.entity_id,
            operation_type=mutation.operation_type,
            base_record_revision=mutation.base_record_revision,
            values=dict(mutation.values),
            geometry=mutation.geometry,
            created_at_utc=utc_now(),
        )

    @property
    def revision(self) -> str:
        return output_revision(self.operation_id)

    @property
    def sort_key(self) -> tuple[str, int, str]:
        return (self.actor_id, self.actor_seq, self.operation_id)

    def payload(self) -> dict[str, Any]:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "schema_version": SCHEMA_VERSION,
            "operation_id": self.operation_id,
            "tx_id": self.tx_id,
            "tx_index": self.tx_index,
            "tx_count": self.tx_count,
            "actor_id": self.actor_id,
            "actor_seq": self.actor_seq,
            "user_id": self.user_id,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "operation_type": self.operation_type,
            "base_record_revision": self.base_record_revision,
            "values": dict(self.values),
            "created_at_utc": self.created_at_utc,
        }


@dataclass(frozen=True)
class PackageReference:
    package_id: str
    relative_path: str
    sha256: str
    size_bytes: int
    first_seq: int
    last_seq: int


@dataclass(frozen=True)
class ActorHead:
    actor_id: str
    employee_number: str
    generation: int
    highest_published_seq: int
    package: PackageReference | None
    updated_at_utc: str

    @classmethod
    def empty(cls, actor_id: str, employee_number: str) -> "ActorHead":
        return cls(actor_id, employee_number, 0, 0, None, utc_now())

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ActorHead":
        try:
            package_value = value.get("latest_package", value.get("package"))
            package = PackageReference(**package_value) if package_value else None
            head = cls(
                actor_id=str(value["actor_id"]),
                employee_number=str(value["employee_number"]),
                generation=int(value["generation"]),
                highest_published_seq=int(value["highest_published_seq"]),
                package=package,
                updated_at_utc=str(value["updated_at_utc"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ProtocolViolation("Actor head is malformed.") from error
        if (head.package is None) != (head.highest_published_seq == 0):
            raise ProtocolViolation("Actor head package and sequence are inconsistent.")
        return head

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "actor_id": self.actor_id,
            "employee_number": self.employee_number,
            "generation": self.generation,
            "highest_published_seq": self.highest_published_seq,
            "latest_package": vars(self.package) if self.package else None,
            "updated_at_utc": self.updated_at_utc,
        }


@dataclass(frozen=True)
class SyncPaths:
    network_root: Path

    @property
    def protocol_root(self) -> Path:
        return self.network_root / "protocol-v1"

    @property
    def membership_current(self) -> Path:
        return self.protocol_root / "membership" / "current.json"

    @property
    def snapshots_current(self) -> Path:
        return self.protocol_root / "snapshots" / "current.json"

    @property
    def coordination(self) -> Path:
        return self.protocol_root / "coordination"

    @property
    def epoch_lock(self) -> Path:
        return self.coordination / "epoch-transition.lck"

    @property
    def actor_lock(self) -> Path:
        return self.coordination / "actor-publication.lck"

    @property
    def save_mutex_root(self) -> Path:
        return self.coordination / "save-mutexes"

    def employee_root(self, identity: Identity) -> Path:
        return self.protocol_root / "users" / identity.employee_directory

    def actor_root(self, identity: Identity, actor_id: str) -> Path:
        return self.employee_root(identity) / "actors" / f"actor-{actor_id}"

    def actor_head(self, identity: Identity, actor_id: str) -> Path:
        return self.actor_root(identity, actor_id) / "head.json"

    def epoch_registry(self, epoch_id: str) -> Path:
        return self.protocol_root / "activity" / "epochs" / epoch_id / "actors"
