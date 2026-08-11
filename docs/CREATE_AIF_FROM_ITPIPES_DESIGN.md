# Create AIF from ITPipes Resource Design

## 1. Purpose

This document defines the functional, data, workflow, and user-interface design for
the Portal Desktop resource **Create AIF from ITPipes**.

The resource lets an authorized user search for an asset, review its previous
inspection history, select an ITPipes inspection and observation, and use the
selected source information to create an Asset Inspection Form (AIF). The editable
AIF is saved in `AIF_PROACTIVE_INSPECTIONS` in `stormwater.db` and synchronized
through the Portal Data Coordinator.

The resource reads the existing configured Cityworks and ITPipes databases directly
in read-only mode. It does not create AIF-specific source copies, serving tables,
caches, staging tables, or shadow databases.

## 2. Approved Design Decisions

- Resource display name: **Create AIF from ITPipes**.
- Resource type: `form`.
- The resource opens to an **AIF Register** containing all active, non-deleted AIFs.
- Initial scope: pipe CCTV assets represented in the configured ITPipes sources.
- No new read-only source-data tables are created.
- No Cityworks or ITPipes data is copied into `stormwater.db`.
- The resource queries existing source databases through backend Python code using
  configured paths and read-only connections.
- Only the selected AIF snapshot is written to `AIF_PROACTIVE_INSPECTIONS`.
- Users may select an older ITPipes inspection; the newest is selected by default.
- The authoritative source inspection date is `MLI.Inspection_Date`.
- Inspection-date navigation uses the same one-day date-period grouping as CCTV
  Review report creation.
- One selected observation populates one AIF.
- Multiple AIFs may exist for one asset, but only one active AIF may exist for the
  same globally unique `MLO_ID`.
- Submitting an AIF requires selecting an individual reviewer. An eligible reviewer
  is either the submitter's configured direct team manager or an active user with
  effective `Review`, `Manage`, or `Admin` permission for this resource.
- A completed AIF may be reopened only by a manager or administrator.
- Previous inspections are reference information. Their values are copied only when
  the user explicitly selects **Copy values from previous AIF**.
- Future clogging fields remain in the business table but are hidden and are not
  written by this release.

The resource key is generated and maintained by Portal when the resource is
registered. It is not manually entered into the AIF business table.

## 3. Simplified Architecture

The resource uses the existing source databases and the existing Portal business
database:

```text
Configured ITPipes databases ----------- read only -----+
Configured Cityworks database ---------- read only -----+----> Resource backend
                                                        |
stormwater.db through Data Coordinator <--- read/write -+
                                                        |
                                                        +----> Portal Desktop UI
```

The backend owns:

- resolving configured database paths;
- opening source databases in read-only mode;
- parameterized source queries;
- source-specific joins and normalization;
- combining source history with Portal AIF history;
- matching existing CCTV Review records;
- validating form and workflow commands; and
- committing business changes through the Data Coordinator.

The frontend never receives a filesystem path and never opens a database. It calls
the local Portal backend through the existing Desktop request mechanism.

## 4. Database Responsibilities

### 4.1 Existing read-only source databases

The source databases retain their current tables. The resource queries only the
required rows and columns.

Expected ITPipes sources:

- `ITPipes_Defects_Merged_PT` in the configured ITPipes intermediate database
  (`${PORTAL_SHARED_DATA_ROOT}/intermediate/itpipes/itpipes.db`);
- `DEFECTS_NS_LN_MAX_CL_PT` in that same ITPipes intermediate database when
  required by verified field derivation; and
- `MLI` and `MLO` in the configured ITPipes production DuckDB
  (`${PORTAL_SHARED_DATA_ROOT}/databases_local/itpipes_stormwater_prod.duckdb`).

Expected Cityworks source:

- `CW_SCORED_ASSET_INSPECTIONS_ALL_PT` in the configured Cityworks intermediate
  database (`${PORTAL_SHARED_DATA_ROOT}/intermediate/cityworks/cityworks.db`).

The source database names, paths, and source table names are configuration values.
They are never written to the application source code.

### 4.2 Existing writable business database

The only new resource-specific business record is:

- `AIF_PROACTIVE_INSPECTIONS` in `stormwater.db`.

The resource also uses these existing shared or CCTV Review business tables:

- `CCTV_REVIEW_PIPES`;
- `CCTV_REVIEW_DISTANCE_GROUPS`;
- `CCTV_REVIEW_OBSERVATIONS`; and
- `SYS_RESOURCE_REVIEW_EVENTS`.

These tables are accessed through the Data Coordinator. The resource does not write
directly to SQLite.

### 4.3 Existing read-only system catalog

Portal accounts, resource registration, permissions, and the dictionaries used by
the form remain in the authoritative `system.db`. The resource uses the existing
`SYS_TEAMS`, `SYS_USERS`, `SYS_RESOURCES`, `SYS_RESOURCE_PERMISSIONS`,
`SYS_DICTIONARIES`, and `SYS_DICTIONARY_ITEMS` tables through the management data
session. It never stores AIF business records in `system.db`.

The table-to-database routing is fixed by role. A table with the same or a similar
name in another database is not a fallback:

| Database role | Database | Tables used by this resource |
| --- | --- | --- |
| ITPipes intermediate, read only | `${PORTAL_SHARED_DATA_ROOT}/intermediate/itpipes/itpipes.db` | `ITPipes_Defects_Merged_PT`; optional verified derivation source `DEFECTS_NS_LN_MAX_CL_PT` |
| ITPipes production, read only | `${PORTAL_SHARED_DATA_ROOT}/databases_local/itpipes_stormwater_prod.duckdb` | `MLI`, `MLO` |
| Cityworks intermediate, read only | `${PORTAL_SHARED_DATA_ROOT}/intermediate/cityworks/cityworks.db` | `CW_SCORED_ASSET_INSPECTIONS_ALL_PT` |
| Portal business, coordinator managed | local configured `stormwater.db` | `AIF_PROACTIVE_INSPECTIONS`, `CCTV_REVIEW_PIPES`, `CCTV_REVIEW_DISTANCE_GROUPS`, `CCTV_REVIEW_OBSERVATIONS`, `SYS_RESOURCE_REVIEW_EVENTS` |
| Portal system catalog, read only in Desktop | packaged `config/system.db` | `SYS_TEAMS`, `SYS_USERS`, `SYS_RESOURCES`, `SYS_RESOURCE_PERMISSIONS`, `SYS_DICTIONARIES`, `SYS_DICTIONARY_ITEMS` |

## 5. Configuration

All source database paths must be stored in `sync.settings.json` or another approved
Manager-owned configuration file. No path may be hard-coded in Python, TypeScript,
Rust, or packaged frontend assets.

