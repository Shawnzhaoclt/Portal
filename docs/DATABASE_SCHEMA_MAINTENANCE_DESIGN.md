# Portal Database Schema Maintenance Design

## 1. Purpose

This module provides a controlled, versioned mechanism for changing Portal database
structures without losing local business data or breaking LAN synchronization.

It supports:

- creating, deprecating, and eventually removing tables;
- adding, renaming, deprecating, and eventually removing fields;
- creating and changing indexes and constraints;
- maintaining GeoPackage metadata, geometry columns, and R-Tree indexes;
- migrating an existing local `stormwater.db` safely;
- validating compatibility between the App, schema catalog, snapshots, and operation
  packages;
- recording exactly which migrations ran, with hashes and outcomes;
- recovering or rolling back after interruption.

This design complements `LAN_OFFLINE_VECTOR_DATA_SYNC_DESIGN_EN.md`. The data
coordinator remains the only runtime writer to `stormwater.db`; resource code may not
execute schema changes directly.

## 2. Database Classes

### 2.1 `system.db`

`system.db` is read-only at runtime and is distributed with the App. It contains users,
teams, resources, permissions, and the schema catalog understood by that App version.

Clients never migrate `system.db` in place. A new App build supplies a complete,
validated replacement. The old copy remains part of the previous portable release.

### 2.2 `stormwater.db`

`stormwater.db` is the local writable SQLite/GeoPackage business database. It contains:

- declared business tables and spatial layers;
- GeoPackage metadata and local R-Tree indexes;
- synchronization state, drafts, inbox/outbox, conflicts, and cursors;
- local schema installation and migration history.

SchemaManager upgrades this database through a temporary local copy followed by an
atomic replacement. It never migrates a database directly on the network share.

### 2.3 Snapshots and `.opdb` Packages

Snapshots are immutable, complete `stormwater.db` baselines at one schema release.
Operation packages are immutable transaction artifacts and are never migrated.
Consumers either understand the package schema version or defer/block it without
advancing the terminal cursor.

## 3. Architecture

```text
Packaged App
  config/system.db
    SYS_SCHEMA_RELEASES
    SYS_SCHEMA_TABLES
    SYS_SCHEMA_FIELDS
    SYS_SCHEMA_GEOMETRY
    SYS_SCHEMA_MIGRATIONS
  trusted Python migration implementations

Shared repository
  protocol-v1/schema/current.json
  protocol-v1/schema/releases/<release-id>/
    manifest.json
    catalog.json
    migration-plan.json

Local client
  data/stormwater.db
    sw_schema_install_state
    sw_schema_migration_history
    business and synchronization tables
```

The shared release selects a target schema. Executable migration logic is trusted code
shipped with the App, not arbitrary SQL downloaded from the share.

## 4. Core Components

| Component | Responsibility |
| --- | --- |
| `SchemaCatalog` | Reads normalized allowlisted table, field, geometry, index, and policy definitions from packaged `system.db` |
| `SchemaReleaseValidator` | Verifies shared release pointer, hashes, version compatibility, migration continuity, and required capabilities |
| `SchemaPlanner` | Builds the exact ordered migration path from the installed release to the target release |
| `MigrationRegistry` | Maps immutable migration IDs to packaged Alembic revisions or exceptional trusted Python handlers and verifies their checksums |
| `SchemaManager` | Runs preflight, backup/copy, migration, validation, and atomic installation |
| `GeoPackageAdapter` | Owns `gpkg_*`, geometry BLOB, SRS, geometry constraints, and R-Tree maintenance |
| `SchemaHealthValidator` | Checks SQLite, foreign keys, schema fingerprint, GeoPackage metadata, geometry/SRS, and R-Tree |
| `SchemaPublisher` | Workstation-only tool that builds, validates, and publishes immutable releases and current pointers |

Proposed source locations:

```text
python/portal/app/schema/
  catalog.py
  manager.py
  migrations.py
  geopackage.py
  validation.py
  models.py

portal-manager/sync/schema/
  build_release.py
  publish_release.py
  validate_release.py
```

### 4.1 Migration Engine Choice and Integration Boundary

