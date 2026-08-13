# Storm Water Asset History Resource Design

## 1. Document Status

- Status: Approved design baseline
- Application: Portal Desktop
- Resource name: **Storm Water Asset History**
- Proposed route: `/asset-history`
- Supported assets: storm structures, storm pipes, and storm channels
- Data access: read only
- Database changes: none
- New database tables: none

This document defines a Portal Desktop resource that gives users one place to find
a core storm-water asset and review all of its related service requests,
investigations, inspections, and work orders. The page also displays the asset's
authoritative assigned or unassigned result produced by Step 401 of the `stm_risk`
workflow.

The Portal must not reproduce, simplify, or reinterpret the Step 401 assignment
algorithm. It reads the published Step 401 result and presents it with its source
context.

## 2. Goals

The resource must let a user:

1. Open an asset directly from the Storm Water Asset Risk Map.
2. Search for a structure, pipe, or channel by asset ID.
3. See the asset's authoritative Step 401 assignment result immediately.
4. Review every related Cityworks service request, investigation, inspection, and
   work order without losing one-to-many relationships.
5. Understand how each record is related to the asset.
6. Open the corresponding Cityworks record when a supported deep link is
   available.
7. Filter, sort, page, and export the displayed history.
8. Review every ITPipes defect observation available for the selected asset,
   enriched with its production inspection and asset context.

The design emphasizes fast scanning, progressive disclosure, and a compact
master-detail workflow suitable for a desktop application.

## 3. Non-Goals

This resource does not:

- create, edit, assign, close, or delete Cityworks records;
- calculate assigned or unassigned status;
- reproduce Step 401 business rules in Portal code;
- infer assignment from the current status of a work order or request;
- create a new business table, source table, serving table, staging table, shadow
  table, materialized view, or SQLite cache;
- copy Cityworks history into `stormwater.db` or `system.db`;
- use spatial proximity as proof that an activity belongs to an asset;
- replace the Storm Water Asset Risk Map; or
- include culverts in the first release.

## 4. Approved Design Decisions

- The resource is named **Storm Water Asset History**.
- It is a read-only Portal Desktop resource.
- The primary entry is an **Asset history** button in the Risk Map feature
  inspector for storm structures, pipes, and channels.
- A resource card and global asset search provide secondary entry points.
- The page presents one selected asset at a time.
- All one-to-many activity records are retained. The backend does not collapse
  multiple service requests, work orders, investigations, or inspections into a
  single row.
- Assignment is read only from the Step 401 outputs in `riskranking.db`.
- Cityworks-only and ITPipes-only Step 401 results remain separate authoritative
  branch results.
- If both Step 401 branches exist and agree, the page shows the shared result.
- If both branches exist and disagree, the page shows **Mixed** and displays both
  branch results. Portal does not choose a winner.
- If neither branch contains the asset, the page shows **Not evaluated**, not
  **Unassigned**.
- Activity history is queried from the existing Cityworks work-order mirror.
- Source paths and table names are configuration values. No data path is
  hard-coded in frontend or backend source code.
- All date and time values follow the Windows regional format and omit fractional
  seconds.

## 5. Terminology

| Term | Meaning |
|---|---|
| Asset | A storm structure, pipe, or channel identified by its Cityworks/ITPipes asset ID. |
| Asset inspection | A Cityworks inspection whose entity is the selected asset and whose template identifies it as an asset inspection. |
| Investigation | A non-asset Cityworks inspection connected to an asset inspection through `ACTIVITYLINK`. |
| Direct work order | A work order connected to the asset through `WORKORDERENTITY`. |
| Direct service request | A request connected to the asset through an asset inspection or its linked investigation. |
| Work-order service request | A request connected to a direct asset work order. |
| Step 401 result | The assigned/unassigned classification already produced by the `stm_risk` Step 401 workflow. |
| Mixed | Cityworks-only and ITPipes-only Step 401 branches both contain the asset but report different classifications. |

## 6. Source-of-Truth Boundaries

The page deliberately separates two concerns:

```text
Step 401 risk-ranking outputs  ---> assignment result only

Cityworks mirror              ---> full activity history

Inventory database            ---> asset identity and map context
```

The activity list is not used to calculate the assignment badge. Likewise, the
Step 401 result tables are not treated as the complete activity history because
they retain selected classification context rather than every related record.

## 7. Data Sources

### 7.1 Asset identity

Use the existing configured inventory source that already supports Risk Map asset
search and feature details.

Expected inventory tables:

| Asset type | Existing table | Expected ID |
|---|---|---|
| Structure | `STORMSTRUCTURE_1_PT` | `S_...` |
| Pipe | `STORMPIPES_1_LN` | `P_...` |
| Channel | `STORMDRAINAGE_1_LN` | `D_...` |

The exact database path, table, ID field, and display fields must be resolved from
Portal configuration.

### 7.2 Authoritative Step 401 assignment result

Configured source ID:

```text
intermediate.riskranking
```

Expected database:

