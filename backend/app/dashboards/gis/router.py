from __future__ import annotations

import datetime as dt
import decimal
import re
from functools import lru_cache
from typing import Any

import duckdb
import pyodbc
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pyproj import Transformer
from shapely import wkb
from shapely.geometry import box, mapping
from shapely.ops import transform as transform_geometry

from backend.app.core.data_sources import (
    CriticalAssetsDataSource,
    GISDataSource,
    GISLayerDataSource,
    critical_assets_data_source,
    gis_data_source,
    selected_sql_server_driver,
)


router = APIRouter(prefix="/api/gis", tags=["GIS"])

IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
LATEST_INSPECTION_LAYER_IDS = {"critical_asset_pipes", "critical_asset_structures"}
LATEST_INSPECTION_SOURCE_KEYS = {"both", "pipes", "structures"}
FACILITY_AGGREGATE_RISK_TYPES = (
    {
        "source": "pipes",
        "metric": "RISK",
        "label": "Total Risk - Pipes Only",
        "field_prefix": "TOTAL_RISK_PIPES",
    },
    {
        "source": "pipes",
        "metric": "COND_RISK",
        "label": "Condition Risk - Pipes Only",
        "field_prefix": "CONDITION_RISK_PIPES",
    },
    {
        "source": "pipes",
        "metric": "FLOOD_RISK",
        "label": "Flood Risk - Pipes Only",
        "field_prefix": "FLOOD_RISK_PIPES",
    },
    {
        "source": "pipes",
        "metric": "CLOG_RISK",
        "label": "Clog Risk - Pipes Only",
        "field_prefix": "CLOG_RISK_PIPES",
    },
    {
        "source": "structures",
        "metric": "COND_RISK",
        "label": "Condition Risk - Structures Only",
        "field_prefix": "CONDITION_RISK_STRUCTURES",
    },
    {
        "source": "both",
        "metric": "COND_RISK",
        "label": "Condition Risk - Pipes and Structures",
        "field_prefix": "CONDITION_RISK_BOTH",
    },
)
FACILITY_AGGREGATE_MEASURES = (
    {"key": "avg", "label": "Avg", "sql_function": "avg"},
    {"key": "max", "label": "Max", "sql_function": "max"},
    {"key": "total", "label": "Total", "sql_function": "sum"},
    {"key": "median", "label": "Median", "sql_function": "median"},
)


def facility_aggregate_renderers() -> tuple[dict[str, str], ...]:
    return tuple(
        {
            "field": f"{risk_type['field_prefix']}_{measure['key'].upper()}",
            "label": str(risk_type["label"]),
            "source": str(risk_type["source"]),
            "metric": str(risk_type["metric"]),
            "measure": str(measure["label"]),
            "measure_key": str(measure["key"]),
            "sql_function": str(measure["sql_function"]),
        }
        for risk_type in FACILITY_AGGREGATE_RISK_TYPES
        for measure in FACILITY_AGGREGATE_MEASURES
    )


FACILITY_AGGREGATE_RENDERERS = facility_aggregate_renderers()
FACILITY_AGGREGATE_RENDERER_FIELDS = tuple(str(renderer["field"]) for renderer in FACILITY_AGGREGATE_RENDERERS)


def quote_identifier(value: str) -> str:
    if not IDENTIFIER_PATTERN.fullmatch(value):
        raise HTTPException(
            status_code=503,
            detail={"message": "GIS datasource contains an invalid SQL identifier.", "identifier": value},
        )
    return f'"{value}"'


def quote_sqlserver_identifier(value: str) -> str:
    if not IDENTIFIER_PATTERN.fullmatch(value):
        raise HTTPException(
            status_code=503,
            detail={"message": "GIS datasource contains an invalid SQL Server identifier.", "identifier": value},
        )
    return f"[{value}]"


def normalize_facility_id(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, decimal.Decimal):
        numeric_value = float(value)
        return str(int(numeric_value)) if numeric_value.is_integer() else str(value).strip()
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else str(value).strip()
    return str(value).strip()