Use a **hybrid Portal + Alembic architecture**. Alembic is the internal open-source
migration engine for revision identifiers, ordered upgrade paths, table creation,
table/field renames, table removal, and SQLite batch table rebuilds. Alembic is not the
public maintenance interface and must not connect directly to the shared repository.
Portal Workstation Manager remains the only schema-authoring and publication interface.

`SchemaManager` remains the controlling layer because Alembic alone does not provide:

- temporary-copy migration and atomic database replacement;
- Portal release-manifest and checksum validation;
- synchronization barriers, snapshot compatibility, or operation-log drain checks;
- GeoPackage metadata, geometry, SRS, and R-Tree validation;
- Portal-specific recovery reports and startup policy.

Migration revisions call `GeoPackageAdapter` for spatial changes and are registered in
`MigrationRegistry`. A revision file is packaged with the App and its checksum is listed
in the schema release. SQL or Python migration code from the network share is never
executed. The shared release contains only normalized catalog data, revision IDs,
checksums, and migration parameters.

The Manager generates migration drafts from typed catalog changes; it does not accept
arbitrary Alembic scripts or SQL. Ordinary structural operations map to reviewed Alembic
operations:

| Manager operation | Alembic implementation |
| --- | --- |
| Add table | `op.create_table(...)` plus declared indexes and constraints |
| Rename table | `op.rename_table(...)` with stable `table_id` retained |
| Add field | `op.add_column(...)`; staged when required or backfilled |
| Rename field | `op.alter_column(..., new_column_name=...)`, using SQLite batch mode when required |
| Add/drop index | `op.create_index(...)` / `op.drop_index(...)` |
| Remove field | Batch-table rebuild after the deprecation and drain releases |
| Remove table | `op.drop_table(...)` only after the deprecation and drain releases |

The Portal wrapper supplies the existing temporary-copy, validation, publication, and
rollback controls around Alembic. An Alembic revision is never allowed to replace those
controls or write directly to the active shared snapshot.

### 4.2 Implemented Schema Foundation

The initial desktop implementation is available under `python/portal/app/schema/`:

- `physical_entities.py` is the packaged source of truth for every editable
  business entity. It registers each entity with a stable resource/entity key,
  physical table name, typed columns, dependency order, delete policy, and
  indexes. It does not discover arbitrary SQLite tables and it never uses a
  generic JSON/EAV table as the authoritative business store.
- `catalog.py` materializes the complete packaged registry in a temporary
  database, fingerprints the physical tables and indexes, and registers that
  catalog in `system.db`. The same path is used for the initial schema and for
  every later business table or field addition.
- `SYS_SCHEMA_MIGRATIONS` stores immutable migration identifiers, ordered release
  transitions, handler names, specifications, and checksums.
- `SYS_SCHEMA_GEOMETRY` is present now for future GeoPackage layer metadata; the
  current `stormwater.db` release has no spatial tables to register.
- `manager.py` creates `SW_SCHEMA_INSTALL_STATE` and
  `SW_SCHEMA_MIGRATION_HISTORY` in the local business database, validates the physical
  schema, and upgrades through a temporary local SQLite copy followed by an atomic
  replacement.
- `migrations.py` contains trusted, packaged Python handlers. The current
  `PORTAL_COORDINATOR_BASELINE` handler registers the existing business schema without changing
  report data. Declarative compatible migrations are limited to validated additive
  columns and indexes; destructive or spatial changes require a dedicated handler.

Alembic is connected to the implemented migration path through the packaged
`alembic_structural` handler. The Manager Schema page supports Add Table, Rename Table,
Add Field, Rename Field, Add Index, and Drop Index as typed drafts. These operations are
resolved from stable logical IDs to reviewed physical operations, tested on a copy of the
active snapshot, and then executed inside `SchemaManager`. Immediate Drop Field and Drop
Table remain intentionally unavailable until deprecation and drain evidence can be
recorded and enforced.

Older installations may still report `stormwater.db` as registered at
`portal-coordinator-baseline`. New registrations receive a dated release identifier.
The catalog is held in the read-only packaged `system.db`. The Manager now publishes
verified LAN schema snapshots through the shared protocol repository; the catalog
database itself remains ordinary SQLite until spatial tables require GeoPackage
metadata.

### 4.3 Platform-Wide Table Registration and Add Table Workflow

