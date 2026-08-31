#!/usr/bin/env python
r"""Clone SQL Server inputs used by the pv-stm legacy workflow to DuckDB.

The default manifest is intentionally limited to SQL Server feature classes and
tables used by the pv-stm 001_MAIN.bat batch chain.

Runtime settings and database connections are loaded from
``clone_sqlserver_to_duckdb.json`` beside this script.

Each selected database group is rebuilt in a sibling staging database, validated,
and atomically promoted over the fixed authoritative DuckDB path. A failed rebuild
leaves the previous authoritative database untouched. The DuckDB spatial extension
is loaded, and SQL Server geometry/geography columns are stored as DuckDB GEOMETRY
columns.

This script reads from SQL Server only. It does not write back to SQL Server.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus


SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "clone_sqlserver_to_duckdb.json"
SPATIAL_TYPES = {"geometry", "geography"}


@dataclass(frozen=True)
class SqlDatabase:
    """Connection details for a SQL Server database."""

    key: str
    server: str
    database: str
    duckdb_name: str
    auth_method: str = "windows"
    username: str = ""
    password: str = ""
    password_env: str = ""


@dataclass(frozen=True)
class CloneItem:
    """One SQL Server table or feature class to copy."""

    connection_key: str
    schema: str
    name: str
    output_name: str
    where_clause: str | None = None
    source_note: str = ""

    @property
    def qualified_name(self) -> str:
        return f"{self.schema}.{self.name}" if self.schema else self.name


def _load_config(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as config_file:
            config = json.load(config_file)
    except FileNotFoundError as exc:
        raise SystemExit(f"Configuration file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in configuration file {path}: {exc}") from exc

    required = {"output_root", "odbc_driver", "create_filegdb", "databases"}
    missing = sorted(required - set(config))
    if missing:
        raise SystemExit(f"Missing configuration setting(s): {', '.join(missing)}")
    return config


CONFIG = _load_config(CONFIG_PATH)
DEFAULT_OUTPUT_ROOT = Path(CONFIG["output_root"]).expanduser()
if not DEFAULT_OUTPUT_ROOT.is_absolute():
    DEFAULT_OUTPUT_ROOT = CONFIG_PATH.parent / DEFAULT_OUTPUT_ROOT
DEFAULT_ODBC_DRIVER = str(CONFIG["odbc_driver"])
CREATE_FILEGDB = bool(CONFIG["create_filegdb"])
DATABASES: dict[str, SqlDatabase] = {
    key: SqlDatabase(key=key, **values)
    for key, values in CONFIG["databases"].items()
}


# Keep this manifest small and explicit. It was built from the SQL Server reads
# in the 001_MAIN.bat batch chain, including FME parameter files and Python
# helpers under pv-stm/cw-survey-prod/post-processing/proactive/inventory-team.


CLONE_ITEMS: list[CloneItem] = [
    CloneItem("stm_inventory", "dbo", "STORMPIPES_LN", "STORMPIPES_LN", source_note="inventory validation"),
    CloneItem("stm_inventory", "dbo", "STORMSTRUCTURE_PT", "STORMSTRUCTURE_PT", source_note="inventory validation"),
    CloneItem("stm_inventory", "dbo", "STORMCONNECTIVITY_LN", "STORMCONNECTIVITY_LN", source_note="inventory validation"),
    CloneItem("stm_inventory", "dbo", "STORMDRAINAGE_LN", "STORMDRAINAGE_LN", source_note="inventory validation"),
    CloneItem("sdw_stm", "dbo", "ROW_ESTIMATED_PY", "ROW_ESTIMATED_PY", where_clause="Maintained_By = 'CITY'", source_note="CITY_PIPES_LN FME SQLSERVER reader"),
    CloneItem("sdw_stm", "dbo", "CITY_PIPES_LN", "CITY_PIPES_LN", source_note="check_city_pipes_counts.py"),
    CloneItem("sdw", "dbo", "CITY_PIPES_LN", "CITY_PIPES_LN", source_note="check_city_pipes_counts.py"),
    CloneItem("sdw", "dbo", "CITYLIMITS_PY", "CITYLIMITS_PY", source_note="CITY_PIPES_LN and priority pipes FME SQLCreator"),
    CloneItem("sdw", "dbo", "STORMWATEREASEMENTS_PT", "STORMWATEREASEMENTS_PT", source_note="CITY_PIPES_LN and priority pipes FME SQLCreator"),
    CloneItem("sdw", "dbo", "PARCEL_PY", "PARCEL_PY", source_note="CITY_PIPES_LN and priority pipes FME SQLCreator"),
    CloneItem("sdw", "dbo", "AIRPORTOWNEDPARCELS_PY", "AIRPORTOWNEDPARCELS_PY", source_note="CITY_PIPES_LN FME SQLCreator"),
    CloneItem("sdw", "dbo", "FEMAFLOODPLAIN_PY", "FEMAFLOODPLAIN_PY", source_note="CITY_PIPES_LN FME SQLCreator"),
    CloneItem("sdw", "dbo", "IMPERVIOUSSURFACEOTHER_PY", "IMPERVIOUSSURFACEOTHER_PY", where_clause="Subtheme IN ('City EOP', 'State EOP', 'Sidewalk Public', 'Unmaintained EOP')", source_note="priority pipes FME SQLCreator"),
    CloneItem("sdw", "dbo", "IMPERVIOUSSURFACESINGLEFAMILY_PY", "IMPERVIOUSSURFACESINGLEFAMILY_PY", where_clause="Subtheme IN ('Building', 'Driveway')", source_note="priority pipes FME SQLCreator"),
    CloneItem("sdw", "dbo", "IMPERVIOUSSURFACENSF_PY", "IMPERVIOUSSURFACENSF_PY", source_note="priority pipes FME SQLCreator"),
    CloneItem("sdw", "dbo", "JURISDICTIONS_PY", "JURISDICTIONS_PY", where_clause="NAME = 'Charlotte'", source_note="priority pipes FME SQLCreator"),
    CloneItem("sdw_tableau", "dbo", "CITY_PIPES_LN", "CITY_PIPES_LN", source_note="check_city_pipes_counts.py"),
    CloneItem("new_cityworks_sqlserver", "dbo", "Culverts_evw", "Culverts_evw", source_note="CITY_PIPES_LN FME MSSQL_SPATIAL reader"),
    CloneItem("itpipes_prod", "dbo", "ML", "ML", source_note="ITPIPES validation"),
    CloneItem("itpipes_prod", "dbo", "MLI", "MLI", source_note="ITPIPES validation"),
    CloneItem("itpipes_prod", "dbo", "MLO", "MLO", source_note="ITPIPES validation"),
    CloneItem("itpipes_prod", "dbo", "Media", "Media", source_note="AM team ITPipes media replication"),
    CloneItem("itpipes_prod", "dbo", "MLO_Media", "MLO_Media", source_note="AM team ITPipes media replication"),
    CloneItem("itpipes_prod", "dbo", "MLI_Media", "MLI_Media", source_note="AM team ITPipes media replication"),
    CloneItem("cityworks_prod", "azteca", "INSPECTION", "azteca_INSPECTION", source_note="Cityworks asset inspections/investigations"),
    CloneItem("cityworks_prod", "azteca", "INSPQUESTION", "azteca_INSPQUESTION", source_note="Cityworks survey answers"),
    CloneItem("cityworks_prod", "azteca", "ACTIVITYLINK", "azteca_ACTIVITYLINK", source_note="Cityworks linked activity QA/QC"),
    CloneItem("cityworks_prod", "azteca", "PWCODE", "azteca_PWCODE", source_note="Cityworks priority/status lookup"),
    CloneItem("cityworks_prod", "azteca", "WORKORDER", "azteca_WORKORDER", source_note="H&H/post-processing work orders"),
    CloneItem("cityworks_prod", "azteca", "WORKORDERENTITY", "azteca_WORKORDERENTITY", source_note="workorder-to-asset QA/QC"),
    CloneItem("cityworks_prod", "azteca", "WORKORDERIMG", "azteca_WORKORDERIMG", source_note="workorder attachment paths for close-out Excel discovery"),
    CloneItem("cityworks_prod", "azteca", "REQUEST", "azteca_REQUEST", source_note="workorder-to-request QA/QC"),
]


def _import_runtime_packages():
    try:
        import duckdb  # type: ignore
        import pandas as pd  # type: ignore
        import sqlalchemy  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "Missing required Python package. Use an environment with duckdb, pandas, and sqlalchemy."
        ) from exc
    return duckdb, pd, sqlalchemy


def _import_filegdb_packages():
    try:
        import duckdb  # type: ignore
        import geopandas as gpd  # type: ignore
        import pandas as pd  # type: ignore
        import pyogrio  # type: ignore
        from shapely import from_wkb  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "Missing required Python package for FileGDB export. Use an environment "
            "with duckdb, geopandas, pandas, pyogrio, and shapely."
        ) from exc
    return duckdb, gpd, pd, pyogrio, from_wkb


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_")
    if not cleaned:
        cleaned = "table"
    if cleaned[0].isdigit():
        cleaned = f"_{cleaned}"
    return cleaned[:150]


def _quote_sqlserver_identifier(value: str) -> str:
    return f"[{value.replace(']', ']]')}]"


def _quote_duckdb_identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) + chr(34))}"'


def _qualified_sqlserver_name(item: CloneItem) -> str:
    if item.schema:
        return f"{_quote_sqlserver_identifier(item.schema)}.{_quote_sqlserver_identifier(item.name)}"
    return _quote_sqlserver_identifier(item.name)


def _object_name_for_metadata(item: CloneItem) -> str:
    return item.qualified_name if item.schema else item.name


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
    except ValueError:
        return False
    return True


def _reset_duckdb(output_root: Path, duckdb_name: str) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    live_path = output_root / duckdb_name
    if live_path.suffix.lower() != ".duckdb" or not _is_relative_to(live_path, output_root):
        raise RuntimeError(f"Refusing to stage unsafe DuckDB path: {live_path}")
    db_path = live_path.with_name(f".{live_path.stem}.next-{os.getpid()}.duckdb")

    for candidate in [db_path, db_path.with_suffix(db_path.suffix + ".wal")]:
        if candidate.exists():
            print(f"  reset_duckdb: removing abandoned staging file {candidate}")
            candidate.unlink()
    return db_path


def _publish_staged_duckdb(staging_path: Path, live_path: Path, duckdb: Any) -> None:
    with duckdb.connect(str(staging_path), read_only=True) as connection:
        table_count = connection.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'main'"
        ).fetchone()[0]
        if not table_count:
            raise RuntimeError(f"Staged DuckDB contains no tables: {staging_path}")
    os.replace(staging_path, live_path)
    staging_path.with_suffix(staging_path.suffix + ".wal").unlink(missing_ok=True)
    print(f"  published: {live_path} ({table_count} tables)")


def _reset_filegdb(output_root: Path, gdb_path: Path) -> None:
    if gdb_path.suffix.lower() != ".gdb" or not _is_relative_to(gdb_path, output_root):
        raise RuntimeError(f"Refusing to delete unsafe FileGDB path: {gdb_path}")

    if not gdb_path.exists():
        return

    print(f"  reset_filegdb: removing existing {gdb_path}")
    if gdb_path.is_dir():
        shutil.rmtree(gdb_path)
    else:
        gdb_path.unlink()


def _connection_string(
    database: SqlDatabase,
    odbc_driver: str,
    trust_server_certificate: bool,
) -> str:
    parts = [
        f"DRIVER={{{odbc_driver}}}",
        f"SERVER={database.server}",
        f"DATABASE={database.database}",
    ]
    if trust_server_certificate:
        parts.append("TrustServerCertificate=yes")

    if database.auth_method == "windows":
        parts.append("Trusted_Connection=yes")
    elif database.auth_method == "sql_server":
        password = database.password or os.environ.get(database.password_env, "")
        if not database.username or not password:
            raise RuntimeError(
                f"{database.key} uses SQL Server authentication. Set "
                f"{database.password_env} before running this script."
            )
        parts.extend([f"UID={database.username}", f"PWD={password}"])
    else:
        raise RuntimeError(f"Unsupported auth_method for {database.key}: {database.auth_method}")
    return ";".join(parts)


def _sqlalchemy_url(connection_string: str) -> str:
    return f"mssql+pyodbc:///?odbc_connect={quote_plus(connection_string)}"


def _read_sql_columns(pd: Any, sqlalchemy: Any, conn: Any, item: CloneItem) -> list[tuple[str, str]]:
    query = """
        SELECT c.name AS column_name, t.name AS type_name
        FROM sys.columns c
        INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
        WHERE c.object_id = OBJECT_ID(:object_name)
        ORDER BY c.column_id
    """
    rows = pd.read_sql_query(
        sqlalchemy.text(query),
        conn,
        params={"object_name": _object_name_for_metadata(item)},
    )
    if rows.empty:
        raise RuntimeError(f"Could not find SQL Server object {item.qualified_name}")
    return [
        (str(row.column_name), str(row.type_name).lower())
        for row in rows.itertuples(index=False)
    ]


def _build_select_sql(item: CloneItem, columns: list[tuple[str, str]]) -> tuple[str, str | None]:
    spatial_columns = [
        column_name
        for column_name, type_name in columns
        if type_name.lower() in SPATIAL_TYPES
    ]
    if len(spatial_columns) > 1:
        raise RuntimeError(
            f"{item.qualified_name} has multiple spatial columns: {', '.join(spatial_columns)}"
        )

    spatial_column = spatial_columns[0] if spatial_columns else None
    select_parts = [
        _quote_sqlserver_identifier(column_name)
        for column_name, _type_name in columns
        if column_name != spatial_column
    ]
    if spatial_column:
        geom = _quote_sqlserver_identifier(spatial_column)
        select_parts.extend(
            [
                f"{geom}.STAsBinary() AS __geometry_wkb",
                f"{geom}.STSrid AS __geometry_srid",
            ]
        )

    query = f"SELECT {', '.join(select_parts)} FROM {_qualified_sqlserver_name(item)}"
    if item.where_clause:
        query = f"{query} WHERE {item.where_clause}"
    return query, spatial_column


def _read_item_dataframe(
    pd: Any,
    sqlalchemy: Any,
    conn: Any,
    item: CloneItem,
) -> tuple[Any, str | None]:
    columns = _read_sql_columns(pd, sqlalchemy, conn, item)
    query, spatial_column = _build_select_sql(item, columns)
    return pd.read_sql_query(sqlalchemy.text(query), conn), spatial_column


def _install_load_spatial(duck_conn: Any) -> None:
    try:
        duck_conn.execute("LOAD spatial")
    except Exception:
        duck_conn.execute("INSTALL spatial")
        duck_conn.execute("LOAD spatial")


def _list_duckdb_tables(duck_conn: Any) -> list[str]:
    rows = duck_conn.execute(
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'main'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
        """
    ).fetchall()
    return [str(row[0]) for row in rows]


