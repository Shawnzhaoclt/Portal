from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any


class DuckDBSpatialExtensionError(RuntimeError):
    """Raised when the packaged DuckDB spatial extension is unavailable."""


def _candidate_spatial_extension_paths(connection: Any) -> list[Path]:
    candidates: list[Path] = []
    configured = os.environ.get("PORTAL_DUCKDB_SPATIAL_EXTENSION", "").strip()
    if configured:
        candidates.append(Path(configured))

    application_root = os.environ.get("PORTAL_APP_ROOT", "").strip()
    if application_root:
        candidates.append(
            Path(application_root)
            / "runtime"
            / "duckdb"
            / "extensions"
            / "spatial.duckdb_extension"
        )

    executable = Path(sys.executable).resolve(strict=False)
    if executable.parent.name.casefold() == "portal-python":
        candidates.append(
            executable.parent.parent
            / "duckdb"
            / "extensions"
            / "spatial.duckdb_extension"
        )

    try:
        import duckdb

        version = str(duckdb.__version__).strip().lstrip("v")
        platform = str(connection.execute("PRAGMA platform").fetchone()[0]).strip()
        if version and platform:
            candidates.append(
                Path.home()
                / ".duckdb"
                / "extensions"
                / f"v{version}"
                / platform
                / "spatial.duckdb_extension"
            )
    except Exception:
        pass

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.resolve(strict=False)).casefold()
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def load_spatial_extension(connection: Any) -> Path:
    """Load spatial from an explicit local file without contacting the internet."""

    connection.execute("SET autoinstall_known_extensions = false")
    connection.execute("SET autoload_known_extensions = false")

    candidates = _candidate_spatial_extension_paths(connection)
    extension_path = next((path for path in candidates if path.is_file()), None)
    if extension_path is None:
        searched = "; ".join(str(path) for path in candidates) or "no local paths"
        raise DuckDBSpatialExtensionError(
            "The packaged DuckDB spatial extension was not found. "
            f"Searched: {searched}. Reinstall Portal using a full portable release."
        )

    try:
        connection.load_extension(str(extension_path))
    except Exception as exc:
        raise DuckDBSpatialExtensionError(
            "The packaged DuckDB spatial extension is incompatible with the bundled "
            f"DuckDB runtime: {extension_path}. Reinstall Portal using a full portable release. "
            f"DuckDB reported: {exc}"
        ) from exc
    return extension_path