The physical-table rule applies to all current and future business tables, not only
the CCTV review tables. Physical names use stable business-domain terms. The schema
catalog describes database structure only; it does not model which Portal resources
read or write a table.

Portal Workstation Manager must provide an **Add table** action on the Schema page. The
action opens a typed table designer containing:

- application-generated opaque table identity, maintained internally and never typed by an administrator;
- physical table name, validated against the domain-prefix convention;
- business fields, SQLite affinities, nullability, defaults, and business keys;
- indexes, unique constraints, foreign keys, dependency order, and delete policy;
- synchronization, replication, conflict, and geometry settings;
- generated system-managed identity, revision, tombstone, conflict, and operation fields.

Saving the designer adds an unpublished catalog draft and generated Alembic revision;
it never creates a table in the live database. The draft must pass diff, temporary-copy
testing, review, and publication before activation.

A new resource must complete this workflow before its first formal save is enabled:

1. Create the table draft in Portal Workstation Manager. Until the Manager designer is
   implemented, add one reviewed `PhysicalEntitySpec` to the packaged registry in
   `python/portal/app/sync/physical_entities.py`. The specification must define a stable
   entity type, domain-prefixed physical table name, logical
   columns, SQLite types, dependency order, delete behavior, and required indexes.
   Sequence fields are expanded into explicitly typed physical columns.
2. Add the entity's trusted application/repository adapter. It may use the generic
   typed-table coordinator helpers for ordinary CRUD, but table-specific foreign
   keys, check constraints, spatial metadata, or derived projections must be
   declared in a packaged migration handler. No resource may create DDL from a
   request or from a network file.
3. Run the registry validator and scale tests against a production-shaped database.
   Registration fails if a table/key/index is duplicated, a column is untyped, an
   identifier is unsafe, or a managed entity is missing from the registry.
4. In Portal Workstation Manager, inspect the generated Alembic revision, normalized
   catalog, structural diff, and migration plan. Test the draft and then register and
   publish the dated release. Unchanged catalog content is idempotent and does not
   create a new release; changed content creates a new release chained to the active
   one.
5. Validate the migration on a temporary copy, publish the verified snapshot, and
   let clients install it through the normal schema/coordinator startup flow. A
   client blocks edits until the physical fingerprint and trusted release match.

This means adding the 51st or 500th table follows the same controlled path as adding
the first table. The coordinator remains generic, while the registry and trusted
migrations provide the table-specific contract needed for millions of rows.

### 4.4 Editable AIF inspection business table

The editable Asset Inspection Form data is registered as the system-owned business
entity `SYS.aif_proactive_inspection` and is materialized in the physical table
`AIF_PROACTIVE_INSPECTIONS`. It is not part of read-only Cityworks source sync.
The table keeps the approved business columns below:

```text
inspection_id, entity_uid, inspection_date, inspected_by, date_closed,
closed_by, initiated_by, date_initiated, submitted_to, date_submitted, status,
inspection_direction, flooding_impact, flooding_service_eligibility,
flooding_design_standards, defect_severity, defect_callout,
consequence_location, consequence_location_zol, service_eligibility,
defect_stationing, limited_extensive, clogging, clogging_defect_callout,
clogging_service_eligibility, clogging_related_flooding,
clogging_related_flooding_impact, habitual_clogging,
engineering_design_project
```

`inspection_id` is enforced as a unique business key. The coordinator also
maintains indexes on `entity_uid` and `status`, and maps the date, integer, and
real-valued fields to their declared SQLite affinities. The coordinator's internal
identity, revision, tombstone, conflict, and selected-operation columns remain
outside the business contract and are added consistently to every physical table.

#### 4.4.1 Proactive CCTV source-derived business tables

The CCTV resource also registers the three editable business tables below through the
same physical-entity registry. They are local business-data tables in `stormwater.db`;
the read-only ITPipes DuckDB/SQLite source files remain source data and are never opened
for writes by the desktop resource.

| Entity type | Physical table | Business key and indexes |
| --- | --- | --- |
| `RPT5W1C0.mlo` | `MLO` | Unique `MLO_ID`; indexes on `MLI_ID` and `Code` |
| `RPT5W1C0.media` | `Media` | Unique `Media_ID` |
| `RPT5W1C0.mlo_media` | `MLO_Media` | Indexes on `MLO_ID` and `Media_ID`; unique `(MLO_ID, Media_ID)` relationship |

