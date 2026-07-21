from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

import pyodbc

from portal.runtime.transport import HTTPException

from portal.app.core.paths import PORTAL_PACKAGE_ROOT
from portal.app.core.sqlite_snapshot import readonly_sqlite_snapshot, resolve_sqlite_snapshot


DEFAULT_DATA_SOURCES_CONFIG = PORTAL_PACKAGE_ROOT / "app" / "config" / "data_sources.json"


def portal_env(name: str) -> str | None:
    return os.getenv(name)


def selected_sql_server_driver() -> str:
    configured_driver = str(portal_env("PORTAL_SQL_DRIVER") or "").strip()
    if configured_driver:
        return configured_driver

    installed = set(pyodbc.drivers())
    for candidate in (
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server",
    ):
        if candidate in installed:
            return candidate
    raise HTTPException(
        status_code=503,
        detail="No SQL Server ODBC driver is installed or configured in portal.settings.json.",
    )


@dataclass(frozen=True)
class CriticalTeamDataSource:
    source_type: str
    workbook: str
    manifest: Path
    workorder_table: str
    wocustfield_table: str
    inspection_table: str
    workorder_entity_table: str
    activity_link_table: str
    description_filter: str

    @property
    def source_tables(self) -> str:
        return ", ".join(
            (
                self.workorder_table,
                self.wocustfield_table,
                self.inspection_table,
                self.workorder_entity_table,
                self.activity_link_table,
            )
        )

    @property
    def database(self) -> Path:
        return resolve_sqlite_snapshot(self.manifest)


@dataclass(frozen=True)
class CriticalAssetsDataSource:
    source_type: str
    workbook: str
    database: Path
    tables: dict[str, str]

    @property
    def source_tables(self) -> str:
        return ", ".join(self.tables.values())


@dataclass(frozen=True)
class GISLayerDataSource:
    id: str
    label: str
    table: str
    geometry_column: str
    color: str
    property_columns: tuple[str, ...]
    source_type: str | None = None
    database: str | None = None
    server: str | None = None
    schema: str | None = None
    source_crs: str | None = None
    target_crs: str | None = None
    trusted_connection: bool | None = None
    encrypt: bool | None = None
    trust_server_certificate: bool | None = None
    timeout_seconds: int | None = None


@dataclass(frozen=True)
class GISDataSource:
    source_type: str
    database: Path
    source_crs: str
    target_crs: str
    layers: dict[str, GISLayerDataSource]

    @property
    def source_tables(self) -> str:
        return ", ".join(layer.table for layer in self.layers.values())


def data_sources_config_path() -> Path:
    return DEFAULT_DATA_SOURCES_CONFIG


@lru_cache(maxsize=1)
def load_data_sources_config() -> dict[str, Any]:
    path = data_sources_config_path()
    if not path.exists():
        raise HTTPException(status_code=503, detail={"message": "Portal data source config file was not found.", "path": str(path)})
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=503, detail={"message": "Portal data source config file is not valid JSON.", "path": str(path), "error": str(error)}) from error


def required_configured_path(environment_name: str, label: str) -> Path:
    value = str(portal_env(environment_name) or "").strip()
    if not value:
        raise HTTPException(status_code=503, detail={"message": f"{label} is not configured in portal.settings.json."})
    return Path(value)


@contextmanager
def portal_sources_connection() -> Iterator[sqlite3.Connection]:
    """Yield the currently published portal source snapshot as a read-only handle."""
    manifest = required_configured_path(
        "PORTAL_SOURCES_MANIFEST",
        "Portal sources SQLite manifest",
    )
    with readonly_sqlite_snapshot(manifest) as connection:
        yield connection


