from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

import duckdb
import pyodbc
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.core.data_sources import (
    CriticalTeamDataSource,
    critical_assets_data_source,
    critical_team_connection_string,
    critical_team_data_source,
)
from backend.app.core.records import clean_record
from backend.app.core.sql import bracket_identifier, qualified_table_name
from backend.app.management.database import get_db
from backend.app.management.models import Team, User
from backend.app.management.router import get_current_user
from backend.app.management.services import ADMIN_ROLES, selected_user_role


router = APIRouter(prefix="/api/critical-team", tags=["critical-team"])

CRITICAL_FACILITY_RISK_TABLE = "critical_facility_highest_risk_assets_by_facility"
CRITICAL_FACILITY_RISK_FACILITY_COLUMN = "FacilityID"
CRITICAL_FACILITY_RISK_VALUE_COLUMN = "COND_RISK"
CRITICAL_TEAM_DATE_COLUMNS = {
    "project_start": "project_start_date",
    "inspection_complete": "inspection_complete_date",
    "report_complete": "report_complete_date",
    "work_order_closed": "wo_closed_date",
}
CRITICAL_TEAM_WORKORDER_SORT_EXPRESSIONS = {
    "workorder_id": "workorders_id",
    "facility_id": "TRY_CONVERT(BIGINT, facility_id)",
    "submit_to": "submit_to",
    "wo_closed_by": "wo_closed_by",
    "critical_team_status": "critical_team_status",
    "project_start_date": "project_start_date",
    "inspection_complete_date": "inspection_complete_date",
    "report_complete_date": "report_complete_date",
    "wo_closed_date": "wo_closed_date",
}
CRITICAL_TEAM_DEFAULT_YEARS = [str(date.today().year - 1), str(date.today().year)]
CRITICAL_TEAM_OVERVIEW_SERIES = [
    ("project_started", "Project Started", "project_start_date", None, "#155e75"),
    ("inspections_completed", "Inspections Complete", "inspection_complete_date", None, "#4e79a7"),
    ("reports_completed", "Reports Complete", "report_complete_date", None, "#f28e2b"),
    ("review_complete", "Review Complete", "wo_closed_date", "Review Complete", "#7b5ea7"),
]
SUBMIT_TO_SCOPED_SHEET_IDS = {
    "insp-proj-start-date",
    "insp-comp-date-bar-chart",
    "insp-comp-date-table",
    "report-comp-date-chart",
    "report-comp-date-table",
}
CLOSED_BY_SCOPED_SHEET_IDS = {
    "insp-comp-date-reviews",
    "insp-comp-date-reviews-table",
}
CRITICAL_TEAM_SHEETS = {
    "insp-proj-start-date": {
        "title": "Insp_Proj_Start_Date",
        "kind": "chart",
        "date_key": "project_start",
        "group_column": "submit_to",
        "default_years": CRITICAL_TEAM_DEFAULT_YEARS,
        "default_statuses": [],
        "exclude_blank_group": False,
    },
    "insp-comp-date-bar-chart": {
        "title": "Insp_Comp_Date_Bar_Chart",
        "kind": "chart",
        "date_key": "inspection_complete",
        "group_column": "submit_to",
        "default_years": CRITICAL_TEAM_DEFAULT_YEARS,
        "default_statuses": [],
        "exclude_blank_group": False,
    },
    "insp-comp-date-table": {
        "title": "Inspection Completion Date",
        "kind": "table",
        "date_key": "inspection_complete",
        "group_column": "submit_to",
        "default_years": CRITICAL_TEAM_DEFAULT_YEARS,
        "default_statuses": [],
        "exclude_blank_group": False,
    },
    "report-comp-date-chart": {
        "title": "Report_Comp_Date_Chart",
        "kind": "chart",
        "date_key": "report_complete",
        "group_column": "submit_to",
        "default_years": CRITICAL_TEAM_DEFAULT_YEARS,
        "default_statuses": [],
        "exclude_blank_group": False,
    },
    "report-comp-date-table": {
        "title": "Report Completion Date",
        "kind": "table",
        "date_key": "report_complete",
        "group_column": "submit_to",
        "default_years": CRITICAL_TEAM_DEFAULT_YEARS,
        "default_statuses": [],
        "exclude_blank_group": False,
    },
    "insp-comp-date-reviews": {
        "title": "Insp_Comp_Date_Reviews",
        "kind": "chart",
        "date_key": "work_order_closed",
        "group_column": "wo_closed_by",
        "default_years": CRITICAL_TEAM_DEFAULT_YEARS,
        "default_statuses": ["Ready For Review", "Review Complete"],
        "exclude_blank_group": True,
    },
    "insp-comp-date-reviews-table": {
        "title": "Review Completion Date",
        "kind": "table",
        "date_key": "work_order_closed",
        "group_column": "wo_closed_by",
        "default_years": CRITICAL_TEAM_DEFAULT_YEARS,
        "default_statuses": ["Review Complete"],
        "exclude_blank_group": True,
    },
}


CRITICAL_TEAM_COLUMNS = [
    ("workorder_id", "varchar"),
    ("workorders_id", "bigint"),
    ("description", "varchar"),
    ("submit_to", "varchar"),
    ("wo_closed_by", "varchar"),
    ("status", "varchar"),
    ("project_start_date", "datetime2"),
    ("wo_closed_date", "datetime2"),
    ("facility_id", "varchar"),
    ("inspection_complete_date", "date"),
    ("report_complete_date", "date"),
    ("critical_team_status", "varchar"),
    ("condition_risk", "double"),
]


