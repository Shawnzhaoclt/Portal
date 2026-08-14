from __future__ import annotations

import json
import re
import tempfile
from contextlib import closing
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Literal

import duckdb
import geopandas as gpd
import pandas as pd
from pyproj import Transformer
from shapely import from_wkb, make_valid
from shapely.geometry import mapping, shape
from shapely.ops import transform, unary_union

from portal.app.core.desktop_config import configured_asset_extract_boundary_sources, configured_asset_history
from portal.app.core.duckdb_extensions import DuckDBSpatialExtensionError, load_spatial_extension
from portal.app.exports import ExcelColumn, ExcelSheet, build_portal_excel_workbook
from portal.app.resources.tables.storm_water_asset_history.source import (
    activity_history_for_assets,
    assignment_statuses,
    itpipes_defects_for_assets,
    priority_pipe_risk_for_assets,
    related_risk_scores_for_assets,
)
from portal.runtime.transport import HTTPException


ASSET_TYPES = ("structure", "pipe", "channel")
ASSET_LABELS = {"structure": "Structures", "pipe": "Pipes", "channel": "Drainage"}
ASSIGNMENT_STATES = ("assigned", "unassigned", "not_evaluated", "data_unavailable")
PREVIEW_LIMIT = 5_000
EXPORT_LIMIT = 50_000
MAX_FILTERS_PER_TYPE = 32
BOUNDARY_SEARCH_LIMIT = 10
BOUNDARY_SELECTION_LIMIT = 100
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
GEOMETRY_NAMES = {"geometry", "geom", "shape", "wkb_geometry"}
INTERNAL_FIELD_NAMES = {"__portal_feature_id", "shape_length", "shape_area"}
DEFAULT_FIELD_CANDIDATES = {
    "structure": ("ITPIPE_ASSETID", "ASSETID", "STRUCT_TYPE", "STRUCTURE_SIZE", "MATERIAL", "ACTIVE", "LOCATION"),
    "pipe": ("ITPIPE_ASSETID", "ASSETID", "MATERIAL", "DIAMETER", "US_ASSETID", "DS_ASSETID", "ACTIVE"),
    "channel": ("ITPIPE_ASSETID", "ASSETID", "CH_MAT", "WIDTH", "DEPTH", "US_ASSETID", "DS_ASSETID", "ACTIVE"),
}
FIELD_OPERATORS = {
    "text": ("eq", "ne", "contains", "starts_with", "is_null", "is_not_null"),
    "number": ("eq", "ne", "gt", "gte", "lt", "lte", "is_null", "is_not_null"),
    "date": ("eq", "ne", "gt", "gte", "lt", "lte", "is_null", "is_not_null"),
    "boolean": ("eq", "ne", "is_null", "is_not_null"),
}
RISK_FILTER_FIELDS = {
    "__condition_risk": {"label": "Condition Risk", "risk_key": "condition_risk"},
    "__clogging_risk": {"label": "Clogging Risk", "risk_key": "clogging_risk"},
    "__risk": {"label": "Risk", "risk_key": "risk"},
    "__flood_risk": {"label": "Flooding Risk", "risk_key": "flood_risk"},
}


def _quote(identifier: str) -> str:
    if not IDENTIFIER.fullmatch(str(identifier or "")):
        raise HTTPException(status_code=503, detail=f"Configured inventory identifier is invalid: {identifier}")
    return f'"{identifier}"'


def _qualified_table(table: str, schema: str = "") -> str:
    return f"{_quote(schema)}.{_quote(table)}" if schema else _quote(table)


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, bytes):
        return None
    return str(value)


def _label(value: str) -> str:
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", str(value).replace("_", " "))
    return re.sub(r"\s+", " ", text).strip().title()


def _field_type(data_type: str) -> Literal["text", "number", "date", "boolean"]:
    normalized = str(data_type).upper()
    if "BOOL" in normalized:
        return "boolean"
    if any(token in normalized for token in ("INT", "DECIMAL", "NUMERIC", "DOUBLE", "REAL", "FLOAT", "HUGEINT")):
        return "number"
    if any(token in normalized for token in ("DATE", "TIME", "TIMESTAMP")):
        return "date"
    return "text"


def _open_inventory(path: Path) -> duckdb.DuckDBPyConnection:
    try:
        connection = duckdb.connect(str(path), read_only=True)
        load_spatial_extension(connection)
        return connection
    except (duckdb.Error, OSError, DuckDBSpatialExtensionError) as error:
        raise HTTPException(status_code=503, detail=f"Could not open the active inventory source: {error}") from error


def _open_boundary_source(path: Path, label: str) -> duckdb.DuckDBPyConnection:
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"The active {label} source is unavailable.")
    try:
        connection = duckdb.connect(str(path), read_only=True)
        load_spatial_extension(connection)
        return connection
    except (duckdb.Error, OSError, DuckDBSpatialExtensionError) as error:
        raise HTTPException(status_code=503, detail=f"Could not open the active {label} source: {error}") from error


def _inventory_contract() -> tuple[dict[str, Any], Path]:
    try:
        config = configured_asset_history()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    path = Path(str(config["sources"]["inventory"]["database"])).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=503, detail="The active inventory source is unavailable.")
    return config, path


def _table_schema(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    schema: str = "",
) -> list[dict[str, Any]]:
    try:
        rows = connection.execute(f"DESCRIBE {_qualified_table(table, schema)}").fetchall()
    except duckdb.Error as error:
        raise HTTPException(status_code=503, detail=f"Required inventory table {table} was not found.") from error
    return [{"name": str(row[0]), "data_type": str(row[1])} for row in rows]