The MLO table stores the observation values, dimensions, clock positions, grade, and
display metadata. The Media table stores the media identity and file metadata. The
MLO_Media table stores the many-to-many relationship between observations and media.
The coordinator adds its standard `global_id`, revision, tombstone, conflict, and
selected-operation columns to all three tables, so business identifiers remain stable
while conflict resolution remains generic.

### 4.5 Administration and schema-maintenance GUI boundary

Portal Desktop is an end-user client. It may inspect the installed schema and apply an
approved compatible release through the coordinator, but it must not expose a schema
editor, edit the system catalog, publish releases, or execute DDL. These operations are
owned by the standalone `PortalManager.exe`.

The workstation manager contains two distinct protected modules in one executable:

| Module | Scope |
| --- | --- |
| Portal Administration | Users, teams, roles, resources, permissions, dictionaries, holidays, and the read-only system publication build |
| Database Maintenance | Physical business-table catalog, fields, indexes, constraints, migration drafts, tests, schema release publication, snapshots, backups, and recovery |

This is a responsibility boundary, not a second database engine or a second
executable. Both modules call the same trusted Python coordinator commands through the
manager's Rust task boundary. They share maintenance leases, progress events, audit
records, and release validation. The GUI must never provide an arbitrary SQL/DDL input
box and must never execute migration code downloaded from the shared drive.

#### Schema editor model

The Schema page edits a versioned desired catalog rather than the live business file.
The editor provides:

- an **Add table** action and typed table designer;
- a table tree showing physical table name, application-maintained stable identity,
  row-volume estimate, geometry metadata, and current indexes;
- explicit **Rename table**, **Deprecate table**, and guarded **Remove table** actions;
- a field editor for name, SQLite affinity, nullability, default, uniqueness, and
  deprecation state;
- explicit **Add field**, **Rename field**, **Deprecate field**, and guarded
  **Remove field** actions;
- an index/constraint editor with indexed columns, order, uniqueness, and scope;
- dependency and foreign-key review, including GeoPackage metadata and R-Tree impact;
- a dated draft release identifier such as `portal-coordinator-2026-217`;
- generated structural diff, data-loss warnings, estimated rebuild cost, and affected
  resources before any migration is approved.

The editor writes a draft specification into the workstation's controlled maintenance
workspace. It does not write directly to `stormwater.db`, `system.db`, or a shared
snapshot.

#### Required schema-change workflow

Every change follows the same path:

1. **Draft** - create a date-based release and modify the typed physical catalog.
2. **Diff** - calculate ordered table, field, index, constraint, and spatial changes;
   flag destructive changes and impacted resources.
3. **Test** - apply the trusted migration to a local production-shaped copy, including
   large-table and representative GeoPackage tests. Verify row counts, key indexes,
   foreign keys, geometry metadata, and coordinator replay.
4. **Review and approve** - record the operator, selected role, release ID, catalog
   hash, test report, backup ID, and approval decision.
5. **Publish** - under the maintenance lease, publish immutable release artifacts and
   the new schema pointer. Build and verify a compatible full snapshot before clients
   are allowed to edit.
6. **Apply** - clients acquire the normal schema/snapshot transition lock and migrate a
   local copy through the coordinator, then atomically install it.
7. **Recover** - on failure, retain the prior valid copy and use the verified backup or
   previous snapshot; never repair a live database by hand.

Drafts may be revised before approval. Published releases and migration history are
immutable. A changed catalog always receives a new date-based release; numeric names
such as `v1` and `v2` are not used as human-facing release identifiers.

#### Change policy for large business tables

The platform assumes future business tables may contain millions of rows. Therefore:

- every managed table is a physical typed table, never a generic JSON/EAV container;
- high-selectivity lookup, relationship, status, time, and synchronization columns must
  declare indexes in the catalog;
- an index change must include an online-size estimate and a temporary-copy test;
- required fields are introduced as nullable/defaulted fields, backfilled, validated,
  and only then made strict in a later release;
- table/field renames use stable IDs and explicit mappings, never name guessing;
- table rebuilds and destructive changes are isolated from the live database and require
  a verified backup, maintenance lease, typed confirmation, and rollback evidence;
