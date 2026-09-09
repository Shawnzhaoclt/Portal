from __future__ import annotations

import math
import re
import time
from contextlib import closing
from datetime import date, datetime
from pathlib import Path
from typing import Any

import duckdb
from pyproj import Transformer
from shapely import from_wkb
from shapely.geometry import LineString, MultiPoint, Point, box, mapping
from shapely.ops import substring, transform, unary_union

from portal.app.core.desktop_config import (
    configured_asset_history,
    configured_failure_consequence_sources,
)
from portal.app.core.duckdb_extensions import DuckDBSpatialExtensionError, load_spatial_extension
from portal.app.resources.tables.storm_water_asset_history.source import latest_itpipes_inspection_defects
from portal.runtime.transport import HTTPException

from .terrain_profile import (
    INVENTORY_SRID,
    _finite_number,
    _inspection_direction_code,
    _load_asset_line,
    _orient_asset_line,
    _resolve_dem,
    _sample_dataset_values,
    _sample_profile,
)


ASSET_TYPES = {"pipe", "structure", "channel"}
CITYWORKS_TABLE_KEYS = {"pipe": "pipe", "structure": "structure", "channel": "channel"}
MAX_IMPACT_FEATURES = 750
BASE_ZOI_FEET = 3.0
SIMULATION_SNAP_TOLERANCE_FEET = 100.0
NUMBER_PATTERN = re.compile(r"\d+(?:\.\d+)?")
CUTAWAY_GRID_SIZE = 72
FEET_PER_MILE = 5_280.0
DEFAULT_DISPLAY_EXTENT_MILES = 0.2
MINIMUM_DISPLAY_EXTENT_MILES = 0.1
MAXIMUM_DISPLAY_EXTENT_MILES = 1.0
DISPLAY_EXTENT_STEP_MILES = 0.1

REFERENCE_LAYERS = (
    ("row_city", "City right-of-way", "city_row"),
    ("eop_city_thoroughfare_py", "City thoroughfare", "roadway"),
    ("eop_city_collector_py", "City collector", "roadway"),
    ("eop_city_local_py", "City local street", "roadway"),
    ("city_eop_local_limited_estimate", "City local limited street", "roadway"),
    ("eop_state_thoroughfare_py", "State thoroughfare", "roadway"),
    ("eop_state_collector_py", "State collector", "roadway"),
    ("eop_state_local_py", "State local street", "roadway"),
    ("eop_state_freeway_py", "State freeway", "roadway"),
)
DEDICATED_BUILDING_LAYERS = (
    ("Buildings_py", "Building", "building", "TRUE"),
)
# The daily SQL Server mirror clones ten curated SDW tables, and neither parcels nor
# conservation easements are among them - they are only published by the weekly 68-layer
# spatial mirror, which also writes each layer in ST_Hilbert order with an R-Tree index
# on its geometry. That mirror is therefore both the only source and the faster one for
# the extent query these two layers need.
SPATIAL_MIRROR_LAYERS = (
    (
        "STORMWATERCONSERVATIONEASEMENTS_PY",
        "Storm water conservation easement",
        "conservation_easement",
        "TRUE",
    ),
    # Parcels blanket the extent, so they are queried last: both the per-layer and the
    # overall cap then trim parcels before the layers a reviewer needs most.
    ("PARCELJOIN_PY", "Parcel", "parcel", "TRUE"),
)
IMPERVIOUS_BUILDING_FALLBACK_LAYERS = (
    ("IMPERVIOUSSURFACESINGLEFAMILY_PY", "Building", "building", "lower(Subtheme)='building' AND coalesce(ImperviousSurfaceAreaSqFt, 0) >= 500"),
    ("IMPERVIOUSSURFACENSF_PY", "Building", "building", "lower(Subtheme)='building' AND coalesce(ImperviousSurfaceAreaSqFt, 0) >= 500"),
    ("IMPERVIOUSSURFACESINGLEFAMILY_PY", "Accessory structure", "accessory_structure", "lower(Subtheme)='building' AND coalesce(ImperviousSurfaceAreaSqFt, 0) >= 150 AND coalesce(ImperviousSurfaceAreaSqFt, 0) < 500"),
    ("IMPERVIOUSSURFACENSF_PY", "Accessory structure", "accessory_structure", "lower(Subtheme)='building' AND coalesce(ImperviousSurfaceAreaSqFt, 0) >= 150 AND coalesce(ImperviousSurfaceAreaSqFt, 0) < 500"),
)
WAREHOUSE_LAYERS = (
    ("IMPERVIOUSSURFACESINGLEFAMILY_PY", "Driveway", "driveway", "lower(Subtheme)='driveway'"),
    ("IMPERVIOUSSURFACENSF_PY", "Paved surface", "paved_surface", "lower(Subtheme)='paved'"),
    ("IMPERVIOUSSURFACEOTHER_PY", "Other impervious surface", "impervious_surface", "TRUE"),
    ("STORMWATEREASEMENTS_PT", "Storm water easement", "stormwater_easement", "TRUE"),
)


