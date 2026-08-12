from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

_TOKEN = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")

_AIF_SOURCE_ENVIRONMENT_KEYS = frozenset(
    {
        "PORTAL_AIF_ITPIPES_INTERMEDIATE_DATABASE",
        "PORTAL_AIF_CITYWORKS_INTERMEDIATE_DATABASE",
        "PORTAL_AIF_ITPIPES_PRODUCTION_DATABASE",
        "PORTAL_AIF_ITPIPES_DEFECTS_TABLE",
        "PORTAL_AIF_ITPIPES_MAXIMUM_CONDITION_TABLE",
        "PORTAL_AIF_CITYWORKS_HISTORY_TABLE",
        "PORTAL_AIF_ITPIPES_INSPECTION_TABLE",
        "PORTAL_AIF_ITPIPES_OBSERVATION_TABLE",
    }
)

_MAP_SOURCE_ENVIRONMENT_KEYS = frozenset(
    {
        "PORTAL_MAP_PMTILES_ROOT",
        "PORTAL_MAP_LEGACY_PMTILES_ROOT",
        "PORTAL_MAP_LEGACY_ARCHIVE",
        "PORTAL_MAP_CONFIG_FILE",
        "PORTAL_MAP_TERRAIN_ROOT",
        "PORTAL_MAP_TERRAIN_ARCHIVE",
        "PORTAL_MAP_REPORTS_ROOT",
    }
)


def desktop_config_path() -> Path:
    configured = os.getenv("PORTAL_CONFIG_FILE", "").strip()
    if not configured:
        raise RuntimeError("PORTAL_CONFIG_FILE was not provided by the Portal desktop host.")
    return Path(configured).expanduser()


def _expand(value: str) -> str:
    return _TOKEN.sub(lambda match: os.getenv(match.group(1), match.group(0)), value)


def _expanded(value: Any) -> Any:
    if isinstance(value, str):
        return _expand(value)
    if isinstance(value, list):
        return [_expanded(item) for item in value]
    if isinstance(value, dict):
        return {key: _expanded(item) for key, item in value.items()}
    return value


@lru_cache(maxsize=1)
def load_desktop_config() -> dict[str, Any]:
    path = desktop_config_path()
    if not path.is_file():
        raise RuntimeError(f"Portal settings file was not found: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Portal settings file is invalid: {path}: {error}") from error
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        raise RuntimeError(f"Portal settings file has an unsupported schema: {path}")
    payload = _expanded(payload)
    shared_data_root = os.getenv(
        "PORTAL_SHARED_DATA_ROOT",
        _value(payload, "shared", "dataRoot"),
    ).strip()
    if shared_data_root:
        os.environ.setdefault("PORTAL_SHARED_DATA_ROOT", shared_data_root)
        payload = _expanded(payload)
    business_network_root = os.getenv(
        "PORTAL_BUSINESS_NETWORK_ROOT",
        _value(payload, "businessSync", "networkRoot"),
    ).strip()
    if business_network_root:
        os.environ.setdefault("PORTAL_BUSINESS_NETWORK_ROOT", business_network_root)
        payload = _expanded(payload)
    return payload


def _value(config: dict[str, Any], *keys: str) -> str:
    current: Any = config
    for key in keys:
        current = current.get(key) if isinstance(current, dict) else None
    return str(current or "").strip()


def configured_map_duckdb_geojson_layers() -> dict[str, dict[str, Any]]:
    config = load_desktop_config()
    maps = config.get("maps")
    raw_layers = maps.get("duckdbGeoJsonLayers") if isinstance(maps, dict) else None
    if not isinstance(raw_layers, list):
        raise RuntimeError("maps.duckdbGeoJsonLayers must be a list in portal.settings.json.")

    configured: dict[str, dict[str, Any]] = {}
    for index, raw_layer in enumerate(raw_layers):
        if not isinstance(raw_layer, dict):
            raise RuntimeError(f"maps.duckdbGeoJsonLayers[{index}] must be an object.")
        layer = dict(raw_layer)
        layer_id = str(layer.get("id") or "").strip().lower()
        database = str(layer.get("database") or "").strip()
        table = str(layer.get("table") or "").strip()
        if not layer_id or not database or not table:
            raise RuntimeError(
                f"maps.duckdbGeoJsonLayers[{index}] must define id, database, and table."
            )
        if layer_id in configured:
            raise RuntimeError(f"Duplicate DuckDB GeoJSON layer id: {layer_id}")
        properties = layer.get("properties", [])
        if not isinstance(properties, list) or not all(
            isinstance(item, str) and item.strip() for item in properties
        ):
            raise RuntimeError(f"DuckDB GeoJSON layer {layer_id} has invalid properties.")
        layer["id"] = layer_id
        layer["database"] = database
        layer["table"] = table
        layer["geometryColumn"] = str(layer.get("geometryColumn") or "geometry").strip()
        layer["featureIdColumn"] = str(layer.get("featureIdColumn") or "").strip()
        layer["properties"] = [str(item).strip() for item in properties]
        try:
            layer["sourceSrid"] = int(layer.get("sourceSrid") or 2264)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"DuckDB GeoJSON layer {layer_id} has an invalid sourceSrid.") from exc
        configured[layer_id] = layer
    return configured