- schema publication is blocked if the migration would exceed configured free-space,
  timeout, or synchronization-drain limits.

#### Authorization and audit

Portal Administration and Database Maintenance use the currently selected Portal role,
not merely roles present on the Windows account. Administrators may prepare catalog and
management drafts. System administrators approve and publish system/business schema
releases, destructive changes, rollback, and recovery. Every draft, diff, test,
approval, publication, migration, and restore records the actor, workstation, selected
role, timestamp, release IDs, hashes, affected tables, and report path.

## 5. Release Naming Model

Human-facing release identifiers do not use numeric labels such as `v1` or `v2`.
Legacy installations may retain `portal-coordinator-baseline`, but new registrations
and publications use the publication year and day of year, for example
`portal-coordinator-2026-215`.
Migration identifiers follow the same rule, such as `PORTAL_COORDINATOR_2026_215`.
The integer `schema_version` remains internal compatibility metadata and is not a
human-facing release name. Legacy handler names containing `_v1` remain readable only
for compatibility with previously published catalogs; new metadata never emits them.

Every release has both a monotonic integer version and a content identity:

```json
{
  "schema_version": 2,
  "schema_release_id": "portal-coordinator-2026-215",
  "previous_release_id": "sha256:<previous-hash>",
  "coordinator_version": "0.1.0",
  "python_runtime_version": "3.x.y",
  "dependency_lock_sha256": "sha256:<lock-hash>",
  "minimum_app_version": "1.0.0",
  "required_capabilities": ["generic-table-v1", "geometry-gpkg-v1"],
  "migration_ids": ["PORTAL_COORDINATOR_2026_215"]
}
```

The catalog hash still identifies the exact structure, while the descriptive release
name identifies the publication. A migration ID reused with a different checksum is
fatal.

## 6. Catalog Tables in `system.db`

### `SYS_SCHEMA_RELEASES`

- schema version and release ID;
- previous release ID;
- normalized catalog hash;
- minimum App/coordinator/Python versions;
- required capabilities;
- active/deprecated state.

### `SYS_SCHEMA_TABLES`

- stable `table_id`, independent of physical name;
- entity type and physical table name;
- attribute/spatial table kind;
- synchronization and delete policies;
- synchronization, conflict, and reducer policy.

### `SYS_SCHEMA_FIELDS`

- stable `field_id`, independent of physical name;
- table ID, name, SQLite type, nullability, and default;
- system-managed and synchronization role flags;
- validation, display, and deprecation policy.

### `SYS_SCHEMA_GEOMETRY`

- table/field IDs;
- geometry type, SRS, Z/M flags;
- GeoPackage geometry column name;
- R-Tree requirement.

### `SYS_SCHEMA_MIGRATIONS`

- migration ID and ordered sequence;
- from/to release IDs;
- implementation name and checksum;
- reversibility and required free-space multiplier;
- destructive-change approval identifier, when applicable.

## 7. Local Schema State

### `sw_schema_install_state`

Singleton fields:

- installed schema version and release ID;
- catalog hash and physical schema fingerprint;
- installed App/coordinator/Python versions;
- state: `ready`, `migration_required`, `migrating`, `failed`, or `blocked`;
- last validation and successful migration times;
- previous database path/hash for startup recovery.

### `sw_schema_migration_history`

One immutable result row per attempt:

- migration ID, from/to releases, implementation checksum;
- start and completion timestamps;
- state: `started`, `validated`, `installed`, `rolled_back`, or `failed`;
- source and output database hashes;
- backup/previous path;
- stable error code and diagnostic report path.

## 8. Supported Change Rules and Delivery Status

| Change | Target behavior | Current Manager status |
| --- | --- | --- |
| Add attribute table | Alembic `create_table` from the typed catalog with system fields, constraints, and indexes | Implemented for attribute tables |
| Add spatial layer | Create through `GeoPackageAdapter`; register `gpkg_*` metadata and R-Tree | Planned |
| Add nullable field | Alembic `add_column` on the temporary copy | Implemented |
| Add required field | Add nullable/default first, backfill and validate, then enforce in a later release | Partially available; staged enforcement is planned |
| Add/drop index | Alembic create/drop index; R-Tree changes use `GeoPackageAdapter` | Implemented for ordinary SQLite indexes |
| Rename table | Alembic rename with stable `table_id`, explicit old/new physical names, and dependency validation | Implemented |
| Rename field | Alembic alter/batch operation with stable `field_id` and explicit old/new physical names | Implemented |
| Change field type | Create replacement column/table, convert, validate, then switch | Planned |
| Change geometry type/SRS | Rebuild through `GeoPackageAdapter` with geometry validation | Planned |
| Remove field/table | Two-release deprecation and removal process followed by guarded Alembic drop/batch migration | Planned |