def build_failure_consequence(payload: dict[str, Any]) -> dict[str, Any]:
    """Build a read-only, session-scoped consequence screening result."""

    started = time.perf_counter()
    asset_type = str(payload.get("asset_type") or "").strip().lower()
    if asset_type == "drainage":
        asset_type = "channel"
    if asset_type not in ASSET_TYPES:
        raise HTTPException(status_code=422, detail="Select a pipe, structure, or drainage asset.")
    asset_id = str(payload.get("asset_id") or "").strip()
    if not asset_id:
        raise HTTPException(status_code=422, detail="Select an asset before opening consequence analysis.")
    display_extent_miles = _display_extent_miles(payload.get("extent_miles"))

    config = _asset_history_config()
    inventory_path = Path(str(config["sources"]["inventory"]["database"]))
    asset, geometry_2264, orientation = _load_asset(asset_type, asset_id, inventory_path)
    warnings: list[str] = []
    if orientation == "source_geometry_order" and asset_type != "structure":
        warnings.append("Asset endpoints could not be matched; source geometry order was used for stationing.")

    profile = _cover_profile(asset_type, asset, geometry_2264, inventory_path, warnings)
    # A caller reviewing one specific inspection supplies that inspection's observation
    # list; those rows replace the latest-scored-inspection lookup so the scene shows
    # exactly what the reviewer sees, including observations recorded in Portal that the
    # risk ETL has not scored yet.
    reviewed_observations = payload.get("observations")
    if isinstance(reviewed_observations, list) and asset_type == "pipe":
        itpipes_defects = _reviewed_observation_defects(
            reviewed_observations,
            payload.get("inspection_direction"),
            geometry_2264,
            profile,
            warnings,
        )
    else:
        itpipes_defects = _itpipes_defects(asset, asset_type, geometry_2264, profile, warnings)
    observed = [
        *itpipes_defects,
        *_cityworks_defects(config, asset, asset_type, geometry_2264, profile, warnings),
    ]
    structure_scenario = _structure_invert_scenario(asset_type, geometry_2264, profile)
    if structure_scenario is not None:
        observed.append(structure_scenario)
    scenario_payload = payload.get("scenario") if isinstance(payload.get("scenario"), dict) else None
    simulated = _simulated_defect(scenario_payload, asset_type, geometry_2264, profile, warnings)
    if simulated is not None:
        observed.append(simulated)

    active = _active_defect(observed, scenario_payload)
    # The conservative ZOI remains asset-wide. A selected defect sets the active
    # scenario and centers the display extent, but the ZOI never clips or filters
    # the consequence-layer context query.
    analysis = _analyze(
        active,
        asset_type,
        geometry_2264,
        profile,
        display_extent_miles,
        warnings,
    )
    cutaway = _terrain_cutaway(active, geometry_2264, analysis, warnings)

    to_wgs84 = Transformer.from_crs(f"EPSG:{INVENTORY_SRID}", "EPSG:4326", always_xy=True)
    asset_wgs84 = transform(to_wgs84.transform, geometry_2264)
    public_defects = [_public_defect(item, to_wgs84) for item in observed]
    result = {
        "ok": True,
        "asset": {
            **asset,
            "asset_type": asset_type,
            "geometry": mapping(asset_wgs84),
            "orientation": orientation,
        },
        "defects": public_defects,
        "active_defect_id": str(active.get("id")) if active else None,
        "analysis": _public_analysis(analysis, to_wgs84) if analysis else None,
        "cutaway": _public_cutaway(cutaway, to_wgs84) if cutaway else None,
        "method": {
            "zoi_formula": "3 ft + (2 x relative depth)",
            "context_clip": "selected square map extent",
            "latest_itpipes_only": True,
            "latest_cityworks_only": True,
            "fallback_to_older_inspections": False,
            "screening_only": True,
        },
        "warnings": list(dict.fromkeys(warnings)),
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
    }
    return result


def _terrain_cutaway(
    defect: dict[str, Any] | None,
    asset_geometry: Any,
    analysis: dict[str, Any],
    warnings: list[str],
) -> dict[str, Any] | None:
    """Sample a small DEM grid for the interactive, schematic cutaway scene."""

    try:
        import rasterio
    except (ImportError, OSError) as exc:
        warnings.append(f"The cutaway terrain runtime is unavailable: {type(exc).__name__}: {exc}")
        return None

    display_extent = analysis.get("display_extent_2264")
    if display_extent is None or display_extent.is_empty:
        center_geometry = defect.get("geometry_2264") if defect else asset_geometry
        display_extent, _ = _display_clip_extent(center_geometry, DEFAULT_DISPLAY_EXTENT_MILES)
    minimum_x, minimum_y, maximum_x, maximum_y = display_extent.bounds
    center = display_extent.centroid
    width = max(1.0, maximum_x - minimum_x)
    height = max(1.0, maximum_y - minimum_y)
    half_width = width / 2.0
    half_height = height / 2.0
    bounds_geometry = box(
        center.x - half_width,
        center.y - half_height,
        center.x + half_width,
        center.y + half_height,
    )
    clipped_asset = asset_geometry.intersection(bounds_geometry)
    if clipped_asset.is_empty:
        clipped_asset = asset_geometry

    try:
        dem_path, dem_metadata = _resolve_dem(None)
        with rasterio.open(dem_path) as dataset:
            if dataset.crs is None:
                warnings.append("The terrain DEM has no coordinate reference system; the 3D cutaway is unavailable.")
                return None
            to_dem = Transformer.from_crs(f"EPSG:{INVENTORY_SRID}", dataset.crs, always_xy=True)
            coordinates_2264: list[tuple[float, float]] = []
            for row in range(CUTAWAY_GRID_SIZE):
                y = center.y + half_height - (height * row / (CUTAWAY_GRID_SIZE - 1))
                for column in range(CUTAWAY_GRID_SIZE):
                    x = center.x - half_width + (width * column / (CUTAWAY_GRID_SIZE - 1))
                    coordinates_2264.append((x, y))
            coordinates_dem = [to_dem.transform(x, y) for x, y in coordinates_2264]
            nodata = dataset.nodata
            elevations: list[float | None] = []
            for value in _sample_dataset_values(dataset, coordinates_dem):
                masked = getattr(value, "mask", False)
                numeric = _finite_number(value)
                elevations.append(
                    None
                    if bool(masked) or numeric is None or (nodata is not None and numeric == nodata)
                    else round(numeric, 3)
                )
    except Exception as exc:
        detail = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        warnings.append(f"The DEM cutaway could not be generated: {detail}")
        return None

    valid = [value for value in elevations if value is not None]
    if not valid:
        warnings.append("No valid DEM cells were found for the 3D cutaway area.")
        return None
    nodata_count = len(elevations) - len(valid)
    filled = _fill_missing_grid(elevations, CUTAWAY_GRID_SIZE, CUTAWAY_GRID_SIZE)
    minimum = min(filled)
    maximum = max(filled)
    relief = maximum - minimum
    base_elevation = minimum - max(35.0, relief * 1.25)
    return {
        "center_2264": [float(center.x), float(center.y)],
        "width_feet": round(width, 3),
        "height_feet": round(height, 3),
        "columns": CUTAWAY_GRID_SIZE,
        "rows": CUTAWAY_GRID_SIZE,
        "elevations": [round(value, 3) for value in filled],
        "minimum_elevation": round(minimum, 3),
        "maximum_elevation": round(maximum, 3),
        "base_elevation": round(base_elevation, 3),
        "nodata_cells_filled": nodata_count,
        "dem_file": str(dem_metadata.get("file_name") or dem_path.name),
        "asset_geometry_2264": clipped_asset,
        "bounds_geometry_2264": bounds_geometry,
    }


def _fill_missing_grid(values: list[float | None], rows: int, columns: int) -> list[float]:
    """Fill sparse DEM gaps from neighboring cells without changing valid samples."""

    filled = list(values)
    valid = [value for value in filled if value is not None]
    fallback = sum(valid) / len(valid) if valid else 0.0
    for _ in range(max(rows, columns)):
        updates: dict[int, float] = {}
        for index, value in enumerate(filled):
            if value is not None:
                continue
            row, column = divmod(index, columns)
            neighbors: list[float] = []
            for row_offset, column_offset in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                nearby_row = row + row_offset
                nearby_column = column + column_offset
                if 0 <= nearby_row < rows and 0 <= nearby_column < columns:
                    nearby = filled[(nearby_row * columns) + nearby_column]
                    if nearby is not None:
                        neighbors.append(nearby)
            if neighbors:
                updates[index] = sum(neighbors) / len(neighbors)
        if not updates:
            break
        for index, value in updates.items():
            filled[index] = value
        if all(value is not None for value in filled):
            break
    return [float(value if value is not None else fallback) for value in filled]


