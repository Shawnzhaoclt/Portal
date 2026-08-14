# Storm Water Terrain Profile Tool

## Purpose

The Terrain Profile tool is part of the Storm Water Asset Risk Map. It lets a
user inspect the ground surface along a drawn path, storm pipe, or storm
drainage line without opening a separate resource.

## Entry and workflow

The map toolbar contains a **Terrain profile** action. Opening it displays a
resizable bottom analysis panel while preserving the usable map area.

The user can choose one of three modes:

1. **Draw line** — click two or more map locations and double-click to finish.
2. **Select pipe** — select a storm pipe and generate a DEM and pipe-invert
   profile from upstream to downstream.
3. **Select drainage** — select a drainage line and generate its ground
   profile. The current drainage inventory does not provide endpoint invert
   elevations, so the panel explains that only the DEM surface is available.

Pipe and drainage features already selected in the map inspector also expose a
**Terrain profile** action. Closing or clearing the tool removes its temporary
line, endpoints, and hover marker from every active map view.

## Data sources

- Ground elevations come from the active local cached version of
  `mecklenburg_dem.tif` registered as `terrain.dem`.
- Asset geometry and attributes come from the active local inventory DuckDB:
  `STORMPIPES_1_LN`, `STORMDRAINAGE_1_LN`, and `STORMSTRUCTURE_1_PT`.
- Pipe inspection context comes from the active local ITPipes production mirror
  (`ML` and `MLI`). Defect observations come from
  `ITPipes_Defects_Merged_PT` in the active local ITPipes intermediate
  database.
- The terrain-rendering PMTiles archive remains a visualization source only. It
  is not used for analytical elevation sampling.
- Source file names and logical source IDs are configuration values. Runtime
  code does not contain shared-drive paths.

## Profile calculation

The Python backend transforms the selected path to the DEM coordinate system,
samples no finer than the native DEM cell size, and limits a profile to 2,000
samples. COG blocks touched by the path are read once to avoid repeated random
file reads.

For pipes, the backend matches the asset's upstream and downstream structures,
orients the geometry upstream-to-downstream, and linearly interpolates between
`US_INVERT` and `DS_INVERT`. If either invert is missing, the ground profile is
still returned with a warning. The chart shows a dashed schematic pipe
alignment below the ground surface so the selected asset remains visible, but
explicitly states that this alignment is not at a surveyed elevation.

The result includes length, ground range, net elevation change, gain and loss,
pipe grade when available, minimum ground-to-invert distance, source version,
and elapsed computation time.

For a selected pipe, the backend resolves its production `ML` row and selects
the newest `MLI` inspection by inspection date. Only observations belonging to
that exact MLI with `COND_RISK > 0` are returned from
`ITPipes_Defects_Merged_PT`. If the newest inspection has no positive-risk
observations, the tool reports that result and does not fall back to an older
inspection.

The profile always uses upstream-to-downstream stationing. For an inspection
recorded downstream (upstream to downstream), profile station equals ITPipes
`Distance`. For an inspection recorded upstream (downstream to upstream),
profile station equals `pipe length - Distance`. Unknown directions, missing
distances, and materially out-of-range distances remain unlocated instead of
being guessed. Reversing the chart mirrors located defect stations without
changing the authoritative source distance.

## Interaction design

- The panel identifies the ground profile as DEM-derived and warns that DEM
  elevations are approximate and should be verified against field or survey
  data when accuracy is critical. This warning applies to the ground surface,
  not to separately sourced surveyed pipe invert values.
- The chart plots DEM ground as a green surface line with dense, adaptive
  vector grass tufts and a small number of evenly distributed vector trees.
  This schematic terrain context is decorative rather than mapped vegetation,
  remains legible at different profile lengths, and never changes or obscures
  the sampled elevation values. Grass spacing is one half of the preceding
  terrain treatment and is interpolated between valid DEM samples, with a
  rendering cap that prevents long profiles from becoming visually noisy or
  expensive.