def _duckdb_table_columns(duck_conn: Any, table_name: str) -> list[tuple[str, str]]:
    rows = duck_conn.execute(
        f"DESCRIBE {_quote_duckdb_identifier(table_name)}"
    ).fetchall()
    return [(str(row[0]), str(row[1])) for row in rows]


def _duckdb_spatial_columns(duck_conn: Any, table_name: str) -> list[str]:
    return [
        column_name
        for column_name, data_type in _duckdb_table_columns(duck_conn, table_name)
        if data_type.upper().startswith("GEOMETRY")
    ]


def _wkb_to_geometry(from_wkb: Any, pd: Any, value: Any) -> Any:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, memoryview):
        value = value.tobytes()
    elif isinstance(value, bytearray):
        value = bytes(value)
    return from_wkb(value)


def _crs_from_srid(dataframe: Any) -> str | None:
    if "__geometry_srid" not in dataframe.columns or dataframe.empty:
        return None

    srids = {
        int(value)
        for value in dataframe["__geometry_srid"].dropna().unique().tolist()
        if int(value) > 0
    }
    if len(srids) == 1:
        return f"EPSG:{next(iter(srids))}"
    return None


def _read_duckdb_table_for_filegdb(
    duck_conn: Any,
    gpd: Any,
    pd: Any,
    from_wkb: Any,
    table_name: str,
) -> Any:
    spatial_columns = _duckdb_spatial_columns(duck_conn, table_name)
    quoted_table = _quote_duckdb_identifier(table_name)

    if len(spatial_columns) > 1:
        raise RuntimeError(
            f"{table_name} has multiple geometry columns and cannot be written "
            "to one FileGDB layer: " + ", ".join(spatial_columns)
        )

    if not spatial_columns:
        return duck_conn.execute(f"SELECT * FROM {quoted_table}").fetchdf()

    geometry_column = spatial_columns[0]
    output_columns = [
        column_name
        for column_name, _data_type in _duckdb_table_columns(duck_conn, table_name)
        if column_name != geometry_column
    ]
    select_parts = [_quote_duckdb_identifier(column) for column in output_columns]
    select_parts.append(
        f"ST_AsWKB({_quote_duckdb_identifier(geometry_column)}) AS __geometry_wkb"
    )

    dataframe = duck_conn.execute(
        f"SELECT {', '.join(select_parts)} FROM {quoted_table}"
    ).fetchdf()
    crs = _crs_from_srid(dataframe)
    geometry = dataframe.pop("__geometry_wkb").apply(
        lambda value: _wkb_to_geometry(from_wkb, pd, value)
    )
    dataframe = dataframe.drop(columns=["__geometry_srid"], errors="ignore")
    return gpd.GeoDataFrame(dataframe, geometry=geometry, crs=crs)


