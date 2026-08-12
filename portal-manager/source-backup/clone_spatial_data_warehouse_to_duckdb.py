#!/usr/bin/env python
"""Rebuild the dedicated Spatial Data Warehouse DuckDB mirror."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
from typing import Any

from clone_sqlserver_to_duckdb import (
    CloneItem,
    SqlDatabase,
    _load_config,
    print_manifest,
    run_clone,
    write_manifest_csv,
)


SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "clone_spatial_data_warehouse_to_duckdb.json"
CONFIG = _load_config(CONFIG_PATH)
DATABASES = {
    key: SqlDatabase(key=key, **values)
    for key, values in CONFIG["databases"].items()
}
ARCGIS_CONFIG = CONFIG.get("arcgis") if isinstance(CONFIG.get("arcgis"), dict) else {}
ARCGIS_LAYERS = [
    item
    for item in ARCGIS_CONFIG.get("layers", [])
    if isinstance(item, dict) and str(item.get("name") or "").strip()
]
ARCGIS_LAYER_NAMES = {str(item["name"]).lower() for item in ARCGIS_LAYERS}
ALL_ITEMS = [
    CloneItem("spatial_data_warehouse", "dbo", name, name, source_note="Spatial Data Warehouse layer")
    for name in CONFIG["items"]
]
ITEMS = [item for item in ALL_ITEMS if item.name.lower() not in ARCGIS_LAYER_NAMES]
OUTPUT_ROOT = Path(os.path.expandvars(os.path.expanduser(str(CONFIG["output_root"]))))
if not OUTPUT_ROOT.is_absolute():
    OUTPUT_ROOT = CONFIG_PATH.parent / OUTPUT_ROOT


def _expand_path(value: str, base: Path = CONFIG_PATH.parent) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(value))
    candidate = Path(expanded)
    return candidate if candidate.is_absolute() else (base / candidate).resolve()


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or "layer"
    return f"_{cleaned}" if cleaned[0].isdigit() else cleaned


def _arcgis_export(layer: dict[str, Any], output: Path) -> dict[str, Any]:
    python_executable = _expand_path(str(ARCGIS_CONFIG.get("pythonExecutable") or ""))
    connections = ARCGIS_CONFIG.get("connections") if isinstance(ARCGIS_CONFIG.get("connections"), dict) else {}
    connection_value = str(connections.get("spatial_data_warehouse") or "").strip()
    connection = _expand_path(connection_value) if connection_value else Path()
    if not python_executable.is_file():
        raise RuntimeError(f"Configured ArcGIS Python executable was not found: {python_executable}")
    if not connection.is_file():
        raise RuntimeError(f"Configured ArcGIS database connection was not found: {connection}")
    fields = layer.get("fields")
    if not isinstance(fields, list) or not fields or not all(isinstance(item, str) and item for item in fields):
        raise RuntimeError(f"ArcGIS layer {layer.get('name')} requires a non-empty fields list.")
    command = [
        str(python_executable),
        str(SCRIPT_DIR / "export_arcgis_layer_to_parquet.py"),
        "--connection",
        str(connection),
        "--dataset",
        str(layer.get("dataset") or ""),
        "--output",
        str(output),
    ]
    for field in fields:
        command.extend(["--field", field])
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise RuntimeError(details or f"ArcGIS export exited with code {result.returncode}.")
    print(f"  ArcGIS export: {result.stdout.strip()}")
    return {"fields": fields, "geometryColumn": str(layer.get("geometryColumn") or "Shape")}


def _write_arcgis_parquet(database: Path, layer: dict[str, Any], parquet: Path) -> None:
    try:
        import duckdb
    except ImportError as exc:
        raise RuntimeError("The configured source-backup Python environment must include DuckDB.") from exc
    metadata = _arcgis_export(layer, parquet)
    table = _safe_name(str(layer["name"]))
    temporary = f"__arcgis_{table}"
    ordered = f"__hilbert_{table}"
    geometry = str(metadata["geometryColumn"])
    fields = [str(item) for item in metadata["fields"]]
    selected = ", ".join(_quote_identifier(field) for field in fields)
    if selected:
        selected += ", "
    connection = duckdb.connect(str(database))
    try:
        try:
            connection.execute("LOAD spatial")
        except Exception:
            connection.execute("INSTALL spatial")
            connection.execute("LOAD spatial")
        connection.execute("BEGIN TRANSACTION")
        connection.execute(f"DROP TABLE IF EXISTS {_quote_identifier(temporary)}")
        connection.execute(f"DROP TABLE IF EXISTS {_quote_identifier(ordered)}")
        connection.execute(
            f"CREATE TABLE {_quote_identifier(temporary)} AS SELECT "
            f"{selected}ST_GeomFromWKB(__geometry_wkb) AS {_quote_identifier(geometry)}, "
            f"CAST(__geometry_srid AS INTEGER) AS __geometry_srid "
            f"FROM read_parquet({_sql_string(str(parquet))})"
        )
        count, missing_geometry, minimum_srid, maximum_srid = connection.execute(
            f"SELECT count(*), count(*) FILTER (WHERE {_quote_identifier(geometry)} IS NULL), "
            f"min(__geometry_srid), max(__geometry_srid) FROM {_quote_identifier(temporary)}"
        ).fetchone()
        if not count or missing_geometry or not minimum_srid or minimum_srid != maximum_srid:
            raise RuntimeError(
                f"ArcGIS layer {table} failed geometry validation: rows={count}, "
                f"missing_geometry={missing_geometry}, SRID={minimum_srid}-{maximum_srid}."
            )
        connection.execute(
            f"CREATE TABLE {_quote_identifier(ordered)} AS SELECT * FROM {_quote_identifier(temporary)} "
            f"ORDER BY ST_Hilbert({_quote_identifier(geometry)})"
        )
        connection.execute(f"DROP TABLE {_quote_identifier(temporary)}")
        connection.execute(f"DROP TABLE IF EXISTS {_quote_identifier(table)}")
        connection.execute(
            f"ALTER TABLE {_quote_identifier(ordered)} RENAME TO {_quote_identifier(table)}"
        )
        connection.execute(
            f"CREATE INDEX {_quote_identifier(table + '_rtree')} ON {_quote_identifier(table)} "
            f"USING rtree ({_quote_identifier(geometry)})"
        )
        connection.execute("COMMIT")
        print(
            f"  cloned {count} rows with ST_Hilbert ordering and R-Tree: "
            f"ArcGIS {layer.get('dataset')} -> {database}::{table}"
        )
    except Exception:
        try:
            connection.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        connection.close()


def _clone_arcgis_layers(database: Path) -> None:
    if not ARCGIS_LAYERS:
        return
    temporary_root = _expand_path(
        str(ARCGIS_CONFIG.get("temporaryDirectory") or "${LOCALAPPDATA}/PortalManager/source-backup")
    )
    temporary_root.mkdir(parents=True, exist_ok=True)
    for layer in ARCGIS_LAYERS:
        parquet = temporary_root / f"{_safe_name(str(layer['name']))}-{os.getpid()}.parquet"
        try:
            _write_arcgis_parquet(database, layer, parquet)
        finally:
            parquet.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Rebuild the dedicated Spatial Data Warehouse DuckDB mirror. "
            "The mirror is intentionally separate from the standard source archive."
        )
    )
    parser.add_argument("--list", action="store_true", help="Print the layer manifest and exit.")
    parser.add_argument("--write-manifest", type=Path, default=None)
    parser.add_argument("--continue-on-error", action="store_true")
    args = parser.parse_args(argv)

    if args.write_manifest:
        write_manifest_csv(args.write_manifest, ALL_ITEMS, DATABASES)
    if args.list:
        print_manifest(ALL_ITEMS, DATABASES)
        return 0

    failures = run_clone(
        output_root=OUTPUT_ROOT,
        items=ITEMS,
        continue_on_error=args.continue_on_error,
        odbc_driver=str(CONFIG["odbc_driver"]),
        trust_server_certificate=True,
        create_filegdb=False,
        databases=DATABASES,
        build_spatial_indexes=True,
    )
    if failures:
        return 1
    database = OUTPUT_ROOT / DATABASES["spatial_data_warehouse"].duckdb_name
    try:
        _clone_arcgis_layers(database)
    except Exception as exc:
        print(f"  failed: configured ArcGIS spatial layers: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
