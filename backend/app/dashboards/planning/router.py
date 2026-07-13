from __future__ import annotations

import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Query

from backend.app.core.data_sources import critical_team_data_source, portal_env
from backend.app.core.records import clean_record
from backend.app.core.sql import bracket_identifier, qualified_table_name
from backend.app.dashboards.critical_team.router import critical_team_connection, fetch_all
from backend.app.management.database import SYSTEM_TABLES, management_database_path


router = APIRouter(prefix="/api/planning", tags=["planning"])

PENDING_AIF_SORT_EXPRESSIONS = {
    "inspection_id": "inspection_id",
    "asset_id": "asset_id",
    "team": "team",
    "inspection_date": "inspection_date",
    "inspection_by": "inspection_by",
    "inspection_status": "inspection_status",
    "submit_to": "submit_to",
    "related_workorder_id": "related_workorder_id",
    "related_wo_status": "related_wo_status",
    "critical_team_status": "critical_team_status",
    "investigation_id": "investigation_id",
    "investigation_status": "investigation_status",
}

PENDING_AIF_CATEGORY_COLUMNS = [
    "team",
    "inspection_by",
    "inspection_status",
    "submit_to",
    "related_wo_status",
    "critical_team_status",
    "investigation_status",
]

PENDING_AIF_LINK_COLUMNS = {
    "inspection_id": "inspection",
    "related_workorder_id": "workorder",
    "investigation_id": "investigation",
}

DEFAULT_CITYWORKS_INSPECTION_URL_TEMPLATE = (
    "https://cityworksprod.ci.charlotte.nc.us/Stormwater_OfficeCompanion/"
    "WorkManagement/InspectionEdit.aspx?InspectionId={id}"
)
DEFAULT_CITYWORKS_WORKORDER_URL_TEMPLATE = (
    "https://cityworksprod.ci.charlotte.nc.us/Stormwater_OfficeCompanion/"
    "WorkManagement/WOGeneralEdit.aspx?WorkOrderId={id}"
)

PENDING_AIF_SQL_CATEGORY_COLUMNS = [
    column for column in PENDING_AIF_CATEGORY_COLUMNS if column != "team"
]

PENDING_AIF_OUTPUT_COLUMNS = [
    "inspection_id",
    "asset_id",
    "inspection_date",
    "inspection_by",
    "inspection_status",
    "submit_to",
    "related_workorder_id",
    "related_wo_status",
    "critical_team_status",
    "investigation_id",
    "investigation_status",
]

PENDING_AIF_SEARCH_COLUMNS = [
    "inspection_id",
    "asset_id",
    "team",
    "inspection_by",
    "inspection_status",
    "submit_to",
    "related_workorder_id",
    "related_wo_status",
    "critical_team_status",
    "investigation_id",
    "investigation_status",
]


def sql_identifier(identifier: str) -> str:
    return bracket_identifier(identifier)


def normalize_person_lookup_value(value: Any) -> str:
    text = str(value or "").strip().casefold()
    text = re.sub(r"\s+", " ", text)
    return re.sub(r"\s*,\s*", ", ", text)


def person_lookup_keys(value: Any) -> set[str]:
    normalized = normalize_person_lookup_value(value)
    if not normalized:
        return set()

    keys = {normalized}
    if "," in normalized:
        last_name, first_name = [part.strip() for part in normalized.split(",", 1)]
        if first_name and last_name:
            keys.add(f"{first_name} {last_name}")
            keys.add(f"{last_name} {first_name}")
            keys.add(f"{last_name}, {first_name}")
    return keys