def configure_environment() -> dict[str, Any]:
    config = load_desktop_config()
    mappings = {
        "PORTAL_SYSTEM_DB": _value(config, "system", "database"),
        "PORTAL_BUSINESS_DB": _value(config, "business", "database"),
        "PORTAL_AMTEAM_DUCKDB": _value(config, "risk", "databases", "assetRisk"),
        "PORTAL_INVENTORY_DUCKDB": _value(config, "risk", "databases", "inventory"),
        "PORTAL_CITY_PIPES_DUCKDB": _value(config, "risk", "databases", "cityPipes"),
        "PORTAL_SOURCES_MANIFEST": _value(config, "dataSources", "portalSources", "manifest"),
        "PORTAL_ITPIPES_DUCKDB": _value(config, "dataSources", "itpipes", "database"),
        "PORTAL_ITPIPES_MERGED_DUCKDB": _value(config, "dataSources", "itpipesMerged", "database"),
        "PORTAL_AIF_ITPIPES_INTERMEDIATE_DATABASE": _value(config, "aifSources", "itpipesIntermediateDatabase"),
        "PORTAL_AIF_CITYWORKS_INTERMEDIATE_DATABASE": _value(config, "aifSources", "cityworksIntermediateDatabase"),
        "PORTAL_AIF_ITPIPES_PRODUCTION_DATABASE": _value(config, "aifSources", "itpipesProductionDatabase"),
        "PORTAL_AIF_ITPIPES_DEFECTS_TABLE": _value(config, "aifSources", "itpipesDefectsTable"),
        "PORTAL_AIF_ITPIPES_MAXIMUM_CONDITION_TABLE": _value(config, "aifSources", "itpipesMaximumConditionTable"),
        "PORTAL_AIF_CITYWORKS_HISTORY_TABLE": _value(config, "aifSources", "cityworksInspectionHistoryTable"),
        "PORTAL_AIF_ITPIPES_INSPECTION_TABLE": _value(config, "aifSources", "itpipesInspectionTable"),
        "PORTAL_AIF_ITPIPES_OBSERVATION_TABLE": _value(config, "aifSources", "itpipesObservationTable"),
        "PORTAL_GIS_FACILITY_DUCKDB": _value(config, "dataSources", "gisFacility", "database"),
        "PORTAL_SDW_DUCKDB": _value(config, "dataSources", "spatialDataWarehouse", "database"),
        "PORTAL_MAP_PMTILES_ROOT": _value(config, "maps", "pmtilesRoot"),
        "PORTAL_MAP_LEGACY_PMTILES_ROOT": _value(config, "maps", "legacyPmtilesRoot"),
        "PORTAL_MAP_LEGACY_ARCHIVE": _value(config, "maps", "legacyMapArchive"),
        "PORTAL_MAP_CONFIG_FILE": _value(config, "maps", "projectConfigFile"),
        "PORTAL_MAP_TERRAIN_ROOT": _value(config, "maps", "terrainRoot"),
        "PORTAL_MAP_TERRAIN_ARCHIVE": _value(config, "maps", "terrainArchive"),
        "PORTAL_MAP_REPORTS_ROOT": _value(config, "maps", "reportsRoot"),
        "PORTAL_BUSINESS_BACKUP_ROOT": _value(config, "business", "backupRoot"),
        "PORTAL_BUSINESS_INBOX_ROOT": _value(config, "business", "inboxRoot"),
        "PORTAL_BUSINESS_OUTBOX_ROOT": _value(config, "business", "outboxRoot"),
        "PORTAL_BUSINESS_NETWORK_ROOT": _value(config, "businessSync", "networkRoot"),
        "PORTAL_BUSINESS_MASTER_MANIFEST": _value(config, "businessSync", "masterManifest"),
        "PORTAL_BUSINESS_MASTER_VERSIONS_ROOT": _value(config, "businessSync", "masterVersionsRoot"),
        "PORTAL_SUBMISSION_INBOX_ROOT": _value(config, "businessSync", "submissionInboxRoot"),
        "PORTAL_SUBMISSION_PROCESSED_ROOT": _value(config, "businessSync", "submissionProcessedRoot"),
        "PORTAL_SUBMISSION_REJECTED_ROOT": _value(config, "businessSync", "submissionRejectedRoot"),
        "PORTAL_CONFLICT_OPEN_ROOT": _value(config, "businessSync", "conflictOpenRoot"),
        "PORTAL_CONFLICT_RESOLVED_ROOT": _value(config, "businessSync", "conflictResolvedRoot"),
        "PORTAL_CONFLICT_ARCHIVE_ROOT": _value(config, "businessSync", "conflictArchiveRoot"),
        "PORTAL_MERGE_LOCK_ROOT": _value(config, "businessSync", "lockRoot"),
        "PORTAL_NETWORK_BACKUP_ROOT": _value(config, "businessSync", "backupRoot"),
        "PORTAL_AMTEAM_MEDIA_ROOT": _value(config, "application", "pipeVideoRoot"),
        "PORTAL_CITYWORKS_INSPECTION_URL_TEMPLATE": _value(config, "externalServices", "cityworks", "inspectionUrlTemplate"),
        "PORTAL_CITYWORKS_WORKORDER_URL_TEMPLATE": _value(config, "externalServices", "cityworks", "workOrderUrlTemplate"),
        "PORTAL_CITYWORKS_INVESTIGATION_URL_TEMPLATE": _value(config, "externalServices", "cityworks", "investigationUrlTemplate"),
        "PORTAL_EXPORT_ROOT": _value(config, "application", "exportRoot"),
        "PORTAL_LOG_ROOT": _value(config, "application", "logRoot"),
        "PORTAL_TEMP_ROOT": _value(config, "application", "tempRoot"),
    }
    for name, value in mappings.items():
        if name in _AIF_SOURCE_ENVIRONMENT_KEYS or name in _MAP_SOURCE_ENVIRONMENT_KEYS:
            # The packaged, Manager-owned Portal settings are authoritative for
            # AIF and map source routing. Do not allow a stale .env or machine
            # variable to redirect an authoritative configured source.
            if value:
                os.environ[name] = value
            else:
                os.environ.pop(name, None)
        elif value:
            os.environ.setdefault(name, value)
    maps_config = config.get("maps")
    thematic_archives = (
        maps_config.get("portalLayerArchives") if isinstance(maps_config, dict) else None
    )
    if isinstance(thematic_archives, dict):
        os.environ["PORTAL_MAP_THEMATIC_ARCHIVES_JSON"] = json.dumps(
            thematic_archives,
            sort_keys=True,
        )
    else:
        os.environ.pop("PORTAL_MAP_THEMATIC_ARCHIVES_JSON", None)
    map_configuration_file = mappings["PORTAL_MAP_CONFIG_FILE"]
    if map_configuration_file and "${" not in map_configuration_file:
        config_path = Path(map_configuration_file)
        if not config_path.is_absolute():
            config_path = desktop_config_path().parent / config_path
        os.environ["PORTAL_MAP_TILES_CONFIG"] = str(config_path.resolve())
    else:
        # The portable configuration owns project.toml beside portal.settings.json.
        # This fallback also keeps direct worker invocations usable when the host
        # has not exported PORTAL_APP_ROOT yet.
        local_project_config = desktop_config_path().parent / "project.toml"
        if local_project_config.is_file():
            os.environ["PORTAL_MAP_TILES_CONFIG"] = str(local_project_config.resolve())
        else:
            os.environ.pop("PORTAL_MAP_TILES_CONFIG", None)
    # Compatibility for management modules while the desktop identity migration is completed.
    if mappings["PORTAL_SYSTEM_DB"]:
        os.environ.setdefault("PORTAL_MANAGEMENT_DB", mappings["PORTAL_SYSTEM_DB"])
    return config


