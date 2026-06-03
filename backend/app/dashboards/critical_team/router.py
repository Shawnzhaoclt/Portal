from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from typing import Any

import duckdb
from fastapi import APIRouter, HTTPException, Query

from backend.app.core.paths import PROJECT_ROOT
from backend.app.core.records import clean_record
from backend.app.core.sql import duck_identifier


router = APIRouter(prefix="/api/critical-team", tags=["critical-team"])

CRITICAL_TEAM_DB = Path(
    os.getenv(
        "ARF_CRITICAL_TEAM_DB",
        PROJECT_ROOT / "frontend" / "data" / "critical_team_dashboard.duckdb",
    )
)
CRITICAL_TEAM_DATE_COLUMNS = {
    "project_start": "project_start_date",
    "inspection_complete": "inspection_complete_date",
    "report_complete": "report_complete_date",
    "work_order_closed": "wo_closed_date",
}
CRITICAL_TEAM_WORKORDER_SORT_EXPRESSIONS = {
    "workorder_id": "workorders_id",
    "facility_id": "TRY_CAST(facility_id AS BIGINT)",
    "submit_to": "submit_to",
    "wo_closed_by": "wo_closed_by",
    "critical_team_status": "critical_team_status",
    "project_start_date": "project_start_date",
    "inspection_complete_date": "inspection_complete_date",
    "report_complete_date": "report_complete_date",
    "wo_closed_date": "wo_closed_date",
}
CRITICAL_TEAM_DEFAULT_YEARS = [str(date.today().year - 1), str(date.today().year)]
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
        "title": "Insp_Comp_Date_Table",
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
        "title": "Report_Comp_Date_Table",
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
        "title": "Insp_Comp_Date_Reviews_Table",
        "kind": "table",
        "date_key": "work_order_closed",
        "group_column": "wo_closed_by",
        "default_years": CRITICAL_TEAM_DEFAULT_YEARS,
        "default_statuses": ["Review Complete"],
        "exclude_blank_group": True,
    },
}


def critical_team_connection() -> duckdb.DuckDBPyConnection:
    if not CRITICAL_TEAM_DB.exists():
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Critical Team DuckDB database was not found.",
                "path": str(CRITICAL_TEAM_DB),
                "hint": "Run `pnpm ingest:critical-team` from the frontend directory.",
            },
        )

    return duckdb.connect(str(CRITICAL_TEAM_DB), read_only=True)


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
        clauses.append(f"EXTRACT(year FROM {duck_identifier(date_column)}) IN ({placeholders})")
        params.extend(numeric_years)
    if include_null:
        clauses.append(f"{duck_identifier(date_column)} IS NULL")

    return f"({' OR '.join(clauses)})", params


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
        clauses.append(f"NULLIF(TRIM({duck_identifier(group_column)}), '') IS NOT NULL")

    return (f"WHERE {' AND '.join(clauses)}" if clauses else "", params)


@router.get("/source")
def critical_team_source() -> dict[str, Any]:
    with critical_team_connection() as con:
        metadata_row = con.execute("SELECT * FROM critical_team_metadata").fetchone()
        metadata_names = [description[0] for description in con.description]
        columns = [
            {"name": name, "data_type": data_type, "ordinal_position": ordinal_position}
            for name, data_type, ordinal_position in con.execute(
                """
                SELECT column_name, data_type, ordinal_position
                FROM information_schema.columns
                WHERE table_schema = 'main' AND table_name = 'critical_team_workorders'
                ORDER BY ordinal_position
                """
            ).fetchall()
        ]

    return {
        "database": str(CRITICAL_TEAM_DB),
        "metadata": clean_record(dict(zip(metadata_names, metadata_row))),
        "columns": columns,
        "sheets": CRITICAL_TEAM_SHEETS,
    }


@router.get("/summary")
def critical_team_summary() -> dict[str, Any]:
    with critical_team_connection() as con:
        row = con.execute(
            """
            SELECT
                COUNT(*) AS row_count,
                COUNT(DISTINCT workorder_id) AS workorder_count,
                COUNT(*) FILTER (WHERE project_start_date IS NOT NULL) AS project_started,
                COUNT(*) FILTER (WHERE inspection_complete_date IS NOT NULL) AS inspections_completed,
                COUNT(*) FILTER (WHERE report_complete_date IS NOT NULL) AS reports_completed,
                COUNT(*) FILTER (WHERE wo_closed_date IS NOT NULL) AS workorders_closed,
                COUNT(*) FILTER (WHERE critical_team_status = 'Ready For Review') AS ready_for_review,
                COUNT(*) FILTER (WHERE critical_team_status = 'Review Complete') AS review_complete
            FROM critical_team_workorders
            """
        ).fetchone()
        names = [description[0] for description in con.description]

    return clean_record(dict(zip(names, row)))