def sql_identifier(identifier: str) -> str:
    return bracket_identifier(identifier)


def critical_team_user_is_manager(db: Session, user: User) -> bool:
    return db.scalar(
        select(Team.id).where(
            Team.manager_user_id == user.id,
            Team.is_active == 1,
        ).limit(1)
    ) is not None


def critical_team_submit_to_scope(db: Session, user: User) -> tuple[bool, str | None]:
    if selected_user_role(user) in ADMIN_ROLES or critical_team_user_is_manager(db, user):
        return False, None

    first_name = str(user.first_name or "").strip()
    last_name = str(user.last_name or "").strip()
    if not first_name or not last_name:
        raise HTTPException(
            status_code=403,
            detail="Your profile must include a first and last name to access this resource.",
        )
    return True, f"{last_name}, {first_name}"


def scoped_submit_to_values(
    db: Session,
    user: User,
    requested_values: list[str] | None,
    *,
    apply_scope: bool,
) -> list[str] | None:
    if not apply_scope:
        return requested_values
    restricted, submit_to_value = critical_team_submit_to_scope(db, user)
    return [submit_to_value] if restricted and submit_to_value else requested_values


def scoped_closed_by_value(
    db: Session,
    user: User,
    requested_value: str | None,
    *,
    apply_scope: bool,
) -> str | None:
    if not apply_scope:
        return requested_value
    restricted, closed_by_value = critical_team_submit_to_scope(db, user)
    return closed_by_value if restricted and closed_by_value else requested_value


def duckdb_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def normalize_facility_id(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def critical_team_connection() -> pyodbc.Connection:
    source = critical_team_data_source()
    if source.source_type.lower() != "sqlserver":
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Critical Team datasource must be configured as SQL Server.",
                "source_type": source.source_type,
            },
        )

    try:
        return pyodbc.connect(
            critical_team_connection_string(source),
            timeout=source.timeout_seconds,
        )
    except pyodbc.Error as error:
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Could not connect to the Critical Team SQL Server datasource.",
                "server": source.server,
                "database": source.database,
                "error": str(error),
            },
        ) from error


def critical_team_source_cte(source: CriticalTeamDataSource | None = None) -> str:
    source = source or critical_team_data_source()
    workorder_table = qualified_table_name(source.schema, source.workorder_table)
    wocustfield_table = qualified_table_name(source.schema, source.wocustfield_table)

    return f"""
        WITH custom_fields AS (
            SELECT
                WORKORDERID,
                MAX(WORKORDERSID) AS WORKORDERSID,
                MAX(CASE WHEN CUSTFIELDID = 6 THEN NULLIF(LTRIM(RTRIM(CUSTFIELDVALUE)), '') END) AS FACILITY_ID,
                MAX(CASE WHEN CUSTFIELDID = 7 THEN TRY_CONVERT(date, NULLIF(LTRIM(RTRIM(CUSTFIELDVALUE)), '')) END) AS INSP_COMP_DATE,
                MAX(CASE WHEN CUSTFIELDID = 10 THEN TRY_CONVERT(date, NULLIF(LTRIM(RTRIM(CUSTFIELDVALUE)), '')) END) AS REPORT_COMP_DATE,
                MAX(CASE WHEN CUSTFIELDID = 17 THEN NULLIF(LTRIM(RTRIM(CUSTFIELDVALUE)), '') END) AS CRITICAL_TEAM_STATUS
            FROM {wocustfield_table}
            WHERE CUSTFIELDID IN (6, 7, 10, 17)
            GROUP BY WORKORDERID
        ),
        critical_team_workorders AS (
            SELECT
                CAST(wo.WORKORDERID AS varchar(64)) AS workorder_id,
                TRY_CONVERT(bigint, cf.WORKORDERSID) AS workorders_id,
                CAST(wo.DESCRIPTION AS varchar(255)) AS description,
                CAST(wo.SUBMITTO AS varchar(255)) AS submit_to,
                CAST(wo.WOCLOSEDBY AS varchar(255)) AS wo_closed_by,
                CAST(wo.STATUS AS varchar(255)) AS status,
                TRY_CONVERT(datetime2, wo.PROJSTARTDATE) AS project_start_date,
                TRY_CONVERT(datetime2, wo.DATEWOCLOSED) AS wo_closed_date,
                CAST(cf.FACILITY_ID AS varchar(255)) AS facility_id,
                TRY_CONVERT(date, cf.INSP_COMP_DATE) AS inspection_complete_date,
                TRY_CONVERT(date, cf.REPORT_COMP_DATE) AS report_complete_date,
                CAST(cf.CRITICAL_TEAM_STATUS AS varchar(255)) AS critical_team_status
            FROM {workorder_table} AS wo
            LEFT JOIN custom_fields AS cf
                ON cf.WORKORDERID = wo.WORKORDERID
            WHERE wo.DESCRIPTION = ?
        )
    """


def critical_team_base_params(source: CriticalTeamDataSource | None = None) -> list[Any]:
    source = source or critical_team_data_source()
    return [source.description_filter]


def fetch_all(cursor: pyodbc.Cursor, sql: str, params: list[Any] | None = None) -> tuple[list[str], list[Any]]:
    cursor.execute(sql, params or [])
    names = [description[0] for description in cursor.description]
    return names, cursor.fetchall()


