from __future__ import annotations

import json
import math
import os
import re
import struct
import tomllib
import time
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from portal.runtime.transport import (
    FileResponse,
    LocalApplication,
    HTTPException,
    JSONResponse,
    Query,
    Request,
    Response,
    StreamingResponse,
)

from .config import ConfigError, ProjectConfig, load_config


EASTERN_TIMEZONE = ZoneInfo("America/New_York")

ASSET_SEARCH_TARGETS = [
    {
        "dataset_id": "culverts",
        "label": "Culvert",
        "kind": "culvert",
        "primary_fields": ["FacilityID"],
        "field_mode": "facility",
    },
    {
        "dataset_id": "stormstructure_pt",
        "label": "Storm Structure",
        "kind": "structure",
        "primary_fields": ["AssetID", "ITPIPE_ASSETID"],
        "field_mode": "asset",
    },
    {
        "dataset_id": "stormpipes_ln",
        "label": "Storm Pipe",
        "kind": "pipe",
        "primary_fields": ["AssetID", "ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID"],
        "field_mode": "asset",
    },
    {
        "dataset_id": "stormdrainage_ln",
        "label": "Storm Drainage",
        "kind": "drainage",
        "primary_fields": ["AssetID", "ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID"],
        "field_mode": "asset",
    },
]

DUCKDB_HELPER_COLUMNS = {
    "__feature_id",
    "__dataset_id",
    "__tile_layer",
    "__geometry_type",
    "__geometry_wkb",
    "__minx",
    "__miny",
    "__maxx",
    "__maxy",
}

INVENTORY_METRIC_TABLES = {
    "structures": "DBO.STORMSTRUCTURE_PT",
    "active_pipes": "DBO.STORMPIPES_LN",
    "active_drainages": "DBO.STORMDRAINAGE_LN",
    "city_maintained_pipes": "DBO.CITY_PIPES_LN",
}

DUCKDB_GEOJSON_DATASET_IDS = {
    "culverts",
    "cw_inspections_all_pt",
    "itpipes_defects_ln",
    "itpipes_defects_pt",
    "itpipes_defects_top_risk_pt",
    "stormstructure_pt",
    "stormpipes_ln",
    "stormdrainage_ln",
    "ur_scfilter_cwonly_all_unassigned_allrisk_0101_pt",
}
DUCKDB_GEOJSON_FEATURE_LIMIT_MAX = 100_000
RISK_TOP_LIST_LIMIT = 10
RISK_SCORE_FIELDS = {
    "total": "RISK",
    "condition": "COND_RISK",
    "flood": "FLOOD_RISK",
    "clog": "CLOG_RISK",
}
ATTRIBUTE_FILTER_OPERATORS = {
    "eq",
    "ne",
    "contains",
    "starts_with",
    "gt",
    "gte",
    "lt",
    "lte",
    "is_null",
    "is_not_null",
}
ATTRIBUTE_FILTER_QUERY_MAX_LENGTH = 20000
ATTRIBUTE_FILTER_FIELD_TYPES = {"number", "text", "date"}
RISK_CITYWORKS_LAYERS = {
    "cityworks_all": {
        "id": "cityworks_all",
        "label": "Cityworks Inspections - All",
        "dataset_id": "cw_inspections_all_pt",
        "display_fields": [
            "ITPIPE_ASSETID",
            "INSPECTIONID",
            "INVESTIGATIONID",
            "Address",
            "Inspection_Date",
            "RISK",
            "COND_RISK",
            "FLOOD_RISK",
            "CLOG_RISK",
        ],
    },
    "cityworks_unassigned": {
        "id": "cityworks_unassigned",
        "label": "Cityworks Inspections - Unassigned",
        "dataset_id": "ur_scfilter_cwonly_all_unassigned_allrisk_0101_pt",
        "display_fields": [
            "ITPIPE_ASSETID",
            "INSPECTIONID",
            "INVESTIGATIONID",
            "Address",
            "Inspection_Date",
            "RISK",
            "COND_RISK",
            "FLOOD_RISK",
            "CLOG_RISK",
        ],
    },
}
RISK_ITPIPES_LAYERS = {
    "itpipes_top_risk": {
        "id": "itpipes_top_risk",
        "label": "ITPipes - Top Risk Defects",
        "dataset_id": "itpipes_defects_top_risk_pt",
        "display_fields": [
            "ITPIPE_ASSETID",
            "US_ASSETID",
            "DS_ASSETID",
            "Inspection_Date",
            "Code",
            "Grade",
            "Observation_Text",
            "RISK",
            "COND_RISK",
            "FLOOD_RISK",
            "CLOG_RISK",
        ],
    },
    "itpipes_all_defects_point": {
        "id": "itpipes_all_defects_point",
        "label": "ITPipes - All Defects - Point",
        "dataset_id": "itpipes_defects_pt",
        "display_fields": [
            "ITPIPE_ASSETID",
            "US_ASSETID",
            "DS_ASSETID",
            "Inspection_Date",
            "Code",
            "Grade",
            "Observation_Text",
            "RISK",
            "COND_RISK",
            "FLOOD_RISK",
            "CLOG_RISK",
        ],
    },
    "itpipes_all_defects_continuous": {
        "id": "itpipes_all_defects_continuous",
        "label": "ITPipes - All Defects - Continuous",
        "dataset_id": "itpipes_defects_ln",
        "display_fields": [
            "ITPIPE_ASSETID",
            "US_ASSETID",
            "DS_ASSETID",
            "Inspection_Date",
            "Code",
            "Grade",
            "Observation_Text",
            "RISK",
            "COND_RISK",
            "FLOOD_RISK",
            "CLOG_RISK",
        ],
    },
}
RISK_HISTOGRAM_BINS = [(start, start + 10) for start in range(0, 100, 10)]
DEFAULT_RISK_CITYWORKS_LAYER = "cityworks_all"
DEFAULT_RISK_HISTOGRAM_CITYWORKS_LAYER = "cityworks_all"
DEFAULT_RISK_TOP_LIST_ITPIPES_LAYER = "itpipes_top_risk"
DEFAULT_RISK_HISTOGRAM_ITPIPES_LAYER = "itpipes_all_defects_point"

INVENTORY_DUCKDB_PATH = Path(os.environ.get("PORTAL_INVENTORY_DUCKDB") or "__inventory_not_configured__")
CITY_PIPES_DUCKDB_PATH = Path(os.environ.get("PORTAL_CITY_PIPES_DUCKDB") or "__city_pipes_not_configured__")
FEET_PER_MILE = 5280.0
INVENTORY_FEATURE_LIMIT_MAX = 5000

INVENTORY_DUCKDB_LAYERS = {
    "active_structures": {
        "id": "active_structures",
        "label": "Active structures",
        "kind": "structures",
        "database": INVENTORY_DUCKDB_PATH,
        "table": "STORMSTRUCTURE_1_PT",
        "geometry_column": "geometry",
        "metric_type": "count",
        "unit": "structures",
        "precision": 0,
    },
    "active_pipes": {
        "id": "active_pipes",
        "label": "Active pipes length",
        "kind": "pipes",
        "database": INVENTORY_DUCKDB_PATH,
        "table": "STORMPIPES_1_LN",
        "geometry_column": "geometry",
        "metric_type": "length",
        "unit": "mi",
        "precision": 2,
    },
    "active_drainages": {
        "id": "active_drainages",
        "label": "Active drainages length",
        "kind": "drainages",
        "database": INVENTORY_DUCKDB_PATH,
        "table": "STORMDRAINAGE_1_LN",
        "geometry_column": "geometry",
        "metric_type": "length",
        "unit": "mi",
        "precision": 2,
    },
    "city_maintained_pipes": {
        "id": "city_maintained_pipes",
        "label": "City maintained pipes length",
        "kind": "city_pipes",
        "database": CITY_PIPES_DUCKDB_PATH,
        "table": "CITY_PIPES_LN",
        "geometry_column": "SHAPE",
        "metric_type": "length",
        "unit": "mi",
        "precision": 2,
        "length_columns": ["CITY_ROW_Length", "SWE_PARCEL_Length"],
    },
}

INVENTORY_TOTAL_CACHE_SECONDS = 300
_inventory_total_cache: dict[str, Any] = {"timestamp": 0.0, "metrics": {}}
_table_columns_cache: dict[str, list[str]] = {}


@dataclass(frozen=True)
class BackendState:
    project_config: ProjectConfig
    raw_config: dict[str, Any]

    @property
    def project_root(self) -> Path:
        return self.project_config.project_root

    @property
    def maplibre_dir(self) -> Path:
        return required_runtime_path("PORTAL_MAP_MAPLIBRE_ROOT", "MapLibre output root")

    @property
    def pmtiles_dir(self) -> Path:
        return required_runtime_path("PORTAL_MAP_PMTILES_ROOT", "PMTiles root")

    @property
    def terrain_dir(self) -> Path:
        return required_runtime_path("PORTAL_MAP_TERRAIN_ROOT", "terrain root")

    @property
    def reports_dir(self) -> Path:
        return required_runtime_path("PORTAL_MAP_REPORTS_ROOT", "map reports root")

    @property
    def duckdb_path(self) -> Path:
        return required_runtime_path("PORTAL_MAP_RISK_DUCKDB", "map risk DuckDB")


def required_runtime_path(environment_name: str, label: str) -> Path:
    configured = os.environ.get(environment_name, "").strip()
    if not configured:
        raise HTTPException(status_code=503, detail=f"{label} is not configured in portal.settings.json.")
    return Path(configured)


