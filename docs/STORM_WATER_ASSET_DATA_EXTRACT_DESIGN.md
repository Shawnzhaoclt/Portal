# Storm Water Asset Data Extract

## 1. Purpose

Asset Data Extract is an embedded tool in the **Storm Water Asset Risk Map** for selecting storm-water assets by geography and attributes and exporting the selected assets with their related operational history.

The resource supports storm structures, storm pipes, and storm drainage/channels. It does not create or maintain business records.

## 2. Design principles

- The map is used for drawing and preview. DuckDB is the authoritative query source.
- Existing Portal data-source configuration and active local-cache resolution are reused. No data path is hard coded in this resource.
- Step 401 remains the only source of assigned/unassigned status. If either the Cityworks or ITPipes branch is assigned, the asset is assigned.
- Existing Asset History logic remains the source of service requests, investigations, inspections, work orders, ITPipes defects, and pipe risk information.
- The resource creates no new persistent business tables.
- Attribute names, types, and filter operators are discovered from the active inventory tables.
- Exports contain normalized worksheets or GeoPackage layers/tables instead of repeating related records in a single wide row.

## 3. Entry and permissions

- Entry: **Extract asset data** button in the Storm Water Asset Risk Map tool rail
- Workspace: a wide right-side map panel; the map remains visible and interactive
- Resource key and permission boundary: `stm_risk_map`
- No new catalog resource, route, favorite, or permission record is created.
- View permission for the map opens and previews the tool.
- View permission for the map permits preview and read-only export. Export never changes a Portal or source record.

## 4. User workflow

The embedded workspace uses four persistent steps.

1. **Area**
   - Choose **Draw area** or **Select existing area**
   - Draw a polygon, rectangle, or circle, or use the current map extent
   - Search and select one or more authoritative culverts or work zones
   - Combine multiple selected boundaries into one export area
   - Clear area
2. **Assets & filters**
   - Select Structures, Pipes, and/or Drainage
   - Filter assignment status
   - Add typed attribute rules for each selected asset type
   - Filter by maximum published Condition Risk, Clogging Risk, Flooding Risk, or overall Risk
3. **Data**
   - Select inventory fields for each asset type
   - Include or omit related service requests, investigations, inspections, work orders, ITPipes defects, and pipe risk
   - Export all related records or only the most recent records
4. **Review & export**
   - Preview counts by asset type and assignment status
   - Review warnings and selection limits
   - Export Excel workbook or GeoPackage

Changing the area, asset types, assignment states, or filter rules invalidates the current preview. Export is disabled until the preview is current.

## 5. Spatial behavior

- Browser drawing is GeoJSON in EPSG:4326 and is shared with the map's existing drawing layer.
- Culvert boundaries come from the configured `Culverts_evw` DuckDB source. Work-zone boundaries come from `geo.WorkZones` in the versioned `reference.consequence` DuckDB source. Its authoritative file remains `resources/consequence.duckdb`; publication stages a verified copy at `databases_local/consequence.duckdb`, and Desktop uses only the active local cache copy.
- Boundary paths, tables, geometry columns, IDs, search fields, and display fields are maintained in `maps.assetExtractBoundarySources`; none are hard coded in the resource.
- Existing-boundary search supports partial matching, returns ten relevance-ordered candidates, and permits selecting up to 100 boundaries.
- Multiple boundaries are dissolved into one exact Polygon or MultiPolygon, highlighted, and fitted in the map before preview.
- The backend validates Polygon or MultiPolygon geometry and transforms it to the inventory CRS, EPSG:2264.
- DuckDB performs exact `ST_Intersects` filtering against the inventory geometry column.
- Existing R-tree indexes and spatial ordering are used by the active inventory database where available.
- Preview geometry is transformed back to EPSG:4326.
- Preview returns at most 5,000 features. Counts always represent the complete filtered result.
- Export is limited to 50,000 assets per request. A larger selection must be narrowed before export.

## 6. Attribute filters

The backend publishes a field catalog from the active inventory schema. Geometry, binary, and internal-only fields are excluded.

Supported operators:

- Text: equals, not equal, contains, starts with, is null, is not null
- Number: equals, not equal, greater than, greater than or equal, less than, less than or equal, is null, is not null
- Date/time: equals, before, on or before, after, on or after, is null, is not null
- Boolean: equals, not equal, is null, is not null

Every field name is validated against the discovered schema and every value is parameterized. Rules within an asset type are combined with AND.

The candidate field list also exposes four standardized related-risk filters: **Condition Risk**, **Clogging Risk**, **Flooding Risk**, and **Risk**. For each asset, these filters use the maximum available published score across direct Cityworks asset inspections and ITPipes defects. The overall Risk filter also considers the published priority-pipe score for pipes. These are derived filter fields; they are not presented as inventory columns and no risk is recalculated by Portal.