def fetch_one(cursor: pyodbc.Cursor, sql: str, params: list[Any] | None = None) -> tuple[list[str], Any]:
    cursor.execute(sql, params or [])
    names = [description[0] for description in cursor.description]
    return names, cursor.fetchone()


def critical_facility_condition_risk_by_facility(facility_ids: list[Any]) -> dict[str, float | None]:
    normalized_ids = sorted({normalized for value in facility_ids if (normalized := normalize_facility_id(value))})
    if not normalized_ids:
        return {}

    try:
        source = critical_assets_data_source()
    except HTTPException:
        return {}

    if source.source_type.lower() != "duckdb" or not source.database.exists():
        return {}

    try:
        connection = duckdb.connect(str(source.database), read_only=True)
    except duckdb.Error:
        return {}

    try:
        column_rows = connection.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE lower(table_name) = ?
            """,
            [CRITICAL_FACILITY_RISK_TABLE.lower()],
        ).fetchall()
        columns_by_lower = {str(row[0]).lower(): str(row[0]) for row in column_rows}
        facility_column = columns_by_lower.get(CRITICAL_FACILITY_RISK_FACILITY_COLUMN.lower())
        condition_risk_column = columns_by_lower.get(CRITICAL_FACILITY_RISK_VALUE_COLUMN.lower())
        if not facility_column or not condition_risk_column:
            return {}

        placeholders = ", ".join(["?"] * len(normalized_ids))
        rows = connection.execute(
            f"""
            WITH ranked_condition_risk AS (
                SELECT
                    trim(cast({duckdb_identifier(facility_column)} AS varchar)) AS facility_id,
                    try_cast({duckdb_identifier(condition_risk_column)} AS double) AS condition_risk,
                    row_number() OVER (
                        PARTITION BY trim(cast({duckdb_identifier(facility_column)} AS varchar))
                        ORDER BY try_cast({duckdb_identifier(condition_risk_column)} AS double) DESC NULLS LAST
                    ) AS condition_risk_rank
                FROM {duckdb_identifier(CRITICAL_FACILITY_RISK_TABLE)}
                WHERE trim(cast({duckdb_identifier(facility_column)} AS varchar)) IN ({placeholders})
            )
            SELECT facility_id, condition_risk
            FROM ranked_condition_risk
            WHERE condition_risk_rank = 1
            """,
            normalized_ids,
        ).fetchall()
    except duckdb.Error:
        return {}
    finally:
        connection.close()

    return {normalize_facility_id(facility_id): condition_risk for facility_id, condition_risk in rows}


def critical_facility_ids_for_condition_risk_filter(
    mode: str,
    value_from: float | None,
    value_to: float | None,
) -> list[str] | None:
    if mode == "any":
        return None
    if mode in {"exact", "greater", "less"} and value_from is None:
        return None
    if mode == "between" and value_from is None and value_to is None:
        return None

    try:
        source = critical_assets_data_source()
    except HTTPException:
        return []

    if source.source_type.lower() != "duckdb" or not source.database.exists():
        return []

    try:
        connection = duckdb.connect(str(source.database), read_only=True)
    except duckdb.Error:
        return []

    try:
        column_rows = connection.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE lower(table_name) = ?
            """,
            [CRITICAL_FACILITY_RISK_TABLE.lower()],
        ).fetchall()
        columns_by_lower = {str(row[0]).lower(): str(row[0]) for row in column_rows}
        facility_column = columns_by_lower.get(CRITICAL_FACILITY_RISK_FACILITY_COLUMN.lower())
        condition_risk_column = columns_by_lower.get(CRITICAL_FACILITY_RISK_VALUE_COLUMN.lower())
        if not facility_column or not condition_risk_column:
            return []

        filter_clauses = ["condition_risk IS NOT NULL"]
        filter_params: list[Any] = []
        if mode == "exact" and value_from is not None:
            filter_clauses.append("condition_risk = ?")
            filter_params.append(value_from)
        elif mode == "greater" and value_from is not None:
            filter_clauses.append("condition_risk > ?")
            filter_params.append(value_from)
        elif mode == "less" and value_from is not None:
            filter_clauses.append("condition_risk < ?")
            filter_params.append(value_from)
        elif mode == "between":
            if value_from is not None:
                filter_clauses.append("condition_risk >= ?")
                filter_params.append(value_from)
            if value_to is not None:
                filter_clauses.append("condition_risk <= ?")
                filter_params.append(value_to)

        rows = connection.execute(
            f"""
            WITH ranked_condition_risk AS (
                SELECT
                    trim(cast({duckdb_identifier(facility_column)} AS varchar)) AS facility_id,
                    try_cast({duckdb_identifier(condition_risk_column)} AS double) AS condition_risk,
                    row_number() OVER (
                        PARTITION BY trim(cast({duckdb_identifier(facility_column)} AS varchar))
                        ORDER BY try_cast({duckdb_identifier(condition_risk_column)} AS double) DESC NULLS LAST
                    ) AS condition_risk_rank
                FROM {duckdb_identifier(CRITICAL_FACILITY_RISK_TABLE)}
            )
            SELECT facility_id
            FROM ranked_condition_risk
            WHERE condition_risk_rank = 1
              AND {" AND ".join(filter_clauses)}
            """,
            filter_params,
        ).fetchall()
    except duckdb.Error:
        return []
    finally:
        connection.close()

    return [normalize_facility_id(row[0]) for row in rows if normalize_facility_id(row[0])]