def serializable_value(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    return value


def critical_asset_table_name(source: CriticalAssetsDataSource, source_key: str) -> str:
    table_name = source.tables.get(source_key)
    if not table_name:
        raise HTTPException(status_code=503, detail={"message": "Missing critical asset GIS renderer table.", "source": source_key})
    return table_name


def critical_asset_latest_records_expression(source_key: str, table_name: str, columns: set[str]) -> str:
    table_reference = quote_identifier(table_name)
    if source_key not in LATEST_INSPECTION_SOURCE_KEYS or not {"ITPIPE_ASSETID", "Inspection_Date"}.issubset(columns):
        return table_reference

    order_terms = [f"try_cast({quote_identifier('Inspection_Date')} AS timestamp) DESC NULLS LAST"]
    if "INSPECTIONID" in columns:
        order_terms.append(f"try_cast({quote_identifier('INSPECTIONID')} AS bigint) DESC NULLS LAST")

    return f"""
        (
            SELECT *
            FROM (
                SELECT
                    *,
                    row_number() OVER (
                        PARTITION BY {quote_identifier('ITPIPE_ASSETID')}
                        ORDER BY {', '.join(order_terms)}
                    ) AS latest_inspection_rank
                FROM {table_reference}
            ) latest_ranked
            WHERE latest_inspection_rank = 1
        ) latest_records
    """


@lru_cache(maxsize=1)
def facility_aggregate_renderer_values() -> dict[str, dict[str, float]]:
    source = critical_assets_data_source()
    if not source.database.exists():
        return {}

    values: dict[str, dict[str, float]] = {}
    try:
        connection = duckdb.connect(str(source.database), read_only=True)
    except duckdb.Error:
        return values

    try:
        for renderer in FACILITY_AGGREGATE_RENDERERS:
            source_key = str(renderer["source"])
            table_name = critical_asset_table_name(source, source_key)
            columns = {str(row[0]) for row in connection.execute(f"DESCRIBE {quote_identifier(table_name)}").fetchall()}
            metric = str(renderer["metric"])
            if "FacilityID" not in columns or metric not in columns:
                continue
            from_expression = critical_asset_latest_records_expression(source_key, table_name, columns)
            sql_function = str(renderer["sql_function"])
            rows = connection.execute(
                f"""
                SELECT
                  {quote_identifier('FacilityID')} as facility_id,
                  {sql_function}(try_cast({quote_identifier(metric)} as double)) as renderer_value
                FROM {from_expression}
                WHERE try_cast({quote_identifier(metric)} as double) IS NOT NULL
                GROUP BY {quote_identifier('FacilityID')}
                """
            ).fetchall()
            for facility_id, renderer_value in rows:
                if renderer_value is None:
                    continue
                normalized_id = normalize_facility_id(facility_id)
                if not normalized_id:
                    continue
                values.setdefault(normalized_id, {})[str(renderer["field"])] = float(renderer_value)
    finally:
        connection.close()
    return values


def layer_renderer_metadata(layer: GISLayerDataSource) -> list[dict[str, str]]:
    if layer.id != "facility_polygons":
        return []
    return [
        {
            "field": str(renderer["field"]),
            "label": str(renderer["label"]),
            "source": str(renderer["source"]),
            "metric": str(renderer["metric"]),
            "measure": str(renderer["measure"]),
        }
        for renderer in FACILITY_AGGREGATE_RENDERERS
    ]


def layer_source_type(source: GISDataSource, layer: GISLayerDataSource) -> str:
    return (layer.source_type or source.source_type).lower()


def layer_duckdb_path(source: GISDataSource, layer: GISLayerDataSource) -> Path:
    return Path(layer.database) if layer.database else source.database


def layer_source_crs(source: GISDataSource, layer: GISLayerDataSource) -> str:
    return layer.source_crs or source.source_crs


def layer_target_crs(source: GISDataSource, layer: GISLayerDataSource) -> str:
    return layer.target_crs or source.target_crs


def sqlserver_connection_string(layer: GISLayerDataSource) -> str:
    if not layer.server or not layer.database:
        raise HTTPException(
            status_code=503,
            detail={"message": "SQL Server GIS layer must include server and database.", "layer": layer.id},
        )
    trusted_connection = "yes" if layer.trusted_connection is not False else "no"
    encrypt = "yes" if layer.encrypt is not False else "no"
    trust_server_certificate = "yes" if layer.trust_server_certificate is not False else "no"
    return (
        f"Driver={{{selected_sql_server_driver()}}};"
        f"Server={layer.server};"
        f"Database={layer.database};"
        f"Trusted_Connection={trusted_connection};"
        f"Encrypt={encrypt};"
        f"TrustServerCertificate={trust_server_certificate};"
    )


def connect_gis_database(source: GISDataSource, layer: GISLayerDataSource) -> Any:
    source_type = layer_source_type(source, layer)
    if source_type in {"duckdb", "duckdb_spatial"}:
        database = layer_duckdb_path(source, layer)
        if not database.exists():
            raise HTTPException(
                status_code=503,
                detail={"message": "GIS DuckDB datasource was not found.", "path": str(database), "layer": layer.id},
            )

        try:
            return duckdb.connect(str(database), read_only=True)
        except duckdb.Error as error:
            raise HTTPException(
                status_code=503,
                detail={"message": "Could not open GIS DuckDB datasource.", "layer": layer.id, "error": str(error)},
            ) from error

    if source_type == "sqlserver":
        try:
            return pyodbc.connect(sqlserver_connection_string(layer), timeout=layer.timeout_seconds or 30)
        except pyodbc.Error as error:
            raise HTTPException(
                status_code=503,
                detail={"message": "Could not open GIS SQL Server datasource.", "layer": layer.id, "error": str(error)},
            ) from error

    raise HTTPException(
        status_code=503,
        detail={"message": "Unsupported GIS layer datasource type.", "layer": layer.id, "source_type": source_type},
    )


def layer_table_reference(source: GISDataSource, layer: GISLayerDataSource) -> str:
    if layer_source_type(source, layer) == "sqlserver":
        schema = layer.schema or "dbo"
        return f"{quote_sqlserver_identifier(schema)}.{quote_sqlserver_identifier(layer.table)}"
    return quote_identifier(layer.table)


def layer_geometry_expression(source: GISDataSource, layer: GISLayerDataSource) -> str:
    if layer_source_type(source, layer) == "sqlserver":
        return f"{quote_sqlserver_identifier(layer.geometry_column)}.STAsBinary()"
    return quote_identifier(layer.geometry_column)


def layer_geometry_not_null_expression(source: GISDataSource, layer: GISLayerDataSource) -> str:
    geometry_column = quote_sqlserver_identifier(layer.geometry_column) if layer_source_type(source, layer) == "sqlserver" else quote_identifier(layer.geometry_column)
    return f"{geometry_column} IS NOT NULL"


def uses_latest_inspection_records(source: GISDataSource, layer: GISLayerDataSource) -> bool:
    if layer.id not in LATEST_INSPECTION_LAYER_IDS or layer_source_type(source, layer) == "sqlserver":
        return False
    configured_columns = set(layer.property_columns)
    return {"ITPIPE_ASSETID", "Inspection_Date"}.issubset(configured_columns)


def layer_from_expression(source: GISDataSource, layer: GISLayerDataSource) -> str:
    table_name = layer_table_reference(source, layer)
    if not uses_latest_inspection_records(source, layer):
        return table_name

    geometry_filter = layer_geometry_not_null_expression(source, layer)
    asset_column = quote_identifier("ITPIPE_ASSETID")
    inspection_date_column = quote_identifier("Inspection_Date")
    inspection_id_column = quote_identifier("INSPECTIONID")
    return f"""
        (
            SELECT *
            FROM (
                SELECT
                    *,
                    row_number() OVER (
                        PARTITION BY {asset_column}
                        ORDER BY
                            try_cast({inspection_date_column} AS timestamp) DESC NULLS LAST,
                            try_cast({inspection_id_column} AS bigint) DESC NULLS LAST
                    ) AS latest_inspection_rank
                FROM {table_name}
                WHERE {geometry_filter}
            ) latest_ranked
            WHERE latest_inspection_rank = 1
        ) latest_records
    """


def close_connection(connection: Any) -> None:
    try:
        connection.close()
    except Exception:
        pass


def layer_or_404(source: GISDataSource, layer_id: str) -> GISLayerDataSource:
    layer = source.layers.get(layer_id)
    if layer is None:
        raise HTTPException(status_code=404, detail={"message": "GIS layer was not found.", "layer_id": layer_id})
    return layer


def table_columns(connection: Any, source: GISDataSource, layer: GISLayerDataSource) -> set[str]:
    try:
        if layer_source_type(source, layer) == "sqlserver":
            rows = connection.execute(
                """
                SELECT COLUMN_NAME
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
                """,
                layer.schema or "dbo",
                layer.table,
            ).fetchall()
            return {str(row[0]) for row in rows}

        table_name = quote_identifier(layer.table)
        return {str(row[0]) for row in connection.execute(f"DESCRIBE {table_name}").fetchall()}
    except (duckdb.Error, pyodbc.Error) as error:
        raise HTTPException(
            status_code=503,
            detail={"message": "Could not inspect GIS layer table.", "layer": layer.id, "error": str(error)},
        ) from error


def layer_property_columns(connection: Any, source: GISDataSource, layer: GISLayerDataSource) -> list[str]:
    available = table_columns(connection, source, layer)
    return [column for column in layer.property_columns if column in available and column != layer.geometry_column]


def layer_metadata_property_columns(connection: Any, source: GISDataSource, layer: GISLayerDataSource) -> list[str]:
    property_columns = layer_property_columns(connection, source, layer)
    if layer.id == "facility_polygons":
        property_columns.extend(FACILITY_AGGREGATE_RENDERER_FIELDS)
    return property_columns


@lru_cache(maxsize=16)
def coordinate_transformer(source_crs: str, target_crs: str):
    return Transformer.from_crs(source_crs, target_crs, always_xy=True).transform


def geometry_from_wkb(value: Any):
    if value is None:
        return None
    return wkb.loads(bytes(value))


def transformed_geometry(value: Any, source_crs: str, target_crs: str):
    geometry = geometry_from_wkb(value)
    if geometry is None:
        return None
    if source_crs == target_crs:
        return geometry
    return transform_geometry(coordinate_transformer(source_crs, target_crs), geometry)


def layer_bounds(
    connection: Any,
    source: GISDataSource,
    layer: GISLayerDataSource,
) -> list[float] | None:
    from_expression = layer_from_expression(source, layer)
    geometry_expression = layer_geometry_expression(source, layer)
    geometry_filter = layer_geometry_not_null_expression(source, layer)
    rows = connection.execute(f"SELECT {geometry_expression} FROM {from_expression} WHERE {geometry_filter}").fetchall()
    bounds: list[float] | None = None
    source_crs = layer_source_crs(source, layer)
    target_crs = layer_target_crs(source, layer)
    for row in rows:
        geometry = transformed_geometry(row[0], source_crs, target_crs)
        if geometry is None or geometry.is_empty:
            continue
        min_x, min_y, max_x, max_y = geometry.bounds
        bounds = [min_x, min_y, max_x, max_y] if bounds is None else [
            min(bounds[0], min_x),
            min(bounds[1], min_y),
            max(bounds[2], max_x),
            max(bounds[3], max_y),
        ]
    if bounds is None:
        return None
    return [float(value) for value in bounds]


def layer_geometry_type(connection: Any, source: GISDataSource, layer: GISLayerDataSource) -> str | None:
    from_expression = layer_from_expression(source, layer)
    geometry_expression = layer_geometry_expression(source, layer)
    geometry_filter = layer_geometry_not_null_expression(source, layer)
    if layer_source_type(source, layer) == "sqlserver":
        rows = connection.execute(f"SELECT TOP 200 {geometry_expression} FROM {from_expression} WHERE {geometry_filter}").fetchall()
    else:
        rows = connection.execute(f"SELECT {geometry_expression} FROM {from_expression} WHERE {geometry_filter} LIMIT 200").fetchall()
    counts: dict[str, int] = {}
    for row in rows:
        geometry = geometry_from_wkb(row[0])
        if geometry is None:
            continue
        geometry_type = geometry.geom_type.upper()
        counts[geometry_type] = counts.get(geometry_type, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda item: item[1])[0]


def layer_row_count(connection: Any, source: GISDataSource, layer: GISLayerDataSource) -> int:
    from_expression = layer_from_expression(source, layer)
    geometry_filter = layer_geometry_not_null_expression(source, layer)
    row = connection.execute(f"SELECT COUNT(*) FROM {from_expression} WHERE {geometry_filter}").fetchone()
    return int(row[0]) if row else 0


@router.get("/layers")
def get_layers(
    source: GISDataSource = Depends(gis_data_source),
) -> dict[str, Any]:
    layers = []
    for layer in source.layers.values():
        connection = connect_gis_database(source, layer)
        try:
            layers.append(
                {
                    "id": layer.id,
                    "label": layer.label,
                    "table": layer.table,
                    "geometry_column": layer.geometry_column,
                    "geometry_type": layer_geometry_type(connection, source, layer),
                    "row_count": layer_row_count(connection, source, layer),
                    "bounds": layer_bounds(connection, source, layer),
                    "color": layer.color,
                    "property_columns": layer_metadata_property_columns(connection, source, layer),
                    "renderers": layer_renderer_metadata(layer),
                }
            )
        finally:
            close_connection(connection)

    return {
        "database": str(source.database),
        "source_crs": source.source_crs,
        "target_crs": source.target_crs,
        "layers": layers,
    }


@router.get("/layers/{layer_id}/features")
def get_layer_features(
    layer_id: str,
    limit: int = Query(500, ge=1, le=5000),
    min_lng: float | None = Query(None, ge=-180, le=180),
    min_lat: float | None = Query(None, ge=-90, le=90),
    max_lng: float | None = Query(None, ge=-180, le=180),
    max_lat: float | None = Query(None, ge=-90, le=90),
    source: GISDataSource = Depends(gis_data_source),
) -> dict[str, Any]:
    bbox_values = [min_lng, min_lat, max_lng, max_lat]
    has_bbox = any(value is not None for value in bbox_values)
    if has_bbox and not all(value is not None for value in bbox_values):
        raise HTTPException(status_code=400, detail={"message": "Spatial filter requires min_lng, min_lat, max_lng, and max_lat."})
    if has_bbox and (min_lng >= max_lng or min_lat >= max_lat):
        raise HTTPException(status_code=400, detail={"message": "Spatial filter bbox is invalid."})

    layer = layer_or_404(source, layer_id)
    connection = connect_gis_database(source, layer)
    try:
        property_columns = layer_property_columns(connection, source, layer)
        if layer_source_type(source, layer) == "sqlserver":
            from_expression = layer_from_expression(source, layer)
            geometry_expression = layer_geometry_expression(source, layer)
            geometry_filter = layer_geometry_not_null_expression(source, layer)
            property_selects = ", ".join(
                f"{quote_sqlserver_identifier(column)} AS {quote_sqlserver_identifier(column)}" for column in property_columns
            )
            select_columns = f"{property_selects}, " if property_selects else ""
            top_clause = "" if has_bbox else f"TOP {limit}"
            sql = f"""
                SELECT {top_clause}
                    {geometry_expression} AS geometry_wkb,
                    {select_columns}
                    1 AS row_marker
                FROM {from_expression}
                WHERE {geometry_filter}
            """
        else:
            from_expression = layer_from_expression(source, layer)
            geometry_expression = layer_geometry_expression(source, layer)
            geometry_filter = layer_geometry_not_null_expression(source, layer)
            property_selects = ", ".join(f"{quote_identifier(column)} AS {quote_identifier(column)}" for column in property_columns)
            select_columns = f"{property_selects}, " if property_selects else ""
            limit_clause = "" if has_bbox else f"LIMIT {limit}"
            sql = f"""
                SELECT
                    {geometry_expression} AS geometry_wkb,
                    {select_columns}
                    1 AS row_marker
                FROM {from_expression}
                WHERE {geometry_filter}
                {limit_clause}
            """

        rows = connection.execute(sql).fetchall()
        features = []
        source_crs = layer_source_crs(source, layer)
        target_crs = layer_target_crs(source, layer)
        bbox_geometry = box(min_lng, min_lat, max_lng, max_lat) if has_bbox else None
        facility_renderer_values = facility_aggregate_renderer_values() if layer.id == "facility_polygons" else {}
        for row in rows:
            geometry = transformed_geometry(row[0], source_crs, target_crs)
            if geometry is None:
                continue
            if bbox_geometry is not None and not geometry.intersects(bbox_geometry):
                continue
            properties = {
                column: serializable_value(row[index + 1])
                for index, column in enumerate(property_columns)
                if row[index + 1] is not None
            }
            if facility_renderer_values:
                properties.update(facility_renderer_values.get(normalize_facility_id(properties.get("FacilityID")), {}))
            properties["geometry_type"] = geometry.geom_type.upper()
            features.append(
                {
                    "type": "Feature",
                    "geometry": mapping(geometry),
                    "properties": properties,
                }
            )
            if len(features) >= limit:
                break
    finally:
        close_connection(connection)

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "layer_id": layer.id,
            "label": layer.label,
            "returned": len(features),
            "limit": limit,
            "spatial_filter": [min_lng, min_lat, max_lng, max_lat] if has_bbox else None,
        },
    }