def create_app() -> LocalApplication:
    app = LocalApplication(
        title="STM Risk Map Local Commands",
        description="Local commands for generated MapLibre styles, PMTiles, and project metadata.",
        version="0.1.0",
    )

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        state = get_state()
        manifest_path = state.maplibre_dir / "manifest.json"
        return {
            "ok": True,
            "project_root": str(state.project_root),
            "config": str(state.project_config.config_path),
            "manifest_exists": manifest_path.exists(),
            "maplibre_dir": str(state.maplibre_dir),
            "pmtiles_dir": str(state.pmtiles_dir),
            "terrain_dir": str(state.terrain_dir),
        }

    @app.get("/api/project")
    def project_summary() -> dict[str, Any]:
        state = get_state()
        maps = raw_maps(state)
        datasets = raw_datasets(state)
        tilesets = raw_tilesets(state)
        manifest = read_manifest(state, required=False)
        return {
            "project": state.raw_config.get("project", {}),
            "config": project_relative(state.project_config.config_path, state.project_root),
            "paths": {
                key: project_relative(path, state.project_root)
                for key, path in state.project_config.paths.items()
            },
            "counts": {
                "maps": len(maps),
                "datasets": len(datasets),
                "enabled_datasets": sum(1 for item in datasets if item.get("enabled", True)),
                "tilesets": len(tilesets),
                "enabled_tilesets": sum(1 for item in tilesets if item.get("enabled", True)),
                "map_layers": sum(len(item.get("layers", [])) for item in maps),
            },
            "default_map_id": state.raw_config.get("maplibre", {}).get("default_map_id", ""),
            "terrain": compact_terrain(state),
            "manifest": manifest,
        }

    @app.post("/api/reload")
    def reload_project_config() -> dict[str, Any]:
        get_state.cache_clear()
        state = get_state()
        return {
            "ok": True,
            "config": str(state.project_config.config_path),
            "maps": len(raw_maps(state)),
            "datasets": len(raw_datasets(state)),
        }

    @app.get("/api/maps")
    def list_maps() -> dict[str, Any]:
        state = get_state()
        manifest = read_manifest(state, required=False)
        manifest_maps = {
            str(item.get("id", "")): item
            for item in manifest.get("maps", [])
            if isinstance(item, dict)
        }
        maps = []
        for map_entry in raw_maps(state):
            map_id = str(map_entry.get("id", ""))
            manifest_entry = manifest_maps.get(map_id, {})
            layers = list(map_entry.get("layers", []))
            maps.append(
                {
                    "id": map_id,
                    "name": map_entry.get("name", map_id),
                    "group_count": len(map_entry.get("groups", [])),
                    "layer_count": len(layers),
                    "visible_layer_count": sum(1 for layer in layers if layer.get("visible", True)),
                    "label_layer_count": manifest_entry.get("label_layer_count", count_label_classes(layers)),
                    "style": manifest_entry.get("style", ""),
                    "generated_style_layers": manifest_entry.get("style_layer_count", 0),
                    "generated_source_layers": manifest_entry.get("source_layer_count", 0),
                }
            )
        return {"maps": maps}

    @app.get("/api/maps/{map_id}")
    def get_map(map_id: str) -> dict[str, Any]:
        state = get_state()
        map_entry = find_map(state, map_id)
        layers = [compact_layer(layer) for layer in map_entry.get("layers", []) if isinstance(layer, dict)]
        return {
            "id": map_entry.get("id", map_id),
            "name": map_entry.get("name", map_id),
            "groups": map_entry.get("groups", []),
            "layer_count": len(layers),
            "layers": layers,
        }

    @app.get("/api/maps/{map_id}/layers")
    def list_map_layers(
        map_id: str,
        q: str = "",
        include_hidden: bool = True,
        limit: int = Query(500, ge=1, le=5000),
    ) -> dict[str, Any]:
        state = get_state()
        map_entry = find_map(state, map_id)
        query = q.strip().lower()
        layers = []
        for layer in map_entry.get("layers", []):
            if not isinstance(layer, dict):
                continue
            if not include_hidden and not layer.get("visible", True):
                continue
            item = compact_layer(layer)
            if query and not layer_matches(item, query):
                continue
            layers.append(item)
            if len(layers) >= limit:
                break
        return {"map_id": map_id, "layers": layers, "returned": len(layers)}

    @app.get("/api/datasets")
    def list_datasets(
        q: str = "",
        enabled_only: bool = False,
        limit: int = Query(500, ge=1, le=5000),
    ) -> dict[str, Any]:
        query = q.strip().lower()
        datasets = []
        for dataset in raw_datasets(get_state()):
            if enabled_only and not dataset.get("enabled", True):
                continue
            item = compact_dataset(dataset)
            if query and not dataset_matches(item, query):
                continue
            datasets.append(item)
            if len(datasets) >= limit:
                break
        return {"datasets": datasets, "returned": len(datasets)}

    @app.get("/api/datasets/{dataset_id}")
    def get_dataset(dataset_id: str) -> dict[str, Any]:
        state = get_state()
        for dataset in raw_datasets(state):
            if str(dataset.get("id", "")).lower() == dataset_id.lower():
                return dataset
        raise HTTPException(status_code=404, detail=f"Dataset not found: {dataset_id}")

    @app.get("/api/tilesets")
    def list_tilesets() -> dict[str, Any]:
        state = get_state()
        return {"tilesets": [compact_tileset(item, state.project_root) for item in raw_tilesets(state)]}

    @app.get("/api/maplibre/manifest")
    def maplibre_manifest() -> JSONResponse:
        return no_cache_json(read_manifest(get_state(), required=True))

    @app.get("/api/maplibre/styles/{style_path:path}")
    def maplibre_style(style_path: str) -> Response:
        state = get_state()
        path = safe_child_path(state.maplibre_dir, style_path)
        media_types = {
            ".json": "application/json",
            ".png": "image/png",
        }
        media_type = media_types.get(path.suffix.lower())
        if not media_type or not path.exists():
            raise HTTPException(status_code=404, detail=f"MapLibre asset not found: {style_path}")
        if path.suffix.lower() == ".json":
            try:
                payload = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError) as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"MapLibre JSON asset is invalid: {style_path}",
                ) from exc
            return no_cache_json(payload)
        return no_cache_file(path, media_type=media_type)

    @app.get("/api/pmtiles/{pmtiles_name:path}")
    def pmtiles_file(pmtiles_name: str, request: Request) -> Response:
        state = get_state()
        path = safe_child_path(state.pmtiles_dir, pmtiles_name)
        if path.suffix.lower() != ".pmtiles" or not path.exists():
            raise HTTPException(status_code=404, detail=f"PMTiles file not found: {pmtiles_name}")
        range_header = request.headers.get("range")
        if range_header:
            start, end = parse_byte_range(range_header, path.stat().st_size)
            content_length = end - start + 1
            return StreamingResponse(
                iter_file_range(path, start, end),
                status_code=206,
                media_type="application/octet-stream",
                headers={
                    "Accept-Ranges": "bytes",
                    "Content-Range": f"bytes {start}-{end}/{path.stat().st_size}",
                    "Content-Length": str(content_length),
                    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
                },
            )
        return FileResponse(
            path,
            media_type="application/octet-stream",
            filename=path.name,
            headers={
                "Accept-Ranges": "bytes",
                "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
            },
        )

    @app.head("/api/pmtiles/{pmtiles_name:path}")
    def pmtiles_head(pmtiles_name: str) -> Response:
        state = get_state()
        path = safe_child_path(state.pmtiles_dir, pmtiles_name)
        if path.suffix.lower() != ".pmtiles" or not path.exists():
            raise HTTPException(status_code=404, detail=f"PMTiles file not found: {pmtiles_name}")
        return Response(
            media_type="application/octet-stream",
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(path.stat().st_size),
                "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
            },
        )

    @app.get("/api/terrain/{terrain_id}/{z}/{x}/{y}.png")
    def terrain_tile(terrain_id: str, z: int, x: int, y: int) -> FileResponse:
        state = get_state()
        terrain = terrain_config_for_id(state, terrain_id)
        tile_dir = resolve_project_path(str(terrain.get("tile_dir", "")), state.project_root)
        path = safe_child_path(tile_dir, f"{z}/{x}/{y}.png")
        if path.suffix.lower() != ".png" or not path.exists():
            raise HTTPException(status_code=404, detail=f"Terrain tile not found: {terrain_id}/{z}/{x}/{y}.png")
        return FileResponse(
            path,
            media_type="image/png",
            headers={
                "Cache-Control": "no-store",
                "Pragma": "no-cache",
            },
        )

    @app.get("/api/search/assets")
    def search_assets(
        q: str = Query("", min_length=0, max_length=128),
        limit: int = Query(12, ge=1, le=50),
    ) -> dict[str, Any]:
        state = get_state()
        query = q.strip()
        if not query:
            return {
                "query": query,
                "database_exists": state.duckdb_path.exists(),
                "results": [],
                "returned": 0,
            }
        if not state.duckdb_path.exists():
            return {
                "query": query,
                "database_exists": False,
                "results": [],
                "returned": 0,
                "message": f"DuckDB database has not been built yet: {project_relative(state.duckdb_path, state.project_root)}",
            }
        results = query_asset_search(state, query, limit)
        return {
            "query": query,
            "database_exists": True,
            "results": results,
            "returned": len(results),
        }

    @app.get("/api/duckdb/geojson/{dataset_id}")
    def duckdb_geojson(
        dataset_id: str,
        limit: int = Query(25_000, ge=1, le=DUCKDB_GEOJSON_FEATURE_LIMIT_MAX),
        west: float | None = Query(None, ge=-180, le=180),
        south: float | None = Query(None, ge=-90, le=90),
        east: float | None = Query(None, ge=-180, le=180),
        north: float | None = Query(None, ge=-90, le=90),
        filters: str = Query("", max_length=ATTRIBUTE_FILTER_QUERY_MAX_LENGTH),
    ) -> dict[str, Any]:
        state = get_state()
        normalized_dataset_id = dataset_id.strip().lower()
        if normalized_dataset_id not in DUCKDB_GEOJSON_DATASET_IDS:
            raise HTTPException(status_code=404, detail=f"DuckDB GeoJSON dataset is not configured: {dataset_id}")
        bbox = valid_request_bbox(west, south, east, north)
        if not state.duckdb_path.exists():
            return empty_geojson_response(
                normalized_dataset_id,
                database_exists=False,
                message=f"DuckDB database has not been built yet: {project_relative(state.duckdb_path, state.project_root)}",
            )
        return query_duckdb_geojson_feature_collection(
            state,
            normalized_dataset_id,
            bbox,
            limit,
            parse_attribute_filter_query(filters),
        )

    @app.get("/api/risk/top-list")
    def risk_top_list(
        risk: str = Query("total", pattern="^(total|condition|flood|clog)$"),
        cityworks_layer: str = Query(DEFAULT_RISK_CITYWORKS_LAYER),
        itpipes_layer: str = Query(DEFAULT_RISK_TOP_LIST_ITPIPES_LAYER),
        west: float | None = Query(None, ge=-180, le=180),
        south: float | None = Query(None, ge=-90, le=90),
        east: float | None = Query(None, ge=-180, le=180),
        north: float | None = Query(None, ge=-90, le=90),
        filters: str = Query("", max_length=ATTRIBUTE_FILTER_QUERY_MAX_LENGTH),
    ) -> JSONResponse:
        state = get_state()
        bbox = valid_request_bbox(west, south, east, north)
        layer_configs = selected_risk_layer_configs(cityworks_layer, itpipes_layer)
        if not state.duckdb_path.exists():
            return no_cache_json({
                "ok": False,
                "risk": risk,
                "risk_field": RISK_SCORE_FIELDS[risk],
                "bbox": bbox,
                "lists": [],
                "message": f"DuckDB database has not been built yet: {project_relative(state.duckdb_path, state.project_root)}",
            })
        return no_cache_json(query_risk_top_lists(state, risk, bbox, layer_configs, parse_attribute_filter_query(filters)))

    @app.get("/api/risk/histograms")
    def risk_histograms(
        risk: str = Query("total", pattern="^(total|condition|flood|clog)$"),
        cityworks_layer: str = Query(DEFAULT_RISK_HISTOGRAM_CITYWORKS_LAYER),
        itpipes_layer: str = Query(DEFAULT_RISK_HISTOGRAM_ITPIPES_LAYER),
        west: float | None = Query(None, ge=-180, le=180),
        south: float | None = Query(None, ge=-90, le=90),
        east: float | None = Query(None, ge=-180, le=180),
        north: float | None = Query(None, ge=-90, le=90),
        filters: str = Query("", max_length=ATTRIBUTE_FILTER_QUERY_MAX_LENGTH),
    ) -> JSONResponse:
        state = get_state()
        bbox = valid_request_bbox(west, south, east, north)
        layer_configs = selected_risk_layer_configs(cityworks_layer, itpipes_layer)
        if not state.duckdb_path.exists():
            return no_cache_json({
                "ok": False,
                "risk": risk,
                "risk_field": RISK_SCORE_FIELDS[risk],
                "bbox": bbox,
                "histograms": [],
                "message": f"DuckDB database has not been built yet: {project_relative(state.duckdb_path, state.project_root)}",
            })
        return no_cache_json(query_risk_histograms(state, risk, bbox, layer_configs, parse_attribute_filter_query(filters)))

    @app.get("/api/metrics/inventory")
    def inventory_metrics(
        west: float | None = Query(None, ge=-180, le=180),
        south: float | None = Query(None, ge=-90, le=90),
        east: float | None = Query(None, ge=-180, le=180),
        north: float | None = Query(None, ge=-90, le=90),
        filters: str = Query("", max_length=ATTRIBUTE_FILTER_QUERY_MAX_LENGTH),
    ) -> dict[str, Any]:
        bbox = valid_request_bbox(west, south, east, north)
        metrics = query_inventory_metrics(bbox, parse_attribute_filter_query(filters))
        return {
            "ok": True,
            "generated_at": int(time.time()),
            "bbox": bbox,
            "metrics": metrics,
        }

    @app.get("/api/inventory/layers")
    def inventory_layers() -> dict[str, Any]:
        return {
            "layers": [
                {
                    "id": str(layer["id"]),
                    "label": str(layer["label"]),
                    "kind": str(layer["kind"]),
                    "table": str(layer["table"]),
                    "database": str(layer["database"]),
                    "unit": str(layer["unit"]),
                }
                for layer in INVENTORY_DUCKDB_LAYERS.values()
            ]
        }

    @app.get("/api/inventory/layers/{layer_id}/features")
    def inventory_layer_features(
        layer_id: str,
        limit: int = Query(1000, ge=1, le=INVENTORY_FEATURE_LIMIT_MAX),
        west: float | None = Query(None, ge=-180, le=180),
        south: float | None = Query(None, ge=-90, le=90),
        east: float | None = Query(None, ge=-180, le=180),
        north: float | None = Query(None, ge=-90, le=90),
        filters: str = Query("", max_length=ATTRIBUTE_FILTER_QUERY_MAX_LENGTH),
    ) -> dict[str, Any]:
        bbox = valid_request_bbox(west, south, east, north)
        return query_inventory_feature_collection(layer_id, bbox, limit, parse_attribute_filter_query(filters))

    @app.get("/api/filters/fields/{target_id}")
    def attribute_filter_fields(target_id: str) -> dict[str, Any]:
        state = get_state()
        normalized_target_id = target_id.strip().lower()
        if not normalized_target_id:
            raise HTTPException(status_code=400, detail="Missing filter target id.")
        if normalized_target_id in INVENTORY_DUCKDB_LAYERS:
            return attribute_filter_fields_for_inventory_layer(normalized_target_id)
        return attribute_filter_fields_for_dataset(state, normalized_target_id)

    @app.get("/api/reports")
    def list_reports() -> dict[str, Any]:
        state = get_state()
        if not state.reports_dir.exists():
            return {"reports": []}
        reports = [
            {
                "name": path.name,
                "path": project_relative(path, state.project_root),
                "size": path.stat().st_size,
                "modified": path.stat().st_mtime,
            }
            for path in sorted(state.reports_dir.glob("*"))
            if path.is_file()
        ]
        return {"reports": reports}

    return app


