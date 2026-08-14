from __future__ import annotations

import math
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from portal.app.core.duckdb_extensions import load_spatial_extension
from portal.app.core.source_cache import resolve_source, source_info
from portal.app.exports import ExcelColumn, ExcelSheet, build_portal_excel_workbook
from portal.app.resources.tables.storm_water_asset_history.source import latest_itpipes_inspection_defects
from portal.runtime.transport import HTTPException


PROFILE_MODES = {"draw", "pipe", "drainage"}
MAX_PROFILE_VERTICES = 10_000
MAX_PROFILE_SAMPLES = 2_000
MIN_PROFILE_LENGTH_FEET = 1.0
INVENTORY_SRID = 2264
ASSET_SOURCES = {
    "pipe": {
        "table": "STORMPIPES_1_LN",
        "id_columns": ("ITPIPE_ASSETID", "PIPE_ID", "AssetID"),
        "fields": (
            "ITPIPE_ASSETID",
            "PIPE_ID",
            "AssetID",
            "US_ID",
            "US_ASSETID",
            "US_INVERT",
            "US_ELEV",
            "DS_ID",
            "DS_ASSETID",
            "DS_INVERT",
            "DS_ELEV",
            "DIAMETER",
            "PI_SHAPE",
        ),
    },
    "drainage": {
        "table": "STORMDRAINAGE_1_LN",
        "id_columns": ("ITPIPE_ASSETID", "CHAN_ID", "AssetID"),
        "fields": (
            "ITPIPE_ASSETID",
            "CHAN_ID",
            "AssetID",
            "US_ID",
            "US_ASSETID",
            "DS_ID",
            "DS_ASSETID",
            "CH_SHAPE",
            "WIDTH_TOP",
            "WIDTH_BTTM",
            "DEPTH",
        ),
    },
}