```text
intermediate/riskranking/riskranking.db
```

The resource reads these existing Step 401 output tables:

| Branch | Unassigned result | Assigned result |
|---|---|---|
| Cityworks-only | `t_0001_UR_AC_CWOnly_All_Unassigned` | `t_0004_UR_AC_CWOnly_Assigned_Or_Universal` |
| ITPipes-only | `t_0001_UR_AC_ITPipesOnly_All_Unassigned` | `t_0004_UR_AC_ITPipesOnly_Assigned_Or_Universal` |

These are classification outputs, not input tables. Portal must not reapply the
Step 401 filters described in the `stm_risk` code.

### 7.3 Full Cityworks activity history

Configured source ID:

```text
mirror.cityworks-workorder
```

Expected database:

```text
databases_local/myrs_cwdbprd_1_swpt_cityworks_db.duckdb
```

Expected mirror tables include:

- `azteca_INSPECTION`;
- `azteca_INSPQUESTION` when question/answer details are requested;
- `azteca_WORKORDER`;
- `azteca_WORKORDERENTITY`;
- `azteca_ACTIVITYLINK`;
- `azteca_REQUEST`; and
- the configured priority lookup table when a priority description is needed.

The implementation must resolve actual table names from configuration and validate
them at startup. The `azteca_` names document the current mirror, not a license to
hard-code them throughout application logic.

### 7.4 ITPipes defect observations

Configured source IDs:

```text
intermediate.itpipes
mirror.itpipes
```

The conditional **ITPipes defects** view reads defect and risk values from
`ITPipes_Defects_Merged_PT` in the active `intermediate/itpipes/itpipes.db` and
matches rows to the selected asset through `ITPIPE_ASSETID`. For those observations,
production `MLI` supplies `Inspection_Date`, `Inspection_Direction`, and `ML_ID`;
production `ML` supplies the matching `ML_Name` through `MLI.ML_ID = ML.ML_ID`.

Each row displays:

- `MLI_ID`;
- `MLO_ID`;
- `ML_ID`;
- inspection date;
- inspection direction;
- `IS_CONTINUOUS`;
- observation text;
- condition risk;
- flood risk;
- clogging risk; and
- total risk.

Rows are ordered by production `MLI.Inspection_Date` descending, then condition
risk descending, then MLI and MLO ID descending. Each MLI ID links to the matching
ITPipes inspection at
`https://charlottenc.itpipes.com/Asset/SearchByInspId?assetType=ML&inspID=<MLI_ID>`
and opens in the user's default browser. Portal creates no serving or cache table
for this view.

### 7.5 Priority-pipe risk information

Configured source ID:

```text
intermediate.prioritypipes
```

For pipe assets only, the conditional **Risk information** view reads the
published model result from `PRIORITY_PIPES_SCORED` in the active
`intermediate/prioritypipes/prioritypipes.db`. It matches the selected pipe by
`ITPIPE_ASSETID` and displays `Basin_Name`, `WorkZoneID`, `CL_SCORE`,
`LOF_SCORE`, `COF_SCORE`, and `RISK`.

Portal does not recalculate, persist, or alter these scores. The tab is hidden for
structures and channels and for pipes without a matching scored row.

### 7.6 Local data-cache behavior

The inventory, Step 401, Cityworks, ITPipes, and priority-pipes inputs are existing
read-only, versioned Desktop data sources. The resource uses the active local cache
version selected by the Desktop data-cache service. It does not read directly from
the shared source when a valid active local version is available.

The response must include the active source version or publication timestamp so
the user can see the age of the Step 401 result and Cityworks mirror.

## 8. Step 401 Assignment Contract

### 8.1 Branch classification

For each Step 401 branch, classify by table membership only:

| Membership | Display result |
|---|---|
| Asset appears only in that branch's `0001` table | Unassigned |
| Asset appears only in that branch's `0004` table | Assigned |
| Asset appears in neither table | Not evaluated in this branch |
| Asset appears in both tables | Data conflict |

Portal does not inspect `WO_STATUS`, dates, request status, CIP fields, or risk
scores to determine the result.

### 8.2 Combined display state

| Cityworks branch | ITPipes branch | Header state |
|---|---|---|
| Assigned | Assigned or not evaluated | Assigned |
| Unassigned | Unassigned or not evaluated | Unassigned |
| Not evaluated | Assigned | Assigned |
| Not evaluated | Unassigned | Unassigned |
| Assigned | Unassigned | Mixed |
| Unassigned | Assigned | Mixed |
| Not evaluated | Not evaluated | Not evaluated |
| Data conflict | Any | Data issue |

The branch badges are always visible in the assignment details popover. The
combined state is a display summary, not a new stored classification.

### 8.3 Duplicate rows

An ITPipes assigned table may contain multiple observation-level rows for one
asset. Membership is therefore tested with `EXISTS` or `SELECT DISTINCT
ITPIPE_ASSETID`; row count must not be interpreted as multiple assignments.