@router.get("/filter-options")
def critical_team_filter_options() -> dict[str, Any]:
    with critical_team_connection() as con:

        def values(column: str) -> list[Any]:
            rows = con.execute(
                f"""
                SELECT DISTINCT {duck_identifier(column)} AS value
                FROM critical_team_workorders
                WHERE NULLIF(TRIM(CAST({duck_identifier(column)} AS VARCHAR)), '') IS NOT NULL
                ORDER BY value
                """
            ).fetchall()
            return [clean_record({"value": row[0]})["value"] for row in rows]

        years = {}
        for key, column in CRITICAL_TEAM_DATE_COLUMNS.items():
            rows = con.execute(
                f"""
                SELECT DISTINCT EXTRACT(year FROM {duck_identifier(column)}) AS value
                FROM critical_team_workorders
                WHERE {duck_identifier(column)} IS NOT NULL
                ORDER BY value
                """
            ).fetchall()
            years[key] = [str(int(row[0])) for row in rows if row[0] is not None]
            null_count = con.execute(
                f"SELECT COUNT(*) FROM critical_team_workorders WHERE {duck_identifier(column)} IS NULL"
            ).fetchone()[0]
            if null_count:
                years[key] = ["null", *years[key]]

        return {
            "submit_to": values("submit_to"),
            "wo_closed_by": values("wo_closed_by"),
            "critical_team_status": values("critical_team_status"),
            "years": years,
        }


@router.get("/sheet/{sheet_id}")
def critical_team_sheet_data(
    sheet_id: str,
    year: list[str] | None = Query(default=None),
    submit_to: list[str] | None = Query(default=None),
    closed_by: str | None = Query(default=None),
    status: list[str] | None = Query(default=None),
    tableau_defaults: bool = Query(default=True),
) -> dict[str, Any]:
    sheet = critical_team_sheet(sheet_id)
    date_column = CRITICAL_TEAM_DATE_COLUMNS[sheet["date_key"]]
    group_column = sheet["group_column"]
    where_sql, params = critical_team_filter_sql(
        sheet,
        year=year,
        submit_to=submit_to,
        closed_by=closed_by,
        status=status,
        use_tableau_defaults=tableau_defaults,
    )

    with critical_team_connection() as con:
        rows = con.execute(
            f"""
            SELECT
                CASE
                    WHEN {duck_identifier(date_column)} IS NULL THEN NULL
                    ELSE CAST(date_trunc('month', {duck_identifier(date_column)}) AS DATE)
                END AS month_start,
                CASE
                    WHEN {duck_identifier(date_column)} IS NULL THEN 'No Date'
                    ELSE strftime({duck_identifier(date_column)}, '%Y-%m')
                END AS month_label,
                COALESCE(NULLIF(TRIM(CAST({duck_identifier(group_column)} AS VARCHAR)), ''), 'Unassigned') AS group_name,
                COUNT(DISTINCT workorder_id) AS count_value
            FROM critical_team_workorders
            {where_sql}
            GROUP BY month_start, month_label, group_name
            ORDER BY month_start NULLS FIRST, group_name
            """,
            params,
        ).fetchall()
        names = [description[0] for description in con.description]

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

    def add_category_filter(column: str, values: list[str] | None) -> None:
        selected = [value for value in values or [] if value]
        if not selected:
            return
        placeholders = ", ".join(["?"] * len(selected))
        clauses.append(f"{duck_identifier(column)} IN ({placeholders})")
        params.extend(selected)

    def add_date_filter(column: str, mode: str, date_from: str | None, date_to: str | None) -> None:
        start_date = date_from.strip() if date_from else ""
        end_date = date_to.strip() if date_to else ""
        date_expression = f"CAST({duck_identifier(column)} AS DATE)"

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
                workorder_id ILIKE ?
                OR facility_id ILIKE ?
                OR submit_to ILIKE ?
                OR wo_closed_by ILIKE ?
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
    add_number_filter("TRY_CAST(facility_id AS BIGINT)", facility_id_mode, facility_id_from, facility_id_to)
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

    with critical_team_connection() as con:
        total = int(
            con.execute(f"SELECT COUNT(*) FROM critical_team_workorders {where_sql}", params).fetchone()[0]
        )
        rows = con.execute(
            f"""
            SELECT
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
            FROM critical_team_workorders
            {where_sql}
            ORDER BY {order_expression} {direction} NULLS LAST{tie_breaker}
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()
        names = [description[0] for description in con.description]

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "rows": [clean_record(dict(zip(names, row))) for row in rows],
    }