def build_terrain_profile(
    payload: dict[str, Any],
    *,
    dem_path: Path | None = None,
    inventory_path: Path | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    mode = str(payload.get("mode") or "").strip().lower()
    if mode not in PROFILE_MODES:
        raise HTTPException(status_code=422, detail="Profile mode must be draw, pipe, or drainage.")

    warnings: list[str] = []
    asset: dict[str, Any] | None = None
    if mode == "draw":
        line = _line_from_geojson(payload.get("geometry"))
        source_crs = "EPSG:4326"
        orientation = "drawn"
    else:
        asset_id = str(payload.get("asset_id") or "").strip()
        if not asset_id:
            raise HTTPException(status_code=422, detail="Select an asset before generating its terrain profile.")
        asset, line = _load_asset_line(mode, asset_id, inventory_path=inventory_path)
        source_crs = f"EPSG:{INVENTORY_SRID}"
        line, orientation = _orient_asset_line(line, asset, inventory_path=inventory_path)
        if orientation == "source_geometry_order":
            warnings.append(
                "The asset endpoints could not be matched to inventory structures; source geometry order was used."
            )

    resolved_dem, dem_metadata = _resolve_dem(dem_path)
    result = _sample_profile(
        line,
        source_crs=source_crs,
        dem_path=resolved_dem,
        mode=mode,
        asset=asset,
        requested_interval=payload.get("sample_interval_feet"),
        warnings=warnings,
    )
    if mode == "pipe":
        try:
            result["itpipes"] = _itpipes_profile_overlay(
                latest_itpipes_inspection_defects(str((asset or {}).get("asset_id") or "")),
                result["statistics"]["length_feet"],
            )
        except Exception as exc:  # The terrain profile remains usable when optional ITPipes data is unavailable.
            detail = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
            result["itpipes"] = {
                "status": "unavailable",
                "message": detail,
                "inspection": None,
                "defects": [],
                "located_count": 0,
                "unlocated_count": 0,
            }
            result["warnings"].append(f"ITPipes defect overlay is unavailable: {detail}")
    else:
        result["itpipes"] = None
    result["orientation"] = orientation
    result["dem"] = dem_metadata | result.pop("dem_runtime")
    result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
    return result


def build_terrain_profile_excel(profile: dict[str, Any], exported_by: str) -> bytes:
    samples = profile.get("samples")
    if not isinstance(samples, list) or not samples:
        raise HTTPException(status_code=422, detail="Generate a terrain profile before exporting it.")
    mode = str(profile.get("mode") or "draw").strip().lower()
    asset = profile.get("asset") if isinstance(profile.get("asset"), dict) else {}
    columns = [
        ExcelColumn("distance_feet", "Distance (ft)", 16, "number"),
        ExcelColumn("ground_elevation", "Ground elevation (ft)", 22, "number"),
    ]
    if any(item.get("asset_elevation") is not None for item in samples if isinstance(item, dict)):
        columns.extend(
            [
                ExcelColumn("asset_elevation", "Pipe invert elevation (ft)", 24, "number"),
                ExcelColumn("cover", "Ground to invert (ft)", 20, "number"),
            ]
        )
    columns.extend(
        [
            ExcelColumn("longitude", "Longitude", 16, "number"),
            ExcelColumn("latitude", "Latitude", 16, "number"),
        ]
    )
    filters = {
        "Profile mode": mode.title(),
        "Asset ID": asset.get("asset_id") or "",
        "Upstream structure": asset.get("US_ASSETID") or asset.get("US_ID") or "",
        "Upstream invert (ft)": asset.get("US_INVERT") if asset.get("US_INVERT") is not None else "",
        "Downstream structure": asset.get("DS_ASSETID") or asset.get("DS_ID") or "",
        "Downstream invert (ft)": asset.get("DS_INVERT") if asset.get("DS_INVERT") is not None else "",
        "Pipe diameter (ft)": asset.get("DIAMETER") if asset.get("DIAMETER") is not None else "",
        "Pipe shape": asset.get("PI_SHAPE") or "",
        "Drainage shape": asset.get("CH_SHAPE") or "",
        "Drainage depth (ft)": asset.get("DEPTH") if asset.get("DEPTH") is not None else "",
        "DEM": (profile.get("dem") or {}).get("file_name") or "",
        "DEM version": (profile.get("dem") or {}).get("version") or "",
        "Orientation": str(profile.get("orientation") or "").replace("_", " ").title(),
    }
    sheets = [
        ExcelSheet(
            "Terrain Profile",
            "Storm Water Terrain Profile",
            columns,
            [item for item in samples if isinstance(item, dict)],
            filters,
        )
    ]
    itpipes = profile.get("itpipes") if isinstance(profile.get("itpipes"), dict) else None
    inspection = itpipes.get("inspection") if isinstance(itpipes, dict) and isinstance(itpipes.get("inspection"), dict) else None
    defects = itpipes.get("defects") if isinstance(itpipes, dict) and isinstance(itpipes.get("defects"), list) else []
    if inspection is not None:
        defect_columns = [
            ExcelColumn("mli_id", "MLI ID", 14),
            ExcelColumn("mlo_id", "MLO ID", 14),
            ExcelColumn("inspection_date", "Inspection date", 20, "datetime"),
            ExcelColumn("inspection_direction", "Inspection direction", 24),
            ExcelColumn("observation_text", "Observation", 36, wrap_text=True),
            ExcelColumn("source_distance_feet", "Source distance (ft)", 20, "number"),
            ExcelColumn("profile_distance_feet", "Profile station (ft)", 20, "number"),
            ExcelColumn("condition_risk", "Condition risk", 16, "number"),
            ExcelColumn("relative_depth", "Relative depth", 16, "number"),
            ExcelColumn("is_continuous", "Continuous", 14),
            ExcelColumn("location_status", "Location status", 22),
        ]
        defect_rows = [
            {
                **item,
                "mli_id": inspection.get("mli_id"),
                "inspection_date": inspection.get("inspection_date"),
                "inspection_direction": inspection.get("inspection_direction_label") or inspection.get("inspection_direction"),
            }
            for item in defects if isinstance(item, dict)
        ]
        sheets.append(
            ExcelSheet(
                "ITPipes Defects",
                "Latest ITPipes Inspection Defects",
                defect_columns,
                defect_rows,
                {
                    "Asset ID": asset.get("asset_id") or "",
                    "MLI ID": inspection.get("mli_id") or "",
                    "Inspection date": inspection.get("inspection_date") or "",
                    "Inspection direction": inspection.get("inspection_direction_label") or inspection.get("inspection_direction") or "",
                    "Rule": "Latest MLI inspection; COND_RISK > 0",
                },
            )
        )
    return build_portal_excel_workbook(
        report_title="Storm Water Terrain Profile",
        sheets=sheets,
        exported_by=exported_by,
        vertical_alignment="center",
        number_format="0.###",
    )


def _itpipes_profile_overlay(latest: dict[str, Any] | None, length_feet: Any) -> dict[str, Any]:
    length = _finite_number(length_feet)
    if latest is None:
        return {
            "status": "no_inspection",
            "message": "No ITPipes inspection is available for this pipe.",
            "inspection": None,
            "defects": [],
            "located_count": 0,
            "unlocated_count": 0,
        }
    if length is None or length <= 0:
        raise HTTPException(status_code=422, detail="The selected pipe has no usable profile length.")
    direction_code = _inspection_direction_code(latest.get("inspection_direction"))
    direction_label = (
        "Upstream to downstream" if direction_code == 1
        else "Downstream to upstream" if direction_code == 0
        else "Unknown"
    )
    inspection = {
        "mli_id": str(latest.get("mli_id") or ""),
        "ml_id": str(latest.get("ml_id") or ""),
        "inspection_date": latest.get("inspection_date"),
        "inspection_direction": latest.get("inspection_direction"),
        "inspection_direction_code": direction_code,
        "inspection_direction_label": direction_label,
        "production_asset_id": str(latest.get("production_asset_id") or ""),
    }
    tolerance = max(1.0, min(5.0, length * 0.02))
    defects: list[dict[str, Any]] = []
    for source in latest.get("defects") or []:
        if not isinstance(source, dict):
            continue
        risk = _finite_number(source.get("condition_risk"))
        if risk is None or risk <= 0:
            continue
        source_distance = _finite_number(source.get("source_distance_feet"))
        profile_distance: float | None = None
        location_status = "located"
        if source_distance is None:
            location_status = "missing_distance"
        elif direction_code is None:
            location_status = "unknown_direction"
        else:
            candidate = source_distance if direction_code == 1 else length - source_distance
            if candidate < -tolerance or candidate > length + tolerance:
                location_status = "out_of_range"
            else:
                profile_distance = min(length, max(0.0, candidate))
                if candidate < 0:
                    location_status = "clamped_to_upstream"
                elif candidate > length:
                    location_status = "clamped_to_downstream"
        defects.append(
            {
                "mlo_id": str(source.get("mlo_id") or ""),
                "observation_text": source.get("observation_text"),
                "source_distance_feet": _rounded(source_distance),
                "profile_distance_feet": _rounded(profile_distance),
                "condition_risk": _rounded(risk),
                "relative_depth": _rounded(source.get("relative_depth")),
                "is_continuous": source.get("is_continuous"),
                "location_status": location_status,
            }
        )
    located_count = sum(item["profile_distance_feet"] is not None for item in defects)
    unlocated_count = len(defects) - located_count
    status = "ready" if defects else "no_positive_defects"
    message = (
        "No observations with condition risk greater than 0 were found in the latest inspection."
        if not defects else ""
    )
    return {
        "status": status,
        "message": message,
        "inspection": inspection,
        "defects": defects,
        "located_count": located_count,
        "unlocated_count": unlocated_count,
        "station_tolerance_feet": round(tolerance, 3),
        "risk_scale": {"minimum": 0, "maximum": 100},
    }


def _inspection_direction_code(value: Any) -> int | None:
    numeric = _finite_number(value)
    if numeric in {0.0, 1.0}:
        return int(numeric)
    normalized = "".join(character for character in str(value or "").casefold() if character.isalnum())
    if normalized in {"downstream", "upstreamtodownstream", "ustods", "us2ds"}:
        return 1
    if normalized in {"upstream", "downstreamtoupstream", "dstous", "ds2us"}:
        return 0
    return None


def _resolve_dem(explicit_path: Path | None) -> tuple[Path, dict[str, Any]]:
    source_id = os.getenv("PORTAL_MAP_TERRAIN_DEM_SOURCE_ID", "").strip()
    file_name = os.getenv("PORTAL_MAP_TERRAIN_DEM", "").strip()
    if explicit_path is not None:
        path = explicit_path
    else:
        if not source_id or not file_name:
            raise HTTPException(
                status_code=503,
                detail="The analytical terrain DEM is not configured in portal.settings.json.",
            )
        if file_name != Path(file_name).name or Path(file_name).suffix.lower() not in {".tif", ".tiff"}:
            raise HTTPException(status_code=500, detail="The configured terrain DEM must be a GeoTIFF file name.")
        terrain_root = os.getenv("PORTAL_MAP_TERRAIN_ROOT", "").strip()
        fallback = str(Path(terrain_root) / file_name) if terrain_root else file_name
        path = Path(resolve_source(source_id, fallback, label="Terrain DEM"))
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"The active local terrain DEM was not found: {path}")

    info = source_info(source_id) if source_id else {}
    version = str(info.get("version") or "").strip()
    if not version:
        try:
            version = datetime.fromtimestamp(path.stat().st_mtime).astimezone().strftime("%Y%m%dT%H%M%S%z")
        except OSError:
            version = ""
    return path, {
        "source_id": source_id,
        "file_name": path.name,
        "version": version,
    }