## 7. Assignment status

The selected inventory IDs are matched in set-based queries against the published Step 401 tables.

- **Assigned**: at least one Cityworks or ITPipes assigned table contains the asset.
- **Unassigned**: no assigned table contains the asset and at least one unassigned table contains it.
- **Not evaluated**: the Step 401 source is available but the asset appears in none of its assignment tables.
- **Data unavailable**: the Step 401 source cannot be read.

Assignment filtering occurs after the spatial and inventory-attribute query and before preview/export.

## 8. Related data

Related data follows the existing Storm Water Asset History contracts:

- Cityworks service requests
- Cityworks investigations
- Cityworks inspections, including published risk fields where available
- Cityworks work orders
- ITPipes defects
- Priority-pipe risk information for pipes

Each related row includes `asset_type` and `asset_id` so its relationship remains explicit in normalized output.

Related record coverage has two modes:

- **All related records** exports every matching record.
- **Most recent only** exports the newest service request, investigation, inspection, and work order for each asset. For ITPipes, it selects the newest inspection for each asset and retains every defect belonging to that inspection. Priority-pipe risk rows are unaffected.

## 9. Excel output

The shared Portal Excel engine is used. Asset ID is always included and the selected inventory fields are appended.

Workbook sheets:

- `Export Summary`
- `Structures`
- `Pipes`
- `Drainage`
- `Service Requests`
- `Investigations`
- `Inspections`
- `Work Orders`
- `ITPipes Defects`
- `Pipe Risk`

Empty optional sheets are omitted. Dates use US Eastern display values, numeric values use no more than three decimals, and cell content is vertically centered.

Portal Desktop opens a native **Save As** dialog with a timestamped `.xlsx` suggestion. The user chooses the folder and filename, Windows confirms replacement of an existing file, Portal writes through an atomic temporary file, and the saved workbook opens in Excel. Browser mode uses the browser's configured download behavior.

## 10. GeoPackage output

GeoPackage uses EPSG:2264 and contains spatial layers `structures`, `pipes`, and `drainage`. Selected inventory fields and assignment status are attributes on those layers.

Selected related datasets are written as non-spatial attribute tables using the same normalized names as the Excel workbook. `asset_type` and `asset_id` are the relationship keys.

Portal Desktop uses the native **Save As** workflow with a timestamped `.gpkg` suggestion. The selected path is confirmed before an atomic write. GeoPackage files are not opened automatically.

## 11. API

- `GET /api/map/asset-data-extract/catalog`
- `GET /api/map/asset-data-extract/boundaries/search`
- `POST /api/map/asset-data-extract/boundaries/geometry`
- `POST /api/map/asset-data-extract/preview`
- `POST /api/map/asset-data-extract/export/excel`
- `POST /api/map/asset-data-extract/export/geopackage`

The preview and export endpoints accept the same selection contract. Export adds selected field lists and related-data options.

## 12. Failure handling

- Missing inventory or spatial extension: block preview and explain which active source is unavailable.
- Missing Step 401 source: preview inventory with `Data unavailable`; assignment-specific filtering returns no assets and explains why.
- Missing optional related source: export the available sections and list omitted sections in `Export Summary`.
- Invalid geometry or filter: reject before querying.
- Selection over limits: return complete counts and require narrower filters.

## 13. Performance

- Open each DuckDB read-only.
- Query assets in set-based SQL by asset type.
- Use one Step 401 membership query per assignment table, not one query per asset.
- Fetch related records in batches keyed by selected assets.
- Keep preview geometry and properties small; full attributes are read only for export.
- Do not read PMTiles to identify export records.

## 14. Acceptance criteria

- Polygon, rectangle, circle, and map extent create valid drawing areas without a buffer step.
- Culvert and work-zone search uses configured active-cache DuckDB sources and exact geometry.
- One or more existing boundaries can be combined, highlighted, and used as the authoritative area.
- Structures, pipes, and drainage can be selected together or independently.
- Typed filters are validated and applied to their active inventory tables.
- Standardized risk filters use the maximum available published scores without recalculation.
- Assignment results match Asset History for sampled assets.
- Most recent mode keeps one newest Cityworks record per asset/category and all defects from the newest ITPipes inspection.
- Preview counts match exported asset row counts.
- Excel and GeoPackage exports prompt for a destination in Portal Desktop; Excel opens after it is saved.
- GeoPackage opens as a valid GeoPackage with spatial asset layers and selected related tables.
- No export query writes to source DuckDB, `system.db`, or `stormwater.db`.