### 8.1 Destructive Changes

Dropping a field or table is never an immediate one-release action:

1. **Deprecate:** stop new writes, hide it from UI/catalog defaults, retain reads for old
   operations, and publish compatibility telemetry.
2. **Drain:** confirm no supported client, draft, operation package above log floor,
   constraint, or workflow still references it.
3. **Remove:** rebuild the SQLite table where necessary, update GeoPackage metadata,
   validate, and publish a new full snapshot.

SQLite column removal uses a controlled table rebuild unless the exact deployed SQLite
version and migration policy explicitly permit native `DROP COLUMN`.

## 9. Client Startup and Migration Flow

1. Open packaged `system.db` read-only and validate its catalog.
2. Inspect `stormwater.db` without changing it.
3. Read the shared schema pointer and verify its immutable release.
4. Confirm that the App contains every required trusted migration implementation.
5. If the share is unavailable, keep a healthy compatible database in degraded read-only
   mode; do not migrate.
6. Recover committed operations and finish the authoritative synchronization barrier.
7. Block new edits and acquire the local schema lock plus shared epoch-transition lock.
8. Revalidate target release, active writers, local outbox, drafts, free space, and hashes.
9. Checkpoint and close local SQLite connections.
10. Copy `stormwater.db` to a unique `.migrating` file using SQLite backup semantics.
11. Apply ordered idempotent migrations to the copy.
12. Run full health validation and compare the physical fingerprint with the catalog.
13. Flush and atomically exchange the validated copy with `stormwater.db`; retain one
    `.previous` copy until the next successful startup.
14. Record migration history, reopen the coordinator, synchronize again, and publish an
    acknowledgement.
15. Enable editing only after all checks pass.

No resource page may open its own SQLite connection while migration is active.

## 10. Failure and Recovery

| Failure point | Required result |
| --- | --- |
| Before temporary copy | Existing database remains unchanged |
| During copy or migration | Delete/quarantine `.migrating`; existing database remains active |
| Validation failure | Do not install; write a diagnostic report with stable error code |
| Crash during atomic exchange | Startup resolves `.migrating`/`.previous` using hashes and install state |
| First startup after install fails | Restore `.previous`, mark release blocked, preserve evidence |
| Unsupported newer operation | Defer transaction and do not advance terminal cursor |
| Share unavailable | Existing compatible database is read-only; migration waits |

Migration code is idempotent and must check preconditions before each operation. It does
not guess whether a partially changed structure is acceptable.

## 11. Snapshot and Synchronization Coordination

- Schema activation and snapshot epoch activation share one exclusive transition window.
- A snapshot declares its exact schema release and physical fingerprint.
- New-schema operation packages cannot be published before the shared schema release is
  active and the actor has registered in the new snapshot epoch.
- Clients complete pending authoritative local apply before migration.
- Prepared but unpublished transactions are voided or retained as drafts and must be
  revalidated against the new schema.
- Snapshot compaction never removes operation history still required by a supported
  schema migration or deprecated field drain.

## 12. Workstation Publication Flow

1. Author catalog changes and trusted migration implementation.
2. Generate normalized catalog and deterministic checksums.
3. Build a release manifest and explicit migration plan.
4. Apply the complete chain to production-shaped test copies.
5. Run reducer fixtures, migration replay, crash injection, GeoPackage, and rollback tests.
6. Build and verify a full snapshot at the new release.
7. Publish immutable release files.
8. Acquire the shared epoch-transition/maintenance lease and revalidate active writers.
9. Publish the new snapshot epoch and finally atomically replace schema/snapshot current
   pointers in the specified activation order.
10. Retain five verified snapshots and seven days of committed operation history, subject
    to log-floor and migration-drain requirements.