def _line_from_geojson(value: Any) -> Any:
    try:
        from shapely.geometry import shape
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include shapely.") from exc
    if not isinstance(value, dict) or str(value.get("type") or "") not in {"LineString", "MultiLineString"}:
        raise HTTPException(status_code=422, detail="Draw a valid profile line on the map.")
    coordinates = value.get("coordinates")
    vertex_count = _coordinate_count(coordinates)
    if vertex_count < 2 or vertex_count > MAX_PROFILE_VERTICES:
        raise HTTPException(
            status_code=422,
            detail=f"A profile line must contain 2 to {MAX_PROFILE_VERTICES:,} vertices.",
        )
    try:
        return _single_line(shape(value))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="The profile line geometry is invalid.") from exc


def _coordinate_count(value: Any) -> int:
    if not isinstance(value, (list, tuple)):
        return 0
    if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
        return 1
    return sum(_coordinate_count(item) for item in value)


def _single_line(geometry: Any) -> Any:
    try:
        from shapely import line_merge
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include shapely.") from exc
    if geometry.is_empty:
        raise HTTPException(status_code=422, detail="The profile line is empty.")
    if geometry.geom_type == "LineString":
        return geometry
    if geometry.geom_type == "MultiLineString":
        merged = line_merge(geometry)
        if merged.geom_type == "LineString":
            return merged
        parts = list(merged.geoms)
        if parts:
            return max(parts, key=lambda item: item.length)
    raise HTTPException(status_code=422, detail="The selected geometry is not a usable line.")


