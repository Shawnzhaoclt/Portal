from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb


DEFAULT_SOURCE_DIR = Path(
    r"G:\Strategic Planning\Planning\Dashboards\critical_asset_tracking"
)
DEFAULT_OUTPUT_DB = Path(__file__).resolve().parents[2] / "data" / "critical_asset_tracking.duckdb"
DEFAULT_EXPORT_JSON = Path(__file__).resolve().parents[2] / "public" / "data" / "critical-assets.json"

SOURCES = {
    "test_data_multiple_merge": "test_data_multiple_merge.csv",
    "test_data_pipes_merge": "test_data_pipes_merge.csv",
    "test_data_structures_merge": "test_data_structures_merge.csv",
}

WORKSHEETS = [
    "Clog Risk Facility Aggregate (Pipes)",
    "Condition Risk Facility Aggregate (Both)",
    "Condition Risk Facility Aggregate (Pipes)",
    "Condition Risk Facility Aggregate (Structures)",
    "Flood Risk Facility Aggregate (Pipes)",
    "History Graph (Both)",
    "History Table (Both)",
    "History Table (Pipes)",
    "Risk Facility Aggregate (Pipes)",
]

BASE_COLUMNS = [
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

PIPE_COLUMNS = [
    *BASE_COLUMNS,
    "INVESTIGATEDBY",
    "WorkZoneID",
    "Pipe_Size",
    "PERCENT_CONSUMED",
    "DC_RISK",
    "INTERSECTS_SWE_PARCEL",
    "INTERSECTS_CITY_EOP",
    "INTERSECTS_CITY_ROW",
    "INTERSECTS_THOROUGHFARE",
    "INTERSECTS_COLLECTOR",
    "INTERSECTS_LOCAL",
    "INTERSECTS_LOCAL_LIMITED",
    "INTERSECTS_STATE_EOP",
    "INTERSECTS_SF_BUILDING",
    "INTERSECTS_NSF_BUILDING",
    "ZOI_INTERSECTS_SWE_PARCEL",
    "ZOI_INTERSECTS_CITY_EOP",
    "ZOI_INTERSECTS_CITY_ROW",
    "ZOI_INTERSECTS_LOCAL_LIMITED",
    "ZOI_INTERSECTS_LOCAL",
    "ZOI_INTERSECTS_COLLECTOR",
    "ZOI_INTERSECTS_THOROUGHFARE",
    "ZOI_INTERSECTS_STATE_EOP",
    "ZOI_INTERSECTS_SF_BUILDING",
    "ZOI_INTERSECTS_NSF_BUILDING",
]


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Load the critical asset tracking Tableau CSV extracts into DuckDB.",
    )
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=DEFAULT_SOURCE_DIR,
        help=f"Directory containing the Tableau CSV source files. Default: {DEFAULT_SOURCE_DIR}",
    )
    parser.add_argument(
        "--output-db",
        type=Path,
        default=DEFAULT_OUTPUT_DB,
        help=f"DuckDB database file to create. Default: {DEFAULT_OUTPUT_DB}",
    )
    parser.add_argument(
        "--export-json",
        type=Path,
        default=DEFAULT_EXPORT_JSON,
        help=f"Browser-ready JSON dataset to export from DuckDB. Default: {DEFAULT_EXPORT_JSON}",
    )
    return parser.parse_args()


def require_source_files(source_dir: Path) -> dict[str, Path]:
    missing = []
    paths = {}

    for table_name, filename in SOURCES.items():
        path = source_dir / filename
        if not path.exists():
            missing.append(str(path))
        paths[table_name] = path

    if missing:
        raise FileNotFoundError(
            "Missing critical asset tracking CSV file(s):\n"
            + "\n".join(f"- {path}" for path in missing)
        )

    return paths


def load_table(con: duckdb.DuckDBPyConnection, table_name: str, csv_path: Path) -> int:
    csv_literal = sql_string(csv_path.as_posix())

    con.execute(f"DROP TABLE IF EXISTS {table_name}")
    con.execute(
        f"""
        CREATE TABLE {table_name} AS
        SELECT *
        FROM read_csv(
            {csv_literal},
            header = true,
            sample_size = -1,
            union_by_name = true
        )
        """
    )

    return int(con.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0])