Recommended configuration shape:

```json
{
  "aifSources": {
    "itpipesIntermediateDatabase": "${PORTAL_SHARED_DATA_ROOT}/intermediate/itpipes/itpipes.db",
    "cityworksIntermediateDatabase": "${PORTAL_SHARED_DATA_ROOT}/intermediate/cityworks/cityworks.db",
    "itpipesProductionDatabase": "${PORTAL_SHARED_DATA_ROOT}/databases_local/itpipes_stormwater_prod.duckdb",
    "itpipesDefectsTable": "ITPipes_Defects_Merged_PT",
    "itpipesMaximumConditionTable": "DEFECTS_NS_LN_MAX_CL_PT",
    "cityworksInspectionHistoryTable": "CW_SCORED_ASSET_INSPECTIONS_ALL_PT",
    "itpipesInspectionTable": "MLI",
    "itpipesObservationTable": "MLO"
  }
}
```

The backend resolves paths relative to the configuration file where appropriate,
validates that every required file exists, and validates table and column identifiers
against an allowlist before constructing SQL.

### 5.1 Source-schema verification prerequisite

The authoritative inspection date is `Inspection_Date` in `MLI`, matching the current
CCTV Review Report implementation. An `Inspection_Date` value found in `ML`, `MLO`,
or `ITPipes_Defects_Merged_PT` is not used as the AIF inspection-date authority.

Before implementation, source-schema verification must confirm that
`MLI.Inspection_Date` is available and can be normalized to a date. A missing or
incompatible MLI date column is a source-schema error; the resource must not silently
fall back to an observation-level date.

The exact source columns used to identify the searched asset, confirm global
`MLO_ID` uniqueness, and verify each observation's parent `MLI_ID` must also be
verified before implementation.

## 6. Runtime Source Queries

### 6.1 Asset lookup

The user enters an Asset ID. The backend:

1. trims surrounding whitespace;
2. normalizes the ID for case-insensitive exact comparison;
3. queries `ITPipes_Defects_Merged_PT` for matching rows; and
4. returns the distinct source inspection IDs associated with that asset.

Fuzzy matching is not used for Asset IDs.

If no matching ITPipes inspection exists, the response is empty and the UI shows:

> No ITPipes inspections are available for this asset. An AIF cannot be created.

### 6.2 ITPipes inspection dates

When an asset has one or more distinct `MLI_ID` values, the backend queries the
configured ITPipes production database for each corresponding
`MLI.Inspection_Date`. Each result retains its exact parent `MLI_ID` and exact source
date.

The inspection list is ordered by:

1. inspection date descending, with null dates last; and
2. `MLI_ID` ascending as the deterministic tie-breaker.

The date dropdown reuses the CCTV Review report-creation logic:

1. Normalize every non-null `MLI.Inspection_Date` to a calendar-date key.
2. Remove duplicate date keys.
3. Sort date keys newest first.
4. Group adjacent keys when the period spans no more than one calendar day.
5. Display one date when the group contains one key, or an operating-system-formatted
   date range when it contains two adjacent keys.

For example, MLI dates `2024-04-01` and `2024-04-02` appear as
`4/1/2024 - 4/2/2024` under an operating-system locale that formats dates that way.

The selected date period is a navigation filter, not an inspection identity. After a
date period is selected, the UI lists the matching MLI records in that period. The
newest MLI record is selected by default, and the user may select another MLI before
selecting an observation.

The application must implement this date-option behavior in a shared utility reused
by CCTV Review report creation and Create AIF. The one-day grouping constant must not
be independently redefined by the two resources.

The AIF saves the exact `MLI.Inspection_Date` for the selected observation's parent as
`source_inspection_date`. It never saves the displayed date-period label or range as
the source inspection date. The AIF business field `inspection_date` remains the form
submission timestamp defined by the workflow.

### 6.3 Observation query

For the selected asset and `MLI_ID`, the backend queries
`ITPipes_Defects_Merged_PT` and returns only the required observation values:

- `MLO_ID`;
- `MLI_ID`;
- `Inspection_Direction`;
- `US_ASSETID`;
- `DS_ASSETID`;
- `COND_RISK`;
- `Flooding_Impact`;
- `Flooding_Service_Eligibility`;
- `Flooding_Design_Standards`;
- `OBS_SE`;
- `OBS_CL`;
- `OBS_CL_ZOI`;
- `VCR_Time`; and
- source stationing when available.

The backend attaches the authoritative inspection date from the selected parent MLI
record to the response context. If the merged observation table also contains an
inspection-date column, that duplicate value is ignored for date authority.

Rows are sorted by:

1. `COND_RISK DESC`, with null values last;
2. source stationing ascending, with null values last; and
3. `MLO_ID` ascending as the deterministic tie-breaker.

The response is a runtime result only. It is not persisted as a new read-only table.

### 6.4 Stable source observation identity

`MLO_ID` is the globally unique observation identity. `MLI_ID` is the parent
inspection identity, and one `MLI_ID` may contain multiple observations with distinct
`MLO_ID` values.

The backend returns both IDs and verifies that the selected `MLO_ID` belongs to the
selected `MLI_ID`. It does not generate a separate source observation key. A duplicate
non-null `MLO_ID` in the source result is treated as a source-integrity error rather
than being disambiguated by stationing or row order.

The configured production `MLO` table is the authority for each observation's parent
`MLI_ID`. The merged observation row and production `MLO.MLI_ID` must agree. Source
identifiers are returned and compared as canonical text; numeric-backed identifiers
such as `104137.0` are normalized to `104137`. When the user selects an observation,
the UI carries that row's returned `MLO_ID` and parent `MLI_ID` together through
enrichment and draft creation instead of reconstructing either identifier from display
text or independent UI state.

## 7. Previous Inspection History

After a successful asset search, the backend returns a combined history from two
queries:

1. a read-only query against `CW_SCORED_ASSET_INSPECTIONS_ALL_PT` in the configured
   Cityworks intermediate database; and
2. a coordinator query against `AIF_PROACTIVE_INSPECTIONS`.

The application combines the results in memory. It does not create a union table or
attach the source and business databases to one SQLite connection.

Each history row shows:

- inspection ID;
- inspection date;
- source: `Cityworks` or `Portal AIF`;
- status; and
- inspector or initiator when available.

Rows are ordered newest first. If a Portal AIF is the latest record, the user can open
it in read-only mode or explicitly select **Copy values from previous AIF**.

Copying a previous AIF never copies:

- `global_id` or `inspection_id`;
- source MLI, MLO, or observation identity;
- initiator, inspector, reviewer, or closer identity;
- initiation, submission, inspection, or closure dates;
- status; or
- coordinator revision and synchronization fields.

## 8. CCTV Review Enrichment

