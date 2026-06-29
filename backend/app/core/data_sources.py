from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import pyodbc
from fastapi import HTTPException

from backend.app.core.paths import PROJECT_ROOT


DEFAULT_DATA_SOURCES_CONFIG = PROJECT_ROOT / "backend" / "app" / "config" / "data_sources.json"


def portal_env(name: str) -> str | None:
    legacy_name = f"ARF_{name.removeprefix('PORTAL_')}"
    return os.getenv(name) or os.getenv(legacy_name)


@dataclass(frozen=True)
class CriticalTeamDataSource:
    source_type: str
    workbook: str
    server: str
    database: str
    schema: str
    workorder_table: str
    wocustfield_table: str
    description_filter: str
    trusted_connection: bool
    encrypt: bool
    trust_server_certificate: bool
    timeout_seconds: int

    @property
    def source_tables(self) -> str:
        return f"{self.schema}.{self.workorder_table} + {self.schema}.{self.wocustfield_table}"


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
    configured_path = portal_env("PORTAL_DATA_SOURCES_CONFIG")
    return Path(configured_path) if configured_path else DEFAULT_DATA_SOURCES_CONFIG


@lru_cache(maxsize=1)
def load_data_sources_config() -> dict[str, Any]:
    path = data_sources_config_path()
    if not path.exists():
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Portal data source config file was not found.",
                "path": str(path),
            },
        )

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Portal data source config file is not valid JSON.",
                "path": str(path),
                "error": str(error),
            },
        ) from error


def critical_team_data_source() -> CriticalTeamDataSource:
    config = load_data_sources_config().get("critical_team")
    if not isinstance(config, dict):
        raise HTTPException(
            status_code=503,
            detail={"message": "Missing `critical_team` datasource config."},
        )

    tables = config.get("tables") if isinstance(config.get("tables"), dict) else {}
    return CriticalTeamDataSource(
        source_type=str(config.get("source_type", "sqlserver")),
        workbook=str(config.get("workbook", "")),
        server=str(config.get("server", "")),
        database=str(config.get("database", "")),
        schema=str(config.get("schema", "")),
        workorder_table=str(tables.get("workorder", "")),
        wocustfield_table=str(tables.get("wocustfield", "")),
        description_filter=str(config.get("description_filter", "")),
        trusted_connection=bool(config.get("trusted_connection", True)),
        encrypt=bool(config.get("encrypt", True)),
        trust_server_certificate=bool(config.get("trust_server_certificate", True)),
        timeout_seconds=int(config.get("timeout_seconds", 30)),
    )


def critical_assets_data_source() -> CriticalAssetsDataSource:
    config = load_data_sources_config().get("critical_assets")
    if not isinstance(config, dict):
        raise HTTPException(
            status_code=503,
            detail={"message": "Missing `critical_assets` datasource config."},
        )

    tables = config.get("tables") if isinstance(config.get("tables"), dict) else {}
    return CriticalAssetsDataSource(
        source_type=str(config.get("source_type", "duckdb")),
        workbook=str(config.get("workbook", "")),
        database=Path(str(config.get("database", ""))),
        tables={
            "both": str(tables.get("both", "")),
            "pipes": str(tables.get("pipes", "")),
            "structures": str(tables.get("structures", "")),
        },
    )


def gis_data_source() -> GISDataSource:
    config = load_data_sources_config().get("gis")
    if not isinstance(config, dict):
        raise HTTPException(
            status_code=503,
            detail={"message": "Missing `gis` datasource config."},
        )

    layers_config = config.get("layers") if isinstance(config.get("layers"), dict) else {}
    layers: dict[str, GISLayerDataSource] = {}
    for layer_id, layer_config in layers_config.items():
        if not isinstance(layer_config, dict):
            continue
        property_columns = layer_config.get("property_columns")
        layers[str(layer_id)] = GISLayerDataSource(
            id=str(layer_id),
            label=str(layer_config.get("label", layer_id)),
            table=str(layer_config.get("table", "")),
            geometry_column=str(layer_config.get("geometry_column", "geometry")),
            color=str(layer_config.get("color", "#4e79a7")),
            property_columns=tuple(str(column) for column in property_columns) if isinstance(property_columns, list) else (),
            source_type=str(layer_config["source_type"]) if layer_config.get("source_type") else None,
            database=str(layer_config["database"]) if layer_config.get("database") else None,
            server=str(layer_config["server"]) if layer_config.get("server") else None,
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
        database=Path(str(config.get("database", ""))),
        source_crs=str(config.get("source_crs", "EPSG:4326")),
        target_crs=str(config.get("target_crs", "EPSG:4326")),
        layers=layers,
    )


def selected_sql_server_driver() -> str:
    configured_driver = portal_env("PORTAL_SQL_DRIVER")
    if configured_driver:
        return configured_driver

    drivers = list(pyodbc.drivers())
    for preferred in ("ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server", "SQL Server"):
        if preferred in drivers:
            return preferred

    return "ODBC Driver 18 for SQL Server"


def critical_team_connection_string(source: CriticalTeamDataSource | None = None) -> str:
    configured = portal_env("PORTAL_CRITICAL_TEAM_CONNECTION_STRING")
    if configured:
        return configured

    source = source or critical_team_data_source()
    trusted_connection = "yes" if source.trusted_connection else "no"
    encrypt = "yes" if source.encrypt else "no"
    trust_server_certificate = "yes" if source.trust_server_certificate else "no"

    return (
        f"Driver={{{selected_sql_server_driver()}}};"
        f"Server={source.server};"
        f"Database={source.database};"
        f"Trusted_Connection={trusted_connection};"
        f"Encrypt={encrypt};"
        f"TrustServerCertificate={trust_server_certificate};"
    )
