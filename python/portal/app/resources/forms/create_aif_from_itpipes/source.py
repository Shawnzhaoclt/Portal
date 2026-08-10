from __future__ import annotations

import os
import re
from contextlib import closing
from pathlib import Path
from typing import Any, Iterable

import duckdb

from portal.runtime.transport import HTTPException

from portal.app.core.records import clean_record


IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
NUMERIC_IDENTIFIER_PATTERN = re.compile(r"^([+-]?\d+)\.0+$")
ASSET_COLUMN_CANDIDATES = (
    "Asset_ID",
    "ASSET_ID",
    "AssetID",
    "ENTITY_UID",
    "EntityUID",
    "ITPIPE_ASSETID",
    "ITPIPES_ASSET_ID",
    "Pipe_ID",
    "PIPE_ID",
    "FacilityID",
    "FACILITY_ID",
    "ML_ID",
)


def _configured_path(name: str, label: str) -> Path:
    value = str(os.getenv(name) or "").strip()
    if not value:
        raise HTTPException(status_code=503, detail=f"{label} is not configured for Create AIF from ITPipes.")
    path = Path(value).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"The configured {label} is unavailable.")
    return path


def _configured_table(name: str, label: str) -> str:
    value = str(os.getenv(name) or "").strip()
    if not value:
        raise HTTPException(status_code=503, detail=f"{label} is not configured for Create AIF from ITPipes.")
    if not IDENTIFIER_PATTERN.fullmatch(value):
        raise HTTPException(status_code=503, detail=f"The configured {label} is not a valid SQL identifier.")
    return value


def _configured_optional_table(name: str, label: str) -> str | None:
    value = str(os.getenv(name) or "").strip()
    if not value:
        return None
    if not IDENTIFIER_PATTERN.fullmatch(value):
        raise HTTPException(status_code=503, detail=f"The configured {label} is not a valid SQL identifier.")
    return value


def _connect(path: Path, label: str) -> duckdb.DuckDBPyConnection:
    try:
        return duckdb.connect(str(path), read_only=True)
    except (duckdb.Error, OSError) as error:
        raise HTTPException(
            status_code=503,
            detail=f"The {label} is currently unavailable or locked. Close any conflicting database session and retry.",
        ) from error