After the user selects an ITPipes observation, the backend queries existing CCTV
Review business data through the coordinator.

Matching order:

1. Match `CCTV_REVIEW_OBSERVATIONS.mlo_id` to the selected globally unique `MLO_ID`.
2. Verify that the matched row's `mli_id` equals the selected parent `MLI_ID`.
3. Follow `distance_group_global_id` to `CCTV_REVIEW_DISTANCE_GROUPS`.
4. Follow `pipe_global_id` to `CCTV_REVIEW_PIPES`.

The resource must not join records using exact equality on `distance_feet`.
Stationing is a floating-point value and is not a stable identity.

Enrichment mappings:

| AIF field | Existing CCTV Review value |
| --- | --- |
| `limited_extensive` | `CCTV_REVIEW_OBSERVATIONS.is_extensive`, mapped to `Limited` or `Extensive` |
| `defect_severity` | `CCTV_REVIEW_DISTANCE_GROUPS.am_score`, mapped through the Defect Severity dictionary |
| `defect_callout` | `CCTV_REVIEW_DISTANCE_GROUPS.defect_comment` |
| future `clogging` | `CCTV_REVIEW_PIPES.clogging_percent` |

The current release may show the clogging value as source evidence, but it does not
write `clogging` or any other future clogging field to the AIF.

If no CCTV Review match exists, related fields remain null and the UI shows **No CCTV
Review value available**. If a fallback returns multiple candidates, no candidate is
selected silently.

## 9. Why Selected Source Values Are Stored in the AIF

The resource does not persist the complete source query result. It copies only the
selected values needed by the AIF.

This overlap is intentional because `AIF_PROACTIVE_INSPECTIONS` is the reviewed
business record:

- the user may edit source-derived values before submission;
- a completed AIF must not change if ITPipes data later changes;
- the AIF must remain viewable if a source database is temporarily unavailable; and
- reviewers must see the exact values that were submitted.

The AIF does not store source-only display values such as condition risk, VCR time,
upstream asset ID, downstream asset ID, or the complete observation row. It stores
only form values and the minimum source identifiers required for traceability.

## 10. Editable AIF Business Schema

`AIF_PROACTIVE_INSPECTIONS` is the authoritative editable table in `stormwater.db`.
It is registered as coordinator entity type `SYS.aif_proactive_inspection`.

The coordinator-managed `global_id`, revision, tombstone, conflict, and selected
operation fields are system storage. Users never enter or edit them.

### 10.1 Existing AIF fields

| Column | Type | Population rule |
| --- | --- | --- |
| `inspection_id` | TEXT NOT NULL | Application-generated unique business key. |
| `entity_uid` | TEXT NOT NULL | Searched Asset ID. |
| `inspection_date` | DATETIME | Set when submitted to review. |
| `inspected_by` | TEXT | Submitting user's display-name snapshot. |
| `date_closed` | DATETIME | Set when completed. |
| `closed_by` | TEXT | Completing reviewer's display-name snapshot. |
| `initiated_by` | TEXT NOT NULL | Creating user's display-name snapshot. |
| `date_initiated` | DATETIME NOT NULL | Creation timestamp. |
| `submitted_to` | TEXT | Selected reviewer's display-name snapshot. |
| `date_submitted` | DATETIME | Submission timestamp. |
| `status` | TEXT NOT NULL | `pending`, `ready_to_review`, or `completed`. |
| `updated_at` | DATETIME NOT NULL | Most recent saved or workflow-change timestamp. |
| `updated_by` | TEXT NOT NULL | Most recent actor's display-name snapshot. |
| `inspection_direction` | INTEGER | Selected source inspection direction: `1` = upstream to downstream and `0` = downstream to upstream. |
| `flooding_impact` | TEXT | Selected observation's flooding impact. |
| `flooding_service_eligibility` | TEXT | Selected observation's flooding service eligibility. |
| `flooding_design_standards` | TEXT | Selected observation's flooding design standards. |
| `defect_severity` | TEXT | Canonical Defect Severity dictionary value. |
| `defect_callout` | TEXT | CCTV Review defect comment or user-entered value. |
| `consequence_location` | TEXT | Selected observation's `OBS_CL`. |
| `consequence_location_zol` | TEXT | Selected observation's `OBS_CL_ZOI`; legacy column spelling retained. |
| `service_eligibility` | TEXT | Selected observation's `OBS_SE`. |
| `defect_stationing` | REAL | Selected ITPipes MLO observation stationing (`Distance`). |
| `limited_extensive` | TEXT | `Limited` or `Extensive`. |
| `clogging` | REAL | Reserved for future use. |
| `clogging_defect_callout` | TEXT | Reserved for future use. |
| `clogging_service_eligibility` | TEXT | Reserved for future use. |
| `clogging_related_flooding` | TEXT | Reserved for future use. |
| `clogging_related_flooding_impact` | TEXT | Reserved for future use. |
| `habitual_clogging` | TEXT | Reserved for future use. |
| `engineering_design_project` | TEXT | Reserved for future use. |

### 10.2 User identity rule

The Portal business user ID is the employee ID. It is stored as `TEXT` so formatting
and any leading zeros are preserved. `SYS_USERS.id`, when present, is an internal
database row key and must not be saved or exposed as the user identity in AIF records,
review assignments, API contracts, or audit events.

The backend resolves an employee ID to the current active `SYS_USERS` row when it
needs local relationships or permission evaluation. Business records continue to use
the employee ID.

### 10.3 Minimal provenance and actor fields

The following fields are added to trace the selected source without copying its
complete row:

| Column | Type | Description |
| --- | --- | --- |
| `source_system` | TEXT NOT NULL | `itpipes`. |
| `source_mli_id` | TEXT NOT NULL | Selected inspection identifier. |
| `source_mlo_id` | TEXT NOT NULL | Globally unique selected observation ID. |
| `source_inspection_date` | DATETIME | Original ITPipes inspection date. |
| `initiated_by_user_id` | TEXT NOT NULL | Creating user's employee ID. |
| `inspected_by_user_id` | TEXT | Submitting user's employee ID. |
| `submitted_to_user_id` | TEXT | Selected reviewer's employee ID. |
| `closed_by_user_id` | TEXT | Completing reviewer's employee ID. |
| `updated_by_user_id` | TEXT NOT NULL | Most recent actor's employee ID. |
| `active_source_mlo_id` | TEXT | Source MLO ID while the AIF is active; null after completion. |

No source database path is stored in the AIF. Display names are retained as historical
snapshots, while employee IDs provide stable user identity for authorization and
filtering.

### 10.4 Indexes and constraints