def pending_aif_person_team_lookup() -> dict[str, str]:
    path = management_database_path()
    if not path.exists():
        return {}

    user_table = sql_identifier(SYSTEM_TABLES["users"])
    team_table = sql_identifier(SYSTEM_TABLES["teams"])
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            f"""
            SELECT
                u.first_name,
                u.last_name,
                u.email,
                u.username,
                t.name AS team_name
            FROM {user_table} AS u
            LEFT JOIN {team_table} AS t
                ON t.id = u.team_id
            WHERE u.deleted_at IS NULL
              AND u.is_active = 1
              AND NULLIF(TRIM(t.name), '') IS NOT NULL
            """
        ).fetchall()
    finally:
        connection.close()

    lookup: dict[str, str] = {}
    for row in rows:
        first_name = str(row["first_name"] or "").strip()
        last_name = str(row["last_name"] or "").strip()
        team_name = str(row["team_name"] or "").strip()
        values = [
            row["email"],
            row["username"],
            f"{first_name} {last_name}",
            f"{last_name}, {first_name}",
            f"{last_name} {first_name}",
        ]
        for value in values:
            for key in person_lookup_keys(value):
                lookup.setdefault(key, team_name)
    return lookup


def enrich_pending_aif_team(record: dict[str, Any], lookup: dict[str, str]) -> dict[str, Any]:
    team_name: str | None = None
    for field in ("submit_to", "inspection_by"):
        for key in person_lookup_keys(record.get(field)):
            if key in lookup:
                team_name = lookup[key]
                break
        if team_name:
            break
    return {**record, "team": team_name}


def record_matches_pending_aif_search(record: dict[str, Any], search: str | None) -> bool:
    needle = str(search or "").strip().casefold()
    if not needle:
        return True
    return any(needle in str(record.get(column) or "").casefold() for column in PENDING_AIF_SEARCH_COLUMNS)


def pending_aif_sort_value(value: Any) -> tuple[int, Any]:
    if value is None or value == "":
        return (1, "")
    if isinstance(value, bool):
        return (0, int(value))
    if isinstance(value, (int, float)):
        return (0, value)
    return (0, str(value).casefold())


def sorted_pending_aif_records(records: list[dict[str, Any]], sort_by: str, sort_dir: str) -> list[dict[str, Any]]:
    sort_key = sort_by if sort_by in PENDING_AIF_SORT_EXPRESSIONS else "inspection_id"
    populated = [record for record in records if record.get(sort_key) not in (None, "")]
    empty = [record for record in records if record.get(sort_key) in (None, "")]
    populated.sort(
        key=lambda record: (
            pending_aif_sort_value(record.get(sort_key)),
            pending_aif_sort_value(record.get("inspection_id")),
        ),
        reverse=sort_dir.lower() == "desc",
    )
    return [*populated, *empty]


