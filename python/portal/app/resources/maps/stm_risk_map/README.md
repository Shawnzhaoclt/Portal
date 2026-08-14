# Storm Water Asset Risk Map Runtime

MapLibre styles, the map manifest, and sprite assets are versioned with this
resource under `assets/maplibre` and packaged into Portal Desktop.

The generated project catalog is packaged as `config/project.toml` beside the
portable settings file. Runtime map metadata is read from that local copy; the
shared `maptiles/config/project.toml` file is not required by Portal Desktop.

PMTiles remain external read-only data. Their locations and logical archive
names are defined only in `config/portal.settings.json`:

- `maps.pmtilesRoot` contains the current Portal-managed archives.
- `maps.portalLayerArchives` names the four required thematic archives. All four
  must pass their manifest and exact source-layer inventory checks.
- `maps.terrainArchive` names the read-only Terrain-RGB PMTiles archive used by
  the MapLibre raster-dem source.
- `maps.legacyPmtilesRoot` contains the retained planning archive used by map
  layers that have not moved to the Portal-managed archive.
- `maps.legacyMapArchive` names the retained archive.

When a style is requested, the resource validates all thematic archive manifests
and routes the 68 registered Spatial Data Warehouse source layers to their theme.
If any archive is absent, incomplete, or contains unexpected layers, the resource
returns a clear publication error instead of serving a partial map.
The eleven Planning Project layers declared by `maps.duckdbGeoJsonLayers` are read
directly from their configured DuckDB tables for the visible map extent; they are
not converted to PMTiles. This includes `Culverts_evw` under the stable `culverts`
source-layer ID. Any other unregistered source layers continue to use the
configured legacy archive.

Asset search uses maintained source databases rather than duplicating base
inventory rows in a generated risk snapshot. Storm structures, storm pipes, and storm
drainage search `STORMSTRUCTURE_1_PT`, `STORMPIPES_1_LN`, and
`STORMDRAINAGE_1_LN` in the configured `risk.databases.inventory` database.
Culverts search the configured `Culverts_evw` layer. Risk top lists and
histograms now read the current scored source tables directly:

- `cityworks.db::CW_SCORED_ASSET_INSPECTIONS_ALL_PT`
- `riskranking.db::t_0101_UR_SCFilter_CWOnly_All_Unassigned_AllRisk`
- `riskranking.db::DEFECTS_MOST_RECENT_NS_LN`
- `riskranking.db::DEFECTS_MOST_RECENT_NS_PT`
- `riskranking.db::DEFECTS_MOST_RECENT_TOP_RISK_NS_PT`

The risk endpoints derive field metadata from those live tables, apply spatial
filters to their `geometry` columns, and do not require the generated
`stm_risk.duckdb` snapshot or its `_datasets`/`_fields` catalog.

The map's Terrain Profile tool samples the active local `terrain.dem` source
(`mecklenburg_dem.tif`) for analytical ground elevations. Drawn lines are
sampled directly; selected pipes and drainage lines resolve their geometry from
the active inventory DuckDB. Pipe profiles also use `US_INVERT` and `DS_INVERT`
after orienting the line upstream-to-downstream. Terrain-RGB PMTiles remain a
rendering source and are not used for elevation analysis. See
`docs/STORM_WATER_TERRAIN_PROFILE_DESIGN.md` for the complete workflow.

The map's Failure Consequence tool is also read-only. It evaluates the latest
ITPipes and latest Cityworks defects independently, supports a session-only
simulated defect, applies the Step 300 `3 ft + 2 x relative depth` ZOI rule, and
queries only intersecting consequence features from configured local DuckDB
sources. It never falls back to an older inspection. See
`docs/STORM_WATER_ASSET_FAILURE_CONSEQUENCE_DESIGN.md` for the full contract.
