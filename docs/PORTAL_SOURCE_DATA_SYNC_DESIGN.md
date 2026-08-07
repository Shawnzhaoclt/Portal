# Portal Source Data Synchronization Design

## 1. Purpose

Portal source synchronization publishes a small, immutable, read-only SQLite
database designed for application reads. It is not a general replica of Cityworks,
ITPipes, or another source database.

The synchronization process owns source filtering, multi-table joins, custom-field
pivots, type normalization, latest-record selection, workflow classification, and
cross-source enrichment. Portal resources own authorization, user and team scope,
interactive filters, sorting, pagination, links, and presentation.

This boundary lets several resources share stable business tables without coupling a
table to a resource ID or duplicating expensive source queries in every request.

## 2. Decision: Complete Serving-Table Rebuild

The five Cityworks source tables used by Portal do not expose one dependable common
last-modified column. SQL Server Change Tracking is not enabled for the database or
those tables. A watermark based on a maximum ID, project date, inspection date, or
status date would miss edits to existing records and cannot reliably represent
deletions.

Portal therefore does not infer changed Cityworks primary keys and does not maintain
incremental synchronization state. Every scheduled run rebuilds only the final
business tables needed by Portal. Filtering, joins, ranking, pivots, and column
projection run at the source before transfer.

This approach is intentionally different from copying source tables:

- only Critical Asset Inspection work orders are selected;
- only custom fields 6, 7, 10, and 17 for those work orders are selected;
- only their entity relationships are selected;
- only Asset Inspection Forms and their linked investigations are selected;
- only inspection-to-inspection activity links involving those forms are selected;
- only columns required by the serving-table contract are transferred;
- no Cityworks or ITPipes source table is stored in the publication;
- unused ITPipes sources are not queried by this synchronization job.

The result is a complete, independently validated serving snapshot on every run.

## 3. Published Data Contract

Published tables use business-domain names. They do not contain resource IDs and do
not declare one owning resource.

### 3.1 `critical_asset_work_orders`

One row per Critical Asset Inspection work order:

- `workorder_id`
- `workorders_id`
- `description`
- `submit_to`
- `wo_closed_by`
- `status`
- `project_start_date`
- `wo_closed_date`
- `facility_id`
- `inspection_complete_date`
- `report_complete_date`
- `critical_team_status`
- `condition_risk`

The sync pivots Cityworks custom fields and enriches the row with the current maximum
condition risk for its facility. Critical Team overview, charts, cross-tabs, filters,
and details read this table.

### 3.2 `asset_inspection_workflows`

One row per pending Asset Inspection Form:

- `inspection_id`
- `asset_id`
- `inspection_date`
- `inspection_by`
- `inspection_status`
- `submit_to`
- `related_workorder_id`
- `related_wo_status`
- `critical_team_status`
- `investigation_id`
- `investigation_status`

The sync resolves the latest Critical Asset Inspection work order for the asset and
the latest linked investigation. The Planning Pending AIF QA/QC resource reads this
table. Team assignment remains an application concern because it comes from the
current system catalog and can change independently of source publication.

### 3.3 `asset_inspection_events`

One row per inspection event:

- `inspection_id`
- `event_type`
- `event_date`
- `actor_name`
- `inspection_status`

Supported event types are `completed`, `inspection`, and `project_started`. AIF
Overview performs only date filtering and lightweight aggregation over this table.

### 3.4 `facility_condition_risk_current`

One row per facility:

- `facility_id`
- `condition_risk`

This table records the enrichment input used to populate
`critical_asset_work_orders.condition_risk` and makes the published result auditable.

### 3.5 Publication metadata

`PORTAL_SYNC_METADATA` records each serving dataset, row count, duration, content
fingerprint, and publication time. The manifest
contains:

- format and publication schema version;
- immutable database path;
- publication timestamp and file size;
- overall serving-data content fingerprint;
- row count and fingerprint for each serving table;
- source profile and validation result.

## 4. No Source-Table Replication

The publication contains no `azteca_*`, `ML`, `MLI`, `MLO`, `MLO_Media`, or `Media`
tables. The sync executes approved business queries at the source and transfers only
their final result columns into the serving tables described above.

Backward compatibility belongs in the application during rollout. The updated
Desktop can read the current raw publication and the new serving publication. Once
the updated application has been distributed, the sync publishes serving schema
version 2. The new publication does not carry legacy source data merely to support an
older query implementation.

## 5. Synchronization Sequence

1. Acquire the existing single-process workstation lock.
2. Resolve and validate configuration and protected credentials.
3. Check access to required Cityworks tables and the condition-risk database.
4. Create a staging SQLite file on the configured build location.
5. Execute trusted, source-side business queries and write their final rows directly
   into serving tables.
6. Enrich condition risk and create serving-table indexes.
7. Validate required tables, columns, unique keys, row relationships, row counts,
   SQLite integrity, and queryability.
8. Calculate deterministic serving-table fingerprints.
9. Copy the verified staging database to a uniquely named immutable
    version and atomically replace `portal_sources.current.json`.
10. Retain the configured number of previous immutable versions.

The active snapshot is never edited in place. A failed run leaves both the active
database and manifest unchanged.

## 5.1 Manager Schedule Configuration

The Manager Source Data page exposes the scheduler's `schedule.intervalMinutes`
setting as a validated interval control. Administrators may select any whole-minute
interval from 1 through 1440. The value is saved to the authoritative
`sync.settings.json` used by the source-sync worker; it is not stored in the
published SQLite database.

The scheduler must be stopped while the interval is changed. The new value is
loaded the next time the scheduler starts and applies only between the configured
`firstRunTime` and `lastRunTime`. The Manager continues to show the current
interval and the next scheduled run in its Source Data status page.

## 6. Resource Query Boundary

Resource code may execute indexed SQL against serving tables for:

- authorization-derived user or team restrictions;
- supplied filter values and date ranges;
- sorting and pagination;
- lightweight grouping for interactive charts;
- URL construction and presentation labels.

Resource code must not repeat source joins, custom-field pivots, source-type parsing,
latest-related-record ranking, or cross-database risk lookups.

## 7. Credentials

Passwords are not stored in `sync.settings.json`, logs, command-line arguments,
manifests, or published databases. Non-Windows source credentials come from the
configured environment variables or a future Manager-controlled Windows credential
store. Any credential previously committed or stored in plain text must be removed
and rotated outside the application repository.

## 8. Validation and Rollout

The rollout is staged:

1. Build serving tables in a local candidate database.
2. Compare serving-table rows and resource responses with the current implementation.
3. Deploy Desktop resources that can read both current raw snapshots and serving
   schema version 2.
4. Publish the serving-only schema version 2 snapshot.
5. Monitor row counts, fingerprints, run duration, and resource errors.

Acceptance requires unit tests for transformation and fingerprints, SQLite integrity,
unique business keys, successful packaged-worker health, frontend compilation, and a
verified read of all affected resource endpoints against a schema-version-2 snapshot.