- Unique index on `inspection_id`.
- Unique index on nullable `active_source_mlo_id`.
- Index on `(updated_at DESC, global_id DESC)`.
- Index on `(entity_uid, updated_at DESC, global_id DESC)`.
- Index on `(status, updated_at DESC, global_id DESC)`.
- Index on `(source_mli_id, source_mlo_id)`.
- Index on `source_mlo_id`.
- Index on `(initiated_by_user_id, status, updated_at DESC)`.
- Index on `(submitted_to_user_id, status, updated_at DESC)`.
- Index on `(updated_by_user_id, updated_at DESC)`.
- Check constraint for `pending`, `ready_to_review`, and `completed`.

`active_source_mlo_id` equals `source_mlo_id` while the AIF is `pending` or
`ready_to_review`. It becomes null when the AIF is completed. Reopening is blocked if
another active AIF already uses the same globally unique `MLO_ID`.

## 11. Source-to-AIF Mapping

When a user selects an observation, the draft is populated as follows:

| AIF field | Source or generated value |
| --- | --- |
| `entity_uid` | Current normalized Asset ID. |
| `inspection_id` | Application-generated AIF identifier. |
| `status` | `pending`. |
| `initiated_by` | Current user's `Last Name, First Name` display value. |
| `initiated_by_user_id` | Current user's employee ID. |
| `date_initiated` | Current timestamp. |
| `inspection_direction` | Normalize the selected source `Inspection_Direction`: ITPipes `Downstream` (upstream to downstream) saves as `1`; ITPipes `Upstream` (downstream to upstream) saves as `0`. The UI displays the full text label, not the numeric code. |
| `flooding_impact` | Selected observation's `Flooding_Impact`. |
| `flooding_service_eligibility` | Selected observation's `Flooding_Service_Eligibility`. |
| `flooding_design_standards` | Selected observation's `Flooding_Design_Standards`. |
| `consequence_location` | Selected observation's `OBS_CL`. |
| `consequence_location_zol` | Selected observation's `OBS_CL_ZOI`. |
| `service_eligibility` | Selected observation's `OBS_SE`. |
| `defect_severity` | Matched CCTV Review AM score mapped through the Defect Severity dictionary. |
| `defect_callout` | Matched CCTV Review distance-group defect comment. |
| `defect_stationing` | Selected ITPipes MLO observation's stationing (`Distance`). |
| `limited_extensive` | Matched CCTV Review extensive flag. |

The provenance fields are saved with the draft. Null source values remain null; the
application does not substitute placeholder strings.

`defect_callout` uses the Pipe Defect Callout dictionary and permits approved custom
input, consistent with the CCTV Review resource.

Inspection-direction labels and persisted codes come from the authoritative
`inspection_direction` system dictionary. Code `1` is **Upstream to downstream** and
code `0` is **Downstream to upstream**. The resource must not maintain a separate
hard-coded option list.

The flooding assessment controls load their options from the authoritative
`flooding_impact`, `flooding_service_eligibility`, and
`flooding_design_standards` dictionaries. Each control includes a **Not available**
choice that persists `NULL`. Matching source values are normalized to the canonical
dictionary label before display and persistence.

## 12. AIF Identifier Generation

The application generates `inspection_id`; users cannot edit it.

Format:

```text
AIF-{normalized Asset ID}-{YYYYMMDD}-{three-digit sequence}
```

Example:

```text
AIF-P123456-20260807-001
```

Generation occurs inside the coordinator transaction after the synchronization
barrier. The coordinator acquires a unique key for the normalized Asset ID and local
calendar date, finds the highest existing sequence, allocates the next sequence, and
uses the unique index for final enforcement. A collision causes a bounded retry and
never overwrites an existing AIF.

The sequence is zero-padded to three digits (`001` through `999`) and restarts at
`001` for each Asset ID and local calendar date. Creation is blocked with a clear
validation error if all 999 sequence values for that Asset ID and date are already in
use.

The coordinator-managed `global_id` remains the distributed record identity.

## 13. Workflow

### 13.1 State model

```text
pending --Submit to review--> ready_to_review --Complete review--> completed
   ^                              |
   |-------- Return to edit ------|

pending --Delete draft--> coordinator tombstone

completed --Reopen--> ready_to_review
```

### 13.2 Create and save

Creating the first saved draft:

- generates `global_id` and `inspection_id`;
- records the minimal source provenance;
- sets `status = pending`;
- sets initiator identity and `date_initiated`; and
- creates a `created` review event.

Explicit saves update editable fields and create a `saved` event. Page views and
individual keystrokes do not create events.

Every create, explicit save, and workflow transition sets `updated_at` to the current
timestamp, `updated_by` to the actor's display-name snapshot, and
`updated_by_user_id` to the actor's employee ID in the same coordinator transaction.
These current-state fields support the AIF Register; the event table remains the
complete audit history.

### 13.3 Submit to review

Only a `pending` AIF may be submitted. Submission requires an active eligible
reviewer and successful validation. The direct manager is resolved from the
submitter's current `SYS_USERS.team_id` to the active `SYS_TEAMS.manager_user_id`.
The direct-manager path does not require a separate resource `Review` permission.
All other reviewer candidates require effective `Review`, `Manage`, or `Admin`
permission for this resource.

Submission sets:

- `status = ready_to_review`;
- `inspection_date = current timestamp`;
- `inspected_by` to the current user's display name and `inspected_by_user_id` to the
  current user's employee ID;
- `submitted_to` to the selected reviewer's display name and
  `submitted_to_user_id` to the selected reviewer's employee ID; and
- `date_submitted = current timestamp`.

It creates a `submitted_to_review` event and makes the AIF read-only to ordinary
editors.

### 13.4 Return to edit

Only a `ready_to_review` AIF may be returned. The action:

- sets `status = pending`;
- clears reviewer assignment and submission date;
- clears closure fields if present; and
- creates a `returned_to_edit` event with an optional memo.

The event history preserves the prior submission.

### 13.5 Complete review

Only a `ready_to_review` AIF may be completed. Completion:

- sets `status = completed`;
- sets `date_closed` and closer identity;
- sets `active_source_mlo_id = null`; and
- creates a `completed` event.

The AIF becomes read-only.

### 13.6 Reopen

A manager or administrator may reopen a completed AIF. Reopening:

- requires a memo;
- is blocked if another active AIF uses the same source `MLO_ID`;
- sets `status = ready_to_review`;
- clears closure fields;
- restores `active_source_mlo_id`; and
- creates a `reopened` event.

## 14. Authorization

Backend authorization is required for every operation.

