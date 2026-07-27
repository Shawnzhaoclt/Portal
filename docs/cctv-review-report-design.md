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

## Legacy Table Design (Superseded)

The relational design below is retained only as historical reference. It is not used by the desktop runtime. Do not create, query, or modify these tables for new report data.

Table naming rule:

- Every table owned by this report resource must start with the resource ID prefix `RPT5W1C0_`.

### `RPT5W1C0_reports`

One row per logical report.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Internal ID |
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

Recommended indexes:

- Unique index on `report_key`
- Index on `binding_type`, `binding_text`
- Index on `inspection_date_text`
- Index on `status`
- Index on `updated_at`

### `RPT5W1C0_pipes`

One row per reviewed pipe in the latest saved report state. Store only source keys and user-entered review state. Pipe details such as asset name, street, manholes, material, inspection date, operator, reason, and direction should be queried from ML and MLI source tables by `ml_id` and `mli_id`.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Internal ID |
| `report_id` | INTEGER NOT NULL | FK to report |
| `ml_id` | TEXT NOT NULL | Source pipe ID |
| `mli_id` | TEXT NOT NULL | Source inspection ID |
| `clogging_percent` | INTEGER NOT NULL DEFAULT 0 | User input |
| `clogging_comment` | TEXT | User input, such as `Deposit` |
| `clogging_frame_seconds` | REAL | Video time in seconds |

Important rule:

Some pipes may have no observation records. These pipes still need a row in `RPT5W1C0_pipes` so their pipe-level inputs, such as clogging, can be saved. `Defects Scored 3+` should be calculated in the frontend from the latest distance group and observation review state, not stored.

### `RPT5W1C0_distance_groups`

One row per distance group in the latest saved report state. The distance is the minimum key needed to connect the group to observations shown in the UI.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Internal ID |
| `pipe_review_id` | INTEGER NOT NULL | FK to `RPT5W1C0_pipes.id` |
| `distance_key` | TEXT NOT NULL | Stable UI key |
| `distance_feet` | REAL | Distance shown in UI |
| `am_score` | INTEGER | User AM score, usually 3 to 5 |
| `defect_comment` | TEXT | User comment |
| `no_am_score_ge_3_confirmed` | INTEGER NOT NULL DEFAULT 0 | Boolean |

If a pipe has no observations, this table can have zero rows for that pipe.

### `RPT5W1C0_observations`

One row per observation reviewed by the user in the latest saved report state. Store only the source observation key, selected picture file name when needed, and user-selected review values. Observation details such as code, observation text, grade, source distance, media path, snapshot count, selected snapshot index, and video time should be queried from MLO source data.

Do not store `code`, `observation_text`, `grade`, `selected_snapshot_index`, `snapshot_count`, or `video_time_seconds` in this table.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Internal ID |
| `distance_group_id` | INTEGER NOT NULL | FK to distance group |
| `mlo_id` | TEXT | Source observation ID |
| `source_observation_key` | TEXT NOT NULL | Stable key from source fields |
| `defect_role` | TEXT NOT NULL | `none`, `major`, or `other` |
| `is_extensive` | INTEGER NOT NULL DEFAULT 0 | Boolean |
| `selected_picture_file_name` | TEXT | User-selected snapshot file name with extension, if different from the default |

Important rule:

Do not assume `mlo_id` is globally unique. The UI has shown cases where the same MLO ID appears more than once. Use the internal `id` and `source_observation_key` for stable identity.

### `RPT5W1C0_report_events`

Audit log for who edited a report and when.

Suggested columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Internal ID |
| `report_id` | INTEGER NOT NULL | FK to report |
| `event_type` | TEXT NOT NULL | `report_saved`, `submitted_to_review`, `returned_to_edit`, `completed`, `export_generated`, `export_failed` |
| `event_by_user_id` | INTEGER NOT NULL | User who performed the action |
| `event_at` | TEXT NOT NULL | ISO datetime |
| `from_status` | TEXT | Previous report status when applicable |
| `to_status` | TEXT | New report status when applicable |
| `memo` | TEXT | Optional user-entered memo for the action |

This table supports the requirement to show who edited the report status and at what time. It can store a short optional user memo for the action, but should not store full modification content or page snapshots.

## Coordinator-Backed Persistence

The desktop report uses the Portal Data Coordinator for every writable report operation. It does not own physical `RPT5W1C0_*` tables.

One logical report is stored as one coordinator entity:

| Coordinator field | Value |
| --- | --- |
| `entity_type` | `RPT5W1C0.report` |
| `entity_id` | `report_key` |
| entity body | Current report metadata, latest pipe review state, and report event history |

The `(entity_type, entity_id)` identity prevents duplicate report keys. The coordinator record revision provides optimistic-concurrency protection; its shared-repository protocol is the authoritative persistence path.

The entity body has three sections:

1. `report`: binding, inspection-date text, status, owner, submitter, reviewer, and timestamps.
2. `pipes`: the latest saved pipe, distance-group, and observation review state. Source properties are re-read from the local CCTV source database by `ml_id`, `mli_id`, and stable observation keys.
3. `events`: the report audit trail, including action, user, timestamp, status transition, and optional memo.

Pipes with no observations remain in `pipes` so pipe-level input such as clogging is preserved. `Defects Scored 3+` is calculated from the current review state and not stored independently. An `mlo_id` is not assumed to be globally unique; saved observations retain a stable source observation key.

All create, update, workflow, and delete actions must be committed as Data Coordinator mutations under its record lock. Direct SQL writes, route startup DDL, and independent report-table migrations are prohibited.

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
5. If no existing report entity exists, commit an `insert_entity` mutation for `RPT5W1C0.report` using `report_key` as the entity ID.
6. If report exists with `status = pending`, update the same logical entity using its current coordinator revision.
7. If report exists with `status = ready_to_review`, require the user to use `Back to Edit` before saving changes.
8. If report exists with `status = completed`, block the save because completed reports are read-only.
9. Set status to `pending`.
10. Update `updated_by_user_id` and `updated_at`.
11. Replace the entity's `pipes` section with the latest pipe, distance-group, and observation review state.
12. Append a `report_saved` event with the optional memo to the entity's `events` section.
13. Commit the report aggregate through the Data Coordinator, then generate the export file.

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
