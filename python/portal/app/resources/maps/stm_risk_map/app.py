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

from portal.app.core.desktop_config import (
    configured_map_duckdb_geojson_layers,
    configured_pmtiles_detail_sources,
)
from portal.app.core.duckdb_extensions import load_spatial_extension
from portal.app.core.source_cache import (
    resolve_file_info as resolve_cached_file_info,
    resolve_file_name as resolve_cached_file_name,
)
from portal.app.resources.tables.storm_water_asset_history.source import (
    assignment_status as query_step401_assignment,
    binary_assignment_status,
)
from portal.runtime.transport import (
    FileResponse,
    LocalApplication,
    HTTPException,
    JSONResponse,
    Query,
    Request,
    Response,
)

from .config import ConfigError, ProjectConfig, load_config


EASTERN_TIMEZONE = ZoneInfo("America/New_York")
RESOURCE_MAPLIBRE_ROOT = Path(__file__).resolve().parent / "assets" / "maplibre"
LEGACY_LAYER_SOURCE_ID = "planning_project"

ASSET_SEARCH_TARGETS = [
    {
        "dataset_id": "culverts",
        "label": "Culvert",
        "kind": "culvert",
        "primary_fields": ["FacilityID"],
        "field_mode": "facility",
        "source": "configured_layer",
    },
    {
        "dataset_id": "stormstructure_pt",
        "label": "Storm Structure",
        "kind": "structure",
        "primary_fields": ["AssetID", "ITPIPE_ASSETID"],
        "field_mode": "asset",
        "source": "inventory",
        "table": "STORMSTRUCTURE_1_PT",
        "geometry_column": "geometry",
        "feature_id_column": "AssetID",
    },
    {
        "dataset_id": "stormpipes_ln",
        "label": "Storm Pipe",
        "kind": "pipe",
        "primary_fields": ["AssetID", "ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID"],
        "field_mode": "asset",
        "source": "inventory",
        "table": "STORMPIPES_1_LN",
        "geometry_column": "geometry",
        "feature_id_column": "AssetID",
    },
    {
        "dataset_id": "stormdrainage_ln",
        "label": "Storm Drainage",
        "kind": "drainage",
        "primary_fields": ["AssetID", "ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID"],
        "field_mode": "asset",
        "source": "inventory",
        "table": "STORMDRAINAGE_1_LN",
        "geometry_column": "geometry",
        "feature_id_column": "AssetID",
    },
]

INVENTORY_METRIC_TABLES = {
    "structures": "DBO.STORMSTRUCTURE_PT",
    "active_pipes": "DBO.STORMPIPES_LN",
    "active_drainages": "DBO.STORMDRAINAGE_LN",
    "city_maintained_pipes": "DBO.CITY_PIPES_LN",
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
_duckdb_schema_cache: dict[str, list[dict[str, str]]] = {}


@dataclass(frozen=True)
class BackendState:
    project_config: ProjectConfig
    raw_config: dict[str, Any]

    @property
    def project_root(self) -> Path:
        return self.project_config.project_root

    @property
    def maplibre_dir(self) -> Path:
        return RESOURCE_MAPLIBRE_ROOT

    @property
    def pmtiles_dir(self) -> Path:
        return required_runtime_path("PORTAL_MAP_PMTILES_ROOT", "PMTiles root")

    @property
    def legacy_pmtiles_dir(self) -> Path:
        return required_runtime_path("PORTAL_MAP_LEGACY_PMTILES_ROOT", "legacy PMTiles root")

    @property
    def portal_layer_archives(self) -> dict[str, str]:
        raw = os.environ.get("PORTAL_MAP_THEMATIC_ARCHIVES_JSON", "").strip()
        if not raw:
            return {}
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=500,
                detail="maps.portalLayerArchives is invalid in portal.settings.json.",
            ) from exc
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=500,
                detail="maps.portalLayerArchives must be an object in portal.settings.json.",
            )
        archives: dict[str, str] = {}
        for archive_id, archive_name in payload.items():
            key = str(archive_id).strip().lower()
            name = str(archive_name).strip()
            if not re.fullmatch(r"[a-z][a-z0-9_]*", key):
                raise HTTPException(status_code=500, detail=f"Invalid thematic archive id: {archive_id}")
            if name != Path(name).name or Path(name).suffix.lower() != ".pmtiles":
                raise HTTPException(status_code=500, detail=f"Invalid thematic PMTiles archive: {name}")
            archives[key] = name
        return archives

    @property
    def legacy_map_archive(self) -> str:
        return required_archive_name(
            "PORTAL_MAP_LEGACY_ARCHIVE",
            "legacy map PMTiles archive",
        )

    @property
    def terrain_dir(self) -> Path:
        return required_runtime_path("PORTAL_MAP_TERRAIN_ROOT", "terrain root")

    @property
    def terrain_archive(self) -> str:
        configured = os.environ.get("PORTAL_MAP_TERRAIN_ARCHIVE", "").strip()
        if not configured:
            return ""
        return required_archive_name("PORTAL_MAP_TERRAIN_ARCHIVE", "Terrain PMTiles archive")

    @property
    def reports_dir(self) -> Path:
        return required_runtime_path("PORTAL_MAP_REPORTS_ROOT", "map reports root")

def required_runtime_path(environment_name: str, label: str) -> Path:
    configured = os.environ.get(environment_name, "").strip()
    if not configured:
        raise HTTPException(status_code=503, detail=f"{label} is not configured in portal.settings.json.")
    return Path(configured)


def required_runtime_value(environment_name: str, label: str) -> str:
    configured = os.environ.get(environment_name, "").strip()
    if not configured:
        raise HTTPException(status_code=503, detail=f"{label} is not configured in portal.settings.json.")
    return configured


def required_archive_name(environment_name: str, label: str) -> str:
    configured = required_runtime_value(environment_name, label)
    if configured != Path(configured).name or Path(configured).suffix.lower() != ".pmtiles":
        raise HTTPException(
            status_code=500,
            detail=f"{label} must be a PMTiles file name, not a file path.",
        )
    return configured


def configured_pmtiles_path(
    state: BackendState,
    archive_name: str,
    *,
    required: bool = True,
) -> Path:
    archive = Path(archive_name).name
    if archive != archive_name or Path(archive).suffix.lower() != ".pmtiles":
        raise HTTPException(status_code=404, detail=f"PMTiles archive is not registered: {archive_name}")
    cached = resolve_cached_file_name(archive)
    if cached is not None:
        return cached
    if os.environ.get("PORTAL_DESKTOP_MODE", "").strip().lower() in {"1", "true", "yes", "on"}:
        registered_names = {
            state.legacy_map_archive,
            state.terrain_archive,
            *state.portal_layer_archives.values(),
        } - {""}
        if archive not in registered_names:
            raise HTTPException(status_code=404, detail=f"PMTiles archive is not registered: {archive_name}")
        cache_manifest = Path(os.environ.get("PORTAL_SOURCE_CACHE_MANIFEST", "source-cache/current.json"))
        unavailable = cache_manifest.parent / "unavailable" / archive
        if required:
            raise HTTPException(status_code=404, detail=f"No active local PMTiles version is available: {archive}")
        return unavailable
    registrations = [(state.legacy_pmtiles_dir / archive, state.legacy_map_archive)]
    registrations.extend(
        (state.pmtiles_dir / archive, registered_name)
        for registered_name in state.portal_layer_archives.values()
    )
    if state.terrain_archive:
        registrations.append((state.terrain_dir / archive, state.terrain_archive))
    registered = [path for path, registered_name in registrations if archive == registered_name]
    if not registered:
        raise HTTPException(status_code=404, detail=f"PMTiles archive is not registered: {archive_name}")
    for path in registered:
        if path.is_file():
            return path
    if required:
        raise HTTPException(status_code=404, detail=f"PMTiles archive was not found: {registered[0]}")
    return registered[0]


