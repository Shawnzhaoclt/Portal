# STM Risk Map Runtime

This dashboard reuses the generated runtime outputs from:

`C:\Users\105692\scripts\stm_risk_models\map_tiles`

Set `PORTAL_MAP_TILES_RUNTIME_ROOT` to point at another generated runtime root. If PMTiles,
DuckDB, and terrain assets are copied under `runtime/build/`, they remain local/generated data
and are ignored by Git.

The Portal integration intentionally excludes the map tile and symbol generation tooling.

