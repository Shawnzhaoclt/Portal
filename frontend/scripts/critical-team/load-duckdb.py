from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pandas as pd
import pyodbc


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DATA_SOURCES_CONFIG = PROJECT_ROOT / "backend" / "app" / "config" / "data_sources.json"
DEFAULT_OUTPUT_DB = Path(__file__).resolve().parents[2] / "data" / "critical_team_dashboard.duckdb"


def data_sources_config_path() -> Path:
    configured_path = os.getenv("ARF_DATA_SOURCES_CONFIG")
    return Path(configured_path) if configured_path else DEFAULT_DATA_SOURCES_CONFIG


def critical_team_source_config() -> dict:
    with data_sources_config_path().open(encoding="utf-8") as config_file:
        config = json.load(config_file)
    return config["critical_team"]


def bracket_identifier(identifier: str) -> str:
    return f"[{identifier.replace(']', ']]')}]"


def qualified_table_name(schema: str, table: str) -> str:
    return f"{bracket_identifier(schema)}.{bracket_identifier(table)}"


def parse_args() -> argparse.Namespace:
    source_config = critical_team_source_config()
    parser = argparse.ArgumentParser(
        description="Load the Critical Team Tableau workbook source data into DuckDB.",
    )
    parser.add_argument(
        "--output-db",
        type=Path,
        default=DEFAULT_OUTPUT_DB,
        help=f"DuckDB database file to create. Default: {DEFAULT_OUTPUT_DB}",
    )
    parser.add_argument(
        "--server",
        default=os.getenv("ARF_CITYWORKS_SERVER", source_config["server"]),
        help="Cityworks SQL Server. Default comes from backend/app/config/data_sources.json.",
    )
    parser.add_argument(
        "--database",
        default=os.getenv("ARF_CITYWORKS_DATABASE", source_config["database"]),
        help="Cityworks SQL database. Default comes from backend/app/config/data_sources.json.",
    )
    return parser.parse_args()


def selected_odbc_driver() -> str:
    configured_driver = os.getenv("ARF_SQL_DRIVER")
    if configured_driver:
        return configured_driver

    drivers = list(pyodbc.drivers())
    for preferred in ("ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server", "SQL Server"):
        if preferred in drivers:
            return preferred

    return "ODBC Driver 18 for SQL Server"


def connection_string(server: str, database: str) -> str:
    configured = os.getenv("ARF_CRITICAL_TEAM_CONNECTION_STRING")
    if configured:
        return configured

    return (
        f"Driver={{{selected_odbc_driver()}}};"
        f"Server={server};"
        f"Database={database};"
        "Trusted_Connection=yes;"
        f"Encrypt={os.getenv('ARF_SQL_ENCRYPT', 'yes')};"
        f"TrustServerCertificate={os.getenv('ARF_SQL_TRUST_SERVER_CERTIFICATE', 'yes')};"
    )


def read_workorders(server: str, database: str, source_config: dict) -> pd.DataFrame:
    schema = source_config["schema"]
    workorder_table = qualified_table_name(schema, source_config["tables"]["workorder"])
    wocustfield_table = qualified_table_name(schema, source_config["tables"]["wocustfield"])
    query = f"""
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
    )
    SELECT
        wo.WORKORDERID,
        cf.WORKORDERSID,
        wo.DESCRIPTION,
        wo.SUBMITTO,
        wo.WOCLOSEDBY,
        wo.STATUS,
        wo.PROJSTARTDATE,
        wo.DATEWOCLOSED,
        cf.FACILITY_ID,
        cf.INSP_COMP_DATE,
        cf.REPORT_COMP_DATE,
        cf.CRITICAL_TEAM_STATUS
    FROM {workorder_table} AS wo
    LEFT JOIN custom_fields AS cf
        ON cf.WORKORDERID = wo.WORKORDERID
    WHERE wo.DESCRIPTION = ?
    """

    with pyodbc.connect(connection_string(server, database), timeout=20) as connection:
        return pd.read_sql_query(query, connection, params=[source_config["description_filter"]])


def write_duckdb(df: pd.DataFrame, output_db: Path, server: str, database: str, source_config: dict) -> None:
    output_db.parent.mkdir(parents=True, exist_ok=True)
    if output_db.exists():
        output_db.unlink()

    imported_at = datetime.now(timezone.utc).isoformat()
    with duckdb.connect(str(output_db)) as con:
        con.register("source_workorders", df)
        con.execute(
            """
            CREATE TABLE critical_team_workorders AS
            SELECT
                WORKORDERID::VARCHAR AS workorder_id,
                WORKORDERSID::BIGINT AS workorders_id,
                DESCRIPTION::VARCHAR AS description,
                SUBMITTO::VARCHAR AS submit_to,
                WOCLOSEDBY::VARCHAR AS wo_closed_by,
                STATUS::VARCHAR AS status,
                TRY_CAST(PROJSTARTDATE AS TIMESTAMP) AS project_start_date,
                TRY_CAST(DATEWOCLOSED AS TIMESTAMP) AS wo_closed_date,
                FACILITY_ID::VARCHAR AS facility_id,
                TRY_CAST(INSP_COMP_DATE AS DATE) AS inspection_complete_date,
                TRY_CAST(REPORT_COMP_DATE AS DATE) AS report_complete_date,
                CRITICAL_TEAM_STATUS::VARCHAR AS critical_team_status
            FROM source_workorders
            """
        )
        con.execute(
            """
            CREATE TABLE critical_team_metadata AS
            SELECT
                ?::VARCHAR AS workbook,
                ?::VARCHAR AS source_server,
                ?::VARCHAR AS source_database,
                ?::VARCHAR AS source_tables,
                COUNT(*)::BIGINT AS row_count,
                ?::VARCHAR AS imported_at_utc
            FROM critical_team_workorders
            """,
            [
                source_config["workbook"],
                server,
                database,
                f"{source_config['schema']}.{source_config['tables']['workorder']} + "
                f"{source_config['schema']}.{source_config['tables']['wocustfield']}",
                imported_at,
            ],
        )
        for column in (
            "workorder_id",
            "workorders_id",
            "submit_to",
            "wo_closed_by",
            "project_start_date",
            "inspection_complete_date",
            "report_complete_date",
            "wo_closed_date",
            "critical_team_status",
        ):
            con.execute(f"CREATE INDEX IF NOT EXISTS idx_critical_team_{column} ON critical_team_workorders ({column})")
        con.execute("CHECKPOINT")


def main() -> None:
    source_config = critical_team_source_config()
    args = parse_args()
    output_db = args.output_db.resolve()
    df = read_workorders(args.server, args.database, source_config)
    write_duckdb(df, output_db, args.server, args.database, source_config)
    print(f"Created {output_db}")
    print(f"- critical_team_workorders: {len(df):,} rows")


if __name__ == "__main__":
    main()