def _asset_history_config() -> dict[str, Any]:
    try:
        return configured_asset_history()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def _load_asset(asset_type: str, asset_id: str, inventory_path: Path) -> tuple[dict[str, Any], Any, str]:
    if asset_type in {"pipe", "channel"}:
        mode = "pipe" if asset_type == "pipe" else "drainage"
        asset, line = _load_asset_line(mode, asset_id, inventory_path=inventory_path)
        line, orientation = _orient_asset_line(line, asset, inventory_path=inventory_path)
        asset["asset_type"] = asset_type
        return asset, line, orientation

    connection = _open(inventory_path, "inventory")
    try:
        columns = _columns(connection, "STORMSTRUCTURE_1_PT")
        geometry = _column(columns, "geometry", "Shape")
        asset_field = _column(columns, "ITPIPE_ASSETID", "NODE_ID", "AssetID")
        if geometry is None or asset_field is None:
            raise HTTPException(status_code=503, detail="The structure inventory contract is incomplete.")
        row = connection.execute(
            f'SELECT *, ST_AsWKB("{geometry}") AS __wkb FROM "STORMSTRUCTURE_1_PT" '
            f'WHERE upper(trim(CAST("{asset_field}" AS VARCHAR)))=upper(?) LIMIT 2',
            [asset_id],
        ).fetchall()
        if not row:
            raise HTTPException(status_code=404, detail=f"Structure {asset_id} was not found.")
        if len(row) > 1:
            raise HTTPException(status_code=409, detail=f"Asset ID {asset_id} is not unique.")
        names = [str(item[0]) for item in connection.description]
        values = dict(zip(names, row[0]))
        point = from_wkb(bytes(values.pop("__wkb")))
        values.pop(geometry, None)
        asset = {key: _json(value) for key, value in values.items() if not isinstance(value, bytes)}
        asset["asset_id"] = str(asset.get("ITPIPE_ASSETID") or asset.get("NODE_ID") or asset_id)
        asset["asset_type"] = "structure"
        return asset, point, "not_applicable"
    finally:
        connection.close()


def _cover_profile(
    asset_type: str,
    asset: dict[str, Any],
    geometry: Any,
    inventory_path: Path,
    warnings: list[str],
) -> dict[str, Any] | None:
    if asset_type == "structure":
        return _structure_cover_profile(asset, geometry, warnings)
    if asset_type != "pipe":
        return None
    try:
        dem_path, _ = _resolve_dem(None)
        return _sample_profile(
            geometry,
            source_crs=f"EPSG:{INVENTORY_SRID}",
            dem_path=dem_path,
            mode="pipe",
            asset=asset,
            requested_interval=None,
            warnings=[],
        )
    except Exception as exc:
        detail = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        warnings.append(f"Relative depth could not be derived from the DEM: {detail}")
        return None


def _structure_cover_profile(
    asset: dict[str, Any],
    geometry: Any,
    warnings: list[str],
) -> dict[str, Any] | None:
    """Derive structure cover from the same DEM used by the terrain-profile tool."""

    invert = _asset_number(asset, "INVERT", "INV_ELEV", "INVERT_ELEV", "INVERT_ELEVATION")
    if invert is None:
        warnings.append("The structure invert elevation is unavailable; an invert-based ZOI could not be generated.")
        return None
    try:
        import rasterio

        dem_path, dem_metadata = _resolve_dem(None)
        with rasterio.open(dem_path) as dataset:
            if dataset.crs is None:
                raise HTTPException(status_code=503, detail="The terrain DEM has no coordinate reference system.")
            to_dem = Transformer.from_crs(f"EPSG:{INVENTORY_SRID}", dataset.crs, always_xy=True)
            coordinate = to_dem.transform(float(geometry.x), float(geometry.y))
            sampled = _sample_dataset_values(dataset, [coordinate])[0]
            ground = _finite_number(sampled)
            if ground is None or bool(getattr(sampled, "mask", False)):
                raise HTTPException(status_code=503, detail="No valid DEM elevation was found at the structure.")
            if dataset.nodata is not None and ground == dataset.nodata:
                raise HTTPException(status_code=503, detail="The DEM contains a no-data value at the structure.")
    except Exception as exc:
        detail = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        warnings.append(f"Structure cover could not be derived from the DEM and invert elevation: {detail}")
        return None
    cover = max(0.0, ground - invert)
    return {
        "mode": "structure",
        "dem_file": str(dem_metadata.get("file_name") or dem_path.name),
        "ground_elevation": round(ground, 3),
        "invert_elevation": round(invert, 3),
        "samples": [
            {
                "distance_feet": 0.0,
                "ground_elevation": round(ground, 3),
                "invert_elevation": round(invert, 3),
                "cover": round(cover, 3),
            }
        ],
    }