def critical_team_data_source() -> CriticalTeamDataSource:
    config = load_data_sources_config().get("critical_team")
    if not isinstance(config, dict):
        raise HTTPException(status_code=503, detail={"message": "Missing `critical_team` datasource config."})
    tables = config.get("tables") if isinstance(config.get("tables"), dict) else {}
    return CriticalTeamDataSource(
        source_type=str(config.get("source_type", "sqlite_snapshot")),
        workbook=str(config.get("workbook", "")),
        manifest=required_configured_path("PORTAL_SOURCES_MANIFEST", "Portal sources SQLite manifest"),
        workorder_table=str(tables.get("workorder", "azteca_WORKORDER")),
        wocustfield_table=str(tables.get("wocustfield", "azteca_WOCUSTFIELD")),
        inspection_table=str(tables.get("inspection", "azteca_INSPECTION")),
        workorder_entity_table=str(tables.get("workorder_entity", "azteca_WORKORDERENTITY")),
        activity_link_table=str(tables.get("activity_link", "azteca_ACTIVITYLINK")),
        description_filter=str(config.get("description_filter", "")),
    )


def critical_assets_data_source() -> CriticalAssetsDataSource:
    config = load_data_sources_config().get("critical_assets")
    if not isinstance(config, dict):
        raise HTTPException(status_code=503, detail={"message": "Missing `critical_assets` datasource config."})
    tables = config.get("tables") if isinstance(config.get("tables"), dict) else {}
    return CriticalAssetsDataSource(
        source_type=str(config.get("source_type", "duckdb")),
        workbook=str(config.get("workbook", "")),
        database=required_configured_path("PORTAL_AMTEAM_DUCKDB", "Asset risk DuckDB database"),
        tables={"both": str(tables.get("both", "")), "pipes": str(tables.get("pipes", "")), "structures": str(tables.get("structures", ""))},
    )


def gis_data_source() -> GISDataSource:
    config = load_data_sources_config().get("gis")
    if not isinstance(config, dict):
        raise HTTPException(status_code=503, detail={"message": "Missing `gis` datasource config."})
    layers_config = config.get("layers") if isinstance(config.get("layers"), dict) else {}
    layers: dict[str, GISLayerDataSource] = {}
    for layer_id, layer_config in layers_config.items():
        if not isinstance(layer_config, dict):
            continue
        is_facility = str(layer_id) == "facility_polygons"
        property_columns = layer_config.get("property_columns")
        layers[str(layer_id)] = GISLayerDataSource(
            id=str(layer_id),
            label=str(layer_config.get("label", layer_id)),
            table=str(layer_config.get("table", "")),
            geometry_column=str(layer_config.get("geometry_column", "geometry")),
            color=str(layer_config.get("color", "#4e79a7")),
            property_columns=tuple(str(column) for column in property_columns) if isinstance(property_columns, list) else (),
            source_type=str(layer_config["source_type"]) if layer_config.get("source_type") else None,
            database=(portal_env("PORTAL_GIS_FACILITY_DUCKDB") if is_facility else None),
            server=None,
            schema=str(layer_config["schema"]) if layer_config.get("schema") else None,
            source_crs=str(layer_config["source_crs"]) if layer_config.get("source_crs") else None,
            target_crs=str(layer_config["target_crs"]) if layer_config.get("target_crs") else None,
            trusted_connection=bool(layer_config["trusted_connection"]) if "trusted_connection" in layer_config else None,
            encrypt=bool(layer_config["encrypt"]) if "encrypt" in layer_config else None,
            trust_server_certificate=bool(layer_config["trust_server_certificate"]) if "trust_server_certificate" in layer_config else None,
            timeout_seconds=int(layer_config["timeout_seconds"]) if layer_config.get("timeout_seconds") else None,
        )
    return GISDataSource(
        source_type=str(config.get("source_type", "duckdb_spatial")),
        database=required_configured_path("PORTAL_AMTEAM_DUCKDB", "GIS DuckDB database"),
        source_crs=str(config.get("source_crs", "EPSG:4326")),
        target_crs=str(config.get("target_crs", "EPSG:4326")),
        layers=layers,
    )