def _quote(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _column_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def _normalize_inspection_direction(value: object) -> int | None:
    """Convert ITPipes direction labels to the Portal's stable 0/1 codes."""
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = None
    if numeric in (0.0, 1.0):
        return int(numeric)

    normalized = _column_key(str(value))
    if normalized in {"downstream", "upstreamtodownstream", "ustods", "us2ds"}:
        return 1
    if normalized in {"upstream", "downstreamtoupstream", "dstous", "ds2us"}:
        return 0
    return None


def normalize_source_identifier(value: object) -> str:
    """Return stable text for source IDs that DuckDB may expose as numbers."""
    if value is None:
        return ""
    text = str(value).strip()
    numeric = NUMERIC_IDENTIFIER_PATTERN.fullmatch(text)
    return numeric.group(1) if numeric else text


def _identifier_query_values(value: object) -> list[str]:
    canonical = normalize_source_identifier(value)
    if not canonical:
        return []
    values = [canonical]
    if re.fullmatch(r"[+-]?\d+", canonical):
        values.append(f"{canonical}.0")
    return values


def _identifier_query_values_many(values: Iterable[object]) -> list[str]:
    """Return all stable SQL text representations for numeric-backed source IDs."""
    return list(
        dict.fromkeys(
            query_value
            for value in values
            for query_value in _identifier_query_values(value)
        )
    )


def _columns(connection: duckdb.DuckDBPyConnection, table: str) -> dict[str, str]:
    rows = connection.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE lower(table_schema) = 'main' AND lower(table_name) = lower(?)
        ORDER BY ordinal_position
        """,
        [table],
    ).fetchall()
    if not rows:
        raise HTTPException(status_code=503, detail=f"The configured source table {table} was not found.")
    return {_column_key(str(row[0])): str(row[0]) for row in rows}


def _first(columns: dict[str, str], candidates: Iterable[str], label: str, *, required: bool = False) -> str | None:
    for candidate in candidates:
        value = columns.get(_column_key(candidate))
        if value:
            return value
    if required:
        raise HTTPException(status_code=503, detail=f"The source schema is missing required column {label}.")
    return None


def _select(column: str | None, alias: str) -> str:
    return f'{_quote(column)} AS {_quote(alias)}' if column else f'NULL AS {_quote(alias)}'


def _fetch(connection: duckdb.DuckDBPyConnection, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    cursor = connection.execute(sql, params or [])
    names = [item[0] for item in cursor.description]
    return [clean_record(dict(zip(names, row))) for row in cursor.fetchall()]


def _observation_parent_map(
    config: dict[str, Any],
    mli_id: object,
    mlo_ids: Iterable[object],
) -> dict[str, str]:
    """Load globally unique canonical MLO -> MLI relationships from production."""
    requested_mli_id = normalize_source_identifier(mli_id)
    requested_mlo_ids = {
        normalized
        for value in mlo_ids
        if (normalized := normalize_source_identifier(value))
    }
    query_values = _identifier_query_values_many(requested_mlo_ids)
    if not query_values:
        return {}
    with closing(_connect(config["production_database"], "ITPipes production database")) as production:
        columns = _columns(production, config["observation_table"])
        mlo_column = _first(columns, ("MLO_ID",), "MLO.MLO_ID", required=True)
        mli_column = _first(columns, ("MLI_ID",), "MLO.MLI_ID", required=True)
        placeholders = ", ".join("?" for _ in query_values)
        rows = _fetch(
            production,
            f"SELECT {_quote(str(mlo_column))} AS mlo_id, {_quote(str(mli_column))} AS mli_id "
            f"FROM {_quote(config['observation_table'])} "
            f"WHERE trim(cast({_quote(str(mlo_column))} AS VARCHAR)) IN ({placeholders})",
            query_values,
        )
    parents: dict[str, str] = {}
    for row in rows:
        mlo_id = normalize_source_identifier(row.get("mlo_id"))
        parent_mli_id = normalize_source_identifier(row.get("mli_id"))
        if not mlo_id or mlo_id not in requested_mlo_ids:
            continue
        if mlo_id in parents:
            raise HTTPException(
                status_code=503,
                detail=f"ITPipes source integrity error: MLO_ID {mlo_id} is duplicated in the production MLO table.",
            )
        parents[mlo_id] = parent_mli_id
    wrong_parent = next(
        (
            (mlo_id, parent_mli_id)
            for mlo_id, parent_mli_id in parents.items()
            if parent_mli_id != requested_mli_id
        ),
        None,
    )
    if wrong_parent:
        raise HTTPException(
            status_code=503,
            detail=(
                f"ITPipes source integrity error: MLO_ID {wrong_parent[0]} belongs to "
                f"MLI_ID {wrong_parent[1] or 'null'}, not selected MLI_ID {requested_mli_id}."
            ),
        )
    return parents


def _source_configuration() -> dict[str, Any]:
    return {
        "merged_database": _configured_path("PORTAL_AIF_ITPIPES_INTERMEDIATE_DATABASE", "ITPipes intermediate database"),
        "production_database": _configured_path("PORTAL_AIF_ITPIPES_PRODUCTION_DATABASE", "ITPipes production database"),
        "cityworks_database": _configured_path("PORTAL_AIF_CITYWORKS_INTERMEDIATE_DATABASE", "Cityworks inspection-history database"),
        "defects_table": _configured_table("PORTAL_AIF_ITPIPES_DEFECTS_TABLE", "ITPipes defects table"),
        "maximum_condition_table": _configured_optional_table(
            "PORTAL_AIF_ITPIPES_MAXIMUM_CONDITION_TABLE",
            "ITPipes maximum-condition table",
        ),
        "inspection_table": _configured_table("PORTAL_AIF_ITPIPES_INSPECTION_TABLE", "ITPipes inspection table"),
        "observation_table": _configured_table("PORTAL_AIF_ITPIPES_OBSERVATION_TABLE", "ITPipes observation table"),
        "cityworks_table": _configured_table("PORTAL_AIF_CITYWORKS_HISTORY_TABLE", "Cityworks inspection-history table"),
    }


def _asset_columns(columns: dict[str, str]) -> list[str]:
    matches: list[str] = []
    for candidate in ASSET_COLUMN_CANDIDATES:
        value = columns.get(_column_key(candidate))
        if value and value not in matches:
            matches.append(value)
    if not matches:
        raise HTTPException(status_code=503, detail="The ITPipes defects source has no approved Asset ID column.")
    return matches


def _asset_where(asset_columns: list[str]) -> str:
    return "(" + " OR ".join(
        f"upper(trim(cast({_quote(column)} AS VARCHAR))) = ?" for column in asset_columns
    ) + ")"


def list_asset_candidates(query: str, *, limit: int = 10) -> list[str]:
    normalized = query.strip().upper()
    if not normalized:
        return []
    safe_limit = max(1, min(int(limit), 10))
    config = _source_configuration()
    with closing(_connect(config["merged_database"], "ITPipes intermediate database")) as connection:
        columns = _columns(connection, config["defects_table"])
        asset_columns = _asset_columns(columns)
        candidate_queries = []
        parameters: list[Any] = []
        for column in asset_columns:
            normalized_column = f"upper(trim(cast({_quote(column)} AS VARCHAR)))"
            candidate_queries.append(
                f"SELECT {normalized_column} AS asset_id FROM {_quote(config['defects_table'])} "
                f"WHERE {_quote(column)} IS NOT NULL AND strpos({normalized_column}, ?) > 0"
            )
            parameters.append(normalized)
        rows = _fetch(
            connection,
            "WITH candidates AS (" + " UNION ALL ".join(candidate_queries) + ") "
            "SELECT DISTINCT asset_id FROM candidates WHERE asset_id <> '' "
            "ORDER BY CASE WHEN asset_id = ? THEN 0 WHEN strpos(asset_id, ?) = 1 THEN 1 ELSE 2 END, "
            "length(asset_id), asset_id LIMIT ?",
            [*parameters, normalized, normalized, safe_limit],
        )
    return [str(row["asset_id"]) for row in rows]


def verify_source_schema() -> dict[str, Any]:
    config = _source_configuration()
    with closing(_connect(config["merged_database"], "ITPipes intermediate database")) as merged:
        defect_columns = _columns(merged, config["defects_table"])
        _first(defect_columns, ("MLI_ID",), "MLI_ID", required=True)
        _first(defect_columns, ("MLO_ID",), "MLO_ID", required=True)
        asset_columns = _asset_columns(defect_columns)
        for candidates, label in (
            (("Inspection_Direction", "Inspection Direction"), "Inspection_Direction"),
            (("US_ASSETID", "US_ASSET_ID"), "US_ASSETID"),
            (("DS_ASSETID", "DS_ASSET_ID"), "DS_ASSETID"),
            (("COND_RISK", "CONDITION_RISK"), "COND_RISK"),
            (("Flooding_Impact",), "Flooding_Impact"),
            (("Flooding_Service_Eligibility",), "Flooding_Service_Eligibility"),
            (("Flooding_Design_Standards",), "Flooding_Design_Standards"),
            (("OBS_SE",), "OBS_SE"),
            (("OBS_CL",), "OBS_CL"),
            (("OBS_CL_ZOI", "OBS_CL_ZOL"), "OBS_CL_ZOI"),
            (("VCR_Time", "VCR Time"), "VCR_Time"),
            (("Distance", "Stationing", "DISTANCE_FEET"), "source stationing"),
        ):
            _first(defect_columns, candidates, label, required=True)
        maximum_condition_table = config.get("maximum_condition_table")
        if maximum_condition_table:
            maximum_columns = _columns(merged, str(maximum_condition_table))
            _first(maximum_columns, ("MLI_ID",), "maximum-condition MLI_ID", required=True)
            _first(maximum_columns, ("MLO_ID",), "maximum-condition MLO_ID", required=True)
    with closing(_connect(config["production_database"], "ITPipes production database")) as production:
        inspection_columns = _columns(production, config["inspection_table"])
        _first(inspection_columns, ("MLI_ID",), "MLI.MLI_ID", required=True)
        _first(inspection_columns, ("Inspection_Date", "Inspection Date", "InspectionDate"), "MLI.Inspection_Date", required=True)
        observation_columns = _columns(production, config["observation_table"])
        _first(observation_columns, ("MLO_ID",), "MLO.MLO_ID", required=True)
        _first(observation_columns, ("MLI_ID",), "MLO.MLI_ID", required=True)
    with closing(_connect(config["cityworks_database"], "Cityworks inspection-history database")) as cityworks:
        cityworks_columns = _columns(cityworks, config["cityworks_table"])
        cityworks_asset_columns = _asset_columns(cityworks_columns)
        _first(
            cityworks_columns,
            ("INSPECTION_ID", "InspectionID", "INSPID", "ACTIVITYSID"),
            "Cityworks inspection ID",
            required=True,
        )
        _first(
            cityworks_columns,
            ("INSPECTION_DATE", "DATEINSP", "Date_Initiated", "DATE_INITIATED"),
            "Cityworks inspection date",
            required=True,
        )
    intermediate_tables = [config["defects_table"]]
    if config.get("maximum_condition_table"):
        intermediate_tables.append(config["maximum_condition_table"])
    return {
        "healthy": True,
        "asset_columns": asset_columns,
        "cityworks_asset_columns": cityworks_asset_columns,
        "inspection_date_authority": "MLI.Inspection_Date",
        "source_tables": {
            "itpipes_intermediate": intermediate_tables,
            "itpipes_production": [config["inspection_table"], config["observation_table"]],
            "cityworks_intermediate": [config["cityworks_table"]],
        },
    }


def search_asset(asset_id: str) -> dict[str, Any]:
    normalized = asset_id.strip().upper()
    if not normalized:
        raise HTTPException(status_code=422, detail="Asset ID is required.")
    config = _source_configuration()
    with closing(_connect(config["merged_database"], "ITPipes intermediate database")) as merged:
        columns = _columns(merged, config["defects_table"])
        mli_column = _first(columns, ("MLI_ID",), "MLI_ID", required=True)
        asset_columns = _asset_columns(columns)
        where = _asset_where(asset_columns)
        mli_rows = _fetch(
            merged,
            f"SELECT DISTINCT cast({_quote(str(mli_column))} AS VARCHAR) AS mli_id "
            f"FROM {_quote(config['defects_table'])} WHERE {where} AND {_quote(str(mli_column))} IS NOT NULL",
            [normalized] * len(asset_columns),
        )
        mli_ids = list(
            dict.fromkeys(
                mli_id
                for row in mli_rows
                if (mli_id := normalize_source_identifier(row.get("mli_id")))
            )
        )
        if not mli_ids:
            return {"asset_id": normalized, "inspections": []}
        query_values = _identifier_query_values_many(mli_ids)
        placeholders = ", ".join("?" for _ in query_values)
        mlo_column = _first(columns, ("MLO_ID",), "MLO_ID", required=True)
        count_rows = _fetch(
            merged,
            f"SELECT cast({_quote(str(mli_column))} AS VARCHAR) AS mli_id, "
            f"cast({_quote(str(mlo_column))} AS VARCHAR) AS mlo_id "
            f"FROM {_quote(config['defects_table'])} "
            f"WHERE trim(cast({_quote(str(mli_column))} AS VARCHAR)) IN ({placeholders}) "
            f"AND {_quote(str(mlo_column))} IS NOT NULL",
            query_values,
        )
        observations_by_inspection: dict[str, set[str]] = {}
        for row in count_rows:
            canonical_mli = normalize_source_identifier(row.get("mli_id"))
            canonical_mlo = normalize_source_identifier(row.get("mlo_id"))
            if canonical_mli and canonical_mlo:
                observations_by_inspection.setdefault(canonical_mli, set()).add(canonical_mlo)
        counts = {key: len(value) for key, value in observations_by_inspection.items()}
    with closing(_connect(config["production_database"], "ITPipes production database")) as production:
        columns = _columns(production, config["inspection_table"])
        mli_column = _first(columns, ("MLI_ID",), "MLI.MLI_ID", required=True)
        date_column = _first(columns, ("Inspection_Date", "Inspection Date", "InspectionDate"), "MLI.Inspection_Date", required=True)
        direction_column = _first(columns, ("Inspection_Direction", "Inspection Direction"), "MLI.Inspection_Direction")
        rows = _fetch(
            production,
            f"SELECT cast({_quote(str(mli_column))} AS VARCHAR) AS mli_id, "
            f"{_select(date_column, 'inspection_date')}, {_select(direction_column, 'inspection_direction')} "
            f"FROM {_quote(config['inspection_table'])} "
            f"WHERE trim(cast({_quote(str(mli_column))} AS VARCHAR)) IN ({placeholders}) "
            f"ORDER BY try_cast({_quote(str(date_column))} AS TIMESTAMP) DESC NULLS LAST, cast({_quote(str(mli_column))} AS VARCHAR)",
            query_values,
        )
    seen: set[str] = set()
    inspections = []
    for row in rows:
        mli_id = normalize_source_identifier(row.get("mli_id"))
        if not mli_id or mli_id in seen:
            continue
        seen.add(mli_id)
        inspections.append(
            {
                **row,
                "mli_id": mli_id,
                "inspection_direction": _normalize_inspection_direction(row.get("inspection_direction")),
                "observation_count": counts.get(mli_id, 0),
            }
        )
    return {"asset_id": normalized, "inspections": inspections}


def list_observations(asset_id: str, mli_id: str) -> dict[str, Any]:
    mli_id = normalize_source_identifier(mli_id)
    search = search_asset(asset_id)
    inspection = next(
        (item for item in search["inspections"] if normalize_source_identifier(item["mli_id"]) == mli_id),
        None,
    )
    if inspection is None:
        raise HTTPException(status_code=404, detail="The selected ITPipes inspection does not belong to this asset.")
    config = _source_configuration()
    with closing(_connect(config["merged_database"], "ITPipes intermediate database")) as connection:
        columns = _columns(connection, config["defects_table"])
        aliases = {
            "mlo_id": _first(columns, ("MLO_ID",), "MLO_ID", required=True),
            "mli_id": _first(columns, ("MLI_ID",), "MLI_ID", required=True),
            "inspection_direction": _first(columns, ("Inspection_Direction", "Inspection Direction"), "Inspection_Direction"),
            "us_asset_id": _first(columns, ("US_ASSETID", "US_ASSET_ID"), "US_ASSETID"),
            "ds_asset_id": _first(columns, ("DS_ASSETID", "DS_ASSET_ID"), "DS_ASSETID"),
            "condition_risk": _first(columns, ("COND_RISK", "CONDITION_RISK"), "COND_RISK"),
            "flooding_impact": _first(columns, ("Flooding_Impact",), "Flooding_Impact"),
            "flooding_service_eligibility": _first(columns, ("Flooding_Service_Eligibility",), "Flooding_Service_Eligibility"),
            "flooding_design_standards": _first(columns, ("Flooding_Design_Standards",), "Flooding_Design_Standards"),
            "service_eligibility": _first(columns, ("OBS_SE",), "OBS_SE"),
            "consequence_location": _first(columns, ("OBS_CL",), "OBS_CL"),
            "consequence_location_zol": _first(columns, ("OBS_CL_ZOI", "OBS_CL_ZOL"), "OBS_CL_ZOI"),
            "vcr_time": _first(columns, ("VCR_Time", "VCR Time"), "VCR_Time"),
            "stationing": _first(columns, ("Distance", "Stationing", "DISTANCE_FEET"), "source stationing"),
        }
        mli_column = str(aliases["mli_id"])
        mlo_column = str(aliases["mlo_id"])
        query_values = _identifier_query_values(mli_id)
        placeholders = ", ".join("?" for _ in query_values)
        select_sql = ", ".join(_select(column, alias) for alias, column in aliases.items())
        risk_order = f"try_cast({_quote(str(aliases['condition_risk']))} AS DOUBLE) DESC NULLS LAST" if aliases["condition_risk"] else "NULL"
        station_order = f"try_cast({_quote(str(aliases['stationing']))} AS DOUBLE) ASC NULLS LAST" if aliases["stationing"] else "NULL"
        rows = _fetch(
            connection,
            f"SELECT {select_sql} FROM {_quote(config['defects_table'])} "
            f"WHERE trim(cast({_quote(mli_column)} AS VARCHAR)) IN ({placeholders}) "
            f"ORDER BY {risk_order}, {station_order}, cast({_quote(mlo_column)} AS VARCHAR)",
            query_values,
        )
    seen_mlo_ids: set[str] = set()
    for row in rows:
        source_mlo_id = normalize_source_identifier(row.get("mlo_id"))
        if not source_mlo_id:
            raise HTTPException(status_code=503, detail="ITPipes source integrity error: an observation has no MLO_ID.")
        if source_mlo_id in seen_mlo_ids:
            raise HTTPException(
                status_code=503,
                detail=f"ITPipes source integrity error: MLO_ID {source_mlo_id} is duplicated in the merged source.",
            )
        seen_mlo_ids.add(source_mlo_id)
    parent_map = _observation_parent_map(config, mli_id, seen_mlo_ids)
    for row in rows:
        source_mlo_id = normalize_source_identifier(row.get("mlo_id"))
        source_mli_id = normalize_source_identifier(row.get("mli_id"))
        parent_mli_id = parent_map.get(source_mlo_id)
        if parent_mli_id is None:
            raise HTTPException(
                status_code=503,
                detail=f"ITPipes source integrity error: MLO_ID {source_mlo_id} has no parent MLI_ID in the production MLO table.",
            )
        if source_mli_id != parent_mli_id:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"ITPipes source integrity error: MLO_ID {source_mlo_id} is associated with MLI_ID "
                    f"{source_mli_id or 'null'} in the merged source but MLI_ID {parent_mli_id} in the production MLO table."
                ),
            )
        row["mlo_id"] = source_mlo_id
        row["mli_id"] = parent_mli_id
        row["inspection_direction"] = _normalize_inspection_direction(row.get("inspection_direction"))
    return {
        "asset_id": search["asset_id"],
        "inspection": inspection,
        "source_inspection_date": inspection.get("inspection_date"),
        "observations": rows,
    }


def cityworks_history(asset_id: str) -> list[dict[str, Any]]:
    normalized = asset_id.strip().upper()
    config = _source_configuration()
    with closing(_connect(config["cityworks_database"], "Cityworks inspection-history database")) as connection:
        columns = _columns(connection, config["cityworks_table"])
        asset_columns = _asset_columns(columns)
        inspection_id = _first(columns, ("INSPECTION_ID", "InspectionID", "INSPID", "ACTIVITYSID"), "Cityworks inspection ID", required=True)
        inspection_date = _first(columns, ("INSPECTION_DATE", "DATEINSP", "Date_Initiated", "DATE_INITIATED"), "Cityworks inspection date")
        status = _first(columns, ("STATUS", "Inspection_Status"), "Cityworks status")
        inspector = _first(
            columns,
            ("INSPECTED_BY", "INSPECTOR", "investigator", "INVESTIGATEDBY", "INITIATED_BY", "SUBMITTED_BY"),
            "Cityworks inspector",
        )
        rows = _fetch(
            connection,
            f"SELECT {_select(inspection_id, 'inspection_id')}, {_select(inspection_date, 'inspection_date')}, "
            f"{_select(status, 'status')}, {_select(inspector, 'actor')} "
            f"FROM {_quote(config['cityworks_table'])} WHERE {_asset_where(asset_columns)} "
            f"ORDER BY try_cast({_quote(str(inspection_date))} AS TIMESTAMP) DESC NULLS LAST LIMIT 250",
            [normalized] * len(asset_columns),
        )
    return [
        {
            **row,
            "inspection_id": normalize_source_identifier(row.get("inspection_id")),
            "source": "Cityworks",
        }
        for row in rows
    ]