def _filegdb_geometry_family(geometry_type: str) -> str | None:
    if geometry_type in {"Point", "MultiPoint"}:
        return "point"
    if geometry_type in {"LineString", "MultiLineString"}:
        return "line"
    if geometry_type in {"Polygon", "MultiPolygon"}:
        return "polygon"
    return None


def _prepare_dataframe_for_filegdb(dataframe: Any, pd: Any) -> tuple[Any, dict[str, Any]]:
    if not hasattr(dataframe, "geometry"):
        return dataframe, {}

    geometry_column = dataframe.geometry.name
    geometry = dataframe.geometry
    geometry_types = set(geometry.dropna().geom_type.unique())

    unsupported_types = {
        geometry_type
        for geometry_type in geometry_types
        if _filegdb_geometry_family(str(geometry_type)) is None
    }
    if unsupported_types:
        dataframe = dataframe.copy()
        unsupported_mask = dataframe.geometry.geom_type.isin(unsupported_types)
        dataframe.loc[unsupported_mask, geometry_column] = None
        geometry = dataframe.geometry
        geometry_types = set(geometry.dropna().geom_type.unique())
        print(
            "    set unsupported geometries to null: "
            + ", ".join(sorted(str(value) for value in unsupported_types))
        )

    if not geometry_types:
        return pd.DataFrame(dataframe.drop(columns=[geometry_column])), {}

    families = {_filegdb_geometry_family(str(geometry_type)) for geometry_type in geometry_types}
    if len(families) != 1:
        print(
            "    mixed geometry families found; writing attributes only: "
            + ", ".join(sorted(str(value) for value in geometry_types))
        )
        return pd.DataFrame(dataframe.drop(columns=[geometry_column])), {}

    write_options: dict[str, Any] = {}
    if any(str(geometry_type).startswith("Multi") for geometry_type in geometry_types):
        family = next(iter(families))
        write_options["promote_to_multi"] = True
        if family == "point":
            write_options["geometry_type"] = "MultiPoint"
        elif family == "line":
            write_options["geometry_type"] = "MultiLineString"
        elif family == "polygon":
            write_options["geometry_type"] = "MultiPolygon"

    return dataframe, write_options