def expected_portal_source_layers(state: BackendState) -> set[str]:
    path = state.maplibre_dir / "portal-layer-source-ids.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Portal layer registry is invalid: {path}") from exc
    if not isinstance(payload, list) or not all(isinstance(item, str) and item for item in payload):
        raise HTTPException(status_code=500, detail=f"Portal layer registry is invalid: {path}")
    return {item.lower() for item in payload}


def expected_portal_archive_layers(state: BackendState) -> dict[str, set[str]]:
    path = state.maplibre_dir / "portal-layer-archives.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Portal archive registry is invalid: {path}") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail=f"Portal archive registry is invalid: {path}")
    result: dict[str, set[str]] = {}
    seen: set[str] = set()
    for archive_id, raw_layers in payload.items():
        key = str(archive_id).strip().lower()
        if not re.fullmatch(r"[a-z][a-z0-9_]*", key) or not isinstance(raw_layers, list):
            raise HTTPException(status_code=500, detail=f"Portal archive registry is invalid: {path}")
        layers = {
            str(layer).strip().lower()
            for layer in raw_layers
            if isinstance(layer, str) and str(layer).strip()
        }
        if len(layers) != len(raw_layers) or seen & layers:
            raise HTTPException(status_code=500, detail=f"Portal archive registry has duplicate layers: {path}")
        result[key] = layers
        seen.update(layers)
    expected = expected_portal_source_layers(state)
    if seen != expected:
        raise HTTPException(
            status_code=500,
            detail="Portal thematic archive registry does not match the approved source-layer registry.",
        )
    return result


def portal_archive_source_layers(state: BackendState, archive_name: str) -> set[str]:
    payload, _manifest_path = portal_archive_manifest_payload(state, archive_name)
    layers = payload.get("layers")
    if not isinstance(layers, list):
        raise HTTPException(status_code=500, detail="Portal PMTiles manifest has no layer list.")
    return {
        str(item.get("id") or "").lower()
        for item in layers
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }


def portal_archive_manifest_payload(
    state: BackendState,
    archive_name: str,
) -> tuple[dict[str, Any], Path]:
    archive = configured_pmtiles_path(state, archive_name)
    manifest_name = archive.name + ".manifest.json"
    manifest_path = resolve_cached_file_name(manifest_name) or archive.with_suffix(archive.suffix + ".manifest.json")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Portal PMTiles manifest was not found: {manifest_path}",
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Portal PMTiles manifest is invalid: {manifest_path}",
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail=f"Portal PMTiles manifest has no layer list: {manifest_path}")
    return payload, manifest_path


def portal_pmtiles_layer_manifest(
    state: BackendState,
    dataset_id: str,
) -> tuple[dict[str, Any], str, str]:
    normalized_dataset_id = dataset_id.strip().lower()
    for archive_id, source_layers in expected_portal_archive_layers(state).items():
        if normalized_dataset_id not in source_layers:
            continue
        archive_name = state.portal_layer_archives.get(archive_id, "")
        if not archive_name:
            raise HTTPException(status_code=503, detail=f"No PMTiles archive is configured for {dataset_id}.")
        payload, _manifest_path = portal_archive_manifest_payload(state, archive_name)
        layers = payload.get("layers")
        if not isinstance(layers, list):
            raise HTTPException(status_code=500, detail="Portal PMTiles manifest has no layer list.")
        layer = next(
            (
                item
                for item in layers
                if isinstance(item, dict)
                and str(item.get("id") or "").strip().lower() == normalized_dataset_id
            ),
            None,
        )
        if layer is None:
            raise HTTPException(
                status_code=503,
                detail=f"The active PMTiles manifest does not describe {dataset_id}.",
            )
        cached_archive = resolve_cached_file_info(archive_name)
        if cached_archive is not None:
            archive_version = cached_archive[1]
        else:
            archive = configured_pmtiles_path(state, archive_name)
            stat = archive.stat()
            archive_version = f"{stat.st_mtime_ns:x}-{stat.st_size:x}"
        return layer, archive_name, archive_version
    raise HTTPException(status_code=404, detail=f"PMTiles dataset is not registered: {dataset_id}")


def active_thematic_portal_archives(
    state: BackendState,
) -> tuple[dict[str, tuple[str, set[str]]], str]:
    configured = state.portal_layer_archives
    expected = expected_portal_archive_layers(state)
    if set(configured) != set(expected):
        return {}, "The thematic archive configuration is incomplete."
    active: dict[str, tuple[str, set[str]]] = {}
    for archive_id, expected_layers in expected.items():
        archive_name = configured[archive_id]
        archive_path = configured_pmtiles_path(state, archive_name, required=False)
        if not archive_path.is_file():
            return {}, f"The thematic archive {archive_name} has not been published."
        try:
            published_layers = portal_archive_source_layers(state, archive_name)
        except HTTPException as exc:
            return {}, str(exc.detail)
        if published_layers != expected_layers:
            missing = sorted(expected_layers - published_layers)
            unexpected = sorted(published_layers - expected_layers)
            details = []
            if missing:
                details.append(f"missing: {', '.join(missing)}")
            if unexpected:
                details.append(f"unexpected: {', '.join(unexpected)}")
            suffix = f" ({'; '.join(details)})" if details else ""
            return {}, f"The thematic archive {archive_name} failed its exact source-layer inventory check{suffix}."
        active[archive_id] = (archive_name, expected_layers)
    return active, ""


def route_resource_style(payload: dict[str, Any], state: BackendState) -> dict[str, Any]:
    sources = payload.get("sources")
    layers = payload.get("layers")
    if not isinstance(sources, dict) or not isinstance(layers, list):
        return payload

    expected_layers = expected_portal_source_layers(state)
    thematic_archives, thematic_error = active_thematic_portal_archives(state)
    if not thematic_archives:
        raise HTTPException(
            status_code=503,
            detail=f"Portal thematic PMTiles publication is unavailable: {thematic_error}",
        )
    source_for_layer: dict[str, str] = {}
    archive_metadata: list[dict[str, Any]] = []
    for archive_id, (archive_name, archive_layers) in thematic_archives.items():
        source_id = f"portal_layers_{archive_id}"
        sources[source_id] = {
            "type": "vector",
            "url": versioned_pmtiles_url(state, archive_name),
        }
        source_for_layer.update({layer: source_id for layer in archive_layers})
        archive_metadata.append(
            {"id": archive_id, "archive": archive_name, "source_layer_count": len(archive_layers)}
        )
    missing_source_layers = expected_layers - set(source_for_layer)
    legacy_source = sources.get(LEGACY_LAYER_SOURCE_ID)
    if isinstance(legacy_source, dict):
        legacy_source["url"] = versioned_pmtiles_url(state, state.legacy_map_archive)

    registered_archives = {
        state.legacy_map_archive,
        state.terrain_archive,
        *state.portal_layer_archives.values(),
    } - {""}
    for source in sources.values():
        if not isinstance(source, dict):
            continue
        source_url = str(source.get("url") or "")
        if not source_url.startswith("pmtiles://"):
            continue
        archive_reference = source_url.removeprefix("pmtiles://").split("?", 1)[0]
        archive_name = Path(archive_reference).name
        if archive_name in registered_archives:
            source["url"] = versioned_pmtiles_url(state, archive_name)

    routed_style_layers = 0
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        source_layer = str(layer.get("source-layer") or "").lower()
        routed_source = source_for_layer.get(source_layer)
        if layer.get("source") == LEGACY_LAYER_SOURCE_ID and routed_source:
            layer["source"] = routed_source
            routed_style_layers += 1

    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        payload["metadata"] = metadata
    metadata["portal_pmtiles"] = {
        "mode": "thematic",
        "archives": archive_metadata,
        "source_layer_count": len(source_for_layer),
        "style_layer_count": routed_style_layers,
        "missing_source_layers": sorted(missing_source_layers),
    }
    return payload


