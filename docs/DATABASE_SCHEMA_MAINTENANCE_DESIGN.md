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
| `MigrationRegistry` | Maps immutable migration IDs to trusted Python implementations and checksums |
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

workstation-manager/sync/schema/
  build_release.py
  publish_release.py
  validate_release.py
```

### 4.1 Migration Engine Choice

Use **Alembic** as an internal library for revision identifiers, ordered upgrade paths,
transaction handling, and SQLite batch table rebuilds. Alembic is not the public
maintenance interface and must not connect directly to the shared repository.

`SchemaManager` remains the controlling layer because Alembic alone does not provide:

- temporary-copy migration and atomic database replacement;
- Portal release-manifest and checksum validation;
- synchronization barriers, snapshot compatibility, or operation-log drain checks;
- GeoPackage metadata, geometry, SRS, and R-Tree validation;
- Portal-specific recovery reports and startup policy.

Migration revisions call `GeoPackageAdapter` for spatial changes and are registered in
`MigrationRegistry`. A revision file is packaged with the App and its checksum is listed
in the schema release. SQL or Python migration code from the network share is never
executed.

### 4.2 Implemented V1 Foundation

The initial desktop implementation is available under `python/portal/app/schema/`:

- `catalog.py` registers only the five explicitly allowlisted `RPT5W1C0_*` business
  tables, their fields, and indexes. It does not discover arbitrary SQLite tables.
- `SYS_SCHEMA_MIGRATIONS` stores immutable migration identifiers, ordered release
  transitions, handler names, specifications, and checksums.
- `SYS_SCHEMA_GEOMETRY` is present now for future GeoPackage layer metadata; the
  current `stormwater.db` release has no spatial tables to register.
- `manager.py` creates `SW_SCHEMA_INSTALL_STATE` and
  `SW_SCHEMA_MIGRATION_HISTORY` in the local business database, validates the physical
  schema, and upgrades through a temporary local SQLite copy followed by an atomic
  replacement.
- `migrations.py` contains trusted, packaged Python handlers. The current
  `RPT5W1C0_BASELINE_001` handler registers the existing report schema without changing
  report data. Declarative compatible migrations are limited to validated additive
  columns and indexes; destructive or spatial changes require a dedicated handler.

The deployed `stormwater.db` is currently installed at `portal-business-v1`. Its
catalog is held in the read-only packaged `system.db`; it is not yet a GeoPackage or a
published LAN schema release.

## 5. Version Model

Every release has both a monotonic integer version and a content identity:

```json
{
  "schema_version": 2,
  "schema_release_id": "sha256:<normalized-catalog-hash>",
  "previous_release_id": "sha256:<previous-hash>",
  "coordinator_version": "0.1.0",
  "python_runtime_version": "3.x.y",
  "dependency_lock_sha256": "sha256:<lock-hash>",
  "minimum_app_version": "1.0.0",
  "required_capabilities": ["generic-table-v1", "geometry-gpkg-v1"],
  "migration_ids": ["0002_add_asset_note"]
}
```

The release ID is derived from canonical catalog bytes. One version number cannot name
two different structures. A migration ID reused with a different checksum is fatal.

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
- ownership, permission, and reducer policy.

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

## 8. Supported Change Rules

| Change | v1 behavior |
| --- | --- |
| Add attribute table | Create from catalog with global ID, revision, tombstone, constraints, and indexes |
| Add spatial layer | Create through `GeoPackageAdapter`; register `gpkg_*` metadata and R-Tree |
| Add nullable field | Direct compatible migration on the temporary copy |
| Add required field | Add nullable/default first, backfill and validate, then enforce in a later release |
| Add/drop index | Explicit catalog migration; R-Tree changes use `GeoPackageAdapter` |
| Rename table/field | Explicit stable ID mapping; never inferred automatically |
| Change field type | Create replacement column/table, convert, validate, then switch |
| Change geometry type/SRS | Rebuild through `GeoPackageAdapter` with geometry validation |
| Remove field/table | Two-release deprecation and removal process |

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
confirmation and produce machine-readable JSON reports. Release build, test, and publish
commands remain a later workstation-management delivery because v1 has no published LAN
schema releases yet.

### 13.1 Workstation GUI

All commands will be exposed through the standalone Portal Workstation Manager. The GUI
supplies validated inputs, previews, progress, confirmation, and result reports; it does
not contain migration logic or execute arbitrary SQL. The GUI and scheduled tasks call
the same trusted Python command implementations. See
`WORKSTATION_MANAGEMENT_GUI_DESIGN.md` for the task catalog and command protocol.

The implemented **Schema** page exposes database status, validation, migration planning,
baseline installation, migration application, and previous-copy restoration. Operators
work entirely in the GUI; confirmation fields are required only before a local database
can be replaced or restored.

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
4. Add trusted migrations for the current schema as baseline release 1.
5. Add generic attribute-table and compatible field/index migrations.
6. Add the GeoPackage adapter and spatial migration tests.
7. Add deprecation/drain/removal workflow.
8. Integrate schema checks into coordinator startup, pre-save barriers, snapshots, and
   operation-package validation.
9. Implement workstation release build/test/publish commands.

## 16. Acceptance Criteria

The module is ready for production only when:

- all supported databases identify one verified release and fingerprint;
- every migration is ordered, immutable, checksummed, idempotent, and audited;
- interrupted migration cannot corrupt or replace the last valid database;
- field/table removal cannot discard data still referenced by clients or operation logs;
- GeoPackage metadata and spatial indexes remain valid;
- incompatible clients are read-only or blocked before formal save;
- snapshots and operation packages declare and enforce schema compatibility;
- no resource or shared file can execute unregistered DDL or migration code.