If multiple rows provide supporting context, the page may display all distinct
inspection, observation, request, and work-order IDs in the Step 401 details
panel. It must not arbitrarily select one as the assignment reason.

### 8.4 Missing and unavailable states

- **Not evaluated** means the asset is absent from all four Step 401 membership
  sets.
- **Data unavailable** means the active `riskranking.db` cannot be opened or a
  required Step 401 table is missing.
- The two states must never be conflated.
- A stale-data warning is informational and does not change the assignment result.

## 9. Activity Relationship Rules

The backend follows the relationship directions already used by `stm_risk`, but
returns all matching history rather than the deduplicated records used for risk
classification.

### 9.1 Asset inspections

Select every Cityworks inspection where:

- `ENTITYUID` equals the selected asset ID;
- `ENTITYTYPE` matches `PIPES`, `STRUCTURES`, or `CHANNELS`; and
- `INSPTEMPLATENAME` identifies an asset inspection, currently by the configured
  equivalent of `LIKE '%Asset Insp%'`.

Do not keep only the most recent inspection.

### 9.2 Investigations

Start with all direct asset inspections. Find inspection-to-inspection links in
both valid `ACTIVITYLINK` directions:

```text
Investigation -> Asset inspection
Asset inspection -> Investigation
```

The linked record is an investigation when it is an inspection that is not an
asset-inspection template. Return every distinct asset-inspection/investigation
pair. Do not collapse the list to a primary investigation.

### 9.3 Work orders

Select every work order connected to the asset through `WORKORDERENTITY`, using
the asset ID and matching core `ENTITYTYPE`.

The history page intentionally includes work-order templates that Step 401 may
exclude. Step 401 inclusion is not the definition of full asset history.

### 9.4 Service requests

Return the union of these relationship paths:

1. Service request linked to a direct asset inspection.
2. Service request linked to an investigation that is linked to a direct asset
   inspection.
3. Service request linked to a direct asset work order.

Support normal and reverse `ACTIVITYLINK` directions for each relationship.

Requests excluded by Step 401, such as a data request, may still appear in full
history. The page labels their relationship path and does not imply that they
affected assignment.

### 9.5 No spatial inference

Two records are not related merely because they are spatially close. Proximity may
be added later as a clearly labeled QA aid, but it is outside this release and must
not appear in the authoritative history count.

### 9.6 Deduplication keys

| Record type | Identity key | Relationship key |
|---|---|---|
| Inspection | `INSPECTIONID` | Asset ID + inspection ID |
| Investigation | `INSPECTIONID` | Asset inspection ID + investigation ID |
| Work order | `WORKORDERID` | Asset ID + work-order ID |
| Service request | `REQUESTID` | Asset ID + request ID + relationship path |

A service request reached through more than one path appears once in its table with
all paths shown as relationship badges. It appears once per event in the combined
timeline.

## 10. Entry Points

### 10.1 Risk Map feature inspector

For the following source layers, add an **Asset history** button beside the current
Details, Flash, and Street View actions:

- `stormstructure_pt`;
- `stormpipes_ln`; and
- `stormdrainage_ln`.

The button opens:

```text
/asset-history?assetId=<encoded-id>&assetType=<structure|pipe|channel>&returnTo=map
```

The selected map feature supplies only navigation context. The history page
validates the asset against the configured inventory source before querying
activities.

### 10.2 Resource catalog

Register **Storm Water Asset History** as a normal Portal resource. Opening it from
the catalog displays the search-first state.

The system catalog generates and maintains the resource identity. No resource ID
is embedded in a business table or manually entered in code.

### 10.3 Contextual links

Tables that already display a core asset ID may use the same route to provide an
**Asset history** link. This is optional for the first release and must use the
same page rather than creating a second implementation.

## 11. User Experience and Information Architecture

The page follows a compact enterprise master-detail pattern:

```text
+--------------------------------------------------------------------------+
| Storm Water Asset History       [Find asset________________] [Search]     |
+--------------------------------------------------------------------------+
| P_12345  Pipe  ACTIVE           [Assigned] [Locate on map] [Open source] |
| From S_100 -> S_200 | 18 in | Concrete | Step 401: 8/13/2026 7:02 AM    |
+--------------------------------------------------------------------------+
| [Timeline 24] [Requests 4] [Investigations 3] [Inspections 9] [WOs 8]   |
+--------------------------------------------------------------------------+
| [Search records____] [Status v] [Date range v] [Relationship v] [Export]|
+--------------------------------------------+-----------------------------+
| Date | Type | ID | Status | Summary | Link | Selected record details     |
| ...                                         | Relationship path           |
| ...                                         | Core fields                 |
|                                             | [Open in Cityworks]          |
+--------------------------------------------+-----------------------------+
| 1-10 of 24                       [Previous] [Next]                        |
+--------------------------------------------------------------------------+
```

### 11.1 Search-first state

When no asset is selected:

- center a focused asset search within the content area;
- search structures, pipes, and channels concurrently;
- use case-insensitive fuzzy matching;
- show at most 10 candidates initially;
- display asset type, asset ID, status, endpoints or address, and a small type
  icon; and
- support keyboard navigation and Enter to select.

Search must prioritize exact asset-ID matches, then prefix matches, then fuzzy
matches. It must not load whole source tables into the frontend.

### 11.2 Compact asset header

The selected asset header is sticky and uses two compact rows:

- Row 1: asset ID, asset type, inventory status, assignment badge, primary
  actions.
- Row 2: type-specific summary fields and source freshness.

The header must not become a large dashboard hero. Its target height is 88-112
pixels at the standard desktop breakpoint.

Primary actions:

- **Locate on map**;
- **Open source** when a supported source URL exists;
- **Copy asset ID**; and
- an overflow menu for lower-frequency actions.

### 11.3 Assignment badge

Use text, icon, and color together:

| State | Treatment |
|---|---|
| Assigned | Green status badge with check icon |
| Unassigned | Amber status badge with open-circle icon |
| Mixed | Purple or neutral-emphasis badge with split-state icon |
| Not evaluated | Gray badge with minus icon |
| Data issue/unavailable | Red badge with warning icon |

Selecting the badge opens a non-modal popover containing:

- Cityworks-only Step 401 result;
- ITPipes-only Step 401 result;
- source publication date/time;
- active source version;
- Step 401 inspection, work-order, request, MLI, and MLO identifiers available in
  the matching output rows; and
- a plain statement that Portal displays but does not calculate the result.

### 11.4 Summary metrics

The tab labels contain record counts, so a separate row of large count cards is not
needed. This saves vertical space and keeps attention on the records.

### 11.5 Tabs

Use these tabs in this order:

1. **Timeline**
2. **Service requests**
3. **Investigations**
4. **Inspections**
5. **Work orders**
6. **ITPipes defects**, shown only when the selected asset has one or more rows in
   `ITPipes_Defects_Merged_PT`
7. **Risk information**, shown only for a pipe with one or more rows in
   `PRIORITY_PIPES_SCORED`

The first tab is active by default. Tabs do not wrap. At narrow widths, replace
them with a labeled view selector.

### 11.6 Timeline

The timeline is a normalized lifecycle-event view, not a one-row-per-record list.
For each related Cityworks record, every approved non-null date field produces an
event. The individual record tabs remain one row per source record.

| Record type | Approved source dates and event labels |
|---|---|
| Service request | `DATETIMEINIT` Created; `DATESUBMITTO` Submitted; `DATEINVTDONE` Investigation completed; `PRJCOMPLETEDATE` Project completed; `DATETIMECLOSED` Closed; `DATECANCELLED` Cancelled |
| Inspection or investigation | `INITIATEDATE` Initiated; `DATESUBMITTO` Submitted; `INSPDATE` Inspection performed; `PRJSTARTDATE` Planned start; `PRJFINISHDATE` Planned finish; `ACTFINISHDATE` Actually finished; `DATECLOSED` Closed; `DATECANCELLED` Cancelled |
| Work order | `INITIATEDATE` Initiated; `DATESUBMITTO` Submitted; `PROJSTARTDATE` Planned start; `ACTUALSTARTDATE` Started; `PROJFINISHDATE` Planned finish; `ACTUALFINISHDATE` Finished; `DATEWOCLOSED` Closed |

Generic and ambiguous fields such as `DATE1` through `DATE5`, integer date fields,
and `FROMDATE` are excluded until their business meaning is formally defined. If
two approved fields on the same record have the same timestamp, one event row is
shown with the labels combined, such as **Initiated · Started**.

Events sort by timestamp descending. Each row shows:

- date and time;
- event label and source date field;
- record type icon and label;
- record ID;
- status;
- concise title or template;
- relationship-path badge; and
- whether the ID appears in the selected Step 401 context.

Use a table/list hybrid, not a decorative vertical line with oversized cards. This
keeps large histories scannable and sortable.

The default presentation is a compact vertical activity timeline grouped by year
and calendar date. A restrained connecting line and color-coded event markers show
chronology without using oversized cards. Each activity item presents the time,
event label, record type, linked record ID, current status, title, concise summary,
relationship, and external-source action. Clicking anywhere on the item opens the
right-side parent-record details panel.

Users may switch between **Timeline** and **Table** views. The timeline provides
**Comfortable** and **Compact** density options; the table remains available for
column comparison and auditing. These are presentation preferences only and do not
change filtering, paging, event counts, or export results. Timeline events are
grouped by timestamps rounded to the displayed second, so source fields separated
only by subsecond precision appear as one combined lifecycle event.

All dates and timestamps displayed by this resource use the `en-US` format and the
`America/New_York` time zone. This applies to timeline groups and cards, all table
date columns, source publication timestamps, selected-event context, and date/time
attributes in the right-side details panel. Date-only business values retain their
calendar date and display as `M/D/YYYY`.

