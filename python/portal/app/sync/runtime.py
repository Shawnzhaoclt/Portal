from __future__ import annotations

from threading import RLock
from typing import Any

from .coordinator import DataCoordinator
from .models import Identity


_coordinator: DataCoordinator | None = None
_identity_key: tuple[str, str] | None = None
_lock = RLock()


def sync_identity(user: Any) -> Identity:
    """The synchronization identity of this installation.

    Operations belong to the desktop's own actor, which is the signed-in
    account. An access preview still writes the previewed user into the
    business records and still answers to that user's permissions, but the sync
    stream stays the device's own: the local store holds one actor per
    installation, and the shared log orders an actor's operations by a sequence
    only that installation may advance. Borrowing the previewed user's identity
    would fork that sequence, so the store refuses it outright.
    """
    preview = getattr(user, "_portal_test_access", None)
    if isinstance(preview, dict) and preview.get("actor_user_id"):
        return Identity(
            user_id=str(preview.get("actor_user_id")),
            employee_number=str(preview.get("actor_employee_id") or "").strip(),
            email=str(preview.get("actor_email") or ""),
        )
    return Identity(
        user_id=str(user.id),
        employee_number=str(user.employee_id or "").strip(),
        email=str(user.email),
    )


def current_coordinator(identity: Identity, *, initialize: bool = True) -> DataCoordinator:
    """Return the single local coordinator for the signed-in desktop identity."""
    global _coordinator, _identity_key

    key = (identity.user_id, identity.employee_number)
    with _lock:
        if _coordinator is None or _identity_key != key:
            _coordinator = DataCoordinator.from_desktop_config(identity)
            _identity_key = key
        if initialize and _coordinator.actor_id is None:
            _coordinator.initialize()
        return _coordinator