def attach_condition_risk_to_workorders(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    condition_risk_by_facility = critical_facility_condition_risk_by_facility(
        [row.get("facility_id") for row in rows]
    )
    for row in rows:
        row["condition_risk"] = condition_risk_by_facility.get(normalize_facility_id(row.get("facility_id")))
    return rows


def sortable_number(value: Any) -> float:
    if value is None:
        return 0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def sort_workorders_by_condition_risk(
    rows: list[dict[str, Any]],
    sort_dir: str,
) -> list[dict[str, Any]]:
    descending = sort_dir.lower() == "desc"

    def sort_key(row: dict[str, Any]) -> tuple[bool, float, float, float]:
        condition_risk = row.get("condition_risk")
        condition_risk_is_null = condition_risk is None
        condition_risk_value = sortable_number(condition_risk)
        return (
            condition_risk_is_null,
            -condition_risk_value if descending else condition_risk_value,
            sortable_number(row.get("facility_id")),
            sortable_number(row.get("workorders_id")),
        )

    return sorted(rows, key=sort_key)


def critical_team_sheet(sheet_id: str) -> dict[str, Any]:
    sheet = CRITICAL_TEAM_SHEETS.get(sheet_id)
    if sheet:
        return sheet

    raise HTTPException(
        status_code=404,
        detail={
            "message": "Unknown Critical Team worksheet.",
            "sheet": sheet_id,
            "valid_sheets": sorted(CRITICAL_TEAM_SHEETS),
        },
    )


def critical_team_year_clause(
    date_column: str,
    years: list[str],
) -> tuple[str, list[Any]]:
    if not years:
        return "", []

    include_null = any(year.lower() == "null" for year in years)
    numeric_years = [int(year) for year in years if year.lower() != "null"]
    clauses = []
    params: list[Any] = []

    if numeric_years:
        placeholders = ", ".join(["?"] * len(numeric_years))
        clauses.append(f"YEAR({sql_identifier(date_column)}) IN ({placeholders})")
        params.extend(numeric_years)
    if include_null:
        clauses.append(f"{sql_identifier(date_column)} IS NULL")

    return f"({' OR '.join(clauses)})", params


def parse_filter_date(value: str | None) -> date | None:
    if not value:
        return None

    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"message": "Date filters must use YYYY-MM-DD format.", "value": value},
        ) from None


def critical_team_overview_dates(date_from: str | None, date_to: str | None) -> tuple[date | None, date | None]:
    start = parse_filter_date(date_from)
    end = parse_filter_date(date_to)

    if start and end and start > end:
        start, end = end, start

    return start, end


def overview_date_predicate(date_column: str) -> str:
    date_expression = f"CAST({sql_identifier(date_column)} AS DATE)"
    return (
        f"{date_expression} IS NOT NULL "
        f"AND (date_from IS NULL OR {date_expression} >= date_from) "
        f"AND (date_to IS NULL OR {date_expression} <= date_to)"
    )


def overview_project_scope_predicate() -> str:
    return (
        "(date_from IS NULL AND date_to IS NULL) "
        f"OR {overview_date_predicate('project_start_date')}"
    )


def critical_team_person_filter_sql(
    submit_to: list[str] | None = None,
    closed_by: list[str] | None = None,
) -> tuple[str, list[Any]]:
    clauses = []
    params: list[Any] = []
    submitters = [value for value in submit_to or [] if value]
    reviewers = [value for value in closed_by or [] if value]

    if submitters:
        placeholders = ", ".join(["?"] * len(submitters))
        clauses.append(f"submit_to IN ({placeholders})")
        params.extend(submitters)

    if reviewers:
        placeholders = ", ".join(["?"] * len(reviewers))
        clauses.append(f"wo_closed_by IN ({placeholders})")
        params.extend(reviewers)

    return (f"WHERE {' AND '.join(clauses)}" if clauses else "", params)


def critical_team_filter_sql(
    sheet: dict[str, Any],
    year: list[str] | None = None,
    submit_to: list[str] | None = None,
    closed_by: str | None = None,
    status: list[str] | None = None,
    use_tableau_defaults: bool = True,
) -> tuple[str, list[Any]]:
    date_column = CRITICAL_TEAM_DATE_COLUMNS[sheet["date_key"]]
    clauses = []
    params: list[Any] = []

    years = year if year is not None else (sheet["default_years"] if use_tableau_defaults else [])
    year_clause, year_params = critical_team_year_clause(date_column, years)
    if year_clause:
        clauses.append(year_clause)
        params.extend(year_params)

    statuses = status if status is not None else (sheet["default_statuses"] if use_tableau_defaults else [])
    if statuses:
        placeholders = ", ".join(["?"] * len(statuses))
        clauses.append(f"critical_team_status IN ({placeholders})")
        params.extend(statuses)

    submitters = [value for value in submit_to or [] if value]
    if submitters:
        placeholders = ", ".join(["?"] * len(submitters))
        clauses.append(f"submit_to IN ({placeholders})")
        params.extend(submitters)

    if closed_by:
        clauses.append("wo_closed_by = ?")
        params.append(closed_by)

    if sheet.get("exclude_blank_group"):
        group_column = sheet["group_column"]
        clauses.append(f"NULLIF(TRIM({sql_identifier(group_column)}), '') IS NOT NULL")

    return (f"WHERE {' AND '.join(clauses)}" if clauses else "", params)


