# Storm Water Asset Failure Consequence Analysis

## 1. Purpose

The Storm Water Asset Risk Map includes a focused, read-only consequence-analysis tool for storm structures, pipes, and drainage assets. It helps a user understand which nearby roadway, parcel, building, impervious-surface, and easement features may be affected by an observed or simulated asset defect.

This is a screening tool. It does not replace field verification, survey data, hydraulic modeling, or engineering judgment.

## 2. Entry and workspace

- The tool is part of the **Storm Water Asset Risk Map**, not a separate Portal resource.
- Users can open it from the map tool rail or from the selected-feature inspector.
- If no core asset is selected, the tool asks the user to select a pipe, structure, or drainage asset on the map.
- Opening the tool closes incompatible drawing, extraction, and terrain-profile interactions.
- The map fits to one authoritative asset-wide ZOI display extent while preserving normal 2D/3D navigation.
- Closing the tool removes every transient asset, defect, ZOI, and impacted-feature graphic.

## 3. Scenario sources

Only one scenario is active for consequence calculations at a time. All latest-inspection defects remain visible so the user can switch scenarios.

### 3.1 ITPipes observed defects

- Resolve the asset through the production `ML` and `MLI` tables.
- Use the most recent `MLI` inspection by inspection date and `MLI_ID` tie-break.
- Load that inspection's observations from `ITPipes_Defects_Merged_PT`.
- Include observations with `COND_RISK > 0`.
- Do not fall back to an older inspection when the latest inspection has no qualifying defects.
- Convert observation distance to upstream-to-downstream profile station using inspection direction.

### 3.2 Cityworks observed defects

Use the latest record for the selected asset from the matching scored table:

- `CW_SCORED_ASSET_INSPECTIONS_PIPES_LN`
- `CW_SCORED_ASSET_INSPECTIONS_STRUCTURES_PT`
- `CW_SCORED_ASSET_INSPECTIONS_DRAINAGE_LN`

The tool reads the five defect slots from that one latest inspection. It does not fall back to an older inspection. Numeric point, list, and range stationing can be mapped. Free text, missing stationing, or line-asset stationing with unknown direction remains visible as an unlocated record and is never assigned a fabricated coordinate.

### 3.3 User-simulated defect

- Simulation is session-only and is not written to a database.
- The user clicks near the selected asset; the point snaps to the asset within 100 feet.
- A simulated point first snaps to the pipe centerline. Its invert is interpolated from upstream and downstream inventory inverts at that exact station, and relative depth is calculated from DEM ground minus that interpolated invert.
- Users do not manually enter depth. If DEM/invert-derived cover is unavailable, the simulation uses only the three-foot base zone and displays a warning.

### 3.4 Structure invert scenario

- A selected structure can be analyzed even when its latest inspections contain no located defect.
- The structure point and inventory `INVERT` elevation define the underground failure location.
- Relative depth is calculated as the configured analytical DEM elevation minus `INVERT`, using the same DEM resolver and sampler as Terrain Profile.
- The generated scenario is labeled **Structure invert** so it is not mistaken for an observed inspection defect.

## 4. Zone of influence

The implementation uses the Step 300 screening rule:

```text
ZOI radius = 3 feet + (2 × relative depth)
```

The context ZOI is asset-wide and is calculated even when no observed defect exists. It controls the shared map extent and the set of nearby context features by assuming a possible defect at every location on the selected asset:

- For pipes, DEM ground and the linearly interpolated upstream/downstream invert define cover at each terrain-profile sample. Every intervening asset segment receives the larger endpoint radius, producing a conservative continuous variable-width ZOI along the full pipe.
- For structures, DEM ground minus inventory `INVERT` defines one point radius.
- Open drainage without defensible depth uses the three-foot base ZOI along the full asset.

Observed and simulated defects remain selectable evidence markers. A pipe defect is snapped to the pipe line and receives a station-specific depth from DEM ground minus the interpolated invert; a source-table relative-depth value does not displace this calculation when the profile data is available.

Each active located defect also has a scenario ZOI using its exact station-specific radius. This scenario ZOI, rather than the larger asset-wide context envelope, determines which portions of consequence features are reported as influenced.

## 5. Consequence context

The tool queries versioned local DuckDB sources in read-only mode. It always applies the asset-wide ZOI spatial predicate, even when there is no observed defect, then returns all configured consequence-layer features that intersect that ZOI.

Configured sources include:

- `reference.consequence` for City ROW and city/state edge-of-pavement layers.
- `mirror.virt-sdw-sdw` (daily SQL Server mirror, ten curated SDW tables) for accessory structures, paved/driveway surfaces, other impervious surfaces, and storm-water easement points.
- `mirror.sdw-spatial` (weekly 68-layer spatial mirror, ST_Hilbert ordered with R-Tree indexes) for buildings, parcels (`ParcelJoin_py`), and storm-water conservation easements. The daily mirror does not clone those two layers, so they are read here.
  A layer a mirror has not published yet is reported as a warning and skipped, so the remaining layers still load.