def versioned_pmtiles_url(state: BackendState, archive_name: str) -> str:
    cached = resolve_cached_file_info(archive_name)
    if cached is not None:
        _, version = cached
        return f"pmtiles://{archive_name}?v={version}" if version else f"pmtiles://{archive_name}"
    path = configured_pmtiles_path(state, archive_name, required=False)
    if not path.is_file():
        return f"pmtiles://{archive_name}"
    stat = path.stat()
    version = f"{stat.st_mtime_ns:x}-{stat.st_size:x}"
    return f"pmtiles://{archive_name}?v={version}"


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
        legacy_archive = configured_pmtiles_path(state, state.legacy_map_archive, required=False)
        terrain_archive = (
            configured_pmtiles_path(state, state.terrain_archive, required=False)
            if state.terrain_archive
            else None
        )
        expected_layers = expected_portal_source_layers(state)
        expected_archive_layers = expected_portal_archive_layers(state)
        configured_archives = state.portal_layer_archives
        archive_status: list[dict[str, Any]] = []
        published_layers: set[str] = set()
        for archive_id, expected in expected_archive_layers.items():
            archive_name = configured_archives.get(archive_id, "")
            archive_path = (
                configured_pmtiles_path(state, archive_name, required=False)
                if archive_name
                else None
            )
            actual: set[str] = set()
            validation_error = ""
            if archive_path is None:
                validation_error = "Archive is not configured."
            elif not archive_path.is_file():
                validation_error = "Archive has not been published."
            else:
                try:
                    actual = portal_archive_source_layers(state, archive_name)
                except HTTPException as exc:
                    validation_error = str(exc.detail)
            published_layers.update(actual)
            archive_status.append(
                {
                    "id": archive_id,
                    "archive": archive_name,
                    "path": str(archive_path) if archive_path is not None else "",
                    "exists": bool(archive_path and archive_path.is_file()),
                    "expected_source_layers": len(expected),
                    "published_source_layers": len(actual),
                    "missing_source_layers": sorted(expected - actual),
                    "unexpected_source_layers": sorted(actual - expected),
                    "validation_error": validation_error,
                }
            )
        thematic_archives, thematic_error = active_thematic_portal_archives(state)
        return {
            "ok": True,
            "project_root": str(state.project_root),
            "config": str(state.project_config.config_path),
            "manifest_exists": manifest_path.exists(),
            "maplibre_dir": str(state.maplibre_dir),
            "pmtiles": {
                "mode": "thematic",
                "thematic_ready": bool(thematic_archives),
                "thematic_validation_error": thematic_error,
                "archives": archive_status,
                "legacy_map": str(legacy_archive),
                "legacy_map_exists": legacy_archive.is_file(),
                "terrain": str(terrain_archive) if terrain_archive is not None else "",
                "terrain_exists": terrain_archive.is_file() if terrain_archive is not None else False,
                "expected_source_layers": len(expected_layers),
                "published_source_layers": len(published_layers),
                "missing_source_layers": sorted(expected_layers - published_layers),
            },
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
            if path.name.lower() == "style.json" and isinstance(payload, dict):
                payload = route_resource_style(payload, state)
            return no_cache_json(payload)
        return no_cache_file(path, media_type=media_type)

    @app.get("/api/pmtiles/{pmtiles_name:path}")
    def pmtiles_file(pmtiles_name: str, request: Request) -> Response:
        state = get_state()
        path = configured_pmtiles_path(state, pmtiles_name)
        stat = path.stat()
        etag = f'W/"{stat.st_size:x}-{stat.st_mtime_ns:x}"'
        cache_control = "public, max-age=31536000, immutable" if request.query.get("v") else "no-cache"
        return FileResponse(
            path,
            media_type="application/octet-stream",
            filename=path.name,
            headers={
                "Accept-Ranges": "bytes",
                "Cache-Control": cache_control,
                "ETag": etag,
                "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, ETag",
            },
        )

    @app.head("/api/pmtiles/{pmtiles_name:path}")
    def pmtiles_head(pmtiles_name: str) -> Response:
        state = get_state()
        path = configured_pmtiles_path(state, pmtiles_name)
        stat = path.stat()
        return Response(
            media_type="application/octet-stream",
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(stat.st_size),
                "ETag": f'W/"{stat.st_size:x}-{stat.st_mtime_ns:x}"',
                "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, ETag",
            },
        )

    @app.get("/api/map/feature-details")
    def map_feature_details(
        dataset_id: str = Query("", min_length=1, max_length=128),
        feature_id: str = Query("", min_length=1, max_length=256),
    ) -> dict[str, Any]:
        return query_pmtiles_feature_details(
            get_state(),
            dataset_id.strip().lower(),
            feature_id.strip(),
        )

    @app.get("/api/map/asset-assignment")
    def map_asset_assignment(
        asset_id: str = Query("", min_length=1, max_length=128),
    ) -> dict[str, Any]:
        normalized_asset_id = asset_id.strip()
        try:
            result = query_step401_assignment(normalized_asset_id)
        except HTTPException:
            return {
                "asset_id": normalized_asset_id,
                "status": "data_unavailable",
                "available": False,
            }
        return {
            "asset_id": normalized_asset_id,
            "status": binary_assignment_status(result),
            "available": True,
            "source_version": result.get("version") or "",
            "published_at": result.get("published_at"),
        }

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
                "database_exists": all(path.is_file() for path in asset_search_database_paths()),
                "results": [],
                "returned": 0,
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
        zoom: float | None = Query(None, ge=0, le=24),
        west: float | None = Query(None, ge=-180, le=180),
        south: float | None = Query(None, ge=-90, le=90),
        east: float | None = Query(None, ge=-180, le=180),
        north: float | None = Query(None, ge=-90, le=90),
        filters: str = Query("", max_length=ATTRIBUTE_FILTER_QUERY_MAX_LENGTH),
    ) -> dict[str, Any]:
        state = get_state()
        normalized_dataset_id = dataset_id.strip().lower()
        layer = configured_duckdb_geojson_layer_or_404(normalized_dataset_id)
        bbox = valid_request_bbox(west, south, east, north)
        database = Path(str(layer["database"]))
        if not database.is_file():
            return empty_geojson_response(
                normalized_dataset_id,
                database_exists=False,
                message=f"DuckDB database was not found: {database}",
            )
        return query_configured_duckdb_geojson_feature_collection(
            layer,
            bbox,
            limit,
            parse_attribute_filter_query(filters),
            zoom=zoom,
        )

    @app.post("/api/duckdb/geojson-batch")
    def duckdb_geojson_batch(payload: dict[str, Any]) -> dict[str, Any]:
        raw_bbox = payload.get("bbox")
        if not isinstance(raw_bbox, list) or len(raw_bbox) != 4:
            raise HTTPException(status_code=400, detail="DuckDB GeoJSON batch requires bbox with four coordinates.")
        try:
            bbox = valid_request_bbox(*(float(value) for value in raw_bbox))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="DuckDB GeoJSON batch bbox is invalid.") from exc
        raw_requests = payload.get("requests")
        if not isinstance(raw_requests, list) or not raw_requests:
            raise HTTPException(status_code=400, detail="DuckDB GeoJSON batch requires at least one dataset request.")
        if len(raw_requests) > 32:
            raise HTTPException(status_code=400, detail="DuckDB GeoJSON batch accepts at most 32 dataset requests.")
        raw_zoom = payload.get("zoom")
        zoom = float(raw_zoom) if isinstance(raw_zoom, (int, float)) else None
        requests: list[dict[str, Any]] = []
        for raw_request in raw_requests:
            if not isinstance(raw_request, dict):
                continue
            dataset_id = str(raw_request.get("dataset_id") or "").strip().lower()
            if not dataset_id:
                continue
            try:
                limit = max(1, min(DUCKDB_GEOJSON_FEATURE_LIMIT_MAX, int(raw_request.get("limit") or 25_000)))
            except (TypeError, ValueError):
                limit = 25_000
            raw_filters = raw_request.get("filters")
            serialized_filters = json.dumps(raw_filters, separators=(",", ":")) if isinstance(raw_filters, dict) else ""
            if len(serialized_filters) > ATTRIBUTE_FILTER_QUERY_MAX_LENGTH:
                raise HTTPException(status_code=400, detail=f"Attribute filters are too large for {dataset_id}.")
            requests.append(
                {
                    "dataset_id": dataset_id,
                    "limit": limit,
                    "filters": parse_attribute_filter_query(serialized_filters),
                }
            )
        if not requests:
            raise HTTPException(status_code=400, detail="DuckDB GeoJSON batch has no valid dataset requests.")
        return query_configured_duckdb_geojson_batch(requests, bbox, zoom)

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
        bbox = valid_request_bbox(west, south, east, north)
        layer_configs = selected_risk_layer_configs(cityworks_layer, itpipes_layer)
        return no_cache_json(query_risk_top_lists(risk, bbox, layer_configs, parse_attribute_filter_query(filters)))

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
        bbox = valid_request_bbox(west, south, east, north)
        layer_configs = selected_risk_layer_configs(cityworks_layer, itpipes_layer)
        return no_cache_json(query_risk_histograms(risk, bbox, layer_configs, parse_attribute_filter_query(filters)))

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
    configured_archive = state.terrain_archive
    configured_pmtiles = (
        configured_pmtiles_path(state, configured_archive, required=False)
        if configured_archive
        else pmtiles_output
    )
    return {
        "enabled": bool(terrain.get("enabled", False)),
        "id": terrain_id,
        "name": terrain.get("name", terrain_id),
        "source": terrain.get("source", ""),
        "tile_dir": project_relative(tile_dir, state.project_root),
        "tile_dir_exists": tile_dir.exists(),
        "tilejson": project_relative(tilejson, state.project_root),
        "tilejson_exists": tilejson.exists(),
        "pmtiles_archive": configured_archive,
        "pmtiles_output": project_relative(configured_pmtiles, state.project_root),
        "pmtiles_exists": configured_pmtiles.exists(),
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
    datasets_by_id = {
        str(dataset.get("id", "")).lower(): dataset
        for dataset in raw_datasets(state)
        if isinstance(dataset, dict)
    }
    connections: dict[Path, Any] = {}
    try:
        results: dict[str, dict[str, Any]] = {}
        for target in ASSET_SEARCH_TARGETS:
            dataset_id = str(target["dataset_id"])
            dataset = datasets_by_id.get(dataset_id.lower(), {})
            layer = asset_search_layer(target)
            database = Path(str(layer["database"]))
            connection = connections.get(database)
            if connection is None:
                connection = open_inventory_duckdb(layer)
                connections[database] = connection
            table_name = str(layer["table"])
            fields = duckdb_table_schema_fields(connection, table_name)
            if not fields:
                continue
            search_fields = search_fields_for_asset_target(target, dataset, fields)
            if not search_fields:
                continue
            per_field_limit = max(limit * 4, 20)
            for field in search_fields:
                for row in search_spatial_asset_field(
                    connection,
                    layer,
                    target,
                    field,
                    fields,
                    query,
                    per_field_limit,
                ):
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
        for connection in connections.values():
            connection.close()


def asset_search_layer(target: dict[str, Any]) -> dict[str, Any]:
    source = str(target.get("source") or "").lower()
    if source == "configured_layer":
        return configured_duckdb_geojson_layer_or_404(str(target["dataset_id"]))
    if source == "inventory":
        return {
            "id": str(target["dataset_id"]),
            "database": required_runtime_path("PORTAL_INVENTORY_DUCKDB", "inventory DuckDB"),
            "table": str(target["table"]),
            "geometryColumn": str(target.get("geometry_column") or "geometry"),
            "featureIdColumn": str(target.get("feature_id_column") or ""),
            "sourceSrid": 2264,
        }
    raise HTTPException(
        status_code=500,
        detail=f"Asset search source is not configured for {target.get('dataset_id', 'unknown dataset')}.",
    )


def asset_search_database_paths() -> set[Path]:
    return {Path(str(asset_search_layer(target)["database"])) for target in ASSET_SEARCH_TARGETS}


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


def configured_duckdb_geojson_layer_or_404(dataset_id: str) -> dict[str, Any]:
    try:
        layer = configured_map_duckdb_geojson_layers().get(dataset_id.lower())
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if layer:
        return layer
    raise HTTPException(status_code=404, detail=f"DuckDB GeoJSON dataset is not configured: {dataset_id}")


def query_configured_duckdb_geojson_feature_collection(
    layer: dict[str, Any],
    bbox: list[float] | None,
    limit: int,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
    *,
    zoom: float | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    connection_started = time.perf_counter()
    connection = open_inventory_duckdb(layer)
    connection_ms = (time.perf_counter() - connection_started) * 1000
    try:
        result = query_configured_duckdb_geojson_with_connection(
            connection,
            layer,
            bbox,
            limit,
            attribute_filters,
            zoom=zoom,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface DuckDB locks and schema issues through the API
        dataset_id = str(layer["id"])
        raise HTTPException(status_code=503, detail=f"Could not read DuckDB GeoJSON for {dataset_id}: {exc}") from exc
    finally:
        connection.close()
    result.setdefault("metadata", {})["connection_ms"] = round(connection_ms, 2)
    result["metadata"]["total_ms"] = round((time.perf_counter() - started) * 1000, 2)
    return result


def query_configured_duckdb_geojson_batch(
    requests: list[dict[str, Any]],
    bbox: list[float] | None,
    zoom: float | None,
) -> dict[str, Any]:
    started = time.perf_counter()
    grouped: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    results: dict[str, Any] = {}
    errors: dict[str, str] = {}
    for request in requests:
        dataset_id = str(request["dataset_id"])
        try:
            layer = configured_duckdb_geojson_layer_or_404(dataset_id)
        except HTTPException as exc:
            errors[dataset_id] = str(exc.detail)
            continue
        database = Path(str(layer["database"]))
        if not database.is_file():
            errors[dataset_id] = f"DuckDB database was not found: {database.name}"
            continue
        grouped.setdefault(str(database), []).append((request, layer))

    database_timings: dict[str, float] = {}
    for database_key, group in grouped.items():
        connection_started = time.perf_counter()
        connection = None
        try:
            connection = open_inventory_duckdb(group[0][1])
            database_timings[Path(database_key).name] = round(
                (time.perf_counter() - connection_started) * 1000,
                2,
            )
            for request, layer in group:
                dataset_id = str(request["dataset_id"])
                try:
                    results[dataset_id] = query_configured_duckdb_geojson_with_connection(
                        connection,
                        layer,
                        bbox,
                        int(request["limit"]),
                        request.get("filters"),
                        zoom=zoom,
                    )
                except Exception as exc:  # noqa: BLE001 - one bad layer must not discard the other batch results
                    errors[dataset_id] = str(exc)
        except Exception as exc:  # noqa: BLE001 - report one database failure for each requested dataset
            for request, _layer in group:
                errors[str(request["dataset_id"])] = str(exc)
        finally:
            if connection is not None:
                connection.close()

    return {
        "results": results,
        "errors": errors,
        "metadata": {
            "requested": len(requests),
            "returned": len(results),
            "database_count": len(grouped),
            "database_open_ms": database_timings,
            "total_ms": round((time.perf_counter() - started) * 1000, 2),
        },
    }


def query_configured_duckdb_geojson_with_connection(
    connection: Any,
    layer: dict[str, Any],
    bbox: list[float] | None,
    limit: int,
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
    *,
    zoom: float | None = None,
) -> dict[str, Any]:
    dataset_id = str(layer["id"])
    table_name = str(layer["table"])
    geometry_column = str(layer.get("geometryColumn") or "geometry")
    feature_id_column = str(layer.get("featureIdColumn") or "")
    source_srid = int(layer.get("sourceSrid") or 2264)
    if source_srid != 2264:
        raise HTTPException(
            status_code=500,
            detail=f"DuckDB GeoJSON dataset {dataset_id} uses unsupported source SRID {source_srid}.",
        )
    schema_started = time.perf_counter()
    try:
        schema_fields = duckdb_table_schema_fields(connection, table_name, Path(str(layer["database"])))
        fields_by_lower = {
            str(item["source_field"]).lower(): item
            for item in schema_fields
        }
        geometry_field = fields_by_lower.get(geometry_column.lower())
        if not geometry_field:
            raise RuntimeError(f"Geometry column {geometry_column!r} was not found in {table_name}.")
        geometry_column = str(geometry_field["source_field"])
        configured_properties = [str(item) for item in layer.get("properties", [])]
        missing_properties = [
            name for name in configured_properties if name.lower() not in fields_by_lower
        ]
        if missing_properties:
            raise RuntimeError(
                f"Configured properties were not found in {table_name}: {', '.join(missing_properties)}"
            )
        property_fields = [fields_by_lower[name.lower()] for name in configured_properties][:120]
        property_selects = [
            f"{quote_identifier(item['duckdb_column'])} AS {quote_identifier('__prop_' + str(index))}"
            for index, item in enumerate(property_fields)
        ]
        schema_ms = (time.perf_counter() - schema_started) * 1000
        extent_wkt = bbox_to_stateplane_wkt(bbox) if bbox else None
        prefer_spatial_index = direct_layer_prefers_spatial_index(layer, bbox, zoom)
        where_clause, params = duckdb_spatial_where_clause(
            geometry_column,
            extent_wkt,
            prefer_spatial_index=prefer_spatial_index,
        )
        filter_parts, filter_params = duckdb_attribute_filter_where_parts(
            attribute_filters,
            [dataset_id],
            property_fields,
        )
        if filter_parts:
            where_clause = " AND ".join([where_clause, *filter_parts])
        params.extend(filter_params)
        actual_feature_id = fields_by_lower.get(feature_id_column.lower()) if feature_id_column else None
        feature_id_expression = (
            f"COALESCE(CAST({quote_identifier(str(actual_feature_id['source_field']))} AS VARCHAR), "
            f"CAST(hash(ST_AsWKB({quote_identifier(geometry_column)})) AS VARCHAR))"
            if actual_feature_id
            else f"CAST(hash(ST_AsWKB({quote_identifier(geometry_column)})) AS VARCHAR)"
        )
        sql = f"""
            SELECT
                {feature_id_expression} AS __feature_id,
                ST_GeometryType({quote_identifier(geometry_column)}) AS __geometry_type,
                ST_AsGeoJSON(
                    ST_Transform(
                        {quote_identifier(geometry_column)},
                        'EPSG:2264',
                        'EPSG:4326',
                        always_xy := true
                    )
                ) AS __geometry_json
                {"," if property_selects else ""}
                {", ".join(property_selects)}
            FROM {quote_identifier(table_name)}
            WHERE {where_clause}
            LIMIT ?
        """
        params.append(int(limit) + 1)
        query_started = time.perf_counter()
        rows = connection.execute(sql, params).fetchall()
        query_ms = (time.perf_counter() - query_started) * 1000
        names = [item[0] for item in connection.description]
    except Exception as exc:  # noqa: BLE001 - add dataset context to DuckDB errors
        raise RuntimeError(f"Could not query {dataset_id}: {exc}") from exc

    truncated = len(rows) > int(limit)
    rows = rows[: int(limit)]
    serialization_started = time.perf_counter()
    prop_aliases = {f"__prop_{index}": field for index, field in enumerate(property_fields)}
    features = []
    for row in rows:
        values = dict(zip(names, row))
        geometry = parse_geometry_json(values.get("__geometry_json"))
        if not geometry:
            continue
        properties = {
            prop_aliases[key]["source_field"]: jsonable_value(value)
            for key, value in values.items()
            if key in prop_aliases and value not in (None, "")
        }
        feature_id = str(values.get("__feature_id") or "")
        properties["__feature_id"] = feature_id
        properties["__dataset_id"] = dataset_id
        properties["__geometry_type"] = values.get("__geometry_type") or ""
        features.append(
            {
                "type": "Feature",
                "id": feature_id,
                "geometry": geometry,
                "properties": properties,
            }
        )
    serialization_ms = (time.perf_counter() - serialization_started) * 1000

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "dataset_id": dataset_id,
            "database": Path(str(layer["database"])).name,
            "table": table_name,
            "source_srid": source_srid,
            "bbox": bbox,
            "returned": len(features),
            "limit": int(limit),
            "truncated": truncated,
            "property_count": len(property_fields),
            "spatial_plan": "rtree_eligible" if prefer_spatial_index else "sequential_preferred",
            "schema_ms": round(schema_ms, 2),
            "query_ms": round(query_ms, 2),
            "serialization_ms": round(serialization_ms, 2),
        },
    }


def direct_layer_prefers_spatial_index(
    layer: dict[str, Any],
    bbox: list[float] | None,
    zoom: float | None,
) -> bool:
    if not bbox:
        return False
    minimum_zoom = float(layer.get("spatialIndexMinZoom") or 13)
    if zoom is not None:
        return zoom >= minimum_zoom
    west, south, east, north = bbox
    maximum_span = float(layer.get("spatialIndexMaxExtentDegrees") or 0.08)
    return max(east - west, north - south) <= maximum_span


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


def configured_risk_source_layer(dataset_id: str) -> dict[str, Any]:
    try:
        layer = configured_map_duckdb_geojson_layers().get(dataset_id.lower())
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not layer:
        raise HTTPException(
            status_code=503,
            detail=f"Risk dataset is not configured as a direct DuckDB source: {dataset_id}",
        )
    return layer


def risk_source_schema(
    connection: Any,
    source_layer: dict[str, Any],
) -> tuple[str, list[dict[str, str]], dict[str, dict[str, str]], str]:
    table_name = str(source_layer["table"])
    fields = duckdb_table_schema_fields(connection, table_name)
    if not fields:
        raise RuntimeError(f"Configured risk table was not found: {table_name}")
    fields_by_normalized = {
        normalize_token(field["source_field"]): field
        for field in fields
    }
    geometry_name = str(source_layer.get("geometryColumn") or "geometry")
    geometry_field = fields_by_normalized.get(normalize_token(geometry_name))
    if not geometry_field:
        raise RuntimeError(f"Geometry column {geometry_name!r} was not found in {table_name}")
    geometry_column = str(geometry_field["duckdb_column"])
    property_fields = [
        field
        for field in fields
        if normalize_token(field["source_field"]) != normalize_token(geometry_column)
    ]
    return table_name, property_fields, fields_by_normalized, geometry_column


def risk_feature_id_expression(
    fields_by_normalized: dict[str, dict[str, str]],
    source_layer: dict[str, Any],
    geometry_column: str,
) -> str:
    geometry_sql = quote_identifier(geometry_column)
    feature_id_name = str(source_layer.get("featureIdColumn") or "")
    feature_id_field = fields_by_normalized.get(normalize_token(feature_id_name))
    fallback = f"CAST(hash(ST_AsWKB({geometry_sql})) % 9007199254740991 AS BIGINT)"
    if not feature_id_field:
        return fallback
    return (
        f"COALESCE(TRY_CAST({quote_identifier(feature_id_field['duckdb_column'])} AS BIGINT), {fallback})"
    )


def risk_property_fields(
    layer_config: dict[str, Any],
    risk_field: str,
    fields: list[dict[str, str]],
    fields_by_normalized: dict[str, dict[str, str]],
) -> list[dict[str, str]]:
    selected: list[dict[str, str]] = []
    requested_names = [*layer_config.get("display_fields", []), risk_field]
    for field_name in requested_names:
        field = fields_by_normalized.get(normalize_token(str(field_name)))
        if field and field not in selected:
            selected.append(field)
    for field in fields:
        if field not in selected and len(selected) < 40:
            selected.append(field)
    return selected[:40]


def risk_source_where_clause(
    layer_config: dict[str, Any],
    source_layer: dict[str, Any],
    geometry_column: str,
    fields: list[dict[str, str]],
    bbox: list[float] | None,
    attribute_filters: dict[str, list[dict[str, Any]]] | None,
) -> tuple[str, list[Any]]:
    extent_wkt = bbox_to_stateplane_wkt(bbox) if bbox else None
    where_clause, params = duckdb_spatial_where_clause(geometry_column, extent_wkt)
    filter_parts, filter_params = duckdb_attribute_filter_where_parts(
        attribute_filters,
        risk_filter_target_keys(layer_config),
        fields,
    )
    if filter_parts:
        where_clause = " AND ".join([where_clause, *filter_parts])
        params.extend(filter_params)
    return where_clause, params


def query_risk_top_lists(
    risk: str,
    bbox: list[float] | None,
    layer_configs: list[dict[str, Any]],
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    risk_field = RISK_SCORE_FIELDS[risk]
    lists: list[dict[str, Any]] = []
    for config in layer_configs:
        source_layer = configured_risk_source_layer(str(config["dataset_id"]))
        connection = open_configured_duckdb(source_layer, "Risk source DuckDB")
        try:
            lists.append(
                query_risk_top_list_layer(
                    connection,
                    config,
                    risk_field,
                    bbox,
                    attribute_filters,
                    source_layer=source_layer,
                )
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - surface source schema/query issues through the API
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Could not read risk top list from {source_layer['database']}"
                    f"::{source_layer['table']}: {exc}"
                ),
            ) from exc
        finally:
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
    risk: str,
    bbox: list[float] | None,
    layer_configs: list[dict[str, Any]],
    attribute_filters: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    risk_field = RISK_SCORE_FIELDS[risk]
    histograms: list[dict[str, Any]] = []
    for config in layer_configs:
        source_layer = configured_risk_source_layer(str(config["dataset_id"]))
        connection = open_configured_duckdb(source_layer, "Risk source DuckDB")
        try:
            histograms.append(
                query_risk_histogram_layer(
                    connection,
                    config,
                    risk_field,
                    bbox,
                    attribute_filters,
                    source_layer=source_layer,
                )
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - surface source schema/query issues through the API
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Could not read risk histogram from {source_layer['database']}"
                    f"::{source_layer['table']}: {exc}"
                ),
            ) from exc
        finally:
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
    *,
    source_layer: dict[str, Any] | None = None,
) -> dict[str, Any]:
    dataset_id = str(layer_config["dataset_id"])
    source_layer = source_layer or configured_risk_source_layer(dataset_id)
    table_name, fields, fields_by_normalized, geometry_column = risk_source_schema(connection, source_layer)
    empty_bins = risk_histogram_bins_from_counts([0] * len(RISK_HISTOGRAM_BINS))
    risk_column = field_column_for_source_field(fields_by_normalized, risk_field)
    if not risk_column:
        return risk_histogram_response(layer_config, risk_field, empty_bins, 0, 0)

    risk_expression = f"TRY_CAST({quote_identifier(risk_column)} AS DOUBLE)"
    where_clause, params = risk_source_where_clause(
        layer_config,
        source_layer,
        geometry_column,
        fields,
        bbox,
        attribute_filters,
    )
    where_clause = f"{where_clause} AND {risk_expression} IS NOT NULL"

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
            WHERE {where_clause}
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
    *,
    source_layer: dict[str, Any] | None = None,
) -> dict[str, Any]:
    dataset_id = str(layer_config["dataset_id"])
    source_layer = source_layer or configured_risk_source_layer(dataset_id)
    table_name, fields, fields_by_normalized, geometry_column = risk_source_schema(connection, source_layer)
    risk_column = field_column_for_source_field(fields_by_normalized, risk_field)
    if not risk_column:
        return risk_top_list_response(layer_config, risk_field, [])
    grade_column = field_column_for_source_field(fields_by_normalized, "Grade")

    selected_fields = risk_property_fields(layer_config, risk_field, fields, fields_by_normalized)

    property_selects = [
        f"{quote_identifier(item['duckdb_column'])} AS {quote_identifier('__prop_' + str(index))}"
        for index, item in enumerate(selected_fields)
    ]
    risk_expression = f"TRY_CAST({quote_identifier(risk_column)} AS DOUBLE)"
    where_clause, params = risk_source_where_clause(
        layer_config,
        source_layer,
        geometry_column,
        fields,
        bbox,
        attribute_filters,
    )
    where_clause = f"{where_clause} AND {risk_expression} IS NOT NULL"
    grade_filter = layer_config.get("grade_filter")
    if grade_filter is not None and grade_column:
        where_clause = " AND ".join(
            [where_clause, f"TRY_CAST({quote_identifier(grade_column)} AS DOUBLE) = ?"]
        )
        params.append(float(grade_filter))

    sql = f"""
        SELECT
            {risk_feature_id_expression(fields_by_normalized, source_layer, geometry_column)} AS __feature_id,
            ST_GeometryType({quote_identifier(geometry_column)}) AS __geometry_type,
            ST_AsWKB({quote_identifier(geometry_column)}) AS __geometry_wkb,
            {risk_expression} AS __risk_score
            {"," if property_selects else ""}
            {", ".join(property_selects)}
        FROM {quote_identifier(table_name)}
        WHERE {where_clause}
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
        geometry = stateplane_wkb_to_wgs84_geojson(values.get("__geometry_wkb"))
        bbox_values = geojson_geometry_bbox(geometry) if geometry else None
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
        data_type = str(field.get("data_type", ""))
        native_numeric = is_native_duckdb_numeric_type(data_type)
        native_temporal = is_native_duckdb_temporal_type(data_type)
        native_text = is_native_duckdb_text_type(data_type)
        text_expression = column if native_text else f"CAST({column} AS VARCHAR)"
        lower_expression = f"lower({text_expression})"

        if operator == "eq":
            if field_type == "number":
                try:
                    numeric_value = float(value)
                except ValueError:
                    continue
                parts.append(f"{column} = ?" if native_numeric else f"TRY_CAST({column} AS DOUBLE) = ?")
                params.append(numeric_value)
            elif field_type == "date":
                parts.append(
                    f"{column} = TRY_CAST(? AS {duckdb_temporal_comparison_type(data_type)})"
                    if native_temporal
                    else f"TRY_CAST({column} AS DATE) = TRY_CAST(? AS DATE)"
                )
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
                numeric_expression = column if native_numeric else f"TRY_CAST({column} AS DOUBLE)"
                parts.append(f"({column} IS NULL OR {numeric_expression} <> ?)")
                params.append(numeric_value)
            elif field_type == "date":
                date_expression = column if native_temporal else f"TRY_CAST({column} AS DATE)"
                parts.append(
                    f"({column} IS NULL OR {date_expression} <> "
                    f"TRY_CAST(? AS {duckdb_temporal_comparison_type(data_type)}))"
                )
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
                date_expression = column if native_temporal else f"TRY_CAST({column} AS TIMESTAMP)"
                parts.append(
                    f"{date_expression} {comparator} "
                    f"TRY_CAST(? AS {duckdb_temporal_comparison_type(data_type)})"
                )
                params.append(value)
            elif field_type == "number":
                try:
                    numeric_value = float(value)
                except ValueError:
                    continue
                numeric_expression = column if native_numeric else f"TRY_CAST({column} AS DOUBLE)"
                parts.append(f"{numeric_expression} {comparator} ?")
                params.append(numeric_value)
            else:
                continue
        elif operator == "is_null":
            parts.append(f"({column} IS NULL OR {text_expression} = '')" if field_type == "text" else f"{column} IS NULL")
        elif operator == "is_not_null":
            parts.append(
                f"({column} IS NOT NULL AND {text_expression} <> '')"
                if field_type == "text"
                else f"{column} IS NOT NULL"
            )

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
    try:
        configured_layer = configured_map_duckdb_geojson_layers().get(dataset_id.lower())
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if configured_layer:
        connection = open_inventory_duckdb(configured_layer)
        try:
            table_name = str(configured_layer["table"])
            schema_fields = duckdb_table_schema_fields(connection, table_name)
            fields = [
                field
                for field in schema_fields
                if normalize_token(field["source_field"])
                != normalize_token(str(configured_layer.get("geometryColumn") or "geometry"))
            ]
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


def is_native_duckdb_numeric_type(data_type: str) -> bool:
    normalized = data_type.strip().upper()
    return any(
        token in normalized
        for token in (
            "TINYINT",
            "SMALLINT",
            "INTEGER",
            "BIGINT",
            "HUGEINT",
            "UTINYINT",
            "USMALLINT",
            "UINTEGER",
            "UBIGINT",
            "FLOAT",
            "DOUBLE",
            "DECIMAL",
            "NUMERIC",
            "REAL",
        )
    )


def is_native_duckdb_temporal_type(data_type: str) -> bool:
    normalized = data_type.strip().upper()
    return normalized.startswith("DATE") or normalized.startswith("TIME") or normalized.startswith("TIMESTAMP")


def is_native_duckdb_text_type(data_type: str) -> bool:
    normalized = data_type.strip().upper()
    return any(token in normalized for token in ("VARCHAR", "CHAR", "TEXT", "STRING", "UUID"))


def duckdb_temporal_comparison_type(data_type: str) -> str:
    normalized = data_type.strip().upper()
    return "DATE" if normalized.startswith("DATE") else "TIMESTAMP"


def open_configured_duckdb(layer: dict[str, Any], label: str = "Configured DuckDB") -> Any:
    try:
        import duckdb
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="The bundled Python runtime must include duckdb.") from exc

    path = Path(str(layer["database"]))
    if not path.exists():
        raise HTTPException(status_code=503, detail=f"{label} file was not found: {path}")
    connection = None
    try:
        connection = duckdb.connect(str(path), read_only=True)
        load_spatial_extension(connection)
        return connection
    except Exception as exc:  # noqa: BLE001 - surface DuckDB locks and extension errors through API
        if connection is not None:
            connection.close()
        raise HTTPException(status_code=503, detail=f"Could not open {label} {path}: {exc}") from exc


def query_pmtiles_feature_details(
    state: BackendState,
    dataset_id: str,
    feature_id: str,
) -> dict[str, Any]:
    started = time.perf_counter()
    layer_manifest, archive_name, archive_version = portal_pmtiles_layer_manifest(
        state,
        dataset_id,
    )
    detail_sources = configured_pmtiles_detail_sources()
    manifest_source_id = str(layer_manifest.get("sourceId") or "").strip().lower()
    detail_source = detail_sources.get(manifest_source_id) if manifest_source_id else None
    if detail_source is None:
        manifest_database_name = Path(str(layer_manifest.get("database") or "")).name.casefold()
        matching_sources = [
            source
            for source in detail_sources.values()
            if manifest_database_name
            and str(source.get("databaseFileName") or "").casefold() == manifest_database_name
        ]
        detail_source = matching_sources[0] if len(matching_sources) == 1 else None
    if detail_source is None:
        raise HTTPException(
            status_code=503,
            detail=f"No local DuckDB detail source is registered for PMTiles layer {dataset_id}.",
        )

    table_name = str(layer_manifest.get("table") or "").strip()
    if not table_name:
        raise HTTPException(
            status_code=503,
            detail=f"The active PMTiles manifest does not identify the source table for {dataset_id}.",
        )
    relation = quote_qualified_identifier(table_name)
    database = Path(str(detail_source["database"]))
    connection = open_configured_duckdb(
        {"database": str(database)},
        "PMTiles feature-detail DuckDB",
    )
    try:
        try:
            described = connection.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Could not inspect the source table for {dataset_id}: {exc}",
            ) from exc
        fields = [(str(row[0]), str(row[1])) for row in described]
        fields_by_lower = {name.casefold(): (name, data_type) for name, data_type in fields}
        configured_geometry = str(layer_manifest.get("geometryColumn") or "").strip()
        geometry_field = fields_by_lower.get(configured_geometry.casefold()) if configured_geometry else None
        if geometry_field is None:
            geometry_field = next(
                ((name, data_type) for name, data_type in fields if duckdb_type_is_geometry(data_type)),
                None,
            )
        geometry_columns = {
            name.casefold()
            for name, data_type in fields
            if duckdb_type_is_geometry(data_type)
        }
        if geometry_field is not None:
            geometry_columns.add(geometry_field[0].casefold())

        source_feature_id_column = str(layer_manifest.get("sourceFeatureIdColumn") or "").strip()
        feature_id_strategy = str(layer_manifest.get("featureIdStrategy") or "").strip()
        try:
            numeric_feature_id = int(feature_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="The selected PMTiles feature ID is invalid.") from exc

        if source_feature_id_column:
            source_feature_field = fields_by_lower.get(source_feature_id_column.casefold())
            if source_feature_field is None:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        f"The source feature-ID column {source_feature_id_column} was not found "
                        f"for {dataset_id}."
                    ),
                )
            predicate = f"{quote_identifier(source_feature_field[0])} = ?"
            parameters: list[Any] = [numeric_feature_id]
        elif feature_id_strategy == "generated_hash":
            if geometry_field is None:
                raise HTTPException(
                    status_code=503,
                    detail=f"The generated feature ID for {dataset_id} cannot be resolved without geometry.",
                )
            raw_hash_columns = layer_manifest.get("featureHashColumns")
            hash_column_names = (
                [str(name) for name in raw_hash_columns if isinstance(name, str)]
                if isinstance(raw_hash_columns, list)
                else sorted(
                    name
                    for name, _data_type in fields
                    if name.casefold() not in geometry_columns
                )
            )
            resolved_hash_columns = []
            for name in hash_column_names:
                field = fields_by_lower.get(name.casefold())
                if field is None:
                    raise HTTPException(
                        status_code=503,
                        detail=f"A generated feature-ID field is missing for {dataset_id}: {name}",
                    )
                resolved_hash_columns.append(field[0])
            hash_inputs = [quote_identifier(name) for name in resolved_hash_columns]
            hash_inputs.append(f"ST_AsWKB({quote_identifier(geometry_field[0])})")
            generated_id = (
                f"CAST(hash({', '.join(hash_inputs)}) & 9223372036854775807 AS BIGINT)"
            )
            predicate = f"{generated_id} = ?"
            parameters = [numeric_feature_id]
        else:
            raise HTTPException(
                status_code=503,
                detail=f"The active PMTiles manifest has no queryable feature-ID strategy for {dataset_id}.",
            )

        selected_fields = [
            (name, data_type)
            for name, data_type in fields
            if name.casefold() not in geometry_columns and not duckdb_type_is_binary(data_type)
        ]
        select_parts = [quote_identifier(name) for name, _data_type in selected_fields]
        if geometry_field is not None:
            select_parts.append(
                f"ST_GeometryType({quote_identifier(geometry_field[0])}) AS __portal_geometry_type"
            )
        if not select_parts:
            select_parts.append("1 AS __portal_present")
        rows = connection.execute(
            f"SELECT {', '.join(select_parts)} FROM {relation} WHERE {predicate} LIMIT 2",
            parameters,
        ).fetchall()
        if not rows:
            raise HTTPException(
                status_code=404,
                detail=f"Feature {feature_id} was not found in the active DuckDB source for {dataset_id}.",
            )
        if len(rows) > 1:
            raise HTTPException(
                status_code=409,
                detail=f"Feature ID {feature_id} is not unique in the active DuckDB source for {dataset_id}.",
            )
        row_values = dict(zip([item[0] for item in connection.description], rows[0]))
        detail_fields = []
        for name, data_type in fields:
            if name.casefold() in geometry_columns:
                continue
            binary = duckdb_type_is_binary(data_type)
            detail_fields.append(
                {
                    "name": name,
                    "data_type": data_type,
                    "value": None if binary else jsonable_detail_value(row_values.get(name)),
                    "binary_omitted": binary,
                }
            )
        return {
            "ok": True,
            "dataset_id": dataset_id,
            "feature_id": feature_id,
            "archive": archive_name,
            "archive_version": archive_version,
            "source_id": str(detail_source["databaseSourceId"]),
            "table": table_name,
            "feature_id_strategy": feature_id_strategy,
            "geometry": {
                "column": geometry_field[0] if geometry_field else "",
                "type": str(row_values.get("__portal_geometry_type") or ""),
            },
            "fields": detail_fields,
            "field_count": len(detail_fields),
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface source lookup failures through the resource API
        raise HTTPException(
            status_code=503,
            detail=f"Could not load full feature details for {dataset_id}: {exc}",
        ) from exc
    finally:
        connection.close()


def quote_qualified_identifier(identifier: str) -> str:
    parts = [part.strip() for part in identifier.split(".")]
    if not parts or len(parts) > 3 or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", part) for part in parts):
        raise HTTPException(status_code=500, detail=f"Configured DuckDB table name is invalid: {identifier}")
    return ".".join(quote_identifier(part) for part in parts)


def duckdb_type_is_geometry(data_type: str) -> bool:
    return str(data_type).strip().upper().startswith("GEOMETRY")


def duckdb_type_is_binary(data_type: str) -> bool:
    normalized = str(data_type).strip().upper()
    return normalized.startswith("BLOB") or normalized.startswith("BITSTRING")


def jsonable_detail_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [jsonable_detail_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): jsonable_detail_value(item) for key, item in value.items()}
    return str(value)


def open_inventory_duckdb(layer: dict[str, Any]) -> Any:
    return open_configured_duckdb(layer, "Inventory DuckDB")


def duckdb_database_signature(database_path: Path) -> str:
    path = database_path.resolve(strict=False)
    try:
        stat = path.stat()
    except OSError:
        return f"{path}:missing"
    return f"{path}:{stat.st_size}:{stat.st_mtime_ns}"


def duckdb_table_columns(
    connection: Any,
    table_name: str,
    database_path: Path | None = None,
) -> list[str]:
    cache_key = (
        f"duckdb-columns:{duckdb_database_signature(database_path)}:{table_name}".lower()
        if database_path is not None
        else ""
    )
    if cache_key and cache_key in _table_columns_cache:
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
    if cache_key:
        if len(_table_columns_cache) >= 512:
            _table_columns_cache.clear()
        _table_columns_cache[cache_key] = columns
    return columns


def duckdb_table_schema_fields(
    connection: Any,
    table_name: str,
    database_path: Path | None = None,
) -> list[dict[str, str]]:
    cache_key = (
        f"duckdb-schema:{duckdb_database_signature(database_path)}:{table_name}".lower()
        if database_path is not None
        else ""
    )
    if cache_key and cache_key in _duckdb_schema_cache:
        return _duckdb_schema_cache[cache_key]
    rows = connection.execute(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE lower(table_name) = lower(?)
        ORDER BY ordinal_position
        """,
        [table_name],
    ).fetchall()
    fields = [
        {
            "source_field": str(column_name),
            "duckdb_column": str(column_name),
            "data_type": str(data_type),
        }
        for column_name, data_type in rows
    ]
    if cache_key:
        if len(_duckdb_schema_cache) >= 512:
            _duckdb_schema_cache.clear()
        _duckdb_schema_cache[cache_key] = fields
    return fields