def _structure_invert_scenario(
    asset_type: str,
    geometry: Any,
    profile: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if asset_type != "structure":
        return None
    relative_depth = _cover_at(profile, 0.0)
    if relative_depth is None:
        return None
    return _defect(
        defect_id="asset:structure-invert",
        source="inventory",
        label="Structure invert",
        geometry=geometry,
        relative_depth=relative_depth,
        condition_risk=None,
        station=0.0,
        metadata={
            "ground_elevation": profile.get("ground_elevation") if profile else None,
            "invert_elevation": profile.get("invert_elevation") if profile else None,
            "dem_file": profile.get("dem_file") if profile else None,
        },
    )


def _profile_values_at(profile: dict[str, Any] | None, station: float | None) -> dict[str, float | None]:
    """Linearly interpolate DEM ground, asset invert, and cover at one station."""

    empty = {"ground_elevation": None, "invert_elevation": None, "cover": None}
    if profile is None or station is None:
        return empty
    samples = [
        item
        for item in (profile.get("samples") or [])
        if _finite_number(item.get("distance_feet")) is not None
    ]
    if not samples:
        return empty
    samples.sort(key=lambda item: float(item["distance_feet"]))
    target = min(
        float(samples[-1]["distance_feet"]),
        max(float(samples[0]["distance_feet"]), float(station)),
    )
    lower = samples[0]
    upper = samples[-1]
    for sample in samples:
        distance = float(sample["distance_feet"])
        if distance <= target:
            lower = sample
        if distance >= target:
            upper = sample
            break
    lower_distance = float(lower["distance_feet"])
    upper_distance = float(upper["distance_feet"])
    fraction = 0.0 if upper_distance <= lower_distance else (target - lower_distance) / (upper_distance - lower_distance)

    def interpolate(*fields: str) -> float | None:
        lower_value = next((_finite_number(lower.get(field)) for field in fields if _finite_number(lower.get(field)) is not None), None)
        upper_value = next((_finite_number(upper.get(field)) for field in fields if _finite_number(upper.get(field)) is not None), None)
        if lower_value is None:
            return upper_value
        if upper_value is None:
            return lower_value
        return lower_value + ((upper_value - lower_value) * fraction)

    ground = interpolate("ground_elevation")
    invert = interpolate("asset_elevation", "invert_elevation")
    cover = max(0.0, ground - invert) if ground is not None and invert is not None else interpolate("cover")
    return {
        "ground_elevation": ground,
        "invert_elevation": invert,
        "cover": max(0.0, cover) if cover is not None else None,
    }


def _asset_wide_zoi(
    asset_type: str,
    geometry: Any,
    profile: dict[str, Any] | None,
) -> tuple[Any, float, float]:
    """Build a conservative ZOI for a hypothetical defect at every asset location."""

    if asset_type == "structure":
        cover = _profile_values_at(profile, 0.0)["cover"] or 0.0
        radius = BASE_ZOI_FEET + (2.0 * cover)
        return geometry.buffer(radius), radius, radius
    if asset_type != "pipe" or geometry.is_empty:
        return geometry.buffer(BASE_ZOI_FEET), BASE_ZOI_FEET, BASE_ZOI_FEET

    samples = [
        item
        for item in (profile or {}).get("samples", [])
        if _finite_number(item.get("distance_feet")) is not None
    ]
    samples.sort(key=lambda item: float(item["distance_feet"]))
    if len(samples) < 2:
        return geometry.buffer(BASE_ZOI_FEET), BASE_ZOI_FEET, BASE_ZOI_FEET

    components = [geometry.buffer(BASE_ZOI_FEET)]
    radii: list[float] = []
    length = float(geometry.length)
    for start_sample, end_sample in zip(samples, samples[1:]):
        start = min(length, max(0.0, float(start_sample["distance_feet"])))
        end = min(length, max(0.0, float(end_sample["distance_feet"])))
        if end <= start:
            continue
        start_cover = _profile_values_at(profile, start)["cover"] or 0.0
        end_cover = _profile_values_at(profile, end)["cover"] or 0.0
        radius = BASE_ZOI_FEET + (2.0 * max(start_cover, end_cover))
        segment = substring(geometry, start, end)
        if not segment.is_empty:
            components.append(segment.buffer(radius))
            radii.append(radius)
    zoi = unary_union(components)
    return zoi, min(radii or [BASE_ZOI_FEET]), max(radii or [BASE_ZOI_FEET])


def _itpipes_defects(
    asset: dict[str, Any],
    asset_type: str,
    geometry: Any,
    profile: dict[str, Any] | None,
    warnings: list[str],
) -> list[dict[str, Any]]:
    try:
        latest = latest_itpipes_inspection_defects(str(asset.get("asset_id") or ""))
    except Exception as exc:
        detail = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        warnings.append(f"ITPipes defects are unavailable: {detail}")
        return []
    if latest is None:
        return []
    direction = _inspection_direction_code(latest.get("inspection_direction"))
    defects: list[dict[str, Any]] = []
    for row in latest.get("defects") or []:
        station = _finite_number(row.get("source_distance_feet"))
        located_geometry = None
        profile_station = None
        if asset_type == "structure":
            located_geometry = geometry
            profile_station = 0.0
        elif station is not None and direction is not None:
            profile_station = station if direction == 1 else max(0.0, float(geometry.length) - station)
            profile_station = min(float(geometry.length), max(0.0, profile_station))
            located_geometry = geometry.interpolate(profile_station)
        profile_values = _profile_values_at(profile, profile_station)
        relative_depth = profile_values["cover"]
        if relative_depth is None and asset_type == "channel":
            relative_depth = _finite_number(row.get("relative_depth"))
        defects.append(
            _defect(
                defect_id=f"itpipes:{row.get('mlo_id')}",
                source="itpipes",
                label=str(row.get("observation_text") or f"MLO {row.get('mlo_id')}"),
                geometry=located_geometry,
                relative_depth=relative_depth,
                condition_risk=_finite_number(row.get("condition_risk")),
                station=profile_station,
                metadata={
                    "mli_id": latest.get("mli_id"),
                    "mlo_id": row.get("mlo_id"),
                    "inspection_date": latest.get("inspection_date"),
                    "inspection_direction": latest.get("inspection_direction"),
                    "source_distance_feet": station,
                    "is_continuous": row.get("is_continuous"),
                    "ground_elevation": _rounded(profile_values["ground_elevation"]),
                    "interpolated_invert_elevation": _rounded(profile_values["invert_elevation"]),
                    "depth_source": "DEM ground minus interpolated asset invert" if relative_depth is not None else None,
                },
            )
        )
    return defects


def _reviewed_observation_defects(
    observations: list[Any],
    inspection_direction: Any,
    geometry: Any,
    profile: dict[str, Any] | None,
    warnings: list[str],
) -> list[dict[str, Any]]:
    """Build defect scenarios from the observation list of the inspection under review.

    Each observation is stationed along the pipe from its recorded distance and the
    inspection direction, and its depth interpolates the same DEM-ground-minus-invert
    profile the scored lookups use. Rows without a usable distance stay unlocated so
    the inspector reports them instead of silently dropping them.
    """
    if len(observations) > 1000:
        raise HTTPException(status_code=422, detail="At most 1000 observations can be displayed.")
    direction = _inspection_direction_code(inspection_direction)
    if direction is None and observations:
        warnings.append(
            "The inspection direction is unknown; observation distances are stationed "
            "from the pipe's inventory start point."
        )
    defects: list[dict[str, Any]] = []
    seen_mlo_ids: set[str] = set()
    for row in observations:
        if not isinstance(row, dict):
            continue
        mlo_id = str(row.get("mlo_id") or "").strip()
        if not mlo_id or mlo_id in seen_mlo_ids:
            continue
        seen_mlo_ids.add(mlo_id)
        label = str(row.get("label") or "").strip() or f"Observation {mlo_id}"
        station = _finite_number(row.get("distance_feet"))
        located_geometry = None
        profile_station = None
        if station is not None:
            profile_station = station if direction in (None, 1) else max(0.0, float(geometry.length) - station)
            profile_station = min(float(geometry.length), max(0.0, profile_station))
            located_geometry = geometry.interpolate(profile_station)
        profile_values = _profile_values_at(profile, profile_station)
        relative_depth = profile_values["cover"]
        defects.append(
            _defect(
                defect_id=f"itpipes:{mlo_id}",
                source="itpipes",
                label=label,
                geometry=located_geometry,
                relative_depth=relative_depth,
                condition_risk=_finite_number(row.get("condition_risk")),
                station=profile_station,
                metadata={
                    "mlo_id": mlo_id,
                    "inspection_direction": inspection_direction,
                    "source_distance_feet": station,
                    "recorded_in": "portal" if str(row.get("origin") or "") == "user" else "itpipes",
                    "ground_elevation": _rounded(profile_values["ground_elevation"]),
                    "interpolated_invert_elevation": _rounded(profile_values["invert_elevation"]),
                    "depth_source": "DEM ground minus interpolated asset invert" if relative_depth is not None else None,
                },
            )
        )
    return defects


def _cityworks_defects(
    config: dict[str, Any],
    asset: dict[str, Any],
    asset_type: str,
    geometry: Any,
    profile: dict[str, Any] | None,
    warnings: list[str],
) -> list[dict[str, Any]]:
    source = config["sources"]["cityworksRisk"]
    path = Path(str(source["database"]))
    table_key = CITYWORKS_TABLE_KEYS[asset_type]
    table = str(config.get("cityworksRiskTables", {}).get(table_key) or "").strip()
    if not table:
        warnings.append(f"The Cityworks scored-inspection table for {asset_type} is not configured.")
        return []
    connection = _open(path, "Cityworks scored inspections")
    try:
        columns = _columns(connection, table)
        asset_field = _column(columns, "ITPIPE_ASSETID")
        date_field = _column(columns, "Inspection_Date", "INSPDATE")
        id_field = _column(columns, "INSPECTIONID")
        if not asset_field or not date_field or not id_field:
            raise HTTPException(status_code=503, detail=f"Required Cityworks fields were not found in {table}.")
        rows = connection.execute(
            f'SELECT * FROM "{table}" WHERE upper(regexp_replace(CAST("{asset_field}" AS VARCHAR), \'\\.0+$\', \'\'))=upper(?) '
            f'ORDER BY try_cast("{date_field}" AS TIMESTAMP) DESC NULLS LAST, try_cast("{id_field}" AS BIGINT) DESC NULLS LAST LIMIT 1',
            [str(asset.get("asset_id") or "")],
        ).fetchall()
        if not rows:
            return []
        names = [str(item[0]) for item in connection.description]
        row = {name: value for name, value in zip(names, rows[0])}
    finally:
        connection.close()

    by_name = {name.casefold(): name for name in row}
    direction = _inspection_direction_code(_value(row, by_name, "direction", "REVERSE"))
    depth_default = _finite_number(_value(row, by_name, "DEPTH"))
    defects: list[dict[str, Any]] = []
    for slot in range(1, 6):
        callout = _value(row, by_name, f"defect_callout_{slot}")
        other = _value(row, by_name, f"other_{slot}")
        severity = _value(row, by_name, f"defect_severity_{slot}")
        station_text = _value(row, by_name, f"defect_stationing_{slot}")
        risk = _finite_number(_value(row, by_name, f"Cond_Risk{slot}"))
        if not any(str(value or "").strip() for value in (callout, other, severity, station_text)) and risk is None:
            continue
        stations = parse_stationing(station_text)
        located: list[Any] = []
        mapped_stations: list[float] = []
        if asset_type == "structure":
            located = [geometry]
            mapped_stations = [0.0]
        elif direction is not None:
            for station in stations:
                profile_station = station if direction == 1 else max(0.0, float(geometry.length) - station)
                profile_station = min(float(geometry.length), max(0.0, profile_station))
                mapped_stations.append(profile_station)
                located.append(geometry.interpolate(profile_station))
        located_geometry = located[0] if len(located) == 1 else MultiPoint(located) if located else None
        representative_station = sum(mapped_stations) / len(mapped_stations) if mapped_stations else None
        profile_values = _profile_values_at(profile, 0.0 if asset_type == "structure" else representative_station)
        relative_depth = profile_values["cover"]
        if relative_depth is None and asset_type == "channel":
            relative_depth = depth_default
        label = str(callout or other or severity or f"Defect {slot}")
        defects.append(
            _defect(
                defect_id=f"cityworks:{row.get(id_field)}:{slot}",
                source="cityworks",
                label=label,
                geometry=located_geometry,
                relative_depth=relative_depth,
                condition_risk=risk,
                station=representative_station,
                metadata={
                    "inspection_id": _json(row.get(id_field)),
                    "inspection_date": _json(row.get(date_field)),
                    "slot": slot,
                    "severity": _json(severity),
                    "stationing_text": _json(station_text),
                    "stations_feet": stations,
                    "inspection_direction": _json(_value(row, by_name, "direction", "REVERSE")),
                    "ground_elevation": _rounded(profile_values["ground_elevation"]),
                    "interpolated_invert_elevation": _rounded(profile_values["invert_elevation"]),
                    "depth_source": "DEM ground minus interpolated asset invert" if relative_depth is not None else None,
                },
            )
        )
    return defects


def parse_stationing(value: Any) -> list[float]:
    """Parse Cityworks station lists/ranges without inventing a location for free text."""

    text = str(value or "").strip()
    if not text:
        return []
    residue = re.sub(r"(?i)\b(?:station(?:ing)?|sta|feet|foot|ft)\b", "", text)
    residue = residue.replace("'", "").replace('"', "")
    if re.search(r"[A-Za-z]", residue) or re.search(r"[^0-9+.,;:/\-\s]", residue):
        return []
    values = [_finite_number(item) for item in NUMBER_PATTERN.findall(text)]
    result = [float(item) for item in values if item is not None and item >= 0]
    if not result:
        return []
    return list(dict.fromkeys(result))


def _simulated_defect(
    scenario: dict[str, Any] | None,
    asset_type: str,
    geometry: Any,
    profile: dict[str, Any] | None,
    warnings: list[str],
) -> dict[str, Any] | None:
    if not scenario or str(scenario.get("source") or "").lower() != "simulated":
        return None
    coordinates = scenario.get("coordinates")
    if not isinstance(coordinates, (list, tuple)) or len(coordinates) < 2:
        raise HTTPException(status_code=422, detail="Click the selected asset to place a simulated defect.")
    try:
        point_wgs84 = Point(float(coordinates[0]), float(coordinates[1]))
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="The simulated defect coordinate is invalid.")
    to_local = Transformer.from_crs("EPSG:4326", f"EPSG:{INVENTORY_SRID}", always_xy=True)
    point = transform(to_local.transform, point_wgs84)
    if asset_type == "structure":
        snapped = geometry
        station = 0.0
        distance = float(point.distance(geometry))
    else:
        station = float(geometry.project(point))
        snapped = geometry.interpolate(station)
        distance = float(point.distance(snapped))
    if distance > SIMULATION_SNAP_TOLERANCE_FEET:
        raise HTTPException(status_code=422, detail="Click within 100 feet of the selected asset.")
    profile_values = _profile_values_at(profile, station)
    relative_depth = profile_values["cover"]
    if relative_depth is None:
        relative_depth = 0.0
        warnings.append("The simulated defect uses the 3-foot base ZOI because relative depth is unavailable.")
    return _defect(
        defect_id="simulated",
        source="simulated",
        label="User-simulated defect",
        geometry=snapped,
        relative_depth=relative_depth,
        condition_risk=_finite_number(scenario.get("condition_risk")),
        station=station,
        metadata={
            "snap_distance_feet": round(distance, 3),
            "user_entered": True,
            "ground_elevation": _rounded(profile_values["ground_elevation"]),
            "interpolated_invert_elevation": _rounded(profile_values["invert_elevation"]),
            "depth_source": (
                "DEM ground minus interpolated asset invert"
                if profile_values["cover"] is not None
                else "3-foot base ZOI"
            ),
        },
    )


