# Proactive Team CCTV Review Report Design

## Purpose

This document defines the database design for saving Proactive Team CCTV Review report results. The report database should save the user's latest operation results, report lifecycle state, and status/action history.

The CCTV source data can still come from DuckDB and media paths. The Portal database should store only the latest reviewed result and the source record identifiers needed to query ML, MLI, and MLO records. Do not duplicate source fields that can be queried from `itpipes_ml_mainline_assets`, `itpipes_mli_mainline_inspections`, or `itpipes_mlo_mainline_observations_with_media`.

## Resource

- Resource name: Proactive Team CCTV Review
- Resource ID: `RPT5W1C0`
- Resource URL: `/report_proactive_team_cctv_review`
- Resource type: Report
- Primary users: Proactive Team, Planning Team, administrators

## Report Binding Rule

Each report is bound to one user search target:

- Address
- ProjectTitle

The binding depends on which text the user used to start the report.

Required saved search fields for each report:

- `binding_type`: `address` or `project_title`
- `binding_text`: the exact address or project title used by the user
- `inspection_date_text`: formatted date string such as `04012024` or `04012024 - 04022024`

If a report is created from an address search, `binding_type = address` and `binding_text` is the address. If it is created from a project title search, `binding_type = project_title` and `binding_text` is the project title.

## Report Key And Name

The report key should start with the normalized binding text and then append the inspection date string.

Normalization rule for the binding text:

1. Trim leading and trailing spaces.
2. Replace every run of one or more special characters with a single `_`.
3. Trim leading and trailing `_`.

For this report key rule, special characters are any characters other than letters and numbers. Spaces, punctuation, symbols, and repeated special characters should all collapse to one `_`.

Date string rule:

- Single inspection date: `MMDDYYYY`
- Date range: `MMDDYYYY - MMDDYYYY`

Example:

- Search binding: `4030 Abingdon RD.`
- Inspection date range: `04/01/2024` to `04/02/2024`
- Normalized binding text: `4030_Abingdon_RD`
- Report display name: `4030_Abingdon_RD @04012024 - 04022024`
- Report machine key: `4030_Abingdon_RD@04012024-04022024`

Additional normalization examples:

- `4030  Abingdon RD.` -> `4030_Abingdon_RD`
- `MCM510 / Phase #2` -> `MCM510_Phase_2`
- `A&B---C` -> `A_B_C`

Recommended fields:

- `report_key`: stable unique machine key
- `report_name`: user-facing display name

The machine key should avoid spaces around `@` and `-` so it is easier to use in URLs, lookups, and file names. The binding text portion of both the display name and machine key should use the same normalized binding text.

## Report Lifecycle

Recommended report statuses:

- `pending`: report has been generated and saved, and is still editable
- `ready_to_review`: report has been submitted for review
- `completed`: report has been reviewed and closed

Report creation rule:

- A report record is created only when the user clicks `Generate Report`.
- Searching, selecting pipes, editing scores, selecting snapshots, or moving between pipes should not create a database report record.
- Before the first `Generate Report` click, the review exists only as in-page working state.

Status behavior:

- `report_key` must be unique. Duplicate report keys are blocked at the database level.
- Multiple users can share and update the same logical report by loading the existing report with the same `report_key`.
- First `Generate Report` click creates the report if it does not already exist and sets the status to `pending`.
- Later `Generate Report` clicks can update the same report only while it is `pending`.
- When a report is `pending`, show a `Submit to Review` button on the page.
- `Submit to Review` can be performed by any user. It validates required pipe review checks, then sets the status to `ready_to_review`.
- When a report is `ready_to_review`, show review action buttons:
  - `Complete Review`: manager only; set status to `completed`.
  - `Back to Edit`: any user; set status to `pending`.
- Only reports with `status = ready_to_review` can be returned to edit.
- A `completed` report is closed and read-only. It cannot be returned to edit and cannot be modified by `Generate Report`.

## Save Behavior