| Action | Required permission |
| --- | --- |
| List, search, and filter the AIF Register | `View` |
| Export the filtered AIF Register | `View` |
| Search assets and source history | `View` |
| View an existing AIF | `View` |
| Create an AIF | `Create` |
| Edit, save, or submit a pending AIF | `Edit` or `Manage` |
| Delete a pending AIF | Draft owner, or `Delete`, `Manage`, or administrator role |
| Return or complete an assigned AIF | `Review` or `Manage` |
| Reopen a completed AIF | `Manage` or administrator role |
| View event history | `View` |

System administrators and administrators have full access. Portal Desktop user
simulation applies the simulated user's effective permissions and selected read-only
or read/write mode.

The selected reviewer must be an active Portal user who is either the submitter's
configured direct team manager or has effective `Review`, `Manage`, or `Admin`
permission for the resource. A direct manager selected through the first path may
complete or return that assigned AIF without a separate resource `Review`
permission. `Manage` and administrative permission continue to authorize review
workflow actions across assignments.

## 15. Desktop User Interface

The resource opens to the AIF Register. Creating, viewing, editing, or reviewing a
record opens a full-page, task-focused workspace aligned with Portal Desktop styling.
Its interaction model follows current Microsoft Fluent 2 guidance for toolbars,
buttons, and message bars, together with U.S. Web Design System guidance for complex
forms, validation, and data tables.

The page uses progressive disclosure and a master-detail layout. Source selection is
kept separate from form entry, but both remain visible together on a wide desktop
window. The UI does not use three equal-width columns or place the form in a narrow
side panel.

### 15.1 AIF Register

The resource opens to an **AIF Register** rather than directly opening a blank form.
It follows the CCTV Review Report list-to-workspace pattern while using AIF-specific
columns, filters, and workflow actions.

Every user with effective `View` permission can see all active, non-deleted AIFs in
the business database. Permission controls which actions the user may perform; it does
not silently remove otherwise viewable AIF rows. Coordinator tombstones are excluded
from ordinary and exported results.

The register header contains:

- a compact **Asset Inspection Forms** context label; the redundant visible
  **AIF Register** heading is omitted to preserve vertical space, while the page
  keeps an accessible `AIF Register` heading for screen readers and window structure;
- compact total and status counts;
- **Export** for the current filtered result; and
- **Create AIF** as the primary action for users with `Create` permission.

Counts are presented compactly in the header or filter bar and do not use large
summary cards.

Recommended filter views:

- **All AIFs**;
- **My drafts**: `pending` rows initiated by the current employee ID;
- **Assigned to me**: active rows assigned to the current employee ID;
- **Ready for review**; and
- **Completed**.

These are saved filters over one register and one API, not separate resources or
database tables.

The filter bar supports:

- free-text search across AIF ID, Asset ID, MLI ID, MLO ID, actor names, and actor
  employee IDs;
- status;
- source inspection-date range;
- initiated/submitted/closed date range;
- initiator;
- assigned reviewer; and
- defect severity.

Default visible columns are:

| Column | Behavior |
| --- | --- |
| AIF ID | Primary link that opens the AIF. |
| Asset ID | Searchable business asset identifier. |
| Source inspection date | Exact parent `MLI.Inspection_Date`, formatted by the OS. |
| Defect severity | Current saved AIF value. |
| Defect callout | Current saved value, truncated visually with full accessible text. |
| Status | Compact status badge. |
| Initiated by | Display name with employee ID available in details or tooltip. |
| Date initiated | Operating-system-formatted date and time. |
| Submitted to | Assigned reviewer, or `-` before submission. |
| Date submitted | Operating-system-formatted date and time. |
| Date closed | Operating-system-formatted date and time. |
| Operations | Actions returned as allowed by the backend. |

MLI ID and MLO ID are searchable and shown in the AIF workspace, but are not default
register columns. This avoids permanent horizontal width for source identifiers that
most users need only during investigation.

Default sorting is:

```text
updated_at DESC, global_id DESC
```

Filtering, sorting, counts, and pagination execute in the backend. The frontend must
not load all AIF rows and filter them in memory. Page-size options are 25, 50, and
100. Large result sets use keyset pagination based on `(updated_at, global_id)`;
changing a filter or sort returns to the first page.

Available row operations are:

| Status | Operations |
| --- | --- |
| `pending` | View, Edit, Submit to review, Events, Delete when authorized. |
| `ready_to_review` | View, Complete review, Return to edit, Events. |
| `completed` | View, Events. |
| `completed` with `Manage` or administrator role | View, Reopen, Events. |

The backend returns explicit `can_view`, `can_edit`, `can_submit`, `can_delete`,
`can_review`, and `can_reopen` flags for each row or result context. The frontend does
not reconstruct authorization from status alone.

Only a saved draft whose current status is `pending` may be deleted. The UI requires
explicit confirmation before sending the request. Deletion writes a coordinator
tombstone rather than physically removing the business row, releases the active MLO
reservation, and removes the AIF from ordinary registers and exports. A `deleted`
event records the actor and time and all existing audit events remain preserved.
Ready-to-review and completed AIFs cannot be deleted.

Selecting an AIF ID or row operation opens the full-page AIF workspace. **Back to AIF
Register** restores the previous saved view, filters, sort, page, selected page size,
and scroll position. Creating an AIF opens a new workspace and returns to the register
with the created row selected after the first save.

Export produces an XLSX file for the complete current filtered result using the same
column meanings and operating-system date/time formatting as the register. It is
permission checked and generated from a server-side filtered query, not only the
currently loaded page. Individual AIF records do not provide a separate download or
print action.

The register provides distinct loading, empty-filter, no-data, and error states. An
empty filtered result preserves the active filters and offers **Clear filters**. A
source-database outage does not prevent the register from showing already saved AIFs,
because the register reads `stormwater.db` only.

### 15.2 Page hierarchy

The wide-screen layout is:

```text
+--------------------------------------------------------------------------+
| Back   Create AIF   AIF ID   Status       Contextual actions             |
+--------------------------------------------------------------------------+
| Page-level source, validation, conflict, or locking message              |
+-----------------------------+--------------------------------------------+
| SOURCE AND SELECTION        | AIF FORM                                   |
|                             |                                            |
| Asset ID search             | Record and source summary                  |
| Inspection history          | Inspection information                     |
| Date period selector        | Flooding assessment                        |
| Inspection selector         | Defect assessment                          |
| Observation table           | Consequence and eligibility                |
|                             | Review and submission summary              |
+-----------------------------+--------------------------------------------+
```

The source pane uses approximately 35 percent of the available width and the AIF form
uses approximately 65 percent. Split-panel resizing is not required in the first
release; predictable dimensions are preferred over another persistent setting.

### 15.3 Command bar

The command bar stays visible at the top of the workspace. It is one line and never
wraps. If actions do not fit, lower-priority actions move into a labeled overflow
menu.

The left group contains:

- **Back** to the AIF list;
- resource title;
- current AIF ID when allocated; and
- status badge;

The right group contains contextually available actions:

- **Save draft**;
- **Submit to review**;
- **Return to edit** or **Complete review** when applicable;
- **Reopen** when authorized;
- **Events**; and
- lower-priority actions in the overflow menu.

Only one action receives primary visual emphasis for the current state:

| State | Primary action |
| --- | --- |
| Unsaved new or modified draft | **Save draft** |
| Saved, valid `pending` AIF | **Submit to review** |
| `ready_to_review` for an authorized reviewer | **Complete review** |
| `completed` | No primary action; **Reopen** remains restricted and secondary. |

Status-changing actions are visually separated from navigation and ordinary utility
actions. Destructive or exceptional actions are placed last and are never grouped
between common actions.

Buttons are controlled by status, permission, validation, user-simulation mode,
coordinator availability, and dirty state. When an action is unavailable, the UI
explains why using helper text or a tooltip. It does not rely on an unexplained,
low-contrast disabled button.

Closing or navigating away with unsaved changes requires confirmation.

### 15.4 Page-level message bar

A message bar appears immediately below the command bar when the user needs
page-level information. It is used for:

- source database unavailable or locked;
- no ITPipes inspection or observation found;
- form validation summary after attempted submission;
- stale coordinator revision or synchronization conflict;
- read-only or simulated-user mode; and
- completed save or workflow actions when confirmation is useful.

Error messages include a direct recovery action when one exists, such as **Retry**,
**Reload AIF**, or **Review fields**. Form-level errors are summarized in the message
bar and repeated beside the affected field. Routine successful actions use concise
language and do not display congratulatory messages.

### 15.5 Source and selection pane

The left pane follows the user's selection order:

1. Asset ID search.
2. Previous-inspection history.
3. MLI inspection-date period selector.
4. ITPipes MLI inspection selector.
5. Observation table.

The Asset ID search remains at the top. Search results do not replace the user's
current unsaved work without confirmation.

Inspection history is collapsed by default after an asset has been selected. Its
header shows the number of previous inspections and the most recent inspection date.
Expanding it shows the Cityworks and Portal AIF history. This keeps reference data
available without permanently consuming workspace height.

The date-period selector is built only from `MLI.Inspection_Date` and uses the shared
one-day grouping logic. Selecting a period filters the MLI inspection selector.

The MLI inspection selector lists exact date, MLI ID, direction, and observation
count. The newest inspection in the selected period is selected by default but is not
silently reselected after the user chooses another inspection.

The observation table:

- has a persistent header row with short, plain-language labels;
- uses one selected row to drive the form;
- keeps numeric condition-risk and stationing values consistently aligned;
- supports keyboard row navigation and selection;
- displays source loading, empty, and error states inside the table region; and
- avoids action buttons in every row when row selection performs the action.

Changing the selected observation after the user edits populated fields requires a
confirmation that identifies which values will be replaced.

Selecting an observation with a non-null condition risk score strictly below `15`
requires an advisory confirmation. The warning explains that observations with a
condition risk score greater than `15` are normally considered real risk. Canceling
leaves the current observation and form values unchanged; confirming continues the
normal selection workflow. This threshold is advisory and does not block saving.

### 15.6 AIF form pane

The form uses vertical, semantically grouped sections rather than a dense matrix. Its
primary reading and keyboard order matches its visual order.

Recommended field groups:

1. **Record and source summary**
   - generated AIF ID;
   - Asset ID;
   - MLI ID and MLO ID;
   - source inspection date; and
   - current status.
2. **Inspection information**
   - inspection direction;
   - initiation information; and
   - inspection/submission information when available.
3. **Flooding assessment**
   - flooding impact;
   - flooding service eligibility; and
   - flooding design standards.
4. **Defect assessment**
   - defect severity;
   - defect callout;
   - stationing; and
   - limited or extensive classification.
5. **Consequence and eligibility**
   - consequence location;
   - consequence location zone of influence; and
   - service eligibility.
6. **Review and submission summary**
   - initiator and dates;
   - selected reviewer after submission;
   - closer and closure date; and
   - latest workflow memo when applicable.

Most fields use a single-column vertical layout. Two short, strongly related fields
may share one row on a wide screen, but the form must not require repeated left-to-
right scanning across several columns. Each group uses a semantic fieldset and clear
group heading.

Required and optional fields are explicitly identified. Future clogging fields are
not rendered as disabled controls; they remain absent until that workflow is designed.

### 15.7 Reviewer selection

Reviewer selection is requested only when the user chooses **Submit to review**. It
does not permanently occupy space in the draft form.

The submission dialog contains:

- searchable reviewer combobox showing display name and employee ID;
- optional submission memo;
- compact summary of unresolved warnings;
- **Cancel**; and
- **Submit to review** as the single primary action.

Only active eligible reviewers appear. The submitter's configured direct manager is
listed first and identified as **Direct manager**. The remaining candidates are
active users with effective `Review`, `Manage`, or `Admin` permission for the
resource. Duplicate candidates appear only once when the direct manager also has
resource reviewer permission. If the selected reviewer becomes ineligible before
submission, the dialog keeps the user's form changes, explains the problem, and
requires another selection.

### 15.8 Validation behavior

Validation is progressive and non-disruptive:

- format feedback appears after the user interacts with a field;
- required-field validation appears when leaving the field or attempting the relevant
  workflow action;
- messages are placed directly beside the related field;
- attempted submission also shows a linked summary at the top of the form;
- focus moves to the summary and then to the first invalid field when requested; and
- errors are communicated with text and icons, not color alone.

Validation messages state what is wrong and how to correct it. They do not blame the
user or use generic messages such as **Invalid value** when a more specific
explanation is available.

### 15.9 Source indication

Automatically populated fields show their origin:

- `ITPipes observation`;
- `CCTV Review`;
- `Previous Portal AIF`; or
- `User entered` after modification.

Source is communicated through text labels or accessible info indicators, not color
alone. The original source value remains available in field details after a user
edits the draft value. A **Restore source value** action is available for an edited
source-derived field when restoration is safe.

### 15.10 History and events

Previous-inspection history remains in the collapsible source-pane section. Review
events open in a drawer or focused dialog so the user does not lose the form context.
The event list shows event, actor employee ID and display name, operating-system-
formatted time, status transition, and memo.

Individual AIF records remain available in the read-only review workspace after
completion. The AIF Register export remains the supported file-export workflow.

### 15.11 Excel export

**Export** creates an `.xlsx` workbook containing every row that matches the
currently applied AIF Register filters and sort order, rather than only the visible
page. The backend rejects exports over 10,000 rows and asks the user to narrow the
result before retrying.