def _defect(
    *,
    defect_id: str,
    source: str,
    label: str,
    geometry: Any,
    relative_depth: float | None,
    condition_risk: float | None,
    station: float | None,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    radius = BASE_ZOI_FEET + (2.0 * max(0.0, relative_depth or 0.0)) if geometry is not None else None
    return {
        "id": defect_id,
        "source": source,
        "label": label,
        "located": geometry is not None,
        "geometry_2264": geometry,
        "relative_depth": round(relative_depth, 3) if relative_depth is not None else None,
        "condition_risk": round(condition_risk, 3) if condition_risk is not None else None,
        "station_feet": round(station, 3) if station is not None else None,
        "zoi_radius_feet": round(radius, 3) if radius is not None else None,
        "metadata": metadata,
    }


def _active_defect(defects: list[dict[str, Any]], scenario: dict[str, Any] | None) -> dict[str, Any] | None:
    requested = str((scenario or {}).get("id") or "").strip()
    if str((scenario or {}).get("source") or "").lower() == "simulated":
        requested = "simulated"
    if requested:
        return next((item for item in defects if str(item.get("id")) == requested), None)
    located = [item for item in defects if item.get("located")]
    return max(located, key=lambda item: (_finite_number(item.get("condition_risk")) or -1.0), default=None)


def _analyze(
    defect: dict[str, Any] | None,
    asset_type: str,
    asset_geometry: Any,
    profile: dict[str, Any] | None,
    display_extent_miles: float,
    warnings: list[str],
) -> dict[str, Any]:
    geometry = defect.get("geometry_2264") if defect else None
    scenario_radius = _finite_number(defect.get("zoi_radius_feet")) if defect else None
    scenario_zoi = (
        geometry.buffer(max(0.0, scenario_radius))
        if geometry is not None and not geometry.is_empty and scenario_radius is not None
        else None
    )
    direct_zone = (
        geometry.buffer(BASE_ZOI_FEET)
        if geometry is not None and not geometry.is_empty
        else None
    )
    zoi, minimum_radius, maximum_radius = _asset_wide_zoi(asset_type, asset_geometry, profile)
    display_center = geometry if geometry is not None and not geometry.is_empty else asset_geometry
    display_extent, clip_basis = _display_clip_extent(display_center, display_extent_miles)
    impacted: list[dict[str, Any]] = []
    try:
        sources = configured_failure_consequence_sources()
    except RuntimeError as error:
        warnings.append(str(error))
        sources = {}

    reference = sources.get("reference")
    if reference:
        try:
            with closing(_open(Path(str(reference["database"])), "consequence reference")) as connection:
                for table, label, category in REFERENCE_LAYERS:
                    impacted.extend(
                        _query_impacts(
                            connection,
                            "geo",
                            table,
                            label,
                            category,
                            display_extent,
                            scenario_zoi,
                            direct_zone,
                            warnings=warnings,
                        )
                    )
        except HTTPException as error:
            warnings.append(str(error.detail))
    buildings_loaded = False
    buildings = sources.get("buildings")
    if buildings:
        try:
            with closing(_open(Path(str(buildings["database"])), "spatial mirror")) as connection:
                for table, label, category, predicate in (
                    *DEDICATED_BUILDING_LAYERS,
                    *SPATIAL_MIRROR_LAYERS,
                ):
                    impacted.extend(
                        _query_impacts(
                            connection,
                            "main",
                            table,
                            label,
                            category,
                            display_extent,
                            scenario_zoi,
                            direct_zone,
                            predicate,
                            warnings=warnings,
                        )
                    )
                buildings_loaded = True
        except HTTPException as error:
            warnings.append(
                f"{error.detail} The impervious-surface building fallback will be used if available."
            )

    warehouse = sources.get("spatialWarehouse")
    if warehouse:
        try:
            with closing(_open(Path(str(warehouse["database"])), "spatial warehouse")) as connection:
                layers = (
                    WAREHOUSE_LAYERS
                    if buildings_loaded
                    else (*IMPERVIOUS_BUILDING_FALLBACK_LAYERS, *WAREHOUSE_LAYERS)
                )
                for table, label, category, predicate in layers:
                    impacted.extend(
                        _query_impacts(
                            connection,
                            "main",
                            table,
                            label,
                            category,
                            display_extent,
                            scenario_zoi,
                            direct_zone,
                            predicate,
                            warnings=warnings,
                        )
                    )
        except HTTPException as error:
            warnings.append(str(error.detail))
    if len(impacted) > MAX_IMPACT_FEATURES:
        impacted.sort(
            key=lambda item: (
                not bool(item.get("is_influenced")),
                str(item.get("category")) not in {"building", "accessory_structure"},
                str(item.get("relationship")) != "direct",
            )
        )
        warnings.append(
            f"Only {MAX_IMPACT_FEATURES:,} features from the selected map extent are displayed; scenario-influenced features were prioritized."
        )
        impacted = impacted[:MAX_IMPACT_FEATURES]
    counts: dict[str, int] = {}
    influenced = [feature for feature in impacted if feature["is_influenced"]]
    influence_footprint = _influence_footprint(influenced)
    for feature in influenced:
        category = str(feature["category"])
        counts[category] = counts.get(category, 0) + 1
    return {
        "scenario_id": defect["id"] if defect else "asset-wide",
        "zoi_radius_feet": maximum_radius,
        "minimum_zoi_radius_feet": minimum_radius,
        "maximum_zoi_radius_feet": maximum_radius,
        "zoi_2264": zoi,
        "scenario_zoi_2264": scenario_zoi,
        "influence_footprint_2264": influence_footprint,
        "display_extent_2264": display_extent,
        "display_extent_miles": display_extent_miles,
        "clip_basis": clip_basis,
        "impacted_features": impacted,
        "counts": counts,
        "total_impacted": len(influenced),
        "total_context": len(impacted),
    }


def _query_impacts(
    connection: duckdb.DuckDBPyConnection,
    schema: str,
    table: str,
    label: str,
    category: str,
    display_extent: Any,
    scenario_zoi: Any | None,
    direct_zone: Any | None,
    predicate: str = "TRUE",
    warnings: list[str] | None = None,
) -> list[dict[str, Any]]:
    # A mirror that has not published one configured layer yet must not cost the reviewer
    # the layers that are present, so a missing table is reported and skipped rather than
    # aborting the rest of the batch.
    if not _table_exists(connection, schema, table):
        if warnings is not None:
            warnings.append(f"{label} layer ({table}) is not in the local mirror; it was skipped.")
        return []
    try:
        columns = _columns(connection, table, schema)
        geometry = _column(columns, "geometry", "Shape", "SHAPE")
        if geometry is None:
            return []
        id_field = _column(columns, "OBJECTID", "WorkZoneID", "ParcelID", "PID", "GlobalID")
        attributes = [
            item for item in (
                id_field,
                _column(columns, "Subtheme"),
                _column(columns, "ParcelID"),
                _column(columns, "PID"),
                _column(columns, "Address"),
            )
            if item
        ]
        selected = ", ".join(f'"{item}"' for item in dict.fromkeys(attributes))
        if selected:
            selected += ", "
        qualified = f'"{schema}"."{table}"' if schema else f'"{table}"'
        priority = ""
        parameters = [bytes(display_extent.wkb), bytes(display_extent.wkb)]
        if scenario_zoi is not None and not scenario_zoi.is_empty:
            priority = (
                f'ORDER BY CASE WHEN ST_Intersects("{geometry}", ST_GeomFromWKB(?)) '
                "THEN 0 ELSE 1 END "
            )
            parameters.append(bytes(scenario_zoi.wkb))
        parameters.append(MAX_IMPACT_FEATURES + 1)
        rows = connection.execute(
            f'SELECT {selected}ST_AsWKB(ST_Intersection("{geometry}", ST_GeomFromWKB(?))) AS __wkb, '
            f'ST_Area("{geometry}") AS __feature_area_sqft, ST_Length("{geometry}") AS __feature_length_feet '
            f'FROM {qualified} '
            f'WHERE ({predicate}) AND ST_Intersects("{geometry}", ST_GeomFromWKB(?)) '
            f"{priority}LIMIT ?",
            parameters,
        ).fetchall()
        names = [str(item[0]) for item in connection.description]
    except duckdb.Error:
        return []
    result: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        values = dict(zip(names, row))
        feature_geometry = from_wkb(bytes(values.pop("__wkb")))
        feature_area = _finite_number(values.pop("__feature_area_sqft", None))
        feature_length = _finite_number(values.pop("__feature_length_feet", None))
        if feature_geometry.is_empty:
            continue
        feature_id = values.get(id_field) if id_field else index + 1
        influence = _feature_influence(
            feature_geometry,
            scenario_zoi,
            direct_zone,
            feature_area=feature_area,
            feature_length=feature_length,
        )
        result.append(
            {
                "id": f"{category}:{table}:{feature_id}",
                "category": category,
                "label": label,
                "source_table": table,
                **influence,
                "extends_beyond_extent": _extends_beyond_extent(
                    feature_geometry,
                    feature_area=feature_area,
                    feature_length=feature_length,
                ),
                "geometry_2264": feature_geometry,
                "attributes": {key: _json(value) for key, value in values.items()},
            }
        )
    return result


def _table_exists(connection: duckdb.DuckDBPyConnection, schema: str, table: str) -> bool:
    """True when the mirror publishes this table or view, matched case-insensitively.

    DuckDB resolves identifiers case-insensitively, so the layer lists can keep one
    spelling while mirrors carry the source's own casing (`ParcelJoin_py`).
    """

    statement = (
        "SELECT 1 FROM information_schema.tables "
        "WHERE lower(table_name) = lower(?) AND (? = '' OR lower(table_schema) = lower(?)) LIMIT 1"
    )
    try:
        return bool(connection.execute(statement, [table, schema, schema]).fetchall())
    except duckdb.Error:
        return False


def _extends_beyond_extent(
    clipped_geometry: Any,
    *,
    feature_area: float | None,
    feature_length: float | None,
) -> bool:
    """True when the map extent cut the feature, so the drawn shape is not its full outline.

    The query returns the feature clipped to the extent alongside the unclipped area and
    length, so the two measures answer this exactly - no second geometry has to travel.
    Polygons are judged on area because clipping can leave a shorter or longer perimeter.
    """

    # Both measures come from the same projected CRS, but one is measured by DuckDB and
    # the other by shapely, so only a difference above float noise counts as a real cut.
    tolerance = 1e-4
    if feature_area is not None and feature_area > 1e-6:
        return float(clipped_geometry.area) < feature_area * (1 - tolerance)
    if feature_length is not None and feature_length > 1e-6:
        return float(clipped_geometry.length) < feature_length * (1 - tolerance)
    return False


def _feature_influence(
    feature_geometry: Any,
    scenario_zoi: Any | None,
    direct_zone: Any | None,
    *,
    feature_area: float | None = None,
    feature_length: float | None = None,
) -> dict[str, Any]:
    """Measure the exact part of one context feature touched by the active defect ZOI."""

    influenced_geometry = None
    if scenario_zoi is not None and not scenario_zoi.is_empty:
        candidate = feature_geometry.intersection(scenario_zoi)
        if not candidate.is_empty:
            influenced_geometry = candidate
    is_influenced = influenced_geometry is not None
    is_direct = bool(
        is_influenced
        and direct_zone is not None
        and not direct_zone.is_empty
        and feature_geometry.intersects(direct_zone)
    )
    relationship = "direct" if is_direct else "within_zoi" if is_influenced else "context"
    measurement_type: str | None = None
    influenced_area: float | None = None
    influenced_percent: float | None = None
    influenced_length: float | None = None
    if influenced_geometry is not None:
        measured_area = float(influenced_geometry.area)
        measured_length = float(influenced_geometry.length)
        if measured_area > 1e-6:
            measurement_type = "area"
            influenced_area = round(measured_area, 3)
            if feature_area is not None and feature_area > 1e-6:
                influenced_percent = round(min(100.0, (measured_area / feature_area) * 100.0), 2)
        elif measured_length > 1e-6:
            measurement_type = "length"
            influenced_length = round(measured_length, 3)
            if feature_length is not None and feature_length > 1e-6:
                influenced_percent = round(min(100.0, (measured_length / feature_length) * 100.0), 2)
        else:
            measurement_type = "point"
    return {
        "relationship": relationship,
        "is_influenced": is_influenced,
        "measurement_type": measurement_type,
        "influenced_area_sqft": influenced_area,
        "feature_area_sqft": round(feature_area, 3) if feature_area is not None else None,
        "influenced_length_feet": influenced_length,
        "feature_length_feet": round(feature_length, 3) if feature_length is not None else None,
        "influenced_percent": influenced_percent,
        "influenced_geometry_2264": influenced_geometry,
    }


def _influence_footprint(features: list[dict[str, Any]]) -> Any | None:
    """Union polygon intersections so overlapping transparency is rendered exactly once."""

    polygons: list[Any] = []

    def collect(geometry: Any | None) -> None:
        if geometry is None or geometry.is_empty:
            return
        if geometry.geom_type in {"Polygon", "MultiPolygon"}:
            polygons.append(geometry)
            return
        if hasattr(geometry, "geoms"):
            for child in geometry.geoms:
                collect(child)

    for feature in features:
        collect(feature.get("influenced_geometry_2264"))
    if not polygons:
        return None
    footprint = unary_union(polygons)
    return None if footprint.is_empty else footprint


def _display_extent_miles(value: Any) -> float:
    if value is None or str(value).strip() == "":
        return DEFAULT_DISPLAY_EXTENT_MILES
    if isinstance(value, bool):
        raise HTTPException(
            status_code=422,
            detail="Map extent must be from 0.1 to 1.0 mile in 0.1-mile steps.",
        )
    try:
        extent = float(value)
    except (TypeError, ValueError) as error:
        raise HTTPException(
            status_code=422,
            detail="Map extent must be from 0.1 to 1.0 mile in 0.1-mile steps.",
        ) from error
    step_count = round(extent / DISPLAY_EXTENT_STEP_MILES)
    if (
        not math.isfinite(extent)
        or extent < MINIMUM_DISPLAY_EXTENT_MILES
        or extent > MAXIMUM_DISPLAY_EXTENT_MILES
        or not math.isclose(
            extent,
            step_count * DISPLAY_EXTENT_STEP_MILES,
            abs_tol=1e-9,
        )
    ):
        raise HTTPException(
            status_code=422,
            detail="Map extent must be from 0.1 to 1.0 mile in 0.1-mile steps.",
        )
    return round(extent, 1)


def _display_clip_extent(center_geometry: Any, extent_miles: float) -> tuple[Any, str]:
    """Return the selected square map extent centered on the active scenario."""

    center = center_geometry.centroid
    half_side = (extent_miles * FEET_PER_MILE) / 2.0
    extent = box(
        center.x - half_side,
        center.y - half_side,
        center.x + half_side,
        center.y + half_side,
    )
    return extent, "map_extent"


def _public_defect(defect: dict[str, Any], transformer: Transformer) -> dict[str, Any]:
    result = {key: value for key, value in defect.items() if key != "geometry_2264"}
    geometry = defect.get("geometry_2264")
    result["geometry"] = mapping(transform(transformer.transform, geometry)) if geometry is not None else None
    return result


def _public_analysis(analysis: dict[str, Any], transformer: Transformer) -> dict[str, Any]:
    impacts = []
    for item in analysis["impacted_features"]:
        geometry = transform(transformer.transform, item["geometry_2264"])
        influenced_geometry = item.get("influenced_geometry_2264")
        public_influence = (
            mapping(transform(transformer.transform, influenced_geometry))
            if influenced_geometry is not None
            else None
        )
        impacts.append(
            {
                **{
                    key: value
                    for key, value in item.items()
                    if key not in {"geometry_2264", "influenced_geometry_2264"}
                },
                "geometry": mapping(geometry),
                "influenced_geometry": public_influence,
            }
        )
    zoi = transform(transformer.transform, analysis["zoi_2264"])
    scenario_zoi = analysis.get("scenario_zoi_2264")
    influence_footprint = analysis.get("influence_footprint_2264")
    display_extent = transform(transformer.transform, analysis["display_extent_2264"])
    return {
        **{
            key: value
            for key, value in analysis.items()
            if key not in {
                "zoi_2264",
                "scenario_zoi_2264",
                "influence_footprint_2264",
                "display_extent_2264",
                "impacted_features",
            }
        },
        "zoi_geometry": mapping(zoi),
        "scenario_zoi_geometry": (
            mapping(transform(transformer.transform, scenario_zoi)) if scenario_zoi is not None else None
        ),
        "influence_footprint_geometry": (
            mapping(transform(transformer.transform, influence_footprint))
            if influence_footprint is not None
            else None
        ),
        "display_extent_geometry": mapping(display_extent),
        "impacted_features": impacts,
    }


def _public_cutaway(cutaway: dict[str, Any], transformer: Transformer) -> dict[str, Any]:
    center = Point(*cutaway["center_2264"])
    center_wgs84 = transform(transformer.transform, center)
    asset_geometry = transform(transformer.transform, cutaway["asset_geometry_2264"])
    bounds_geometry = transform(transformer.transform, cutaway["bounds_geometry_2264"])
    return {
        **{
            key: value
            for key, value in cutaway.items()
            if key not in {"center_2264", "asset_geometry_2264", "bounds_geometry_2264"}
        },
        "center": [round(float(center_wgs84.x), 7), round(float(center_wgs84.y), 7)],
        "asset_geometry": mapping(asset_geometry),
        "bounds_geometry": mapping(bounds_geometry),
        "soil_layers_schematic": True,
    }


def _cover_at(profile: dict[str, Any] | None, station: float | None) -> float | None:
    return _profile_values_at(profile, station)["cover"]


def _rounded(value: Any) -> float | None:
    numeric = _finite_number(value)
    return round(numeric, 3) if numeric is not None else None


def _asset_number(asset: dict[str, Any], *fields: str) -> float | None:
    by_name = {str(key).casefold(): value for key, value in asset.items()}
    for field in fields:
        numeric = _finite_number(by_name.get(field.casefold()))
        if numeric is not None:
            return numeric
    return None


def _open(path: Path, label: str) -> duckdb.DuckDBPyConnection:
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"The active {label} source is unavailable.")
    try:
        connection = duckdb.connect(str(path), read_only=True)
        load_spatial_extension(connection)
        return connection
    except (duckdb.Error, OSError, DuckDBSpatialExtensionError) as error:
        raise HTTPException(status_code=503, detail=f"Could not open the read-only {label} source: {error}") from error


def _columns(connection: duckdb.DuckDBPyConnection, table: str, schema: str = "") -> list[str]:
    qualified = f'"{schema}"."{table}"' if schema else f'"{table}"'
    try:
        return [str(row[0]) for row in connection.execute(f"DESCRIBE {qualified}").fetchall()]
    except duckdb.Error as error:
        raise HTTPException(status_code=503, detail=f"Required table {table} was not found.") from error


def _column(columns: list[str], *candidates: str) -> str | None:
    by_name = {item.casefold(): item for item in columns}
    return next((by_name[item.casefold()] for item in candidates if item.casefold() in by_name), None)


def _value(row: dict[str, Any], by_name: dict[str, str], *candidates: str) -> Any:
    field = next((by_name[item.casefold()] for item in candidates if item.casefold() in by_name), None)
    return row.get(field) if field else None


def _json(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value