The Timeline badge counts events. The pager also reports the number of distinct
source records represented by the filtered event set. Selecting an event opens the
existing details panel for its parent record and identifies the selected event,
timestamp, and source date field. Date filters operate on event timestamps.

### 11.7 Type-specific tables

#### Service requests

Default columns:

- Request ID
- Initiated
- Closed
- Status
- Priority
- Description
- Relationship
- Related work order or inspection

Request IDs open the corresponding Cityworks service request in the default browser.

#### Investigations

Default columns:

- Investigation ID
- Initiated/inspection date
- Status
- Template
- Investigator
- Linked asset inspection
- Link direction/type

Investigation IDs open the corresponding Cityworks inspection page in the default
browser because Cityworks stores investigations as inspection records.

#### Inspections

Default columns:

- Inspection ID
- Inspection date
- Status
- Template
- Inspector
- Entity type
- Step 401 context
- Condition risk
- Flood risk
- Clogging risk
- Overall risk

Inspection IDs open the corresponding Cityworks inspection in the default browser.
Risk values, when available, are read by `INSPECTIONID` from
`intermediate.cityworks/CW_SCORED_ASSET_INSPECTIONS_ALL_PT`; the application does
not recalculate them. Risk values display with one decimal place.

#### Work orders

Default columns:

- Work-order ID
- Initiated
- Status
- Template
- Project name
- Project type
- Work type
- Maintenance type
- Priority
- Asset-work completed flag

Work-order IDs open the corresponding Cityworks work order in the default browser.

#### ITPipes defects

Default columns, in order:

- Inspection date
- MLI ID
- MLO ID
- ML ID
- Inspection direction
- Is continuous
- Observation text
- Distance
- Relative depth
- Condition risk
- Flood risk
- Clogging risk
- Risk

This table is read only and is not merged into the Cityworks timeline. Search covers
the three IDs, direction, observation text, and risk values. Date filters apply to
the production MLI inspection date; the Cityworks status filter is hidden. Within
the same inspection date, rows are ordered by condition risk descending. MLI IDs
open their corresponding ITPipes inspection in the default browser. Distance,
relative depth, and risk values display with one decimal place.

#### Risk information

Default columns, in order:

- Basin name
- Work zone ID
- CL score
- LOF score
- COF score
- Risk

This pipe-only table is read only and presents the published priority-pipe model
output without recalculation. The status and date filters are hidden.

### 11.8 Record details

On windows at least 1,366 pixels wide, selecting a row opens a details panel on the
right without navigating away. On narrower windows, details use a full-height
drawer.

The panel contains:

- identity and current status;
- relationship path to the selected asset;
- important fields grouped into compact sections;
- related record links;
- raw source attributes behind an expandable **All fields** section; and
- **Open in Cityworks** when supported.

Every data-table row supports this interaction, including **ITPipes defects** and
**Risk information**. Details are loaded only when a row is selected. ITPipes
defect details contain every field from the matching
`ITPipes_Defects_Merged_PT` row, identified by globally unique `MLO_ID`. Priority-
pipe details contain every field from the matching
`PRIORITY_PIPES_SCORED` row, identified by asset ID and work-zone ID when present.
This keeps list responses compact while still exposing all source attributes.
For these two source-model views, null and blank attributes remain visible and
display as an em dash so that the panel represents the complete table schema.

Do not display an empty field row. Preserve zero and false values; suppress only
true null/blank values.

### 11.9 Toolbar and filters

The toolbar remains on one row and contains:

- record search;
- status filter;
- date-range filter;
- relationship filter where relevant;
- **Clear filters** when any filter is active;
- **Export**; and
- refresh in the overflow group.

Use overflow instead of wrapping controls to a second row.

### 11.10 Paging and table height

- The table fills the remaining application height.
- Page size defaults to 25 and allows 10, 25, 50, or 100.
- Paging controls remain visible at the bottom.
- Column headers are sticky.
- Horizontal scrolling is a last resort. Lower-priority columns move into row
  details at narrower widths.

## 12. Export

Export uses the Portal's unified Excel engine and style.

Workbook name:

```text
Storm_Water_Asset_History_<asset-id>_<local-date-time>.xlsx
```

Workbook sheets:

1. `Asset Summary`
2. `Timeline`
3. `Service Requests`
4. `Investigations`
5. `Inspections`
6. `Work Orders`
7. `ITPipes Defects`
8. `Pipe Risk`, included only when the selected pipe has a scored row

The export contains all rows matching current filters, not only the visible page.
It includes the active data-source versions and generation time. After successful
creation, Portal opens the workbook in the user's registered Excel application,
following the existing export behavior.
All populated workbook cells are vertically center-aligned.
Decimal values display no more than three decimal places and omit unnecessary
trailing zeros.

### 12.1 Configurable export fields

Every worksheet always exports all fields visible in its Portal table. Required
visible fields cannot be removed. The Export dialog also presents an
asset-specific, searchable catalog of source fields for Service Requests,
Investigations, Inspections, Work Orders, ITPipes Defects, and Risk Information.