The workbook follows the shared Portal Excel export standard already used by the
Planning, Critical Assets, and Critical Team resources:

- a dark-blue report title row;
- generated time, exporting user, record count, active filters, and sort order;
- light-blue column headings, borders, and alternating body rows;
- frozen headings, worksheet filters, readable column widths, and wrapped long text;
- native numeric, date, and date-time cells where the source type is known;
- landscape print settings with fit-to-width behavior; and
- protection against spreadsheet-formula injection in user-entered text.

Resource-specific behavior, including hyperlinks, total rows, and multi-level pivot
headings, remains supported by the shared template. The AIF export is produced by the
coordinator-backed API so access checks, filtering, and the 10,000-row limit cannot be
bypassed in the client. The workbook title and worksheet tab are **Asset Inspection
Form Register**, and the filename is
`Asset-Inspection-Form-Register-YYYYMMDD-HHMMSS.xlsx`.

The AIF workbook includes the Register columns plus the full business record needed
for review and analysis: source system, MLI/MLO identifiers, inspection direction,
stationing, defect classification, flooding assessment, consequence and eligibility
values, actor display names and employee IDs, workflow timestamps, and last-update
audit values. It excludes coordinator storage fields, synchronization state,
`active_source_mlo_id`, and the reserved future clogging fields.

### 15.12 Review mode

Review mode uses the same information architecture to avoid forcing reviewers to
learn a second page. The source pane remains available, while the form is read-only.
Review mode highlights:

- current saved values;
- original source values when different;
- missing or explicitly unavailable values;
- submitter, reviewer, and status information; and
- event history.

**Complete review** is the single primary action. **Return to edit** is secondary and
opens a dialog requiring or allowing a memo according to the workflow validation
rules.

### 15.13 Responsive and accessibility behavior

At wide Desktop sizes, the page uses the 35/65 two-pane layout. When the application
window becomes too narrow for both panes to remain usable, the workspace switches to
two top-level views: **Source selection** and **AIF form**. The current selection and
unsaved form state are preserved while switching views.

The implementation must provide:

- logical DOM and keyboard focus order;
- visible keyboard focus;
- labeled toolbar, table, dialogs, and form groups;
- accessible names for icon-only controls;
- adequate text, icon, border, and focus contrast;
- no information conveyed by color alone;
- predictable table headers and column formatting; and
- announcements for loading, source errors, save results, and status changes.

Displayed dates and times follow the operating-system locale and omit fractional
seconds. Stored timestamps remain normalized UTC ISO-8601 values.

### 15.13 Design references

