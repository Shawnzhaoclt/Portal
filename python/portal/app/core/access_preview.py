"""Requests a read-only access preview may still make.

A preview blocks every request that is not a GET, which is the right default:
those are the ones that change Portal data. A few POSTs change nothing in
Portal at all - they ask about the computer's own ITpipes session, which belongs
to the person at the keyboard rather than to the previewed user. Blocking those
leaves the ITpipes sign-in window waiting forever for a probe that can never
answer, so they are named here and allowed through.
"""

from __future__ import annotations

# The gate asks whether this machine's ITpipes sign-in is still valid, and the
# manifest lists media through that same session. Neither writes Portal data.
DEVICE_SESSION_PATHS = frozenset(
    {
        "/api/amteam/itpipes/session",
        "/api/amteam/itpipes/manifest",
    }
)


def is_preview_safe(path: str) -> bool:
    """Whether a read-only preview may issue this request despite its method."""
    return str(path or "").rstrip("/") in DEVICE_SESSION_PATHS
