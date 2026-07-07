from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
import tomllib


class ConfigError(ValueError):
    """Raised when the project TOML cannot be used by the tile tooling."""


@dataclass(frozen=True)
class SourceConfig:
    id: str
    enabled: bool
    path: str
    format: str
    tile_layer: str
    description: str = ""
    source_layer: str = ""
    include_properties: tuple[str, ...] = ()
    exclude_properties: tuple[str, ...] = ()


@dataclass(frozen=True)
class TilesetConfig:
    id: str
    enabled: bool
    output: Path
    sources: tuple[str, ...]
    name: str = ""
    description: str = ""
    tippecanoe: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ProjectConfig:
    config_path: Path
    project_root: Path
    project: dict[str, Any]
    paths: dict[str, Path]
    tippecanoe_defaults: dict[str, Any]
    sources: dict[str, SourceConfig]
    tilesets: dict[str, TilesetConfig]

    def enabled_sources(self) -> list[SourceConfig]:
        return [source for source in self.sources.values() if source.enabled]

    def enabled_tilesets(self) -> list[TilesetConfig]:
        return [tileset for tileset in self.tilesets.values() if tileset.enabled]


def load_config(config_path: str | Path = "config/project.toml") -> ProjectConfig:
    path = Path(config_path).resolve()
    if not path.exists():
        raise ConfigError(f"Config file does not exist: {path}")

    with path.open("rb") as handle:
        raw = tomllib.load(handle)

    project_root = path.parent.parent.resolve()
    project = _require_table(raw, "project")
    raw_paths = _require_table(raw, "paths")
    raw_tippecanoe = _require_table(raw, "tippecanoe")
    defaults = _require_table(raw_tippecanoe, "defaults", parent="tippecanoe")

    paths = {
        key: _resolve_path(value, project_root)
        for key, value in raw_paths.items()
        if isinstance(value, str)
    }

    raw_sources = raw.get("datasets", raw.get("sources", []))
    sources = _load_sources(raw_sources, project_root)
    tilesets = _load_tilesets(raw.get("tilesets", []), project_root, sources)

    return ProjectConfig(
        config_path=path,
        project_root=project_root,
        project=project,
        paths=paths,
        tippecanoe_defaults=defaults,
        sources=sources,
        tilesets=tilesets,
    )


def validate_config(config: ProjectConfig) -> list[str]:
    warnings: list[str] = []

    tippecanoe_path = config.paths.get("tippecanoe")
    if tippecanoe_path is None:
        raise ConfigError("paths.tippecanoe is required")
    if not tippecanoe_path.exists():
        warnings.append(f"Tippecanoe executable not found: {tippecanoe_path}")

    for key in ("raw_data", "staging", "pmtiles", "logs"):
        if key not in config.paths:
            warnings.append(f"paths.{key} is not configured")

    for source in config.enabled_sources():
        source_path = _filesystem_container_for_source(source.path)
        if source_path is not None and not source_path.exists():
            warnings.append(f"Enabled source '{source.id}' does not exist: {source.path}")

    for tileset in config.enabled_tilesets():
        missing = [source_id for source_id in tileset.sources if source_id not in config.sources]
        if missing:
            raise ConfigError(
                f"Tileset '{tileset.id}' references unknown source id(s): {', '.join(missing)}"
            )

    return warnings


def _load_sources(raw_sources: Any, project_root: Path) -> dict[str, SourceConfig]:
    if not isinstance(raw_sources, list):
        raise ConfigError("sources must be an array of tables")

    sources: dict[str, SourceConfig] = {}
    for raw in raw_sources:
        if not isinstance(raw, dict):
            raise ConfigError("Each source must be a table")

        source_id = _require_string(raw, "id", context="source")
        if source_id in sources:
            raise ConfigError(f"Duplicate source id: {source_id}")

        tile_layer = _require_string(raw, "tile_layer", context=f"source '{source_id}'")
        sources[source_id] = SourceConfig(
            id=source_id,
            enabled=bool(raw.get("enabled", True)),
            description=str(raw.get("description", "")),
            path=_resolve_source_location(
                _require_string(raw, "path", context=f"source '{source_id}'"),
                project_root,
            ),
            format=str(raw.get("format", "geojson")),
            source_layer=str(raw.get("source_layer", "")),
            tile_layer=tile_layer,
            include_properties=_string_tuple(raw.get("include_properties", []), source_id, "include_properties"),
            exclude_properties=_string_tuple(raw.get("exclude_properties", []), source_id, "exclude_properties"),
        )

    return sources


def _load_tilesets(
    raw_tilesets: Any,
    project_root: Path,
    sources: dict[str, SourceConfig],
) -> dict[str, TilesetConfig]:
    if not isinstance(raw_tilesets, list):
        raise ConfigError("tilesets must be an array of tables")

    tilesets: dict[str, TilesetConfig] = {}
    for raw in raw_tilesets:
        if not isinstance(raw, dict):
            raise ConfigError("Each tileset must be a table")

        tileset_id = _require_string(raw, "id", context="tileset")
        if tileset_id in tilesets:
            raise ConfigError(f"Duplicate tileset id: {tileset_id}")

        raw_source_ids = raw.get("datasets", raw.get("sources", []))
        source_ids = _string_tuple(raw_source_ids, tileset_id, "datasets")
        missing = [source_id for source_id in source_ids if source_id not in sources]
        if missing:
            raise ConfigError(
                f"Tileset '{tileset_id}' references unknown source id(s): {', '.join(missing)}"
            )

        tilesets[tileset_id] = TilesetConfig(
            id=tileset_id,
            enabled=bool(raw.get("enabled", True)),
            name=str(raw.get("name", tileset_id)),
            description=str(raw.get("description", "")),
            output=_resolve_path(_require_string(raw, "output", context=f"tileset '{tileset_id}'"), project_root),
            sources=source_ids,
            tippecanoe=dict(raw.get("tippecanoe", {})),
        )

    return tilesets


def _resolve_path(value: str, project_root: Path) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return (project_root / path).resolve()


def _resolve_source_location(value: str, project_root: Path) -> str:
    if _looks_like_non_file_source(value):
        return value

    path = Path(value).expanduser()
    if path.is_absolute():
        return str(path)
    return str((project_root / path).resolve())


def _looks_like_non_file_source(value: str) -> bool:
    lowered = value.lower()
    return (
        "://" in lowered
        or lowered.startswith("server=")
        or lowered.startswith("instance=")
        or "database platform=" in lowered
        or "authentication type=" in lowered
    )


def _filesystem_container_for_source(value: str) -> Path | None:
    if _looks_like_non_file_source(value):
        return None

    path = Path(value)
    for parent in (path, *path.parents):
        if parent.suffix.lower() == ".gdb":
            return parent

    return path


def _require_table(raw: dict[str, Any], key: str, parent: str = "") -> dict[str, Any]:
    value = raw.get(key)
    if not isinstance(value, dict):
        full_key = f"{parent}.{key}" if parent else key
        raise ConfigError(f"{full_key} must be a table")
    return value


def _require_string(raw: dict[str, Any], key: str, context: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or value == "":
        raise ConfigError(f"{context} requires non-empty string field '{key}'")
    return value


def _string_tuple(raw: Any, item_id: str, key: str) -> tuple[str, ...]:
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise ConfigError(f"'{key}' for '{item_id}' must be a list of strings")
    return tuple(raw)
