from __future__ import annotations

import json
import os
from pathlib import Path
from threading import RLock
from typing import Any


_LOCK = RLock()
_CACHED_MANIFEST: tuple[Path, int, dict[str, dict[str, Any]]] | None = None


def _desktop_mode() -> bool:
    return os.getenv("PORTAL_DESKTOP_MODE", "").strip().lower() in {"1", "true", "yes", "on"}


def source_cache_manifest_path() -> Path | None:
    value = os.getenv("PORTAL_SOURCE_CACHE_MANIFEST", "").strip()
    return Path(value).expanduser() if value else None


def _sources() -> dict[str, dict[str, Any]]:
    path = source_cache_manifest_path()
    if path is None or not path.is_file():
        return {}
    try:
        modified = path.stat().st_mtime_ns
    except OSError:
        return {}
    global _CACHED_MANIFEST
    with _LOCK:
        if _CACHED_MANIFEST and _CACHED_MANIFEST[0] == path and _CACHED_MANIFEST[1] == modified:
            return _CACHED_MANIFEST[2]
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            return {}
        raw_sources = payload.get("sources") if isinstance(payload, dict) else None
        if not isinstance(raw_sources, dict):
            return {}
        sources = {
            str(source_id): value
            for source_id, value in raw_sources.items()
            if isinstance(value, dict)
        }
        _CACHED_MANIFEST = (path, modified, sources)
        return sources


def resolve_source(source_id: str, fallback: str = "", *, label: str | None = None) -> str:
    logical_id = str(source_id or "").strip()
    if logical_id:
        source = _sources().get(logical_id)
        path_value = str((source or {}).get("localPath") or "").strip()
        if path_value and Path(path_value).is_file():
            return path_value
        if _desktop_mode():
            manifest = source_cache_manifest_path()
            cache_root = manifest.parent if manifest is not None else Path("source-cache")
            safe_id = "".join(
                character if character.isalnum() or character in "-_." else "_"
                for character in logical_id
            )
            file_name = Path(str(fallback or "source.data")).name or "source.data"
            # Return a deterministic local-only unavailable path. This lets the
            # worker authenticate from the packaged catalog while optional
            # resources report their own missing source; it never falls back to G:.
            return str(cache_root / "unavailable" / safe_id / file_name)
    return str(fallback or "").strip()


def resolve_file_name(file_name: str) -> Path | None:
    result = resolve_file_info(file_name)
    return result[0] if result else None


def resolve_file_info(file_name: str) -> tuple[Path, str] | None:
    expected = Path(file_name).name
    for source in _sources().values():
        path_value = str(source.get("localPath") or "").strip()
        path = Path(path_value) if path_value else None
        if path and path.name == expected and path.is_file():
            return path, str(source.get("version") or "")
    return None


def source_info(source_id: str) -> dict[str, Any]:
    """Return non-sensitive publication metadata for an active cached source."""

    source = _sources().get(str(source_id or "").strip())
    if not source:
        return {}
    return {
        key: source.get(key)
        for key in ("version", "publishedAt", "publicationTimestamp", "localPath", "sourceId")
        if source.get(key) not in (None, "")
    }