def pending_aif_source_cte() -> str:
    source = critical_team_data_source()
    schema = source.schema or "azteca"
    inspection_table = qualified_table_name(schema, "INSPECTION")
    workorder_entity_table = qualified_table_name(schema, "WORKORDERENTITY")
    workorder_table = qualified_table_name(schema, "WORKORDER")
    wocustfield_table = qualified_table_name(schema, "WOCUSTFIELD")
    activity_link_table = qualified_table_name(schema, "ACTIVITYLINK")

    return f"""
        WITH asset_inspections AS (
            SELECT
                TRY_CONVERT(bigint, i.INSPECTIONID) AS inspection_id,
                CAST(i.ENTITYUID AS varchar(255)) AS asset_id,
                TRY_CONVERT(datetime2, i.INSPDATE) AS inspection_date,
                CAST(i.INSPECTEDBY AS varchar(255)) AS inspection_by,
                CAST(i.STATUS AS varchar(255)) AS inspection_status,
                CAST(i.SUBMITTONAME AS varchar(255)) AS submit_to,
                CAST(i.LOCATION AS varchar(500)) AS location,
                TRY_CONVERT(datetime2, i.ACTFINISHDATE) AS actual_finish,
                TRY_CONVERT(bigint, i.REQUESTID) AS request_id,
                CAST(i.DISTRICT AS varchar(255)) AS council_district,
                CAST(i.SHOP AS varchar(255)) AS watershed,
                CAST(i.PRIORITY AS varchar(255)) AS classification,
                CAST(i.ENTITYTYPE AS varchar(255)) AS entity_type,
                CAST(i.INSPTEMPLATENAME AS varchar(255)) AS inspection_template_name
            FROM {inspection_table} AS i
            WHERE i.INSPTEMPLATENAME LIKE '%Asset Insp%'
              AND i.ENTITYTYPE IN ('CHANNELS', 'PIPES', 'STRUCTURES')
              AND i.STATUS = 'PENDING'
        ),
        asset_workorders_ranked AS (
            SELECT
                CAST(woe.ENTITYUID AS varchar(255)) AS asset_id,
                TRY_CONVERT(bigint, wo.WORKORDERID) AS related_workorder_id,
                CAST(wo.STATUS AS varchar(255)) AS related_wo_status,
                CAST(cf17.CUSTFIELDVALUE AS varchar(255)) AS critical_team_status,
                ROW_NUMBER() OVER (
                    PARTITION BY woe.ENTITYUID
                    ORDER BY TRY_CONVERT(bigint, wo.WORKORDERID) DESC
                ) AS rn
            FROM {workorder_entity_table} AS woe
            INNER JOIN {workorder_table} AS wo
                ON wo.WORKORDERID = woe.WORKORDERID
            LEFT JOIN {wocustfield_table} AS cf17
                ON cf17.WORKORDERID = wo.WORKORDERID
               AND cf17.CUSTFIELDID = 17
            WHERE woe.ENTITYTYPE IN ('PIPES', 'STRUCTURES', 'CHANNELS')
              AND woe.ENTITYUID IS NOT NULL
              AND wo.DESCRIPTION = 'Critical Asset Inspection'
        ),
        asset_workorders AS (
            SELECT
                asset_id,
                related_workorder_id,
                related_wo_status,
                critical_team_status
            FROM asset_workorders_ranked
            WHERE rn = 1
        ),
        investigations_raw AS (
            SELECT
                TRY_CONVERT(bigint, al.DESTACTIVITYID) AS inspection_id,
                TRY_CONVERT(bigint, al.SOURCEACTIVITYID) AS investigation_id,
                CAST(inv.STATUS AS varchar(255)) AS investigation_status
            FROM {activity_link_table} AS al
            INNER JOIN {inspection_table} AS inv
                ON al.SOURCEACTIVITYID = inv.INSPECTIONID
            WHERE inv.INSPTEMPLATENAME NOT LIKE '%Asset Insp%'
              AND al.SOURCEACTIVITYTYPE = 'Inspection'
              AND al.DESTACTIVITYTYPE = 'Inspection'

            UNION ALL

            SELECT
                TRY_CONVERT(bigint, al.SOURCEACTIVITYID) AS inspection_id,
                TRY_CONVERT(bigint, al.DESTACTIVITYID) AS investigation_id,
                CAST(inv.STATUS AS varchar(255)) AS investigation_status
            FROM {activity_link_table} AS al
            INNER JOIN {inspection_table} AS inv
                ON al.DESTACTIVITYID = inv.INSPECTIONID
            WHERE inv.INSPTEMPLATENAME NOT LIKE '%Asset Insp%'
              AND al.SOURCEACTIVITYTYPE = 'Inspection'
              AND al.DESTACTIVITYTYPE = 'Inspection'
        ),
        investigations_ranked AS (
            SELECT
                inspection_id,
                investigation_id,
                investigation_status,
                ROW_NUMBER() OVER (
                    PARTITION BY inspection_id
                    ORDER BY investigation_id DESC
                ) AS rn
            FROM investigations_raw
        ),
        investigations AS (
            SELECT
                inspection_id,
                investigation_id,
                investigation_status
            FROM investigations_ranked
            WHERE rn = 1
        ),
        pending_aif_forms AS (
            SELECT
                i.inspection_id,
                i.asset_id,
                i.inspection_date,
                i.inspection_by,
                i.inspection_status,
                i.submit_to,
                w.related_workorder_id,
                w.related_wo_status,
                w.critical_team_status,
                inv.investigation_id,
                inv.investigation_status
            FROM asset_inspections AS i
            LEFT JOIN asset_workorders AS w
                ON i.asset_id = w.asset_id
            LEFT JOIN investigations AS inv
                ON i.inspection_id = inv.inspection_id
        )
    """