Every time a user clicks `Generate Report`, the application should save the latest page review state to the database before or during report export.

The database does not need to store previous modification content or full page snapshots. It only keeps the most recent report state. The audit table records who performed major actions and when.

This save should be transactional:

1. Validate the current page state.
2. Create or update the report record.
3. Replace the latest pipe, distance group, and observation review rows for that report.
4. Insert an audit event.
5. Build the export file.

If export file creation fails after the database save, the saved latest report state should remain. The audit event can record `export_failed` if failure tracking is needed.

## Physical Relational Table Design

The desktop runtime stores the current report state in the following registered, typed physical tables in `stormwater.db`. These tables are authoritative for business queries and are included in full replication. They must be created and changed only through approved schema releases and migrations.

Table naming rule:

- The resource ID is `RPT5W1C0`, but the physical business tables use the stable domain prefix
  `CCTV_REVIEW_`. This keeps the storage names readable and prevents a future resource-ID
  change from forcing a physical table rename. The resource ID remains in resource metadata,
  managed entity types, and review-event records.

### `CCTV_REVIEW_REPORTS`

One row per logical report.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `global_id` | TEXT PK | Globally unique report ID used by synchronization |
| `report_key` | TEXT UNIQUE NOT NULL | Machine key, such as `4030_Abingdon_RD@04012024-04022024` |
| `report_name` | TEXT NOT NULL | Display name, such as `4030_Abingdon_RD @04012024 - 04022024` |
| `binding_type` | TEXT NOT NULL | `address` or `project_title` |
| `binding_text` | TEXT NOT NULL | Exact text used by the user |
| `inspection_date_text` | TEXT NOT NULL | `04012024` or `04012024 - 04022024` |
| `status` | TEXT NOT NULL | `pending`, `ready_to_review`, `completed` |
| `created_by_user_id` | INTEGER | Portal user ID |
| `created_at` | TEXT NOT NULL | ISO datetime |
| `updated_by_user_id` | INTEGER | Last editor |
| `updated_at` | TEXT NOT NULL | ISO datetime |
| `submitted_by_user_id` | INTEGER | User who submitted the report for review |
| `submitted_at` | TEXT | ISO datetime |
| `reviewed_by_user_id` | INTEGER | Reviewer |
| `reviewed_at` | TEXT | ISO datetime |
| `record_revision` | TEXT NOT NULL | Coordinator-managed revision |
| `deleted` | INTEGER NOT NULL DEFAULT 0 | Coordinator-managed tombstone |

Recommended indexes:

- Unique index on `report_key`
- Index on `binding_type`, `binding_text`
- Index on `inspection_date_text`
- Index on `status`
- Index on `updated_at`
- Composite index on `status`, `updated_at`

### `CCTV_REVIEW_PIPES`

One row per reviewed pipe in the latest saved report state. Store only source keys and user-entered review state. Pipe details such as asset name, street, manholes, material, inspection date, operator, reason, and direction should be queried from ML and MLI source tables by `ml_id` and `mli_id`.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `global_id` | TEXT PK | Globally unique pipe-review ID |
| `report_global_id` | TEXT NOT NULL | FK to `CCTV_REVIEW_REPORTS.global_id` |
| `ml_id` | TEXT NOT NULL | Source pipe ID |
| `mli_id` | TEXT NOT NULL | Source inspection ID |
| `clogging_percent` | INTEGER NOT NULL DEFAULT 0 | User input |
| `clogging_comment` | TEXT | User input, such as `Deposit` |
| `clogging_frame_seconds` | REAL | Video time in seconds |
| `record_revision` | TEXT NOT NULL | Coordinator-managed revision |
| `deleted` | INTEGER NOT NULL DEFAULT 0 | Coordinator-managed tombstone |

Important rule:

Some pipes may have no observation records. These pipes still need a row in `CCTV_REVIEW_PIPES` so their pipe-level inputs, such as clogging, can be saved. `Defects Scored 3+` should be calculated in the frontend from the latest distance group and observation review state, not stored.