- [Microsoft Fluent 2 Toolbar](https://fluent2.microsoft.design/components/web/react/core/toolbar/usage)
- [Microsoft Fluent 2 Button](https://fluent2.microsoft.design/components/web/react/core/button/usage)
- [Microsoft Fluent 2 Message bar](https://fluent2.microsoft.design/components/web/react/core/messagebar/usage)
- [U.S. Web Design System Form](https://designsystem.digital.gov/components/form/)
- [U.S. Web Design System Table](https://designsystem.digital.gov/components/table/)
- [U.S. Web Design System Progress easily pattern](https://designsystem.digital.gov/patterns/complete-a-complex-form/progress-easily/)
- [U.S. Web Design System Keep a record pattern](https://designsystem.digital.gov/patterns/complete-a-complex-form/keep-a-record/)

## 16. Backend API Responsibilities

The resource API provides these logical operations:

| Operation | Data access |
| --- | --- |
| Search Asset ID | Direct read-only ITPipes query. |
| List inspections | Direct read-only ITPipes query. |
| List observations | Direct read-only ITPipes query plus coordinator CCTV lookup. |
| Load inspection history | Direct read-only Cityworks query plus coordinator AIF query. |
| List, count, filter, sort, or load AIFs | Coordinator query. |
| Export the filtered AIF Register | Coordinator query plus XLSX generation. |
| Create or save draft | Coordinator mutation. |
| Submit, return, complete, or reopen | Coordinator mutation. |
| Load event history | Coordinator query. |

Source responses contain only fields needed by the UI. They never expose connection
strings, credentials, or filesystem paths.

The AIF Register list operation accepts:

- saved-view key;
- free-text search;
- status;
- source inspection-date range;
- initiated/submitted/closed date range;
- initiator employee ID;
- reviewer employee ID;
- defect severity;
- approved sort column and direction;
- page size; and
- keyset cursor.

The response contains rows, total filtered count, compact status counts, next and
previous cursor information when available, current filter metadata, and backend-
calculated action flags. Text search uses escaped parameters and approved indexed
columns. Sort expressions come from a backend allowlist and never accept raw SQL.

The export operation accepts the same filter and sort contract but no page cursor. It
generates the complete authorized filtered result. A practical maximum export size
and a clear error for exceeding it must be defined during implementation based on
measured workbook memory and generation time.

## 17. Source Connection and Query Safety

- Open source databases with explicit read-only connections.
- Use short-lived connections scoped to one request or bounded service operation.
- Use parameterized values for Asset IDs and inspection IDs.
- Validate configured table and column identifiers before SQL construction.
- Select only required columns and rows.
- Apply reasonable query timeouts where supported.
- Close connections in `finally` blocks.
- Never execute DDL, `INSERT`, `UPDATE`, `DELETE`, `COPY`, or export operations against
  a source database.
- Never attach `stormwater.db` to a source database connection.
- Combine source and business results in Python using normalized identifiers.

DuckDB normally enforces a process-level file lock. If DBeaver or another process has
opened a source database in a conflicting mode, the resource may be unable to open
it. The backend returns a clear **Source database is currently unavailable or locked**
error and does not create a partial AIF. The application does not terminate or modify
the other process.

## 18. Coordinator Persistence and Events

All business writes use the Portal Data Coordinator. Direct SQLite writes, route
startup DDL, and resource-specific databases are prohibited.

One create, save, delete, or workflow operation is one coordinator transaction containing:

1. the AIF insert, update, or tombstone mutation; and
2. the `SYS_RESOURCE_REVIEW_EVENTS` insert.

Review events use:

- `resource_type = form`;
- the generated catalog resource key;
- `subject_type = aif_proactive_inspection`;
- `subject_global_id = AIF global_id`; and
- `subject_display_key = inspection_id`.

Supported event types:

- `created`;
- `saved`;
- `submitted_to_review`;
- `returned_to_edit`;
- `completed`; and
- `reopened`; and
- `deleted`.

Events contain the actor's employee ID as `actor_user_id`, actor display name, event
time, previous status, new status, optional memo, and correlation ID. The universal
review-event schema must define `actor_user_id` as `TEXT`; an internal `SYS_USERS.id`
value is not written there. Events do not store complete form snapshots.

Coordinator revisions provide optimistic concurrency. A stale save returns a
conflict response and never overwrites newer work.

## 19. Validation and Error Handling

### 19.1 Draft requirements

A draft requires:

- Asset ID;
- source MLI ID;
- globally unique source MLO ID;
- generated inspection ID;
- initiator identity and date; and
- no existing active AIF for the same source MLO ID.

### 19.2 Submission requirements

Submission additionally requires:

- an active reviewer who is either the submitter's configured direct manager or has
  effective `Review`, `Manage`, or `Admin` permission for the resource;
- all business-required AIF fields;
- defect severity or explicit unavailable confirmation;
- defect callout or explicit unavailable confirmation; and
- no unresolved ambiguous CCTV Review match.

The final mandatory business-field list must be confirmed with the AIF business owner
before implementation. The API returns field-specific validation messages.

### 19.3 Distinct user-facing errors

The resource distinguishes:

- Asset ID was not found;
- no ITPipes inspection exists;
- no observation exists for the selected inspection;
- a source database is missing, unavailable, or locked;
- required source schema changed;
- CCTV Review enrichment is unavailable or ambiguous;
- duplicate active AIF exists;
- selected reviewer is no longer eligible;
- coordinator revision changed; and
- `stormwater.db` or shared synchronization is unavailable.

`system.db` is never used as a fallback business database.

## 20. Schema Release

The provenance fields, actor IDs, current-update fields, Register indexes, and
constraints are delivered through the existing Portal Manager database
schema-maintenance workflow:

1. register the target packaged schema;
2. inspect and edit the migration plan;
3. validate on a temporary business-database copy;
4. publish the approved migration;
5. install it through normal coordinator startup; and
6. block AIF writes until the installed release and physical fingerprint match.

Existing `AIF_PROACTIVE_INSPECTIONS` rows are preserved. New provenance fields remain
nullable for legacy rows but are required for AIFs created after the new schema is
active. Migration backfills `updated_at` from the best available existing lifecycle
date and backfills `updated_by` and `updated_by_user_id` from the corresponding actor
when available. Unresolvable legacy actor values remain clearly identified rather
than being assigned to the migration operator.

## 21. Testing and Acceptance Criteria

### 21.1 Source access

- All database paths come from configuration.
- No AIF-specific read-only source table or database copy is created.
- Source connections are opened read only and always closed.
- Asset, inspection, observation, and history queries return only required columns.
- Source-schema changes produce a clear error.
- A locked source produces a clear error and no AIF write.

### 21.2 Search and observation selection

- Asset search is exact after case and whitespace normalization.
- An asset with no ITPipes inspection cannot start an AIF.
- Inspection dates come from `MLI.Inspection_Date`, never MLO or the merged
  observation table.
- Distinct MLI dates use the same one-day date-period grouping as CCTV Review report
  creation.
- A displayed date range filters inspections but is never stored as an AIF source
  inspection date.
- Multiple MLI inspections are ordered correctly and the newest is selected by
  default.
- Users can select an older inspection.
- Observations are ordered by condition risk and deterministic tie-breakers.
- One MLI ID may return multiple observations with distinct MLO IDs.
- Duplicate non-null MLO IDs are rejected as a source-integrity error.
- Cityworks and Portal AIF history are combined correctly in memory.

### 21.3 Mapping and enrichment

- Every approved source field maps to the correct AIF field.
- Only the selected AIF values and minimal provenance are persisted.
- Condition risk, VCR time, upstream/downstream IDs, and complete observation rows are
  not copied into `stormwater.db`.
- CCTV matching uses stable identities, not floating-point equality.
- Missing enrichment leaves null fields and shows a clear message.
- Ambiguous enrichment does not populate fields automatically.
- Defect severity uses the authoritative Defect Severity dictionary.
- Future clogging fields remain unwritten.

### 21.4 AIF Register

- The resource opens to the AIF Register.
- Every user with `View` permission sees all active, non-deleted AIFs.
- Saved filter views return the correct rows for the current employee ID.
- Free-text, status, date, actor, reviewer, severity, and source-ID filters work in
  combination.
- Sorting and page-size changes are executed by the backend.
- Keyset pagination produces no duplicate or skipped rows while the underlying result
  remains unchanged.
- The default order is `updated_at DESC, global_id DESC`.
- Each row exposes only backend-authorized actions for the current user and mode.
- Opening an AIF and returning restores filters, sorting, page size, cursor position,
  and scroll position.
- A source-database outage does not prevent saved AIFs from appearing.
- Filtered XLSX export contains the complete authorized result rather than only the
  loaded page.
- Exported dates follow the operating-system format and omit fractional seconds.
- Authorized pending AIFs expose Delete, require confirmation, create a `deleted`
  event, and become coordinator tombstones excluded from ordinary lists and exports.
- Ready-to-review and completed AIFs cannot be deleted.
- Empty, loading, no-data, filtered-empty, and error states are distinguishable and
  accessible.

### 21.5 Workflow and permissions

- Only authorized users can create, edit, submit, delete, review, complete, or reopen.
- Reviewer selection includes the submitter's active configured direct manager and
  active users with effective `Review`, `Manage`, or `Admin` permission; the direct
  manager appears first and can act on the AIF assigned to them.
- Duplicate active AIFs for the same observation are blocked.
- All status actions update the approved fields.
- Completed AIFs are read-only.
- Reopening requires a memo and clears closure fields.
- Every save and transition creates its event atomically.
- Stale revisions never overwrite newer edits.

### 21.6 Packaging

- Portal Desktop contains no source paths or credentials.
- Portal Desktop writes business data only through the coordinator.
- The resource works in normal and administrator user-simulation modes.
- The production application is rebuilt and verified at
  `dist/Portal-Desktop/Portal.exe` after implementation.

## 22. Implementation Sequence

1. Verify `MLI.Inspection_Date`, Asset ID matching columns, global MLO ID uniqueness,
   and the MLI-to-MLO one-to-many relationship.
2. Add and validate configured AIF source settings.
3. Implement shared read-only source connection and query services.
4. Add and publish the `AIF_PROACTIVE_INSPECTIONS` schema migration.
5. Register the form resource and permissions.
6. Implement coordinator-backed AIF Register list, count, filter, pagination, action
   flags, and export APIs.
7. Implement asset, history, inspection, observation, and CCTV enrichment APIs.
8. Implement coordinator-backed create, save, workflow, and event APIs.
9. Implement the AIF Register, full-page workspace, and review mode.
10. Run source, schema, Register, export, mapping, permissions, workflow, concurrency,
    frontend, and packaging verification.

No implementation step may create an AIF-specific source copy, hard-code a source
path, write to a source database, bypass the schema release, or bypass coordinator
persistence.