def _load_asset_line(
    mode: str,
    asset_id: str,
    *,
    inventory_path: Path | None,
) -> tuple[dict[str, Any], Any]:
    try:
        import duckdb
        from shapely import from_wkb
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime is missing DuckDB or Shapely.") from exc

    path = inventory_path or Path(os.getenv("PORTAL_INVENTORY_DUCKDB", ""))
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"The active local inventory database was not found: {path}")
    config = ASSET_SOURCES[mode]
    connection = duckdb.connect(str(path), read_only=True)
    try:
        load_spatial_extension(connection)
        table = str(config["table"])
        described = connection.execute(f"DESCRIBE SELECT * FROM {_quote(table)}").fetchall()
        fields = {str(row[0]).casefold(): str(row[0]) for row in described}
        geometry_column = fields.get("geometry")
        if not geometry_column:
            raise HTTPException(status_code=503, detail=f"Inventory table {table} has no geometry column.")
        selected = [field for field in config["fields"] if str(field).casefold() in fields]
        select_sql = [f"{_quote(fields[str(field).casefold()])} AS {_quote(str(field))}" for field in selected]
        select_sql.append(f"ST_AsWKB({_quote(geometry_column)}) AS __geometry_wkb")
        predicates = []
        parameters: list[Any] = []
        for field in config["id_columns"]:
            actual = fields.get(str(field).casefold())
            if actual:
                predicates.append(f"upper(trim(CAST({_quote(actual)} AS VARCHAR))) = upper(?)")
                parameters.append(asset_id)
        rows = connection.execute(
            f"SELECT {', '.join(select_sql)} FROM {_quote(table)} WHERE {' OR '.join(predicates)} LIMIT 2",
            parameters,
        ).fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found in {table}.")
        if len(rows) > 1:
            raise HTTPException(status_code=409, detail=f"Asset ID {asset_id} is not unique in {table}.")
        values = dict(zip([item[0] for item in connection.description], rows[0]))
        line = _single_line(from_wkb(bytes(values.pop("__geometry_wkb"))))
        normalized_asset_id = str(values.get("ITPIPE_ASSETID") or values.get("PIPE_ID") or values.get("CHAN_ID") or asset_id)
        asset = {
            "asset_id": normalized_asset_id,
            "asset_type": mode,
            "source_table": table,
            **{key: _json_number(value) for key, value in values.items()},
        }
        return asset, line
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not read the selected asset profile: {exc}") from exc
    finally:
        connection.close()