def export_duckdbs_to_filegdbs(output_root: Path, db_paths: list[Path]) -> None:
    duckdb, _gpd, pd, pyogrio, from_wkb = _import_filegdb_packages()

    print("\nCreating Esri FileGDB copies from local DuckDB files.")
    for db_path in db_paths:
        gdb_path = db_path.with_suffix(".gdb")
        _reset_filegdb(output_root=output_root, gdb_path=gdb_path)
        print(f"\n[filegdb] {db_path.name} -> {gdb_path.name}")

        with duckdb.connect(str(db_path), read_only=True) as duck_conn:
            _install_load_spatial(duck_conn)
            table_names = _list_duckdb_tables(duck_conn)
            for table_name in table_names:
                layer_name = _safe_name(table_name)
                dataframe = _read_duckdb_table_for_filegdb(
                    duck_conn=duck_conn,
                    gpd=_gpd,
                    pd=pd,
                    from_wkb=from_wkb,
                    table_name=table_name,
                )
                dataframe, write_options = _prepare_dataframe_for_filegdb(dataframe, pd)
                pyogrio.write_dataframe(
                    dataframe,
                    gdb_path,
                    layer=layer_name,
                    driver="OpenFileGDB",
                    layer_options={
                        "TARGET_ARCGIS_VERSION": "ARCGIS_PRO_3_2_OR_LATER"
                    },
                    **write_options,
                )
                print(f"  wrote {len(dataframe)} rows: {layer_name}")


