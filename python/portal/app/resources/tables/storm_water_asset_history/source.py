from __future__ import annotations

import math
import re
from contextlib import closing
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import duckdb

from portal.app.core.desktop_config import configured_asset_history
from portal.app.core.source_cache import source_info
from portal.runtime.transport import HTTPException


IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
NUMERIC_ID = re.compile(r"^([+-]?\d+)\.0+$")
ASSET_TYPES = {"structure", "pipe", "channel"}


def _calendar_date(value: Any) -> Any:
    if isinstance(value, datetime):
        normalized = value.astimezone(timezone.utc) if value.tzinfo is not None else value
        return normalized.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        text = value.strip()
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return value
        normalized = parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else parsed
        return normalized.date().isoformat()
    return value

TIMELINE_DATE_FIELDS: dict[str, tuple[tuple[str, str], ...]] = {
    "service_request": (
        ("DATETIMEINIT", "Created"),
        ("DATESUBMITTO", "Submitted"),
        ("DATEINVTDONE", "Investigation completed"),
        ("PRJCOMPLETEDATE", "Project completed"),
        ("DATETIMECLOSED", "Closed"),
        ("DATECANCELLED", "Cancelled"),
    ),
    "investigation": (
        ("INITIATEDATE", "Initiated"),
        ("DATESUBMITTO", "Submitted"),
        ("INSPDATE", "Inspection performed"),
        ("PRJSTARTDATE", "Planned start"),
        ("PRJFINISHDATE", "Planned finish"),
        ("ACTFINISHDATE", "Actually finished"),
        ("DATECLOSED", "Closed"),
        ("DATECANCELLED", "Cancelled"),
    ),
    "inspection": (
        ("INITIATEDATE", "Initiated"),
        ("DATESUBMITTO", "Submitted"),
        ("INSPDATE", "Inspection performed"),
        ("PRJSTARTDATE", "Planned start"),
        ("PRJFINISHDATE", "Planned finish"),
        ("ACTFINISHDATE", "Actually finished"),
        ("DATECLOSED", "Closed"),
        ("DATECANCELLED", "Cancelled"),
    ),
    "work_order": (
        ("INITIATEDATE", "Initiated"),
        ("DATESUBMITTO", "Submitted"),
        ("PROJSTARTDATE", "Planned start"),
        ("ACTUALSTARTDATE", "Started"),
        ("PROJFINISHDATE", "Planned finish"),
        ("ACTUALFINISHDATE", "Finished"),
        ("DATEWOCLOSED", "Closed"),
    ),
}


def _id(value: Any) -> str:
    text = str(value or "").strip()
    match = NUMERIC_ID.fullmatch(text)
    return match.group(1) if match else text


def _json(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return f"Binary value ({len(value):,} bytes)"
    return value


def _sort_number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("-inf")


def _timeline_timestamp(value: Any) -> str:
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat()
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time()).isoformat()
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text:
        return ""
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).replace(microsecond=0).isoformat()
    except ValueError:
        return ""