### `CCTV_REVIEW_DISTANCE_GROUPS`

One row per distance group in the latest saved report state. The distance is the minimum key needed to connect the group to observations shown in the UI.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `global_id` | TEXT PK | Globally unique distance-group ID |
| `pipe_global_id` | TEXT NOT NULL | FK to `CCTV_REVIEW_PIPES.global_id` |
| `distance_key` | TEXT NOT NULL | Stable UI key |
| `distance_feet` | REAL | Distance shown in UI |
| `am_score` | INTEGER | User AM score, usually 3 to 5 |
| `defect_comment` | TEXT | User comment |
| `no_am_score_ge_3_confirmed` | INTEGER NOT NULL DEFAULT 0 | Boolean |
| `record_revision` | TEXT NOT NULL | Coordinator-managed revision |
| `deleted` | INTEGER NOT NULL DEFAULT 0 | Coordinator-managed tombstone |

If a pipe has no observations, this table can have zero rows for that pipe.

### `CCTV_REVIEW_OBSERVATIONS`

One row per observation reviewed by the user in the latest saved report state. Store only the source observation key, selected picture file name when needed, and user-selected review values. Observation details such as code, observation text, grade, source distance, media path, snapshot count, selected snapshot index, and video time should be queried from MLO source data.

Do not store `code`, `observation_text`, `grade`, `selected_snapshot_index`, `snapshot_count`, or `video_time_seconds` in this table.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `global_id` | TEXT PK | Globally unique observation-review ID |
| `distance_group_global_id` | TEXT NOT NULL | FK to `CCTV_REVIEW_DISTANCE_GROUPS.global_id` |
| `mlo_id` | TEXT | Source observation ID |
| `source_observation_key` | TEXT NOT NULL | Stable key from source fields |
| `defect_role` | TEXT NOT NULL | `none`, `major`, or `other` |
| `is_extensive` | INTEGER NOT NULL DEFAULT 0 | Boolean |
| `selected_picture_file_name` | TEXT | User-selected snapshot file name with extension, if different from the default |
| `record_revision` | TEXT NOT NULL | Coordinator-managed revision |
| `deleted` | INTEGER NOT NULL DEFAULT 0 | Coordinator-managed tombstone |

Important rule:

Do not assume `mlo_id` is globally unique. The UI has shown cases where the same MLO ID appears more than once. Use `global_id` and `source_observation_key` for stable identity.

### Universal `SYS_RESOURCE_REVIEW_EVENTS` (current baseline)

Review history is shared by reports, maps, documents, and forms. The fresh business
database creates one typed physical table in `stormwater.db` named
`SYS_RESOURCE_REVIEW_EVENTS`. It is replicated as business data and is written only
through the Data Coordinator. No resource-specific review-event table is created for
CCTV reports.

The stable `resource_key` identifies the resource (for example, `RPT5W1C0`), while
`subject_global_id` identifies the reviewed report, map record, document, or form
record. `resource_id` may link to the local system catalog, but it is not a cross-
database foreign key and must not be the identity used for synchronization.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `global_id` | TEXT PK | Globally unique event ID |
| `resource_id` | INTEGER | Optional local `SYS_RESOURCES.id` reference |
| `resource_key` | TEXT NOT NULL | Stable resource key such as `RPT5W1C0` |
| `resource_type` | TEXT NOT NULL | `report`, `map`, `document`, or `form` |
| `subject_type` | TEXT NOT NULL | Resource-specific subject type |
| `subject_global_id` | TEXT NOT NULL | Globally unique reviewed-record ID |
| `subject_display_key` | TEXT | Human-readable key for filtering/display |
| `event_type` | TEXT NOT NULL | Workflow or edit action |
| `actor_user_id` | INTEGER | User who performed the action, when available |
| `actor_name` | TEXT | Display name captured at event time, when available |
| `event_at` | TEXT NOT NULL | UTC ISO-8601 timestamp |
| `from_status` | TEXT | Previous status when applicable |
| `to_status` | TEXT | New status when applicable |
| `memo` | TEXT | Optional short memo; never a full page snapshot |
| `correlation_id` | TEXT | Groups related actions in one user operation |
| `record_revision` | TEXT NOT NULL | Coordinator-managed revision |
| `deleted` | INTEGER NOT NULL DEFAULT 0 | Coordinator-managed tombstone |

