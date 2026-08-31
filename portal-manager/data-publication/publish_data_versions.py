from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time
from typing import Any, Iterator


MANIFEST_SCHEMA_VERSION = 1
LOCK_RETRY_SECONDS = 30.0
LOCK_POLL_SECONDS = 0.25


class PublicationError(RuntimeError):
    """Raised when a producer output cannot be safely registered."""


def _environment_root(shared_root: Path, environment: str) -> Path:
    """Mirror of the software release channels: test publications live in an
    isolated subtree so production desktops never see them."""
    normalized = (environment or "production").strip().lower()
    if normalized == "production":
        return shared_root
    if normalized == "test":
        return shared_root / "test"
    raise PublicationError("environment must be production or test.")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_text(value: datetime | None = None) -> str:
    return (value or _utc_now()).isoformat(timespec="seconds").replace("+00:00", "Z")


def _utc_token(value: datetime | None = None) -> str:
    return (value or _utc_now()).strftime("%Y%m%dT%H%M%SZ")


def _release_token(value: datetime | None = None) -> str:
    return (value or _utc_now()).strftime("%Y%m%dT%H%M%S%fZ")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise PublicationError(f"Configuration file was not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise PublicationError(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise PublicationError(f"Expected a JSON object in {path}")
    return value


def _write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _expand_text(value: str, variables: dict[str, str]) -> str:
    expanded = value
    for name, replacement in variables.items():
        expanded = expanded.replace(f"${{{name}}}", replacement)
    return os.path.expandvars(os.path.expanduser(expanded))


def _resolve_path(value: str, *, base: Path, variables: dict[str, str]) -> Path:
    candidate = Path(_expand_text(value, variables))
    return candidate if candidate.is_absolute() else (base / candidate).resolve()


def _relative_source(path: Path, shared_root: Path) -> str:
    try:
        return path.resolve().relative_to(shared_root.resolve()).as_posix()
    except ValueError as exc:
        raise PublicationError(
            f"Published source must remain below the shared data root: {path}"
        ) from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _normalized_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _duckdb_schema(path: Path) -> str:
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise PublicationError(
            "DuckDB validation requires the duckdb Python package in the producer environment."
        ) from exc
    connection = duckdb.connect(str(path), read_only=True)
    try:
        tables = connection.execute(
            """
            SELECT table_schema, table_name, table_type
            FROM information_schema.tables
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
            ORDER BY table_schema, table_name
            """
        ).fetchall()
        columns = connection.execute(
            """
            SELECT table_schema, table_name, ordinal_position, column_name,
                   data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
            ORDER BY table_schema, table_name, ordinal_position
            """
        ).fetchall()
        if not tables:
            raise PublicationError(f"DuckDB database has no published tables: {path}")
        return _normalized_hash({"tables": tables, "columns": columns})
    finally:
        connection.close()


def _sqlite_schema(path: Path) -> str:
    # SQLite URI authorities are not enabled in the standard Windows build, so
    # ``file://server/share/...`` fails for mapped drives that resolve to UNC
    # paths. The source has already been verified to exist; opening the native
    # Windows path and immediately enabling query_only preserves read-only
    # validation without depending on URI authority support.
    connection = sqlite3.connect(os.fspath(path))
    try:
        connection.execute("PRAGMA query_only = ON")
        quick_check = connection.execute("PRAGMA quick_check").fetchone()
        if not quick_check or str(quick_check[0]).lower() != "ok":
            raise PublicationError(f"SQLite quick_check failed for {path}: {quick_check}")
        rows = connection.execute(
            """
            SELECT type, name, tbl_name, COALESCE(sql, '')
            FROM sqlite_master
            WHERE type IN ('table', 'index', 'view', 'trigger')
              AND name NOT LIKE 'sqlite_%'
            ORDER BY type, name
            """
        ).fetchall()
        if not rows:
            raise PublicationError(f"SQLite database has no published schema: {path}")
        return _normalized_hash(rows)
    finally:
        connection.close()


def _pmtiles_schema(path: Path, source: dict[str, Any]) -> str:
    with path.open("rb") as handle:
        magic = handle.read(7)
    if magic != b"PMTiles":
        raise PublicationError(f"Invalid PMTiles header: {path}")
    sidecar_value = str(source.get("sidecar") or "").strip()
    if sidecar_value:
        sidecar = path.parent / sidecar_value if not Path(sidecar_value).is_absolute() else Path(sidecar_value)
        sidecar_json = _read_json(sidecar)
        return _normalized_hash(sidecar_json)
    return hashlib.sha256(magic).hexdigest()


def _tiff_schema(path: Path) -> str:
    with path.open("rb") as handle:
        header = handle.read(16)
    classic_tiff = header.startswith(b"II*\x00") or header.startswith(b"MM\x00*")
    big_tiff = header.startswith(b"II+\x00") or header.startswith(b"MM\x00+")
    if not (classic_tiff or big_tiff):
        raise PublicationError(f"Invalid TIFF/COG header: {path}")
    return hashlib.sha256(header).hexdigest()


def _json_schema(path: Path) -> str:
    return _normalized_hash(_read_json(path))


def _validate_source(path: Path, source: dict[str, Any]) -> str:
    if not path.is_file():
        raise PublicationError(f"Published source was not found: {path}")
    if path.stat().st_size <= 0:
        raise PublicationError(f"Published source is empty: {path}")
    source_format = str(source.get("format") or "file").lower()
    if source_format == "duckdb":
        return _duckdb_schema(path)
    if source_format == "sqlite":
        return _sqlite_schema(path)
    if source_format.startswith("pmtiles"):
        return _pmtiles_schema(path, source)
    if source_format in {"geotiff", "cog", "tiff"}:
        return _tiff_schema(path)
    if source_format in {"json", "manifest"}:
        return _json_schema(path)
    with path.open("rb") as handle:
        header = handle.read(4096)
    return hashlib.sha256(header).hexdigest()


def _resolve_pointer(value: Any, dotted_path: str) -> Any:
    current = value
    for part in dotted_path.split("."):
        if not isinstance(current, dict) or part not in current:
            raise PublicationError(f"Manifest pointer field was not found: {dotted_path}")
        current = current[part]
    return current


def _source_path(
    source: dict[str, Any],
    *,
    shared_root: Path,
    config_base: Path,
    variables: dict[str, str],
) -> Path:
    path_value = str(source.get("path") or "").strip()
    if path_value:
        return _resolve_path(path_value, base=shared_root, variables=variables)
    manifest_value = str(source.get("pathManifest") or "").strip()
    pointer_field = str(source.get("pathField") or "").strip()
    if not manifest_value or not pointer_field:
        raise PublicationError(f"Source {source.get('id')} has no path or manifest pointer.")
    manifest_path = _resolve_path(manifest_value, base=shared_root, variables=variables)
    manifest = _read_json(manifest_path)
    pointed_value = str(_resolve_pointer(manifest, pointer_field))
    pointed_path = Path(_expand_text(pointed_value, variables))
    return pointed_path if pointed_path.is_absolute() else (manifest_path.parent / pointed_path).resolve()


def _copy_staged_source(source_path: Path, destination: Path, read_only: bool) -> Path:
    if not source_path.is_file():
        raise PublicationError(f"Staged publication source was not found: {source_path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.next")
    shutil.copy2(source_path, temporary)
    if read_only:
        temporary.chmod(temporary.stat().st_mode & ~0o222)
    destination_was_read_only = False
    if destination.exists():
        destination_was_read_only = not bool(destination.stat().st_mode & 0o200)
        if destination_was_read_only:
            destination.chmod(destination.stat().st_mode | 0o200)
    try:
        os.replace(temporary, destination)
    except Exception:
        if destination.exists() and destination_was_read_only:
            destination.chmod(destination.stat().st_mode & ~0o222)
        temporary.unlink(missing_ok=True)
        raise
    return destination


@contextmanager
def _publication_lock(path: Path, timeout_seconds: float = LOCK_RETRY_SECONDS) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout_seconds
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(descriptor, json.dumps({"pid": os.getpid(), "startedAtUtc": _utc_text()}).encode("utf-8"))
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise PublicationError(f"Timed out waiting for the publication lock: {path}")
            time.sleep(LOCK_POLL_SECONDS)
    try:
        yield
    finally:
        if descriptor is not None:
            os.close(descriptor)
        path.unlink(missing_ok=True)


def _producer_definitions(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    producers = config.get("producers")
    if not isinstance(producers, dict):
        raise PublicationError("Publication settings must contain a producers object.")
    definitions = {str(key): value for key, value in producers.items() if isinstance(value, dict)}
    owners: dict[str, str] = {}
    for producer_name, definition in definitions.items():
        for source in definition.get("sources", []):
            if not isinstance(source, dict):
                continue
            source_id = str(source.get("id") or "").strip()
            if not source_id:
                raise PublicationError(f"Producer {producer_name} contains a source without an id.")
            previous = owners.get(source_id)
            if previous is not None:
                raise PublicationError(
                    f"Logical source ID is configured for multiple producers: {source_id} ({previous}, {producer_name})"
                )
            owners[source_id] = producer_name
    return definitions


def _existing_sources(fragment_path: Path) -> dict[str, dict[str, Any]]:
    if not fragment_path.is_file():
        return {}
    fragment = _read_json(fragment_path)
    return {
        str(item.get("id")): item
        for item in fragment.get("sources", [])
        if isinstance(item, dict) and item.get("id")
    }


def _prepare_source_record(
    source: dict[str, Any],
    *,
    producer_name: str,
    producer_release_id: str,
    shared_root: Path,
    config_base: Path,
    variables: dict[str, str],
    previous: dict[str, Any] | None,
    staged_override: Path | None,
    compatibility: dict[str, Any],
) -> dict[str, Any]:
    source_id = str(source.get("id") or "").strip()
    if not source_id:
        raise PublicationError(f"Producer {producer_name} contains a source without an id.")
    destination = _source_path(
        source,
        shared_root=shared_root,
        config_base=config_base,
        variables=variables,
    )
    if staged_override is not None:
        destination = _copy_staged_source(
            staged_override,
            destination,
            bool(source.get("readOnly", True)),
        )
    fingerprint = _validate_source(destination, source)
    digest = _sha256(destination)
    now = _utc_now()
    unchanged = bool(previous and previous.get("sha256") == digest)
    version = str(previous.get("version")) if unchanged else f"{_utc_token(now)}-{digest[:8]}"
    published_at = str(previous.get("publishedAtUtc")) if unchanged else _utc_text(now)
    published_epoch = int(previous.get("publishedAtEpoch") or now.timestamp()) if unchanged else int(now.timestamp())
    record: dict[str, Any] = {
        "id": source_id,
        "producer": producer_name,
        "producerReleaseId": producer_release_id,
        "displayName": str(source.get("displayName") or source_id),
        "source": _relative_source(destination, shared_root),
        "format": str(source.get("format") or "file"),
        "version": version,
        "publishedAtUtc": published_at,
        "publishedAtEpoch": published_epoch,
        "sizeBytes": destination.stat().st_size,
        "sha256": digest,
        "schemaFingerprint": fingerprint,
        "updateClass": str(source.get("updateClass") or "event-driven"),
        "activationGroup": str(source.get("activationGroup") or source_id),
        "desktopEnabled": bool(source.get("desktopEnabled", False)),
        "requiredAtStartup": bool(source.get("requiredAtStartup", False)),
        "priority": int(source.get("priority") or 100),
        "readOnly": bool(source.get("readOnly", True)),
    }
    for optional_key in (
        "requiredTables",
        "requiredColumns",
        "sourceLayers",
        "crs",
        "bounds",
        "minimumZoom",
        "maximumZoom",
        "terrainEncoding",
        "minimumAppVersion",
        "maximumAppVersion",
        "sidecarFor",
    ):
        optional_value = source.get(optional_key, compatibility.get(optional_key))
        if optional_value not in (None, ""):
            record[optional_key] = optional_value
    return record


def _merge_central_manifest(
    *,
    central_path: Path,
    publications_directory: Path,
    configured_producers: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    merged: dict[str, dict[str, Any]] = {}
    for producer_name, definition in configured_producers.items():
        fragment_name = str(definition.get("fragment") or f"{producer_name}.current.json")
        fragment_path = publications_directory / fragment_name
        if not fragment_path.is_file():
            continue
        fragment = _read_json(fragment_path)
        if str(fragment.get("producer") or "") != producer_name:
            raise PublicationError(f"Producer ownership mismatch in {fragment_path}")
        for source in fragment.get("sources", []):
            if not isinstance(source, dict) or not bool(source.get("desktopEnabled", False)):
                continue
            source_id = str(source.get("id") or "")
            owner = str(source.get("producer") or "")
            if owner != producer_name:
                raise PublicationError(f"Source {source_id} is owned by {owner}, not {producer_name}.")
            if source_id in merged:
                raise PublicationError(f"Logical source ID is owned by multiple producers: {source_id}")
            merged[source_id] = source
    sources = sorted(merged.values(), key=lambda item: (int(item.get("priority") or 100), str(item.get("id"))))
    now = _utc_now()
    publication_hash = _normalized_hash(sources)
    manifest = {
        "manifestSchemaVersion": MANIFEST_SCHEMA_VERSION,
        "publicationId": f"{_utc_token(now)}-{publication_hash[:8]}",
        "publishedAtUtc": _utc_text(now),
        "publishedAtEpoch": int(now.timestamp()),
        "sources": sources,
    }
    _write_json_atomic(central_path, manifest)
    return manifest


def publish(
    config_path: Path,
    producer_name: str,
    staged_overrides: dict[str, Path] | None = None,
    environment: str = "production",
) -> dict[str, Any]:
    config_path = config_path.resolve()
    config = _read_json(config_path)
    variables = {
        "PORTAL_SHARED_DATA_ROOT": str(config.get("sharedDataRoot") or os.environ.get("PORTAL_SHARED_DATA_ROOT") or ""),
        "LOCALAPPDATA": os.environ.get("LOCALAPPDATA", ""),
    }
    shared_root_value = str(config.get("sharedDataRoot") or "").strip()
    if not shared_root_value:
        raise PublicationError("sharedDataRoot is required in publication settings.")
    shared_root = _environment_root(
        _resolve_path(shared_root_value, base=config_path.parent, variables=variables),
        environment,
    )
    variables["PORTAL_SHARED_DATA_ROOT"] = str(shared_root)
    central_path = _resolve_path(
        str(config.get("centralManifest") or "databases_local/portal-data.current.json"),
        base=shared_root,
        variables=variables,
    )
    publications_directory = _resolve_path(
        str(config.get("publicationsDirectory") or "databases_local/publications"),
        base=shared_root,
        variables=variables,
    )
    producers = _producer_definitions(config)
    if producer_name not in producers:
        raise PublicationError(f"Unknown producer: {producer_name}")
    definition = producers[producer_name]
    compatibility = config.get("compatibility") if isinstance(config.get("compatibility"), dict) else {}
    fragment_name = str(definition.get("fragment") or f"{producer_name}.current.json")
    fragment_path = publications_directory / fragment_name
    previous = _existing_sources(fragment_path)
    now = _utc_now()
    release_id = f"{producer_name}-{_release_token(now)}"
    records: list[dict[str, Any]] = []
    configured_ids: set[str] = set()
    unexpected_overrides = set(staged_overrides or {}) - {
        str(source.get("id") or "")
        for source in definition.get("sources", [])
        if isinstance(source, dict)
    }
    if unexpected_overrides:
        raise PublicationError(
            "Staged sources are not owned by the selected producer: "
            + ", ".join(sorted(unexpected_overrides))
        )
    for source in definition.get("sources", []):
        if not isinstance(source, dict):
            continue
        source_id = str(source.get("id") or "")
        if source_id in configured_ids:
            raise PublicationError(f"Duplicate source ID in producer {producer_name}: {source_id}")
        configured_ids.add(source_id)
        records.append(
            _prepare_source_record(
                source,
                producer_name=producer_name,
                producer_release_id=release_id,
                shared_root=shared_root,
                config_base=config_path.parent,
                variables=variables,
                previous=previous.get(source_id),
                staged_override=(staged_overrides or {}).get(source_id),
                compatibility=compatibility,
            )
        )
    if not records:
        raise PublicationError(f"Producer {producer_name} has no configured sources.")
    fragment = {
        "manifestSchemaVersion": MANIFEST_SCHEMA_VERSION,
        "producer": producer_name,
        "producerReleaseId": release_id,
        "publishedAtUtc": _utc_text(now),
        "publishedAtEpoch": int(now.timestamp()),
        "sources": records,
    }
    lock_path = central_path.with_suffix(central_path.suffix + ".lock")
    journal_path = publications_directory / f"{producer_name}.transaction.json"
    _write_json_atomic(
        journal_path,
        {
            "state": "prepared",
            "producer": producer_name,
            "producerReleaseId": release_id,
            "preparedAtUtc": _utc_text(),
            "fragment": fragment,
        },
    )
    with _publication_lock(lock_path):
        _write_json_atomic(fragment_path, fragment)
        central = _merge_central_manifest(
            central_path=central_path,
            publications_directory=publications_directory,
            configured_producers=producers,
        )
        _write_json_atomic(
            journal_path,
            {
                "state": "committed",
                "producer": producer_name,
                "producerReleaseId": release_id,
                "committedAtUtc": _utc_text(),
                "centralPublicationId": central["publicationId"],
            },
        )
    return {
        "status": "succeeded",
        "producer": producer_name,
        "producer_release_id": release_id,
        "source_count": len(records),
        "desktop_source_count": sum(1 for item in records if item["desktopEnabled"]),
        "fragment": str(fragment_path),
        "central_manifest": str(central_path),
        "central_publication_id": central["publicationId"],
    }


def _publication_paths(
    config_path: Path, environment: str = "production"
) -> tuple[dict[str, Any], Path, Path, Path, dict[str, dict[str, Any]]]:
    config_path = config_path.resolve()
    config = _read_json(config_path)
    shared_root_value = str(config.get("sharedDataRoot") or "").strip()
    if not shared_root_value:
        raise PublicationError("sharedDataRoot is required in publication settings.")
    variables = {
        "PORTAL_SHARED_DATA_ROOT": shared_root_value,
        "LOCALAPPDATA": os.environ.get("LOCALAPPDATA", ""),
    }
    shared_root = _environment_root(
        _resolve_path(shared_root_value, base=config_path.parent, variables=variables),
        environment,
    )
    variables["PORTAL_SHARED_DATA_ROOT"] = str(shared_root)
    central_path = _resolve_path(
        str(config.get("centralManifest") or "databases_local/portal-data.current.json"),
        base=shared_root,
        variables=variables,
    )
    publications_directory = _resolve_path(
        str(config.get("publicationsDirectory") or "databases_local/publications"),
        base=shared_root,
        variables=variables,
    )
    return config, shared_root, central_path, publications_directory, _producer_definitions(config)


def _record_path(record: dict[str, Any], shared_root: Path) -> Path:
    relative = Path(str(record.get("source") or ""))
    if relative.is_absolute() or any(
        component == os.pardir for component in relative.parts
    ):
        raise PublicationError(f"Published source has an unsafe path: {relative}")
    path = (shared_root / relative).resolve()
    _relative_source(path, shared_root)
    return path


def recover_prepared(config_path: Path, environment: str = "production") -> dict[str, Any]:
    _, shared_root, central_path, publications_directory, producers = _publication_paths(config_path, environment)
    recovered: list[str] = []
    for producer_name, definition in producers.items():
        journal_path = publications_directory / f"{producer_name}.transaction.json"
        if not journal_path.is_file():
            continue
        journal = _read_json(journal_path)
        if str(journal.get("state") or "") != "prepared":
            continue
        fragment = journal.get("fragment")
        if not isinstance(fragment, dict) or str(fragment.get("producer") or "") != producer_name:
            raise PublicationError(f"Prepared transaction is invalid: {journal_path}")
        configured_ids = {
            str(item.get("id") or "")
            for item in definition.get("sources", [])
            if isinstance(item, dict)
        }
        records = [item for item in fragment.get("sources", []) if isinstance(item, dict)]
        if not records or {str(item.get("id") or "") for item in records} != configured_ids:
            raise PublicationError(f"Prepared transaction does not match producer ownership: {producer_name}")
        for record in records:
            source_path = _record_path(record, shared_root)
            if not source_path.is_file() or source_path.stat().st_size != int(record.get("sizeBytes") or -1):
                raise PublicationError(f"Prepared source is missing or changed: {source_path}")
            if _sha256(source_path) != str(record.get("sha256") or ""):
                raise PublicationError(f"Prepared source checksum changed: {source_path}")
        fragment_name = str(definition.get("fragment") or f"{producer_name}.current.json")
        with _publication_lock(central_path.with_suffix(central_path.suffix + ".lock")):
            _write_json_atomic(publications_directory / fragment_name, fragment)
            central = _merge_central_manifest(
                central_path=central_path,
                publications_directory=publications_directory,
                configured_producers=producers,
            )
            _write_json_atomic(
                journal_path,
                {
                    "state": "committed",
                    "producer": producer_name,
                    "producerReleaseId": fragment.get("producerReleaseId"),
                    "recoveredAtUtc": _utc_text(),
                    "centralPublicationId": central["publicationId"],
                },
            )
        recovered.append(producer_name)
    return {"status": "succeeded", "recovered": recovered, "recovered_count": len(recovered)}


def check_publication(config_path: Path, environment: str = "production") -> dict[str, Any]:
    _, shared_root, central_path, publications_directory, producers = _publication_paths(config_path, environment)
    prepared = []
    for producer_name in producers:
        journal_path = publications_directory / f"{producer_name}.transaction.json"
        if journal_path.is_file() and str(_read_json(journal_path).get("state") or "") == "prepared":
            prepared.append(producer_name)
    if prepared:
        raise PublicationError("Prepared publication transactions require recovery: " + ", ".join(prepared))
    manifest = _read_json(central_path)
    seen: set[str] = set()
    for record in manifest.get("sources", []):
        if not isinstance(record, dict):
            raise PublicationError(f"Central manifest contains an invalid source record: {central_path}")
        source_id = str(record.get("id") or "")
        if not source_id or source_id in seen:
            raise PublicationError(f"Central manifest contains a duplicate or empty source ID: {source_id}")
        seen.add(source_id)
        path = _record_path(record, shared_root)
        if not path.is_file() or path.stat().st_size != int(record.get("sizeBytes") or -1):
            raise PublicationError(f"Published source is missing or changed: {path}")
        if _sha256(path) != str(record.get("sha256") or ""):
            raise PublicationError(f"Published source checksum changed: {path}")
    return {
        "status": "succeeded",
        "central_manifest": str(central_path),
        "publication_id": str(manifest.get("publicationId") or ""),
        "source_count": len(seen),
    }


def _parse_staged_overrides(values: list[str]) -> dict[str, Path]:
    parsed: dict[str, Path] = {}
    for value in values:
        source_id, separator, path_value = value.partition("=")
        if not separator or not source_id.strip() or not path_value.strip():
            raise PublicationError("--stage-source must use LOGICAL_ID=PATH syntax.")
        parsed[source_id.strip()] = Path(os.path.expandvars(os.path.expanduser(path_value.strip()))).resolve()
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish Portal data versions and merge the Desktop manifest.")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--producer")
    parser.add_argument("--stage-source", action="append", default=[], metavar="LOGICAL_ID=PATH")
    parser.add_argument("--recover-prepared", action="store_true")
    parser.add_argument(
        "--environment",
        default="production",
        choices=["production", "test"],
        help="Publish into the production tree or the isolated test subtree.",
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.recover_prepared:
            result = recover_prepared(args.config, args.environment)
        elif args.check:
            result = check_publication(args.config, args.environment)
        else:
            if not args.producer:
                raise PublicationError("--producer is required when publishing data versions.")
            result = publish(
                args.config,
                args.producer,
                _parse_staged_overrides(args.stage_source),
                args.environment,
            )
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