def _geometry_field(schema: list[dict[str, Any]], table: str) -> str:
    for field in schema:
        if str(field["data_type"]).upper().startswith("GEOMETRY"):
            return str(field["name"])
    for field in schema:
        if str(field["name"]).casefold() in GEOMETRY_NAMES:
            return str(field["name"])
    raise HTTPException(status_code=503, detail=f"Inventory table {table} has no queryable geometry field.")


def _catalog_from_connection(connection: duckdb.DuckDBPyConnection, config: dict[str, Any]) -> dict[str, Any]:
    assets: dict[str, Any] = {}
    for asset_type in ASSET_TYPES:
        definition = config["inventoryTables"][asset_type]
        table = str(definition["table"])
        id_field = str(definition["idField"])
        schema = _table_schema(connection, table)
        geometry_field = _geometry_field(schema, table)
        by_name = {str(field["name"]).casefold(): field for field in schema}
        if id_field.casefold() not in by_name:
            raise HTTPException(status_code=503, detail=f"Inventory ID field {id_field} was not found in {table}.")
        defaults = {candidate.casefold() for candidate in DEFAULT_FIELD_CANDIDATES[asset_type]}
        fields: list[dict[str, Any]] = []
        for field in schema:
            name = str(field["name"])
            data_type = str(field["data_type"])
            normalized = name.casefold()
            if normalized == geometry_field.casefold() or normalized in GEOMETRY_NAMES:
                continue
            if "BLOB" in data_type.upper() or "GEOMETRY" in data_type.upper():
                continue
            field_type = _field_type(data_type)
            fields.append({
                "name": name,
                "label": _label(name),
                "type": field_type,
                "data_type": data_type,
                "operators": list(FIELD_OPERATORS[field_type]),
                "default": normalized in defaults or normalized == id_field.casefold(),
                "filterable": normalized not in INTERNAL_FIELD_NAMES,
            })
        assets[asset_type] = {
            "asset_type": asset_type,
            "label": ASSET_LABELS[asset_type],
            "table": table,
            "id_field": id_field,
            "geometry_field": geometry_field,
            "fields": fields,
            "filter_fields": [
                *(
                    {
                        "name": name,
                        "label": definition["label"],
                        "type": "number",
                        "data_type": "DERIVED DOUBLE",
                        "operators": list(FIELD_OPERATORS["number"]),
                        "default": False,
                        "filterable": True,
                        "source": "related_risk",
                        "risk_key": definition["risk_key"],
                    }
                    for name, definition in RISK_FILTER_FIELDS.items()
                ),
                *fields,
            ],
            "default_fields": [field["name"] for field in fields if field["default"]],
        }
    return assets


def catalog() -> dict[str, Any]:
    config, path = _inventory_contract()
    with closing(_open_inventory(path)) as connection:
        assets = _catalog_from_connection(connection, config)
    try:
        boundary_sources = configured_asset_extract_boundary_sources()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "asset_types": assets,
        "assignment_states": [
            {"value": "assigned", "label": "Assigned"},
            {"value": "unassigned", "label": "Unassigned"},
            {"value": "not_evaluated", "label": "Not evaluated"},
            {"value": "data_unavailable", "label": "Data unavailable"},
        ],
        "related_sections": [
            {"key": "service_requests", "label": "Service requests"},
            {"key": "investigations", "label": "Investigations"},
            {"key": "inspections", "label": "Inspections"},
            {"key": "work_orders", "label": "Work orders"},
            {"key": "itpipes_defects", "label": "ITPipes defects"},
            {"key": "pipe_risk", "label": "Pipe risk"},
        ],
        "boundary_sources": [
            {"id": source["id"], "label": source["label"]}
            for source in boundary_sources.values()
        ],
        "limits": {"preview": PREVIEW_LIMIT, "export": EXPORT_LIMIT},
    }


def _boundary_source(source_id: str) -> dict[str, Any]:
    normalized = str(source_id or "").strip().lower()
    try:
        source = configured_asset_extract_boundary_sources().get(normalized)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if source is None:
        raise HTTPException(status_code=404, detail="The requested export boundary source is not configured.")
    return source


def _boundary_schema(
    connection: duckdb.DuckDBPyConnection,
    source: dict[str, Any],
) -> dict[str, str]:
    fields = _table_schema(
        connection,
        str(source["table"]),
        str(source.get("schema") or ""),
    )
    by_name = {str(field["name"]).casefold(): str(field["name"]) for field in fields}
    required = [
        str(source["geometryColumn"]),
        str(source["featureIdColumn"]),
        *source["searchFields"],
        *source["displayFields"],
    ]
    missing = [field for field in required if field.casefold() not in by_name]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"The {source['label']} source is missing configured fields: {', '.join(missing)}.",
        )
    return by_name


