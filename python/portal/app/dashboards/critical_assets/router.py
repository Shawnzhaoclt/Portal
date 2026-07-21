from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import duckdb
from portal.runtime.transport import APIRouter, Depends, HTTPException, Query

from portal.app.core.data_sources import CriticalAssetsDataSource, critical_assets_data_source
from portal.app.core.records import clean_record


router = APIRouter(prefix="/api/critical-assets", tags=["critical-assets"])

SOURCE_LABELS = {
    "both": "Multiple Assets",
    "pipes": "Pipes",
    "structures": "Structures",
}
METRIC_COLUMNS = {
    "risk": "RISK",
    "condition": "COND_RISK",
    "flood": "FLOOD_RISK",
    "clog": "CLOG_RISK",
}
NUMERIC_FILTER_COLUMNS = {
    "risk": "RISK",
    "condition_risk": "COND_RISK",
    "flood_risk": "FLOOD_RISK",
    "clog_risk": "CLOG_RISK",
    "risk_delta": "RISK_DELTA",
    "condition_delta": "COND_RISK_DELTA",
    "flood_delta": "FLOOD_RISK_DELTA",
    "clog_delta": "CLOG_RISK_DELTA",
    "risk_delta_sum": "RISK_DELTA_SUM",
    "condition_delta_sum": "COND_RISK_DELTA_SUM",
    "flood_delta_sum": "FLOOD_RISK_DELTA_SUM",
    "clog_delta_sum": "CLOG_RISK_DELTA_SUM",
    "pipe_size": "Pipe_Size",
    "inspection_count": "INSPECTION_COUNT",
}
NUMERIC_FILTER_LABELS = {
    "risk": "Risk",
    "condition_risk": "Condition Risk",
    "flood_risk": "Flood Risk",
    "clog_risk": "Clog Risk",
    "risk_delta": "Risk Delta",
    "condition_delta": "Condition Risk Delta",
    "flood_delta": "Flood Risk Delta",
    "clog_delta": "Clog Risk Delta",
    "risk_delta_sum": "Risk Delta Sum",
    "condition_delta_sum": "Condition Risk Delta Sum",
    "flood_delta_sum": "Flood Risk Delta Sum",
    "clog_delta_sum": "Clog Risk Delta Sum",
    "pipe_size": "Pipe Size",
    "inspection_count": "Inspection Count",
}
HISTORY_GRAPH_BOTH_DEFAULT_RANGES = {
    "risk_delta_sum": ("RISK_DELTA_SUM", 0.0, 80.614999999999995),
    "condition_delta_sum": ("COND_RISK_DELTA_SUM", 0.0, 123.82499999999999),
    "flood_delta_sum": ("FLOOD_RISK_DELTA_SUM", 0.0, 88.0),
    "clog_delta_sum": ("CLOG_RISK_DELTA_SUM", 0.0, 162.75),
}
TABLE_NUMERIC_COLUMNS = {
    "FacilityID",
    "INSPECTIONID",
    "INSPECTION_COUNT",
    "INSPECTION_INDEX",
    "Pipe_Size",
    "RISK",
    "RISK_DELTA",
    "RISK_DELTA_SUM",
    "COND_RISK",
    "COND_RISK_DELTA",
    "COND_RISK_DELTA_SUM",
    "CLOG_RISK",
    "CLOG_RISK_DELTA",
    "CLOG_RISK_DELTA_SUM",
    "FLOOD_RISK",
    "FLOOD_RISK_DELTA",
    "FLOOD_RISK_DELTA_SUM",
}
TABLE_CHECKLIST_COLUMNS = {"INVESTIGATEDBY", "investigator", "MATERIAL"}