def _orient_asset_line(line: Any, asset: dict[str, Any], *, inventory_path: Path | None) -> tuple[Any, str]:
    upstream = _asset_endpoint(asset, "US", inventory_path)
    downstream = _asset_endpoint(asset, "DS", inventory_path)
    start = line.coords[0]
    end = line.coords[-1]
    forward_score = 0.0
    reverse_score = 0.0
    matches = 0
    if upstream is not None:
        forward_score += math.hypot(start[0] - upstream[0], start[1] - upstream[1])
        reverse_score += math.hypot(end[0] - upstream[0], end[1] - upstream[1])
        matches += 1
    if downstream is not None:
        forward_score += math.hypot(end[0] - downstream[0], end[1] - downstream[1])
        reverse_score += math.hypot(start[0] - downstream[0], start[1] - downstream[1])
        matches += 1
    if matches == 0:
        return line, "source_geometry_order"
    if reverse_score + 0.01 < forward_score:
        from shapely.geometry import LineString

        return LineString(list(line.coords)[::-1]), "upstream_to_downstream"
    return line, "upstream_to_downstream"


def _asset_endpoint(asset: dict[str, Any], prefix: str, inventory_path: Path | None) -> tuple[float, float] | None:
    candidates = [str(asset.get(f"{prefix}_ASSETID") or "").strip(), str(asset.get(f"{prefix}_ID") or "").strip()]
    candidates = [item for item in candidates if item]
    if not candidates:
        return None
    try:
        import duckdb
    except ImportError:
        return None
    path = inventory_path or Path(os.getenv("PORTAL_INVENTORY_DUCKDB", ""))
    if not path.is_file():
        return None
    connection = duckdb.connect(str(path), read_only=True)
    try:
        load_spatial_extension(connection)
        for value in candidates:
            row = connection.execute(
                """
                SELECT ST_X(geometry), ST_Y(geometry)
                FROM STORMSTRUCTURE_1_PT
                WHERE upper(trim(CAST(ITPIPE_ASSETID AS VARCHAR))) = upper(?)
                   OR upper(trim(CAST(NODE_ID AS VARCHAR))) = upper(?)
                LIMIT 1
                """,
                [value, value],
            ).fetchone()
            if row and all(item is not None for item in row):
                return float(row[0]), float(row[1])
    except Exception:
        return None
    finally:
        connection.close()
    return None