@router.get("/source")
def critical_team_source() -> dict[str, Any]:
    source = critical_team_data_source()
    with critical_team_connection() as con:
        cursor = con.cursor()
        row_count = cursor.execute(
            f"""
            {critical_team_source_cte(source)}
            SELECT COUNT(*) AS row_count
            FROM critical_team_workorders
            """,
            critical_team_base_params(source),
        ).fetchone()[0]
        columns = [
            {"name": name, "data_type": data_type, "ordinal_position": index + 1}
            for index, (name, data_type) in enumerate(CRITICAL_TEAM_COLUMNS)
        ]
        metadata = {
            "workbook": source.workbook,
            "source_server": source.server,
            "source_database": source.database,
            "source_tables": source.source_tables,
            "row_count": row_count,
            "imported_at_utc": datetime.now(timezone.utc).isoformat(),
        }

    return {
        "database": f"sqlserver://{source.server}/{source.database}",
        "metadata": clean_record(metadata),
        "columns": columns,
        "sheets": CRITICAL_TEAM_SHEETS,
    }


@router.get("/summary")
def critical_team_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    source = critical_team_data_source()
    effective_submit_to = scoped_submit_to_values(
        db,
        current_user,
        None,
        apply_scope=True,
    )
    where_sql, person_params = critical_team_person_filter_sql(submit_to=effective_submit_to)
    with critical_team_connection() as con:
        cursor = con.cursor()
        names, row = fetch_one(
            cursor,
            """
            {source_cte}
            SELECT
                COUNT(*) AS row_count,
                COUNT(DISTINCT workorder_id) AS workorder_count,
                SUM(CASE WHEN project_start_date IS NOT NULL THEN 1 ELSE 0 END) AS project_started,
                SUM(CASE WHEN inspection_complete_date IS NOT NULL THEN 1 ELSE 0 END) AS inspections_completed,
                SUM(CASE WHEN report_complete_date IS NOT NULL THEN 1 ELSE 0 END) AS reports_completed,
                SUM(CASE WHEN wo_closed_date IS NOT NULL THEN 1 ELSE 0 END) AS workorders_closed,
                SUM(CASE WHEN critical_team_status = 'Ready For Review' THEN 1 ELSE 0 END) AS ready_for_review,
                SUM(CASE WHEN critical_team_status = 'Review Complete' THEN 1 ELSE 0 END) AS review_complete
            FROM critical_team_workorders
            {where_sql}
            """.format(
                source_cte=critical_team_source_cte(source),
                where_sql=where_sql,
            ),
            [*critical_team_base_params(source), *person_params],
        )

    return clean_record(dict(zip(names, row)))