Users may select additional fields in either of two places:

- the worksheet field list in the Export dialog; or
- the export checkbox beside a field in the selected record's right-side detail
  panel.

A selected field applies to all matching records in that worksheet, not only the
record used to select it. The Desktop stores the user's most recent selection in
local browser storage and offers a per-worksheet reset. The backend validates
requested field names against the active asset-specific catalog and enriches the
already-loaded source rows in bulk; it does not issue one detail query per row.
Null values remain blank in Excel. Additional fields are appended after required
columns and retain their original source-field key in the selection interface.

## 13. Backend Design

### 13.1 Module boundary

Create one resource backend package, for example:

```text
python/portal/app/resources/asset_history/
  app.py
  config.py
  queries.py
  models.py
  export.py
  tests/
```

The frontend never opens DuckDB directly and never receives physical database
paths. It calls the local Portal backend through the existing Desktop request
mechanism.

### 13.2 Read-only connection rules

- Resolve active sources through the Desktop source-cache registry.
- Open DuckDB connections in read-only mode.
- Use parameterized SQL for every user-provided value.
- Validate table and column identifiers against configuration before composing SQL.
- Do not attach or mutate `stormwater.db` or `system.db`.
- Do not create temporary persistent tables. In-memory CTEs are allowed.

### 13.3 Query sequence

When an asset is selected:

1. Normalize the asset ID without changing its business value.
2. Validate the asset and determine its type from inventory.
3. Query the four Step 401 membership sets in parallel or in one read-only query.
4. Query direct asset inspections.
5. Query investigations from those inspections.
6. Query direct asset work orders.
7. Query service requests through inspection, investigation, and work-order paths.
8. Deduplicate records while preserving all relationship paths.
9. Count matching intermediate ITPipes defect rows for conditional tab visibility.
10. When that tab is opened, query matching merged defects and enrich their MLI/ML
    context from the active production ITPipes mirror.
11. For pipes, count matching `PRIORITY_PIPES_SCORED` rows; query the six display
    fields only when the Risk information tab is opened.
12. Return summary counts first, then page data on demand.

Queries for unrelated tabs should be lazy. Opening the page should not load every
question/answer or raw field for every record.

### 13.4 Suggested request contract

```text
GET /resources/asset-history/assets/search?q=<text>&limit=10
GET /resources/asset-history/assets/<asset-type>/<asset-id>/summary
GET /resources/asset-history/assets/<asset-type>/<asset-id>/activities
GET /resources/asset-history/assets/<asset-type>/<asset-id>/<record-type>
GET /resources/asset-history/records/<record-type>/<record-id>
POST /resources/asset-history/assets/<asset-type>/<asset-id>/export
```

List parameters:

```text
page, pageSize, sort, direction, status, from, to, relationship, search
```

The actual implementation may use Tauri IPC job names rather than HTTP routes,
but the payload and response boundaries must remain equivalent.

### 13.5 Summary response

```json
{
  "asset": {
    "id": "P_12345",
    "type": "pipe",
    "status": "Active",
    "display": {}
  },
  "assignment": {
    "combined": "mixed",
    "cityworks": "unassigned",
    "itpipes": "assigned",
    "calculatedByPortal": false,
    "sourceVersion": "...",
    "publishedAt": "..."
  },
  "counts": {
    "serviceRequests": 4,
    "investigations": 3,
    "inspections": 9,
    "workOrders": 8,
    "itpipesDefects": 12,
    "pipeRisk": 1,
    "timeline": 24
  },
  "sources": {
    "inventory": {},
    "step401": {},
    "cityworks": {},
    "itpipesIntermediate": {},
    "itpipesProduction": {},
    "priorityPipes": {}
  }
}
```

The `calculatedByPortal` value is always `false` for assignment.

## 14. Configuration Design

Add resource configuration only; do not add database schema.

Suggested shape:

```json
{
  "assetHistory": {
    "inventorySourceId": "intermediate.inventory",
    "cityworksSourceId": "mirror.cityworks-workorder",
    "step401SourceId": "intermediate.riskranking",
    "itpipesIntermediateSourceId": "intermediate.itpipes",
    "itpipesProductionSourceId": "mirror.itpipes",
    "priorityPipesSourceId": "intermediate.prioritypipes",
    "assetTypes": {
      "structure": {"entityType": "STRUCTURES", "idPrefix": "S_"},
      "pipe": {"entityType": "PIPES", "idPrefix": "P_"},
      "channel": {"entityType": "CHANNELS", "idPrefix": "D_"}
    },
    "step401Tables": {
      "cityworksUnassigned": "t_0001_UR_AC_CWOnly_All_Unassigned",
      "cityworksAssigned": "t_0004_UR_AC_CWOnly_Assigned_Or_Universal",
      "itpipesUnassigned": "t_0001_UR_AC_ITPipesOnly_All_Unassigned",
      "itpipesAssigned": "t_0004_UR_AC_ITPipesOnly_Assigned_Or_Universal"
    },
    "itpipesTables": {
      "defects": "ITPipes_Defects_Merged_PT",
      "inspection": "MLI",
      "asset": "ML"
    },
    "priorityPipesTables": {
      "scored": "PRIORITY_PIPES_SCORED"
    },
    "pageSize": 25,
    "searchLimit": 10
  }
}
```