def duckdb_spatial_where_clause(
    geometry_column: str,
    extent_wkt: str | None,
    *,
    prefer_spatial_index: bool = False,
) -> tuple[str, list[Any]]:
    geometry = quote_identifier(geometry_column)
    if not extent_wkt:
        return f"{geometry} IS NOT NULL", []
    intersects = f"ST_Intersects({geometry}, ST_GeomFromText(?))"
    if prefer_spatial_index:
        return intersects, [extent_wkt]
    return f"{geometry} IS NOT NULL AND {intersects}", [extent_wkt]


def duckdb_length_miles_expression(connection: Any, layer: dict[str, Any]) -> str:
    table_name = str(layer["table"])
    database_path = Path(str(layer["database"])) if layer.get("database") else None
    columns = duckdb_table_columns(connection, table_name, database_path)
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


def search_spatial_asset_field(
    connection: Any,
    layer: dict[str, Any],
    target: dict[str, Any],
    field: dict[str, str],
    all_fields: list[dict[str, str]],
    query: str,
    limit: int,
) -> list[dict[str, Any]]:
    table_name = str(layer["table"])
    fields_by_normalized = {
        normalize_token(item["source_field"]): item
        for item in all_fields
    }
    geometry_field = fields_by_normalized.get(normalize_token(str(layer.get("geometryColumn") or "geometry")))
    if not geometry_field:
        raise HTTPException(
            status_code=503,
            detail=f"Geometry column was not found for asset search table {table_name}.",
        )
    geometry_column = quote_identifier(geometry_field["duckdb_column"])
    feature_id_field = fields_by_normalized.get(
        normalize_token(str(layer.get("featureIdColumn") or ""))
    )
    feature_id_sql = (
        f"COALESCE(TRY_CAST({quote_identifier(feature_id_field['duckdb_column'])} AS BIGINT), "
        f"CAST(hash(ST_AsWKB({geometry_column})) % 9007199254740991 AS BIGINT))"
        if feature_id_field
        else f"CAST(hash(ST_AsWKB({geometry_column})) % 9007199254740991 AS BIGINT)"
    )

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
    where_sql = f"{column} IS NOT NULL AND {geometry_column} IS NOT NULL AND ({' OR '.join(match_parts)})"

    configured_properties = [str(item) for item in layer.get("properties", [])]
    if configured_properties:
        property_fields = [
            fields_by_normalized[normalize_token(name)]
            for name in configured_properties
            if normalize_token(name) in fields_by_normalized
        ][:80]
    else:
        property_fields = search_fields_for_asset_target(target, {}, all_fields)
        for name in ("PIPE_ID", "NODE_ID", "CHAN_ID", "Location"):
            item = fields_by_normalized.get(normalize_token(name))
            if item and item not in property_fields:
                property_fields.append(item)
        property_fields = property_fields[:80]
    property_selects = [
        f"{quote_identifier(item['duckdb_column'])} AS {quote_identifier('__prop_' + str(index))}"
        for index, item in enumerate(property_fields)
    ]
    sql = f"""
        SELECT
            {feature_id_sql} AS __feature_id,
            ST_GeometryType({geometry_column}) AS __geometry_type,
            ST_AsWKB({geometry_column}) AS __geometry_wkb,
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
    prop_aliases = {f"__prop_{index}": item for index, item in enumerate(property_fields)}
    for row in rows:
        values = dict(zip(names, row))
        properties = {
            prop_aliases[key]["source_field"]: jsonable_value(value)
            for key, value in values.items()
            if key in prop_aliases and value not in (None, "")
        }
        geometry = stateplane_wkb_to_wgs84_geojson(values.get("__geometry_wkb"))
        if not geometry:
            continue
        dataset_id = str(target["dataset_id"])
        match_value = "" if values.get("__match_value") is None else str(values.get("__match_value"))
        display_value = primary_display_value(target, properties) or match_value
        target_label = str(target.get("label", dataset_id))
        feature_id = int(values.get("__feature_id") or 0)
        results.append(
            {
                "id": f"{dataset_id}:{feature_id}:{normalize_token(field['source_field'])}",
                "feature_id": feature_id,
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
                "bbox": geojson_geometry_bbox(geometry),
                "properties": properties,
            }
        )
    return results


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


def geojson_geometry_bbox(geometry: dict[str, Any]) -> list[float] | None:
    points: list[tuple[float, float]] = []

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            if value.get("type") == "GeometryCollection":
                collect(value.get("geometries"))
            else:
                collect(value.get("coordinates"))
            return
        if not isinstance(value, (list, tuple)):
            return
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            points.append((float(value[0]), float(value[1])))
            return
        for item in value:
            collect(item)

    collect(geometry)
    if not points:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return valid_bbox([min(xs), min(ys), max(xs), max(ys)])


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