def search_boundaries(source_id: str, query: str, limit: int = BOUNDARY_SEARCH_LIMIT) -> dict[str, Any]:
    source = _boundary_source(source_id)
    search = str(query or "").strip()
    if len(search) > 100:
        raise HTTPException(status_code=422, detail="Boundary search text cannot exceed 100 characters.")
    safe_limit = max(1, min(int(limit or BOUNDARY_SEARCH_LIMIT), 25))
    path = Path(str(source["database"])).expanduser()
    with closing(_open_boundary_source(path, str(source["label"]))) as connection:
        names = _boundary_schema(connection, source)
        table = _qualified_table(str(source["table"]), str(source.get("schema") or ""))
        id_field = names[str(source["featureIdColumn"]).casefold()]
        display_fields = [names[str(field).casefold()] for field in source["displayFields"]]
        search_fields = [names[str(field).casefold()] for field in source["searchFields"]]
        selected_fields = list(dict.fromkeys([id_field, *display_fields]))
        select_sql = ", ".join(_quote(field) for field in selected_fields)
        search_sql = " || ' ' || ".join(
            f"COALESCE(CAST({_quote(field)} AS VARCHAR), '')" for field in search_fields
        )
        where_sql = ""
        order_rank_sql = "CASE WHEN TRUE THEN 0 ELSE 0 END"
        values: list[Any] = []
        if search:
            where_sql = f"WHERE LOWER({search_sql}) LIKE ? ESCAPE '\\'"
            escaped_search = search.casefold().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            values.append(f"%{escaped_search}%")
            exact_sql = " OR ".join(
                f"LOWER(COALESCE(CAST({_quote(field)} AS VARCHAR), '')) = ?" for field in search_fields
            )
            prefix_sql = " OR ".join(
                f"LOWER(COALESCE(CAST({_quote(field)} AS VARCHAR), '')) LIKE ? ESCAPE '\\'"
                for field in search_fields
            )
            order_rank_sql = f"CASE WHEN {exact_sql} THEN 0 WHEN {prefix_sql} THEN 1 ELSE 2 END"
            values.extend([search.casefold()] * len(search_fields))
            values.extend([f"{escaped_search}%"] * len(search_fields))
        rows = connection.execute(
            f"SELECT {select_sql} FROM {table} {where_sql} "
            f"ORDER BY {order_rank_sql}, CAST({_quote(display_fields[0])} AS VARCHAR), "
            f"CAST({_quote(id_field)} AS VARCHAR) "
            f"LIMIT ?",
            [*values, safe_limit],
        ).fetchall()

    items: list[dict[str, Any]] = []
    for row in rows:
        values_by_field = dict(zip(selected_fields, row, strict=True))
        display_values = [str(values_by_field.get(field) or "").strip() for field in display_fields]
        label = next((value for value in display_values if value), str(values_by_field[id_field]))
        subtitle_values = list(dict.fromkeys(value for value in display_values if value and value != label))
        items.append({
            "id": str(values_by_field[id_field]),
            "label": label,
            "subtitle": " · ".join(subtitle_values),
        })
    return {"source_id": source["id"], "items": items, "limit": safe_limit}


def _polygonal_geometry(geometry: Any) -> Any:
    if geometry.geom_type in {"Polygon", "MultiPolygon"}:
        return geometry
    polygons = [
        item for item in getattr(geometry, "geoms", ())
        if item.geom_type in {"Polygon", "MultiPolygon"} and not item.is_empty
    ]
    return unary_union(polygons) if polygons else None


def boundary_geometry(source_id: str, feature_ids: Iterable[Any]) -> dict[str, Any]:
    source = _boundary_source(source_id)
    ids = list(dict.fromkeys(str(value or "").strip() for value in feature_ids if str(value or "").strip()))
    if not ids:
        raise HTTPException(status_code=422, detail="Select at least one boundary.")
    if len(ids) > BOUNDARY_SELECTION_LIMIT:
        raise HTTPException(
            status_code=422,
            detail=f"No more than {BOUNDARY_SELECTION_LIMIT} boundaries can be combined at once.",
        )
    path = Path(str(source["database"])).expanduser()
    with closing(_open_boundary_source(path, str(source["label"]))) as connection:
        names = _boundary_schema(connection, source)
        table = _qualified_table(str(source["table"]), str(source.get("schema") or ""))
        id_field = names[str(source["featureIdColumn"]).casefold()]
        geometry_field = names[str(source["geometryColumn"]).casefold()]
        placeholders = ", ".join("?" for _ in ids)
        rows = connection.execute(
            f"SELECT CAST({_quote(id_field)} AS VARCHAR), ST_AsWKB({_quote(geometry_field)}) "
            f"FROM {table} WHERE CAST({_quote(id_field)} AS VARCHAR) IN ({placeholders})",
            ids,
        ).fetchall()
    geometries = []
    found_ids = []
    for feature_id, raw_geometry in rows:
        if not raw_geometry:
            continue
        geometry = from_wkb(bytes(raw_geometry))
        if not geometry.is_valid:
            geometry = make_valid(geometry)
        geometry = _polygonal_geometry(geometry)
        if geometry is not None and not geometry.is_empty:
            geometries.append(geometry)
            found_ids.append(str(feature_id))
    if not geometries:
        raise HTTPException(status_code=422, detail="The selected records have no usable polygon geometry.")
    combined = _polygonal_geometry(unary_union(geometries))
    if combined is None or combined.is_empty:
        raise HTTPException(status_code=422, detail="The selected boundaries could not be combined.")
    transformer = Transformer.from_crs(int(source["sourceSrid"]), 4326, always_xy=True)
    projected = transform(transformer.transform, combined)
    count = len(found_ids)
    singular = str(source["label"]).rstrip("s")
    label = f"{count} {singular if count == 1 else source['label'].lower()}"
    return {
        "source_id": source["id"],
        "feature_ids": found_ids,
        "label": label,
        "area": {
            "type": "Feature",
            "properties": {"source_id": source["id"], "feature_count": count},
            "geometry": mapping(projected),
        },
    }