def _write_item_dataframe(
    duck_conn: Any,
    dataframe: Any,
    item: CloneItem,
    spatial_column: str | None,
    build_spatial_indexes: bool = False,
) -> None:
    table_name = _safe_name(item.output_name)
    temp_name = f"__clone_{table_name}"
    quoted_table = _quote_duckdb_identifier(table_name)
    quoted_temp = _quote_duckdb_identifier(temp_name)

    duck_conn.execute(f"DROP TABLE IF EXISTS {quoted_table}")
    duck_conn.execute(f"DROP TABLE IF EXISTS {quoted_temp}")
    duck_conn.register(temp_name, dataframe)

    try:
        if not spatial_column:
            duck_conn.execute(f"CREATE TABLE {quoted_table} AS SELECT * FROM {quoted_temp}")
            return

        output_columns = [
            column
            for column in dataframe.columns
            if column not in {"__geometry_wkb", "__geometry_srid"}
        ]
        select_parts = [
            f"{_quote_duckdb_identifier(column)}"
            for column in output_columns
        ]
        select_parts.append(
            f"ST_GeomFromWKB(__geometry_wkb) AS {_quote_duckdb_identifier(spatial_column)}"
        )
        select_parts.append("__geometry_srid")
        duck_conn.execute(
            f"CREATE TABLE {quoted_table} AS SELECT {', '.join(select_parts)} FROM {quoted_temp}"
        )
        if build_spatial_indexes:
            ordered_name = f"__hilbert_{table_name}"
            quoted_ordered = _quote_duckdb_identifier(ordered_name)
            quoted_geometry = _quote_duckdb_identifier(spatial_column)
            quoted_index = _quote_duckdb_identifier(f"{table_name}_rtree")
            duck_conn.execute(f"DROP TABLE IF EXISTS {quoted_ordered}")
            duck_conn.execute(
                f"CREATE TABLE {quoted_ordered} AS "
                f"SELECT * FROM {quoted_table} "
                f"ORDER BY CASE WHEN {quoted_geometry} IS NULL OR ST_IsEmpty({quoted_geometry}) "
                f"THEN NULL ELSE ST_Hilbert({quoted_geometry}) END NULLS LAST"
            )
            duck_conn.execute(f"DROP TABLE {quoted_table}")
            duck_conn.execute(
                f"ALTER TABLE {quoted_ordered} RENAME TO {quoted_table}"
            )
            duck_conn.execute(
                f"CREATE INDEX {quoted_index} ON {quoted_table} USING rtree ({quoted_geometry})"
            )
    finally:
        duck_conn.unregister(temp_name)
        duck_conn.execute(f"DROP TABLE IF EXISTS {quoted_temp}")