Standard event types are `created`, `saved`, `submitted_to_review`,
`returned_to_edit`, `approved`, `completed`, `rejected`, `export_generated`,
`export_failed`, and `deleted`. Page views are not recorded as review events; a
separate security/audit stream may be added later for login and administration events.

This table supports the requirement to show who edited a resource and at what time. It
stores only event metadata and an optional short memo; it does not store full page
snapshots or duplicated report content.

## Coordinator-Backed Persistence

The Portal Data Coordinator is the only writable entry point for this resource. It validates commands, performs the synchronization barrier and record locking, emits immutable operations, and applies those operations transactionally to the four report-state tables plus `SYS_RESOURCE_REVIEW_EVENTS`.

The stable coordinator entity types map one-to-one to registered physical tables:

| Entity type | Physical table | Entity ID |
| --- | --- | --- |
| `RPT5W1C0.report` | `CCTV_REVIEW_REPORTS` | `global_id` |
| `RPT5W1C0.pipe` | `CCTV_REVIEW_PIPES` | `global_id` |
| `RPT5W1C0.distance_group` | `CCTV_REVIEW_DISTANCE_GROUPS` | `global_id` |
| `RPT5W1C0.observation` | `CCTV_REVIEW_OBSERVATIONS` | `global_id` |
| `SYS.review_event` | `SYS_RESOURCE_REVIEW_EVENTS` | `global_id` |

`report_key` has a unique physical index and enforces one logical report for a binding and inspection date range. Coordinator record revisions provide optimistic-concurrency protection. Child records use globally unique IDs and physical foreign keys so independently created client copies converge without local integer-ID collisions.

Pipes with no observations still have physical rows so pipe-level input such as clogging is preserved. `Defects Scored 3+` is calculated from current distance-group and observation rows and is not stored independently. An `mlo_id` is not assumed globally unique; observation identity uses `global_id` and `source_observation_key`.

One report save is a single coordinator transaction that upserts the report and its current child rows, tombstones removed child rows, and inserts the audit event into `SYS_RESOURCE_REVIEW_EVENTS`. Direct SQL writes, route startup DDL, independent report migrations, and generic JSON/EAV aggregate persistence are prohibited.

### Query and Index Contract

Repositories query the physical tables directly. Optional views may provide stable relational joins or calculated display fields, but they must not flatten JSON documents at query time and are not a second persistence path.

Required indexes include:

- `CCTV_REVIEW_REPORTS(report_key)` as a unique index;
- `CCTV_REVIEW_REPORTS(status, updated_at)` for the report queue;
- binding/search indexes covering `binding_type`, `binding_text`, and `inspection_date_text`;
- indexes on every child foreign key;
- source-key indexes on `ml_id`, `mli_id`, `mlo_id`, and `source_observation_key` where used by reload or reconciliation queries.

The universal review-event table has six indexes in the current baseline:

```sql
CREATE INDEX SYS_RRE_subject_time
ON SYS_RESOURCE_REVIEW_EVENTS(
    resource_key, subject_type, subject_global_id,
    deleted, event_at DESC, global_id DESC
);

CREATE INDEX SYS_RRE_resource_time
ON SYS_RESOURCE_REVIEW_EVENTS(
    resource_key, deleted, event_at DESC, global_id DESC
);

CREATE INDEX SYS_RRE_actor_time
ON SYS_RESOURCE_REVIEW_EVENTS(
    actor_user_id, deleted, event_at DESC, global_id DESC
);

CREATE INDEX SYS_RRE_type_time
ON SYS_RESOURCE_REVIEW_EVENTS(
    resource_key, event_type, deleted, event_at DESC, global_id DESC
);

CREATE INDEX SYS_RRE_correlation
ON SYS_RESOURCE_REVIEW_EVENTS(
    resource_key, correlation_id, event_at DESC, global_id DESC
);

CREATE INDEX SYS_RRE_conflict
ON SYS_RESOURCE_REVIEW_EVENTS(
    resource_key, conflict_state, event_at DESC, global_id DESC
);
```

`global_id` is already indexed by the primary key and is only used as the stable
tie-breaker. `resource_key` leads resource queries because it is stable across client
copies; `resource_id` is only a local catalog reference. `event_at` must use UTC
ISO-8601 text so chronological ordering remains lexical. Event history screens should
use keyset pagination with `(event_at, global_id)` rather than large `OFFSET` values.

Do not index `memo`, `actor_name`, `from_status`, or `to_status` until a measured query
requires them. The current registry supports ordinary composite indexes, so the first
release includes `deleted` as an equality column instead of using an unregistered
partial-index predicate. All indexes are declared in the physical entity registry,
published through schema release/migration, followed by `ANALYZE` and representative
`EXPLAIN QUERY PLAN` validation.

Every report-list, open-report, workflow, and export query must have a reviewed `EXPLAIN QUERY PLAN` at target volume. Schema and index changes are delivered through approved coordinator migrations and become part of subsequent verified snapshots.

## Search Behavior

The report list should support search and filters by:

- `report_name`
- `report_key`
- `binding_text`
- `inspection_date_text`
- `status`
- `created_by_user_id`
- `updated_by_user_id`
- `updated_at`

For a simple search bar, search across:

- `report_name`
- `binding_text`
- `inspection_date_text`

## Generate Report Flow

When the user clicks `Generate Report`:

1. Validate all pipes in the report.
2. Ask the user to enter an optional memo.
3. Build `report_key` and `report_name`.
4. Find existing report by `report_key`.
5. If no existing report row exists, allocate a `global_id` and insert `CCTV_REVIEW_REPORTS`; the unique `report_key` index blocks duplicates.
6. If a report exists with `status = pending`, update the same physical report row using its current coordinator revision.
7. If report exists with `status = ready_to_review`, require the user to use `Back to Edit` before saving changes.
8. If report exists with `status = completed`, block the save because completed reports are read-only.
9. Set status to `pending`.
10. Update `updated_by_user_id` and `updated_at`.
11. Upsert the latest rows in `CCTV_REVIEW_PIPES`, `CCTV_REVIEW_DISTANCE_GROUPS`, and `CCTV_REVIEW_OBSERVATIONS`; tombstone child rows removed from the current report state.
12. Insert a `saved` row in `SYS_RESOURCE_REVIEW_EVENTS` with `resource_key = RPT5W1C0`, `subject_type = report`, `subject_global_id` set to the report global ID, and the optional memo.
13. Commit all physical rows and synchronization metadata atomically through the Data Coordinator, then generate the export file.

The coordinator mutation is the atomic business-data save boundary.

## Review Flow

Submit to review:

- Available to any user when `status = pending`.
- Validate all required pipe review checks.
- Set `status = ready_to_review`.
- Set `submitted_by_user_id`.
- Set `submitted_at`.
- Insert a `submitted_to_review` event.

Back to edit:

- Available to any user when `status = ready_to_review`.
- Set `status = pending`.
- Set `updated_by_user_id`.
- Set `updated_at`.
- Insert a `returned_to_edit` event.

Completed:

- Available only when `status = ready_to_review`.
- Only a manager can complete review and close the report.
- Set `status = completed`.
- Set `reviewed_by_user_id`.
- Set `reviewed_at`.
- Insert a `completed` event.

## Open Questions Before Implementation

None currently.