def _sample_profile(
    line: Any,
    *,
    source_crs: str,
    dem_path: Path,
    mode: str,
    asset: dict[str, Any] | None,
    requested_interval: Any,
    warnings: list[str],
) -> dict[str, Any]:
    try:
        import rasterio
        from pyproj import Transformer
        from shapely.geometry import LineString, mapping
        from shapely.ops import transform
    except (ImportError, OSError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"The bundled Python terrain runtime could not load {type(exc).__name__}: {exc}",
        ) from exc

    with rasterio.open(dem_path) as dataset:
        if dataset.crs is None:
            raise HTTPException(status_code=503, detail="The terrain DEM has no coordinate reference system.")
        if source_crs != str(dataset.crs):
            line = transform(Transformer.from_crs(source_crs, dataset.crs, always_xy=True).transform, line)
        line = _single_line(line)
        length = float(line.length)
        if not math.isfinite(length) or length < MIN_PROFILE_LENGTH_FEET:
            raise HTTPException(status_code=422, detail="The terrain profile line is too short.")
        cell_size = max(abs(float(dataset.res[0])), abs(float(dataset.res[1])))
        try:
            configured_interval = float(requested_interval)
        except (TypeError, ValueError):
            configured_interval = cell_size
        interval = max(cell_size, configured_interval if math.isfinite(configured_interval) else cell_size)
        sample_count = min(MAX_PROFILE_SAMPLES, max(2, int(math.ceil(length / interval)) + 1))
        distances = [length * index / (sample_count - 1) for index in range(sample_count)]
        points = [line.interpolate(distance) for distance in distances]
        nodata = dataset.nodata
        ground_values: list[float | None] = []
        for value in _sample_dataset_values(dataset, [(point.x, point.y) for point in points]):
            masked = getattr(value, "mask", False)
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                numeric = math.nan
            ground_values.append(
                None
                if bool(masked) or not math.isfinite(numeric) or (nodata is not None and numeric == nodata)
                else numeric
            )

        to_wgs84 = Transformer.from_crs(dataset.crs, "EPSG:4326", always_xy=True)
        wgs_points = [to_wgs84.transform(point.x, point.y) for point in points]
        wgs_line = transform(to_wgs84.transform, line)
        us_invert = _finite_number((asset or {}).get("US_INVERT"))
        ds_invert = _finite_number((asset or {}).get("DS_INVERT"))
        asset_profile_available = mode == "pipe" and us_invert is not None and ds_invert is not None
        if mode == "pipe" and not asset_profile_available:
            warnings.append(
                "Upstream or downstream invert elevation is missing; the pipe alignment is schematic and is not shown at a surveyed elevation."
            )
        if mode == "drainage":
            warnings.append("The drainage inventory has no endpoint elevation fields; only the ground profile is shown.")

        samples = []
        for index, (distance, wgs_point, ground) in enumerate(zip(distances, wgs_points, ground_values)):
            fraction = index / (sample_count - 1)
            asset_elevation = (
                us_invert + ((ds_invert - us_invert) * fraction)
                if asset_profile_available and us_invert is not None and ds_invert is not None
                else None
            )
            samples.append(
                {
                    "index": index,
                    "distance_feet": round(distance, 3),
                    "fraction": round(fraction, 6),
                    "longitude": round(float(wgs_point[0]), 7),
                    "latitude": round(float(wgs_point[1]), 7),
                    "ground_elevation": _rounded(ground),
                    "asset_elevation": _rounded(asset_elevation),
                    "cover": _rounded(ground - asset_elevation) if ground is not None and asset_elevation is not None else None,
                }
            )

        valid_ground = [value for value in ground_values if value is not None]
        if not valid_ground:
            warnings.append("No valid DEM cells were found along this profile line.")
        gain, loss = _elevation_gain_loss(ground_values)
        ground_change = (
            ground_values[-1] - ground_values[0]
            if ground_values and ground_values[0] is not None and ground_values[-1] is not None
            else None
        )
        cover_values = [item["cover"] for item in samples if item["cover"] is not None]
        endpoints = {
            "start": {
                "role": "upstream" if mode != "draw" else "start",
                "label": str((asset or {}).get("US_ASSETID") or (asset or {}).get("US_ID") or "Start"),
                "elevation": _rounded(us_invert) if asset_profile_available else None,
                "longitude": samples[0]["longitude"],
                "latitude": samples[0]["latitude"],
            },
            "end": {
                "role": "downstream" if mode != "draw" else "end",
                "label": str((asset or {}).get("DS_ASSETID") or (asset or {}).get("DS_ID") or "End"),
                "elevation": _rounded(ds_invert) if asset_profile_available else None,
                "longitude": samples[-1]["longitude"],
                "latitude": samples[-1]["latitude"],
            },
        }
        return {
            "ok": True,
            "mode": mode,
            "asset": asset,
            "path": mapping(wgs_line),
            "samples": samples,
            "sample_count": sample_count,
            "sample_interval_feet": round(length / (sample_count - 1), 3),
            "statistics": {
                "length_feet": round(length, 3),
                "ground_min": _rounded(min(valid_ground)) if valid_ground else None,
                "ground_max": _rounded(max(valid_ground)) if valid_ground else None,
                "ground_mean": _rounded(sum(valid_ground) / len(valid_ground)) if valid_ground else None,
                "ground_change": _rounded(ground_change),
                "elevation_gain": _rounded(gain),
                "elevation_loss": _rounded(loss),
                "pipe_grade_percent": _rounded(((us_invert - ds_invert) / length) * 100) if asset_profile_available else None,
                "minimum_ground_to_invert": _rounded(min(cover_values)) if cover_values else None,
            },
            "endpoints": endpoints,
            "warnings": list(dict.fromkeys(warnings)),
            "dem_runtime": {
                "crs": str(dataset.crs),
                "horizontal_units": "US survey feet" if "foot" in str(getattr(dataset.crs, "linear_units", "")).lower() else str(getattr(dataset.crs, "linear_units", "")),
                "vertical_units": str(dataset.tags().get("VERTICAL_UNITS") or "feet").replace("_", " "),
                "resolution_feet": round(cell_size, 3),
                "source_dataset": str(dataset.tags().get("SOURCE_DATASET") or ""),
            },
        }


