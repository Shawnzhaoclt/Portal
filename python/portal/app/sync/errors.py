from __future__ import annotations


class SyncError(RuntimeError):
    """Base error with a stable code suitable for the desktop UI."""

    code = "SYNC_ERROR"

    def __init__(self, message: str, *, details: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.details = details or {}


class ConfigurationError(SyncError):
    code = "SYNC_CONFIGURATION_INVALID"


class SharedRootUnavailable(SyncError):
    code = "SYNC_SHARED_ROOT_UNAVAILABLE"


class ProtocolViolation(SyncError):
    code = "SYNC_PROTOCOL_VIOLATION"


class IdentityRejected(SyncError):
    code = "SYNC_IDENTITY_REJECTED"


class LockTimeout(SyncError):
    code = "SYNC_LOCK_TIMEOUT"


class RevisionChanged(SyncError):
    code = "SYNC_REVISION_CHANGED"


class SnapshotRequired(SyncError):
    code = "SYNC_SNAPSHOT_REQUIRED"


class CorruptArtifact(SyncError):
    code = "SYNC_CORRUPT_ARTIFACT"