def add_number_filter(
    clauses: list[str],
    params: list[Any],
    expression: str,
    mode: str,
    value_from: int | None,
    value_to: int | None,
) -> None:
    if mode == "exact" and value_from is not None:
        clauses.append(f"{expression} = ?")
        params.append(value_from)
    elif mode == "greater" and value_from is not None:
        clauses.append(f"{expression} > ?")
        params.append(value_from)
    elif mode == "less" and value_from is not None:
        clauses.append(f"{expression} < ?")
        params.append(value_from)
    elif mode == "between":
        if value_from is not None:
            clauses.append(f"{expression} >= ?")
            params.append(value_from)
        if value_to is not None:
            clauses.append(f"{expression} <= ?")
            params.append(value_to)


def add_date_filter(
    clauses: list[str],
    params: list[Any],
    column: str,
    mode: str,
    date_from: str | None,
    date_to: str | None,
) -> None:
    start_date = date_from.strip() if date_from else ""
    end_date = date_to.strip() if date_to else ""
    date_expression = f"CAST({sql_identifier(column)} AS DATE)"

    if mode == "exact" and start_date:
        clauses.append(f"{date_expression} = CAST(? AS DATE)")
        params.append(start_date)
    elif mode == "before" and start_date:
        clauses.append(f"{date_expression} < CAST(? AS DATE)")
        params.append(start_date)
    elif mode == "after" and start_date:
        clauses.append(f"{date_expression} > CAST(? AS DATE)")
        params.append(start_date)
    elif mode == "between":
        if start_date:
            clauses.append(f"{date_expression} >= CAST(? AS DATE)")
            params.append(start_date)
        if end_date:
            clauses.append(f"{date_expression} <= CAST(? AS DATE)")
            params.append(end_date)


def add_category_filter(clauses: list[str], params: list[Any], column: str, values: list[str] | None) -> None:
    selected = [value for value in values or [] if value]
    if not selected:
        return
    placeholders = ", ".join(["?"] * len(selected))
    clauses.append(f"{sql_identifier(column)} IN ({placeholders})")
    params.extend(selected)


def pending_aif_link_templates() -> dict[str, str]:
    inspection_template = portal_env("PORTAL_CITYWORKS_INSPECTION_URL_TEMPLATE") or DEFAULT_CITYWORKS_INSPECTION_URL_TEMPLATE
    return {
        "inspection_id": inspection_template,
        "related_workorder_id": portal_env("PORTAL_CITYWORKS_WORKORDER_URL_TEMPLATE") or DEFAULT_CITYWORKS_WORKORDER_URL_TEMPLATE,
        "investigation_id": portal_env("PORTAL_CITYWORKS_INVESTIGATION_URL_TEMPLATE") or inspection_template,
    }


def render_link(template: str, value: Any) -> str:
    if not template or value is None or value == "":
        return ""
    text = str(value)
    return template.replace("{id}", text).replace("{value}", text)


def attach_links(record: dict[str, Any], templates: dict[str, str]) -> dict[str, Any]:
    links = {
        column: render_link(templates.get(column, ""), record.get(column))
        for column in PENDING_AIF_LINK_COLUMNS
    }
    return {**record, "_links": {column: url for column, url in links.items() if url}}


@router.get("/pending-aif/filter-options")
def pending_aif_filter_options() -> dict[str, Any]:
    with critical_team_connection() as con:
        cursor = con.cursor()
        options: dict[str, list[Any]] = {}
        for column in PENDING_AIF_SQL_CATEGORY_COLUMNS:
            names, rows = fetch_all(
                cursor,
                f"""
                {pending_aif_source_cte()}
                SELECT DISTINCT {sql_identifier(column)} AS value
                FROM pending_aif_forms
                WHERE NULLIF(LTRIM(RTRIM(CAST({sql_identifier(column)} AS varchar(4000)))), '') IS NOT NULL
                ORDER BY value
                """,
            )
            options[column] = [clean_record(dict(zip(names, row)))["value"] for row in rows]

        names, rows = fetch_all(
            cursor,
            f"""
            {pending_aif_source_cte()}
            SELECT
                inspection_by,
                submit_to
            FROM pending_aif_forms
            """,
        )
    team_lookup = pending_aif_person_team_lookup()
    team_values = {
        enriched["team"]
        for enriched in (
            enrich_pending_aif_team(clean_record(dict(zip(names, row))), team_lookup)
            for row in rows
        )
        if enriched.get("team")
    }
    options["team"] = sorted(team_values, key=lambda value: str(value).casefold())
    return options