- `mirror.virt-sdw-stm` remains registered for storm-water warehouse context and future Step 300 contract expansion.

All configured features that intersect the asset-wide context ZOI remain available as muted spatial context. When an active located defect exists, the backend intersects each context feature with that defect's scenario ZOI. A feature is marked **Direct contact** when it intersects the inner three-foot base zone; other nonempty intersections are marked **Within zone of influence**. Context features with no scenario intersection are not counted as affected.

The backend reports the exact influenced geometry and measurement:

- Polygon features: influenced square feet and percentage of the full source feature.
- Line features: influenced feet and percentage of the full source feature.
- Point features: whether the point is inside the scenario ZOI.

## 6. Map presentation

- Selected asset: bright cyan, high-contrast line or point.
- ITPipes observed defect: orange/red marker or pipe collar with a cyan analytical ZOI.
- Cityworks observed defect: amber marker with a cyan analytical ZOI.
- Simulated defect: magenta marker or pipe collar with a magenta analytical ZOI.
- Affected features use category colors and stronger outlines for direct contact.
- The 2D view remains a focused MapLibre map for scenario placement and conventional spatial review.
- Both views use the same authoritative rectangular extent: exactly twice the width and twice the height of the asset-wide ZOI envelope, centered on that envelope. Neither view applies an independent extent or padding. Consequence membership is tested against the asset-wide ZOI, while returned feature geometries are clipped to the shared display extent. The 2D map masks basemap and terrain outside it; the 3D DEM grid, draped basemap, terrain mesh, transparent subsurface block, selected asset, and consequence features terminate at the identical boundary.
- The 3D view is a dedicated interactive terrain cutaway rather than a pitched 2D map. It uses a bounded DEM grid, a basemap-draped irregular DEM top surface, and one transparent muted earth-gray subsurface volume with darker boundary edges.
- The 3D view provides **Landscape**, **Technical**, and **X-ray** display modes. Landscape adds restrained illustrative vegetation; Technical removes decorative vegetation while retaining terrain context; X-ray lowers the full terrain opacity for maximum subsurface visibility. These modes change presentation only and never alter analysis results.
- The terrain is split into an outer context surface and an automatic inspection corridor centered on the selected asset. The corridor is wider for line assets than structures, contains no vegetation, and uses substantially lower terrain opacity so pipes, chambers, defects, and ZOI geometry remain legible without hiding the surrounding DEM.
- Landscape vegetation is deterministic, low-poly, and explicitly illustrative rather than an inventory of real trees or grass. Grass and sparse trees are rendered only outside the inspection corridor and are omitted from Technical and X-ray modes.
- Analytical terrain elevations come from the same configured local `mecklenburg_dem.tif` resolver and raster sampler used by the Terrain Profile tool. Terrain PMTiles remain a rendering source and are not used for analytical cutaway elevations.
- Pipes use the same inventory upstream/downstream invert fields used by Terrain Profile and interpret `DIAMETER` as feet. Valid pipes are circular and rendered at their true diameter without a display-size clamp; the pipe axis is placed one radius above the interpolated invert. Terrain vertical exaggeration changes terrain and elevation separation but never stretches the pipe cross-section. A null, zero, or invalid diameter uses a clearly disclosed two-foot schematic display diameter only. Structures use inventory `INVERT` with DEM-derived cover and are shown as vertical chambers. Open drainage follows the terrain surface, and missing endpoint elevations are shown as schematic rather than fabricated surveyed elevations.
- Located defects are snapped in full 3D to the same curved asset centerline used to render the pipe or drainage mesh. Their X, Y, and Z coordinates therefore remain attached to the rendered asset rather than combining an independent map point with a calculated elevation. Pipe defects use compact illuminated collars aligned to the pipe tangent instead of large spheres. The asset-wide ZOI is always shown; the active defect additionally uses a low-opacity cone, wireframe shell, and elevation contour rings for visual context.
- Non-building consequence polygons are tessellated into bounded terrain-sampled triangles so roadways, driveways, paved and impervious surfaces, and easement context conform to DEM relief instead of appearing as flat planes. Consequence lines are similarly densified and draped; point markers are anchored at their DEM elevation.
- Building footprints are rendered as terrain-footed one-story 3D display models with flat roofs and walls that descend to the local DEM. Main buildings use a 12-foot average display height and accessory structures use 10 feet. These heights are illustrative defaults, not measured structure heights.
- Observed defects use solid orange/red markers. User-simulated defects use magenta markers. Both remain visually distinct from the cyan selected asset and translucent cyan/magenta ZOI.
- The user can orbit, pan, zoom, reset the camera, select a display mode, adjust vertical exaggeration, terrain-surface opacity, and cube opacity. Switching between 2D and 3D preserves the active scenario and calculated results.
- Camera distance, clipping, fog, lighting, and orbit limits are scaled from the larger horizontal cutaway dimension so long or narrow north-south and east-west extents remain equally visible.
- The transparent cube uses one color rather than geological bands. Its material never implies measured soil or rock strata, and underground assets, defects, and ZOI geometry remain visible through it.
- The subsurface block bottom is derived from the lowest valid selected-asset or located-defect elevation. Zero, nonfinite, out-of-range, and unlocated-defect sentinel values are excluded. The block extends below the DEM by 1.5 times the deepest required depth, with a small safe minimum only when no usable depth is available; it is not constrained by the former fixed 45-to-120-foot range.
- Full consequence features are shown with muted category colors. The exact influenced portion is overlaid in orange/red for observed scenarios or magenta for simulated scenarios. Buildings retain their one-story context model while their influenced footprint is highlighted on the DEM surface.
- Overlapping influenced polygon portions are unioned into one display footprint so transparency is applied only once. Individual influenced polygons remain available as category-colored outlines and invisible interaction geometries for tooltips, measurements, selection, and yellow flashing. Influenced lines and points remain individually rendered.
- The active ZOI volume uses a restrained wireframe and boundary rings rather than an opaque filled cone, preserving visibility of underground assets and nearby consequence features.