@router.get("/overview")
def critical_team_overview(
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    submit_to: list[str] | None = Query(default=None),
    closed_by: list[str] | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    source = critical_team_data_source()
    start_date, end_date = critical_team_overview_dates(date_from, date_to)
    effective_submit_to = scoped_submit_to_values(
        db,
        current_user,
        submit_to,
        apply_scope=True,
    )
    person_where_sql, person_params = critical_team_person_filter_sql(
        submit_to=effective_submit_to,
        closed_by=closed_by,
    )
    filtered_cte = f"""
        {critical_team_source_cte(source)},
        parameters AS (
            SELECT CAST(? AS DATE) AS date_from, CAST(? AS DATE) AS date_to
        ),
        filtered AS (
            SELECT critical_team_workorders.*, parameters.date_from, parameters.date_to
            FROM critical_team_workorders
            CROSS JOIN parameters
            {person_where_sql}
        )
    """
    base_params: list[Any] = [
        *critical_team_base_params(source),
        start_date.isoformat() if start_date else None,
        end_date.isoformat() if end_date else None,
        *person_params,
    ]

    with critical_team_connection() as con:
        cursor = con.cursor()
        metric_names, metric_row = fetch_one(
            cursor,
            f"""
            {filtered_cte}
            SELECT
                COUNT(*) AS row_count,
                COUNT(DISTINCT workorder_id) AS workorder_count,
                COUNT(DISTINCT CASE
                    WHEN critical_team_status = 'Future Inspection Scheduled'
                    AND ({overview_project_scope_predicate()})
                    THEN workorder_id
                END) AS future_inspection_scheduled,
                COUNT(DISTINCT CASE
                    WHEN critical_team_status = 'Inspection In Progress'
                    AND ({overview_project_scope_predicate()})
                    THEN workorder_id
                END) AS inspection_in_progress,
                COUNT(DISTINCT CASE
                    WHEN critical_team_status = 'On Hold'
                    AND ({overview_project_scope_predicate()})
                    THEN workorder_id
                END) AS on_hold,
                COUNT(DISTINCT CASE
                    WHEN critical_team_status = 'Ready For Review'
                    AND ({overview_project_scope_predicate()})
                    THEN workorder_id
                END) AS ready_for_review,
                COUNT(DISTINCT CASE
                    WHEN critical_team_status = 'Revisions Required'
                    AND ({overview_project_scope_predicate()})
                    THEN workorder_id
                END) AS revisions_required,
                COUNT(DISTINCT CASE
                    WHEN critical_team_status = 'Review Complete'
                    AND ({overview_project_scope_predicate()})
                    THEN workorder_id
                END) AS review_complete
            FROM filtered
            """,
            base_params,
        )
        total_names, total_row = fetch_one(
            cursor,
            f"""
            {filtered_cte}
            SELECT
                COUNT(DISTINCT workorder_id) AS all_time_started_projects,
                COUNT(DISTINCT workorder_id) AS all_time_scheduled_inspections,
                COUNT(DISTINCT CASE WHEN critical_team_status = 'Future Inspection Scheduled' THEN workorder_id END) AS all_time_future_inspection_scheduled,
                COUNT(DISTINCT CASE WHEN critical_team_status = 'Inspection In Progress' THEN workorder_id END) AS all_time_inspection_in_progress,
                COUNT(DISTINCT CASE WHEN critical_team_status = 'On Hold' THEN workorder_id END) AS all_time_on_hold,
                COUNT(DISTINCT CASE WHEN critical_team_status = 'Ready For Review' THEN workorder_id END) AS all_time_ready_for_review,
                COUNT(DISTINCT CASE WHEN critical_team_status = 'Revisions Required' THEN workorder_id END) AS all_time_revisions_required,
                COUNT(DISTINCT CASE WHEN critical_team_status = 'Review Complete' THEN workorder_id END) AS all_time_review_complete
            FROM filtered
            """,
            base_params,
        )

        event_selects = []
        for series_key, series_label, date_column, status_value, color in CRITICAL_TEAM_OVERVIEW_SERIES:
            status_sql = ""
            if status_value:
                status_sql = "AND critical_team_status = ?"
            event_selects.append(
                f"""
                SELECT
                    ? AS series_key,
                    ? AS series_label,
                    ? AS color,
                    {sql_identifier(date_column)} AS event_date,
                    workorder_id,
                    date_from,
                    date_to
                FROM filtered
                WHERE {sql_identifier(date_column)} IS NOT NULL
                {status_sql}
                """
            )

        # Parameters for each event SELECT must be in textual order.
        ordered_event_params = []
        for series_key, series_label, _date_column, status_value, color in CRITICAL_TEAM_OVERVIEW_SERIES:
            ordered_event_params.extend([series_key, series_label, color])
            if status_value:
                ordered_event_params.append(status_value)

        series_names, series_rows = fetch_all(
            cursor,
            f"""
            {filtered_cte},
            events AS (
                {' UNION ALL '.join(event_selects)}
            )
            SELECT
                series_key,
                series_label,
                color,
                DATEFROMPARTS(YEAR(event_date), MONTH(event_date), 1) AS month_start,
                CONVERT(char(7), event_date, 120) AS month_label,
                COUNT(DISTINCT workorder_id) AS count_value
            FROM events
            WHERE (date_from IS NULL OR CAST(event_date AS DATE) >= date_from)
              AND (date_to IS NULL OR CAST(event_date AS DATE) <= date_to)
            GROUP BY
                series_key,
                series_label,
                color,
                DATEFROMPARTS(YEAR(event_date), MONTH(event_date), 1),
                CONVERT(char(7), event_date, 120)
            ORDER BY month_start, series_key
            """,
            [*base_params, *ordered_event_params],
        )

    points_by_series: dict[str, dict[str, Any]] = {
        series_key: {"key": series_key, "label": label, "color": color, "points": []}
        for series_key, label, _date_column, _status_value, color in CRITICAL_TEAM_OVERVIEW_SERIES
    }
    for row in series_rows:
        record = clean_record(dict(zip(series_names, row)))
        points_by_series[record["series_key"]]["points"].append(
            {
                "month_start": record["month_start"],
                "month_label": record["month_label"],
                "count_value": record["count_value"],
            }
        )

    return {
        "filters": {
            "date_from": start_date.isoformat() if start_date else "",
            "date_to": end_date.isoformat() if end_date else "",
            "submit_to": effective_submit_to or [],
        },
        "metrics": clean_record(dict(zip(metric_names, metric_row))),
        "totals": clean_record(dict(zip(total_names, total_row))),
        "series": list(points_by_series.values()),
    }


@router.get("/filter-options")
def critical_team_filter_options(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    source = critical_team_data_source()
    person_restricted, scoped_person_name = critical_team_submit_to_scope(db, current_user)
    with critical_team_connection() as con:
        cursor = con.cursor()

        def values(column: str) -> list[Any]:
            _names, rows = fetch_all(
                cursor,
                f"""
                {critical_team_source_cte(source)}
                SELECT DISTINCT {sql_identifier(column)} AS value
                FROM critical_team_workorders
                WHERE NULLIF(LTRIM(RTRIM(CAST({sql_identifier(column)} AS varchar(4000)))), '') IS NOT NULL
                ORDER BY value
                """,
                critical_team_base_params(source),
            )
            return [clean_record({"value": row[0]})["value"] for row in rows]

        years = {}
        for key, column in CRITICAL_TEAM_DATE_COLUMNS.items():
            _names, rows = fetch_all(
                cursor,
                f"""
                {critical_team_source_cte(source)}
                SELECT DISTINCT YEAR({sql_identifier(column)}) AS value
                FROM critical_team_workorders
                WHERE {sql_identifier(column)} IS NOT NULL
                ORDER BY value
                """,
                critical_team_base_params(source),
            )
            years[key] = [str(int(row[0])) for row in rows if row[0] is not None]
            null_count = cursor.execute(
                f"""
                {critical_team_source_cte(source)}
                SELECT COUNT(*) FROM critical_team_workorders WHERE {sql_identifier(column)} IS NULL
                """,
                critical_team_base_params(source),
            ).fetchone()[0]
            if null_count:
                years[key] = ["null", *years[key]]

        return {
            "submit_to": values("submit_to"),
            "wo_closed_by": values("wo_closed_by"),
            "critical_team_status": values("critical_team_status"),
            "years": years,
            "viewer_scope": {
                "submit_to_restricted": person_restricted,
                "submit_to": scoped_person_name,
                "closed_by_restricted": person_restricted,
                "closed_by": scoped_person_name,
            },
        }


@router.get("/sheet/{sheet_id}")
def critical_team_sheet_data(
    sheet_id: str,
    year: list[str] | None = Query(default=None),
    submit_to: list[str] | None = Query(default=None),
    closed_by: str | None = Query(default=None),
    status: list[str] | None = Query(default=None),
    tableau_defaults: bool = Query(default=True),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    source = critical_team_data_source()
    sheet = critical_team_sheet(sheet_id)
    date_column = CRITICAL_TEAM_DATE_COLUMNS[sheet["date_key"]]
    group_column = sheet["group_column"]
    effective_submit_to = scoped_submit_to_values(
        db,
        current_user,
        submit_to,
        apply_scope=sheet_id in SUBMIT_TO_SCOPED_SHEET_IDS,
    )
    effective_closed_by = scoped_closed_by_value(
        db,
        current_user,
        closed_by,
        apply_scope=sheet_id in CLOSED_BY_SCOPED_SHEET_IDS,
    )
    where_sql, params = critical_team_filter_sql(
        sheet,
        year=year,
        submit_to=effective_submit_to,
        closed_by=effective_closed_by,
        status=status,
        use_tableau_defaults=tableau_defaults,
    )

    with critical_team_connection() as con:
        cursor = con.cursor()
        month_start_expression = (
            f"CASE WHEN {sql_identifier(date_column)} IS NULL THEN NULL "
            f"ELSE DATEFROMPARTS(YEAR({sql_identifier(date_column)}), MONTH({sql_identifier(date_column)}), 1) END"
        )
        month_label_expression = (
            f"CASE WHEN {sql_identifier(date_column)} IS NULL THEN 'No Date' "
            f"ELSE CONVERT(char(7), {sql_identifier(date_column)}, 120) END"
        )
        group_expression = (
            f"COALESCE(NULLIF(LTRIM(RTRIM(CAST({sql_identifier(group_column)} AS varchar(4000)))), ''), 'Unassigned')"
        )
        names, rows = fetch_all(
            cursor,
            f"""
            {critical_team_source_cte(source)}
            SELECT
                {month_start_expression} AS month_start,
                {month_label_expression} AS month_label,
                {group_expression} AS group_name,
                COUNT(DISTINCT workorder_id) AS count_value
            FROM critical_team_workorders
            {where_sql}
            GROUP BY
                {month_start_expression},
                {month_label_expression},
                {group_expression}
            ORDER BY
                CASE WHEN {month_start_expression} IS NULL THEN 0 ELSE 1 END,
                {month_start_expression},
                {group_expression}
            """,
            [*critical_team_base_params(source), *params],
        )

    return {
        "sheet_id": sheet_id,
        "sheet": sheet,
        "rows": [clean_record(dict(zip(names, row))) for row in rows],
    }


@router.get("/workorders")
def critical_team_workorders(
    search: str | None = Query(default=None),
    submit_to: list[str] | None = Query(default=None),
    closed_by: str | None = Query(default=None),
    status: list[str] | None = Query(default=None),
    workorder_id_mode: str = Query(default="any", pattern="^(any|exact|between|greater|less)$"),
    workorder_id_from: int | None = Query(default=None),
    workorder_id_to: int | None = Query(default=None),
    facility_id_mode: str = Query(default="any", pattern="^(any|exact|between|greater|less)$"),
    facility_id_from: int | None = Query(default=None),
    facility_id_to: int | None = Query(default=None),
    condition_risk_mode: str = Query(default="any", pattern="^(any|exact|between|greater|less)$"),
    condition_risk_from: float | None = Query(default=None),
    condition_risk_to: float | None = Query(default=None),
    submit_to_filter: list[str] | None = Query(default=None),
    wo_closed_by_filter: list[str] | None = Query(default=None),
    critical_team_status_filter: list[str] | None = Query(default=None),
    project_start_date_mode: str = Query(default="any", pattern="^(any|exact|between|before|after)$"),
    project_start_date_from: str | None = Query(default=None),
    project_start_date_to: str | None = Query(default=None),
    inspection_complete_date_mode: str = Query(default="any", pattern="^(any|exact|between|before|after)$"),
    inspection_complete_date_from: str | None = Query(default=None),
    inspection_complete_date_to: str | None = Query(default=None),
    report_complete_date_mode: str = Query(default="any", pattern="^(any|exact|between|before|after)$"),
    report_complete_date_from: str | None = Query(default=None),
    report_complete_date_to: str | None = Query(default=None),
    wo_closed_date_mode: str = Query(default="any", pattern="^(any|exact|between|before|after)$"),
    wo_closed_date_from: str | None = Query(default=None),
    wo_closed_date_to: str | None = Query(default=None),
    sort_by: str = Query(default="project_start_date"),
    sort_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    source = critical_team_data_source()
    clauses = []
    params: list[Any] = []

    def add_number_filter(expression: str, mode: str, value_from: int | None, value_to: int | None) -> None:
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

    def add_facility_id_set_filter(facility_ids: list[str] | None) -> None:
        if facility_ids is None:
            return
        if not facility_ids:
            clauses.append("1 = 0")
            return
        chunk_clauses = []
        for index in range(0, len(facility_ids), 1000):
            chunk = facility_ids[index:index + 1000]
            placeholders = ", ".join(["?"] * len(chunk))
            chunk_clauses.append(f"LTRIM(RTRIM(CAST(facility_id AS varchar(4000)))) IN ({placeholders})")
            params.extend(chunk)
        clauses.append(f"({' OR '.join(chunk_clauses)})")

    def add_category_filter(column: str, values: list[str] | None) -> None:
        selected = [value for value in values or [] if value]
        if not selected:
            return
        placeholders = ", ".join(["?"] * len(selected))
        clauses.append(f"{sql_identifier(column)} IN ({placeholders})")
        params.extend(selected)

    def add_date_filter(column: str, mode: str, date_from: str | None, date_to: str | None) -> None:
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

    if search:
        clauses.append(
            """
            (
                CAST(workorder_id AS varchar(4000)) LIKE ?
                OR CAST(facility_id AS varchar(4000)) LIKE ?
                OR CAST(submit_to AS varchar(4000)) LIKE ?
                OR CAST(wo_closed_by AS varchar(4000)) LIKE ?
            )
            """
        )
        params.extend([f"%{search}%"] * 4)
    submitters = [value for value in submit_to or [] if value]
    if submitters:
        placeholders = ", ".join(["?"] * len(submitters))
        clauses.append(f"submit_to IN ({placeholders})")
        params.extend(submitters)
    if closed_by:
        clauses.append("wo_closed_by = ?")
        params.append(closed_by)
    if status:
        statuses = [value for value in status if value]
        if statuses:
            placeholders = ", ".join(["?"] * len(statuses))
            clauses.append(f"critical_team_status IN ({placeholders})")
            params.extend(statuses)

    add_number_filter("workorders_id", workorder_id_mode, workorder_id_from, workorder_id_to)
    add_number_filter("TRY_CONVERT(BIGINT, facility_id)", facility_id_mode, facility_id_from, facility_id_to)
    add_facility_id_set_filter(
        critical_facility_ids_for_condition_risk_filter(
            condition_risk_mode,
            condition_risk_from,
            condition_risk_to,
        )
    )
    add_category_filter("submit_to", submit_to_filter)
    add_category_filter("wo_closed_by", wo_closed_by_filter)
    add_category_filter("critical_team_status", critical_team_status_filter)
    add_date_filter(
        "project_start_date",
        project_start_date_mode,
        project_start_date_from,
        project_start_date_to,
    )
    add_date_filter(
        "inspection_complete_date",
        inspection_complete_date_mode,
        inspection_complete_date_from,
        inspection_complete_date_to,
    )
    add_date_filter(
        "report_complete_date",
        report_complete_date_mode,
        report_complete_date_from,
        report_complete_date_to,
    )
    add_date_filter("wo_closed_date", wo_closed_date_mode, wo_closed_date_from, wo_closed_date_to)

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    order_expression = CRITICAL_TEAM_WORKORDER_SORT_EXPRESSIONS.get(sort_by, "project_start_date")
    direction = "ASC" if sort_dir.lower() == "asc" else "DESC"
    tie_breakers = {
        "workorder_id": "",
        "facility_id": ", facility_id, workorders_id",
    }
    tie_breaker = tie_breakers.get(sort_by, ", workorders_id")
    select_sql = """
                workorder_id,
                workorders_id,
                facility_id,
                submit_to,
                wo_closed_by,
                status,
                critical_team_status,
                project_start_date,
                inspection_complete_date,
                report_complete_date,
                wo_closed_date
    """

    with critical_team_connection() as con:
        cursor = con.cursor()
        total = int(cursor.execute(
            f"""
            {critical_team_source_cte(source)}
            SELECT COUNT(*) FROM critical_team_workorders {where_sql}
            """,
            [*critical_team_base_params(source), *params],
        ).fetchone()[0])
        if sort_by == "condition_risk":
            names, rows = fetch_all(
                cursor,
                f"""
                {critical_team_source_cte(source)}
                SELECT
                    {select_sql}
                FROM critical_team_workorders
                {where_sql}
                """,
                [*critical_team_base_params(source), *params],
            )
        else:
            names, rows = fetch_all(
                cursor,
                f"""
                {critical_team_source_cte(source)}
                SELECT
                    {select_sql}
                FROM critical_team_workorders
                {where_sql}
                ORDER BY
                    CASE WHEN {order_expression} IS NULL THEN 1 ELSE 0 END,
                    {order_expression} {direction}{tie_breaker}
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
                """,
                [*critical_team_base_params(source), *params, offset, limit],
            )

    records = [clean_record(dict(zip(names, row))) for row in rows]
    records = attach_condition_risk_to_workorders(records)
    if sort_by == "condition_risk":
        records = sort_workorders_by_condition_risk(records, sort_dir)[offset:offset + limit]

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "rows": records,
    }