BASE_DETAIL_COLUMNS = [
    "INSPECTIONID",
    "STATUS",
    "ITPIPE_ASSETID",
    "asset_type",
    "Inspection_Date",
    "investigator",
    "Address",
    "StreetWater",
    "MATERIAL",
    "Size",
    "FacilityID",
    "RISK",
    "RISK_DELTA",
    "RISK_DELTA_SUM",
    "COND_RISK",
    "COND_RISK_DELTA",
    "COND_RISK_DELTA_SUM",
    "CLOG_RISK",
    "CLOG_RISK_DELTA",
    "CLOG_RISK_DELTA_SUM",
    "FLOOD_RISK",
    "FLOOD_RISK_DELTA",
    "FLOOD_RISK_DELTA_SUM",
    "INSPECTION_INDEX",
    "IS_MOST_RECENT",
    "INSPECTION_COUNT",
    "GB_MAX_RISK",
    "GB_MAX_COND_RISK",
    "GB_MAX_FLOOD_RISK",
    "GB_MAX_CLOG_RISK",
    "GB_MAX_PACP_DEFECT",
]
PIPE_DETAIL_COLUMNS = [
    *BASE_DETAIL_COLUMNS,
    "INVESTIGATEDBY",
    "WorkZoneID",
    "Pipe_Size",
    "PERCENT_CONSUMED",
    "DC_RISK",
]
TABLEAU_HISTORY_BOTH_TABLE_COLUMNS = [
    "FacilityID",
    "ITPIPE_ASSETID",
    "INSPECTIONID",
    "INSPECTION_INDEX",
    "Inspection_Date",
    "RISK",
    "RISK_DELTA",
    "COND_RISK",
    "COND_RISK_DELTA",
    "CLOG_RISK",
    "CLOG_RISK_DELTA",
    "FLOOD_RISK",
    "FLOOD_RISK_DELTA",
]
TABLEAU_HISTORY_PIPES_TABLE_COLUMNS = [
    "FacilityID",
    "ITPIPE_ASSETID",
    "INSPECTIONID",
    "INSPECTION_INDEX",
    "Inspection_Date",
    "INVESTIGATEDBY",
    "investigator",
    "MATERIAL",
    "Pipe_Size",
    "COND_RISK",
    "COND_RISK_DELTA",
    "CLOG_RISK",
    "CLOG_RISK_DELTA",
    "RISK",
    "RISK_DELTA",
    "FLOOD_RISK",
    "FLOOD_RISK_DELTA",
]
HISTORY_COLUMNS = [
    "FacilityID",
    "ITPIPE_ASSETID",
    "INSPECTIONID",
    "INSPECTION_INDEX",
    "Inspection_Date",
    "MATERIAL",
    "RISK",
    "RISK_DELTA",
    "RISK_DELTA_SUM",
    "COND_RISK",
    "COND_RISK_DELTA",
    "COND_RISK_DELTA_SUM",
    "CLOG_RISK",
    "CLOG_RISK_DELTA",
    "CLOG_RISK_DELTA_SUM",
    "FLOOD_RISK",
    "FLOOD_RISK_DELTA",
    "FLOOD_RISK_DELTA_SUM",
    "INSPECTION_COUNT",
    "IS_MOST_RECENT",
]
PIPE_HISTORY_COLUMNS = [
    *HISTORY_COLUMNS,
    "INVESTIGATEDBY",
    "investigator",
    "Pipe_Size",
    "PERCENT_CONSUMED",
]


def quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def table_reference(table_name: str) -> str:
    if not table_name:
        raise HTTPException(status_code=503, detail={"message": "Critical assets table name is not configured."})
    return quote_identifier(table_name)


def source_table(source_key: str, source: CriticalAssetsDataSource) -> str:
    if source_key not in source.tables:
        raise HTTPException(status_code=404, detail={"message": "Unknown critical asset source.", "source": source_key})
    table_name = source.tables[source_key]
    if not table_name:
        raise HTTPException(status_code=503, detail={"message": "Critical asset source table is not configured.", "source": source_key})
    return table_name


def critical_assets_connection() -> duckdb.DuckDBPyConnection:
    source = critical_assets_data_source()
    if source.source_type.lower() != "duckdb":
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Critical Asset Tracking datasource must be configured as DuckDB.",
                "source_type": source.source_type,
            },
        )
    if not source.database.exists():
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Critical Asset Tracking DuckDB file was not found.",
                "database": str(source.database),
            },
        )

    try:
        connection = duckdb.connect(str(source.database), read_only=True)
    except duckdb.Error as error:
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Could not connect to the Critical Asset Tracking DuckDB datasource.",
                "database": str(source.database),
                "error": str(error),
            },
        ) from error

    try:
        connection.execute("LOAD spatial")
    except duckdb.Error:
        pass

    return connection