def _selection_area(payload: dict[str, Any]) -> tuple[dict[str, Any], str]:
    raw = payload.get("area")
    if isinstance(raw, dict) and raw.get("type") == "Feature":
        raw = raw.get("geometry")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="Draw or select an export area first.")
    try:
        geometry = shape(raw)
    except Exception as error:
        raise HTTPException(status_code=422, detail="The export area is not valid GeoJSON.") from error
    if geometry.is_empty or geometry.geom_type not in {"Polygon", "MultiPolygon"}:
        raise HTTPException(status_code=422, detail="The export area must be a drawing, selected boundary, or current map extent.")
    if not geometry.is_valid:
        geometry = geometry.buffer(0)
    if geometry.is_empty or not geometry.is_valid:
        raise HTTPException(status_code=422, detail="The export area geometry is invalid.")
    transformer = Transformer.from_crs(4326, 2264, always_xy=True)
    state_plane = transform(transformer.transform, geometry)
    return mapping(geometry), state_plane.wkt


def _validated_asset_types(payload: dict[str, Any]) -> list[str]:
    values = payload.get("asset_types")
    if not isinstance(values, list):
        values = []
    selected = [asset_type for asset_type in ASSET_TYPES if asset_type in {str(value).casefold() for value in values}]
    if not selected:
        raise HTTPException(status_code=422, detail="Select at least one asset type.")
    return selected


def _selected_assignment_states(payload: dict[str, Any]) -> set[str]:
    raw = payload.get("assignment_states")
    if not isinstance(raw, list) or not raw:
        return set(ASSIGNMENT_STATES)
    selected = {str(value).strip().casefold() for value in raw} & set(ASSIGNMENT_STATES)
    if not selected:
        raise HTTPException(status_code=422, detail="Select at least one assignment status.")
    return selected