## 13. Commands

The replacement workstation tool should expose explicit commands rather than the old
generic `upgrade-db` behavior:

```text
python -m portal.app.schema.cli --system-database <system.db> --business-database <stormwater.db> catalog-register
python -m portal.app.schema.cli --system-database <system.db> --business-database <stormwater.db> status
python -m portal.app.schema.cli --system-database <system.db> --business-database <stormwater.db> initialize
python -m portal.app.schema.cli --system-database <system.db> --business-database <stormwater.db> plan
python -m portal.app.schema.cli --system-database <system.db> --business-database <stormwater.db> validate
python -m portal.app.schema.cli --system-database <system.db> --business-database <stormwater.db> migrate --confirm
python -m portal.app.schema.cli --system-database <system.db> --business-database <stormwater.db> rollback --confirm
```

`status`, `plan`, and `validate` are read-only. `migrate` and `rollback` require explicit
confirmation and produce machine-readable JSON reports. Release registration, testing,
planning, baseline publication, and migration publication are exposed through the
Manager task boundary. Alembic-backed structural draft commands remain part of the
target delivery described above.

### 13.1 Workstation GUI

All commands will be exposed through the standalone Portal Workstation Manager. The GUI
supplies validated inputs, previews, progress, confirmation, and result reports; it does
not contain migration logic or execute arbitrary SQL. The GUI and scheduled tasks call
the same trusted Python command implementations. See
`WORKSTATION_MANAGEMENT_GUI_DESIGN.md` for the task catalog and command protocol.

The implemented **Schema** page exposes the current table, field, and index catalog;
typed Add Table, Rename Table, Add/Rename Field, and Add/Drop Index drafts;
production-shaped-copy testing; database validation; dated release registration;
migration planning; and guarded baseline or migration publication. Existing definitions
remain protected until an operator deliberately starts the corresponding operation.

Drop Field and Drop Table remain blocked. Those destructive actions require the future
deprecation/drain evidence, System Admin approval, typed confirmation, verified backup,
and successful rollback test described in section 8.1. Operators never use a shell or
edit a live `stormwater.db` file.

## 14. Testing Requirements

- clean install and every supported upgrade path;
- migration replay and checksum mismatch;
- add/rename/deprecate/remove table and field;
- attribute and point/line/polygon GeoPackage layers;
- migration with drafts, conflicts, and committed/uncommitted outbox states;
- interruption before, during, and after atomic exchange;
- insufficient disk, unavailable share, and lock timeout;
- old/new App and old/new snapshot compatibility;
- deterministic schema fingerprint on every supported workstation;
- no data loss after rollback.

## 15. Initial Delivery Plan

1. Implement catalog models and deterministic schema fingerprinting.
2. Add local install-state and migration-history tables.
3. Implement `SchemaManager` preflight, temporary-copy migration, validation, and atomic
   installation.
4. Add trusted migrations for the current schema as the initial baseline release.
5. Integrate Alembic behind `SchemaManager` and register packaged revision checksums. **Implemented.**
6. Add Manager operations for Add Table, Rename Table, Rename Field, and index removal. **Implemented.**
7. Add generic attribute-table and compatible field/index migrations. **Implemented.**
8. Add the GeoPackage adapter and spatial migration tests.
9. Add deprecation/drain/removal workflow and guarded field/table removal.
10. Integrate schema checks into coordinator startup, pre-save barriers, snapshots, and
   operation-package validation.
11. Implement workstation release build/test/publish commands.

## 16. Acceptance Criteria

The module is ready for production only when:

- all supported databases identify one verified release and fingerprint;
- every migration is ordered, immutable, checksummed, idempotent, and audited;
- interrupted migration cannot corrupt or replace the last valid database;
- field/table removal cannot discard data still referenced by clients or operation logs;
- GeoPackage metadata and spatial indexes remain valid;
- incompatible clients are read-only or blocked before formal save;
- snapshots and operation packages declare and enforce schema compatibility;
- no resource or shared file can execute unregistered DDL or migration code;
- the Manager supports typed Add Table, Rename Table, and Rename Field drafts without
  accepting arbitrary SQL;
- physical table names use stable business-domain terms, while opaque table and field
  identities are generated and maintained by the application to preserve references
  across table and field renames.