## 7. Panel layout

The right-side panel follows a compact inspect-and-compare workflow:

1. Selected asset and an explicit 2D/3D control.
2. Active scenario and source badge.
3. Located observed-defect list with condition risk and station, ordered by condition risk descending. Null condition-risk values appear last, and equal-risk records retain source order.
4. Simulated-defect placement control with an automatic DEM-and-invert depth explanation.
5. **Summary**, **Affected features**, and **Method** tabs.

The Summary tab shows the maximum asset-wide ZOI radius, total scenario-affected features, active condition risk, and affected category counts. Affected Features lists the source table, relationship, and influenced area/percentage, length/percentage, or point inclusion. Each row is actionable: selecting it pulses the exact influenced geometry in the active 2D or 3D view without changing the authoritative map extent. Method states the formula, latest-inspection rules, and screening limitation.

## 8. Performance and safety

- All databases are opened read-only through the centralized desktop source configuration.
- No database path is hard-coded in analysis code.
- The Desktop resolves active versioned local-cache files before the request reaches the resource.
- Spatial queries return at most 750 context features per scenario and report truncation. Only the exact scenario intersections are counted and emphasized as affected.
- The backend samples only a local `72 x 72` DEM grid over the authoritative doubled asset-wide ZOI display extent. Both rendering modes consume that same extent.
- The frontend renders no more than 350 affected features in the interactive cutaway and disposes all WebGL geometry, materials, controls, and animation frames when the panel closes or the scenario changes.
- Decorative grass, trunks, and tree canopies use capped Three.js instancing with deterministic placement. No individual vegetation mesh is created, and no vegetation is placed in the inspection corridor or on terrain that exceeds the local slope threshold.
- Terrain draping uses an 18-foot target triangle interval with a maximum of 18 subdivisions per source triangle to preserve local relief without allowing very large source polygons to create unbounded WebGL geometry.
- The feature result and map graphics are transient; closing the panel clears them.
- The normal Portal permission check for `stm_risk_map` applies to the endpoint.

## 9. Validation requirements

- Verify latest-only ITPipes and Cityworks behavior independently.
- Verify upstream/downstream direction conversion using known assets.
- Verify point, list, range, null, and free-text Cityworks stationing.
- Verify the ZOI formula at known depths.
- Verify pipe defect coordinates are snapped to the asset and their depth equals DEM ground minus the station-interpolated invert.
- Verify each 3D defect marker remains centered on the rendered asset centerline from every camera angle.
- Verify a pipe defect collar is aligned to the local pipe tangent and that the wireframe ZOI originates at the same snapped location.
- Verify Landscape vegetation never enters the asset inspection corridor, Technical removes vegetation, and X-ray lowers terrain opacity without changing the analytical extent or feature set.
- Verify non-building consequence polygons and lines remain attached to the DEM across sloped terrain, and verify building walls reach the local terrain while roofs remain flat at the configured one-story display height.
- Verify consequence context features and an asset-wide ZOI are returned when the latest inspections contain no located defect, while affected counts remain scenario-specific.
- Verify 2D and 3D use the identical doubled asset-wide ZOI extent.
- Verify polygon area/percentage, line length/percentage, and point inclusion measurements against known geometries.
- Verify overlapping influenced polygons produce one unioned display footprint and do not darken where source features overlap.
- Verify an affected-feature row flashes the matching scenario-intersection geometry in both views without moving either camera or changing the shared extent.
- Verify the transparent block reaches 1.5 times below the deepest known selected-asset or located-defect elevation and does not use the former fixed depth cap.
- Verify long, narrow cutaways in both orientations remain outside the fog washout range and open with the complete model visible.
- Verify observed and simulated symbology in both 2D and 3D.
- Verify closing the tool clears all runtime layers.
- Verify the packaged Desktop contains the configured sources and builds to `dist\Portal-Desktop\Portal.exe`.