@lru_cache(maxsize=1)
def get_state() -> BackendState:
    configured = os.environ.get("PORTAL_MAP_TILES_CONFIG", "").strip()
    if not configured:
        raise HTTPException(status_code=503, detail="Map configuration is not configured in portal.settings.json.")
    config_path = Path(configured).resolve()
    try:
        project_config = load_config(config_path)
    except ConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    with config_path.open("rb") as handle:
        raw_config = tomllib.load(handle)
    return BackendState(project_config=project_config, raw_config=raw_config)


def parse_byte_range(range_header: str, file_size: int) -> tuple[int, int]:
    raw = range_header.strip()
    if not raw.lower().startswith("bytes="):
        raise HTTPException(status_code=416, detail="Unsupported Range header.", headers={"Content-Range": f"bytes */{file_size}"})
    range_spec = raw.split("=", 1)[1].split(",", 1)[0].strip()
    if "-" not in range_spec:
        raise HTTPException(status_code=416, detail="Invalid Range header.", headers={"Content-Range": f"bytes */{file_size}"})
    start_raw, end_raw = [part.strip() for part in range_spec.split("-", 1)]
    try:
        if start_raw == "":
            suffix_length = int(end_raw)
            if suffix_length <= 0:
                raise ValueError
            start = max(file_size - suffix_length, 0)
            end = file_size - 1
        else:
            start = int(start_raw)
            end = int(end_raw) if end_raw else file_size - 1
    except ValueError as exc:
        raise HTTPException(status_code=416, detail="Invalid Range header.", headers={"Content-Range": f"bytes */{file_size}"}) from exc
    if start < 0 or end < start or start >= file_size:
        raise HTTPException(status_code=416, detail="Requested range not satisfiable.", headers={"Content-Range": f"bytes */{file_size}"})
    return start, min(end, file_size - 1)


def iter_file_range(path: Path, start: int, end: int, chunk_size: int = 1024 * 1024):
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def raw_maps(state: BackendState) -> list[dict[str, Any]]:
    return [item for item in state.raw_config.get("maps", []) if isinstance(item, dict)]


def raw_datasets(state: BackendState) -> list[dict[str, Any]]:
    return [item for item in state.raw_config.get("datasets", []) if isinstance(item, dict)]


def raw_tilesets(state: BackendState) -> list[dict[str, Any]]:
    return [item for item in state.raw_config.get("tilesets", []) if isinstance(item, dict)]


def find_map(state: BackendState, map_id: str) -> dict[str, Any]:
    for map_entry in raw_maps(state):
        if str(map_entry.get("id", "")).lower() == map_id.lower():
            return map_entry
    raise HTTPException(status_code=404, detail=f"Map not found: {map_id}")


def read_manifest(state: BackendState, required: bool) -> dict[str, Any]:
    path = state.maplibre_dir / "manifest.json"
    if not path.exists():
        if required:
            raise HTTPException(status_code=404, detail=f"Manifest not found: {path}")
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail=f"Manifest is not a JSON object: {path}")
    return payload


def compact_layer(layer: dict[str, Any]) -> dict[str, Any]:
    label_classes = [item for item in layer.get("label_classes", []) if isinstance(item, dict)]
    return {
        "id": layer.get("id", ""),
        "aprx_layer": layer.get("aprx_layer", ""),
        "dataset_id": layer.get("dataset_id", ""),
        "tile_layer": layer.get("tile_layer", ""),
        "tile_source_layer": layer.get("tile_source_layer", ""),
        "service_type": layer.get("service_type", ""),
        "layer_order": layer.get("layer_order", 0),
        "draw_order": layer.get("draw_order", 0),
        "visible": layer.get("visible", True),
        "parent_group": layer.get("parent_group", ""),
        "group_path": layer.get("group_path", []),
        "min_scale": layer.get("min_scale", 0),
        "max_scale": layer.get("max_scale", 0),
        "transparency": layer.get("transparency", 0),
        "definition_query": layer.get("definition_query", ""),
        "renderer_type": layer.get("renderer_type", ""),
        "label_visibility": layer.get("label_visibility", False),
        "label_class_count": len(label_classes),
        "label_fields": layer.get("label_fields", []),
        "include_properties": layer.get("include_properties", []),
        "missing_requested_fields": layer.get("missing_requested_fields", []),
        "style_metadata_file": layer.get("style_metadata_file", ""),
    }


def compact_dataset(dataset: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": dataset.get("id", ""),
        "enabled": dataset.get("enabled", True),
        "description": dataset.get("description", ""),
        "format": dataset.get("format", ""),
        "geometry_type": dataset.get("geometry_type", ""),
        "service_type": dataset.get("service_type", ""),
        "source_layer": dataset.get("source_layer", ""),
        "tile_layer": dataset.get("tile_layer", ""),
        "fgb_path": dataset.get("fgb_path", ""),
        "layer_count": dataset.get("layer_count", 0),
        "maps": dataset.get("maps", []),
        "include_properties": dataset.get("include_properties", []),
        "missing_requested_fields": dataset.get("missing_requested_fields", []),
    }


def compact_tileset(tileset: dict[str, Any], project_root: Path) -> dict[str, Any]:
    output = str(tileset.get("output", ""))
    return {
        "id": tileset.get("id", ""),
        "enabled": tileset.get("enabled", True),
        "name": tileset.get("name", ""),
        "description": tileset.get("description", ""),
        "output": output,
        "output_exists": resolve_project_path(output, project_root).exists() if output else False,
        "dataset_count": len(tileset.get("datasets", [])),
        "tippecanoe": tileset.get("tippecanoe", {}),
    }


def compact_terrain(state: BackendState) -> dict[str, Any]:
    terrain = state.raw_config.get("terrain", {})
    if not isinstance(terrain, dict):
        return {"enabled": False}
    terrain_id = str(terrain.get("id", "terrain"))
    tile_dir = resolve_project_path(str(terrain.get("tile_dir", "")), state.project_root)
    tilejson = resolve_project_path(str(terrain.get("tilejson", "")), state.project_root)
    pmtiles_output = resolve_project_path(str(terrain.get("pmtiles_output", "")), state.project_root)
    return {
        "enabled": bool(terrain.get("enabled", False)),
        "id": terrain_id,
        "name": terrain.get("name", terrain_id),
        "source": terrain.get("source", ""),
        "tile_dir": project_relative(tile_dir, state.project_root),
        "tile_dir_exists": tile_dir.exists(),
        "tilejson": project_relative(tilejson, state.project_root),
        "tilejson_exists": tilejson.exists(),
        "pmtiles_output": project_relative(pmtiles_output, state.project_root),
        "pmtiles_exists": pmtiles_output.exists(),
        "minimum_zoom": terrain.get("minimum_zoom", terrain.get("min_zoom", "")),
        "maximum_zoom": terrain.get("maximum_zoom", terrain.get("max_zoom", "")),
        "encoding": terrain.get("encoding", "mapbox"),
    }


def terrain_config_for_id(state: BackendState, terrain_id: str) -> dict[str, Any]:
    terrain = state.raw_config.get("terrain", {})
    if not isinstance(terrain, dict) or not bool(terrain.get("enabled", False)):
        raise HTTPException(status_code=404, detail="Terrain is not enabled.")
    configured_id = str(terrain.get("id", "terrain"))
    if terrain_id.lower() != configured_id.lower():
        raise HTTPException(status_code=404, detail=f"Terrain source not found: {terrain_id}")
    return terrain


def count_label_classes(layers: list[dict[str, Any]]) -> int:
    return sum(len(layer.get("label_classes", [])) for layer in layers if isinstance(layer, dict))


def layer_matches(layer: dict[str, Any], query: str) -> bool:
    haystack = " ".join(
        str(layer.get(key, ""))
        for key in ("id", "aprx_layer", "dataset_id", "tile_layer", "tile_source_layer", "parent_group")
    ).lower()
    return query in haystack