- A selected pipe with surveyed endpoint inverts is rendered as a side-view
  cutaway between its interpolated invert and crown. The symbol uses the
  inventory `DIAMETER` in feet to draw an outer barrel, lighter inner bore,
  wall highlight, and endpoint coupling rings at its true vertical diameter.
  The invert is the lower engineering reference and the crown equals invert
  plus diameter; the renderer does not impose a minimum visual thickness on a
  valid diameter. If diameter is null, zero, or invalid, the chart uses a
  clearly labeled two-foot schematic diameter for display only and does not
  store or export that fallback as source data. If either endpoint invert is
  unavailable, the pipe remains a clearly labeled dashed schematic alignment;
  the application never invents a surveyed pipe elevation.
- Upstream and downstream structures are rendered as compact vector manhole
  chambers: a cover at the DEM ground surface, a bold chamber shaft to the
  invert, a connection base, and ladder-rung details when chart space permits.
  They remain sharp at every Windows display scale and work in both themes.
  Structure labels prefer `US_ASSETID` and `DS_ASSETID`, which are the ITPipes
  asset IDs, and fall back to `US_ID` and `DS_ID` only when the ITPipes IDs are
  unavailable. Known invert elevations are shown with the labels.
- The selected pipe or drainage asset ID is shown both in the compact summary
  and directly beside its profile symbol, preventing ambiguity when several
  overlapping map features are selectable.
- Multiple compact, solid-color flow arrows are distributed inside the pipe or
  drainage symbol. Each uses a simple shaft and filled triangular head. Arrow
  count adapts to the displayed profile length, follows the actual
  upstream-to-downstream slope, and reverses with the chart reading direction
  without crowding short assets.
- The map toolbar, selected-feature action, profile panel, and empty state use
  the same elevation-profile icon so the tool is visually distinct from route
  and navigation functions.
- Located defects from the latest ITPipes inspection are shown as lollipop
  markers on the pipe profile. Markers use a continuous condition-risk ramp
  from yellow through amber and red to dark red. Observations at the same or a
  near-identical station are clustered; the highest risk controls the marker
  color and a badge shows the observation count.
- The inspection strip shows MLI ID, inspection date, direction, located and
  unlocated counts, a risk legend, a show/hide control, and a link to the
  authoritative ITPipes inspection. Tooltips include MLO ID, observation text,
  station, and condition risk.
- A selected drainage line uses a teal open-channel symbol and dashed
  longitudinal alignment. Because the current drainage inventory has no
  endpoint bed elevations, this representation is labeled as schematic and
  does not invent a drainage elevation.
- The compact summary exposes both endpoint structure IDs. The chart tooltip
  reports station, ground elevation, pipe invert, pipe crown when calculable,
  and ground-to-invert distance.
- Hovering the map line or chart synchronizes a highlighted location and chart
  tooltip.
- **Reverse** changes the chart reading direction without re-reading the DEM.
- **Clear** removes the current result while keeping the tool open.
- **Export** opens a compact format menu. **Excel workbook** uses the shared
  Portal Excel engine, includes endpoint IDs, elevations, and available pipe or
  drainage dimensions, and opens the generated workbook in Excel. Pipe
  workbooks include a second worksheet for the latest inspection's
  positive-risk observations, including source distance and normalized profile
  station. **JPG graph** captures the visible chart at two-times pixel density,
  uses a theme-appropriate background, prompts for a destination through the
  Windows Save As dialog, and opens the saved image in the default viewer.

## Validation and failure behavior

- Invalid or too-short lines are rejected before sampling.
- Missing local DEM or inventory data produces a clear, recoverable panel
  message.
- Asset IDs must resolve to exactly one inventory feature.
- Nodata cells create gaps rather than fabricated elevation values.
- ITPipes lookup failures do not prevent the DEM and engineering profile from
  loading; the panel displays an explicit unavailable warning.
- Requests are cancelled when superseded or when the panel closes.

## Performance and security

- All data access is read-only and resolves through the active local source
  cache.
- The API requires View permission for the Storm Water Asset Risk Map.
- Sampling and asset queries run in the local Portal Python service; no terrain
  or asset data is sent to an external service.
- Map graphics are transient GeoJSON helper layers and are not persisted.