def _elevation_gain_loss(values: list[float | None]) -> tuple[float, float]:
    gain = 0.0
    loss = 0.0
    previous: float | None = None
    for value in values:
        if value is None:
            previous = None
            continue
        if previous is not None:
            change = value - previous
            gain += max(0.0, change)
            loss += max(0.0, -change)
        previous = value
    return gain, loss


def _sample_dataset_values(dataset: Any, coordinates: list[tuple[float, float]]) -> list[Any]:
    """Read each touched COG block once and return nearest-cell values in input order."""

    try:
        from rasterio.windows import Window
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include rasterio.") from exc

    inverse = ~dataset.transform
    block_height, block_width = dataset.block_shapes[0]
    locations: list[tuple[int, int] | None] = []
    grouped: dict[tuple[int, int], list[tuple[int, int, int]]] = {}
    for index, (x, y) in enumerate(coordinates):
        column_value, row_value = inverse * (x, y)
        row = int(math.floor(row_value))
        column = int(math.floor(column_value))
        if row < 0 or column < 0 or row >= dataset.height or column >= dataset.width:
            locations.append(None)
            continue
        locations.append((row, column))
        block_key = (row // block_height, column // block_width)
        grouped.setdefault(block_key, []).append((index, row, column))

    values: list[Any] = [None] * len(coordinates)
    for (block_row, block_column), items in grouped.items():
        row_offset = block_row * block_height
        column_offset = block_column * block_width
        height = min(block_height, dataset.height - row_offset)
        width = min(block_width, dataset.width - column_offset)
        data = dataset.read(
            1,
            window=Window(column_offset, row_offset, width, height),
            masked=True,
        )
        for index, row, column in items:
            values[index] = data[row - row_offset, column - column_offset]
    return values


def _finite_number(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def _rounded(value: Any) -> float | None:
    numeric = _finite_number(value)
    return round(numeric, 3) if numeric is not None else None


def _json_number(value: Any) -> Any:
    numeric = _finite_number(value)
    if numeric is not None and not isinstance(value, str):
        return numeric
    return value


def _quote(identifier: str) -> str:
    return '"' + str(identifier).replace('"', '""') + '"'