def dataset_matches(dataset: dict[str, Any], query: str) -> bool:
    haystack = " ".join(
        str(dataset.get(key, ""))
        for key in ("id", "description", "format", "geometry_type", "service_type", "source_layer", "tile_layer")
    ).lower()
    return query in haystack


def query_asset_search(state: BackendState, query: str, limit: int) -> list[dict[str, Any]]:
    try:
        import duckdb
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include duckdb.") from exc

    datasets_by_id = {
        str(dataset.get("id", "")).lower(): dataset
        for dataset in raw_datasets(state)
        if isinstance(dataset, dict)
    }
    connection = duckdb.connect(str(state.duckdb_path), read_only=True)
    try:
        results: dict[str, dict[str, Any]] = {}
        for target in ASSET_SEARCH_TARGETS:
            dataset_id = str(target["dataset_id"])
            dataset = datasets_by_id.get(dataset_id.lower(), {})
            table_name = duckdb_table_for_dataset(connection, dataset_id)
            if not table_name:
                continue
            fields = duckdb_fields_for_dataset(connection, dataset_id, table_name)
            search_fields = search_fields_for_asset_target(target, dataset, fields)
            if not search_fields:
                continue
            per_field_limit = max(limit * 4, 20)
            for field in search_fields:
                for row in search_asset_field(connection, table_name, target, field, fields, query, per_field_limit):
                    key = f"{row['dataset_id']}:{row['feature_id']}"
                    existing = results.get(key)
                    if existing is None or float(row["score"]) > float(existing["score"]):
                        results[key] = row
        ordered = sorted(
            results.values(),
            key=lambda item: (
                -float(item.get("score") or 0),
                int(item.get("target_order") or 999),
                str(item.get("label") or ""),
            ),
        )
        return [finalize_asset_search_result(item) for item in ordered[:limit]]
    finally:
        connection.close()


def empty_geojson_response(
    dataset_id: str,
    *,
    database_exists: bool = True,
    message: str = "",
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "dataset_id": dataset_id,
        "database_exists": database_exists,
        "returned": 0,
        "limit": 0,
        "truncated": False,
    }
    if message:
        metadata["message"] = message
    return {
        "type": "FeatureCollection",
        "features": [],
        "metadata": metadata,
    }


