# Portal Manager PMTiles generation

This directory is the authoritative implementation for generating Portal PMTiles
from registered local DuckDB mirrors. It does not import or execute files from the
older `stm_risk_models` project.

The primary builder uses DuckDB Spatial and the packaged Tippecanoe toolchain to:

1. open each configured authoritative DuckDB directly in read-only mode;
2. transform native geometry to EPSG:3857 and stage only the selected fields as
   temporary FlatGeobuf layers;
3. encode independent zoom-compatible layer groups concurrently with
   Tippecanoe, dividing the configured CPU allowance across the processes, and
   merge those groups with `tile-join` when necessary;
4. validate the PMTiles v3 header, layer IDs, and exact field allowlists; and
5. atomically publish the validated archive and manifest.

Every published feature includes the queryable string property
`__portal_feature_id`. It comes from a verified unique internal source column
(`OBJECTID`, numbered `OBJECTID_*`, `FID`, or `OID`) and never from a business
identifier. If a source view has no unique internal row ID, the builder emits a
deterministic publication hash and records that strategy in the manifest.

The source DuckDB is never copied to local storage. Only disposable conversion
files are written under the configured local temporary directory. If the packaged
Tippecanoe runtime is unavailable, the configured GDAL engine is used; if both
native engines are unavailable, the Portal-owned Python encoder is the final
diagnostic fallback. Conversion or validation errors do not trigger a silent
engine change.

Configuration is maintained in `pmtiles.settings.json`. Only registered databases,
tables, fields, and output paths are accepted.

The workstation profile uses three staging workers, six DuckDB threads per worker,
and three parallel Tippecanoe zoom-group workers that share all available
processors for native tile encoding. Each staging worker has its own
temporary FlatGeobuf file and DuckDB spill directory under
`%LOCALAPPDATA%\PortalManager\map-tiles\temp`. Live progress is written to
`%LOCALAPPDATA%\PortalManager\map-tiles\progress.json` and displayed by Portal
Manager. Use `--workers 1-8` to override staging concurrency. Use `--engine gdal`
to force the GDAL fallback or `--engine python` only for diagnostic runs.

## Commands

Validate all sources without writing output:

```powershell
python build_pmtiles_from_duckdb.py --check
```

Build every configured tileset:

```powershell
python build_pmtiles_from_duckdb.py
```

Build one thematic Portal tileset:

```powershell
python build_pmtiles_from_duckdb.py --tileset core_storm
```

Force the diagnostic Python encoder:

```powershell
python build_pmtiles_from_duckdb.py --tileset core_storm --engine python
```

The self-contained Tippecanoe runtime and license texts are maintained under
`vendor/tippecanoe`. Portable builds copy this directory beside the builder, so
production does not depend on another project or a machine-wide installation.

The 68 approved Spatial Data Warehouse vector layers are split among four
thematic archives under:

```text
G:\Strategic Planning\Planning\stm_risk_data\databases_local\tiles
```

The allowlists are explicit, disjoint, and mandatory. A build fails when any
configured layer is missing instead of silently publishing an incomplete archive.
`Topo_ln` is included in the transportation/reference archive.

The eleven Planning Project layers sourced from Cityworks, risk-ranking, and
proactive DuckDBs are intentionally excluded from this builder. Portal Desktop
queries those tables directly using `maps.duckdbGeoJsonLayers` in
`portal.settings.json`, including the stable `culverts` layer mapped to
`Culverts_evw`.

`ImperviousSurfaceSingleFamily_py.Layer` is intentionally not exposed because
the authoritative mirror currently contains only null values in that column.

Portal Manager packages this entire directory beside `PortalManager.exe` and runs
the builder with the configured source-backup Python environment.