def _clone_one(
    pd: Any,
    sqlalchemy: Any,
    duck_conn: Any,
    sql_conn: Any,
    item: CloneItem,
    build_spatial_indexes: bool = False,
) -> str:
    dataframe, spatial_column = _read_item_dataframe(
        pd,
        sqlalchemy,
        sql_conn,
        item,
    )
    _write_item_dataframe(
        duck_conn,
        dataframe,
        item,
        spatial_column,
        build_spatial_indexes=build_spatial_indexes,
    )
    suffix = " with ST_Hilbert ordering and R-Tree" if build_spatial_indexes and spatial_column else ""
    return f"cloned {len(dataframe)} rows{suffix}"


def _group_items(items: list[CloneItem]) -> dict[str, list[CloneItem]]:
    grouped: dict[str, list[CloneItem]] = {}
    for item in items:
        grouped.setdefault(item.connection_key, []).append(item)
    return grouped


def write_manifest_csv(
    path: Path,
    items: list[CloneItem],
    databases: dict[str, SqlDatabase] | None = None,
) -> None:
    database_map = databases or DATABASES
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(
            [
                "connection_key",
                "server",
                "database",
                "schema",
                "table",
                "output_duckdb",
                "output_name",
                "where_clause",
                "source_note",
            ]
        )
        for item in items:
            db = database_map[item.connection_key]
            writer.writerow(
                [
                    item.connection_key,
                    db.server,
                    db.database,
                    item.schema,
                    item.name,
                    db.duckdb_name,
                    item.output_name,
                    item.where_clause or "",
                    item.source_note,
                ]
            )


def print_manifest(
    items: list[CloneItem],
    databases: dict[str, SqlDatabase] | None = None,
) -> None:
    database_map = databases or DATABASES
    for key, grouped_items in _group_items(items).items():
        db = database_map[key]
        print(f"{key}: {db.server}/{db.database} [{db.auth_method}] -> {db.duckdb_name}")
        for item in grouped_items:
            where = f" WHERE {item.where_clause}" if item.where_clause else ""
            print(f"  {item.qualified_name}{where} -> {item.output_name}")