def query_duckdb_geojson_feature_collection(
    state: BackendState,
    dataset_id: str,
    bbox: list[float] | None,
    limit: int,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    try:
        import duckdb
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include duckdb.") from exc

    connection = None
    try:
        connection = duckdb.connect(str(state.duckdb_path), read_only=True)
        table_name = duckdb_table_for_dataset(connection, dataset_id)
        if not table_name:
            return empty_geojson_response(dataset_id, message=f"DuckDB table was not found for dataset: {dataset_id}")
        fields = duckdb_fields_for_dataset(connection, dataset_id, table_name)
        property_fields = fields[:120]
        property_selects = [
            f"{quote_identifier(item['duckdb_column'])} AS {quote_identifier('__prop_' + str(index))}"
            for index, item in enumerate(property_fields)
        ]
        where_parts = ["__geometry_wkb IS NOT NULL"]
        params: list[Any] = []
        if bbox:
            west, south, east, north = bbox
            where_parts.append("__maxx >= ? AND __minx <= ? AND __maxy >= ? AND __miny <= ?")
            params.extend([west, east, south, north])
        filter_parts, filter_params = duckdb_attribute_filter_where_parts(
            attribute_filters,
            [dataset_id],
            fields,
        )
        where_parts.extend(filter_parts)
        params.extend(filter_params)
        sql = f"""
            SELECT
                __feature_id,
                __dataset_id,
                __geometry_type,
                __minx,
                __miny,
                __maxx,
                __maxy,
                __geometry_wkb
                {"," if property_selects else ""}
                {", ".join(property_selects)}
            FROM {quote_identifier(table_name)}
            WHERE {" AND ".join(where_parts)}
            LIMIT ?
        """
        params.append(int(limit))
        rows = connection.execute(sql, params).fetchall()
        names = [item[0] for item in connection.description]
    except Exception as exc:  # noqa: BLE001 - surface DuckDB locks and schema issues through the API
        raise HTTPException(status_code=503, detail=f"Could not read DuckDB GeoJSON for {dataset_id}: {exc}") from exc
    finally:
        if connection is not None:
            connection.close()

    prop_aliases = {f"__prop_{index}": field for index, field in enumerate(property_fields)}
    features = []
    for row in rows:
        values = dict(zip(names, row))
        geometry = wkb_to_geojson(values.get("__geometry_wkb"))
        if not geometry:
            continue
        properties = {
            prop_aliases[key]["source_field"]: jsonable_value(value)
            for key, value in values.items()
            if key in prop_aliases and value not in (None, "")
        }
        feature_id = int(values.get("__feature_id") or 0)
        properties["__feature_id"] = feature_id
        properties["__dataset_id"] = values.get("__dataset_id") or dataset_id
        properties["__geometry_type"] = values.get("__geometry_type") or ""
        features.append(
            {
                "type": "Feature",
                "id": feature_id,
                "geometry": geometry,
                "properties": properties,
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "dataset_id": dataset_id,
            "database": str(state.duckdb_path),
            "table": table_name,
            "bbox": bbox,
            "returned": len(features),
            "limit": int(limit),
            "truncated": len(features) >= int(limit),
            "property_count": len(property_fields),
        },
    }


def selected_risk_layer_configs(cityworks_layer: str, itpipes_layer: str) -> list[dict[str, Any]]:
    cityworks_config = RISK_CITYWORKS_LAYERS.get(cityworks_layer)
    if cityworks_config is None:
        allowed = ", ".join(RISK_CITYWORKS_LAYERS)
        raise HTTPException(status_code=400, detail=f"Unknown Cityworks risk layer: {cityworks_layer}. Expected one of: {allowed}")

    itpipes_config = RISK_ITPIPES_LAYERS.get(itpipes_layer)
    if itpipes_config is None:
        allowed = ", ".join(RISK_ITPIPES_LAYERS)
        raise HTTPException(status_code=400, detail=f"Unknown ITPipes risk layer: {itpipes_layer}. Expected one of: {allowed}")

    return [cityworks_config, itpipes_config]


def query_risk_top_lists(
    state: BackendState,
    risk: str,
    bbox: list[float] | None,
    layer_configs: list[dict[str, Any]],
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    try:
        import duckdb
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include duckdb.") from exc

    risk_field = RISK_SCORE_FIELDS[risk]
    connection = None
    try:
        connection = duckdb.connect(str(state.duckdb_path), read_only=True)
        lists = [
            query_risk_top_list_layer(connection, config, risk_field, bbox, attribute_filters)
            for config in layer_configs
        ]
    except Exception as exc:  # noqa: BLE001 - surface DuckDB locks and schema issues through the API
        raise HTTPException(status_code=503, detail=f"Could not read risk top list from DuckDB: {exc}") from exc
    finally:
        if connection is not None:
            connection.close()

    return {
        "ok": True,
        "generated_at": int(time.time()),
        "risk": risk,
        "risk_field": risk_field,
        "bbox": bbox,
        "lists": lists,
    }


def query_risk_histograms(
    state: BackendState,
    risk: str,
    bbox: list[float] | None,
    layer_configs: list[dict[str, Any]],
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    try:
        import duckdb
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include duckdb.") from exc

    risk_field = RISK_SCORE_FIELDS[risk]
    connection = None
    try:
        connection = duckdb.connect(str(state.duckdb_path), read_only=True)
        histograms = [
            query_risk_histogram_layer(connection, config, risk_field, bbox, attribute_filters)
            for config in layer_configs
        ]
    except Exception as exc:  # noqa: BLE001 - surface DuckDB locks and schema issues through the API
        raise HTTPException(status_code=503, detail=f"Could not read risk histograms from DuckDB: {exc}") from exc
    finally:
        if connection is not None:
            connection.close()

    return {
        "ok": True,
        "generated_at": int(time.time()),
        "risk": risk,
        "risk_field": risk_field,
        "bbox": bbox,
        "histograms": histograms,
    }


def query_risk_histogram_layer(
    connection: Any,
    layer_config: dict[str, Any],
    risk_field: str,
    bbox: list[float] | None,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    dataset_id = str(layer_config["dataset_id"])
    table_name = duckdb_table_for_dataset(connection, dataset_id)
    empty_bins = risk_histogram_bins_from_counts([0] * len(RISK_HISTOGRAM_BINS))
    if not table_name:
        return risk_histogram_response(layer_config, risk_field, empty_bins, 0, 0)

    fields = duckdb_fields_for_dataset(connection, dataset_id, table_name)
    fields_by_normalized = {normalize_token(field["source_field"]): field for field in fields}
    risk_column = field_column_for_source_field(fields_by_normalized, risk_field)
    if not risk_column:
        return risk_histogram_response(layer_config, risk_field, empty_bins, 0, 0)

    risk_expression = f"TRY_CAST({quote_identifier(risk_column)} AS DOUBLE)"
    where_parts = ["__geometry_wkb IS NOT NULL", f"{risk_expression} IS NOT NULL"]
    params: list[Any] = []
    if bbox:
        west, south, east, north = bbox
        where_parts.append("__maxx >= ? AND __minx <= ? AND __maxy >= ? AND __miny <= ?")
        params.extend([west, east, south, north])
    filter_parts, filter_params = duckdb_attribute_filter_where_parts(
        attribute_filters,
        risk_filter_target_keys(layer_config),
        fields,
    )
    where_parts.extend(filter_parts)
    params.extend(filter_params)

    bin_selects = []
    for index, (start, end) in enumerate(RISK_HISTOGRAM_BINS):
        upper_operator = "<=" if index == len(RISK_HISTOGRAM_BINS) - 1 else "<"
        bin_selects.append(
            f"SUM(CASE WHEN risk_score >= {start} AND risk_score {upper_operator} {end} THEN 1 ELSE 0 END) AS {quote_identifier('bin_' + str(index))}"
        )
    sql = f"""
        WITH filtered AS (
            SELECT {risk_expression} AS risk_score
            FROM {quote_identifier(table_name)}
            WHERE {" AND ".join(where_parts)}
        )
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN risk_score < 0 OR risk_score > 100 THEN 1 ELSE 0 END) AS out_of_range,
            {", ".join(bin_selects)}
        FROM filtered
    """
    row = connection.execute(sql, params).fetchone()
    if not row:
        return risk_histogram_response(layer_config, risk_field, empty_bins, 0, 0)
    total = int(row[0] or 0)
    out_of_range = int(row[1] or 0)
    counts = [int(value or 0) for value in row[2:]]
    return risk_histogram_response(
        layer_config,
        risk_field,
        risk_histogram_bins_from_counts(counts),
        total,
        out_of_range,
    )


def risk_histogram_bins_from_counts(counts: list[int]) -> list[dict[str, Any]]:
    bins = []
    for index, (start, end) in enumerate(RISK_HISTOGRAM_BINS):
        bins.append(
            {
                "label": f"{start}-{end}",
                "start": start,
                "end": end,
                "count": int(counts[index] if index < len(counts) else 0),
            }
        )
    return bins


def risk_histogram_response(
    layer_config: dict[str, Any],
    risk_field: str,
    bins: list[dict[str, Any]],
    total: int,
    out_of_range: int,
) -> dict[str, Any]:
    return {
        "id": str(layer_config["id"]),
        "label": str(layer_config["label"]),
        "dataset_id": str(layer_config["dataset_id"]),
        "risk_field": risk_field,
        "total": int(total),
        "out_of_range": int(out_of_range),
        "bins": bins,
    }


def query_risk_top_list_layer(
    connection: Any,
    layer_config: dict[str, Any],
    risk_field: str,
    bbox: list[float] | None,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    dataset_id = str(layer_config["dataset_id"])
    table_name = duckdb_table_for_dataset(connection, dataset_id)
    if not table_name:
        return risk_top_list_response(layer_config, risk_field, [])

    fields = duckdb_fields_for_dataset(connection, dataset_id, table_name)
    fields_by_normalized = {normalize_token(field["source_field"]): field for field in fields}
    risk_column = field_column_for_source_field(fields_by_normalized, risk_field)
    if not risk_column:
        return risk_top_list_response(layer_config, risk_field, [])
    grade_column = field_column_for_source_field(fields_by_normalized, "Grade")

    selected_fields: list[dict[str, str]] = []
    for field_name in list(layer_config.get("display_fields", [])):
        field = fields_by_normalized.get(normalize_token(str(field_name)))
        if field and field not in selected_fields:
            selected_fields.append(field)
    for field in fields[:40]:
        if field not in selected_fields and len(selected_fields) < 40:
            selected_fields.append(field)

    property_selects = [
        f"{quote_identifier(item['duckdb_column'])} AS {quote_identifier('__prop_' + str(index))}"
        for index, item in enumerate(selected_fields)
    ]
    risk_expression = f"TRY_CAST({quote_identifier(risk_column)} AS DOUBLE)"
    where_parts = ["__geometry_wkb IS NOT NULL", f"{risk_expression} IS NOT NULL"]
    params: list[Any] = []
    if bbox:
        west, south, east, north = bbox
        where_parts.append("__maxx >= ? AND __minx <= ? AND __maxy >= ? AND __miny <= ?")
        params.extend([west, east, south, north])
    filter_parts, filter_params = duckdb_attribute_filter_where_parts(
        attribute_filters,
        risk_filter_target_keys(layer_config),
        fields,
    )
    where_parts.extend(filter_parts)
    params.extend(filter_params)
    grade_filter = layer_config.get("grade_filter")
    if grade_filter is not None and grade_column:
        where_parts.append(f"TRY_CAST({quote_identifier(grade_column)} AS DOUBLE) = ?")
        params.append(float(grade_filter))

    sql = f"""
        SELECT
            __feature_id,
            __dataset_id,
            __geometry_type,
            __minx,
            __miny,
            __maxx,
            __maxy,
            __geometry_wkb,
            {risk_expression} AS __risk_score
            {"," if property_selects else ""}
            {", ".join(property_selects)}
        FROM {quote_identifier(table_name)}
        WHERE {" AND ".join(where_parts)}
        ORDER BY __risk_score DESC NULLS LAST
        LIMIT {RISK_TOP_LIST_LIMIT}
    """
    rows = connection.execute(sql, params).fetchall()
    names = [item[0] for item in connection.description]
    prop_aliases = {f"__prop_{index}": field for index, field in enumerate(selected_fields)}
    items = []
    for index, row in enumerate(rows):
        values = dict(zip(names, row))
        properties = {
            prop_aliases[key]["source_field"]: jsonable_value(value)
            for key, value in values.items()
            if key in prop_aliases and value not in (None, "")
        }
        feature_id = int(values.get("__feature_id") or 0)
        geometry = wkb_to_geojson(values.get("__geometry_wkb"))
        bbox_values = valid_bbox(
            [
                values.get("__minx"),
                values.get("__miny"),
                values.get("__maxx"),
                values.get("__maxy"),
            ]
        )
        items.append(
            {
                "rank": index + 1,
                "id": f"{dataset_id}:{feature_id}",
                "feature_id": feature_id,
                "dataset_id": dataset_id,
                "layer_id": str(layer_config["id"]),
                "layer_label": str(layer_config["label"]),
                "risk_score": round(float(values.get("__risk_score") or 0), 2),
                "risk_field": risk_field,
                "title": risk_item_title(properties, dataset_id, feature_id),
                "subtitle": risk_item_subtitle(properties),
                "geometry_type": values.get("__geometry_type") or "",
                "geometry": geometry,
                "bbox": bbox_values,
                "properties": properties,
            }
        )
    return risk_top_list_response(layer_config, risk_field, items)


def field_column_for_source_field(fields_by_normalized: dict[str, dict[str, str]], field_name: str) -> str:
    field = fields_by_normalized.get(normalize_token(field_name))
    return str(field["duckdb_column"]) if field else ""


def risk_top_list_response(layer_config: dict[str, Any], risk_field: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": str(layer_config["id"]),
        "label": str(layer_config["label"]),
        "dataset_id": str(layer_config["dataset_id"]),
        "risk_field": risk_field,
        "items": items,
    }


def risk_item_title(properties: dict[str, Any], dataset_id: str, feature_id: int) -> str:
    for field_name in ("ITPIPE_ASSETID", "FacilityID", "AssetID", "INSPECTIONID", "INVESTIGATIONID"):
        value = value_by_normalized_property(properties, field_name)
        if value not in (None, ""):
            return str(value)
    return f"{dataset_id} #{feature_id}"


def risk_item_subtitle(properties: dict[str, Any]) -> str:
    parts = []
    for field_name in ("Inspection_Date", "Code", "Grade", "INSPECTIONID", "INVESTIGATIONID"):
        value = value_by_normalized_property(properties, field_name)
        if value not in (None, ""):
            display_value = format_risk_subtitle_value(field_name, value)
            parts.append(f"{risk_subtitle_field_label(field_name)}: {display_value}")
        if len(parts) >= 2:
            break
    return " | ".join(parts)


def risk_subtitle_field_label(field_name: str) -> str:
    if normalize_token(field_name) == normalize_token("INSPECTIONID"):
        return "ID"
    return field_name


def format_risk_subtitle_value(field_name: str, value: Any) -> Any:
    normalized = normalize_token(field_name)
    if "date" in normalized or "time" in normalized:
        return format_eastern_date(value)
    if normalized == normalize_token("INSPECTIONID"):
        return format_integer_id(value)
    return value


def format_integer_id(value: Any) -> str:
    try:
        numeric_value = float(value)
    except (TypeError, ValueError):
        return str(value)
    if numeric_value.is_integer():
        return str(int(numeric_value))
    return str(value)


def format_eastern_date(value: Any) -> str:
    if isinstance(value, datetime):
        timestamp = value
    elif isinstance(value, date):
        return value.strftime("%m/%d/%Y")
    else:
        raw_value = str(value).strip()
        if not raw_value:
            return raw_value
        try:
            timestamp = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
        except ValueError:
            return raw_value
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=EASTERN_TIMEZONE)
    else:
        timestamp = timestamp.astimezone(EASTERN_TIMEZONE)
    return timestamp.strftime("%m/%d/%Y")


def value_by_normalized_property(properties: dict[str, Any], field_name: str) -> Any:
    normalized = normalize_token(field_name)
    for key, value in properties.items():
        if normalize_token(key) == normalized:
            return value
    return None


def valid_request_bbox(
    west: float | None,
    south: float | None,
    east: float | None,
    north: float | None,
) -> list[float] | None:
    if any(value is None for value in (west, south, east, north)):
        return None
    assert west is not None and south is not None and east is not None and north is not None
    if west >= east or south >= north:
        raise HTTPException(status_code=400, detail="Invalid bbox. Expected west < east and south < north.")
    return [west, south, east, north]


def parse_attribute_filter_query(raw_filters: str) -> dict[str, list[dict[str, Any]]]:
    raw = (raw_filters or "").strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid attribute filter JSON: {exc.msg}") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Attribute filters must be a JSON object keyed by layer or dataset id.")

    parsed: dict[str, list[dict[str, Any]]] = {}
    for raw_key, raw_rules in payload.items():
        key = normalize_filter_target_key(str(raw_key))
        if not key or not isinstance(raw_rules, list):
            continue
        rules: list[dict[str, Any]] = []
        for raw_rule in raw_rules[:32]:
            if not isinstance(raw_rule, dict):
                continue
            field = str(raw_rule.get("field", "")).strip()
            operator = str(raw_rule.get("operator", "")).strip().lower()
            value = str(raw_rule.get("value", "")).strip()
            if not field or operator not in ATTRIBUTE_FILTER_OPERATORS:
                continue
            if operator not in {"is_null", "is_not_null"} and value == "":
                continue
            rules.append({"field": field, "operator": operator, "value": value})
        if rules:
            parsed[key] = rules
    return parsed


def duckdb_attribute_filter_where_parts(
    attribute_filters: dict[str, list[dict[str, Any]]] | None,
    target_keys: list[str],
    fields: list[dict[str, str]],
) -> tuple[list[str], list[Any]]:
    rules = attribute_filter_rules_for_targets(attribute_filters, target_keys)
    if not rules:
        return [], []

    fields_by_normalized = {normalize_token(str(field["source_field"])): field for field in fields}
    parts: list[str] = []
    params: list[Any] = []
    for rule in rules:
        field = fields_by_normalized.get(normalize_token(str(rule.get("field", ""))))
        if not field:
            continue
        column = quote_identifier(str(field["duckdb_column"]))
        operator = str(rule.get("operator", "")).lower()
        value = str(rule.get("value", ""))
        field_type = attribute_filter_field_type(
            str(field.get("source_field", "")),
            str(field.get("duckdb_column", "")),
            str(field.get("data_type", "")),
        )
        text_expression = f"CAST({column} AS VARCHAR)"
        lower_expression = f"lower({text_expression})"

        if operator == "eq":
            if field_type == "number":
                try:
                    numeric_value = float(value)
                except ValueError:
                    continue
                parts.append(f"TRY_CAST({column} AS DOUBLE) = ?")
                params.append(numeric_value)
            elif field_type == "date":
                parts.append(f"TRY_CAST({column} AS DATE) = TRY_CAST(? AS DATE)")
                params.append(value)
            else:
                parts.append(f"{text_expression} = ?")
                params.append(value)
        elif operator == "ne":
            if field_type == "number":
                try:
                    numeric_value = float(value)
                except ValueError:
                    continue
                parts.append(f"({column} IS NULL OR TRY_CAST({column} AS DOUBLE) <> ?)")
                params.append(numeric_value)
            elif field_type == "date":
                parts.append(f"({column} IS NULL OR TRY_CAST({column} AS DATE) <> TRY_CAST(? AS DATE))")
                params.append(value)
            else:
                parts.append(f"({column} IS NULL OR {text_expression} <> ?)")
                params.append(value)
        elif operator == "contains":
            if field_type != "text":
                continue
            parts.append(f"{lower_expression} LIKE ? ESCAPE '\\'")
            params.append(f"%{escape_like(value.lower())}%")
        elif operator == "starts_with":
            if field_type != "text":
                continue
            parts.append(f"{lower_expression} LIKE ? ESCAPE '\\'")
            params.append(f"{escape_like(value.lower())}%")
        elif operator in {"gt", "gte", "lt", "lte"}:
            comparator = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[operator]
            if field_type == "date":
                parts.append(f"TRY_CAST({column} AS TIMESTAMP) {comparator} TRY_CAST(? AS TIMESTAMP)")
                params.append(value)
            elif field_type == "number":
                try:
                    numeric_value = float(value)
                except ValueError:
                    continue
                parts.append(f"TRY_CAST({column} AS DOUBLE) {comparator} ?")
                params.append(numeric_value)
            else:
                continue
        elif operator == "is_null":
            parts.append(f"({column} IS NULL OR {text_expression} = '')")
        elif operator == "is_not_null":
            parts.append(f"({column} IS NOT NULL AND {text_expression} <> '')")

    return parts, params


def attribute_filter_rules_for_targets(
    attribute_filters: dict[str, list[dict[str, Any]]] | None,
    target_keys: list[str],
) -> list[dict[str, Any]]:
    if not attribute_filters:
        return []
    rules: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for target_key in target_keys:
        normalized = normalize_filter_target_key(target_key)
        for rule in attribute_filters.get(normalized, []):
            identity = (str(rule.get("field", "")), str(rule.get("operator", "")), str(rule.get("value", "")))
            if identity in seen:
                continue
            seen.add(identity)
            rules.append(rule)
    return rules


def risk_filter_target_keys(layer_config: dict[str, Any]) -> list[str]:
    return [
        str(layer_config.get("id", "")),
        str(layer_config.get("dataset_id", "")),
    ]


def inventory_filter_target_keys(layer: dict[str, Any]) -> list[str]:
    return [
        str(layer.get("id", "")),
        str(layer.get("kind", "")),
        str(layer.get("table", "")),
    ]


def normalize_filter_target_key(value: str) -> str:
    return value.strip().lower()


def query_inventory_metrics(
    bbox: list[float] | None,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    total_values = inventory_total_values(attribute_filters) if attribute_filters else cached_inventory_total_values()
    extent_wkt = bbox_to_stateplane_wkt(bbox) if bbox else None
    extent_values = inventory_extent_values(extent_wkt, attribute_filters) if extent_wkt else total_values
    return [
        inventory_metric_from_layer(layer, total_values[str(layer["id"])], extent_values[str(layer["id"])])
        for layer in INVENTORY_DUCKDB_LAYERS.values()
    ]


def query_inventory_feature_collection(
    layer_id: str,
    bbox: list[float] | None,
    limit: int,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    layer = inventory_layer_or_404(layer_id)
    geometry_column = str(layer.get("geometry_column", "geometry"))
    extent_wkt = bbox_to_stateplane_wkt(bbox) if bbox else None
    connection = open_inventory_duckdb(layer)
    try:
        schema_fields = duckdb_table_schema_fields(connection, str(layer["table"]))
        columns = [field["source_field"] for field in schema_fields]
        if geometry_column not in columns:
            raise HTTPException(
                status_code=500,
                detail=f"Geometry column {geometry_column!r} was not found in {layer['table']}.",
            )
        property_columns = [column for column in columns if column != geometry_column]
        select_properties = ", ".join(quote_identifier(column) for column in property_columns)
        select_properties = f", {select_properties}" if select_properties else ""
        where_clause, params = duckdb_spatial_where_clause(geometry_column, extent_wkt)
        filter_fields = [field for field in schema_fields if field["source_field"] != geometry_column]
        filter_parts, filter_params = duckdb_attribute_filter_where_parts(
            attribute_filters,
            inventory_filter_target_keys(layer),
            filter_fields,
        )
        if filter_parts:
            where_clause = " AND ".join([where_clause, *filter_parts])
            params.extend(filter_params)
        rows = connection.execute(
            f"""
            SELECT ST_AsWKB({quote_identifier(geometry_column)}) AS "__geometry_wkb"
                   {select_properties}
            FROM {quote_identifier(str(layer["table"]))}
            WHERE {where_clause}
            LIMIT {int(limit)}
            """,
            params,
        ).fetchall()
    finally:
        connection.close()

    features = []
    for row in rows:
        geometry = stateplane_wkb_to_wgs84_geojson(row[0])
        if not geometry:
            continue
        properties = {
            column: serializable_value(row[index + 1])
            for index, column in enumerate(property_columns)
            if row[index + 1] is not None
        }
        features.append({"type": "Feature", "geometry": geometry, "properties": properties})
    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "layer_id": str(layer["id"]),
            "label": str(layer["label"]),
            "database": str(layer["database"]),
            "table": str(layer["table"]),
            "returned": len(features),
            "limit": limit,
            "bbox": bbox,
        },
    }


def open_sdw_connection() -> Any:
    import duckdb

    database = required_runtime_path("PORTAL_SDW_DUCKDB", "spatial data warehouse DuckDB")
    if not database.is_file():
        raise HTTPException(status_code=503, detail=f"Spatial data warehouse DuckDB was not found: {database}")
    try:
        return duckdb.connect(str(database), read_only=True)
    except duckdb.Error as exc:
        raise HTTPException(status_code=503, detail=f"Could not open spatial data warehouse DuckDB: {exc}") from exc


def cached_inventory_total_values() -> dict[str, float]:
    now = time.monotonic()
    cached_timestamp = float(_inventory_total_cache.get("timestamp") or 0.0)
    cached_metrics = _inventory_total_cache.get("metrics")
    cached_signature = _inventory_total_cache.get("signature")
    signature = inventory_database_signature()
    if (
        isinstance(cached_metrics, dict)
        and cached_signature == signature
        and now - cached_timestamp < INVENTORY_TOTAL_CACHE_SECONDS
    ):
        return {key: float(value) for key, value in cached_metrics.items()}
    metrics = inventory_total_values()
    _inventory_total_cache["timestamp"] = now
    _inventory_total_cache["metrics"] = metrics
    _inventory_total_cache["signature"] = signature
    return metrics


def inventory_total_values(attribute_filters: dict[str, list[dict[str, Any]]] | None = None) -> dict[str, float]:
    return {
        str(layer["id"]): inventory_metric_value_for_layer(layer, None, attribute_filters)
        for layer in INVENTORY_DUCKDB_LAYERS.values()
    }


def inventory_extent_values(
    extent_wkt: str,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, float]:
    return {
        str(layer["id"]): inventory_metric_value_for_layer(layer, extent_wkt, attribute_filters)
        for layer in INVENTORY_DUCKDB_LAYERS.values()
    }


def inventory_metric_value_for_layer(
    layer: dict[str, Any],
    extent_wkt: str | None,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> float:
    connection = open_inventory_duckdb(layer)
    try:
        geometry_column = str(layer.get("geometry_column", "geometry"))
        where_clause, params = duckdb_spatial_where_clause(geometry_column, extent_wkt)
        schema_fields = duckdb_table_schema_fields(connection, str(layer["table"]))
        filter_fields = [field for field in schema_fields if field["source_field"] != geometry_column]
        filter_parts, filter_params = duckdb_attribute_filter_where_parts(
            attribute_filters,
            inventory_filter_target_keys(layer),
            filter_fields,
        )
        if filter_parts:
            where_clause = " AND ".join([where_clause, *filter_parts])
            params.extend(filter_params)
        if str(layer.get("metric_type")) == "count":
            sql = f"""
                SELECT COUNT(*)
                FROM {quote_identifier(str(layer["table"]))}
                WHERE {where_clause}
            """
            return query_single_number(connection, sql, params)
        length_expression = duckdb_length_miles_expression(connection, layer)
        sql = f"""
            SELECT {length_expression}
            FROM {quote_identifier(str(layer["table"]))}
            WHERE {where_clause}
        """
        return query_single_number(connection, sql, params)
    finally:
        connection.close()


def query_single_number(connection: Any, sql: str, params: list[Any] | None = None) -> float:
    row = connection.execute(sql, params or []).fetchone()
    if not row or row[0] is None:
        return 0.0
    return float(row[0])


def inventory_database_signature() -> tuple[tuple[str, float], ...]:
    paths = sorted({Path(str(layer["database"])) for layer in INVENTORY_DUCKDB_LAYERS.values()})
    signature = []
    for path in paths:
        try:
            modified = path.stat().st_mtime
        except OSError:
            modified = 0.0
        signature.append((str(path), modified))
    return tuple(signature)


def inventory_layer_or_404(layer_id: str) -> dict[str, Any]:
    layer = INVENTORY_DUCKDB_LAYERS.get(layer_id)
    if layer:
        return layer
    raise HTTPException(status_code=404, detail=f"Inventory layer not found: {layer_id}")


def attribute_filter_fields_for_inventory_layer(layer_id: str) -> dict[str, Any]:
    layer = inventory_layer_or_404(layer_id)
    connection = open_inventory_duckdb(layer)
    try:
        fields = duckdb_table_schema_fields(connection, str(layer["table"]))
    finally:
        connection.close()
    return {
        "ok": True,
        "target_id": layer_id,
        "fields": filterable_field_metadata(fields, geometry_columns={str(layer.get("geometry_column", "geometry"))}),
    }


def attribute_filter_fields_for_dataset(state: BackendState, dataset_id: str) -> dict[str, Any]:
    if state.duckdb_path.exists():
        try:
            import duckdb
        except ImportError as exc:
            raise HTTPException(status_code=500, detail="The bundled Python runtime must include duckdb.") from exc
        connection = duckdb.connect(str(state.duckdb_path), read_only=True)
        try:
            table_name = duckdb_table_for_dataset(connection, dataset_id)
            if table_name:
                fields = duckdb_fields_for_dataset(connection, dataset_id, table_name)
                return {
                    "ok": True,
                    "target_id": dataset_id,
                    "fields": filterable_field_metadata(fields),
                }
        finally:
            connection.close()

    for dataset in raw_datasets(state):
        if str(dataset.get("id", "")).lower() != dataset_id.lower():
            continue
        names = [
            str(name)
            for name in dataset.get("include_properties", [])
            if isinstance(name, str) and name.strip()
        ]
        return {
            "ok": True,
            "target_id": dataset_id,
            "fields": filterable_field_metadata([
                {"source_field": name, "duckdb_column": name, "data_type": ""}
                for name in names
            ]),
            "message": "Field types were inferred from project configuration.",
        }

    raise HTTPException(status_code=404, detail=f"Filter field target not found: {dataset_id}")


def filterable_field_metadata(
    fields: list[dict[str, str]],
    geometry_columns: set[str] | None = None,
) -> list[dict[str, str]]:
    geometry_names = {name.lower() for name in geometry_columns or set()}
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for field in fields:
        name = str(field.get("source_field", "")).strip()
        column = str(field.get("duckdb_column", name)).strip()
        data_type = str(field.get("data_type", "")).strip()
        field_type = attribute_filter_field_type(name, column, data_type)
        if (
            not name
            or normalize_token(name) in seen
            or not field_type
            or is_excluded_filter_field(name, column, geometry_names)
        ):
            continue
        seen.add(normalize_token(name))
        result.append({"name": name, "type": field_type, "data_type": data_type})
    return sorted(result, key=lambda item: item["name"].lower())


def is_excluded_filter_field(name: str, column: str, geometry_names: set[str]) -> bool:
    normalized_names = {normalize_token(name), normalize_token(column)}
    if normalized_names & {"shape", "objectid", "objectid1", "oid", "fid", "geometry"}:
        return True
    if name.lower() in geometry_names or column.lower() in geometry_names:
        return True
    if name.lower().startswith("__") or column.lower().startswith("__"):
        return True
    return False


def attribute_filter_field_type(name: str, column: str, data_type: str) -> str:
    normalized_type = data_type.lower()
    normalized_name = normalize_token(name or column)
    if normalized_name in {"shape", "geometry"}:
        return ""
    if any(token in normalized_type for token in ("date", "time", "timestamp")):
        return "date"
    if any(token in normalized_type for token in ("int", "double", "float", "decimal", "numeric", "real", "hugeint", "bigint", "smallint", "tinyint", "utinyint", "uinteger", "ubigint")):
        return "number"
    if any(token in normalized_type for token in ("char", "text", "varchar", "string", "uuid", "bool")) or not normalized_type:
        if re.search(r"(date|time)$", normalized_name):
            return "date"
        if re.search(r"(risk|score|grade|length|count|num|number|height|width|area|miles?)$", normalized_name):
            return "number"
        return "text"
    return ""


def open_inventory_duckdb(layer: dict[str, Any]) -> Any:
    try:
        import duckdb
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include duckdb.") from exc

    path = Path(str(layer["database"]))
    if not path.exists():
        raise HTTPException(status_code=503, detail=f"Inventory DuckDB file was not found: {path}")
    try:
        connection = duckdb.connect(str(path), read_only=True)
        load_duckdb_spatial_extension(connection)
        return connection
    except Exception as exc:  # noqa: BLE001 - surface DuckDB locks and extension errors through API
        raise HTTPException(status_code=503, detail=f"Could not open inventory DuckDB {path}: {exc}") from exc


def load_duckdb_spatial_extension(connection: Any) -> None:
    try:
        connection.execute("LOAD spatial")
    except Exception:
        connection.execute("INSTALL spatial")
        connection.execute("LOAD spatial")


def duckdb_table_columns(connection: Any, table_name: str) -> list[str]:
    cache_key = f"duckdb:{getattr(connection, 'database_name', '')}:{table_name}".lower()
    if cache_key in _table_columns_cache:
        return _table_columns_cache[cache_key]
    rows = connection.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE lower(table_name) = lower(?)
        ORDER BY ordinal_position
        """,
        [table_name],
    ).fetchall()
    columns = [str(row[0]) for row in rows]
    _table_columns_cache[cache_key] = columns
    return columns


def duckdb_table_schema_fields(connection: Any, table_name: str) -> list[dict[str, str]]:
    rows = connection.execute(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE lower(table_name) = lower(?)
        ORDER BY ordinal_position
        """,
        [table_name],
    ).fetchall()
    return [
        {
            "source_field": str(column_name),
            "duckdb_column": str(column_name),
            "data_type": str(data_type),
        }
        for column_name, data_type in rows
    ]


def duckdb_spatial_where_clause(geometry_column: str, extent_wkt: str | None) -> tuple[str, list[Any]]:
    geometry = quote_identifier(geometry_column)
    if not extent_wkt:
        return f"{geometry} IS NOT NULL", []
    return f"{geometry} IS NOT NULL AND ST_Intersects({geometry}, ST_GeomFromText(?))", [extent_wkt]


def duckdb_length_miles_expression(connection: Any, layer: dict[str, Any]) -> str:
    table_name = str(layer["table"])
    columns = duckdb_table_columns(connection, table_name)
    by_lower = {column.lower(): column for column in columns}
    configured_columns = [str(column) for column in layer.get("length_columns", [])]
    length_columns = [by_lower[column.lower()] for column in configured_columns if column.lower() in by_lower]
    if length_columns:
        expression = " + ".join(f"COALESCE({quote_identifier(column)}, 0)" for column in length_columns)
        return f"SUM(({expression}) / {FEET_PER_MILE})"
    for candidate in ("shape_length", "shape__length", "shape_leng", "st_length"):
        column = by_lower.get(candidate)
        if column:
            return f"SUM(COALESCE({quote_identifier(column)}, 0) / {FEET_PER_MILE})"
    geometry_column = str(layer.get("geometry_column", "geometry"))
    return f"SUM(COALESCE(ST_Length({quote_identifier(geometry_column)}), 0) / {FEET_PER_MILE})"


def inventory_metric_from_layer(layer: dict[str, Any], total: float, visible: float) -> dict[str, Any]:
    return inventory_metric(
        str(layer["id"]),
        str(layer["label"]),
        str(layer["unit"]),
        total,
        visible,
        int(layer["precision"]),
        f"{layer['database']}::{layer['table']}",
    )


def active_sql() -> str:
    return "(Active = '1' OR TRY_CONVERT(int, Active) = 1)"


def shape_length_sum_expression(connection: Any, table_name: str) -> str:
    shape_length_column = shape_length_column_for_table(connection, table_name)
    if shape_length_column:
        return f"SUM(COALESCE([{shape_length_column}], 0))"
    return "SUM(COALESCE(Shape.STLength(), 0))"


def shape_length_column_for_table(connection: Any, table_name: str) -> str:
    columns = table_columns(connection, table_name)
    by_lower = {column.lower(): column for column in columns}
    for candidate in ("shape_length", "shape__length", "shape_leng", "st_length"):
        if candidate in by_lower:
            return by_lower[candidate]
    return ""


def table_columns(connection: Any, table_name: str) -> list[str]:
    cache_key = table_name.lower()
    if cache_key in _table_columns_cache:
        return _table_columns_cache[cache_key]
    schema, name = sql_schema_and_table(table_name)
    rows = connection.cursor().execute(
        """
        SELECT c.name
        FROM sys.columns c
        JOIN sys.objects o ON c.object_id = o.object_id
        JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE lower(s.name) = lower(?) AND lower(o.name) = lower(?)
        ORDER BY c.column_id
        """,
        [schema, name],
    ).fetchall()
    columns = [str(row[0]) for row in rows]
    _table_columns_cache[cache_key] = columns
    return columns


def sql_schema_and_table(table_name: str) -> tuple[str, str]:
    parts = [part.strip("[] ") for part in table_name.split(".") if part.strip()]
    if len(parts) >= 2:
        return parts[-2], parts[-1]
    return "dbo", parts[-1] if parts else table_name


def bbox_to_stateplane_wkt(bbox: list[float]) -> str:
    try:
        from pyproj import Transformer
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include pyproj.") from exc

    west, south, east, north = bbox
    # Inventory geometries are stored in NAD83 / North Carolina StatePlane feet.
    # In some Conda builds, the WGS84 transformation path returns infinities,
    # while NAD83 geographic coordinates transform correctly and are close enough
    # for web-map lon/lat bounds.
    transformer = Transformer.from_crs("EPSG:4269", "EPSG:2264", always_xy=True)
    points = [
        transformer.transform(west, south),
        transformer.transform(east, south),
        transformer.transform(east, north),
        transformer.transform(west, north),
        transformer.transform(west, south),
    ]
    if not all(math.isfinite(x) and math.isfinite(y) for x, y in points):
        raise HTTPException(status_code=400, detail="Map extent could not be projected to the inventory coordinate system.")
    coordinates = ", ".join(f"{x:.3f} {y:.3f}" for x, y in points)
    return f"POLYGON(({coordinates}))"


def inventory_metric(
    metric_id: str,
    label: str,
    unit: str,
    total: float,
    visible: float,
    precision: int,
    source_table: str,
) -> dict[str, Any]:
    return {
        "id": metric_id,
        "label": label,
        "unit": unit,
        "precision": precision,
        "total": round(float(total), precision),
        "visible_extent": round(float(visible), precision),
        "source_table": source_table,
    }


def duckdb_table_for_dataset(connection: Any, dataset_id: str) -> str:
    rows = connection.execute(
        """
        SELECT table_name
        FROM _datasets
        WHERE lower(dataset_id) = lower(?)
        LIMIT 1
        """,
        [dataset_id],
    ).fetchall()
    candidates = [str(rows[0][0])] if rows else [dataset_id]
    for candidate in candidates:
        exists = connection.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE lower(table_name) = lower(?)
            LIMIT 1
            """,
            [candidate],
        ).fetchone()
        if exists:
            return str(exists[0])
    return ""


def duckdb_fields_for_dataset(connection: Any, dataset_id: str, table_name: str) -> list[dict[str, str]]:
    columns = connection.execute(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE lower(table_name) = lower(?)
        ORDER BY ordinal_position
        """,
        [table_name],
    ).fetchall()
    columns_by_name = {str(name).lower(): str(data_type) for name, data_type in columns}
    rows = connection.execute(
        """
        SELECT source_field, duckdb_column
        FROM _fields
        WHERE lower(dataset_id) = lower(?)
        ORDER BY ordinal
        """,
        [dataset_id],
    ).fetchall()
    fields: list[dict[str, str]] = []
    used: set[str] = set()
    for source_field, duckdb_column in rows:
        column = str(duckdb_column)
        if column.lower() not in columns_by_name or column.lower() in DUCKDB_HELPER_COLUMNS:
            continue
        fields.append(
            {
                "source_field": str(source_field),
                "duckdb_column": column,
                "data_type": columns_by_name.get(column.lower(), ""),
            }
        )
        used.add(column.lower())
    for column, data_type in columns:
        column_name = str(column)
        if column_name.lower() in used or column_name.lower() in DUCKDB_HELPER_COLUMNS:
            continue
        fields.append(
            {
                "source_field": column_name,
                "duckdb_column": column_name,
                "data_type": str(data_type),
            }
        )
    return fields


def search_fields_for_asset_target(
    target: dict[str, Any],
    dataset: dict[str, Any],
    fields: list[dict[str, str]],
) -> list[dict[str, str]]:
    fields_by_normalized = {normalize_token(field["source_field"]): field for field in fields}
    selected: list[dict[str, str]] = []

    def add_field_name(field_name: str) -> None:
        field = fields_by_normalized.get(normalize_token(field_name))
        if field and field not in selected:
            selected.append(field)

    for field_name in target.get("primary_fields", []):
        add_field_name(str(field_name))
    for field_name in dataset.get("id_fields", []):
        add_field_name(str(field_name))

    mode = str(target.get("field_mode", "asset"))
    for field in fields:
        normalized = normalize_token(field["source_field"])
        if mode == "facility" and "facility" in normalized and "id" in normalized:
            if field not in selected:
                selected.append(field)
        if mode == "asset" and "asset" in normalized and "id" in normalized:
            if field not in selected:
                selected.append(field)
        if is_address_field(field["source_field"]) and field not in selected:
            selected.append(field)

    return selected


def search_asset_field(
    connection: Any,
    table_name: str,
    target: dict[str, Any],
    field: dict[str, str],
    all_fields: list[dict[str, str]],
    query: str,
    limit: int,
) -> list[dict[str, Any]]:
    column = quote_identifier(field["duckdb_column"])
    value_sql = f"CAST({column} AS VARCHAR)"
    lower_sql = f"lower({value_sql})"
    normalized_sql = f"regexp_replace({lower_sql}, '[^a-z0-9]+', '', 'g')"
    escaped_query = escape_like(query.lower())
    normalized_query = normalize_token(query)
    contains_pattern = f"%{escaped_query}%"
    prefix_pattern = f"{escaped_query}%"
    normalized_contains = f"%{normalized_query}%"
    normalized_prefix = f"{normalized_query}%"
    fuzzy_enabled = len(normalized_query) >= 3
    fuzzy_threshold = 0.84 if len(normalized_query) >= 5 else 0.9
    score_sql = f"""
        CASE
            WHEN {lower_sql} = lower(?) THEN 100.0
            WHEN {normalized_sql} = ? THEN 98.0
            WHEN {lower_sql} LIKE lower(?) ESCAPE '\\' THEN 92.0
            WHEN {normalized_sql} LIKE ? THEN 88.0
            WHEN {lower_sql} LIKE lower(?) ESCAPE '\\' THEN 76.0
            ELSE jaro_winkler_similarity({lower_sql}, lower(?)) * 72.0
        END
    """
    match_parts = [
        f"{lower_sql} LIKE lower(?) ESCAPE '\\'",
        f"{normalized_sql} LIKE ?",
    ]
    params: list[Any] = [
        query,
        normalized_query,
        prefix_pattern,
        normalized_prefix,
        contains_pattern,
        query,
        contains_pattern,
        normalized_contains,
    ]
    if fuzzy_enabled:
        match_parts.append(f"jaro_winkler_similarity({lower_sql}, lower(?)) >= ?")
        params.extend([query, fuzzy_threshold])
    where_sql = f"{column} IS NOT NULL AND ({' OR '.join(match_parts)})"

    property_fields = all_fields[:80]
    property_selects = [
        f"{quote_identifier(item['duckdb_column'])} AS {quote_identifier('__prop_' + str(index))}"
        for index, item in enumerate(property_fields)
    ]
    sql = f"""
        SELECT
            __feature_id,
            __geometry_type,
            __minx,
            __miny,
            __maxx,
            __maxy,
            __geometry_wkb,
            {value_sql} AS __match_value,
            {score_sql} AS __score
            {"," if property_selects else ""}
            {", ".join(property_selects)}
        FROM {quote_identifier(table_name)}
        WHERE {where_sql}
        ORDER BY __score DESC
        LIMIT ?
    """
    params.append(limit)
    rows = connection.execute(sql, params).fetchall()
    names = [item[0] for item in connection.description]
    results: list[dict[str, Any]] = []
    prop_aliases = {f"__prop_{index}": field for index, field in enumerate(property_fields)}
    for row in rows:
        values = dict(zip(names, row))
        properties = {
            prop_aliases[key]["source_field"]: jsonable_value(value)
            for key, value in values.items()
            if key in prop_aliases and value not in (None, "")
        }
        geometry = wkb_to_geojson(values.get("__geometry_wkb"))
        bbox = valid_bbox(
            [
                values.get("__minx"),
                values.get("__miny"),
                values.get("__maxx"),
                values.get("__maxy"),
            ]
        )
        dataset_id = str(target["dataset_id"])
        match_value = "" if values.get("__match_value") is None else str(values.get("__match_value"))
        display_value = primary_display_value(target, properties) or match_value
        target_label = str(target.get("label", dataset_id))
        results.append(
            {
                "id": f"{dataset_id}:{values.get('__feature_id')}:{normalize_token(field['source_field'])}",
                "feature_id": int(values.get("__feature_id") or 0),
                "dataset_id": dataset_id,
                "table_name": table_name,
                "layer_name": target_label,
                "kind": target.get("kind", dataset_id),
                "label": f"{target_label} {display_value}".strip(),
                "subtitle": f"{field['source_field']}: {match_value}",
                "match_field": field["source_field"],
                "match_value": match_value,
                "score": float(values.get("__score") or 0),
                "target_order": ASSET_SEARCH_TARGETS.index(target),
                "geometry_type": values.get("__geometry_type") or "",
                "geometry": geometry,
                "bbox": bbox,
                "properties": properties,
            }
        )
    return results


def finalize_asset_search_result(item: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item[key]
        for key in (
            "id",
            "feature_id",
            "dataset_id",
            "table_name",
            "layer_name",
            "kind",
            "label",
            "subtitle",
            "match_field",
            "match_value",
            "score",
            "geometry_type",
            "geometry",
            "bbox",
            "properties",
        )
    }


def primary_display_value(target: dict[str, Any], properties: dict[str, Any]) -> str:
    by_normalized = {normalize_token(key): value for key, value in properties.items()}
    for field_name in target.get("primary_fields", []):
        value = by_normalized.get(normalize_token(str(field_name)))
        if value not in (None, ""):
            return str(value)
    return ""


def is_address_field(field_name: str) -> bool:
    normalized = normalize_token(field_name)
    return "address" in normalized or normalized in {"addr", "fulladdr", "fulladdress", "siteaddr", "siteaddress"}


def normalize_token(value: str) -> str:
    return re.sub(r"[^0-9a-z]+", "", str(value).lower())


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def quote_identifier(identifier: str) -> str:
    return '"' + str(identifier).replace('"', '""') + '"'


def parse_geometry_json(value: Any) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        geometry = json.loads(str(value))
    except json.JSONDecodeError:
        return None
    return geometry if isinstance(geometry, dict) else None


def wkb_to_geojson(value: Any) -> dict[str, Any] | None:
    if not value:
        return None
    data = bytes(value)
    try:
        geometry, offset = read_wkb_geometry(data, 0)
    except (IndexError, struct.error, ValueError):
        return None
    if offset <= len(data) and isinstance(geometry, dict):
        return geometry
    return None


def stateplane_wkb_to_wgs84_geojson(value: Any) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        from shapely import wkb
        from shapely.geometry import mapping
        from shapely.ops import transform
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include shapely.") from exc

    try:
        geometry = wkb.loads(bytes(value))
    except Exception:
        return None
    if geometry.is_empty:
        return None
    transformed = transform(stateplane_to_wgs84_transformer().transform, geometry)
    return mapping(transformed)


@lru_cache(maxsize=1)
def stateplane_to_wgs84_transformer() -> Any:
    try:
        from pyproj import Transformer
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include pyproj.") from exc
    return Transformer.from_crs("EPSG:2264", "EPSG:4269", always_xy=True)


def serializable_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    return value


def read_wkb_geometry(data: bytes, offset: int) -> tuple[dict[str, Any], int]:
    byte_order = data[offset]
    offset += 1
    endian = "<" if byte_order == 1 else ">"
    raw_type, offset = read_uint32(data, offset, endian)
    geometry_type, coordinate_dimensions, has_srid = normalize_wkb_type(raw_type)
    if has_srid:
        _, offset = read_uint32(data, offset, endian)

    if geometry_type == 1:
        coordinate, offset = read_wkb_coordinate(data, offset, endian, coordinate_dimensions)
        return {"type": "Point", "coordinates": coordinate}, offset
    if geometry_type == 2:
        coordinates, offset = read_wkb_coordinate_sequence(data, offset, endian, coordinate_dimensions)
        return {"type": "LineString", "coordinates": coordinates}, offset
    if geometry_type == 3:
        rings, offset = read_wkb_polygon(data, offset, endian, coordinate_dimensions)
        return {"type": "Polygon", "coordinates": rings}, offset
    if geometry_type in {4, 5, 6, 7}:
        count, offset = read_uint32(data, offset, endian)
        geometries: list[dict[str, Any]] = []
        for _ in range(count):
            geometry, offset = read_wkb_geometry(data, offset)
            geometries.append(geometry)
        if geometry_type == 4:
            return {"type": "MultiPoint", "coordinates": [item["coordinates"] for item in geometries]}, offset
        if geometry_type == 5:
            return {"type": "MultiLineString", "coordinates": [item["coordinates"] for item in geometries]}, offset
        if geometry_type == 6:
            return {"type": "MultiPolygon", "coordinates": [item["coordinates"] for item in geometries]}, offset
        return {"type": "GeometryCollection", "geometries": geometries}, offset
    raise ValueError(f"Unsupported WKB geometry type: {geometry_type}")


def normalize_wkb_type(raw_type: int) -> tuple[int, int, bool]:
    has_srid = bool(raw_type & 0x20000000)
    has_z = bool(raw_type & 0x80000000)
    has_m = bool(raw_type & 0x40000000)
    geometry_type = raw_type & 0x000000FF if raw_type & 0xE0000000 else raw_type
    dimensions = 2 + int(has_z) + int(has_m)
    if geometry_type >= 3000:
        geometry_type -= 3000
        dimensions = max(dimensions, 4)
    elif geometry_type >= 2000:
        geometry_type -= 2000
        dimensions = max(dimensions, 3)
    elif geometry_type >= 1000:
        geometry_type -= 1000
        dimensions = max(dimensions, 3)
    return geometry_type, dimensions, has_srid


def read_wkb_polygon(data: bytes, offset: int, endian: str, dimensions: int) -> tuple[list[list[list[float]]], int]:
    ring_count, offset = read_uint32(data, offset, endian)
    rings: list[list[list[float]]] = []
    for _ in range(ring_count):
        coordinates, offset = read_wkb_coordinate_sequence(data, offset, endian, dimensions)
        rings.append(coordinates)
    return rings, offset


def read_wkb_coordinate_sequence(data: bytes, offset: int, endian: str, dimensions: int) -> tuple[list[list[float]], int]:
    count, offset = read_uint32(data, offset, endian)
    coordinates: list[list[float]] = []
    for _ in range(count):
        coordinate, offset = read_wkb_coordinate(data, offset, endian, dimensions)
        coordinates.append(coordinate)
    return coordinates, offset


def read_wkb_coordinate(data: bytes, offset: int, endian: str, dimensions: int) -> tuple[list[float], int]:
    values = []
    for _ in range(max(2, dimensions)):
        value, offset = read_double(data, offset, endian)
        values.append(value)
    return [values[0], values[1]], offset


def read_uint32(data: bytes, offset: int, endian: str) -> tuple[int, int]:
    return struct.unpack_from(f"{endian}I", data, offset)[0], offset + 4


def read_double(data: bytes, offset: int, endian: str) -> tuple[float, int]:
    return struct.unpack_from(f"{endian}d", data, offset)[0], offset + 8


def valid_bbox(values: list[Any]) -> list[float] | None:
    try:
        bbox = [float(value) for value in values]
    except (TypeError, ValueError):
        return None
    if not all(value == value and value not in {float("inf"), float("-inf")} for value in bbox):
        return None
    return bbox


def jsonable_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def safe_child_path(base_dir: Path, relative_path: str) -> Path:
    base = base_dir.resolve()
    path = (base / relative_path.replace("\\", "/")).resolve()
    try:
        path.relative_to(base)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path is outside the configured directory.") from exc
    return path


def resolve_project_path(value: str, project_root: Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return (project_root / path).resolve()


def project_relative(path: Path, project_root: Path) -> str:
    try:
        return str(path.resolve().relative_to(project_root.resolve())).replace("\\", "/")
    except ValueError:
        return str(path)


def no_cache_json(payload: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        payload,
        headers={
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
        },
    )


def no_cache_file(path: Path, media_type: str) -> FileResponse:
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
        },
    )


app = create_app()