@router.get("/pending-aif")
def pending_aif_rows(
    search: str | None = Query(default=None),
    asset_id_filter: str | None = Query(default=None),
    inspection_id_mode: str = Query(default="any", pattern="^(any|exact|between|greater|less)$"),
    inspection_id_from: int | None = Query(default=None),
    inspection_id_to: int | None = Query(default=None),
    related_workorder_id_mode: str = Query(default="any", pattern="^(any|exact|between|greater|less)$"),
    related_workorder_id_from: int | None = Query(default=None),
    related_workorder_id_to: int | None = Query(default=None),
    investigation_id_mode: str = Query(default="any", pattern="^(any|exact|between|greater|less)$"),
    investigation_id_from: int | None = Query(default=None),
    investigation_id_to: int | None = Query(default=None),
    inspection_by_filter: list[str] | None = Query(default=None),
    inspection_status_filter: list[str] | None = Query(default=None),
    submit_to_filter: list[str] | None = Query(default=None),
    team_filter: list[str] | None = Query(default=None),
    related_wo_status_filter: list[str] | None = Query(default=None),
    critical_team_status_filter: list[str] | None = Query(default=None),
    investigation_status_filter: list[str] | None = Query(default=None),
    inspection_date_mode: str = Query(default="any", pattern="^(any|exact|between|before|after)$"),
    inspection_date_from: str | None = Query(default=None),
    inspection_date_to: str | None = Query(default=None),
    sort_by: str = Query(default="inspection_id"),
    sort_dir: str = Query(default="asc", pattern="^(asc|desc)$"),
    limit: int = Query(default=100, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []

    if asset_id_filter and asset_id_filter.strip():
        clauses.append("CAST(asset_id AS varchar(4000)) LIKE ?")
        params.append(f"%{asset_id_filter.strip()}%")

    add_number_filter(clauses, params, "inspection_id", inspection_id_mode, inspection_id_from, inspection_id_to)
    add_number_filter(
        clauses,
        params,
        "related_workorder_id",
        related_workorder_id_mode,
        related_workorder_id_from,
        related_workorder_id_to,
    )
    add_number_filter(clauses, params, "investigation_id", investigation_id_mode, investigation_id_from, investigation_id_to)
    add_category_filter(clauses, params, "inspection_by", inspection_by_filter)
    add_category_filter(clauses, params, "inspection_status", inspection_status_filter)
    add_category_filter(clauses, params, "submit_to", submit_to_filter)
    add_category_filter(clauses, params, "related_wo_status", related_wo_status_filter)
    add_category_filter(clauses, params, "critical_team_status", critical_team_status_filter)
    add_category_filter(clauses, params, "investigation_status", investigation_status_filter)
    add_date_filter(clauses, params, "inspection_date", inspection_date_mode, inspection_date_from, inspection_date_to)

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    templates = pending_aif_link_templates()

    with critical_team_connection() as con:
        cursor = con.cursor()
        names, rows = fetch_all(
            cursor,
            f"""
            {pending_aif_source_cte()}
            SELECT
                {", ".join(sql_identifier(column) for column in PENDING_AIF_OUTPUT_COLUMNS)}
            FROM pending_aif_forms
            {where_sql}
            """,
            params,
        )

    team_lookup = pending_aif_person_team_lookup()
    records = [
        enrich_pending_aif_team(clean_record(dict(zip(names, row))), team_lookup)
        for row in rows
    ]
    records = [record for record in records if record_matches_pending_aif_search(record, search)]
    selected_teams = {value for value in team_filter or [] if value}
    if selected_teams:
        records = [record for record in records if record.get("team") in selected_teams]

    records = sorted_pending_aif_records(records, sort_by, sort_dir)
    total = len(records)
    paged_records = records[offset: offset + limit]
    paged_records = [attach_links(record, templates) for record in paged_records]
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "link_columns": PENDING_AIF_LINK_COLUMNS,
        "rows": paged_records,
    }
