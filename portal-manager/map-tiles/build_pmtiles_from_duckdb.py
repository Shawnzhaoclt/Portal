"""Build PMTiles archives from registered DuckDB spatial tables.

Portal Manager owns the orchestration, source registry, field allowlists,
validation, progress reporting, and atomic publication. The primary engine uses
the packaged Tippecanoe toolchain; native GDAL and the in-project Python encoder
remain available as controlled fallbacks.
"""

from __future__ import annotations

import argparse
from collections import deque
from concurrent.futures import (
    FIRST_COMPLETED,
    Future,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    as_completed,
    wait,
)
from dataclasses import dataclass, replace
from datetime import datetime
import gzip
import heapq
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from typing import Any, Iterable
from xml.etree import ElementTree

from pmtiles_v3 import Compression, TileType, Writer, read_header, zxy_to_tile_id


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIRECTORY / "pmtiles.settings.json"
WORLD_HALF_METERS = 20_037_508.342789244
WORLD_WIDTH_METERS = WORLD_HALF_METERS * 2
TOKEN_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
SUPPORTED_PROPERTY_TYPES = {
    "BOOLEAN": "Boolean",
    "TINYINT": "Number",
    "SMALLINT": "Number",
    "INTEGER": "Number",
    "BIGINT": "Number",
    "HUGEINT": "Number",
    "UTINYINT": "Number",
    "USMALLINT": "Number",
    "UINTEGER": "Number",
    "UBIGINT": "Number",
    "FLOAT": "Number",
    "DOUBLE": "Number",
    "REAL": "Number",
    "DECIMAL": "Number",
    "VARCHAR": "String",
    "CHAR": "String",
    "TEXT": "String",
    "DATE": "String",
    "TIME": "String",
    "TIMESTAMP": "String",
    "TIMESTAMP WITH TIME ZONE": "String",
}


@dataclass(frozen=True)
class Property:
    source_name: str
    alias: str
    source_type: str
    metadata_type: str


@dataclass(frozen=True)
class Layer:
    source_id: str
    database: Path
    schema: str
    table: str
    layer_id: str
    geometry_column: str
    source_srid: int
    feature_id_column: str | None
    properties: tuple[Property, ...]
    estimated_features: int
    minimum_zoom: int
    maximum_zoom: int
    enabled: bool
    publication_bounds: tuple[float, float, float, float] = (-180.0, -85.05112878, 180.0, 85.05112878)
    feature_id_strategy: str = "generated_hash"
    feature_hash_columns: tuple[str, ...] = ()


@dataclass(frozen=True)
class Tileset:
    tileset_id: str
    name: str
    description: str
    output: Path
    layers: tuple[Layer, ...]
    extent: int
    buffer: int
    simplification: float
    memory_limit: str
    temporary_directory: Path
    progress_file: Path
    worker_count: int
    threads_per_worker: int
    engine: str
    fallback_engine: str
    tippecanoe_executable: str
    tippecanoe_threads: str
    tippecanoe_group_workers: int
    gdal_executable: str
    gdal_threads: str
    publication_bounds: tuple[float, float, float, float]


@dataclass(frozen=True)
class LayerBuildResult:
    layer_order: int
    layer_id: str
    parts_path: Path
    feature_count: int
    tile_count: int
    bounds: tuple[float, float, float, float]
    source_feature_count: int
    excluded_feature_count: int


class GdalUnavailableError(RuntimeError):
    """Raised when the configured native GDAL engine cannot be started."""


class TippecanoeUnavailableError(RuntimeError):
    """Raised when the packaged Tippecanoe toolchain cannot be started."""


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"PMTiles configuration was not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object in {path}")
    return value


def _token_environment(config: dict[str, Any]) -> dict[str, str]:
    values = dict(os.environ)
    shared_root = str(config.get("sharedDataRoot") or "").strip()
    if shared_root:
        values["PORTAL_SHARED_DATA_ROOT"] = os.path.expandvars(os.path.expanduser(shared_root))
    return values


def _expand(value: str, base: Path, environment: dict[str, str]) -> Path:
    expanded = TOKEN_PATTERN.sub(lambda match: environment.get(match.group(1), match.group(0)), value)
    for name, replacement in environment.items():
        expanded = expanded.replace(f"%{name}%", replacement)
    expanded = os.path.expanduser(expanded)
    candidate = Path(expanded)
    return candidate if candidate.is_absolute() else (base / candidate).resolve()


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _qualified_table(schema: str, table: str) -> str:
    return f"{_quote_identifier(schema)}.{_quote_identifier(table)}"


def _sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _load_duckdb() -> Any:
    try:
        import duckdb
    except ImportError as exc:
        raise RuntimeError("The configured PMTiles Python environment must include DuckDB.") from exc
    return duckdb


def _load_spatial(connection: Any) -> None:
    try:
        connection.execute("LOAD spatial")
    except Exception as exc:
        raise RuntimeError(f"DuckDB Spatial could not be loaded: {exc}") from exc


def _column_rows(connection: Any, schema: str, table: str) -> list[tuple[str, str]]:
    return [
        (str(name), str(data_type).upper())
        for name, data_type in connection.execute(
            """
            SELECT column_name, data_type
            FROM duckdb_columns()
            WHERE schema_name = ? AND table_name = ?
            ORDER BY column_index
            """,
            [schema, table],
        ).fetchall()
    ]