def configured_paths() -> dict[str, str]:
    config = load_desktop_config()
    map_configuration_file = os.getenv(
        "PORTAL_MAP_TILES_CONFIG",
        _value(config, "maps", "projectConfigFile"),
    )
    return {
        "config": str(desktop_config_path()),
        "shared_data_root": os.getenv("PORTAL_SHARED_DATA_ROOT", _value(config, "shared", "dataRoot")),
        "system_database": os.getenv("PORTAL_SYSTEM_DB", _value(config, "system", "database")),
        "business_database": os.getenv("PORTAL_BUSINESS_DB", _value(config, "business", "database")),
        "asset_risk_database": os.getenv("PORTAL_AMTEAM_DUCKDB", _value(config, "risk", "databases", "assetRisk")),
        "inventory_database": os.getenv("PORTAL_INVENTORY_DUCKDB", _value(config, "risk", "databases", "inventory")),
        "city_pipes_database": os.getenv("PORTAL_CITY_PIPES_DUCKDB", _value(config, "risk", "databases", "cityPipes")),
        "portal_sources_manifest": os.getenv("PORTAL_SOURCES_MANIFEST", _value(config, "dataSources", "portalSources", "manifest")),
        "itpipes_database": os.getenv("PORTAL_ITPIPES_DUCKDB", _value(config, "dataSources", "itpipes", "database")),
        "itpipes_merged_database": os.getenv("PORTAL_ITPIPES_MERGED_DUCKDB", _value(config, "dataSources", "itpipesMerged", "database")),
        "gis_facility_database": os.getenv("PORTAL_GIS_FACILITY_DUCKDB", _value(config, "dataSources", "gisFacility", "database")),
        "spatial_data_warehouse": os.getenv("PORTAL_SDW_DUCKDB", _value(config, "dataSources", "spatialDataWarehouse", "database")),
        "pmtiles_root": os.getenv("PORTAL_MAP_PMTILES_ROOT", _value(config, "maps", "pmtilesRoot")),
        "legacy_pmtiles_root": os.getenv(
            "PORTAL_MAP_LEGACY_PMTILES_ROOT",
            _value(config, "maps", "legacyPmtilesRoot"),
        ),
        "legacy_map_archive": os.getenv(
            "PORTAL_MAP_LEGACY_ARCHIVE",
            _value(config, "maps", "legacyMapArchive"),
        ),
        "map_configuration_file": map_configuration_file,
        "map_configuration_root": str(Path(map_configuration_file).parent) if map_configuration_file else "",
        "terrain_root": os.getenv("PORTAL_MAP_TERRAIN_ROOT", _value(config, "maps", "terrainRoot")),
        "terrain_archive": os.getenv("PORTAL_MAP_TERRAIN_ARCHIVE", _value(config, "maps", "terrainArchive")),
        "map_reports_root": os.getenv("PORTAL_MAP_REPORTS_ROOT", _value(config, "maps", "reportsRoot")),
        "business_backup_root": os.getenv("PORTAL_BUSINESS_BACKUP_ROOT", _value(config, "business", "backupRoot")),
        "business_inbox_root": os.getenv("PORTAL_BUSINESS_INBOX_ROOT", _value(config, "business", "inboxRoot")),
        "business_outbox_root": os.getenv("PORTAL_BUSINESS_OUTBOX_ROOT", _value(config, "business", "outboxRoot")),
        "business_network_root": os.getenv("PORTAL_BUSINESS_NETWORK_ROOT", _value(config, "businessSync", "networkRoot")),
        "business_master_manifest": os.getenv("PORTAL_BUSINESS_MASTER_MANIFEST", _value(config, "businessSync", "masterManifest")),
        "business_master_versions_root": os.getenv("PORTAL_BUSINESS_MASTER_VERSIONS_ROOT", _value(config, "businessSync", "masterVersionsRoot")),
        "submission_inbox_root": os.getenv("PORTAL_SUBMISSION_INBOX_ROOT", _value(config, "businessSync", "submissionInboxRoot")),
        "submission_processed_root": os.getenv("PORTAL_SUBMISSION_PROCESSED_ROOT", _value(config, "businessSync", "submissionProcessedRoot")),
        "submission_rejected_root": os.getenv("PORTAL_SUBMISSION_REJECTED_ROOT", _value(config, "businessSync", "submissionRejectedRoot")),
        "conflict_open_root": os.getenv("PORTAL_CONFLICT_OPEN_ROOT", _value(config, "businessSync", "conflictOpenRoot")),
        "conflict_resolved_root": os.getenv("PORTAL_CONFLICT_RESOLVED_ROOT", _value(config, "businessSync", "conflictResolvedRoot")),
        "conflict_archive_root": os.getenv("PORTAL_CONFLICT_ARCHIVE_ROOT", _value(config, "businessSync", "conflictArchiveRoot")),
        "merge_lock_root": os.getenv("PORTAL_MERGE_LOCK_ROOT", _value(config, "businessSync", "lockRoot")),
        "network_backup_root": os.getenv("PORTAL_NETWORK_BACKUP_ROOT", _value(config, "businessSync", "backupRoot")),
        "export_root": os.getenv("PORTAL_EXPORT_ROOT", _value(config, "application", "exportRoot")),
        "log_root": os.getenv("PORTAL_LOG_ROOT", _value(config, "application", "logRoot")),
        "temp_root": os.getenv("PORTAL_TEMP_ROOT", _value(config, "application", "tempRoot")),
        "pipe_video_root": os.getenv("PORTAL_AMTEAM_MEDIA_ROOT", _value(config, "application", "pipeVideoRoot")),
    }