def _filter_parts(
    raw_rules: Any,
    fields: list[dict[str, Any]],
) -> tuple[list[str], list[Any]]:
    if not isinstance(raw_rules, list):
        return [], []
    if len(raw_rules) > MAX_FILTERS_PER_TYPE:
        raise HTTPException(status_code=422, detail=f"At most {MAX_FILTERS_PER_TYPE} attribute rules may be used for one asset type.")
    by_name = {str(field["name"]).casefold(): field for field in fields if field.get("filterable")}
    parts: list[str] = []
    parameters: list[Any] = []
    for raw in raw_rules:
        if not isinstance(raw, dict):
            continue
        field = by_name.get(str(raw.get("field") or "").casefold())
        if not field:
            raise HTTPException(status_code=422, detail=f"Unknown or non-filterable inventory field: {raw.get('field')}")
        operator = str(raw.get("operator") or "").casefold()
        field_type = str(field["type"])
        if operator not in FIELD_OPERATORS[field_type]:
            raise HTTPException(status_code=422, detail=f"Operator {operator} is not valid for {field['name']}.")
        column = _quote(str(field["name"]))
        value = raw.get("value")
        if operator == "is_null":
            parts.append(f"{column} IS NULL" if field_type != "text" else f"({column} IS NULL OR CAST({column} AS VARCHAR)='')")
            continue
        if operator == "is_not_null":
            parts.append(f"{column} IS NOT NULL" if field_type != "text" else f"({column} IS NOT NULL AND CAST({column} AS VARCHAR)<>'')")
            continue
        comparator = {"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}.get(operator)
        if field_type == "number":
            try:
                value = float(value)
            except (TypeError, ValueError) as error:
                raise HTTPException(status_code=422, detail=f"{field['label']} requires a numeric value.") from error
            parts.append(f"TRY_CAST({column} AS DOUBLE) {comparator} ?")
            parameters.append(value)
        elif field_type == "date":
            parts.append(f"TRY_CAST({column} AS TIMESTAMP) {comparator} TRY_CAST(? AS TIMESTAMP)")
            parameters.append(str(value or ""))
        elif field_type == "boolean":
            normalized = str(value).strip().casefold()
            if normalized not in {"true", "false", "1", "0", "yes", "no"}:
                raise HTTPException(status_code=422, detail=f"{field['label']} requires true or false.")
            parts.append(f"TRY_CAST({column} AS BOOLEAN) {comparator} ?")
            parameters.append(normalized in {"true", "1", "yes"})
        elif operator == "contains":
            parts.append(f"lower(CAST({column} AS VARCHAR)) LIKE ? ESCAPE '\\'")
            parameters.append(f"%{str(value or '').lower().replace('%', '\\%').replace('_', '\\_')}%")
        elif operator == "starts_with":
            parts.append(f"lower(CAST({column} AS VARCHAR)) LIKE ? ESCAPE '\\'")
            parameters.append(f"{str(value or '').lower().replace('%', '\\%').replace('_', '\\_')}%")
        else:
            parts.append(f"CAST({column} AS VARCHAR) {comparator} ?")
            parameters.append(str(value or ""))
    return parts, parameters


def _raw_filter_rules(payload: dict[str, Any], asset_type: str) -> list[dict[str, Any]]:
    filters = payload.get("filters") if isinstance(payload.get("filters"), dict) else {}
    rules = filters.get(asset_type)
    if not isinstance(rules, list):
        return []
    if len(rules) > MAX_FILTERS_PER_TYPE:
        raise HTTPException(status_code=422, detail=f"At most {MAX_FILTERS_PER_TYPE} attribute rules may be used for one asset type.")
    return [rule for rule in rules if isinstance(rule, dict)]


def _compiled_risk_rules(payload: dict[str, Any], asset_type: str) -> list[tuple[str, str, float | None]]:
    compiled: list[tuple[str, str, float | None]] = []
    for rule in _raw_filter_rules(payload, asset_type):
        definition = RISK_FILTER_FIELDS.get(str(rule.get("field") or "").casefold())
        if not definition:
            continue
        operator = str(rule.get("operator") or "").casefold()
        if operator not in FIELD_OPERATORS["number"]:
            raise HTTPException(status_code=422, detail=f"Operator {operator} is not valid for {definition['label']}.")
        value: float | None = None
        if operator not in {"is_null", "is_not_null"}:
            try:
                value = float(rule.get("value"))
            except (TypeError, ValueError) as error:
                raise HTTPException(status_code=422, detail=f"{definition['label']} requires a numeric value.") from error
        compiled.append((str(definition["risk_key"]), operator, value))
    return compiled


def _matches_risk_rules(
    scores: dict[str, float | None],
    rules: list[tuple[str, str, float | None]],
) -> bool:
    for field, operator, expected in rules:
        actual = scores.get(field)
        if operator == "is_null":
            if actual is not None:
                return False
            continue
        if operator == "is_not_null":
            if actual is None:
                return False
            continue
        if actual is None or expected is None:
            return False
        if operator == "eq" and actual != expected:
            return False
        if operator == "ne" and actual == expected:
            return False
        if operator == "gt" and actual <= expected:
            return False
        if operator == "gte" and actual < expected:
            return False
        if operator == "lt" and actual >= expected:
            return False
        if operator == "lte" and actual > expected:
            return False
    return True


def _requested_fields(payload: dict[str, Any], asset_type: str, definition: dict[str, Any], *, preview: bool) -> list[str]:
    available = {str(field["name"]).casefold(): str(field["name"]) for field in definition["fields"]}
    raw_fields = (payload.get("fields") or {}).get(asset_type) if isinstance(payload.get("fields"), dict) else None
    requested = definition["default_fields"] if preview or not isinstance(raw_fields, list) else raw_fields
    selected = [available[str(value).casefold()] for value in requested if str(value).casefold() in available]
    id_field = str(definition["id_field"])
    if id_field not in selected:
        selected.insert(0, id_field)
    return list(dict.fromkeys(selected))[:200]


def _query_attribute_rows(
    connection: duckdb.DuckDBPyConnection,
    payload: dict[str, Any],
    definition: dict[str, Any],
    area_wkt: str,
    fields: list[str],
) -> list[dict[str, Any]]:
    rules = _raw_filter_rules(payload, str(definition["asset_type"]))
    inventory_rules = [rule for rule in rules if str(rule.get("field") or "").casefold() not in RISK_FILTER_FIELDS]
    filter_parts, filter_values = _filter_parts(inventory_rules, definition["fields"])
    id_field = str(definition["id_field"])
    geometry_field = str(definition["geometry_field"])
    selected = ", ".join(_quote(field) for field in fields)
    where = [f"{_quote(geometry_field)} IS NOT NULL", f"ST_Intersects({_quote(geometry_field)}, ST_GeomFromText(?))", *filter_parts]
    rows = connection.execute(
        f"SELECT {selected} FROM {_quote(str(definition['table']))} WHERE {' AND '.join(where)}",
        [area_wkt, *filter_values],
    ).fetchall()
    output: list[dict[str, Any]] = []
    for row in rows:
        attributes = {field: _json_value(value) for field, value in zip(fields, row)}
        asset_id = re.sub(r"\.0+$", "", str(attributes.get(id_field) or "").strip())
        if asset_id:
            output.append({"asset_type": definition["asset_type"], "asset_id": asset_id, "attributes": attributes})
    return output


def _attach_geometry(
    connection: duckdb.DuckDBPyConnection,
    definition: dict[str, Any],
    rows: list[dict[str, Any]],
    *,
    geojson: bool,
) -> None:
    if not rows:
        return
    connection.execute("DROP TABLE IF EXISTS portal_extract_ids")
    connection.execute("CREATE TEMP TABLE portal_extract_ids(asset_id VARCHAR)")
    connection.executemany("INSERT INTO portal_extract_ids VALUES (?)", [(row["asset_id"],) for row in rows])
    id_field = str(definition["id_field"])
    geometry_field = str(definition["geometry_field"])
    geometry_sql = (
        f"ST_AsGeoJSON(ST_Transform(source.{_quote(geometry_field)}, 'EPSG:2264', 'EPSG:4326', always_xy := true))"
        if geojson
        else f"ST_AsWKB(source.{_quote(geometry_field)})"
    )
    values = connection.execute(
        f"""
        SELECT regexp_replace(CAST(source.{_quote(id_field)} AS VARCHAR), '\\.0+$', '') AS asset_id,
               {geometry_sql} AS geometry
        FROM {_quote(str(definition['table']))} source
        JOIN portal_extract_ids selected
          ON upper(regexp_replace(CAST(source.{_quote(id_field)} AS VARCHAR), '\\.0+$', ''))=upper(selected.asset_id)
        """
    ).fetchall()
    geometry_by_id = {str(asset_id): geometry for asset_id, geometry in values}
    for row in rows:
        row["geometry"] = geometry_by_id.get(row["asset_id"])


def _preview_sample(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a proportional preview so one abundant asset type cannot hide the others."""
    if len(rows) <= PREVIEW_LIMIT:
        return rows
    grouped = {
        asset_type: [row for row in rows if row["asset_type"] == asset_type]
        for asset_type in ASSET_TYPES
    }
    grouped = {asset_type: values for asset_type, values in grouped.items() if values}
    raw_allocations = {
        asset_type: PREVIEW_LIMIT * len(values) / len(rows)
        for asset_type, values in grouped.items()
    }
    allocations = {
        asset_type: min(len(grouped[asset_type]), max(1, int(raw)))
        for asset_type, raw in raw_allocations.items()
    }
    while sum(allocations.values()) < PREVIEW_LIMIT:
        candidates = [
            asset_type for asset_type, values in grouped.items()
            if allocations[asset_type] < len(values)
        ]
        if not candidates:
            break
        asset_type = max(
            candidates,
            key=lambda value: (raw_allocations[value] - allocations[value], len(grouped[value])),
        )
        allocations[asset_type] += 1
    while sum(allocations.values()) > PREVIEW_LIMIT:
        candidates = [asset_type for asset_type, value in allocations.items() if value > 1]
        if not candidates:
            break
        asset_type = max(candidates, key=lambda value: allocations[value] - raw_allocations[value])
        allocations[asset_type] -= 1
    return [
        row
        for asset_type in ASSET_TYPES
        for row in grouped.get(asset_type, [])[:allocations.get(asset_type, 0)]
    ]


def select_assets(payload: dict[str, Any], *, preview: bool) -> dict[str, Any]:
    area_geojson, area_wkt = _selection_area(payload)
    selected_types = _validated_asset_types(payload)
    assignment_filter = _selected_assignment_states(payload)
    config, path = _inventory_contract()
    with closing(_open_inventory(path)) as connection:
        definitions = _catalog_from_connection(connection, config)
        rows_by_type: dict[str, list[dict[str, Any]]] = {}
        all_rows: list[dict[str, Any]] = []
        for asset_type in selected_types:
            definition = definitions[asset_type]
            fields = _requested_fields(payload, asset_type, definition, preview=preview)
            rows = _query_attribute_rows(connection, payload, definition, area_wkt, fields)
            rows_by_type[asset_type] = rows
            all_rows.extend(rows)

        warnings: list[str] = []
        risk_rules = {asset_type: _compiled_risk_rules(payload, asset_type) for asset_type in selected_types}
        if any(risk_rules.values()):
            risk_scores, risk_warnings = related_risk_scores_for_assets(
                (row["asset_type"], row["asset_id"]) for row in all_rows
            )
            warnings.extend(risk_warnings)
            filtered_rows: list[dict[str, Any]] = []
            for row in all_rows:
                scores = risk_scores.get((row["asset_type"], row["asset_id"]), {})
                if _matches_risk_rules(scores, risk_rules[row["asset_type"]]):
                    row["risk_scores"] = scores
                    filtered_rows.append(row)
            all_rows = filtered_rows
        try:
            assignment = assignment_statuses(row["asset_id"] for row in all_rows)
            statuses = assignment["statuses"]
            assignment_source = {key: assignment.get(key) for key in ("source_id", "version", "published_at")}
        except HTTPException as error:
            statuses = {row["asset_id"]: "data_unavailable" for row in all_rows}
            assignment_source = {"source_id": "intermediate.riskranking", "version": "", "published_at": None}
            warnings.append(str(error.detail))
        selected_rows: list[dict[str, Any]] = []
        counts_by_type = {asset_type: 0 for asset_type in selected_types}
        counts_by_status = {status: 0 for status in ASSIGNMENT_STATES}
        for row in all_rows:
            status = statuses.get(row["asset_id"], "not_evaluated")
            row["assignment_status"] = status
            if status not in assignment_filter:
                continue
            selected_rows.append(row)
            counts_by_type[row["asset_type"]] += 1
            counts_by_status[status] += 1
        if len(selected_rows) > EXPORT_LIMIT:
            warnings.append(f"The selection contains {len(selected_rows):,} assets. Narrow it to {EXPORT_LIMIT:,} assets or fewer before export.")

        preview_rows: list[dict[str, Any]] = []
        if preview:
            preview_rows = _preview_sample(selected_rows)
            for asset_type in selected_types:
                subset = [row for row in preview_rows if row["asset_type"] == asset_type]
                _attach_geometry(connection, definitions[asset_type], subset, geojson=True)
        else:
            if len(selected_rows) > EXPORT_LIMIT:
                raise HTTPException(status_code=422, detail=f"The selection exceeds the {EXPORT_LIMIT:,}-asset export limit.")
            for asset_type in selected_types:
                subset = [row for row in selected_rows if row["asset_type"] == asset_type]
                _attach_geometry(connection, definitions[asset_type], subset, geojson=False)

    return {
        "area": area_geojson,
        "rows": selected_rows,
        "preview_rows": preview_rows,
        "counts_by_type": counts_by_type,
        "counts_by_status": counts_by_status,
        "total": len(selected_rows),
        "preview_limit": PREVIEW_LIMIT,
        "truncated": preview and len(selected_rows) > PREVIEW_LIMIT,
        "warnings": warnings,
        "assignment_source": assignment_source,
    }


def preview(payload: dict[str, Any]) -> dict[str, Any]:
    selection = select_assets(payload, preview=True)
    features: list[dict[str, Any]] = []
    for row in selection["preview_rows"]:
        if not row.get("geometry"):
            continue
        try:
            geometry = json.loads(str(row["geometry"]))
        except json.JSONDecodeError:
            continue
        features.append({
            "type": "Feature",
            "id": f"{row['asset_type']}:{row['asset_id']}",
            "geometry": geometry,
            "properties": {
                "asset_type": row["asset_type"],
                "asset_id": row["asset_id"],
                "assignment_status": row["assignment_status"],
                **{key: value for key, value in row.get("risk_scores", {}).items() if value is not None},
                **row["attributes"],
            },
        })
    return {
        "type": "FeatureCollection",
        "features": features,
        "total": selection["total"],
        "counts_by_type": selection["counts_by_type"],
        "counts_by_status": selection["counts_by_status"],
        "preview_limit": PREVIEW_LIMIT,
        "truncated": selection["truncated"],
        "warnings": selection["warnings"],
        "assignment_source": selection["assignment_source"],
    }


def _record_time(value: Any) -> float:
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time()).timestamp()
    text = str(value or "").strip()
    if not text:
        return float("-inf")
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("-inf")


def _record_identifier_rank(value: Any) -> tuple[int, float, str]:
    text = str(value or "").strip()
    try:
        return (1, float(text), text)
    except ValueError:
        return (0, float("-inf"), text.casefold())


def _most_recent_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (str(row.get("asset_type") or ""), str(row.get("asset_id") or ""))
        current = latest.get(key)
        rank = (_record_time(row.get("event_date")), _record_identifier_rank(row.get("record_id")))
        current_rank = (
            _record_time(current.get("event_date")),
            _record_identifier_rank(current.get("record_id")),
        ) if current else None
        if current_rank is None or rank > current_rank:
            latest[key] = row
    return sorted(latest.values(), key=lambda row: _record_time(row.get("event_date")), reverse=True)


def _most_recent_itpipes_defects(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest_inspection: dict[str, tuple[float, tuple[int, float, str], str]] = {}
    for row in rows:
        asset_id = str(row.get("asset_id") or "")
        inspection_id = str(row.get("mli_id") or "")
        rank = (_record_time(row.get("inspection_date")), _record_identifier_rank(inspection_id), inspection_id)
        if asset_id not in latest_inspection or rank > latest_inspection[asset_id]:
            latest_inspection[asset_id] = rank
    return [
        row for row in rows
        if str(row.get("mli_id") or "") == latest_inspection.get(
            str(row.get("asset_id") or ""),
            (float("-inf"), (0, float("-inf"), ""), ""),
        )[2]
    ]


def _apply_related_mode(related: dict[str, list[dict[str, Any]]], mode: str) -> dict[str, list[dict[str, Any]]]:
    if mode == "all":
        return related
    if mode != "most_recent":
        raise HTTPException(status_code=422, detail="Related record coverage must be all or most_recent.")
    for key in ("service_requests", "investigations", "inspections", "work_orders"):
        related[key] = _most_recent_rows(related[key])
    related["itpipes_defects"] = _most_recent_itpipes_defects(related["itpipes_defects"])
    return related


def _related_rows(selection: dict[str, Any], payload: dict[str, Any]) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    include = payload.get("include_related") if isinstance(payload.get("include_related"), dict) else {}
    assets = [(row["asset_type"], row["asset_id"]) for row in selection["rows"]]
    related: dict[str, list[dict[str, Any]]] = {
        "service_requests": [], "investigations": [], "inspections": [], "work_orders": [],
        "itpipes_defects": [], "pipe_risk": [],
    }
    warnings: list[str] = []
    if any(bool(include.get(key, True)) for key in ("service_requests", "investigations", "inspections", "work_orders")):
        try:
            history = activity_history_for_assets(assets)
            for key in history:
                if bool(include.get(key, True)):
                    related[key] = history[key]
        except HTTPException as error:
            warnings.append(f"Cityworks related data was omitted: {error.detail}")
    if bool(include.get("itpipes_defects", True)):
        try:
            related["itpipes_defects"] = itpipes_defects_for_assets(row["asset_id"] for row in selection["rows"])
        except HTTPException as error:
            warnings.append(f"ITPipes defects were omitted: {error.detail}")
    if bool(include.get("pipe_risk", True)):
        try:
            related["pipe_risk"] = priority_pipe_risk_for_assets(
                row["asset_id"] for row in selection["rows"] if row["asset_type"] == "pipe"
            )
        except HTTPException as error:
            warnings.append(f"Pipe risk was omitted: {error.detail}")
    return _apply_related_mode(related, str(payload.get("related_mode") or "all").strip().casefold()), warnings


def _excel_type(data_type: str) -> Literal["text", "number", "integer", "date", "datetime"]:
    field_type = _field_type(data_type)
    if field_type == "number":
        return "number"
    if field_type == "date":
        return "datetime"
    return "text"


def build_excel(payload: dict[str, Any], exported_by: str) -> bytes:
    selection = select_assets(payload, preview=False)
    related, related_warnings = _related_rows(selection, payload)
    config, path = _inventory_contract()
    with closing(_open_inventory(path)) as connection:
        definitions = _catalog_from_connection(connection, config)
    sheets: list[ExcelSheet] = []
    summary_rows = [
        {"field": "Generated", "value": datetime.now().astimezone()},
        {"field": "Total assets", "value": selection["total"]},
        *({"field": ASSET_LABELS[key], "value": value} for key, value in selection["counts_by_type"].items()),
        *({"field": _label(key), "value": value} for key, value in selection["counts_by_status"].items()),
        {"field": "Step 401 source version", "value": selection["assignment_source"].get("version") or "Unavailable"},
        {"field": "Related record coverage", "value": "Most recent only" if payload.get("related_mode") == "most_recent" else "All related records"},
        {"field": "Warnings", "value": " | ".join([*selection["warnings"], *related_warnings]) or "None"},
    ]
    sheets.append(ExcelSheet(
        "Export Summary", "Asset Data Extract Summary",
        (ExcelColumn("field", "Field", 30), ExcelColumn("value", "Value", 60, wrap_text=True)),
        summary_rows,
    ))
    for asset_type in ASSET_TYPES:
        rows = [row for row in selection["rows"] if row["asset_type"] == asset_type]
        if not rows:
            continue
        definition = definitions[asset_type]
        fields = _requested_fields(payload, asset_type, definition, preview=False)
        schema_by_name = {field["name"]: field for field in definition["fields"]}
        columns = [
            ExcelColumn("asset_id", "Asset ID", 18),
            ExcelColumn("assignment_status", "Assignment Status", 20),
            *(ExcelColumn(field, _label(field), 20, _excel_type(str(schema_by_name[field]["data_type"])), wrap_text=True) for field in fields if field != definition["id_field"]),
        ]
        flat_rows = [
            {"asset_id": row["asset_id"], "assignment_status": _label(row["assignment_status"]), **row["attributes"]}
            for row in rows
        ]
        sheets.append(ExcelSheet(ASSET_LABELS[asset_type], ASSET_LABELS[asset_type], columns, flat_rows))

    activity_columns = (
        ExcelColumn("asset_type", "Asset Type", 16), ExcelColumn("asset_id", "Asset ID", 18),
        ExcelColumn("event_date", "Event Date", 22, "datetime"), ExcelColumn("record_id", "Record ID", 18),
        ExcelColumn("status", "Status", 16), ExcelColumn("title", "Title", 30, wrap_text=True),
        ExcelColumn("summary", "Summary", 42, wrap_text=True), ExcelColumn("relationship", "Relationship", 28, wrap_text=True),
    )
    for key, title in (("service_requests", "Service Requests"), ("investigations", "Investigations"), ("inspections", "Inspections"), ("work_orders", "Work Orders")):
        if related[key]:
            columns = activity_columns
            if key == "inspections":
                columns = (*activity_columns, ExcelColumn("condition_risk", "Condition Risk", 16, "number"), ExcelColumn("flood_risk", "Flood Risk", 14, "number"), ExcelColumn("clogging_risk", "Clogging Risk", 16, "number"), ExcelColumn("risk", "Risk", 14, "number"))
            sheets.append(ExcelSheet(title, title, columns, related[key]))
    if related["itpipes_defects"]:
        sheets.append(ExcelSheet("ITPipes Defects", "ITPipes Defects", (
            ExcelColumn("asset_id", "Asset ID", 18), ExcelColumn("inspection_date", "Inspection Date", 22, "datetime"),
            ExcelColumn("mli_id", "MLI ID", 14), ExcelColumn("mlo_id", "MLO ID", 14), ExcelColumn("ml_id", "ML ID", 14),
            ExcelColumn("inspection_direction", "Direction", 18), ExcelColumn("is_continuous", "Continuous", 14),
            ExcelColumn("observation_text", "Observation Text", 36, wrap_text=True), ExcelColumn("distance", "Distance", 14, "number"),
            ExcelColumn("relative_depth", "Relative Depth", 16, "number"), ExcelColumn("condition_risk", "Condition Risk", 16, "number"),
            ExcelColumn("flood_risk", "Flood Risk", 14, "number"), ExcelColumn("clogging_risk", "Clogging Risk", 16, "number"), ExcelColumn("risk", "Risk", 14, "number"),
        ), related["itpipes_defects"]))
    if related["pipe_risk"]:
        sheets.append(ExcelSheet("Pipe Risk", "Pipe Risk", (
            ExcelColumn("asset_id", "Asset ID", 18), ExcelColumn("basin_name", "Basin Name", 22), ExcelColumn("work_zone_id", "Work Zone ID", 18),
            ExcelColumn("cl_score", "CL Score", 14, "number"), ExcelColumn("lof_score", "LOF Score", 14, "number"),
            ExcelColumn("cof_score", "COF Score", 14, "number"), ExcelColumn("risk", "Risk", 14, "number"),
        ), related["pipe_risk"]))
    return build_portal_excel_workbook(
        report_title="Storm Water Asset Data Extract",
        sheets=sheets,
        exported_by=exported_by,
        vertical_alignment="center",
        number_format="0.###",
    )


def _plain_related_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _json_value(value) for key, value in row.items() if key not in {"source_attributes", "source_ids"} and not isinstance(value, (dict, list, tuple, set))}


def build_geopackage(payload: dict[str, Any]) -> bytes:
    # Keep GDAL optional for every other map workflow. The portable worker
    # imports it only when a user actually requests a GeoPackage export.
    import pyogrio

    selection = select_assets(payload, preview=False)
    related, _warnings = _related_rows(selection, payload)
    config, path = _inventory_contract()
    with closing(_open_inventory(path)) as connection:
        definitions = _catalog_from_connection(connection, config)
    with tempfile.TemporaryDirectory(prefix="portal-asset-extract-") as temporary:
        output = Path(temporary) / "Storm_Water_Asset_Data_Extract.gpkg"
        for asset_type in ASSET_TYPES:
            rows = [row for row in selection["rows"] if row["asset_type"] == asset_type and row.get("geometry")]
            if not rows:
                continue
            definition = definitions[asset_type]
            fields = _requested_fields(payload, asset_type, definition, preview=False)
            records = [{"asset_id": row["asset_id"], "assignment_status": row["assignment_status"], **{field: row["attributes"].get(field) for field in fields if field != definition["id_field"]}} for row in rows]
            geometries = [from_wkb(bytes(row["geometry"])) for row in rows]
            frame = gpd.GeoDataFrame(records, geometry=geometries, crs="EPSG:2264")
            pyogrio.write_dataframe(frame, output, layer={"structure": "structures", "pipe": "pipes", "channel": "drainage"}[asset_type], driver="GPKG")
        for key, values in related.items():
            if values:
                pyogrio.write_dataframe(pd.DataFrame([_plain_related_row(row) for row in values]), output, layer=key, driver="GPKG")
        if not output.is_file():
            raise HTTPException(status_code=500, detail="GeoPackage export did not produce an output file.")
        return output.read_bytes()