Physical paths remain in the centralized source manifest/publication settings and
the Desktop source-cache registry.

## 15. Performance Design

### 15.1 Query strategy

- Query by exact normalized asset ID after candidate selection.
- Select only fields required by the current view.
- Page in SQL, not in the frontend.
- Fetch record details only when a row is selected.
- Run independent summary queries concurrently with separate read-only
  connections.
- Cache only immutable response data for the currently selected asset in process
  memory. Clear it when an active source version changes.
- Do not load geometry for activity tables.

### 15.2 Existing-source indexes

No new tables are required. During source-generation workflows, verify useful
indexes exist on the existing mirrored/output tables:

- Step 401 `ITPIPE_ASSETID`;
- inspection `ENTITYUID`, `ENTITYTYPE`, `INSPECTIONID`;
- work-order entity `ENTITYUID`, `ENTITYTYPE`, `WORKORDERID`;
- work order `WORKORDERID`;
- request `REQUESTID`; and
- activity link source/destination activity type and ID columns.
- merged ITPipes defects `ITPIPE_ASSETID`, `MLI_ID`, and `MLO_ID`.
- priority-pipe scores `ITPIPE_ASSETID`.

If an index is missing, add it in the script that builds the replaceable DuckDB
source, not at Portal runtime. Adding an index to an existing generated source is
not a new application table.

### 15.3 Performance targets

On a workstation with active local sources:

| Operation | Target |
|---|---|
| Exact asset lookup | 250 ms or less at p95 |
| Candidate search | 500 ms or less at p95 |
| Header and counts | 1 second or less at p95 |
| First activity page | 1 second or less at p95 |
| Record details | 500 ms or less at p95 |

The UI shows a skeleton after 150 ms and a non-blocking slow-query message after 3
seconds.

## 16. Responsive Behavior

Use the existing Portal breakpoints and a 12-column desktop grid:

| Width | Behavior |
|---|---|
| 1,366 px and wider | Table and right-side details panel shown together. |
| 1,024-1,365 px | Table uses full width; details open in a drawer. |
| Below 1,024 px | Header actions move to overflow; tabs become a view selector; low-priority columns move to details. |

The Desktop window is the primary target. The design remains usable when the user
resizes the window, but a mobile-specific experience is not required.

## 17. Accessibility

- Meet WCAG 2.2 AA contrast requirements.
- Use semantic tabs, buttons, tables, and dialogs.
- Implement the WAI-ARIA tabs keyboard pattern.
- For interactive grids, manage focus and arrow-key navigation without creating
  hundreds of tab stops.
- Never communicate status by color alone.
- Give icon-only actions an accessible name and visible tooltip.
- Preserve a visible focus indicator.
- Return focus to the originating row when a details drawer closes.
- Announce loaded record counts, errors, and assignment state changes caused by a
  source refresh.

## 18. Loading, Empty, and Error States

### 18.1 Loading

- Show skeletons in the asset header and first table page.
- Do not block already loaded tabs while another tab loads.
- Preserve the selected asset and filters during refresh.

### 18.2 Empty history

Use a concise state:

```text
No related <record type> found for <asset ID> in the active Cityworks mirror.
```

An empty activity list does not change the Step 401 assignment result.

### 18.3 Source failure

Show the failed logical source name, active source version, and a retry action. Do
not expose a physical filesystem path in the user-facing message.

If Cityworks history fails but Step 401 succeeds, keep the assignment header
available and show a tab-level error. If Step 401 fails but Cityworks succeeds,
show **Assignment unavailable** while retaining history access.

### 18.4 Data integrity issue

If a branch places the same asset in both assigned and unassigned outputs, show a
red **Data issue** badge and the conflicting source tables. Do not choose one.

## 19. Security and Permissions

- Existing Portal resource permissions control access.
- `View` permission is sufficient because the resource is read only.
- User simulation follows the Desktop's existing read-only/read-write simulation
  policy, but this resource exposes no write command in either mode.
- Database files open read only.
- Queries are parameterized.
- Physical data paths and connection details are excluded from frontend payloads,
  exports, and user-facing errors.

## 20. Observability

Log one structured event per backend request with:

- resource key;
- operation;
- asset type;
- hashed or safely logged asset ID according to current Portal logging policy;
- logical source IDs and versions;
- elapsed time;
- returned row count;
- cache hit/miss; and
- success or normalized error code.

Do not log full source rows, inspection answers, request descriptions, or database
paths.

## 21. Design References

The design follows established desktop enterprise patterns rather than copying a
consumer product's visual identity:

