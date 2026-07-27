from __future__ import annotations

import ctypes
import hashlib
import json
import os
import random
import time
import uuid
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator, Mapping, Sequence

from .errors import CorruptArtifact, LockTimeout, ProtocolViolation, SharedRootUnavailable
from .models import canonical_json


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sqlite_readonly_uri(path: Path, *, immutable: bool = False) -> str:
    """Build a SQLite read-only URI that also works for Windows UNC paths."""

    normalized = path.resolve().as_posix()
    # SQLite rejects `file://server/share/...` on Windows as a non-local URI
    # authority. Four slashes preserve the UNC path as a local SQLite filename.
    if normalized.startswith("//"):
        normalized = f"//{normalized}"
    query = "mode=ro"
    if immutable:
        query += "&immutable=1"
    return f"file:{normalized}?{query}"


def read_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise CorruptArtifact(f"Could not read valid JSON from {path}.") from error
    if not isinstance(value, dict):
        raise CorruptArtifact(f"Expected a JSON object in {path}.")
    return value


def _write_and_flush(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def atomic_replace_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.part")
    try:
        _write_and_flush(temporary, data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_replace_json(path: Path, value: Mapping[str, object]) -> None:
    atomic_replace_bytes(path, (canonical_json(dict(value)) + "\n").encode("utf-8"))


def publish_immutable_bytes(data: bytes, destination: Path) -> tuple[str, int]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_source = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.source")
    try:
        _write_and_flush(temporary_source, data)
        return publish_immutable_file(temporary_source, destination)
    finally:
        temporary_source.unlink(missing_ok=True)


def publish_immutable_json(
    value: Mapping[str, object], destination: Path
) -> tuple[str, int]:
    return publish_immutable_bytes(
        (canonical_json(dict(value)) + "\n").encode("utf-8"), destination
    )


def publish_immutable_file(source: Path, destination: Path) -> tuple[str, int]:
    """Publish a complete file without ever overwriting an immutable destination."""

    destination.parent.mkdir(parents=True, exist_ok=True)
    expected_hash = sha256_file(source)
    expected_size = source.stat().st_size
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.part")
    try:
        with source.open("rb") as input_stream, temporary.open("xb") as output_stream:
            for block in iter(lambda: input_stream.read(1024 * 1024), b""):
                output_stream.write(block)
            output_stream.flush()
            os.fsync(output_stream.fileno())
        if sha256_file(temporary) != expected_hash or temporary.stat().st_size != expected_size:
            raise CorruptArtifact(f"Staged immutable artifact failed verification: {destination}")
        try:
            _move_no_replace(temporary, destination)
        except FileExistsError:
            if destination.stat().st_size != expected_size or sha256_file(destination) != expected_hash:
                raise CorruptArtifact(f"Immutable artifact name collision at {destination}.")
        if destination.stat().st_size != expected_size or sha256_file(destination) != expected_hash:
            raise CorruptArtifact(f"Published immutable artifact failed read-back: {destination}")
        return expected_hash, expected_size
    finally:
        temporary.unlink(missing_ok=True)


def _move_no_replace(source: Path, destination: Path) -> None:
    if os.name == "nt":
        move_file = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileExW
        move_file.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
        move_file.restype = ctypes.c_int
        if move_file(str(source), str(destination), 0x00000008):
            return
        error = ctypes.get_last_error()
        if error in {80, 183}:
            raise FileExistsError(destination)
        raise OSError(error, os.strerror(error), str(destination))
    try:
        os.link(source, destination)
    except FileExistsError:
        raise
    source.unlink()


def require_shared_root(root: Path) -> None:
    if not root.is_dir():
        raise SharedRootUnavailable(f"The business synchronization root is unavailable: {root}")


def _lock_offset(key: str) -> int:
    return int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "little")


class _Overlapped(ctypes.Structure):
    _fields_ = [
        ("Internal", ctypes.c_void_p),
        ("InternalHigh", ctypes.c_void_p),
        ("Offset", ctypes.c_uint32),
        ("OffsetHigh", ctypes.c_uint32),
        ("hEvent", ctypes.c_void_p),
    ]


class FileRangeLock:
    def __init__(
        self,
        path: Path,
        *,
        offset: int = 0,
        exclusive: bool = True,
        timeout_seconds: float = 5.0,
    ) -> None:
        self.path = path
        self.offset = offset
        self.exclusive = exclusive
        self.timeout_seconds = timeout_seconds
        self._stream = None
        self._overlapped = None

    def __enter__(self) -> "FileRangeLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._stream = self.path.open("a+b", buffering=0)
        if os.name != "nt":
            return self
        import msvcrt

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        lock_file = kernel.LockFileEx
        lock_file.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.POINTER(_Overlapped),
        ]
        lock_file.restype = ctypes.c_int
        handle = msvcrt.get_osfhandle(self._stream.fileno())
        offset = self.offset & 0xFFFFFFFFFFFFFFFF
        self._overlapped = _Overlapped(
            Offset=offset & 0xFFFFFFFF,
            OffsetHigh=(offset >> 32) & 0xFFFFFFFF,
        )
        flags = 0x00000001 | (0x00000002 if self.exclusive else 0)
        deadline = time.monotonic() + self.timeout_seconds
        while not lock_file(handle, flags, 0, 1, 0, ctypes.byref(self._overlapped)):
            error = ctypes.get_last_error()
            if error not in {32, 33, 158} or time.monotonic() >= deadline:
                self._stream.close()
                self._stream = None
                raise LockTimeout(
                    f"Timed out acquiring synchronization lock {self.path}.",
                    details={"windows_error": error, "offset": self.offset},
                )
            time.sleep(random.uniform(0.1, 0.5))
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        if self._stream is None:
            return
        if os.name == "nt" and self._overlapped is not None:
            import msvcrt

            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            handle = msvcrt.get_osfhandle(self._stream.fileno())
            kernel.UnlockFileEx(handle, 0, 1, 0, ctypes.byref(self._overlapped))
        self._stream.close()
        self._stream = None


@contextmanager
def record_locks(root: Path, keys: Sequence[str], timeout_seconds: float = 5.0) -> Iterator[None]:
    normalized = sorted({_lock_offset(key): key for key in keys}.items())
    with ExitStack() as stack:
        for offset, _key in normalized:
            stripe = root / f"stripe-{offset & 0xFF:03d}.lck"
            stack.enter_context(
                FileRangeLock(stripe, offset=offset >> 8, timeout_seconds=timeout_seconds)
            )
        yield


def actor_lock_offset(actor_id: str) -> int:
    if not actor_id:
        raise ProtocolViolation("Actor ID is required for publication locking.")
    return _lock_offset(actor_id)
