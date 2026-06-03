from __future__ import annotations

from io import BytesIO
from typing import Any, Callable

import duckdb
import pandas as pd
import pyodbc
import sqlalchemy
from fastapi import APIRouter

from backend.app.diagnostics.environment import ENV_FILE, check_import, read_dependencies

router = APIRouter(prefix="/api", tags=["diagnostics"])


def ok(name: str, details: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "ok": True, "details": details}


def fail(name: str, exc: Exception) -> dict[str, Any]:
    return {
        "name": name,
        "ok": False,
        "error_type": type(exc).__name__,
        "error": str(exc),
    }


def run_check(name: str, check: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        return ok(name, check())
    except Exception as exc:
        return fail(name, exc)


def sample_dataframe() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "station": ["A", "B", "C"],
            "rainfall_inches": [1.25, 0.80, 1.60],
            "watershed": ["North", "South", "North"],
        }
    )


def csv_check() -> dict[str, Any]:
    df = pd.read_csv(BytesIO(sample_dataframe().to_csv(index=False).encode("utf-8")))
    return {
        "rows": int(len(df)),
        "columns": list(df.columns),
        "total_rainfall_inches": float(df["rainfall_inches"].sum()),
    }


def excel_check() -> dict[str, Any]:
    workbook = BytesIO()
    sample_dataframe().to_excel(workbook, index=False, engine="openpyxl")
    workbook.seek(0)

    df = pd.read_excel(workbook, engine="openpyxl")
    return {
        "rows": int(len(df)),
        "columns": list(df.columns),
        "max_rainfall_inches": float(df["rainfall_inches"].max()),
    }


def duckdb_check() -> dict[str, Any]:
    con = duckdb.connect()
    con.register("rainfall", sample_dataframe())
    rows = con.execute(
        """
        SELECT watershed, SUM(rainfall_inches) AS total_rainfall_inches
        FROM rainfall
        GROUP BY watershed
        ORDER BY watershed
        """
    ).fetchall()
    return {
        "duckdb_version": duckdb.__version__,
        "rows": [
            {"watershed": watershed, "total_rainfall_inches": float(total)}
            for watershed, total in rows
        ],
    }


def sqlalchemy_check() -> dict[str, Any]:
    engine = sqlalchemy.create_engine("sqlite+pysqlite:///:memory:")
    with engine.connect() as connection:
        value = connection.execute(sqlalchemy.text("SELECT 1")).scalar_one()

    return {"sqlalchemy_version": sqlalchemy.__version__, "select_one": int(value)}


def sql_server_driver_check() -> dict[str, Any]:
    drivers = list(pyodbc.drivers())
    return {
        "pyodbc_version": pyodbc.version,
        "available_odbc_drivers": drivers,
        "sql_server_drivers": [driver for driver in drivers if "SQL Server" in driver],
    }


@router.get("/package-checks")
def package_checks() -> dict[str, Any]:
    dependencies = read_dependencies(ENV_FILE)
    results = []

    for dependency in dependencies:
        passed, message = check_import(dependency)
        results.append({"dependency": dependency, "ok": passed, "message": message})

    return {
        "environment_file": str(ENV_FILE),
        "all_passed": all(result["ok"] for result in results),
        "results": results,
    }


@router.get("/tests/csv")
def test_csv() -> dict[str, Any]:
    return run_check("csv", csv_check)


@router.get("/tests/excel")
def test_excel() -> dict[str, Any]:
    return run_check("excel", excel_check)


@router.get("/tests/duckdb")
def test_duckdb() -> dict[str, Any]:
    return run_check("duckdb", duckdb_check)


@router.get("/tests/sqlalchemy")
def test_sqlalchemy() -> dict[str, Any]:
    return run_check("sqlalchemy", sqlalchemy_check)


@router.get("/tests/sql-server")
def test_sql_server() -> dict[str, Any]:
    return run_check("sql-server", sql_server_driver_check)


@router.get("/tests/all")
def test_all() -> dict[str, Any]:
    checks = [
        run_check("csv", csv_check),
        run_check("excel", excel_check),
        run_check("duckdb", duckdb_check),
        run_check("sqlalchemy", sqlalchemy_check),
        run_check("sql-server", sql_server_driver_check),
    ]

    return {
        "all_passed": all(check["ok"] for check in checks),
        "checks": checks,
    }