def fetch_dicts(
    connection: duckdb.DuckDBPyConnection,
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
) -> list[dict[str, Any]]:
    cursor = connection.execute(sql, params or [])
    columns = [column[0] for column in cursor.description]
    return [clean_record(dict(zip(columns, row))) for row in cursor.fetchall()]


def fetch_one(
    connection: duckdb.DuckDBPyConnection,
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
) -> dict[str, Any]:
    rows = fetch_dicts(connection, sql, params)
    return rows[0] if rows else {}


def table_columns(connection: duckdb.DuckDBPyConnection, table_name: str) -> list[dict[str, Any]]:
    return fetch_dicts(
        connection,
        """
        select column_name as name, data_type, ordinal_position
        from information_schema.columns
        where table_name = ?
        order by ordinal_position
        """,
        [table_name],
    )


def available_columns(connection: duckdb.DuckDBPyConnection, table_name: str) -> set[str]:
    return {row["name"] for row in table_columns(connection, table_name)}


def selected_columns(columns: set[str], desired: list[str]) -> list[str]:
    return [column for column in desired if column in columns]


def coerce_float(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except ValueError as error:
        raise HTTPException(status_code=400, detail={"message": "Numeric filter value is not valid.", "value": value}) from error


def truthy_expression(column: str, expected: str) -> str:
    values = ("'true'", "'1'", "'yes'", "'y'")
    negated_values = ("'false'", "'0'", "'no'", "'n'")
    options = ", ".join(values if expected == "true" else negated_values)
    return f"lower(cast({quote_identifier(column)} as varchar)) in ({options})"


def critical_asset_filters(
    search: str | None = Query(default=None),
    facility_id: str | None = Query(default=None),
    asset_id: str | None = Query(default=None),
    inspection_count: str | None = Query(default=None),
    inspection_date: str | None = Query(default=None),
    material: list[str] | None = Query(default=None),
    street_water: str | None = Query(default=None),
    most_recent: str | None = Query(default=None),
    min_risk: str | None = Query(default=None),
    max_risk: str | None = Query(default=None),
    min_condition_risk: str | None = Query(default=None),
    max_condition_risk: str | None = Query(default=None),
    min_flood_risk: str | None = Query(default=None),
    max_flood_risk: str | None = Query(default=None),
    min_clog_risk: str | None = Query(default=None),
    max_clog_risk: str | None = Query(default=None),
    min_risk_delta: str | None = Query(default=None),
    max_risk_delta: str | None = Query(default=None),
    min_condition_delta: str | None = Query(default=None),
    max_condition_delta: str | None = Query(default=None),
    min_flood_delta: str | None = Query(default=None),
    max_flood_delta: str | None = Query(default=None),
    min_clog_delta: str | None = Query(default=None),
    max_clog_delta: str | None = Query(default=None),
    min_risk_delta_sum: str | None = Query(default=None),
    max_risk_delta_sum: str | None = Query(default=None),
    min_condition_delta_sum: str | None = Query(default=None),
    max_condition_delta_sum: str | None = Query(default=None),
    min_flood_delta_sum: str | None = Query(default=None),
    max_flood_delta_sum: str | None = Query(default=None),
    min_clog_delta_sum: str | None = Query(default=None),
    max_clog_delta_sum: str | None = Query(default=None),
    min_pipe_size: str | None = Query(default=None),
    max_pipe_size: str | None = Query(default=None),
    min_inspection_count: str | None = Query(default=None),
    max_inspection_count: str | None = Query(default=None),
    flag: list[str] | None = Query(default=None),
    number_filter: list[str] | None = Query(default=None),
    date_filter: list[str] | None = Query(default=None),
    text_filter: list[str] | None = Query(default=None),
    multi_filter: list[str] | None = Query(default=None),
) -> dict[str, Any]:
    return {
        "search": search,
        "facility_id": facility_id,
        "asset_id": asset_id,
        "inspection_count": inspection_count,
        "inspection_date": inspection_date,
        "material": material or [],
        "street_water": street_water,
        "most_recent": most_recent,
        "flag": flag or [],
        "number_filter": number_filter or [],
        "date_filter": date_filter or [],
        "text_filter": text_filter or [],
        "multi_filter": multi_filter or [],
        "numeric": {
            "risk": (min_risk, max_risk),
            "condition_risk": (min_condition_risk, max_condition_risk),
            "flood_risk": (min_flood_risk, max_flood_risk),
            "clog_risk": (min_clog_risk, max_clog_risk),
            "risk_delta": (min_risk_delta, max_risk_delta),
            "condition_delta": (min_condition_delta, max_condition_delta),
            "flood_delta": (min_flood_delta, max_flood_delta),
            "clog_delta": (min_clog_delta, max_clog_delta),
            "risk_delta_sum": (min_risk_delta_sum, max_risk_delta_sum),
            "condition_delta_sum": (min_condition_delta_sum, max_condition_delta_sum),
            "flood_delta_sum": (min_flood_delta_sum, max_flood_delta_sum),
            "clog_delta_sum": (min_clog_delta_sum, max_clog_delta_sum),
            "pipe_size": (min_pipe_size, max_pipe_size),
            "inspection_count": (min_inspection_count, max_inspection_count),
        },
    }


def build_where_clause(
    connection: duckdb.DuckDBPyConnection,
    table_name: str,
    filters: dict[str, Any],
) -> tuple[str, list[Any]]:
    columns = available_columns(connection, table_name)
    clauses: list[str] = []
    params: list[Any] = []

    search = (filters.get("search") or "").strip()
    if search:
        searchable = selected_columns(
            columns,
            ["FacilityID", "ITPIPE_ASSETID", "INSPECTIONID", "Address", "investigator", "INVESTIGATEDBY", "MATERIAL"],
        )
        if searchable:
            clauses.append(
                "("
                + " or ".join(f"cast({quote_identifier(column)} as varchar) ilike ?" for column in searchable)
                + ")"
            )
            params.extend([f"%{search}%"] * len(searchable))

    simple_like_filters = {
        "facility_id": "FacilityID",
        "asset_id": "ITPIPE_ASSETID",
        "inspection_count": "INSPECTION_COUNT",
    }
    for filter_key, column in simple_like_filters.items():
        value = (filters.get(filter_key) or "").strip()
        if value and column in columns:
            clauses.append(f"cast({quote_identifier(column)} as varchar) ilike ?")
            params.append(f"%{value}%")

    materials = [str(value) for value in filters.get("material", []) if str(value) != ""]
    if materials and "MATERIAL" in columns:
        placeholders = ", ".join("?" for _ in materials)
        clauses.append(f"cast({quote_identifier('MATERIAL')} as varchar) in ({placeholders})")
        params.extend(materials)

    inspection_date = filters.get("inspection_date")
    if inspection_date and "Inspection_Date" in columns:
        clauses.append(f"try_cast({quote_identifier('Inspection_Date')} as date) = try_cast(? as date)")
        params.append(inspection_date)

    street_water = filters.get("street_water")
    if street_water in {"true", "false"} and "StreetWater" in columns:
        clauses.append(truthy_expression("StreetWater", street_water))

    most_recent = filters.get("most_recent")
    if most_recent in {"true", "false"} and "IS_MOST_RECENT" in columns:
        clauses.append(truthy_expression("IS_MOST_RECENT", most_recent))

    for key, (minimum, maximum) in filters.get("numeric", {}).items():
        column = NUMERIC_FILTER_COLUMNS.get(key)
        if not column or column not in columns:
            continue
        min_value = coerce_float(minimum)
        max_value = coerce_float(maximum)
        if min_value is not None:
            clauses.append(f"try_cast({quote_identifier(column)} as double) >= ?")
            params.append(min_value)
        if max_value is not None:
            clauses.append(f"try_cast({quote_identifier(column)} as double) <= ?")
            params.append(max_value)

    for raw_flag in filters.get("flag", []):
        if ":" not in raw_flag:
            continue
        column, expected = raw_flag.split(":", 1)
        if column in columns and expected in {"true", "false"}:
            clauses.append(truthy_expression(column, expected))

    for raw_filter in filters.get("number_filter", []):
        parts = raw_filter.split(":", 2)
        if len(parts) != 3:
            continue
        column, minimum, maximum = parts
        if column not in columns or column == "geometry":
            continue
        min_value = coerce_float(minimum)
        max_value = coerce_float(maximum)
        if min_value is not None:
            clauses.append(f"try_cast({quote_identifier(column)} as double) >= ?")
            params.append(min_value)
        if max_value is not None:
            clauses.append(f"try_cast({quote_identifier(column)} as double) <= ?")
            params.append(max_value)

    for raw_filter in filters.get("date_filter", []):
        parts = raw_filter.split(":", 2)
        if len(parts) != 3:
            continue
        column, start_date, end_date = parts
        if column not in columns or column == "geometry":
            continue
        if start_date:
            clauses.append(f"try_cast({quote_identifier(column)} as date) >= try_cast(? as date)")
            params.append(start_date)
        if end_date:
            clauses.append(f"try_cast({quote_identifier(column)} as date) <= try_cast(? as date)")
            params.append(end_date)

    for raw_filter in filters.get("text_filter", []):
        if ":" not in raw_filter:
            continue
        column, value = raw_filter.split(":", 1)
        value = value.strip()
        if column not in columns or column == "geometry" or not value:
            continue
        clauses.append(f"cast({quote_identifier(column)} as varchar) ilike ?")
        params.append(f"%{value}%")

    multi_filters: dict[str, list[str]] = {}
    for raw_filter in filters.get("multi_filter", []):
        if ":" not in raw_filter:
            continue
        column, value = raw_filter.split(":", 1)
        if column not in columns or column == "geometry":
            continue
        multi_filters.setdefault(column, []).append(value)

    for column, values in multi_filters.items():
        cleaned_values = [value for value in values if value != ""]
        if not cleaned_values:
            continue
        placeholders = ", ".join("?" for _ in cleaned_values)
        clauses.append(f"cast({quote_identifier(column)} as varchar) in ({placeholders})")
        params.extend(cleaned_values)

    where_sql = f"where {' and '.join(clauses)}" if clauses else ""
    return where_sql, params


def merge_where_clauses(
    where_sql: str,
    params: list[Any],
    extra_clauses: list[str],
    extra_params: list[Any],
) -> tuple[str, list[Any]]:
    if not extra_clauses:
        return where_sql, params

    clauses = []
    if where_sql:
        clauses.append(where_sql.removeprefix("where ").strip())
    clauses.extend(extra_clauses)
    return f"where {' and '.join(clauses)}", [*params, *extra_params]


def history_graph_both_default_filters(columns: set[str], filters: dict[str, Any]) -> tuple[list[str], list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []

    if "INSPECTION_COUNT" in columns:
        count_text = (filters.get("inspection_count") or "").strip()
        count_range = filters.get("numeric", {}).get("inspection_count", ("", ""))
        if not count_text and not any((value or "").strip() for value in count_range):
            clauses.append(f"try_cast({quote_identifier('INSPECTION_COUNT')} as integer) in (3, 4)")

    if "MATERIAL" in columns and not filters.get("material"):
        clauses.append(f"{quote_identifier('MATERIAL')} is not null")

    numeric_filters = filters.get("numeric", {})
    for key, (column, minimum, maximum) in HISTORY_GRAPH_BOTH_DEFAULT_RANGES.items():
        if column not in columns:
            continue
        current_range = numeric_filters.get(key, ("", ""))
        if any((value or "").strip() for value in current_range):
            continue
        clauses.append(f"try_cast({quote_identifier(column)} as double) >= ?")
        params.append(minimum)
        clauses.append(f"try_cast({quote_identifier(column)} as double) <= ?")
        params.append(maximum)

    return clauses, params


def pipe_flag_columns(columns: set[str]) -> list[str]:
    return sorted(
        column
        for column in columns
        if column.startswith("INTERSECTS_") or column.startswith("ZOI_INTERSECTS_")
    )


def table_order_by(sort_column: str, direction: str, columns: set[str]) -> str:
    ordered_columns = [sort_column]
    if sort_column == "FacilityID":
        ordered_columns.extend(["ITPIPE_ASSETID", "INSPECTION_INDEX", "Inspection_Date"])
    elif sort_column == "ITPIPE_ASSETID":
        ordered_columns.extend(["FacilityID", "INSPECTION_INDEX", "Inspection_Date"])

    expressions: list[str] = []
    for index, column in enumerate(ordered_columns):
        if column not in columns:
            continue
        column_direction = direction if index == 0 else "asc"
        expressions.append(f"{quote_identifier(column)} {column_direction} nulls last")

    return ", ".join(expressions) if expressions else "1"


def distinct_values(connection: duckdb.DuckDBPyConnection, table_name: str, column: str, limit: int = 500) -> list[Any]:
    rows = fetch_dicts(
        connection,
        f"""
        select distinct {quote_identifier(column)} as value
        from {table_reference(table_name)}
        where {quote_identifier(column)} is not null
        order by value
        limit ?
        """,
        [limit],
    )
    return [row["value"] for row in rows]


def numeric_range(connection: duckdb.DuckDBPyConnection, table_name: str, column: str) -> dict[str, float | None]:
    row = fetch_one(
        connection,
        f"""
        select
          min(try_cast({quote_identifier(column)} as double)) as min,
          max(try_cast({quote_identifier(column)} as double)) as max
        from {table_reference(table_name)}
        where try_cast({quote_identifier(column)} as double) is not null
        """,
    )
    return {"min": row.get("min"), "max": row.get("max")}


def date_range(connection: duckdb.DuckDBPyConnection, table_name: str, column: str) -> dict[str, str | None]:
    row = fetch_one(
        connection,
        f"""
        select
          cast(min(try_cast({quote_identifier(column)} as date)) as varchar) as min,
          cast(max(try_cast({quote_identifier(column)} as date)) as varchar) as max
        from {table_reference(table_name)}
        where try_cast({quote_identifier(column)} as date) is not null
        """,
    )
    return {"min": row.get("min"), "max": row.get("max")}


@router.get("/source")
def critical_assets_source() -> dict[str, Any]:
    source = critical_assets_data_source()
    connection = critical_assets_connection()
    try:
        data_sources = []
        tables: dict[str, Any] = {}
        metadata_rows = fetch_dicts(
            connection,
            """
            select table_name, record_count, updated_at
            from table_metadata
            where table_name in (?, ?, ?)
            """,
            [source.tables.get("both", ""), source.tables.get("pipes", ""), source.tables.get("structures", "")],
        )
        metadata_by_table = {row["table_name"]: row for row in metadata_rows}

        for source_key, table_name in source.tables.items():
            count_row = fetch_one(connection, f"select count(*) as row_count from {table_reference(table_name)}")
            row_count = int(count_row.get("row_count") or 0)
            columns = table_columns(connection, table_name)
            metadata = metadata_by_table.get(table_name, {})
            imported_at_utc = metadata.get("updated_at") or datetime.now(timezone.utc).isoformat()

            data_sources.append(
                {
                    "table_name": table_name,
                    "source_file": source.workbook,
                    "row_count": row_count,
                    "imported_at_utc": imported_at_utc,
                }
            )
            tables[source_key] = {
                "table_name": table_name,
                "row_count": row_count,
                "columns": columns,
            }

        pipe_columns = available_columns(connection, source.tables["pipes"])
        return {
            "database": str(source.database),
            "data_sources": data_sources,
            "tables": tables,
            "metrics": METRIC_COLUMNS,
            "pipe_flags": pipe_flag_columns(pipe_columns),
        }
    finally:
        connection.close()


@router.get("/summary")
def critical_assets_summary() -> dict[str, Any]:
    source = critical_assets_data_source()
    connection = critical_assets_connection()
    try:
        summaries: dict[str, Any] = {}
        for source_key, table_name in source.tables.items():
            columns = available_columns(connection, table_name)
            metric_selects = []
            for alias, column in (
                ("avg_risk", "RISK"),
                ("avg_condition", "COND_RISK"),
                ("avg_flood", "FLOOD_RISK"),
                ("avg_clog", "CLOG_RISK"),
            ):
                metric_selects.append(
                    f"avg(try_cast({quote_identifier(column)} as double)) as {alias}"
                    if column in columns
                    else f"null as {alias}"
                )

            asset_expression = (
                f"count(distinct {quote_identifier('ITPIPE_ASSETID')}) as asset_count"
                if "ITPIPE_ASSETID" in columns
                else "0 as asset_count"
            )
            facility_expression = (
                f"count(distinct {quote_identifier('FacilityID')}) as facility_count"
                if "FacilityID" in columns
                else "0 as facility_count"
            )
            row = fetch_one(
                connection,
                f"""
                select
                  count(*) as row_count,
                  {facility_expression},
                  {asset_expression},
                  {", ".join(metric_selects)}
                from {table_reference(table_name)}
                """,
            )
            summaries[source_key] = row

        return {"sources": summaries}
    finally:
        connection.close()


@router.get("/filter-options")
def critical_assets_filter_options() -> dict[str, Any]:
    source = critical_assets_data_source()
    connection = critical_assets_connection()
    try:
        options: dict[str, Any] = {}
        for source_key, table_name in source.tables.items():
            columns = available_columns(connection, table_name)
            source_options: dict[str, Any] = {}
            for response_key, column in (
                ("facility_ids", "FacilityID"),
                ("asset_ids", "ITPIPE_ASSETID"),
                ("inspection_counts", "INSPECTION_COUNT"),
                ("materials", "MATERIAL"),
                ("street_water", "StreetWater"),
            ):
                source_options[response_key] = distinct_values(connection, table_name, column) if column in columns else []

            if "Inspection_Date" in columns:
                rows = fetch_dicts(
                    connection,
                    f"""
                    select distinct cast(try_cast({quote_identifier('Inspection_Date')} as date) as varchar) as value
                    from {table_reference(table_name)}
                    where try_cast({quote_identifier('Inspection_Date')} as date) is not null
                    order by value
                    limit 500
                    """,
                )
                source_options["inspection_dates"] = [row["value"] for row in rows]
            else:
                source_options["inspection_dates"] = []

            source_options["numeric_ranges"] = {
                column: numeric_range(connection, table_name, column)
                for column in sorted(TABLE_NUMERIC_COLUMNS)
                if column in columns
            }
            source_options["date_ranges"] = {
                column: date_range(connection, table_name, column)
                for column in ["Inspection_Date"]
                if column in columns
            }
            source_options["checklist_values"] = {
                column: distinct_values(connection, table_name, column, limit=1000)
                for column in sorted(TABLE_CHECKLIST_COLUMNS)
                if column in columns
            }

            options[source_key] = source_options

        pipe_columns = available_columns(connection, source.tables["pipes"])
        return {
            "sources": options,
            "numeric_filters": NUMERIC_FILTER_LABELS,
            "pipe_flags": pipe_flag_columns(pipe_columns),
        }
    finally:
        connection.close()


@router.get("/aggregates/{source_key}/{metric_key}")
def critical_assets_aggregates(
    source_key: str,
    metric_key: str,
    filters: dict[str, Any] = Depends(critical_asset_filters),
    limit: int = Query(default=1000, ge=1, le=5000),
) -> dict[str, Any]:
    source = critical_assets_data_source()
    if metric_key not in METRIC_COLUMNS:
        raise HTTPException(status_code=404, detail={"message": "Unknown critical asset metric.", "metric": metric_key})
    table_name = source_table(source_key, source)
    connection = critical_assets_connection()
    try:
        columns = available_columns(connection, table_name)
        metric_column = METRIC_COLUMNS[metric_key]
        if metric_column not in columns:
            raise HTTPException(
                status_code=404,
                detail={"message": "Metric is not available for this source.", "source": source_key, "metric": metric_key},
            )
        if "FacilityID" not in columns:
            raise HTTPException(status_code=404, detail={"message": "FacilityID is not available for this source."})

        percent_select = (
            f"avg(try_cast({quote_identifier('PERCENT_CONSUMED')} as double)) as avg_percent_consumed"
            if "PERCENT_CONSUMED" in columns
            else "null as avg_percent_consumed"
        )
        pipe_size_select = (
            f"avg(try_cast({quote_identifier('Pipe_Size')} as double)) as avg_pipe_size"
            if "Pipe_Size" in columns
            else "null as avg_pipe_size"
        )
        inspection_count_select = (
            f"max(try_cast({quote_identifier('INSPECTION_COUNT')} as double)) as inspection_count"
            if "INSPECTION_COUNT" in columns
            else "null as inspection_count"
        )
        where_sql, params = build_where_clause(connection, table_name, filters)
        rows = fetch_dicts(
            connection,
            f"""
            select
              cast({quote_identifier('FacilityID')} as varchar) as facility_id,
              count(*) as row_count,
              avg(try_cast({quote_identifier(metric_column)} as double)) as avg_value,
              median(try_cast({quote_identifier(metric_column)} as double)) as median_value,
              max(try_cast({quote_identifier(metric_column)} as double)) as max_value,
              sum(try_cast({quote_identifier(metric_column)} as double)) as sum_value,
              {percent_select},
              {pipe_size_select},
              {inspection_count_select}
            from {table_reference(table_name)}
            {where_sql}
            group by {quote_identifier('FacilityID')}
            order by max_value desc nulls last, avg_value desc nulls last
            limit ?
            """,
            [*params, limit],
        )
        return {"source": source_key, "metric": metric_key, "rows": rows}
    finally:
        connection.close()


@router.get("/history")
def critical_assets_history(
    filters: dict[str, Any] = Depends(critical_asset_filters),
    source_key: str = Query(default="both", alias="source"),
    worksheet: str | None = Query(default=None),
    limit: int = Query(default=2500, ge=1, le=10000),
) -> dict[str, Any]:
    source = critical_assets_data_source()
    table_name = source_table(source_key, source)
    connection = critical_assets_connection()
    try:
        columns = available_columns(connection, table_name)
        desired = PIPE_HISTORY_COLUMNS if source_key == "pipes" else HISTORY_COLUMNS
        visible_columns = selected_columns(columns, desired)
        if not visible_columns:
            return {"source": source_key, "columns": [], "rows": []}

        where_sql, params = build_where_clause(connection, table_name, filters)
        if source_key == "both" and worksheet == "history_graph_both":
            default_clauses, default_params = history_graph_both_default_filters(columns, filters)
            where_sql, params = merge_where_clauses(where_sql, params, default_clauses, default_params)
        order_columns = selected_columns(columns, ["FacilityID", "ITPIPE_ASSETID", "Inspection_Date", "INSPECTION_INDEX"])
        order_sql = ", ".join(quote_identifier(column) for column in order_columns) if order_columns else "1"
        select_sql = ", ".join(quote_identifier(column) for column in visible_columns)
        rows = fetch_dicts(
            connection,
            f"""
            select {select_sql}
            from {table_reference(table_name)}
            {where_sql}
            order by {order_sql}
            limit ?
            """,
            [*params, limit],
        )
        return {"source": source_key, "columns": visible_columns, "rows": rows}
    finally:
        connection.close()


@router.get("/table/{source_key}")
def critical_assets_table(
    source_key: str,
    filters: dict[str, Any] = Depends(critical_asset_filters),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    sort_by: str | None = Query(default=None),
    sort_dir: str = Query(default="asc"),
) -> dict[str, Any]:
    source = critical_assets_data_source()
    table_name = source_table(source_key, source)
    connection = critical_assets_connection()
    try:
        columns = available_columns(connection, table_name)
        desired_columns = TABLEAU_HISTORY_PIPES_TABLE_COLUMNS if source_key == "pipes" else TABLEAU_HISTORY_BOTH_TABLE_COLUMNS
        visible_columns = selected_columns(columns, desired_columns)
        if not visible_columns:
            fallback_columns = PIPE_DETAIL_COLUMNS if source_key == "pipes" else BASE_DETAIL_COLUMNS
            visible_columns = selected_columns(columns, [*fallback_columns, *pipe_flag_columns(columns)])
        if not visible_columns:
            visible_columns = [column for column in sorted(columns) if column != "geometry"][:40]

        where_sql, params = build_where_clause(connection, table_name, filters)
        total = int(
            fetch_one(connection, f"select count(*) as total from {table_reference(table_name)} {where_sql}", params).get("total")
            or 0
        )

        sort_column = sort_by if sort_by in columns and sort_by != "geometry" else visible_columns[0]
        direction = "desc" if sort_dir.lower() == "desc" else "asc"
        order_sql = table_order_by(sort_column, direction, columns)
        select_sql = ", ".join(quote_identifier(column) for column in visible_columns)
        rows = fetch_dicts(
            connection,
            f"""
            select {select_sql}
            from {table_reference(table_name)}
            {where_sql}
            order by {order_sql}
            limit ? offset ?
            """,
            [*params, limit, offset],
        )

        return {
            "source": source_key,
            "columns": visible_columns,
            "total": total,
            "limit": limit,
            "offset": offset,
            "rows": rows,
        }
    finally:
        connection.close()