def run_clone(
    output_root: Path,
    items: list[CloneItem],
    continue_on_error: bool,
    odbc_driver: str,
    trust_server_certificate: bool,
    create_filegdb: bool,
    databases: dict[str, SqlDatabase] | None = None,
    build_spatial_indexes: bool = False,
) -> int:
    duckdb, pd, sqlalchemy = _import_runtime_packages()

    database_map = databases or DATABASES
    failures = 0
    grouped = _group_items(items)
    cloned_db_paths: list[Path] = []

    for key, grouped_items in grouped.items():
        database = database_map[key]
        group_failed = False
        print(f"\n[{key}] {database.server}/{database.database}")
        connection_string = _connection_string(
            database=database,
            odbc_driver=odbc_driver,
            trust_server_certificate=trust_server_certificate,
        )
        engine = sqlalchemy.create_engine(_sqlalchemy_url(connection_string), fast_executemany=False)
        try:
            with engine.connect() as sql_conn:
                db_path = _reset_duckdb(output_root, database.duckdb_name)
                live_path = output_root / database.duckdb_name
                with duckdb.connect(str(db_path)) as duck_conn:
                    _install_load_spatial(duck_conn)
                    for item in grouped_items:
                        try:
                            status = _clone_one(
                                pd=pd,
                                sqlalchemy=sqlalchemy,
                                duck_conn=duck_conn,
                                sql_conn=sql_conn,
                                item=item,
                                build_spatial_indexes=build_spatial_indexes,
                            )
                            print(f"  {status}: {item.qualified_name} -> {db_path}::{_safe_name(item.output_name)}")
                        except Exception as exc:
                            failures += 1
                            group_failed = True
                            print(f"  failed: {item.qualified_name}: {exc}")
                            if not continue_on_error:
                                break
                if not group_failed:
                    _publish_staged_duckdb(db_path, live_path, duckdb)
                    cloned_db_paths.append(live_path)
                else:
                    db_path.unlink(missing_ok=True)
                    db_path.with_suffix(db_path.suffix + ".wal").unlink(missing_ok=True)
                    if not continue_on_error:
                        return failures
        finally:
            engine.dispose()

    if create_filegdb and failures:
        print("\nSkipping FileGDB export because one or more DuckDB clone steps failed.")
    elif create_filegdb:
        export_duckdbs_to_filegdbs(output_root=output_root, db_paths=cloned_db_paths)

    return failures


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Clone SQL Server inputs used by pv-stm 001_MAIN.bat to local DuckDB files. "
            "Each selected local DuckDB file is deleted and recreated before cloning."
        )
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help=(
            "Folder where per-database DuckDB files are created. "
            f"Default from {CONFIG_PATH.name}: {DEFAULT_OUTPUT_ROOT}"
        ),
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Print the clone manifest and exit without connecting to SQL Server.",
    )
    parser.add_argument(
        "--write-manifest",
        type=Path,
        default=None,
        help="Optional CSV path for the manifest.",
    )
    parser.add_argument(
        "--connection-key",
        action="append",
        default=None,
        help="Limit cloning to one connection key. Can be repeated.",
    )
    parser.add_argument(
        "--odbc-driver",
        default=DEFAULT_ODBC_DRIVER,
        help=f"SQL Server ODBC driver name. Default: {DEFAULT_ODBC_DRIVER}",
    )
    parser.add_argument(
        "--no-trust-server-certificate",
        action="store_true",
        help="Do not add TrustServerCertificate=yes to the ODBC connection string.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue cloning remaining items if one dataset fails.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    items = CLONE_ITEMS
    if args.connection_key:
        allowed = set(args.connection_key)
        unknown = sorted(allowed - set(DATABASES))
        if unknown:
            parser.error(f"Unknown connection key(s): {', '.join(unknown)}")
        items = [item for item in items if item.connection_key in allowed]

    if args.write_manifest:
        write_manifest_csv(args.write_manifest, items, DATABASES)

    if args.list:
        print_manifest(items, DATABASES)
        return 0

    failures = run_clone(
        output_root=args.output_root,
        items=items,
        continue_on_error=args.continue_on_error,
        odbc_driver=args.odbc_driver,
        trust_server_certificate=not args.no_trust_server_certificate,
        create_filegdb=CREATE_FILEGDB,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