def timeline_events(
    history: dict[str, list[dict[str, Any]]],
    asset: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Expand activity records and the inventory construction date into lifecycle events."""

    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
    for records in history.values():
        for record in records:
            kind = str(record.get("kind") or "")
            record_id = _id(record.get("record_id"))
            attributes = record.get("source_attributes") or {}
            for field, label in TIMELINE_DATE_FIELDS.get(kind, ()):
                timestamp = _timeline_timestamp(attributes.get(field))
                if not timestamp:
                    continue
                key = (kind, record_id, timestamp)
                event = grouped.get(key)
                if event is None:
                    event = dict(record)
                    event.update({
                        "event_date": timestamp,
                        "event_name": label,
                        "event_field": field,
                        "event_fields": [field],
                        "event_names": [label],
                    })
                    grouped[key] = event
                else:
                    event["event_fields"].append(field)
                    event["event_names"].append(label)
                    event["event_field"] = ", ".join(event["event_fields"])
                    event["event_name"] = " · ".join(event["event_names"])
    if asset:
        construction_timestamp = _timeline_timestamp(asset.get("construction_date"))
        if construction_timestamp:
            asset_id = _id(asset.get("asset_id"))
            field = str(asset.get("construction_date_field") or "CONST_DATE")
            grouped[("asset", asset_id, construction_timestamp)] = {
                "kind": "asset",
                "record_id": asset_id,
                "event_date": construction_timestamp,
                "status": asset.get("status"),
                "title": f"{str(asset.get('asset_type') or 'asset').title()} constructed",
                "summary": None,
                "person": None,
                "relationship": "Inventory record",
                "related_id": None,
                "source_attributes": dict(asset.get("all_fields") or {}),
                "event_name": "Constructed",
                "event_field": field,
                "event_fields": [field],
                "event_names": ["Constructed"],
            }
    events = list(grouped.values())
    for event in events:
        event["event_key"] = ":".join((
            str(event.get("kind") or ""),
            str(event.get("record_id") or ""),
            str(event.get("event_date") or ""),
            str(event.get("event_field") or ""),
        ))
    events.sort(
        key=lambda item: (str(item.get("event_date") or ""), str(item.get("record_id") or ""), str(item.get("event_name") or "")),
        reverse=True,
    )
    return events


def _record(columns: Iterable[str], row: Iterable[Any]) -> dict[str, Any]:
    return {str(key): _json(value) for key, value in zip(columns, row)}


def _rows(cursor: Any) -> list[dict[str, Any]]:
    columns = [item[0] for item in cursor.description]
    return [_record(columns, row) for row in cursor.fetchall()]


def _quote(identifier: str) -> str:
    if not IDENTIFIER.fullmatch(str(identifier or "")):
        raise HTTPException(status_code=503, detail="Asset History contains an invalid configured SQL identifier.")
    return f'"{identifier}"'


def _config() -> dict[str, Any]:
    try:
        return configured_asset_history()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def _source(config: dict[str, Any], key: str) -> tuple[str, Path]:
    item = config["sources"][key]
    path = Path(str(item["database"])).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"The active Asset History {key} source is unavailable.")
    return str(item["sourceId"]), path


def _connect(path: Path) -> duckdb.DuckDBPyConnection:
    try:
        return duckdb.connect(str(path), read_only=True)
    except (duckdb.Error, OSError) as error:
        raise HTTPException(status_code=503, detail=f"Could not open the read-only Asset History source {path.name}.") from error


def _columns(connection: duckdb.DuckDBPyConnection, table: str) -> list[str]:
    try:
        return [str(row[0]) for row in connection.execute(f"DESCRIBE {_quote(table)}").fetchall()]
    except duckdb.Error as error:
        raise HTTPException(status_code=503, detail=f"Required Asset History table {table} was not found.") from error


def _column(columns: Iterable[str], *candidates: str) -> str | None:
    lookup = {str(value).casefold(): str(value) for value in columns}
    for candidate in candidates:
        if candidate.casefold() in lookup:
            return lookup[candidate.casefold()]
    return None


def _in(values: Iterable[str]) -> tuple[str, list[str]]:
    normalized = sorted({_id(value) for value in values if _id(value)})
    return (", ".join("?" for _ in normalized) or "NULL", normalized)


def source_status() -> dict[str, Any]:
    config = _config()
    result: dict[str, Any] = {}
    for key in ("inventory", "step401", "cityworks", "cityworksRisk", "itpipesIntermediate", "itpipesProduction", "priorityPipes"):
        item = config["sources"][key]
        source_id = str(item["sourceId"])
        metadata = source_info(source_id)
        path = Path(str(item["database"]))
        result[key] = {
            "source_id": source_id,
            "available": path.is_file(),
            "version": str(metadata.get("version") or ""),
            "published_at": metadata.get("publishedAt") or metadata.get("publicationTimestamp"),
        }
    return result


def _asset_definition(config: dict[str, Any], asset_type: str) -> dict[str, str]:
    normalized = str(asset_type or "").strip().casefold()
    if normalized not in ASSET_TYPES:
        raise HTTPException(status_code=422, detail="Asset type must be structure, pipe, or channel.")
    raw = config.get("inventoryTables", {}).get(normalized)
    if not isinstance(raw, dict):
        raise HTTPException(status_code=503, detail=f"Asset History inventory table for {normalized} is not configured.")
    return {
        key: str(raw.get(key) or "").strip()
        for key in ("table", "idField", "entityType", "constructionDateField")
    }


def search_assets(query: str, limit: int = 10) -> list[dict[str, Any]]:
    text = str(query or "").strip()
    if len(text) < 2:
        return []
    config = _config()
    _, path = _source(config, "inventory")
    matches: list[dict[str, Any]] = []
    with closing(_connect(path)) as connection:
        for asset_type in ("structure", "pipe", "channel"):
            definition = _asset_definition(config, asset_type)
            table = definition["table"]
            id_field = definition["idField"]
            columns = _columns(connection, table)
            display = [
                name for name in (
                    _column(columns, "Location", "ADDRESS", "FACILITYADDRESS"),
                    _column(columns, "Active", "STATUS"),
                    _column(columns, "MATERIAL", "CH_MAT"),
                    _column(columns, "DIAMETER", "STRUCTURE_SIZE", "WIDTH"),
                    _column(columns, "US_ASSETID", "US_ID"),
                    _column(columns, "DS_ASSETID", "DS_ID"),
                ) if name
            ]
            selected = ", ".join([_quote(id_field), *(_quote(name) for name in display)])
            sql = f"""
                SELECT {selected},
                       CASE
                         WHEN lower(CAST({_quote(id_field)} AS VARCHAR)) = lower(?) THEN 0
                         WHEN lower(CAST({_quote(id_field)} AS VARCHAR)) LIKE lower(?) THEN 1
                         WHEN lower(CAST({_quote(id_field)} AS VARCHAR)) LIKE lower(?) THEN 2
                         ELSE 3
                       END AS match_rank
                FROM {_quote(table)}
                WHERE lower(CAST({_quote(id_field)} AS VARCHAR)) LIKE lower(?)
                ORDER BY match_rank, length(CAST({_quote(id_field)} AS VARCHAR)), {_quote(id_field)}
                LIMIT ?
            """
            params = [text, f"{text}%", f"%{text}%", f"%{text}%", limit]
            for row in _rows(connection.execute(sql, params)):
                asset_id = _id(row.get(id_field))
                properties = {name: row.get(name) for name in display if row.get(name) not in (None, "")}
                subtitle_parts = [str(value) for value in properties.values() if value not in (None, "")][:3]
                matches.append({
                    "asset_id": asset_id,
                    "asset_type": asset_type,
                    "label": asset_id,
                    "subtitle": " | ".join(subtitle_parts) or asset_type.title(),
                    "status": properties.get(_column(display, "Active", "STATUS") or ""),
                    "match_rank": int(row.get("match_rank") or 0),
                })
        if not matches and len(text) >= 4:
            for asset_type in ("structure", "pipe", "channel"):
                definition = _asset_definition(config, asset_type)
                table = definition["table"]
                id_field = definition["idField"]
                columns = _columns(connection, table)
                display = [name for name in (
                    _column(columns, "Location", "ADDRESS", "FACILITYADDRESS"),
                    _column(columns, "Active", "STATUS"),
                    _column(columns, "MATERIAL", "CH_MAT"),
                    _column(columns, "DIAMETER", "STRUCTURE_SIZE", "WIDTH"),
                    _column(columns, "US_ASSETID", "US_ID"),
                    _column(columns, "DS_ASSETID", "DS_ID"),
                ) if name]
                selected = ", ".join([_quote(id_field), *(_quote(name) for name in display)])
                fuzzy = _rows(connection.execute(
                    f"SELECT {selected}, 3 AS match_rank FROM {_quote(table)} WHERE levenshtein(lower(CAST({_quote(id_field)} AS VARCHAR)), lower(?)) <= 2 ORDER BY levenshtein(lower(CAST({_quote(id_field)} AS VARCHAR)), lower(?)), length(CAST({_quote(id_field)} AS VARCHAR)) LIMIT ?",
                    [text, text, limit],
                ))
                for row in fuzzy:
                    asset_value = _id(row.get(id_field))
                    properties = {name: row.get(name) for name in display if row.get(name) not in (None, "")}
                    matches.append({
                        "asset_id": asset_value,
                        "asset_type": asset_type,
                        "label": asset_value,
                        "subtitle": " | ".join(str(value) for value in list(properties.values())[:3]) or asset_type.title(),
                        "status": properties.get(_column(display, "Active", "STATUS") or ""),
                        "match_rank": 3,
                    })
    matches.sort(key=lambda item: (item["match_rank"], len(item["asset_id"]), item["asset_id"]))
    return matches[:limit]


def asset_summary(asset_type: str, asset_id: str) -> dict[str, Any]:
    config = _config()
    definition = _asset_definition(config, asset_type)
    _, path = _source(config, "inventory")
    with closing(_connect(path)) as connection:
        columns = _columns(connection, definition["table"])
        id_field = _column(columns, definition["idField"])
        if not id_field:
            raise HTTPException(status_code=503, detail="The configured inventory asset ID field is unavailable.")
        cursor = connection.execute(
            f"SELECT * FROM {_quote(definition['table'])} WHERE upper(CAST({_quote(id_field)} AS VARCHAR)) = upper(?) LIMIT 1",
            [_id(asset_id)],
        )
        rows = _rows(cursor)
    if not rows:
        raise HTTPException(status_code=404, detail=f"Asset {_id(asset_id)} was not found in the active inventory source.")
    raw = rows[0]
    construction_date_field = _column(raw.keys(), definition["constructionDateField"])
    preferred = [
        "Location", "ADDRESS", "Active", "STATUS", "MATERIAL", "TYPE", "STRUCT_TYPE",
        "STRUCTURE_SIZE", "DIAMETER", "WIDTH", "DEPTH", "INVERT", "PI_SHAPE", "CH_SHAPE",
        "US_ASSETID", "DS_ASSETID", "US_ID", "US_INVERT", "DS_ID", "DS_INVERT",
        "CONST_DATE", "ConstDateSource",
    ]
    summary = {name: raw[name] for name in preferred if name in raw and raw[name] not in (None, "")}
    construction_date = _calendar_date(raw.get(construction_date_field or ""))
    if construction_date_field and construction_date not in (None, ""):
        summary[construction_date_field] = construction_date
    return {
        "asset_id": _id(raw.get(id_field)),
        "asset_type": asset_type,
        "entity_type": definition["entityType"],
        "status": raw.get(_column(raw.keys(), "Active", "STATUS") or ""),
        "construction_date": construction_date,
        "construction_date_field": construction_date_field,
        "summary": summary,
        "all_fields": {key: value for key, value in raw.items() if value not in (None, "") and key.casefold() not in {"geometry", "shape"}},
    }


def _membership(connection: duckdb.DuckDBPyConnection, table: str, id_field: str, asset_id: str) -> list[dict[str, Any]]:
    _columns(connection, table)
    return _rows(connection.execute(
        f"SELECT * FROM {_quote(table)} WHERE upper(CAST({_quote(id_field)} AS VARCHAR)) = upper(?)",
        [_id(asset_id)],
    ))


def assignment_status(asset_id: str) -> dict[str, Any]:
    config = _config()
    source_id, path = _source(config, "step401")
    tables = config.get("step401Tables", {})
    id_field = str(tables.get("assetIdField") or "ITPIPE_ASSETID")
    with closing(_connect(path)) as connection:
        branches: dict[str, Any] = {}
        for branch, unassigned_key, assigned_key in (
            ("cityworks", "cityworksUnassigned", "cityworksAssigned"),
            ("itpipes", "itpipesUnassigned", "itpipesAssigned"),
        ):
            unassigned = _membership(connection, str(tables.get(unassigned_key) or ""), id_field, asset_id)
            assigned = _membership(connection, str(tables.get(assigned_key) or ""), id_field, asset_id)
            if assigned and unassigned:
                state = "data_conflict"
            elif assigned:
                state = "assigned"
            elif unassigned:
                state = "unassigned"
            else:
                state = "not_evaluated"
            context_rows = assigned + unassigned
            context: dict[str, list[str]] = {}
            for key in ("INSPECTIONID", "WORKORDERID", "REQUESTID", "MLI_ID", "MLO_ID"):
                values = sorted({_id(row.get(key)) for row in context_rows if _id(row.get(key))})
                if values:
                    context[key.casefold()] = values
            branches[branch] = {"state": state, "context": context}
    states = {branches["cityworks"]["state"], branches["itpipes"]["state"]}
    evaluated = states - {"not_evaluated"}
    if "data_conflict" in states:
        combined = "data_issue"
    elif evaluated == {"assigned", "unassigned"}:
        combined = "mixed"
    elif "assigned" in evaluated:
        combined = "assigned"
    elif "unassigned" in evaluated:
        combined = "unassigned"
    else:
        combined = "not_evaluated"
    metadata = source_info(source_id)
    return {
        "combined": combined,
        "branches": branches,
        "source_id": source_id,
        "version": str(metadata.get("version") or ""),
        "published_at": metadata.get("publishedAt") or metadata.get("publicationTimestamp"),
    }


def assignment_statuses(asset_ids: Iterable[str]) -> dict[str, Any]:
    """Resolve Step 401 status for many assets with one query per source table."""

    normalized_ids = sorted({_id(value) for value in asset_ids if _id(value)})
    config = _config()
    source_id, path = _source(config, "step401")
    tables = config.get("step401Tables", {})
    id_field = str(tables.get("assetIdField") or "ITPIPE_ASSETID")
    memberships: dict[str, set[str]] = {
        "cityworks_assigned": set(),
        "cityworks_unassigned": set(),
        "itpipes_assigned": set(),
        "itpipes_unassigned": set(),
    }
    placeholders, values = _in(value.upper() for value in normalized_ids)
    if values:
        with closing(_connect(path)) as connection:
            for membership, table_key in (
                ("cityworks_unassigned", "cityworksUnassigned"),
                ("cityworks_assigned", "cityworksAssigned"),
                ("itpipes_unassigned", "itpipesUnassigned"),
                ("itpipes_assigned", "itpipesAssigned"),
            ):
                table = str(tables.get(table_key) or "")
                columns = _columns(connection, table)
                source_field = _required_column(columns, table, id_field)
                rows = connection.execute(
                    f"SELECT DISTINCT upper(regexp_replace(CAST({_quote(source_field)} AS VARCHAR), '\\.0+$', '')) "
                    f"FROM {_quote(table)} WHERE upper(regexp_replace(CAST({_quote(source_field)} AS VARCHAR), '\\.0+$', '')) IN ({placeholders})",
                    values,
                ).fetchall()
                memberships[membership] = {_id(row[0]).upper() for row in rows if _id(row[0])}

    statuses: dict[str, str] = {}
    for asset_id in normalized_ids:
        key = asset_id.upper()
        assigned = key in memberships["cityworks_assigned"] or key in memberships["itpipes_assigned"]
        unassigned = key in memberships["cityworks_unassigned"] or key in memberships["itpipes_unassigned"]
        statuses[asset_id] = "assigned" if assigned else "unassigned" if unassigned else "not_evaluated"
    metadata = source_info(source_id)
    return {
        "statuses": statuses,
        "source_id": source_id,
        "version": str(metadata.get("version") or ""),
        "published_at": metadata.get("publishedAt") or metadata.get("publicationTimestamp"),
    }


def binary_assignment_status(result: dict[str, Any]) -> str:
    """Collapse the two Step 401 branches for the compact map inspector."""

    branches = result.get("branches") if isinstance(result, dict) else None
    states = {
        str(branch.get("state") or "").strip().casefold()
        for branch in (branches or {}).values()
        if isinstance(branch, dict)
    }
    if "assigned" in states:
        return "assigned"
    if "unassigned" in states:
        return "unassigned"
    return "data_unavailable"


def _itpipes_table(config: dict[str, Any], key: str) -> str:
    table = str(config.get("itpipesTables", {}).get(key) or "").strip()
    if not table:
        raise HTTPException(status_code=503, detail=f"Asset History ITPipes {key} table is not configured.")
    return table


def _priority_pipes_table(config: dict[str, Any], key: str) -> str:
    table = str(config.get("priorityPipesTables", {}).get(key) or "").strip()
    if not table:
        raise HTTPException(status_code=503, detail=f"Asset History priority-pipes {key} table is not configured.")
    return table


def _required_column(columns: Iterable[str], table: str, *candidates: str) -> str:
    value = _column(columns, *candidates)
    if value is None:
        raise HTTPException(
            status_code=503,
            detail=f"Required Asset History field {candidates[0]} was not found in {table}.",
        )
    return value


def itpipes_defect_count(asset_id: str) -> int:
    config = _config()
    _, path = _source(config, "itpipesIntermediate")
    table = _itpipes_table(config, "defects")
    with closing(_connect(path)) as connection:
        columns = _columns(connection, table)
        asset_field = _required_column(columns, table, "ITPIPE_ASSETID")
        return int(
            connection.execute(
                f"SELECT count(*) FROM {_quote(table)} WHERE upper(CAST({_quote(asset_field)} AS VARCHAR))=upper(?)",
                [_id(asset_id)],
            ).fetchone()[0]
        )


def itpipes_defects(asset_id: str) -> list[dict[str, Any]]:
    """Return merged ITPipes defects enriched by authoritative production MLI/ML rows."""

    return itpipes_defects_for_assets([asset_id])


def latest_itpipes_inspection_defects(asset_id: str) -> dict[str, Any] | None:
    """Return the latest production MLI and its positive-condition-risk observations."""

    normalized_asset_id = _id(asset_id)
    if not normalized_asset_id:
        return None
    config = _config()
    intermediate_source_id, intermediate_path = _source(config, "itpipesIntermediate")
    production_source_id, production_path = _source(config, "itpipesProduction")
    defect_table = _itpipes_table(config, "defects")
    inspection_table = _itpipes_table(config, "inspection")
    asset_table = _itpipes_table(config, "asset")

    with closing(_connect(production_path)) as connection:
        inspection_columns = _columns(connection, inspection_table)
        asset_columns = _columns(connection, asset_table)
        mli_id_field = _required_column(inspection_columns, inspection_table, "MLI_ID")
        inspection_ml_id_field = _required_column(inspection_columns, inspection_table, "ML_ID")
        inspection_date_field = _required_column(inspection_columns, inspection_table, "Inspection_Date")
        direction_field = _required_column(inspection_columns, inspection_table, "Inspection_Direction")
        asset_ml_id_field = _required_column(asset_columns, asset_table, "ML_ID")
        asset_name_field = _required_column(asset_columns, asset_table, "ML_Name")
        latest = _rows(connection.execute(
            f"""
            SELECT
                inspection.{_quote(mli_id_field)} AS mli_id,
                inspection.{_quote(inspection_ml_id_field)} AS ml_id,
                inspection.{_quote(inspection_date_field)} AS inspection_date,
                inspection.{_quote(direction_field)} AS inspection_direction,
                asset.{_quote(asset_name_field)} AS production_asset_id
            FROM {_quote(asset_table)} asset
            JOIN {_quote(inspection_table)} inspection
              ON CAST(inspection.{_quote(inspection_ml_id_field)} AS VARCHAR)=CAST(asset.{_quote(asset_ml_id_field)} AS VARCHAR)
            WHERE upper(regexp_replace(CAST(asset.{_quote(asset_name_field)} AS VARCHAR), '\\.0+$', ''))=upper(?)
            ORDER BY try_cast(inspection.{_quote(inspection_date_field)} AS TIMESTAMP) DESC NULLS LAST,
                     CAST(inspection.{_quote(mli_id_field)} AS VARCHAR) ASC
            LIMIT 1
            """,
            [normalized_asset_id],
        ))
    if not latest:
        return None

    inspection = latest[0]
    mli_id = _id(inspection.get("mli_id"))
    with closing(_connect(intermediate_path)) as connection:
        columns = _columns(connection, defect_table)
        fields = {
            "asset_id": _required_column(columns, defect_table, "ITPIPE_ASSETID"),
            "mli_id": _required_column(columns, defect_table, "MLI_ID"),
            "mlo_id": _required_column(columns, defect_table, "MLO_ID"),
            "is_continuous": _required_column(columns, defect_table, "IS_CONTINUOUS"),
            "observation_text": _required_column(columns, defect_table, "Observation_Text"),
            "distance": _required_column(columns, defect_table, "Distance"),
            "condition_risk": _required_column(columns, defect_table, "COND_RISK"),
        }
        relative_depth_field = _column(columns, "RELATIVE_DEPTH", "Relative_Depth")
        relative_depth_select = (
            f"{_quote(relative_depth_field)} AS relative_depth"
            if relative_depth_field else "NULL AS relative_depth"
        )
        defects = _rows(connection.execute(
            f"""
            SELECT
                {_quote(fields['mlo_id'])} AS mlo_id,
                {_quote(fields['is_continuous'])} AS is_continuous,
                {_quote(fields['observation_text'])} AS observation_text,
                {_quote(fields['distance'])} AS source_distance_feet,
                {relative_depth_select},
                try_cast({_quote(fields['condition_risk'])} AS DOUBLE) AS condition_risk
            FROM {_quote(defect_table)}
            WHERE upper(regexp_replace(CAST({_quote(fields['asset_id'])} AS VARCHAR), '\\.0+$', ''))=upper(?)
              AND regexp_replace(CAST({_quote(fields['mli_id'])} AS VARCHAR), '\\.0+$', '')=?
              AND try_cast({_quote(fields['condition_risk'])} AS DOUBLE) > 0
            ORDER BY try_cast({_quote(fields['distance'])} AS DOUBLE) ASC NULLS LAST,
                     try_cast({_quote(fields['condition_risk'])} AS DOUBLE) DESC,
                     CAST({_quote(fields['mlo_id'])} AS VARCHAR) ASC
            """,
            [normalized_asset_id, mli_id],
        ))

    seen_mlo_ids: set[str] = set()
    normalized_defects: list[dict[str, Any]] = []
    for defect in defects:
        mlo_id = _id(defect.get("mlo_id"))
        if not mlo_id:
            raise HTTPException(status_code=503, detail="The latest ITPipes inspection contains an observation without MLO_ID.")
        if mlo_id in seen_mlo_ids:
            raise HTTPException(status_code=503, detail=f"MLO_ID {mlo_id} is duplicated in the latest ITPipes inspection.")
        seen_mlo_ids.add(mlo_id)
        normalized_defects.append({**defect, "mlo_id": mlo_id})
    return {
        "mli_id": mli_id,
        "ml_id": _id(inspection.get("ml_id")),
        "inspection_date": inspection.get("inspection_date"),
        "inspection_direction": inspection.get("inspection_direction"),
        "production_asset_id": _id(inspection.get("production_asset_id")),
        "source_ids": [intermediate_source_id, production_source_id],
        "defects": normalized_defects,
    }


def itpipes_defects_for_assets(asset_ids: Iterable[str]) -> list[dict[str, Any]]:
    """Return merged ITPipes defects for a selected asset set."""

    config = _config()
    intermediate_source_id, intermediate_path = _source(config, "itpipesIntermediate")
    production_source_id, production_path = _source(config, "itpipesProduction")
    defect_table = _itpipes_table(config, "defects")
    inspection_table = _itpipes_table(config, "inspection")
    asset_table = _itpipes_table(config, "asset")

    with closing(_connect(intermediate_path)) as connection:
        columns = _columns(connection, defect_table)
        fields = {
            name: _required_column(columns, defect_table, name)
            for name in (
                "ITPIPE_ASSETID",
                "MLI_ID",
                "MLO_ID",
                "IS_CONTINUOUS",
                "Observation_Text",
                "COND_RISK",
                "FLOOD_RISK",
                "CLOG_RISK",
                "RISK",
            )
        }
        distance_field = _column(columns, "Distance")
        relative_depth_field = _column(columns, "RELATIVE_DEPTH", "Relative_Depth")
        placeholders, selected_ids = _in(_id(value).upper() for value in asset_ids)
        defects = _rows(connection.execute(
            f"SELECT * FROM {_quote(defect_table)} "
            f"WHERE upper(regexp_replace(CAST({_quote(fields['ITPIPE_ASSETID'])} AS VARCHAR), '\\.0+$', '')) IN ({placeholders})",
            selected_ids,
        )) if selected_ids else []
    if not defects:
        return []

    mli_ids = {_id(row.get(fields["MLI_ID"])) for row in defects if _id(row.get(fields["MLI_ID"]))}
    placeholders, values = _in(mli_ids)
    inspections: dict[str, dict[str, Any]] = {}
    with closing(_connect(production_path)) as connection:
        inspection_columns = _columns(connection, inspection_table)
        asset_columns = _columns(connection, asset_table)
        mli_id_field = _required_column(inspection_columns, inspection_table, "MLI_ID")
        inspection_ml_id_field = _required_column(inspection_columns, inspection_table, "ML_ID")
        inspection_date_field = _required_column(inspection_columns, inspection_table, "Inspection_Date")
        direction_field = _required_column(inspection_columns, inspection_table, "Inspection_Direction")
        asset_ml_id_field = _required_column(asset_columns, asset_table, "ML_ID")
        asset_name_field = _required_column(asset_columns, asset_table, "ML_Name")
        if values:
            production_rows = _rows(
                connection.execute(
                    f"""
                    SELECT
                        inspection.{_quote(mli_id_field)} AS mli_id,
                        inspection.{_quote(inspection_ml_id_field)} AS ml_id,
                        inspection.{_quote(inspection_date_field)} AS inspection_date,
                        inspection.{_quote(direction_field)} AS inspection_direction,
                        asset.{_quote(asset_name_field)} AS production_asset_id
                    FROM {_quote(inspection_table)} inspection
                    LEFT JOIN {_quote(asset_table)} asset
                      ON CAST(asset.{_quote(asset_ml_id_field)} AS VARCHAR)=CAST(inspection.{_quote(inspection_ml_id_field)} AS VARCHAR)
                    WHERE regexp_replace(CAST(inspection.{_quote(mli_id_field)} AS VARCHAR), '\\.0+$', '') IN ({placeholders})
                    """,
                    values,
                )
            )
            inspections = {_id(row.get("mli_id")): row for row in production_rows}

    result: list[dict[str, Any]] = []
    for defect in defects:
        mli_id = _id(defect.get(fields["MLI_ID"]))
        mlo_id = _id(defect.get(fields["MLO_ID"]))
        inspection = inspections.get(mli_id, {})
        result.append(
            {
                "kind": "itpipes_defect",
                "record_id": mlo_id,
                "asset_id": _id(defect.get(fields["ITPIPE_ASSETID"])),
                "production_asset_id": _id(inspection.get("production_asset_id")),
                "mli_id": mli_id,
                "mlo_id": mlo_id,
                "ml_id": _id(inspection.get("ml_id")),
                "inspection_date": inspection.get("inspection_date"),
                "inspection_direction": inspection.get("inspection_direction"),
                "is_continuous": defect.get(fields["IS_CONTINUOUS"]),
                "observation_text": defect.get(fields["Observation_Text"]),
                "distance": defect.get(distance_field) if distance_field else None,
                "relative_depth": defect.get(relative_depth_field) if relative_depth_field else None,
                "condition_risk": defect.get(fields["COND_RISK"]),
                "flood_risk": defect.get(fields["FLOOD_RISK"]),
                "clogging_risk": defect.get(fields["CLOG_RISK"]),
                "risk": defect.get(fields["RISK"]),
                "event_date": inspection.get("inspection_date"),
                "source_ids": [intermediate_source_id, production_source_id],
                "source_attributes": defect,
            }
        )
    result.sort(
        key=lambda row: (
            str(row.get("inspection_date") or ""),
            _sort_number(row.get("condition_risk")),
            _id(row.get("mli_id")),
            _id(row.get("mlo_id")),
        ),
        reverse=True,
    )
    return result


def priority_pipe_risk_count(asset_id: str) -> int:
    config = _config()
    _, path = _source(config, "priorityPipes")
    table = _priority_pipes_table(config, "scored")
    with closing(_connect(path)) as connection:
        columns = _columns(connection, table)
        asset_field = _required_column(columns, table, "ITPIPE_ASSETID")
        return int(
            connection.execute(
                f"SELECT count(*) FROM {_quote(table)} WHERE upper(CAST({_quote(asset_field)} AS VARCHAR))=upper(?)",
                [_id(asset_id)],
            ).fetchone()[0]
        )


def priority_pipe_risk(asset_id: str) -> list[dict[str, Any]]:
    """Return the published priority-pipe scores without recalculating model logic."""

    return priority_pipe_risk_for_assets([asset_id])


def priority_pipe_risk_for_assets(asset_ids: Iterable[str]) -> list[dict[str, Any]]:
    """Return published priority-pipe scores for a selected pipe set."""

    config = _config()
    source_id, path = _source(config, "priorityPipes")
    table = _priority_pipes_table(config, "scored")
    with closing(_connect(path)) as connection:
        columns = _columns(connection, table)
        fields = {
            name: _required_column(columns, table, name)
            for name in ("ITPIPE_ASSETID", "Basin_Name", "WorkZoneID", "CL_SCORE", "LOF_SCORE", "COF_SCORE", "RISK")
        }
        placeholders, selected_ids = _in(_id(value).upper() for value in asset_ids)
        rows = _rows(connection.execute(
            f"SELECT * FROM {_quote(table)} "
            f"WHERE upper(regexp_replace(CAST({_quote(fields['ITPIPE_ASSETID'])} AS VARCHAR), '\\.0+$', '')) IN ({placeholders}) "
            f"ORDER BY {_quote(fields['RISK'])} DESC NULLS LAST",
            selected_ids,
        )) if selected_ids else []
    return [
        {
            "kind": "pipe_risk",
            "record_id": _id(row.get(fields["ITPIPE_ASSETID"])),
            "asset_id": _id(row.get(fields["ITPIPE_ASSETID"])),
            "basin_name": row.get(fields["Basin_Name"]),
            "work_zone_id": row.get(fields["WorkZoneID"]),
            "cl_score": row.get(fields["CL_SCORE"]),
            "lof_score": row.get(fields["LOF_SCORE"]),
            "cof_score": row.get(fields["COF_SCORE"]),
            "risk": row.get(fields["RISK"]),
            "source_ids": [source_id],
            "source_attributes": row,
        }
        for row in rows
    ]


def _fetch_by_ids(connection: duckdb.DuckDBPyConnection, table: str, id_column: str, ids: Iterable[str]) -> list[dict[str, Any]]:
    placeholders, values = _in(ids)
    if not values:
        return []
    return _rows(connection.execute(
        f"SELECT * FROM {_quote(table)} WHERE regexp_replace(CAST({_quote(id_column)} AS VARCHAR), '\\.0+$', '') IN ({placeholders})",
        values,
    ))


def _inspection_risk_by_id(inspection_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    placeholders, values = _in(inspection_ids)
    if not values:
        return {}
    config = _config()
    _, path = _source(config, "cityworksRisk")
    table = str(config.get("cityworksRiskTables", {}).get("scoredInspection") or "")
    with closing(_connect(path)) as connection:
        columns = _columns(connection, table)
        inspection_id = _required_column(columns, table, "INSPECTIONID")
        risk_fields = {
            "condition_risk": _required_column(columns, table, "COND_RISK"),
            "flood_risk": _required_column(columns, table, "FLOOD_RISK"),
            "clogging_risk": _required_column(columns, table, "CLOG_RISK"),
            "risk": _required_column(columns, table, "RISK"),
        }
        select_fields = ", ".join(
            f"{_quote(column)} AS {_quote(alias)}" for alias, column in risk_fields.items()
        )
        rows = _rows(connection.execute(
            f"SELECT {_quote(inspection_id)} AS inspection_id, {select_fields} "
            f"FROM {_quote(table)} WHERE regexp_replace(CAST({_quote(inspection_id)} AS VARCHAR), '\\.0+$', '') IN ({placeholders})",
            values,
        ))
    return {_id(row.get("inspection_id")): row for row in rows}


def related_risk_scores_for_assets(
    assets: Iterable[tuple[str, str]],
) -> tuple[dict[tuple[str, str], dict[str, float | None]], list[str]]:
    """Return each asset's maximum published Cityworks/ITPipes risk scores."""

    selected = sorted({
        (str(asset_type).strip().casefold(), _id(asset_id))
        for asset_type, asset_id in assets
        if str(asset_type).strip().casefold() in ASSET_TYPES and _id(asset_id)
    })
    scores = {
        asset: {"condition_risk": None, "flood_risk": None, "clogging_risk": None, "risk": None}
        for asset in selected
    }
    warnings: list[str] = []
    if not selected:
        return scores, warnings

    references_by_id: dict[str, set[tuple[str, str]]] = {}
    for asset in selected:
        references_by_id.setdefault(asset[1].upper(), set()).add(asset)

    def record(asset: tuple[str, str], field: str, value: Any) -> None:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return
        if not math.isfinite(number):
            return
        current = scores[asset][field]
        scores[asset][field] = number if current is None else max(current, number)

    config = _config()
    try:
        _, cityworks_path = _source(config, "cityworks")
        inspection_table = str(config.get("cityworksTables", {}).get("inspection") or "")
        template_pattern = str(config.get("assetInspectionTemplatePattern") or "%Asset Insp%")
        selected_rows = [
            (asset_type, asset_id, _asset_definition(config, asset_type)["entityType"])
            for asset_type, asset_id in selected
        ]
        with closing(_connect(cityworks_path)) as connection:
            columns = _columns(connection, inspection_table)
            inspection_id = _required_column(columns, inspection_table, "INSPECTIONID")
            entity_uid = _required_column(columns, inspection_table, "ENTITYUID")
            entity_type = _required_column(columns, inspection_table, "ENTITYTYPE")
            template_name = _required_column(columns, inspection_table, "INSPTEMPLATENAME")
            connection.execute("CREATE TEMP TABLE portal_risk_assets(asset_type VARCHAR, asset_id VARCHAR, entity_type VARCHAR)")
            connection.executemany("INSERT INTO portal_risk_assets VALUES (?, ?, ?)", selected_rows)
            rows = _rows(connection.execute(
                f"""
                SELECT selected.asset_type, selected.asset_id,
                       inspection.{_quote(inspection_id)} AS inspection_id
                FROM {_quote(inspection_table)} inspection
                JOIN portal_risk_assets selected
                  ON upper(regexp_replace(CAST(inspection.{_quote(entity_uid)} AS VARCHAR), '\\.0+$', ''))=upper(selected.asset_id)
                 AND upper(CAST(inspection.{_quote(entity_type)} AS VARCHAR))=upper(selected.entity_type)
                WHERE CAST(inspection.{_quote(template_name)} AS VARCHAR) ILIKE ?
                """,
                [template_pattern],
            ))
        inspection_assets: dict[str, set[tuple[str, str]]] = {}
        for row in rows:
            inspection_assets.setdefault(_id(row.get("inspection_id")), set()).add(
                (str(row.get("asset_type")), _id(row.get("asset_id")))
            )
        for inspection_id_value, risk in _inspection_risk_by_id(inspection_assets).items():
            for asset in inspection_assets.get(inspection_id_value, set()):
                for field in ("condition_risk", "flood_risk", "clogging_risk", "risk"):
                    record(asset, field, risk.get(field))
    except (HTTPException, duckdb.Error) as error:
        detail = error.detail if isinstance(error, HTTPException) else str(error)
        warnings.append(f"Cityworks risk filters used no Cityworks scores: {detail}")

    try:
        _, itpipes_path = _source(config, "itpipesIntermediate")
        defect_table = _itpipes_table(config, "defects")
        with closing(_connect(itpipes_path)) as connection:
            columns = _columns(connection, defect_table)
            fields = {
                name: _required_column(columns, defect_table, name)
                for name in ("ITPIPE_ASSETID", "COND_RISK", "FLOOD_RISK", "CLOG_RISK", "RISK")
            }
            placeholders, values = _in(references_by_id)
            rows = _rows(connection.execute(
                f"SELECT {_quote(fields['ITPIPE_ASSETID'])} AS asset_id, "
                f"{_quote(fields['COND_RISK'])} AS condition_risk, "
                f"{_quote(fields['FLOOD_RISK'])} AS flood_risk, "
                f"{_quote(fields['CLOG_RISK'])} AS clogging_risk, "
                f"{_quote(fields['RISK'])} AS risk FROM {_quote(defect_table)} "
                f"WHERE upper(regexp_replace(CAST({_quote(fields['ITPIPE_ASSETID'])} AS VARCHAR), '\\.0+$', '')) IN ({placeholders})",
                values,
            )) if values else []
        for row in rows:
            for asset in references_by_id.get(_id(row.get("asset_id")).upper(), set()):
                for field in ("condition_risk", "flood_risk", "clogging_risk", "risk"):
                    record(asset, field, row.get(field))
    except (HTTPException, duckdb.Error) as error:
        detail = error.detail if isinstance(error, HTTPException) else str(error)
        warnings.append(f"Risk filters used no ITPipes scores: {detail}")

    try:
        pipe_ids = [asset_id for asset_type, asset_id in selected if asset_type == "pipe"]
        for row in priority_pipe_risk_for_assets(pipe_ids) if pipe_ids else []:
            asset = ("pipe", _id(row.get("asset_id")))
            if asset in scores:
                record(asset, "risk", row.get("risk"))
    except (HTTPException, duckdb.Error) as error:
        detail = error.detail if isinstance(error, HTTPException) else str(error)
        warnings.append(f"Risk filters used no priority-pipe scores: {detail}")

    return scores, warnings


def _activity_type(value: Any) -> str:
    normalized = re.sub(r"[^a-z]", "", str(value or "").casefold())
    if "service" in normalized or normalized == "request":
        return "service_request"
    if "workorder" in normalized:
        return "work_order"
    if "inspection" in normalized:
        return "inspection"
    return normalized


def _common(kind: str, raw: dict[str, Any], relationship: str, related_id: str = "") -> dict[str, Any]:
    if kind in {"inspection", "investigation"}:
        record_id = _id(raw.get("INSPECTIONID"))
        event_date = raw.get("INSPDATE") or raw.get("INITIATEDATE") or raw.get("DATECLOSED")
        title = raw.get("INSPTEMPLATENAME") or raw.get("DESCRIPTION") or kind.title()
        summary = raw.get("OBSERVATIONSUM") or raw.get("LOCATION") or ""
        person = raw.get("INSPECTEDBY") or raw.get("INITIATEDBY")
    elif kind == "work_order":
        record_id = _id(raw.get("WORKORDERID"))
        event_date = raw.get("INITIATEDATE") or raw.get("ACTUALSTARTDATE") or raw.get("DATEWOCLOSED")
        title = raw.get("DESCRIPTION") or raw.get("PROJECTNAME") or "Work order"
        summary = raw.get("LOCATION") or raw.get("WORKCOMPLETEDBY") or ""
        person = raw.get("SUPERVISOR") or raw.get("INITIATEDBY")
    else:
        record_id = _id(raw.get("REQUESTID"))
        event_date = raw.get("DATETIMEINIT") or raw.get("DATETIMECLOSED")
        title = raw.get("DESCRIPTION") or raw.get("PROBLEMCODE") or "Service request"
        summary = raw.get("DETAILS") or raw.get("PROBADDRESS") or ""
        person = raw.get("INITIATEDBY")
    return {
        "kind": kind,
        "record_id": record_id,
        "event_date": event_date,
        "status": raw.get("STATUS"),
        "priority": raw.get("PRIORITY"),
        "title": title,
        "summary": summary,
        "person": person,
        "relationship": relationship,
        "related_id": _id(related_id),
        "source_attributes": dict(raw),
    }


def activity_history(asset_type: str, asset_id: str) -> dict[str, list[dict[str, Any]]]:
    config = _config()
    definition = _asset_definition(config, asset_type)
    _, path = _source(config, "cityworks")
    tables = config.get("cityworksTables", {})
    inspection_table = str(tables.get("inspection") or "")
    work_order_table = str(tables.get("workOrder") or "")
    entity_table = str(tables.get("workOrderEntity") or "")
    link_table = str(tables.get("activityLink") or "")
    request_table = str(tables.get("request") or "")
    template_pattern = str(config.get("assetInspectionTemplatePattern") or "%Asset Insp%")
    with closing(_connect(path)) as connection:
        for table in (inspection_table, work_order_table, entity_table, link_table, request_table):
            _columns(connection, table)
        inspections = _rows(connection.execute(
            f"SELECT * FROM {_quote(inspection_table)} WHERE upper(CAST(ENTITYUID AS VARCHAR)) = upper(?) AND upper(CAST(ENTITYTYPE AS VARCHAR)) = upper(?) AND CAST(INSPTEMPLATENAME AS VARCHAR) ILIKE ?",
            [_id(asset_id), definition["entityType"], template_pattern],
        ))
        inspection_ids = {_id(row.get("INSPECTIONID")) for row in inspections if _id(row.get("INSPECTIONID"))}
        work_orders = _rows(connection.execute(
            f"SELECT DISTINCT wo.* FROM {_quote(work_order_table)} wo JOIN {_quote(entity_table)} entity ON CAST(entity.WORKORDERID AS VARCHAR)=CAST(wo.WORKORDERID AS VARCHAR) WHERE upper(CAST(entity.ENTITYUID AS VARCHAR))=upper(?) AND upper(CAST(entity.ENTITYTYPE AS VARCHAR))=upper(?)",
            [_id(asset_id), definition["entityType"]],
        ))
        work_order_ids = {_id(row.get("WORKORDERID")) for row in work_orders if _id(row.get("WORKORDERID"))}

        inspection_placeholders, inspection_values = _in(inspection_ids)
        inspection_links = _rows(connection.execute(
            f"""
                SELECT * FROM {_quote(link_table)}
                WHERE lower(CAST(SOURCEACTIVITYTYPE AS VARCHAR)) = 'inspection'
                  AND lower(CAST(DESTACTIVITYTYPE AS VARCHAR)) = 'inspection'
                  AND (
                    regexp_replace(CAST(SOURCEACTIVITYID AS VARCHAR), '\\.0+$', '') IN ({inspection_placeholders})
                    OR regexp_replace(CAST(DESTACTIVITYID AS VARCHAR), '\\.0+$', '') IN ({inspection_placeholders})
                  )
            """,
            [*inspection_values, *inspection_values],
        )) if inspection_values else []
        investigation_pairs: list[tuple[str, str]] = []
        investigation_ids: set[str] = set()
        for link in inspection_links:
            source_type = _activity_type(link.get("SOURCEACTIVITYTYPE"))
            dest_type = _activity_type(link.get("DESTACTIVITYTYPE"))
            source_id = _id(link.get("SOURCEACTIVITYID"))
            dest_id = _id(link.get("DESTACTIVITYID"))
            if source_type == dest_type == "inspection":
                if source_id in inspection_ids and dest_id not in inspection_ids:
                    investigation_pairs.append((source_id, dest_id)); investigation_ids.add(dest_id)
                elif dest_id in inspection_ids and source_id not in inspection_ids:
                    investigation_pairs.append((dest_id, source_id)); investigation_ids.add(source_id)
        investigation_raw = { _id(row.get("INSPECTIONID")): row for row in _fetch_by_ids(connection, inspection_table, "INSPECTIONID", investigation_ids) }
        investigations: list[dict[str, Any]] = []
        seen_pairs: set[tuple[str, str]] = set()
        for asset_inspection_id, investigation_id in investigation_pairs:
            if (asset_inspection_id, investigation_id) in seen_pairs or investigation_id not in investigation_raw:
                continue
            seen_pairs.add((asset_inspection_id, investigation_id))
            row = investigation_raw[investigation_id]
            if "asset insp" in str(row.get("INSPTEMPLATENAME") or "").casefold():
                continue
            investigations.append(_common("investigation", row, "Linked investigation", asset_inspection_id))

        request_paths: dict[str, set[str]] = {}
        request_related: dict[str, set[str]] = {}
        def add_request(request_id: Any, path_label: str, related: Any = "") -> None:
            normalized = _id(request_id)
            if not normalized:
                return
            request_paths.setdefault(normalized, set()).add(path_label)
            if _id(related):
                request_related.setdefault(normalized, set()).add(_id(related))
        for row in inspections:
            add_request(row.get("REQUESTID"), "Asset inspection", row.get("INSPECTIONID"))
        for row in investigation_raw.values():
            add_request(row.get("REQUESTID"), "Investigation", row.get("INSPECTIONID"))
        if work_order_ids:
            placeholders, values = _in(work_order_ids)
            for row in _rows(connection.execute(f"SELECT * FROM {_quote(request_table)} WHERE regexp_replace(CAST(WORKORDERID AS VARCHAR), '\\.0+$', '') IN ({placeholders})", values)):
                add_request(row.get("REQUESTID"), "Direct asset work order", row.get("WORKORDERID"))
        related_inspection_ids = inspection_ids | investigation_ids
        inspection_placeholders, inspection_values = _in(related_inspection_ids)
        workorder_placeholders, workorder_values = _in(work_order_ids)
        link_predicates: list[str] = []
        link_parameters: list[str] = []
        if inspection_values:
            for side in ("SOURCE", "DEST"):
                link_predicates.append(
                    f"(lower(CAST({side}ACTIVITYTYPE AS VARCHAR))='inspection' AND regexp_replace(CAST({side}ACTIVITYID AS VARCHAR), '\\.0+$', '') IN ({inspection_placeholders}))"
                )
                link_parameters.extend(inspection_values)
        if workorder_values:
            for side in ("SOURCE", "DEST"):
                link_predicates.append(
                    f"(lower(replace(CAST({side}ACTIVITYTYPE AS VARCHAR), ' ', ''))='workorder' AND regexp_replace(CAST({side}ACTIVITYID AS VARCHAR), '\\.0+$', '') IN ({workorder_placeholders}))"
                )
                link_parameters.extend(workorder_values)
        related_links = _rows(connection.execute(
            f"SELECT * FROM {_quote(link_table)} WHERE {' OR '.join(link_predicates)}",
            link_parameters,
        )) if link_predicates else []
        for link in related_links:
            source_type = _activity_type(link.get("SOURCEACTIVITYTYPE")); dest_type = _activity_type(link.get("DESTACTIVITYTYPE"))
            source_id = _id(link.get("SOURCEACTIVITYID")); dest_id = _id(link.get("DESTACTIVITYID"))
            if source_type == "service_request" and dest_type == "inspection" and dest_id in related_inspection_ids:
                add_request(source_id, "Asset inspection" if dest_id in inspection_ids else "Investigation", dest_id)
            elif dest_type == "service_request" and source_type == "inspection" and source_id in related_inspection_ids:
                add_request(dest_id, "Asset inspection" if source_id in inspection_ids else "Investigation", source_id)
            elif source_type == "service_request" and dest_type == "work_order" and dest_id in work_order_ids:
                add_request(source_id, "Direct asset work order", dest_id)
            elif dest_type == "service_request" and source_type == "work_order" and source_id in work_order_ids:
                add_request(dest_id, "Direct asset work order", source_id)
        request_raw = { _id(row.get("REQUESTID")): row for row in _fetch_by_ids(connection, request_table, "REQUESTID", request_paths) }

    inspection_risks = _inspection_risk_by_id(inspection_ids)
    inspection_records = [_common("inspection", row, "Direct asset inspection") for row in inspections]
    for record in inspection_records:
        scored = inspection_risks.get(record["record_id"], {})
        for key in ("condition_risk", "flood_risk", "clogging_risk", "risk"):
            record[key] = scored.get(key)
        record["source_attributes"].update({
            "COND_RISK": scored.get("condition_risk"),
            "FLOOD_RISK": scored.get("flood_risk"),
            "CLOG_RISK": scored.get("clogging_risk"),
            "RISK": scored.get("risk"),
        })
    work_order_records = [_common("work_order", row, "Direct asset work order") for row in work_orders]
    request_records = []
    for request_id, paths in request_paths.items():
        raw = request_raw.get(request_id)
        if not raw:
            continue
        record = _common("service_request", raw, ", ".join(sorted(paths)), ", ".join(sorted(request_related.get(request_id, set()))))
        record["relationship_paths"] = sorted(paths)
        request_records.append(record)
    return {
        "service_requests": request_records,
        "investigations": investigations,
        "inspections": inspection_records,
        "work_orders": work_order_records,
    }


def activity_history_for_assets(assets: Iterable[tuple[str, str]]) -> dict[str, list[dict[str, Any]]]:
    """Resolve Cityworks history for many assets without per-asset queries."""

    selected = sorted({
        (str(asset_type).strip().casefold(), _id(asset_id))
        for asset_type, asset_id in assets
        if str(asset_type).strip().casefold() in ASSET_TYPES and _id(asset_id)
    })
    result: dict[str, list[dict[str, Any]]] = {
        "service_requests": [],
        "investigations": [],
        "inspections": [],
        "work_orders": [],
    }
    if not selected:
        return result

    config = _config()
    _, path = _source(config, "cityworks")
    tables = config.get("cityworksTables", {})
    inspection_table = str(tables.get("inspection") or "")
    work_order_table = str(tables.get("workOrder") or "")
    entity_table = str(tables.get("workOrderEntity") or "")
    link_table = str(tables.get("activityLink") or "")
    request_table = str(tables.get("request") or "")
    template_pattern = str(config.get("assetInspectionTemplatePattern") or "%Asset Insp%")
    selected_rows = [
        (asset_type, asset_id, _asset_definition(config, asset_type)["entityType"])
        for asset_type, asset_id in selected
    ]

    with closing(_connect(path)) as connection:
        for table in (inspection_table, work_order_table, entity_table, link_table, request_table):
            _columns(connection, table)
        connection.execute("CREATE TEMP TABLE portal_selected_assets(asset_type VARCHAR, asset_id VARCHAR, entity_type VARCHAR)")
        connection.executemany("INSERT INTO portal_selected_assets VALUES (?, ?, ?)", selected_rows)
        inspections = _rows(connection.execute(
            f"""
            SELECT selected.asset_type AS __asset_type, selected.asset_id AS __asset_id, inspection.*
            FROM {_quote(inspection_table)} inspection
            JOIN portal_selected_assets selected
              ON upper(regexp_replace(CAST(inspection.ENTITYUID AS VARCHAR), '\\.0+$', ''))=upper(selected.asset_id)
             AND upper(CAST(inspection.ENTITYTYPE AS VARCHAR))=upper(selected.entity_type)
            WHERE CAST(inspection.INSPTEMPLATENAME AS VARCHAR) ILIKE ?
            """,
            [template_pattern],
        ))
        work_orders = _rows(connection.execute(
            f"""
            SELECT DISTINCT selected.asset_type AS __asset_type, selected.asset_id AS __asset_id, work_order.*
            FROM {_quote(work_order_table)} work_order
            JOIN {_quote(entity_table)} entity
              ON CAST(entity.WORKORDERID AS VARCHAR)=CAST(work_order.WORKORDERID AS VARCHAR)
            JOIN portal_selected_assets selected
              ON upper(regexp_replace(CAST(entity.ENTITYUID AS VARCHAR), '\\.0+$', ''))=upper(selected.asset_id)
             AND upper(CAST(entity.ENTITYTYPE AS VARCHAR))=upper(selected.entity_type)
            """
        ))

        inspection_refs: dict[str, set[tuple[str, str]]] = {}
        for row in inspections:
            inspection_refs.setdefault(_id(row.get("INSPECTIONID")), set()).add((str(row["__asset_type"]), _id(row["__asset_id"])))
        work_order_refs: dict[str, set[tuple[str, str]]] = {}
        for row in work_orders:
            work_order_refs.setdefault(_id(row.get("WORKORDERID")), set()).add((str(row["__asset_type"]), _id(row["__asset_id"])))

        inspection_placeholders, inspection_values = _in(inspection_refs)
        inspection_links = _rows(connection.execute(
            f"""
            SELECT * FROM {_quote(link_table)}
            WHERE lower(CAST(SOURCEACTIVITYTYPE AS VARCHAR))='inspection'
              AND lower(CAST(DESTACTIVITYTYPE AS VARCHAR))='inspection'
              AND (
                regexp_replace(CAST(SOURCEACTIVITYID AS VARCHAR), '\\.0+$', '') IN ({inspection_placeholders})
                OR regexp_replace(CAST(DESTACTIVITYID AS VARCHAR), '\\.0+$', '') IN ({inspection_placeholders})
              )
            """,
            [*inspection_values, *inspection_values],
        )) if inspection_values else []
        investigation_refs: dict[str, set[tuple[str, str]]] = {}
        investigation_related: dict[tuple[str, tuple[str, str]], set[str]] = {}
        for link in inspection_links:
            source_id = _id(link.get("SOURCEACTIVITYID"))
            destination_id = _id(link.get("DESTACTIVITYID"))
            if source_id in inspection_refs and destination_id not in inspection_refs:
                direct_id, investigation_id = source_id, destination_id
            elif destination_id in inspection_refs and source_id not in inspection_refs:
                direct_id, investigation_id = destination_id, source_id
            else:
                continue
            for asset_ref in inspection_refs[direct_id]:
                investigation_refs.setdefault(investigation_id, set()).add(asset_ref)
                investigation_related.setdefault((investigation_id, asset_ref), set()).add(direct_id)
        investigation_raw = {
            _id(row.get("INSPECTIONID")): row
            for row in _fetch_by_ids(connection, inspection_table, "INSPECTIONID", investigation_refs)
        }

        request_refs: dict[str, set[tuple[str, str]]] = {}
        request_paths: dict[tuple[str, tuple[str, str]], set[str]] = {}
        request_related: dict[tuple[str, tuple[str, str]], set[str]] = {}

        def add_request(request_id: Any, asset_ref: tuple[str, str], path_label: str, related: Any = "") -> None:
            normalized = _id(request_id)
            if not normalized:
                return
            request_refs.setdefault(normalized, set()).add(asset_ref)
            request_paths.setdefault((normalized, asset_ref), set()).add(path_label)
            if _id(related):
                request_related.setdefault((normalized, asset_ref), set()).add(_id(related))

        for row in inspections:
            asset_ref = (str(row["__asset_type"]), _id(row["__asset_id"]))
            add_request(row.get("REQUESTID"), asset_ref, "Asset inspection", row.get("INSPECTIONID"))
        for investigation_id, raw in investigation_raw.items():
            for asset_ref in investigation_refs.get(investigation_id, set()):
                add_request(raw.get("REQUESTID"), asset_ref, "Investigation", investigation_id)

        work_order_placeholders, work_order_values = _in(work_order_refs)
        work_order_requests = _rows(connection.execute(
            f"SELECT * FROM {_quote(request_table)} WHERE regexp_replace(CAST(WORKORDERID AS VARCHAR), '\\.0+$', '') IN ({work_order_placeholders})",
            work_order_values,
        )) if work_order_values else []
        for raw in work_order_requests:
            work_order_id = _id(raw.get("WORKORDERID"))
            for asset_ref in work_order_refs.get(work_order_id, set()):
                add_request(raw.get("REQUESTID"), asset_ref, "Direct asset work order", work_order_id)

        all_inspection_refs = dict(inspection_refs)
        for investigation_id, refs in investigation_refs.items():
            all_inspection_refs.setdefault(investigation_id, set()).update(refs)
        related_inspection_placeholders, related_inspection_values = _in(all_inspection_refs)
        predicates: list[str] = []
        parameters: list[str] = []
        if related_inspection_values:
            for side in ("SOURCE", "DEST"):
                predicates.append(
                    f"(lower(CAST({side}ACTIVITYTYPE AS VARCHAR))='inspection' AND regexp_replace(CAST({side}ACTIVITYID AS VARCHAR), '\\.0+$', '') IN ({related_inspection_placeholders}))"
                )
                parameters.extend(related_inspection_values)
        if work_order_values:
            for side in ("SOURCE", "DEST"):
                predicates.append(
                    f"(lower(replace(CAST({side}ACTIVITYTYPE AS VARCHAR), ' ', ''))='workorder' AND regexp_replace(CAST({side}ACTIVITYID AS VARCHAR), '\\.0+$', '') IN ({work_order_placeholders}))"
                )
                parameters.extend(work_order_values)
        related_links = _rows(connection.execute(
            f"SELECT * FROM {_quote(link_table)} WHERE {' OR '.join(predicates)}",
            parameters,
        )) if predicates else []
        for link in related_links:
            source_type = _activity_type(link.get("SOURCEACTIVITYTYPE"))
            destination_type = _activity_type(link.get("DESTACTIVITYTYPE"))
            source_id = _id(link.get("SOURCEACTIVITYID"))
            destination_id = _id(link.get("DESTACTIVITYID"))
            if source_type == "service_request" and destination_type == "inspection":
                for asset_ref in all_inspection_refs.get(destination_id, set()):
                    add_request(source_id, asset_ref, "Asset inspection" if destination_id in inspection_refs else "Investigation", destination_id)
            elif destination_type == "service_request" and source_type == "inspection":
                for asset_ref in all_inspection_refs.get(source_id, set()):
                    add_request(destination_id, asset_ref, "Asset inspection" if source_id in inspection_refs else "Investigation", source_id)
            elif source_type == "service_request" and destination_type == "work_order":
                for asset_ref in work_order_refs.get(destination_id, set()):
                    add_request(source_id, asset_ref, "Direct asset work order", destination_id)
            elif destination_type == "service_request" and source_type == "work_order":
                for asset_ref in work_order_refs.get(source_id, set()):
                    add_request(destination_id, asset_ref, "Direct asset work order", source_id)
        request_raw = {
            _id(row.get("REQUESTID")): row
            for row in _fetch_by_ids(connection, request_table, "REQUESTID", request_refs)
        }

    try:
        inspection_risks = _inspection_risk_by_id(inspection_refs)
    except HTTPException:
        inspection_risks = {}
    for raw in inspections:
        asset_type = str(raw.pop("__asset_type"))
        asset_id = _id(raw.pop("__asset_id"))
        record = _common("inspection", raw, "Direct asset inspection")
        record.update({"asset_type": asset_type, "asset_id": asset_id})
        scored = inspection_risks.get(record["record_id"], {})
        for key in ("condition_risk", "flood_risk", "clogging_risk", "risk"):
            record[key] = scored.get(key)
        record["source_attributes"].update({
            "COND_RISK": scored.get("condition_risk"),
            "FLOOD_RISK": scored.get("flood_risk"),
            "CLOG_RISK": scored.get("clogging_risk"),
            "RISK": scored.get("risk"),
        })
        result["inspections"].append(record)
    for raw in work_orders:
        asset_type = str(raw.pop("__asset_type"))
        asset_id = _id(raw.pop("__asset_id"))
        record = _common("work_order", raw, "Direct asset work order")
        record.update({"asset_type": asset_type, "asset_id": asset_id})
        result["work_orders"].append(record)
    for investigation_id, raw in investigation_raw.items():
        if "asset insp" in str(raw.get("INSPTEMPLATENAME") or "").casefold():
            continue
        for asset_ref in investigation_refs.get(investigation_id, set()):
            related = ", ".join(sorted(investigation_related.get((investigation_id, asset_ref), set())))
            record = _common("investigation", raw, "Linked investigation", related)
            record.update({"asset_type": asset_ref[0], "asset_id": asset_ref[1]})
            result["investigations"].append(record)
    for request_id, raw in request_raw.items():
        for asset_ref in request_refs.get(request_id, set()):
            paths = sorted(request_paths.get((request_id, asset_ref), set()))
            related = ", ".join(sorted(request_related.get((request_id, asset_ref), set())))
            record = _common("service_request", raw, ", ".join(paths), related)
            record.update({"asset_type": asset_ref[0], "asset_id": asset_ref[1], "relationship_paths": paths})
            result["service_requests"].append(record)
    return result


def record_detail(kind: str, record_id: str, *, work_zone_id: str = "") -> dict[str, Any]:
    config = _config()
    if kind == "itpipes_defect":
        _, path = _source(config, "itpipesIntermediate")
        table = _itpipes_table(config, "defects")
        with closing(_connect(path)) as connection:
            columns = _columns(connection, table)
            id_field = _required_column(columns, table, "MLO_ID")
            rows = _rows(connection.execute(
                f"SELECT * FROM {_quote(table)} WHERE regexp_replace(CAST({_quote(id_field)} AS VARCHAR), '\\.0+$', '')=? LIMIT 1",
                [_id(record_id)],
            ))
        if not rows:
            raise HTTPException(status_code=404, detail="The requested ITPipes defect was not found.")
        return {
            "kind": kind,
            "record_id": _id(record_id),
            "fields": rows[0],
            "questions": [],
        }

    if kind == "pipe_risk":
        _, path = _source(config, "priorityPipes")
        table = _priority_pipes_table(config, "scored")
        with closing(_connect(path)) as connection:
            columns = _columns(connection, table)
            asset_field = _required_column(columns, table, "ITPIPE_ASSETID")
            zone_field = _column(columns, "WorkZoneID")
            parameters: list[str] = [_id(record_id)]
            zone_sql = ""
            if work_zone_id and zone_field:
                zone_sql = f" AND CAST({_quote(zone_field)} AS VARCHAR)=?"
                parameters.append(str(work_zone_id))
            rows = _rows(connection.execute(
                f"SELECT * FROM {_quote(table)} WHERE upper(CAST({_quote(asset_field)} AS VARCHAR))=upper(?)"
                f"{zone_sql} LIMIT 1",
                parameters,
            ))
        if not rows:
            raise HTTPException(status_code=404, detail="The requested priority-pipe risk record was not found.")
        return {
            "kind": kind,
            "record_id": _id(record_id),
            "fields": rows[0],
            "questions": [],
        }

    _, path = _source(config, "cityworks")
    tables = config.get("cityworksTables", {})
    definitions = {
        "service_request": (str(tables.get("request") or ""), "REQUESTID"),
        "investigation": (str(tables.get("inspection") or ""), "INSPECTIONID"),
        "inspection": (str(tables.get("inspection") or ""), "INSPECTIONID"),
        "work_order": (str(tables.get("workOrder") or ""), "WORKORDERID"),
    }
    if kind not in definitions:
        raise HTTPException(status_code=422, detail="Unsupported Asset History record type.")
    table, id_field = definitions[kind]
    with closing(_connect(path)) as connection:
        rows = _rows(connection.execute(
            f"SELECT * FROM {_quote(table)} WHERE regexp_replace(CAST({_quote(id_field)} AS VARCHAR), '\\.0+$', '')=? LIMIT 1",
            [_id(record_id)],
        ))
        questions: list[dict[str, Any]] = []
        if kind in {"inspection", "investigation"} and rows:
            question_table = str(tables.get("inspectionQuestion") or "")
            if question_table:
                _columns(connection, question_table)
                questions = _rows(connection.execute(
                    f"SELECT * FROM {_quote(question_table)} WHERE regexp_replace(CAST(INSPECTIONID AS VARCHAR), '\\.0+$', '')=? ORDER BY QUESTIONSEQUENCE, INSPQUESTIONID",
                    [_id(record_id)],
                ))
    if not rows:
        raise HTTPException(status_code=404, detail="The requested Cityworks record was not found.")
    return {"kind": kind, "record_id": _id(record_id), "fields": {key: value for key, value in rows[0].items() if value not in (None, "")}, "questions": questions}
