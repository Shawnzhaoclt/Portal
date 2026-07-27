from __future__ import annotations

from threading import RLock

from .coordinator import DataCoordinator
from .models import Identity


_coordinator: DataCoordinator | None = None
_identity_key: tuple[str, str] | None = None
_lock = RLock()


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