def create_indexes(con: duckdb.DuckDBPyConnection, table_name: str) -> None:
    columns = {
        row[0]
        for row in con.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'main' AND table_name = ?
            """,
            [table_name],
        ).fetchall()
    }

    for column in ("FacilityID", "ITPIPE_ASSETID", "INSPECTIONID", "Inspection_Date"):
        if column in columns:
            index_name = f"idx_{table_name}_{column}".replace(" ", "_").lower()
            con.execute(f'CREATE INDEX IF NOT EXISTS "{index_name}" ON {table_name} ("{column}")')


def create_metadata_table(
    con: duckdb.DuckDBPyConnection,
    loaded_tables: list[tuple[str, Path, int]],
) -> None:
    imported_at = datetime.now(timezone.utc).isoformat()

    con.execute("DROP TABLE IF EXISTS data_sources")
    con.execute(
        """
        CREATE TABLE data_sources (
            table_name VARCHAR,
            source_file VARCHAR,
            row_count BIGINT,
            imported_at_utc TIMESTAMPTZ
        )
        """
    )

    con.executemany(
        """
        INSERT INTO data_sources
        VALUES (?, ?, ?, ?)
        """,
        [
            (table_name, str(path), row_count, imported_at)
            for table_name, path, row_count in loaded_tables
        ],
    )


def create_dashboard_views(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        """
        CREATE OR REPLACE VIEW risk_history_both AS
        SELECT
            FacilityID,
            ITPIPE_ASSETID,
            INSPECTIONID,
            INSPECTION_INDEX,
            Inspection_Date,
            MATERIAL,
            RISK,
            RISK_DELTA,
            RISK_DELTA_SUM,
            COND_RISK,
            COND_RISK_DELTA,
            COND_RISK_DELTA_SUM,
            CLOG_RISK,
            CLOG_RISK_DELTA,
            CLOG_RISK_DELTA_SUM,
            FLOOD_RISK,
            FLOOD_RISK_DELTA,
            FLOOD_RISK_DELTA_SUM,
            INSPECTION_COUNT,
            IS_MOST_RECENT
        FROM test_data_multiple_merge
        """
    )

    con.execute(
        """
        CREATE OR REPLACE VIEW risk_history_pipes AS
        SELECT
            FacilityID,
            ITPIPE_ASSETID,
            INSPECTIONID,
            INSPECTION_INDEX,
            Inspection_Date,
            INVESTIGATEDBY,
            investigator,
            MATERIAL,
            Pipe_Size,
            RISK,
            RISK_DELTA,
            RISK_DELTA_SUM,
            COND_RISK,
            COND_RISK_DELTA,
            COND_RISK_DELTA_SUM,
            CLOG_RISK,
            CLOG_RISK_DELTA,
            CLOG_RISK_DELTA_SUM,
            FLOOD_RISK,
            FLOOD_RISK_DELTA,
            FLOOD_RISK_DELTA_SUM,
            INSPECTION_COUNT,
            IS_MOST_RECENT,
            PERCENT_CONSUMED
        FROM test_data_pipes_merge
        """
    )


def existing_columns(con: duckdb.DuckDBPyConnection, table_name: str) -> set[str]:
    return {
        row[0]
        for row in con.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'main' AND table_name = ?
            """,
            [table_name],
        ).fetchall()
    }


def export_rows(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    requested_columns: list[str],
) -> list[dict[str, Any]]:
    columns = [column for column in requested_columns if column in existing_columns(con, table_name)]
    select_columns = ", ".join(f'"{column}"' for column in columns)
    query = f"SELECT {select_columns} FROM {table_name}"

    cursor = con.execute(query)
    names = [description[0] for description in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def json_default(value: Any) -> Any:
    if isinstance(value, (datetime, Decimal)):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def export_app_dataset(con: duckdb.DuckDBPyConnection, export_path: Path) -> None:
    export_path.parent.mkdir(parents=True, exist_ok=True)

    metadata = [
        {
            "tableName": table_name,
            "sourceFile": source_file,
            "rowCount": row_count,
            "importedAtUtc": str(imported_at),
        }
        for table_name, source_file, row_count, imported_at in con.execute(
            """
            SELECT table_name, source_file, row_count, imported_at_utc
            FROM data_sources
            ORDER BY table_name
            """
        ).fetchall()
    ]

    payload = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "worksheets": WORKSHEETS,
        "dataSources": metadata,
        "tables": {
            "multiple": export_rows(con, "test_data_multiple_merge", BASE_COLUMNS),
            "pipes": export_rows(con, "test_data_pipes_merge", PIPE_COLUMNS),
            "structures": export_rows(con, "test_data_structures_merge", BASE_COLUMNS),
        },
    }

    export_path.write_text(
        json.dumps(payload, default=json_default, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> None:
    args = parse_args()
    source_dir = args.source_dir.resolve()
    output_db = args.output_db.resolve()
    export_json = args.export_json.resolve()
    output_db.parent.mkdir(parents=True, exist_ok=True)

    source_paths = require_source_files(source_dir)

    if output_db.exists():
        output_db.unlink()

    loaded_tables: list[tuple[str, Path, int]] = []
    with duckdb.connect(str(output_db)) as con:
        for table_name, csv_path in source_paths.items():
            row_count = load_table(con, table_name, csv_path)
            create_indexes(con, table_name)
            loaded_tables.append((table_name, csv_path, row_count))

        create_metadata_table(con, loaded_tables)
        create_dashboard_views(con)
        export_app_dataset(con, export_json)
        con.execute("CHECKPOINT")

    print(f"Created {output_db}")
    print(f"Exported {export_json}")
    for table_name, csv_path, row_count in loaded_tables:
        print(f"- {table_name}: {row_count:,} rows from {csv_path}")


if __name__ == "__main__":
    main()
