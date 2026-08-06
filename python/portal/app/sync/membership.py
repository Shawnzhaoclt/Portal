from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from .errors import IdentityRejected, ProtocolViolation
from .models import (
    COORDINATOR_VERSION,
    PYTHON_RUNTIME_VERSION,
    Identity,
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
)
from .storage import read_json, sha256_file


@dataclass(frozen=True)
class MembershipRelease:
    generation: int
    release_id: str
    relative_path: str
    members: Mapping[str, Mapping[str, Any]]

    def member_for(self, identity: Identity) -> Mapping[str, Any]:
        member = self.members.get(identity.user_id)
        if not member:
            raise IdentityRejected("The current user is not in the synchronization membership.")
        if str(member.get("employee_number", "")) != identity.employee_number:
            raise IdentityRejected(
                "The employee number does not match the synchronization membership."
            )
        if not bool(member.get("active", True)):
            raise IdentityRejected("The synchronization membership is inactive.")
        return member


def load_membership(protocol_root: Path) -> MembershipRelease:
    pointer_path = protocol_root / "membership" / "current.json"
    if not pointer_path.is_file():
        raise ProtocolViolation(
            "The shared synchronization repository has not published a membership release."
        )
    pointer = read_json(pointer_path)
    if int(pointer.get("protocol_version", -1)) != PROTOCOL_VERSION:
        raise ProtocolViolation("Membership protocol version is unsupported.")
    relative_path = str(pointer.get("relative_path", ""))
    release_path = _safe_child(protocol_root / "membership", relative_path)
    expected_hash = str(pointer.get("sha256", ""))
    expected_size = int(pointer.get("size_bytes", -1))
    if not release_path.is_file() or release_path.stat().st_size != expected_size:
        raise ProtocolViolation("The current membership release is unavailable or incomplete.")
    if sha256_file(release_path) != expected_hash:
        raise ProtocolViolation("The current membership release hash is invalid.")
    release = read_json(release_path)
    if int(release.get("protocol_version", -1)) != PROTOCOL_VERSION:
        raise ProtocolViolation("Membership release protocol version is unsupported.")
    if int(release.get("schema_version", -1)) != SCHEMA_VERSION:
        raise ProtocolViolation("Membership release schema version is unsupported.")
    if release.get("coordinator_version") != COORDINATOR_VERSION:
        raise ProtocolViolation("Membership release coordinator version is unsupported.")
    # Python is an implementation detail, not a wire-format compatibility boundary.
    # Keep the recorded version for diagnostics, but allow a packaged client or
    # workstation coordinator to read releases produced by another Python build.
    members_value = release.get("members")
    if not isinstance(members_value, list):
        raise ProtocolViolation("Membership release does not contain a member list.")
    members: dict[str, Mapping[str, Any]] = {}
    for item in members_value:
        if not isinstance(item, dict) or not str(item.get("user_id", "")).strip():
            raise ProtocolViolation("Membership release contains an invalid member.")
        user_id = str(item["user_id"])
        if user_id in members:
            raise ProtocolViolation("Membership release contains a duplicate user ID.")
        members[user_id] = item
    return MembershipRelease(
        generation=int(release.get("generation", pointer.get("generation", 0))),
        release_id=str(release.get("release_id", pointer.get("release_id", ""))),
        relative_path=relative_path,
        members=members,
    )


def membership_payload(
    members: Iterable[Identity], *, generation: int, release_id: str, created_at_utc: str
) -> dict[str, object]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "schema_version": SCHEMA_VERSION,
        "coordinator_version": COORDINATOR_VERSION,
        "python_runtime_version": PYTHON_RUNTIME_VERSION,
        "generation": generation,
        "release_id": release_id,
        "created_at_utc": created_at_utc,
        "members": [
            {
                "user_id": identity.user_id,
                "employee_number": identity.employee_number,
                "email": identity.email,
                "active": True,
                "can_edit": True,
            }
            for identity in sorted(members, key=lambda value: value.user_id)
        ],
    }


def _safe_child(root: Path, relative_path: str) -> Path:
    if not relative_path or Path(relative_path).is_absolute():
        raise ProtocolViolation("A control-plane relative path is invalid.")
    root_resolved = root.resolve()
    result = (root / relative_path).resolve()
    try:
        result.relative_to(root_resolved)
    except ValueError as error:
        raise ProtocolViolation("A control-plane path escapes its configured root.") from error
    return result