def _estimated_size(connection: Any, schema: str, table: str) -> int:
    row = connection.execute(
        "SELECT estimated_size FROM duckdb_tables() WHERE schema_name = ? AND table_name = ?",
        [schema, table],
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _default_minimum_zoom(feature_count: int) -> int:
    if feature_count >= 750_000:
        return 14
    if feature_count >= 250_000:
        return 13
    if feature_count >= 100_000:
        return 12
    if feature_count >= 50_000:
        return 11
    if feature_count >= 10_000:
        return 10
    return 8


def _type_base(data_type: str) -> str:
    return data_type.split("(", 1)[0].strip().upper()


def _property_metadata_type(data_type: str) -> str:
    return SUPPORTED_PROPERTY_TYPES.get(_type_base(data_type), "String")


def _property_expression(property_value: Property) -> str:
    column = _quote_identifier(property_value.source_name)
    base = _type_base(property_value.source_type)
    if base == "BOOLEAN":
        return f"CAST({column} AS BOOLEAN)"
    if _property_metadata_type(property_value.source_type) == "Number":
        if base in {"FLOAT", "DOUBLE", "REAL", "DECIMAL"}:
            return f"CAST({column} AS DOUBLE)"
        return f"CAST({column} AS BIGINT)"
    return f"CAST({column} AS VARCHAR)"


def _resolve_layer(
    connection: Any,
    source: dict[str, Any],
    database: Path,
    schema: str,
    table: str,
    override: dict[str, Any],
    defaults: dict[str, Any],
) -> Layer | None:
    columns = _column_rows(connection, schema, table)
    if not columns:
        raise RuntimeError(f"Configured DuckDB table was not found: {database} :: {schema}.{table}")
    by_lower = {name.lower(): (name, data_type) for name, data_type in columns}
    geometry_name = str(override.get("geometryColumn") or "").strip()
    if geometry_name:
        actual_geometry = by_lower.get(geometry_name.lower())
        if not actual_geometry or _type_base(actual_geometry[1]) != "GEOMETRY":
            raise RuntimeError(f"{schema}.{table} does not contain GEOMETRY column {geometry_name}.")
        geometry_name = actual_geometry[0]
    else:
        geometry_columns = [name for name, data_type in columns if _type_base(data_type) == "GEOMETRY"]
        if not geometry_columns:
            return None
        if len(geometry_columns) > 1:
            raise RuntimeError(f"{schema}.{table} has multiple geometry columns; configure geometryColumn.")
        geometry_name = geometry_columns[0]

    layer_srid_configured = override.get("sourceSrid") not in (None, "")
    configured_srid = override.get("sourceSrid", source.get("sourceSrid", defaults.get("sourceSrid", 0)))
    source_srid = int(configured_srid or 0)
    srid_column = by_lower.get("__geometry_srid")
    if srid_column:
        row = connection.execute(
            f"SELECT min({_quote_identifier(srid_column[0])}), max({_quote_identifier(srid_column[0])}) "
            f"FROM {_qualified_table(schema, table)} WHERE {_quote_identifier(geometry_name)} IS NOT NULL"
        ).fetchone()
        minimum_srid = int(row[0] or 0) if row else 0
        maximum_srid = int(row[1] or 0) if row else 0
        if minimum_srid and maximum_srid and minimum_srid != maximum_srid:
            raise RuntimeError(f"{schema}.{table} contains mixed geometry SRIDs ({minimum_srid}, {maximum_srid}).")
        if minimum_srid:
            if layer_srid_configured and source_srid and source_srid != minimum_srid:
                raise RuntimeError(
                    f"{schema}.{table} is configured as EPSG:{source_srid} but contains EPSG:{minimum_srid}."
                )
            source_srid = minimum_srid
    if source_srid <= 0:
        raise RuntimeError(f"A source SRID is required for {schema}.{table}.")

    property_names = override.get("properties")
    if property_names is None:
        property_map = source.get("propertiesByTable") if isinstance(source.get("propertiesByTable"), dict) else {}
        property_names = property_map.get(table, property_map.get(table.lower(), []))
    if not isinstance(property_names, list):
        raise RuntimeError(f"properties must be a list for {schema}.{table}.")
    properties: list[Property] = []
    seen: set[str] = set()
    for requested in property_names:
        actual = by_lower.get(str(requested).lower())
        if not actual:
            raise RuntimeError(f"Configured property {requested} was not found in {schema}.{table}.")
        if actual[0].lower() in seen or _type_base(actual[1]) == "GEOMETRY":
            continue
        seen.add(actual[0].lower())
        properties.append(
            Property(actual[0], f"property_{len(properties)}", actual[1], _property_metadata_type(actual[1]))
        )

    configured_id = str(override.get("featureIdColumn") or "").strip()
    feature_id: str | None = None
    candidates = (
        [configured_id]
        if configured_id
        else [
            "OBJECTID",
            *sorted(name for name, _data_type in columns if name.upper().startswith("OBJECTID_")),
            "FID",
            "OID",
            "__feature_id",
        ]
    )
    for candidate in candidates:
        if not candidate:
            continue
        actual = by_lower.get(candidate.lower())
        if actual and _property_metadata_type(actual[1]) == "Number" and _type_base(actual[1]) not in {
            "FLOAT", "DOUBLE", "REAL", "DECIMAL"
        }:
            total_count, populated_count, distinct_count, minimum_value = connection.execute(
                f"SELECT count(*), count({_quote_identifier(actual[0])}), "
                f"count(DISTINCT {_quote_identifier(actual[0])}), min({_quote_identifier(actual[0])}) "
                f"FROM {_qualified_table(schema, table)}"
            ).fetchone()
            if (
                int(total_count) == int(populated_count) == int(distinct_count)
                and (minimum_value is None or int(minimum_value) >= 0)
            ):
                feature_id = actual[0]
                break
            if configured_id:
                raise RuntimeError(
                    f"Configured internal feature ID {configured_id} is not non-null and unique in {schema}.{table}."
                )
    if configured_id and not feature_id:
        raise RuntimeError(
            f"Configured internal feature ID {configured_id} was not found as an integer column in {schema}.{table}."
        )
    feature_hash_columns = tuple(
        sorted(name for name, data_type in columns if _type_base(data_type) != "GEOMETRY")
    )
    estimated = _estimated_size(connection, schema, table)
    minimum_zoom = int(override.get("minimumZoom", source.get("minimumZoom", _default_minimum_zoom(estimated))))
    maximum_zoom = int(override.get("maximumZoom", source.get("maximumZoom", defaults.get("maximumZoom", 16))))
    if minimum_zoom < 0 or maximum_zoom > 22 or minimum_zoom > maximum_zoom:
        raise RuntimeError(f"Invalid zoom range {minimum_zoom}-{maximum_zoom} for {schema}.{table}.")
    return Layer(
        source_id=str(source.get("id") or database.stem),
        database=database,
        schema=schema,
        table=table,
        layer_id=str(override.get("id") or table).strip().lower(),
        geometry_column=geometry_name,
        source_srid=source_srid,
        feature_id_column=feature_id,
        properties=tuple(properties),
        estimated_features=estimated,
        minimum_zoom=minimum_zoom,
        maximum_zoom=maximum_zoom,
        enabled=bool(override.get("enabled", True)),
        feature_id_strategy=f"source:{feature_id}" if feature_id else "generated_hash",
        feature_hash_columns=feature_hash_columns,
    )


def _source_layers(
    source: dict[str, Any],
    base: Path,
    environment: dict[str, str],
    defaults: dict[str, Any],
    include_layer_ids: set[str] | None = None,
) -> list[Layer]:
    database_value = str(source.get("database") or "").strip()
    if not database_value:
        raise RuntimeError(f"PMTiles source {source.get('id') or '<unnamed>'} has no database path.")
    database = _expand(database_value, base, environment)
    if not database.is_file():
        raise RuntimeError(f"PMTiles source database was not found: {database}")
    duckdb = _load_duckdb()
    connection = duckdb.connect(str(database), read_only=True)
    try:
        _load_spatial(connection)
        overrides_value = source.get("layers") if isinstance(source.get("layers"), list) else []
        overrides: dict[str, dict[str, Any]] = {}
        ordered_tables: list[tuple[str, str]] = []
        for item in overrides_value:
            if not isinstance(item, dict):
                continue
            table = str(item.get("table") or "").strip()
            if not table:
                continue
            schema = str(item.get("schema") or source.get("schema") or "main").strip()
            overrides[f"{schema.lower()}.{table.lower()}"] = item
            ordered_tables.append((schema, table))
        if bool(source.get("includeAllSpatialTables")):
            ordered_tables = [
                (str(schema), str(table))
                for schema, table in connection.execute(
                    """
                    SELECT DISTINCT schema_name, table_name
                    FROM duckdb_columns()
                    WHERE upper(data_type) = 'GEOMETRY'
                    ORDER BY schema_name, table_name
                    """
                ).fetchall()
            ]
        result: list[Layer] = []
        for schema, table in ordered_tables:
            override = overrides.get(f"{schema.lower()}.{table.lower()}", {"table": table, "schema": schema})
            candidate_layer_id = str(override.get("id") or table).strip().lower()
            if include_layer_ids and candidate_layer_id not in include_layer_ids:
                continue
            layer = _resolve_layer(connection, source, database, schema, table, override, defaults)
            if layer is not None:
                result.append(layer)
        return result
    finally:
        connection.close()


def load_tilesets(config_path: Path, selected: set[str] | None = None) -> tuple[dict[str, Any], list[Tileset]]:
    config = _read_json(config_path)
    base = config_path.resolve().parent
    environment = _token_environment(config)
    defaults = config.get("defaults") if isinstance(config.get("defaults"), dict) else {}
    sources = {
        str(source.get("id")): source
        for source in config.get("sources", [])
        if isinstance(source, dict) and source.get("id")
    }
    tilesets: list[Tileset] = []
    for raw in config.get("tilesets", []):
        if not isinstance(raw, dict) or not bool(raw.get("enabled", True)):
            continue
        tileset_id = str(raw.get("id") or "").strip()
        if not tileset_id or (selected and tileset_id.lower() not in selected):
            continue
        output_value = str(raw.get("output") or "").strip()
        if not output_value:
            raise RuntimeError(f"Tileset {tileset_id} has no output path.")
        include_layers_value = raw.get("includeLayers", [])
        if not isinstance(include_layers_value, list):
            raise RuntimeError(f"includeLayers must be a list for tileset {tileset_id}.")
        layer_filter = {
            str(value).strip().lower()
            for value in include_layers_value
            if str(value).strip()
        }
        layers: list[Layer] = []
        for source_id in raw.get("sources", []):
            source = sources.get(str(source_id))
            if source is None:
                raise RuntimeError(f"Tileset {tileset_id} references unknown source {source_id}.")
            layers.extend(_source_layers(source, base, environment, defaults, layer_filter or None))
        if layer_filter:
            available_layer_ids = {layer.layer_id.lower() for layer in layers}
            missing_layer_ids = sorted(layer_filter - available_layer_ids)
            if missing_layer_ids:
                raise RuntimeError(
                    f"Tileset {tileset_id} is missing configured layers: "
                    f"{', '.join(missing_layer_ids)}"
                )
            layers = [layer for layer in layers if layer.layer_id.lower() in layer_filter]
        layers = [layer for layer in layers if layer.enabled]
        if not layers:
            raise RuntimeError(f"Tileset {tileset_id} contains no enabled spatial layers.")
        temporary_value = str(
            raw.get("temporaryDirectory")
            or defaults.get("temporaryDirectory")
            or "${LOCALAPPDATA}/PortalManager/map-tiles/temp"
        )
        temporary_directory = _expand(temporary_value, base, environment)
        progress_value = str(raw.get("progressFile") or defaults.get("progressFile") or "").strip()
        progress_file = (
            _expand(progress_value, base, environment)
            if progress_value
            else temporary_directory.parent / "progress.json"
        )
        worker_count = int(raw.get("workerCount", defaults.get("workerCount", 3)))
        threads_per_worker = int(raw.get("threadsPerWorker", defaults.get("threadsPerWorker", 6)))
        engine = str(raw.get("engine", defaults.get("engine", "tippecanoe"))).strip().lower()
        fallback_engine = str(
            raw.get("fallbackEngine", defaults.get("fallbackEngine", "gdal"))
        ).strip().lower()
        tippecanoe_executable = str(
            raw.get(
                "tippecanoeExecutable",
                defaults.get("tippecanoeExecutable", "vendor/tippecanoe/tippecanoe.exe"),
            )
        ).strip()
        tippecanoe_threads = str(
            raw.get("tippecanoeThreads", defaults.get("tippecanoeThreads", "ALL_CPUS"))
        ).strip()
        tippecanoe_group_workers = int(
            raw.get(
                "tippecanoeGroupWorkers",
                defaults.get("tippecanoeGroupWorkers", 3),
            )
        )
        gdal_executable = str(
            raw.get("gdalExecutable", defaults.get("gdalExecutable", ""))
        ).strip()
        gdal_threads = str(raw.get("gdalThreads", defaults.get("gdalThreads", "ALL_CPUS"))).strip()
        if worker_count < 1 or worker_count > 8:
            raise RuntimeError(f"workerCount must be between 1 and 8 for tileset {tileset_id}.")
        if threads_per_worker < 1 or threads_per_worker > 16:
            raise RuntimeError(f"threadsPerWorker must be between 1 and 16 for tileset {tileset_id}.")
        if engine not in {"tippecanoe", "gdal", "python"}:
            raise RuntimeError(f"Unsupported PMTiles engine for {tileset_id}: {engine}")
        if fallback_engine not in {"", "tippecanoe", "gdal", "python"}:
            raise RuntimeError(f"Unsupported PMTiles fallback engine for {tileset_id}: {fallback_engine}")
        if fallback_engine == engine:
            raise RuntimeError(
                f"PMTiles fallback engine must differ from the primary engine for {tileset_id}."
            )
        if tippecanoe_group_workers < 1 or tippecanoe_group_workers > 6:
            raise RuntimeError(
                f"tippecanoeGroupWorkers must be between 1 and 6 for tileset {tileset_id}."
            )
        if tippecanoe_threads.upper() != "ALL_CPUS":
            try:
                tippecanoe_thread_count = int(tippecanoe_threads)
            except ValueError as exc:
                raise RuntimeError(
                    f"tippecanoeThreads must be ALL_CPUS or an integer for tileset {tileset_id}."
                ) from exc
            if tippecanoe_thread_count < 1 or tippecanoe_thread_count > 64:
                raise RuntimeError(
                    f"tippecanoeThreads must be between 1 and 64 for tileset {tileset_id}."
                )
            tippecanoe_threads = str(tippecanoe_thread_count)
        else:
            tippecanoe_threads = "ALL_CPUS"
        if gdal_threads.upper() != "ALL_CPUS":
            try:
                gdal_thread_count = int(gdal_threads)
            except ValueError as exc:
                raise RuntimeError(
                    f"gdalThreads must be ALL_CPUS or an integer for tileset {tileset_id}."
                ) from exc
            if gdal_thread_count < 1 or gdal_thread_count > 64:
                raise RuntimeError(f"gdalThreads must be between 1 and 64 for tileset {tileset_id}.")
            gdal_threads = str(gdal_thread_count)
        else:
            gdal_threads = "ALL_CPUS"
        duplicate_layers = sorted(
            layer_id
            for layer_id in {layer.layer_id for layer in layers}
            if sum(1 for layer in layers if layer.layer_id == layer_id) > 1
        )
        if duplicate_layers:
            raise RuntimeError(
                f"Tileset {tileset_id} contains duplicate layer IDs: {', '.join(duplicate_layers)}"
            )
        raw_publication_bounds = raw.get(
            "publicationBounds",
            defaults.get("publicationBounds", [-180.0, -85.05112878, 180.0, 85.05112878]),
        )
        if not isinstance(raw_publication_bounds, list) or len(raw_publication_bounds) != 4:
            raise RuntimeError(f"publicationBounds must contain west, south, east, north for {tileset_id}.")
        publication_bounds = tuple(float(value) for value in raw_publication_bounds)
        if not (
            -180 <= publication_bounds[0] < publication_bounds[2] <= 180
            and -85.05112878 <= publication_bounds[1] < publication_bounds[3] <= 85.05112878
        ):
            raise RuntimeError(f"publicationBounds is invalid for tileset {tileset_id}.")
        layers = [replace(layer, publication_bounds=publication_bounds) for layer in layers]
        tilesets.append(
            Tileset(
                tileset_id=tileset_id,
                name=str(raw.get("name") or tileset_id),
                description=str(raw.get("description") or ""),
                output=_expand(output_value, base, environment),
                layers=tuple(layers),
                extent=int(raw.get("extent", defaults.get("extent", 4096))),
                buffer=int(raw.get("buffer", defaults.get("buffer", 64))),
                simplification=float(raw.get("simplification", defaults.get("simplification", 1.0))),
                memory_limit=str(raw.get("memoryLimit", defaults.get("memoryLimit", "4GB"))),
                temporary_directory=temporary_directory,
                progress_file=progress_file,
                worker_count=worker_count,
                threads_per_worker=threads_per_worker,
                engine=engine,
                fallback_engine=fallback_engine,
                tippecanoe_executable=tippecanoe_executable,
                tippecanoe_threads=tippecanoe_threads,
                tippecanoe_group_workers=tippecanoe_group_workers,
                gdal_executable=gdal_executable,
                gdal_threads=gdal_threads,
                publication_bounds=publication_bounds,
            )
        )
    if not tilesets:
        raise RuntimeError("No enabled PMTiles tileset matched the request.")
    return config, tilesets


def _mercator_to_lon_lat(x: float, y: float) -> tuple[float, float]:
    longitude = x / WORLD_HALF_METERS * 180.0
    latitude = math.degrees(2 * math.atan(math.exp(y / 6_378_137.0)) - math.pi / 2)
    return max(-180.0, min(180.0, longitude)), max(-85.05112878, min(85.05112878, latitude))


def _lon_lat_to_mercator(longitude: float, latitude: float) -> tuple[float, float]:
    x = longitude / 180.0 * WORLD_HALF_METERS
    clipped_latitude = max(-85.05112878, min(85.05112878, latitude))
    y = 6_378_137.0 * math.log(math.tan(math.pi / 4 + math.radians(clipped_latitude) / 2))
    return x, y


def _mercator_bounds_to_lon_lat(
    bounds: tuple[float, float, float, float],
) -> list[float]:
    west, south = _mercator_to_lon_lat(bounds[0], bounds[1])
    east, north = _mercator_to_lon_lat(bounds[2], bounds[3])
    return [west, south, east, north]


def _validate_layer_publication_bounds(
    tileset: Tileset,
    results: Iterable[LayerBuildResult],
) -> None:
    allowed_west, allowed_south, allowed_east, allowed_north = tileset.publication_bounds
    rejected: list[str] = []
    for result in results:
        west, south, east, north = _mercator_bounds_to_lon_lat(result.bounds)
        if west < allowed_west or south < allowed_south or east > allowed_east or north > allowed_north:
            rejected.append(
                f"{result.layer_id} [{west:.5f}, {south:.5f}, {east:.5f}, {north:.5f}]"
            )
    if rejected:
        raise RuntimeError(
            "PMTiles publication rejected layers outside the configured build bounds "
            f"{list(tileset.publication_bounds)}: {'; '.join(rejected)}"
        )


def _feature_id_expressions(layer: Layer, geometry: str) -> tuple[str, str]:
    if layer.feature_id_column:
        source_column = _quote_identifier(layer.feature_id_column)
        numeric = f"CAST({source_column} AS BIGINT)"
        return numeric, f"CAST({source_column} AS VARCHAR)"
    hash_inputs = [_quote_identifier(name) for name in layer.feature_hash_columns]
    hash_inputs.append(f"ST_AsWKB({geometry})")
    numeric = f"CAST(hash({', '.join(hash_inputs)}) & 9223372036854775807 AS BIGINT)"
    return numeric, f"CAST({numeric} AS VARCHAR)"


def _prepare_layer(
    connection: Any,
    layer: Layer,
    temporary_directory: Path,
    memory_limit: str,
    threads_per_worker: int,
) -> tuple[int, tuple[float, float, float, float], int]:
    temporary_directory.mkdir(parents=True, exist_ok=True)
    connection.execute(f"SET memory_limit = {_sql_string(memory_limit)}")
    connection.execute(f"SET temp_directory = {_sql_string(str(temporary_directory))}")
    connection.execute(f"SET threads = {int(threads_per_worker)}")
    property_select = ",\n                ".join(
        f"{_property_expression(item)} AS {_quote_identifier(item.alias)}" for item in layer.properties
    )
    if property_select:
        property_select += ",\n                "
    geometry = _quote_identifier(layer.geometry_column)
    feature_id, portal_feature_id = _feature_id_expressions(layer, geometry)
    source = _qualified_table(layer.schema, layer.table)
    source_feature_count = int(
        connection.execute(
            f"SELECT count(*) FROM {source} WHERE {geometry} IS NOT NULL AND NOT ST_IsEmpty({geometry})"
        ).fetchone()[0]
        or 0
    )
    minimum_x, minimum_y = _lon_lat_to_mercator(
        layer.publication_bounds[0], layer.publication_bounds[1]
    )
    maximum_x, maximum_y = _lon_lat_to_mercator(
        layer.publication_bounds[2], layer.publication_bounds[3]
    )
    publication_envelope = (
        f"ST_MakeEnvelope({minimum_x:.8f}, {minimum_y:.8f}, {maximum_x:.8f}, {maximum_y:.8f})"
    )
    connection.execute("DROP TABLE IF EXISTS __portal_pmtiles_prepared")
    connection.execute(
        f"""
        CREATE TEMP TABLE __portal_pmtiles_prepared AS
        WITH transformed AS MATERIALIZED (
            SELECT
                {feature_id} AS feature_id,
                {portal_feature_id} AS portal_feature_id,
                {property_select}
                ST_Transform(
                    CASE
                        WHEN ST_IsValid({geometry}) THEN {geometry}
                        ELSE ST_MakeValid({geometry})
                    END,
                    'EPSG:{layer.source_srid}',
                    'EPSG:3857',
                    always_xy := true
                ) AS geometry
            FROM {source}
            WHERE {geometry} IS NOT NULL AND NOT ST_IsEmpty({geometry})
        ), clipped AS MATERIALIZED (
            SELECT
                * EXCLUDE (geometry),
                ST_Intersection(geometry, {publication_envelope}) AS geometry
            FROM transformed
            WHERE geometry IS NOT NULL AND ST_Intersects(geometry, {publication_envelope})
        )
        SELECT
            *,
            ST_XMin(geometry) AS minimum_x,
            ST_YMin(geometry) AS minimum_y,
            ST_XMax(geometry) AS maximum_x,
            ST_YMax(geometry) AS maximum_y
        FROM clipped
        WHERE geometry IS NOT NULL AND NOT ST_IsEmpty(geometry)
        """
    )
    row = connection.execute(
        """
        SELECT count(*), min(minimum_x), min(minimum_y), max(maximum_x), max(maximum_y)
        FROM __portal_pmtiles_prepared
        """
    ).fetchone()
    count = int(row[0] or 0)
    if not count:
        raise RuntimeError(f"Layer {layer.layer_id} contains no usable geometry.")
    return (
        count,
        (float(row[1]), float(row[2]), float(row[3]), float(row[4])),
        max(0, source_feature_count - count),
    )


def _mvt_struct(layer: Layer) -> str:
    values = [
        "'geometry': geometry",
        "'feature_id': feature_id",
        "'__portal_feature_id': portal_feature_id",
    ]
    values.extend(f"{_sql_string(item.source_name)}: {_quote_identifier(item.alias)}" for item in layer.properties)
    return "{" + ", ".join(values) + "}"


def _tile_query(layer: Layer, zoom: int, extent: int, buffer: int, simplification: float) -> str:
    scale = 1 << zoom
    tolerance = WORLD_WIDTH_METERS / (extent * scale) * simplification
    simplified = (
        "geometry"
        if zoom >= layer.maximum_zoom or simplification <= 0
        else f"ST_SimplifyPreserveTopology(geometry, {tolerance:.12f})"
    )
    properties = ", ".join(_quote_identifier(item.alias) for item in layer.properties)
    if properties:
        properties = ", " + properties
    return f"""
        WITH zoom_geometry AS MATERIALIZED (
            SELECT feature_id, portal_feature_id{properties}, {simplified} AS geometry,
                   minimum_x, minimum_y, maximum_x, maximum_y
            FROM __portal_pmtiles_prepared
        ), expanded AS (
            SELECT
                tile_x.range::INTEGER AS tile_x,
                tile_y.range::INTEGER AS tile_y,
                feature_id, portal_feature_id{properties}, geometry
            FROM zoom_geometry
            CROSS JOIN LATERAL range(
                greatest(0, floor(((minimum_x + {WORLD_HALF_METERS}) / {WORLD_WIDTH_METERS}) * {scale})::BIGINT),
                least({scale}, floor(((maximum_x + {WORLD_HALF_METERS}) / {WORLD_WIDTH_METERS}) * {scale})::BIGINT + 1)
            ) AS tile_x
            CROSS JOIN LATERAL range(
                greatest(0, floor((({WORLD_HALF_METERS} - maximum_y) / {WORLD_WIDTH_METERS}) * {scale})::BIGINT),
                least({scale}, floor((({WORLD_HALF_METERS} - minimum_y) / {WORLD_WIDTH_METERS}) * {scale})::BIGINT + 1)
            ) AS tile_y
        ), clipped AS (
            SELECT
                tile_x, tile_y, feature_id, portal_feature_id{properties},
                ST_AsMVTGeom(
                    geometry,
                    ST_Extent(ST_TileEnvelope({zoom}, tile_x, tile_y)),
                    {extent},
                    {buffer},
                    true
                ) AS geometry
            FROM expanded
        )
        SELECT
            tile_x,
            tile_y,
            ST_AsMVT(
                {_mvt_struct(layer)},
                {_sql_string(layer.layer_id)},
                {extent},
                'geometry',
                'feature_id'
            ) AS tile_data
        FROM clipped
        WHERE geometry IS NOT NULL AND NOT ST_IsEmpty(geometry)
        GROUP BY tile_x, tile_y
        ORDER BY tile_x, tile_y
    """


def _build_layer_parts(
    parts: sqlite3.Connection,
    layer_order: int,
    layer: Layer,
    extent: int,
    buffer: int,
    simplification: float,
    temporary_directory: Path,
    memory_limit: str,
    threads_per_worker: int,
    total_layers: int,
) -> tuple[int, int, tuple[float, float, float, float], int]:
    duckdb = _load_duckdb()
    connection = duckdb.connect(str(layer.database), read_only=True)
    try:
        _load_spatial(connection)
        feature_count, bounds, excluded_feature_count = _prepare_layer(
            connection,
            layer,
            temporary_directory,
            memory_limit,
            threads_per_worker,
        )
        tile_count = 0
        for zoom in range(layer.minimum_zoom, layer.maximum_zoom + 1):
            started = time.perf_counter()
            cursor = connection.execute(
                _tile_query(layer, zoom, extent, buffer, simplification)
            )
            zoom_tiles = 0
            while True:
                rows = cursor.fetchmany(500)
                if not rows:
                    break
                insert_rows = []
                for x, y, data in rows:
                    value = bytes(data or b"")
                    if not value:
                        continue
                    insert_rows.append((zxy_to_tile_id(zoom, int(x), int(y)), layer_order, value))
                if insert_rows:
                    parts.executemany(
                        "INSERT OR REPLACE INTO tile_parts(tile_id, layer_order, tile_data) VALUES (?, ?, ?)",
                        insert_rows,
                    )
                    zoom_tiles += len(insert_rows)
            parts.commit()
            tile_count += zoom_tiles
            print(
                f"  [{layer_order + 1}/{total_layers}] {layer.layer_id}: "
                f"zoom {zoom} -> {zoom_tiles:,} tiles "
                f"({time.perf_counter() - started:.1f} sec)",
                flush=True,
            )
        return feature_count, tile_count, bounds, excluded_feature_count
    finally:
        connection.close()


def _safe_file_component(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-.") or "tileset"


def _layer_parts_path(
    temporary_directory: Path,
    tileset_id: str,
    build_id: str,
    layer_order: int,
) -> Path:
    return temporary_directory / (
        f"{_safe_file_component(tileset_id)}-{build_id}-layer-{layer_order + 1:03d}.sqlite3"
    )


def _build_layer_fragment(
    layer_order: int,
    total_layers: int,
    layer: Layer,
    tileset_id: str,
    build_id: str,
    extent: int,
    buffer: int,
    simplification: float,
    temporary_directory: Path,
    memory_limit: str,
    threads_per_worker: int,
) -> LayerBuildResult:
    parts_path = _layer_parts_path(temporary_directory, tileset_id, build_id, layer_order)
    worker_temp = temporary_directory / (
        f"{_safe_file_component(tileset_id)}-{build_id}-duckdb-{layer_order + 1:03d}"
    )
    parts_path.unlink(missing_ok=True)
    worker_temp.mkdir(parents=True, exist_ok=True)
    parts = sqlite3.connect(parts_path)
    try:
        parts.execute("PRAGMA journal_mode=OFF")
        parts.execute("PRAGMA synchronous=OFF")
        parts.execute(
            """
            CREATE TABLE tile_parts (
                tile_id INTEGER NOT NULL,
                layer_order INTEGER NOT NULL,
                tile_data BLOB NOT NULL,
                PRIMARY KEY (tile_id, layer_order)
            ) WITHOUT ROWID
            """
        )
        print(
            f"Layer {layer_order + 1}/{total_layers} started: {layer.layer_id}",
            flush=True,
        )
        feature_count, tile_count, bounds, excluded_feature_count = _build_layer_parts(
            parts,
            layer_order,
            layer,
            extent,
            buffer,
            simplification,
            worker_temp,
            memory_limit,
            threads_per_worker,
            total_layers,
        )
        parts.commit()
        print(
            f"Layer {layer_order + 1}/{total_layers} completed: {layer.layer_id} "
            f"({feature_count:,} features, {tile_count:,} tile parts)",
            flush=True,
        )
        return LayerBuildResult(
            layer_order=layer_order,
            layer_id=layer.layer_id,
            parts_path=parts_path,
            feature_count=feature_count,
            tile_count=tile_count,
            bounds=bounds,
            source_feature_count=feature_count + excluded_feature_count,
            excluded_feature_count=excluded_feature_count,
        )
    except Exception:
        parts.close()
        parts_path.unlink(missing_ok=True)
        raise
    finally:
        try:
            parts.close()
        except Exception:
            pass
        shutil.rmtree(worker_temp, ignore_errors=True)


def _flatgeobuf_layer_path(stage_directory: Path, layer_order: int, layer: Layer) -> Path:
    return stage_directory / (
        f"{layer_order + 1:03d}-{_safe_file_component(layer.layer_id)}.fgb"
    )


def _resolve_gdal_executable(configured: str = "") -> Path:
    candidates: list[Path] = []
    configured_value = os.path.expandvars(os.path.expanduser(configured.strip()))
    if configured_value:
        configured_path = Path(configured_value)
        if configured_path.is_absolute() or any(value in configured_value for value in ("/", "\\")):
            candidates.append(
                configured_path if configured_path.is_absolute() else SCRIPT_DIRECTORY / configured_path
            )
        else:
            located = shutil.which(configured_value)
            if located:
                candidates.append(Path(located))
    located = shutil.which("ogr2ogr")
    if located:
        candidates.append(Path(located))
    executable_directory = Path(sys.executable).resolve().parent
    candidates.extend(
        [
            executable_directory / "Library" / "bin" / "ogr2ogr.exe",
            Path(sys.prefix).resolve() / "Library" / "bin" / "ogr2ogr.exe",
        ]
    )
    conda_prefix = os.environ.get("CONDA_PREFIX")
    if conda_prefix:
        candidates.append(Path(conda_prefix) / "Library" / "bin" / "ogr2ogr.exe")
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.resolve(strict=False)).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.is_file():
            return candidate.resolve()
    raise GdalUnavailableError(
        "GDAL ogr2ogr was not found. Configure gdalExecutable or install GDAL in the configured Python environment."
    )


def _gdal_environment(executable: Path, threads: str) -> dict[str, str]:
    environment = dict(os.environ)
    bin_directory = executable.parent
    environment["PATH"] = str(bin_directory) + os.pathsep + environment.get("PATH", "")
    library_directory = bin_directory.parent
    data_directory = library_directory / "share" / "gdal"
    proj_directory = library_directory / "share" / "proj"
    if data_directory.is_dir():
        environment["GDAL_DATA"] = str(data_directory)
    if proj_directory.is_dir():
        environment["PROJ_LIB"] = str(proj_directory)
    environment["GDAL_NUM_THREADS"] = threads
    environment.setdefault("GDAL_XML_VALIDATION", "NO")
    return environment


def _validate_gdal(executable: Path, environment: dict[str, str]) -> None:
    try:
        result = subprocess.run(
            [str(executable), "--formats"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            env=environment,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GdalUnavailableError(f"GDAL could not be started: {exc}") from exc
    output = f"{result.stdout}\n{result.stderr}"
    if result.returncode != 0:
        raise GdalUnavailableError(
            f"GDAL format validation failed with exit code {result.returncode}: {output.strip()}"
        )
    missing = [name for name in ("PMTiles", "FlatGeobuf") if name.lower() not in output.lower()]
    if missing:
        raise GdalUnavailableError(
            "The configured GDAL installation is missing required drivers: " + ", ".join(missing)
        )


def _export_flatgeobuf_layer(
    layer_order: int,
    total_layers: int,
    layer: Layer,
    stage_directory: Path,
    memory_limit: str,
    threads_per_worker: int,
    engine: str,
) -> LayerBuildResult:
    output = _flatgeobuf_layer_path(stage_directory, layer_order, layer)
    worker_temp = stage_directory / f"duckdb-{layer_order + 1:03d}"
    output.unlink(missing_ok=True)
    worker_temp.mkdir(parents=True, exist_ok=True)
    duckdb = _load_duckdb()
    connection = duckdb.connect(str(layer.database), read_only=True)
    try:
        _load_spatial(connection)
        print(
            f"{engine.title()} staging {layer_order + 1}/{total_layers}: {layer.layer_id}",
            flush=True,
        )
        feature_count, bounds, excluded_feature_count = _prepare_layer(
            connection,
            layer,
            worker_temp,
            memory_limit,
            threads_per_worker,
        )
        selections: list[str] = [
            "feature_id AS __portal_mvt_id",
            "portal_feature_id AS __portal_feature_id",
        ]
        selections.extend(
            f"{_quote_identifier(item.alias)} AS {_quote_identifier(item.source_name)}"
            for item in layer.properties
        )
        selections.append("geometry")
        connection.execute(
            f"""
            COPY (
                SELECT {', '.join(selections)}
                FROM __portal_pmtiles_prepared
            ) TO {_sql_string(output.as_posix())}
            WITH (FORMAT GDAL, DRIVER 'FlatGeobuf')
            """
        )
        if not output.is_file() or output.stat().st_size <= 0:
            raise RuntimeError(f"{engine.title()} staging did not create {output}")
        print(
            f"{engine.title()} staged {layer_order + 1}/{total_layers}: {layer.layer_id} "
            f"({feature_count:,} features, {output.stat().st_size:,} bytes)",
            flush=True,
        )
        return LayerBuildResult(
            layer_order=layer_order,
            layer_id=layer.layer_id,
            parts_path=output,
            feature_count=feature_count,
            tile_count=0,
            bounds=bounds,
            source_feature_count=feature_count + excluded_feature_count,
            excluded_feature_count=excluded_feature_count,
        )
    finally:
        connection.close()
        shutil.rmtree(worker_temp, ignore_errors=True)


def _submit_flatgeobuf_layer(
    executor: ProcessPoolExecutor,
    layer_order: int,
    tileset: Tileset,
    stage_directory: Path,
    engine: str,
) -> Future[LayerBuildResult]:
    return executor.submit(
        _export_flatgeobuf_layer,
        layer_order,
        len(tileset.layers),
        tileset.layers[layer_order],
        stage_directory,
        tileset.memory_limit,
        tileset.threads_per_worker,
        engine,
    )


def _stage_flatgeobuf_layers(
    tileset: Tileset,
    stage_directory: Path,
    started_at: str,
    worker_count: int,
    engine: str,
) -> list[LayerBuildResult]:
    effective_workers = max(1, min(worker_count, len(tileset.layers)))
    completed: list[LayerBuildResult] = []
    pending = deque(range(len(tileset.layers)))
    running: dict[Future[LayerBuildResult], int] = {}
    executor = ProcessPoolExecutor(max_workers=effective_workers)
    try:
        while pending and len(running) < effective_workers:
            layer_order = pending.popleft()
            running[
                _submit_flatgeobuf_layer(
                    executor, layer_order, tileset, stage_directory, engine
                )
            ] = layer_order
        _write_build_progress(
            tileset,
            "building",
            started_at,
            completed,
            running.values(),
            effective_workers,
            engine=engine,
            phase="staging",
            message=f"Preparing selected fields and geometry for {engine.title()}.",
        )
        while running:
            finished, _unfinished = wait(running, return_when=FIRST_COMPLETED)
            for future in finished:
                running.pop(future)
                completed.append(future.result())
                if pending:
                    layer_order = pending.popleft()
                    running[
                        _submit_flatgeobuf_layer(
                            executor, layer_order, tileset, stage_directory, engine
                        )
                    ] = layer_order
                _write_build_progress(
                    tileset,
                    "building",
                    started_at,
                    completed,
                    running.values(),
                    effective_workers,
                    engine=engine,
                    phase="staging",
                    message=f"Preparing selected fields and geometry for {engine.title()}.",
                )
        executor.shutdown(wait=True)
        return completed
    except Exception:
        for future in running:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)
        raise


def _ogr_field_definition(item: Property) -> dict[str, str]:
    base = _type_base(item.source_type)
    if base == "BOOLEAN":
        return {"type": "Integer", "subtype": "Boolean"}
    if item.metadata_type == "Number":
        return {"type": "Real" if base in {"FLOAT", "DOUBLE", "REAL", "DECIMAL"} else "Integer64"}
    return {"type": "String"}


def _write_gdal_vrt(
    path: Path,
    tileset: Tileset,
    completed: list[LayerBuildResult],
) -> None:
    root = ElementTree.Element("OGRVRTDataSource")
    by_order = {result.layer_order: result for result in completed}
    for layer_order, layer in enumerate(tileset.layers):
        result = by_order[layer_order]
        layer_node = ElementTree.SubElement(root, "OGRVRTLayer", {"name": layer.layer_id})
        source_node = ElementTree.SubElement(
            layer_node,
            "SrcDataSource",
            {"relativeToVRT": "1"},
        )
        source_node.text = result.parts_path.name
        ElementTree.SubElement(layer_node, "SrcLayer").text = result.parts_path.stem
        ElementTree.SubElement(layer_node, "LayerSRS").text = "EPSG:3857"
        ElementTree.SubElement(layer_node, "FID", {"name": ""}).text = "__portal_mvt_id"
        ElementTree.SubElement(
            layer_node,
            "Field",
            {"name": "__portal_feature_id", "src": "__portal_feature_id", "type": "String"},
        )
        for item in layer.properties:
            attributes = {"name": item.source_name, "src": item.source_name}
            attributes.update(_ogr_field_definition(item))
            ElementTree.SubElement(layer_node, "Field", attributes)
        ElementTree.SubElement(layer_node, "FeatureCount").text = str(result.feature_count)
        for name, value in zip(
            ("ExtentXMin", "ExtentYMin", "ExtentXMax", "ExtentYMax"),
            result.bounds,
        ):
            ElementTree.SubElement(layer_node, name).text = repr(float(value))
    tree = ElementTree.ElementTree(root)
    ElementTree.indent(tree, space="  ")
    tree.write(path, encoding="utf-8", xml_declaration=True)


def _write_gdal_layer_configuration(path: Path, tileset: Tileset) -> None:
    _atomic_json(
        path,
        {
            layer.layer_id: {
                "target_name": layer.layer_id,
                "description": "",
                "minzoom": layer.minimum_zoom,
                "maxzoom": layer.maximum_zoom,
            }
            for layer in tileset.layers
        },
    )


def _read_pmtiles_metadata(path: Path, header: dict[str, int | bool] | None = None) -> dict[str, Any]:
    value = header or read_header(path)
    with path.open("rb") as handle:
        handle.seek(int(value["metadata_offset"]))
        raw = handle.read(int(value["metadata_length"]))
    compression = int(value["internal_compression"])
    if compression == int(Compression.GZIP):
        raw = gzip.decompress(raw)
    elif compression != int(Compression.NONE):
        raise RuntimeError(f"Unsupported PMTiles metadata compression: {compression}")
    try:
        metadata = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Invalid PMTiles metadata in {path}: {exc}") from exc
    if not isinstance(metadata, dict):
        raise RuntimeError(f"Expected a PMTiles metadata object in {path}")
    return metadata


def _validate_pmtiles_archive(
    path: Path,
    tileset: Tileset,
    engine_label: str,
) -> tuple[dict[str, int | bool], dict[str, Any]]:
    if not path.is_file() or path.stat().st_size <= 127:
        raise RuntimeError(f"{engine_label} did not create a valid PMTiles file: {path}")
    header = read_header(path)
    if int(header["tile_type"]) != int(TileType.MVT):
        raise RuntimeError(f"{engine_label} produced a PMTiles archive that is not MVT.")
    if int(header["addressed_tiles_count"]) <= 0:
        raise RuntimeError(f"{engine_label} produced a PMTiles archive with no addressed tiles.")
    metadata = _read_pmtiles_metadata(path, header)
    vector_layers = metadata.get("vector_layers")
    if not isinstance(vector_layers, list):
        raise RuntimeError(f"{engine_label} PMTiles metadata does not contain vector_layers.")
    metadata_by_id = {
        str(item.get("id")): item
        for item in vector_layers
        if isinstance(item, dict) and item.get("id")
    }
    expected_ids = [layer.layer_id for layer in tileset.layers]
    if set(metadata_by_id) != set(expected_ids):
        missing = sorted(set(expected_ids) - set(metadata_by_id))
        unexpected = sorted(set(metadata_by_id) - set(expected_ids))
        raise RuntimeError(
            f"{engine_label} PMTiles layer validation failed. "
            f"Missing: {', '.join(missing) or 'none'}; "
            f"unexpected: {', '.join(unexpected) or 'none'}."
        )
    for layer in tileset.layers:
        layer_metadata = metadata_by_id[layer.layer_id]
        fields = layer_metadata.get("fields")
        actual_fields = set(fields) if isinstance(fields, dict) else set()
        expected_fields = set(_metadata_fields(layer))
        if actual_fields != expected_fields:
            raise RuntimeError(
                f"{engine_label} field validation failed for {layer.layer_id}. "
                f"Expected {sorted(expected_fields)}, found {sorted(actual_fields)}."
            )
        try:
            actual_minimum_zoom = int(layer_metadata["minzoom"])
            actual_maximum_zoom = int(layer_metadata["maxzoom"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(
                f"{engine_label} zoom metadata is missing for {layer.layer_id}."
            ) from exc
        if (
            actual_minimum_zoom != layer.minimum_zoom
            or actual_maximum_zoom != layer.maximum_zoom
        ):
            raise RuntimeError(
                f"{engine_label} zoom validation failed for {layer.layer_id}. "
                f"Expected {layer.minimum_zoom}-{layer.maximum_zoom}, found "
                f"{actual_minimum_zoom}-{actual_maximum_zoom}."
            )
    return header, metadata


def _run_gdal_pmtiles(
    executable: Path,
    environment: dict[str, str],
    tileset: Tileset,
    source_vrt: Path,
    layer_configuration: Path,
    output: Path,
    started_at: str,
    completed: list[LayerBuildResult],
    worker_count: int,
) -> None:
    minimum_zoom = min(layer.minimum_zoom for layer in tileset.layers)
    maximum_zoom = max(layer.maximum_zoom for layer in tileset.layers)
    command = [
        str(executable),
        "-f",
        "PMTiles",
        str(output),
        str(source_vrt),
        "-dsco",
        f"NAME={tileset.name}",
        "-dsco",
        f"DESCRIPTION={tileset.description}",
        "-dsco",
        f"MINZOOM={minimum_zoom}",
        "-dsco",
        f"MAXZOOM={maximum_zoom}",
        "-dsco",
        f"CONF={layer_configuration}",
        "-dsco",
        f"EXTENT={tileset.extent}",
        "-dsco",
        f"BUFFER={tileset.buffer}",
        "-dsco",
        f"SIMPLIFICATION={tileset.simplification}",
        "-dsco",
        "SIMPLIFICATION_MAX_ZOOM=0",
        "-progress",
    ]
    _write_build_progress(
        tileset,
        "building",
        started_at,
        completed,
        [],
        worker_count,
        engine="gdal",
        phase="encoding",
        phase_percent=0,
        message="GDAL is encoding the tileset PMTiles archive.",
    )
    print(
        f"GDAL is encoding {len(tileset.layers)} layers with GDAL_NUM_THREADS={tileset.gdal_threads}.",
        flush=True,
    )
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except OSError as exc:
        raise GdalUnavailableError(f"GDAL could not be started: {exc}") from exc
    output_text: list[str] = []
    recent = ""
    last_percent = -1
    assert process.stdout is not None
    while True:
        value = process.stdout.read(1)
        if not value:
            break
        print(value, end="", flush=True)
        output_text.append(value)
        recent = (recent + value)[-64:]
        matches = list(re.finditer(r"(?<!\d)(\d{1,3})\.\.\.", recent))
        if matches:
            percent = min(100, int(matches[-1].group(1)))
            if percent != last_percent:
                last_percent = percent
                _write_build_progress(
                    tileset,
                    "building",
                    started_at,
                    completed,
                    [],
                    worker_count,
                    engine="gdal",
                    phase="encoding",
                    phase_percent=percent,
                    message="GDAL is encoding the tileset PMTiles archive.",
                )
    process.stdout.close()
    return_code = process.wait()
    if return_code != 0:
        details = "".join(output_text)[-4000:].strip()
        raise RuntimeError(f"GDAL PMTiles conversion failed with exit code {return_code}: {details}")


def _combine_layer_fragments(results: list[LayerBuildResult], writer: Writer) -> int:
    connections: list[sqlite3.Connection] = []
    cursors: list[sqlite3.Cursor] = []
    queue: list[tuple[int, int, int, bytes]] = []
    count = 0
    try:
        for stream_index, result in enumerate(sorted(results, key=lambda item: item.layer_order)):
            connection = sqlite3.connect(result.parts_path)
            cursor = connection.execute(
                "SELECT tile_id, layer_order, tile_data FROM tile_parts ORDER BY tile_id"
            )
            connections.append(connection)
            cursors.append(cursor)
            row = cursor.fetchone()
            if row:
                heapq.heappush(
                    queue,
                    (int(row[0]), int(row[1]), stream_index, bytes(row[2])),
                )

        while queue:
            tile_id = queue[0][0]
            chunks: list[tuple[int, bytes]] = []
            while queue and queue[0][0] == tile_id:
                _tile_id, layer_order, stream_index, data = heapq.heappop(queue)
                chunks.append((layer_order, data))
                row = cursors[stream_index].fetchone()
                if row:
                    heapq.heappush(
                        queue,
                        (int(row[0]), int(row[1]), stream_index, bytes(row[2])),
                    )
            chunks.sort(key=lambda item: item[0])
            writer.write_tile(
                tile_id,
                gzip.compress(b"".join(data for _order, data in chunks), mtime=0),
            )
            count += 1
        return count
    finally:
        for connection in connections:
            connection.close()


def _union_bounds(
    current: tuple[float, float, float, float] | None,
    value: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    if current is None:
        return value
    return (
        min(current[0], value[0]),
        min(current[1], value[1]),
        max(current[2], value[2]),
        max(current[3], value[3]),
    )


def _metadata_fields(layer: Layer) -> dict[str, str]:
    return {
        "__portal_feature_id": "String",
        **{item.source_name: item.metadata_type for item in layer.properties},
    }


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _write_build_progress(
    tileset: Tileset,
    status: str,
    started_at: str,
    completed: list[LayerBuildResult],
    active_orders: Iterable[int],
    worker_count: int,
    error: str = "",
    *,
    engine: str = "python",
    phase: str = "",
    phase_percent: int | None = None,
    message: str = "",
) -> None:
    completed_orders = {result.layer_order for result in completed}
    active = sorted(set(int(value) for value in active_orders))
    _atomic_json(
        tileset.progress_file,
        {
            "schemaVersion": 2,
            "tilesetId": tileset.tileset_id,
            "tilesetName": tileset.name,
            "status": status,
            "engine": engine,
            "phase": phase or status,
            "phasePercent": phase_percent,
            "message": message,
            "startedAt": started_at,
            "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "output": str(tileset.output),
            "workerCount": worker_count,
            "threadsPerWorker": tileset.threads_per_worker,
            "tippecanoeThreads": (
                tileset.tippecanoe_threads if engine == "tippecanoe" else ""
            ),
            "tippecanoeGroupWorkers": (
                tileset.tippecanoe_group_workers if engine == "tippecanoe" else 0
            ),
            "gdalThreads": tileset.gdal_threads if engine == "gdal" else "",
            "totalLayers": len(tileset.layers),
            "completedLayers": len(completed_orders),
            "completedLayerIds": [
                tileset.layers[index].layer_id for index in sorted(completed_orders)
            ],
            "activeLayers": [
                {"index": index + 1, "id": tileset.layers[index].layer_id}
                for index in active
            ],
            "error": error,
        },
    )


def _submit_layer(
    executor: ProcessPoolExecutor,
    layer_order: int,
    tileset: Tileset,
    build_id: str,
) -> Future[LayerBuildResult]:
    return executor.submit(
        _build_layer_fragment,
        layer_order,
        len(tileset.layers),
        tileset.layers[layer_order],
        tileset.tileset_id,
        build_id,
        tileset.extent,
        tileset.buffer,
        tileset.simplification,
        tileset.temporary_directory,
        tileset.memory_limit,
        tileset.threads_per_worker,
    )


def _build_layers(
    tileset: Tileset,
    build_id: str,
    started_at: str,
    worker_count: int,
) -> list[LayerBuildResult]:
    effective_workers = max(1, min(worker_count, len(tileset.layers)))
    completed: list[LayerBuildResult] = []
    if effective_workers == 1:
        for layer_order in range(len(tileset.layers)):
            _write_build_progress(
                tileset,
                "building",
                started_at,
                completed,
                [layer_order],
                effective_workers,
            )
            completed.append(
                _build_layer_fragment(
                    layer_order,
                    len(tileset.layers),
                    tileset.layers[layer_order],
                    tileset.tileset_id,
                    build_id,
                    tileset.extent,
                    tileset.buffer,
                    tileset.simplification,
                    tileset.temporary_directory,
                    tileset.memory_limit,
                    tileset.threads_per_worker,
                )
            )
        return completed

    pending = deque(range(len(tileset.layers)))
    running: dict[Future[LayerBuildResult], int] = {}
    executor = ProcessPoolExecutor(max_workers=effective_workers)
    try:
        while pending and len(running) < effective_workers:
            layer_order = pending.popleft()
            running[_submit_layer(executor, layer_order, tileset, build_id)] = layer_order
        _write_build_progress(
            tileset,
            "building",
            started_at,
            completed,
            running.values(),
            effective_workers,
        )

        while running:
            finished, _unfinished = wait(running, return_when=FIRST_COMPLETED)
            for future in finished:
                running.pop(future)
                completed.append(future.result())
                if pending:
                    layer_order = pending.popleft()
                    running[_submit_layer(executor, layer_order, tileset, build_id)] = layer_order
                _write_build_progress(
                    tileset,
                    "building",
                    started_at,
                    completed,
                    running.values(),
                    effective_workers,
                )
        executor.shutdown(wait=True)
        return completed
    except Exception:
        for future in running:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)
        raise


def _build_tileset_python(tileset: Tileset, worker_count_override: int | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    started_at = datetime.now().astimezone().isoformat(timespec="seconds")
    tileset.output.parent.mkdir(parents=True, exist_ok=True)
    tileset.temporary_directory.mkdir(parents=True, exist_ok=True)
    working_archive = tileset.output.with_name(f".{tileset.output.name}.{os.getpid()}.building")
    build_id = f"{os.getpid()}-{int(time.time())}"
    worker_count = int(worker_count_override or tileset.worker_count)
    if worker_count < 1 or worker_count > 8:
        raise RuntimeError("PMTiles worker count must be between 1 and 8.")
    fragment_paths = [
        _layer_parts_path(tileset.temporary_directory, tileset.tileset_id, build_id, index)
        for index in range(len(tileset.layers))
    ]
    working_archive.unlink(missing_ok=True)
    layer_results: list[dict[str, Any]] = []
    mercator_bounds: tuple[float, float, float, float] | None = None
    completed: list[LayerBuildResult] = []
    try:
        print(
            f"Building {tileset.name} with the Python engine, {len(tileset.layers)} layer(s), "
            f"{min(worker_count, len(tileset.layers))} worker(s), and "
            f"{tileset.threads_per_worker} DuckDB thread(s) per worker.",
            flush=True,
        )
        completed = _build_layers(tileset, build_id, started_at, worker_count)
        completed.sort(key=lambda item: item.layer_order)
        _validate_layer_publication_bounds(tileset, completed)
        _write_build_progress(
            tileset,
            "finalizing",
            started_at,
            completed,
            [],
            min(worker_count, len(tileset.layers)),
        )
        print("All layers completed. Merging and validating the PMTiles archive.", flush=True)
        for result in completed:
            layer = tileset.layers[result.layer_order]
            mercator_bounds = _union_bounds(mercator_bounds, result.bounds)
            layer_results.append(
                {
                    "id": layer.layer_id,
                    "database": str(layer.database),
                    "table": f"{layer.schema}.{layer.table}",
                    "featureCount": result.feature_count,
                    "sourceFeatureCount": result.source_feature_count,
                    "excludedFeatureCount": result.excluded_feature_count,
                    "tilePartCount": result.tile_count,
                    "sourceBounds": _mercator_bounds_to_lon_lat(result.bounds),
                    "stagedBytes": result.parts_path.stat().st_size if result.parts_path.is_file() else 0,
                    "archive": tileset.output.name,
                    "featureIdField": "__portal_feature_id",
                    "sourceFeatureIdColumn": layer.feature_id_column,
                    "featureIdStrategy": layer.feature_id_strategy,
                    "minimumZoom": layer.minimum_zoom,
                    "maximumZoom": layer.maximum_zoom,
                    "properties": [item.source_name for item in layer.properties],
                }
            )
        if mercator_bounds is None:
            raise RuntimeError(f"Tileset {tileset.tileset_id} produced no geometry.")
        minimum_lon, minimum_lat = _mercator_to_lon_lat(mercator_bounds[0], mercator_bounds[1])
        maximum_lon, maximum_lat = _mercator_to_lon_lat(mercator_bounds[2], mercator_bounds[3])
        minimum_zoom = min(layer.minimum_zoom for layer in tileset.layers)
        maximum_zoom = max(layer.maximum_zoom for layer in tileset.layers)
        metadata = {
            "name": tileset.name,
            "description": tileset.description,
            "version": "1",
            "format": "pbf",
            "minzoom": str(minimum_zoom),
            "maxzoom": str(maximum_zoom),
            "bounds": f"{minimum_lon},{minimum_lat},{maximum_lon},{maximum_lat}",
            "center": f"{(minimum_lon + maximum_lon) / 2},{(minimum_lat + maximum_lat) / 2},{minimum_zoom}",
            "vector_layers": [
                {
                    "id": layer.layer_id,
                    "fields": _metadata_fields(layer),
                    "minzoom": layer.minimum_zoom,
                    "maxzoom": layer.maximum_zoom,
                }
                for layer in tileset.layers
            ],
            "generator": "Portal Manager DuckDB PMTiles builder",
            "generator_options": (
                f"extent={tileset.extent};buffer={tileset.buffer};"
                f"simplification={tileset.simplification};workers={worker_count};"
                f"threads_per_worker={tileset.threads_per_worker}"
            ),
        }
        header = {
            "tile_compression": Compression.GZIP,
            "tile_type": TileType.MVT,
            "min_zoom": minimum_zoom,
            "max_zoom": maximum_zoom,
            "min_lon_e7": round(minimum_lon * 10_000_000),
            "min_lat_e7": round(minimum_lat * 10_000_000),
            "max_lon_e7": round(maximum_lon * 10_000_000),
            "max_lat_e7": round(maximum_lat * 10_000_000),
            "center_zoom": minimum_zoom,
            "center_lon_e7": round(((minimum_lon + maximum_lon) / 2) * 10_000_000),
            "center_lat_e7": round(((minimum_lat + maximum_lat) / 2) * 10_000_000),
        }
        with working_archive.open("wb") as destination:
            writer = Writer(destination)
            tile_count = _combine_layer_fragments(completed, writer)
            writer.finalize(header, metadata)
        verified_header = read_header(working_archive)
        if int(verified_header["addressed_tiles_count"]) != tile_count:
            raise RuntimeError("PMTiles validation found an unexpected tile count.")
        os.replace(working_archive, tileset.output)
        manifest = {
            "schemaVersion": 1,
            "tilesetId": tileset.tileset_id,
            "name": tileset.name,
            "engine": "python",
            "output": str(tileset.output),
            "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "sizeBytes": tileset.output.stat().st_size,
            "tileCount": tile_count,
            "averageTileBytes": round(tileset.output.stat().st_size / tile_count, 1),
            "minimumZoom": int(verified_header["min_zoom"]),
            "maximumZoom": int(verified_header["max_zoom"]),
            "bounds": [minimum_lon, minimum_lat, maximum_lon, maximum_lat],
            "layers": layer_results,
            "durationSeconds": round(time.perf_counter() - started, 3),
            "workerCount": min(worker_count, len(tileset.layers)),
            "threadsPerWorker": tileset.threads_per_worker,
        }
        _atomic_json(tileset.output.with_suffix(tileset.output.suffix + ".manifest.json"), manifest)
        _write_build_progress(
            tileset,
            "succeeded",
            started_at,
            completed,
            [],
            min(worker_count, len(tileset.layers)),
        )
        print(f"Published {tileset.output} ({tile_count:,} tiles).", flush=True)
        return manifest
    except Exception as exc:
        _write_build_progress(
            tileset,
            "failed",
            started_at,
            completed,
            [],
            min(worker_count, len(tileset.layers)),
            str(exc),
        )
        raise
    finally:
        working_archive.unlink(missing_ok=True)
        for path in fragment_paths:
            path.unlink(missing_ok=True)


def _resolve_tippecanoe_executables(configured: str = "") -> tuple[Path, Path]:
    candidates: list[Path] = []
    configured_value = os.path.expandvars(os.path.expanduser(configured.strip()))
    if configured_value:
        configured_path = Path(configured_value)
        if configured_path.is_absolute() or any(value in configured_value for value in ("/", "\\")):
            candidates.append(
                configured_path if configured_path.is_absolute() else SCRIPT_DIRECTORY / configured_path
            )
        else:
            located = shutil.which(configured_value)
            if located:
                candidates.append(Path(located))
    candidates.append(SCRIPT_DIRECTORY / "vendor" / "tippecanoe" / "tippecanoe.exe")
    located = shutil.which("tippecanoe")
    if located:
        candidates.append(Path(located))
    seen: set[str] = set()
    incomplete: list[str] = []
    for candidate in candidates:
        key = str(candidate.resolve(strict=False)).lower()
        if key in seen:
            continue
        seen.add(key)
        if not candidate.is_file():
            continue
        executable = candidate.resolve()
        tile_join_name = "tile-join.exe" if executable.suffix.lower() == ".exe" else "tile-join"
        tile_join = executable.with_name(tile_join_name)
        if not tile_join.is_file():
            located_join = shutil.which("tile-join")
            if located_join:
                tile_join = Path(located_join).resolve()
        if tile_join.is_file():
            return executable, tile_join.resolve()
        incomplete.append(f"{executable} (tile-join is missing)")
    detail = f" Found incomplete installations: {'; '.join(incomplete)}." if incomplete else ""
    raise TippecanoeUnavailableError(
        "Tippecanoe was not found. Keep the packaged runtime under "
        "map-tiles/vendor/tippecanoe or configure tippecanoeExecutable." + detail
    )


def _tippecanoe_environment(executable: Path, threads: str) -> tuple[dict[str, str], int]:
    environment = dict(os.environ)
    environment["PATH"] = str(executable.parent) + os.pathsep + environment.get("PATH", "")
    effective_threads = max(1, os.cpu_count() or 1) if threads == "ALL_CPUS" else int(threads)
    environment["TIPPECANOE_MAX_THREADS"] = str(effective_threads)
    return environment, effective_threads


def _validate_tippecanoe(
    executable: Path,
    tile_join: Path,
    environment: dict[str, str],
) -> str:
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        version_result = subprocess.run(
            [str(executable), "--version"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            env=environment,
            creationflags=creation_flags,
        )
        join_result = subprocess.run(
            [str(tile_join)],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            env=environment,
            creationflags=creation_flags,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise TippecanoeUnavailableError(f"Tippecanoe could not be started: {exc}") from exc
    version_output = f"{version_result.stdout}\n{version_result.stderr}".strip()
    if version_result.returncode != 0 or "tippecanoe" not in version_output.lower():
        raise TippecanoeUnavailableError(
            "Tippecanoe version validation failed "
            f"with exit code {version_result.returncode}: {version_output or 'no diagnostic output'}"
        )
    join_output = f"{join_result.stdout}\n{join_result.stderr}".strip()
    if "tile-join" not in join_output.lower():
        raise TippecanoeUnavailableError(
            "The packaged tile-join utility could not be validated "
            f"(exit code {join_result.returncode}): {join_output or 'no diagnostic output'}"
        )
    match = re.search(r"tippecanoe\s+v?([^\s]+)", version_output, re.IGNORECASE)
    return match.group(1) if match else version_output.splitlines()[0]


def _tippecanoe_buffer_pixels(tileset: Tileset) -> int:
    return max(0, round(tileset.buffer * 256 / max(1, tileset.extent)))


def _run_tippecanoe_group(
    executable: Path,
    environment: dict[str, str],
    tileset: Tileset,
    group_layers: list[tuple[Layer, LayerBuildResult]],
    output: Path,
    temporary_directory: Path,
    started_at: str,
    completed: list[LayerBuildResult],
    worker_count: int,
    group_index: int,
    group_count: int,
    completed_weight: int,
    group_weight: int,
    total_weight: int,
    report_progress: bool = True,
) -> None:
    minimum_zoom = group_layers[0][0].minimum_zoom
    maximum_zoom = group_layers[0][0].maximum_zoom
    temporary_directory.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    command = [
        str(executable),
        "--force",
        f"--output={output.as_posix()}",
        f"--name={tileset.name}",
        f"--description={tileset.description}",
        f"--minimum-zoom={minimum_zoom}",
        f"--maximum-zoom={maximum_zoom}",
        "--projection=EPSG:3857",
        "--exclude=__portal_mvt_id",
        f"--simplification={tileset.simplification}",
        "--simplify-only-low-zooms",
        "--no-tiny-polygon-reduction-at-maximum-zoom",
        "--no-feature-limit",
        "--no-tile-size-limit",
        "--drop-rate=1",
        f"--buffer={_tippecanoe_buffer_pixels(tileset)}",
        f"--temporary-directory={temporary_directory.as_posix()}",
        "--json-progress",
        "--progress-interval=1",
    ]
    for layer, result in group_layers:
        command.extend(["-L", f"{layer.layer_id}:{result.parts_path.as_posix()}"])
    message = (
        f"Tippecanoe is encoding zoom group {group_index} of {group_count} "
        f"({minimum_zoom}-{maximum_zoom})."
    )
    if report_progress:
        _write_build_progress(
            tileset,
            "building",
            started_at,
            completed,
            [],
            worker_count,
            engine="tippecanoe",
            phase="encoding",
            phase_percent=round(completed_weight / max(1, total_weight) * 100),
            message=message,
        )
    print(
        f"Tippecanoe is encoding group {group_index}/{group_count}: "
        f"{len(group_layers)} layer(s), zoom {minimum_zoom}-{maximum_zoom}.",
        flush=True,
    )
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except OSError as exc:
        raise TippecanoeUnavailableError(f"Tippecanoe could not be started: {exc}") from exc
    output_lines: deque[str] = deque(maxlen=200)
    last_percent = -1
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="", flush=True)
        output_lines.append(line)
        try:
            progress_value = json.loads(line.strip()).get("progress")
            progress = max(0.0, min(100.0, float(progress_value)))
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
            continue
        overall = round(
            (completed_weight + group_weight * progress / 100) / max(1, total_weight) * 100
        )
        overall = min(99, max(last_percent, overall))
        if report_progress and overall != last_percent:
            last_percent = overall
            _write_build_progress(
                tileset,
                "building",
                started_at,
                completed,
                [],
                worker_count,
                engine="tippecanoe",
                phase="encoding",
                phase_percent=overall,
                message=message,
            )
    process.stdout.close()
    return_code = process.wait()
    if return_code != 0:
        details = "".join(output_lines).strip()
        raise RuntimeError(
            f"Tippecanoe conversion failed with exit code {return_code}: "
            f"{details[-4000:] or 'no diagnostic output'}"
        )
    if not output.is_file() or output.stat().st_size <= 127:
        raise RuntimeError(f"Tippecanoe did not create the zoom-group archive: {output}")


def _run_tile_join(
    executable: Path,
    environment: dict[str, str],
    tileset: Tileset,
    inputs: list[Path],
    output: Path,
    started_at: str,
    completed: list[LayerBuildResult],
    worker_count: int,
) -> None:
    output.unlink(missing_ok=True)
    _write_build_progress(
        tileset,
        "finalizing",
        started_at,
        completed,
        [],
        worker_count,
        engine="tippecanoe",
        phase="merging",
        phase_percent=100,
        message=f"Merging {len(inputs)} zoom groups into one PMTiles archive.",
    )
    command = [
        str(executable),
        "-f",
        "-pk",
        "-o",
        output.as_posix(),
        "-n",
        tileset.name,
        "-N",
        tileset.description,
        *[path.as_posix() for path in inputs],
    ]
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.stdout:
        print(result.stdout, end="", flush=True)
    if result.stderr:
        print(result.stderr, end="", flush=True)
    if result.returncode != 0:
        details = f"{result.stdout}\n{result.stderr}".strip()
        raise RuntimeError(
            f"tile-join failed with exit code {result.returncode}: "
            f"{details[-4000:] or 'no diagnostic output'}"
        )


def _build_tileset_tippecanoe(
    tileset: Tileset,
    worker_count_override: int | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    started_at = datetime.now().astimezone().isoformat(timespec="seconds")
    executable, tile_join = _resolve_tippecanoe_executables(tileset.tippecanoe_executable)
    environment, effective_threads = _tippecanoe_environment(
        executable, tileset.tippecanoe_threads
    )
    version = _validate_tippecanoe(executable, tile_join, environment)
    tileset.output.parent.mkdir(parents=True, exist_ok=True)
    tileset.temporary_directory.mkdir(parents=True, exist_ok=True)
    build_id = f"{os.getpid()}-{int(time.time())}"
    stage_directory = tileset.temporary_directory / (
        f"{_safe_file_component(tileset.tileset_id)}-{build_id}-tippecanoe"
    )
    stage_directory.mkdir(parents=True, exist_ok=False)
    local_archive = stage_directory / f"{_safe_file_component(tileset.tileset_id)}.pmtiles"
    working_archive = tileset.output.with_name(f".{tileset.output.name}.{os.getpid()}.building")
    working_archive.unlink(missing_ok=True)
    worker_count = int(worker_count_override or tileset.worker_count)
    if worker_count < 1 or worker_count > 8:
        raise RuntimeError("PMTiles worker count must be between 1 and 8.")
    effective_workers = min(worker_count, len(tileset.layers))
    completed: list[LayerBuildResult] = []
    try:
        print(
            f"Building {tileset.name} with Tippecanoe {version}, {len(tileset.layers)} layer(s), "
            f"{effective_workers} staging worker(s), and {effective_threads} encoding thread(s).",
            flush=True,
        )
        print(f"Reading the authoritative source directly: {tileset.layers[0].database}", flush=True)
        completed = _stage_flatgeobuf_layers(
            tileset,
            stage_directory,
            started_at,
            worker_count,
            "tippecanoe",
        )
        completed.sort(key=lambda item: item.layer_order)
        _validate_layer_publication_bounds(tileset, completed)
        by_order = {result.layer_order: result for result in completed}
        grouped: dict[tuple[int, int], list[tuple[Layer, LayerBuildResult]]] = {}
        for layer_order, layer in enumerate(tileset.layers):
            grouped.setdefault((layer.minimum_zoom, layer.maximum_zoom), []).append(
                (layer, by_order[layer_order])
            )
        groups = sorted(grouped.items())
        total_weight = sum(max(1, result.feature_count) for result in completed)
        completed_weight = 0
        group_worker_count = min(tileset.tippecanoe_group_workers, len(groups))
        threads_per_group = max(1, math.ceil(effective_threads / group_worker_count))
        group_environment = dict(environment)
        group_environment["TIPPECANOE_MAX_THREADS"] = str(threads_per_group)
        group_jobs: list[
            tuple[int, int, int, list[tuple[Layer, LayerBuildResult]], Path, Path, int]
        ] = []
        for group_index, ((minimum_zoom, maximum_zoom), group_layers) in enumerate(groups, 1):
            group_archive = stage_directory / (
                f"group-{group_index:02d}-{minimum_zoom}-{maximum_zoom}.pmtiles"
            )
            group_temp = stage_directory / f"tippecanoe-temp-{group_index:02d}"
            group_weight = sum(max(1, result.feature_count) for _layer, result in group_layers)
            group_jobs.append(
                (
                    group_index,
                    minimum_zoom,
                    maximum_zoom,
                    group_layers,
                    group_archive,
                    group_temp,
                    group_weight,
                )
            )
        group_archives = [job[4] for job in group_jobs]
        if group_worker_count == 1:
            for (
                group_index,
                _minimum_zoom,
                _maximum_zoom,
                group_layers,
                group_archive,
                group_temp,
                group_weight,
            ) in group_jobs:
                _run_tippecanoe_group(
                    executable,
                    group_environment,
                    tileset,
                    group_layers,
                    group_archive,
                    group_temp,
                    started_at,
                    completed,
                    effective_workers,
                    group_index,
                    len(groups),
                    completed_weight,
                    group_weight,
                    total_weight,
                )
                completed_weight += group_weight
        else:
            print(
                f"Encoding {len(groups)} zoom groups with {group_worker_count} parallel "
                f"Tippecanoe process(es) and up to {threads_per_group} thread(s) per process.",
                flush=True,
            )
            _write_build_progress(
                tileset,
                "building",
                started_at,
                completed,
                [],
                effective_workers,
                engine="tippecanoe",
                phase="encoding",
                phase_percent=0,
                message=f"Encoding {len(groups)} zoom groups with {group_worker_count} parallel processes.",
            )
            futures: dict[Future[None], tuple[int, int]] = {}
            with ThreadPoolExecutor(max_workers=group_worker_count) as executor:
                for (
                    group_index,
                    _minimum_zoom,
                    _maximum_zoom,
                    group_layers,
                    group_archive,
                    group_temp,
                    group_weight,
                ) in group_jobs:
                    future = executor.submit(
                        _run_tippecanoe_group,
                        executable,
                        group_environment,
                        tileset,
                        group_layers,
                        group_archive,
                        group_temp,
                        started_at,
                        completed,
                        effective_workers,
                        group_index,
                        len(groups),
                        0,
                        group_weight,
                        total_weight,
                        False,
                    )
                    futures[future] = (group_index, group_weight)
                completed_groups = 0
                for future in as_completed(futures):
                    group_index, group_weight = futures[future]
                    future.result()
                    completed_groups += 1
                    completed_weight += group_weight
                    _write_build_progress(
                        tileset,
                        "building",
                        started_at,
                        completed,
                        [],
                        effective_workers,
                        engine="tippecanoe",
                        phase="encoding",
                        phase_percent=min(
                            99,
                            round(completed_weight / max(1, total_weight) * 100),
                        ),
                        message=(
                            f"Encoded {completed_groups} of {len(groups)} zoom groups; "
                            f"group {group_index} just completed."
                        ),
                    )
        if len(group_archives) == 1:
            os.replace(group_archives[0], local_archive)
        else:
            _run_tile_join(
                tile_join,
                environment,
                tileset,
                group_archives,
                local_archive,
                started_at,
                completed,
                effective_workers,
            )
        _write_build_progress(
            tileset,
            "finalizing",
            started_at,
            completed,
            [],
            effective_workers,
            engine="tippecanoe",
            phase="validating",
            phase_percent=100,
            message="Validating layer metadata before publication.",
        )
        verified_header, _metadata = _validate_pmtiles_archive(
            local_archive, tileset, "Tippecanoe"
        )
        with local_archive.open("rb") as source, working_archive.open("wb") as destination:
            shutil.copyfileobj(source, destination, length=8 * 1024 * 1024)
            destination.flush()
            os.fsync(destination.fileno())
        if working_archive.stat().st_size != local_archive.stat().st_size:
            raise RuntimeError("The PMTiles publication copy is incomplete.")
        _validate_pmtiles_archive(working_archive, tileset, "Published Tippecanoe copy")
        os.replace(working_archive, tileset.output)
        tile_count = int(verified_header["addressed_tiles_count"])
        bounds = [
            int(verified_header["min_lon_e7"]) / 10_000_000,
            int(verified_header["min_lat_e7"]) / 10_000_000,
            int(verified_header["max_lon_e7"]) / 10_000_000,
            int(verified_header["max_lat_e7"]) / 10_000_000,
        ]
        layer_results = [
            {
                "id": layer.layer_id,
                "database": str(layer.database),
                "table": f"{layer.schema}.{layer.table}",
                "featureCount": by_order[index].feature_count,
                "sourceFeatureCount": by_order[index].source_feature_count,
                "excludedFeatureCount": by_order[index].excluded_feature_count,
                "tilePartCount": None,
                "sourceBounds": _mercator_bounds_to_lon_lat(by_order[index].bounds),
                "stagedBytes": by_order[index].parts_path.stat().st_size if by_order[index].parts_path.is_file() else 0,
                "archive": tileset.output.name,
                "featureIdField": "__portal_feature_id",
                "sourceFeatureIdColumn": layer.feature_id_column,
                "featureIdStrategy": layer.feature_id_strategy,
                "minimumZoom": layer.minimum_zoom,
                "maximumZoom": layer.maximum_zoom,
                "properties": [item.source_name for item in layer.properties],
            }
            for index, layer in enumerate(tileset.layers)
        ]
        manifest = {
            "schemaVersion": 1,
            "tilesetId": tileset.tileset_id,
            "name": tileset.name,
            "engine": "tippecanoe",
            "tippecanoeExecutable": str(executable),
            "tileJoinExecutable": str(tile_join),
            "tippecanoeVersion": version,
            "tippecanoeThreads": tileset.tippecanoe_threads,
            "effectiveTippecanoeThreads": effective_threads,
            "tippecanoeGroupWorkers": group_worker_count,
            "tippecanoeThreadsPerGroup": threads_per_group,
            "zoomGroupCount": len(groups),
            "output": str(tileset.output),
            "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "sizeBytes": tileset.output.stat().st_size,
            "tileCount": tile_count,
            "averageTileBytes": round(tileset.output.stat().st_size / tile_count, 1),
            "minimumZoom": int(verified_header["min_zoom"]),
            "maximumZoom": int(verified_header["max_zoom"]),
            "bounds": bounds,
            "layers": layer_results,
            "durationSeconds": round(time.perf_counter() - started, 3),
            "workerCount": effective_workers,
            "threadsPerWorker": tileset.threads_per_worker,
        }
        _atomic_json(tileset.output.with_suffix(tileset.output.suffix + ".manifest.json"), manifest)
        _write_build_progress(
            tileset,
            "succeeded",
            started_at,
            completed,
            [],
            effective_workers,
            engine="tippecanoe",
            phase="published",
            phase_percent=100,
            message="The validated PMTiles archive was published.",
        )
        print(f"Published {tileset.output} with Tippecanoe ({tile_count:,} tiles).", flush=True)
        return manifest
    except Exception as exc:
        _write_build_progress(
            tileset,
            "failed",
            started_at,
            completed,
            [],
            effective_workers,
            str(exc),
            engine="tippecanoe",
            phase="failed",
            message=str(exc),
        )
        raise
    finally:
        working_archive.unlink(missing_ok=True)
        shutil.rmtree(stage_directory, ignore_errors=True)


def _build_tileset_gdal(tileset: Tileset, worker_count_override: int | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    started_at = datetime.now().astimezone().isoformat(timespec="seconds")
    executable = _resolve_gdal_executable(tileset.gdal_executable)
    environment = _gdal_environment(executable, tileset.gdal_threads)
    _validate_gdal(executable, environment)
    tileset.output.parent.mkdir(parents=True, exist_ok=True)
    tileset.temporary_directory.mkdir(parents=True, exist_ok=True)
    build_id = f"{os.getpid()}-{int(time.time())}"
    stage_directory = tileset.temporary_directory / (
        f"{_safe_file_component(tileset.tileset_id)}-{build_id}-gdal"
    )
    stage_directory.mkdir(parents=True, exist_ok=False)
    working_archive = tileset.output.with_name(f".{tileset.output.name}.{os.getpid()}.building")
    working_archive.unlink(missing_ok=True)
    worker_count = int(worker_count_override or tileset.worker_count)
    if worker_count < 1 or worker_count > 8:
        raise RuntimeError("PMTiles worker count must be between 1 and 8.")
    effective_workers = min(worker_count, len(tileset.layers))
    completed: list[LayerBuildResult] = []
    try:
        print(
            f"Building {tileset.name} with the GDAL engine, {len(tileset.layers)} layer(s), "
            f"{effective_workers} staging worker(s), and GDAL_NUM_THREADS={tileset.gdal_threads}.",
            flush=True,
        )
        print(f"Reading the authoritative source directly: {tileset.layers[0].database}", flush=True)
        completed = _stage_flatgeobuf_layers(
            tileset,
            stage_directory,
            started_at,
            worker_count,
            "gdal",
        )
        completed.sort(key=lambda item: item.layer_order)
        _validate_layer_publication_bounds(tileset, completed)
        source_vrt = stage_directory / "layers.vrt"
        layer_configuration = stage_directory / "layers.json"
        _write_gdal_vrt(source_vrt, tileset, completed)
        _write_gdal_layer_configuration(layer_configuration, tileset)
        _run_gdal_pmtiles(
            executable,
            environment,
            tileset,
            source_vrt,
            layer_configuration,
            working_archive,
            started_at,
            completed,
            effective_workers,
        )
        _write_build_progress(
            tileset,
            "finalizing",
            started_at,
            completed,
            [],
            effective_workers,
            engine="gdal",
            phase="validating",
            phase_percent=100,
            message="Validating layer metadata before publication.",
        )
        verified_header, _metadata = _validate_pmtiles_archive(
            working_archive, tileset, "GDAL"
        )
        tile_count = int(verified_header["addressed_tiles_count"])
        os.replace(working_archive, tileset.output)
        bounds = [
            int(verified_header["min_lon_e7"]) / 10_000_000,
            int(verified_header["min_lat_e7"]) / 10_000_000,
            int(verified_header["max_lon_e7"]) / 10_000_000,
            int(verified_header["max_lat_e7"]) / 10_000_000,
        ]
        layer_results = [
            {
                "id": layer.layer_id,
                "database": str(layer.database),
                "table": f"{layer.schema}.{layer.table}",
                "featureCount": completed[index].feature_count,
                "sourceFeatureCount": completed[index].source_feature_count,
                "excludedFeatureCount": completed[index].excluded_feature_count,
                "tilePartCount": None,
                "sourceBounds": _mercator_bounds_to_lon_lat(completed[index].bounds),
                "stagedBytes": completed[index].parts_path.stat().st_size if completed[index].parts_path.is_file() else 0,
                "archive": tileset.output.name,
                "featureIdField": "__portal_feature_id",
                "sourceFeatureIdColumn": layer.feature_id_column,
                "featureIdStrategy": layer.feature_id_strategy,
                "minimumZoom": layer.minimum_zoom,
                "maximumZoom": layer.maximum_zoom,
                "properties": [item.source_name for item in layer.properties],
            }
            for index, layer in enumerate(tileset.layers)
        ]
        manifest = {
            "schemaVersion": 1,
            "tilesetId": tileset.tileset_id,
            "name": tileset.name,
            "engine": "gdal",
            "gdalExecutable": str(executable),
            "gdalThreads": tileset.gdal_threads,
            "output": str(tileset.output),
            "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "sizeBytes": tileset.output.stat().st_size,
            "tileCount": tile_count,
            "averageTileBytes": round(tileset.output.stat().st_size / tile_count, 1),
            "minimumZoom": int(verified_header["min_zoom"]),
            "maximumZoom": int(verified_header["max_zoom"]),
            "bounds": bounds,
            "layers": layer_results,
            "durationSeconds": round(time.perf_counter() - started, 3),
            "workerCount": effective_workers,
            "threadsPerWorker": tileset.threads_per_worker,
        }
        _atomic_json(tileset.output.with_suffix(tileset.output.suffix + ".manifest.json"), manifest)
        _write_build_progress(
            tileset,
            "succeeded",
            started_at,
            completed,
            [],
            effective_workers,
            engine="gdal",
            phase="published",
            phase_percent=100,
            message="The validated PMTiles archive was published.",
        )
        print(f"Published {tileset.output} with GDAL ({tile_count:,} tiles).", flush=True)
        return manifest
    except Exception as exc:
        _write_build_progress(
            tileset,
            "failed",
            started_at,
            completed,
            [],
            effective_workers,
            str(exc),
            engine="gdal",
            phase="failed",
            message=str(exc),
        )
        raise
    finally:
        working_archive.unlink(missing_ok=True)
        shutil.rmtree(stage_directory, ignore_errors=True)


def build_tileset(
    tileset: Tileset,
    worker_count_override: int | None = None,
    engine_override: str | None = None,
) -> dict[str, Any]:
    engine = str(engine_override or tileset.engine).strip().lower()
    builders = {
        "tippecanoe": _build_tileset_tippecanoe,
        "gdal": _build_tileset_gdal,
        "python": _build_tileset_python,
    }
    if engine not in builders:
        raise RuntimeError(f"Unsupported PMTiles engine: {engine}")
    if engine_override:
        return builders[engine](tileset, worker_count_override)
    try:
        return builders[engine](tileset, worker_count_override)
    except (TippecanoeUnavailableError, GdalUnavailableError) as exc:
        expected_error = (
            TippecanoeUnavailableError if engine == "tippecanoe" else GdalUnavailableError
        )
        if not isinstance(exc, expected_error) or not tileset.fallback_engine:
            raise
        fallback = tileset.fallback_engine
        print(
            f"WARNING: {exc} Falling back to the {fallback.title()} PMTiles engine.",
            flush=True,
        )
        try:
            return builders[fallback](tileset, worker_count_override)
        except GdalUnavailableError as fallback_exc:
            if engine != "tippecanoe" or fallback != "gdal":
                raise
            print(
                f"WARNING: {fallback_exc} Falling back to the Python PMTiles engine.",
                flush=True,
            )
            return _build_tileset_python(tileset, worker_count_override)


def status_payload(config_path: Path, selected: set[str] | None = None) -> dict[str, Any]:
    _config, tilesets = load_tilesets(config_path, selected)
    values = []
    for tileset in tilesets:
        tippecanoe_available = False
        tippecanoe_path = ""
        tile_join_path = ""
        tippecanoe_version = ""
        tippecanoe_error = ""
        if tileset.engine == "tippecanoe" or tileset.fallback_engine == "tippecanoe":
            try:
                executable, tile_join = _resolve_tippecanoe_executables(
                    tileset.tippecanoe_executable
                )
                environment, _effective_threads = _tippecanoe_environment(
                    executable, tileset.tippecanoe_threads
                )
                tippecanoe_version = _validate_tippecanoe(
                    executable, tile_join, environment
                )
                tippecanoe_available = True
                tippecanoe_path = str(executable)
                tile_join_path = str(tile_join)
            except TippecanoeUnavailableError as exc:
                tippecanoe_error = str(exc)
                if tileset.engine == "tippecanoe" and not tileset.fallback_engine:
                    raise
        gdal_available = False
        gdal_path = ""
        gdal_error = ""
        if tileset.engine == "gdal" or tileset.fallback_engine == "gdal":
            try:
                executable = _resolve_gdal_executable(tileset.gdal_executable)
                _validate_gdal(executable, _gdal_environment(executable, tileset.gdal_threads))
                gdal_available = True
                gdal_path = str(executable)
            except GdalUnavailableError as exc:
                gdal_error = str(exc)
                if tileset.engine == "gdal" and tileset.fallback_engine != "python":
                    raise
        manifest_path = tileset.output.with_suffix(tileset.output.suffix + ".manifest.json")
        manifest: dict[str, Any] | None = None
        if manifest_path.is_file():
            try:
                manifest = _read_json(manifest_path)
            except RuntimeError:
                manifest = None
        values.append(
            {
                "id": tileset.tileset_id,
                "name": tileset.name,
                "output": str(tileset.output),
                "available": tileset.output.is_file(),
                "sizeBytes": tileset.output.stat().st_size if tileset.output.is_file() else 0,
                "layerCount": len(tileset.layers),
                "engine": tileset.engine,
                "fallbackEngine": tileset.fallback_engine,
                "tippecanoeAvailable": tippecanoe_available,
                "tippecanoeExecutable": tippecanoe_path,
                "tileJoinExecutable": tile_join_path,
                "tippecanoeVersion": tippecanoe_version,
                "tippecanoeError": tippecanoe_error,
                "tippecanoeThreads": tileset.tippecanoe_threads,
                "tippecanoeGroupWorkers": tileset.tippecanoe_group_workers,
                "gdalAvailable": gdal_available,
                "gdalExecutable": gdal_path,
                "gdalError": gdal_error,
                "gdalThreads": tileset.gdal_threads,
                "workerCount": tileset.worker_count,
                "threadsPerWorker": tileset.threads_per_worker,
                "progressFile": str(tileset.progress_file),
                "layers": [
                    {
                        "id": layer.layer_id,
                        "database": str(layer.database),
                        "table": f"{layer.schema}.{layer.table}",
                        "estimatedFeatures": layer.estimated_features,
                        "minimumZoom": layer.minimum_zoom,
                        "maximumZoom": layer.maximum_zoom,
                        "propertyCount": len(layer.properties),
                    }
                    for layer in tileset.layers
                ],
                "lastBuild": manifest,
            }
        )
    return {
        "available": True,
        "configFile": str(config_path.resolve()),
        "tilesetCount": len(values),
        "layerCount": sum(int(item["layerCount"]) for item in values),
        "tilesets": values,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build PMTiles from Portal-registered DuckDB layers.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="Path to pmtiles.settings.json.")
    parser.add_argument("--tileset", action="append", help="Only validate or build this tileset ID.")
    parser.add_argument("--workers", type=int, help="Override the configured parallel layer-worker count (1-8).")
    parser.add_argument(
        "--engine",
        choices=("tippecanoe", "gdal", "python"),
        help="Override the configured PMTiles conversion engine.",
    )
    parser.add_argument("--check", action="store_true", help="Validate configuration and source tables without building.")
    parser.add_argument("--json", action="store_true", help="Print the status or build result as JSON.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config_path = Path(args.config).resolve()
    selected = {str(value).lower() for value in args.tileset or []} or None
    try:
        if args.check:
            result = status_payload(config_path, selected)
        else:
            _config, tilesets = load_tilesets(config_path, selected)
            result = {
                "available": True,
                "configFile": str(config_path),
                "builds": [build_tileset(tileset, args.workers, args.engine) for tileset in tilesets],
            }
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        elif args.check:
            print(
                f"Validated {result['tilesetCount']} tileset(s) and {result['layerCount']} spatial layer(s)."
            )
        return 0
    except Exception as exc:
        if args.json:
            print(json.dumps({"available": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