- [Fluent 2 layout](https://fluent2.microsoft.design/layout): responsive grid,
  reflow, hierarchy, spacing, and master-detail behavior.
- [Fluent 2 toolbar](https://fluent2.microsoft.design/components/web/react/core/toolbar/usage):
  one-line commands, logical grouping, and overflow.
- [Fluent 2 tabs](https://fluent2.microsoft.design/components/web/react/core/tablist/usage):
  related information categories with a small, stable tab set.
- [Fluent 2 badges](https://fluent2.microsoft.design/components/web/react/core/badge/usage):
  concise status presentation near the object it describes.
- [Fluent 2 message bar](https://fluent2.microsoft.design/components/web/react/core/messagebar/usage):
  contextual, non-blocking source and error messages.
- [WAI-ARIA grid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/):
  accessible keyboard behavior for interactive tabular content.
- [WAI-ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/):
  accessible tab semantics and focus behavior.

## 22. Implementation Phases

### Phase 1: Read-only backend and tests

- Add resource configuration.
- Add source validation.
- Implement asset search and identity lookup.
- Implement Step 401 membership lookup.
- Implement full relationship queries.
- Add unit tests with small fixture DuckDB files.
- Add focused tests for normal and reverse `ACTIVITYLINK` directions.

### Phase 2: Dedicated resource page

- Add search-first page.
- Add compact asset header and assignment details.
- Add tabs, filters, paging, and record details.
- Add empty, stale, mixed, unavailable, and conflict states.

### Phase 3: Entry points and export

- Add Risk Map **Asset history** action.
- Register the resource in the system catalog.
- Add contextual asset links where appropriate.
- Add unified Excel export and open-after-export behavior.

### Phase 4: Performance and accessibility verification

- Verify indexes in replaceable source-generation scripts.
- Measure p95 query timings on production-size local copies.
- Test keyboard-only navigation and screen-reader labels.
- Test source-version changes and cache invalidation.

## 23. Test Matrix

At minimum, cover:

| Scenario | Expected result |
|---|---|
| Asset only in Cityworks assigned table | Assigned |
| Asset only in Cityworks unassigned table | Unassigned |
| Asset only in ITPipes assigned table | Assigned |
| Asset only in ITPipes unassigned table | Unassigned |
| Both branches agree | Shared assigned/unassigned state plus both branch badges |
| Branches disagree | Mixed; no precedence applied |
| Asset absent from all four tables | Not evaluated |
| Same branch contains asset in both tables | Data issue |
| ITPipes assigned table has several rows for one asset | One branch status with all supporting IDs available |
| Multiple work orders for one asset | All work orders shown |
| Request reached by two paths | One request row with both path badges |
| Normal and reverse activity links | Both discovered |
| No history but Step 401 result exists | Assignment shown; tabs empty |
| Step 401 source unavailable | History remains usable; assignment unavailable |
| Cityworks source unavailable | Assignment remains visible; history tab error |
| Source version changes | In-memory cache invalidated |
| Export with active filters | All matching rows exported, not only current page |
| Export with additional source fields | Selected fields are appended for every matching worksheet row |
| Invalid or stale additional field name | Field is ignored and cannot alter the generated query |

## 24. Acceptance Criteria

The resource is complete when:

1. Structures, pipes, and channels can be opened from the Risk Map and searched
   from the dedicated page.
2. Every assignment display is based solely on the four configured Step 401 output
   tables.
3. Portal contains no duplicate implementation of Step 401 classification logic.
4. Mixed, not-evaluated, unavailable, and data-conflict states are distinguished.
5. All related one-to-many service requests, investigations, inspections, and
   work orders are queryable and independently pageable.
6. Each record shows its relationship path to the selected asset.
7. No new database table or persisted application cache is introduced.
8. All database connections are read only and all user values are parameterized.
9. The page adapts to the Desktop window height and supported widths without
   unnecessary horizontal scrolling.
10. Excel export follows the unified Portal style and opens after generation.
11. Visible table fields are always exported and optional detail fields can be
    selected without per-record database queries.
12. Focused backend, frontend, relationship-direction, assignment-state, export,
    and accessibility tests pass.

## 25. Verified Current-State Notes

The design was checked against the current Step 401 workflow and production
`riskranking.db` on August 13, 2026:

- Step 401 produces separate Cityworks-only and ITPipes-only `0001` and `0004`
  outputs.
- The ITPipes assigned output can contain multiple rows for one asset.
- Some assets currently exist in both branches, and some branch classifications
  differ. This is why the UI preserves branch results and uses **Mixed** rather
  than silently applying a Portal precedence rule.
- `t_0101_RR_AC_CWOnly_Everything_AllRisk` is useful for Cityworks ranked review,
  but it is not a complete cross-branch assignment source. The resource therefore
  reads the four direct Step 401 classification outputs listed in Section 7.2.

These observations validate the data contract; runtime counts are intentionally
not embedded as permanent business rules.
