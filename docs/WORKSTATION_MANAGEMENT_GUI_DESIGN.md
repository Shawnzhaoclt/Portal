# Portal Workstation Management GUI Design

## 1. Purpose

Portal workstation maintenance will use one standalone native Windows GUI built with
React, Rust, and Tauri. Operators should not need to open PowerShell, Command Prompt,
or manually compose Python commands for ordinary operation. It is a separate desktop
application and is not a module of the Portal user application.

The GUI is an orchestration layer. React owns windows, input validation,
confirmations, progress, and result presentation; Rust owns native commands and
process coordination. Versioned Python commands own source
publication, repository coordination, schema migration, snapshots, backup, restore,
validation, and retention. The GUI and Task Scheduler must call the same commands.

### 1.1 Product boundary and maintenance ownership

`Portal-Desktop` is the end-user application. It presents resources and performs
approved business operations through the local data coordinator, but it does not
administer users, publish `system.db`, edit the schema catalog, or publish a shared
business-data schema release.

`PortalManager.exe` is the single operator application for workstation
and portal maintenance. Portal Administration and Database Maintenance are separate
navigation modules inside this executable, with separate permissions and task
contracts, but they share the same trusted Python command runner, audit trail,
configuration, maintenance lease, and progress model. A second administration
executable is not required. Optional desktop shortcuts or deep links may open a
specific module in the same executable.

The separation is by responsibility, not by binary:

| Module | Primary responsibility | Database/write boundary |
| --- | --- | --- |
| Portal Administration | Users, teams, roles, resources, permissions, dictionaries, holidays, and system publication settings | Writes only through approved management commands; publishes a new read-only `system.db` release |
| Database Maintenance | Business schema catalog, table/field/index definitions, migration drafts, validation, release publication, snapshots, backups, conflicts, and recovery | The Python data coordinator remains the only component that changes `stormwater.db` |
| Portal Desktop | Resource browsing and end-user business workflows | Reads `system.db`; reads/writes local `stormwater.db` through the coordinator |

The manager must never expose an arbitrary SQL editor or execute DDL supplied by a
resource, user, or network file. All changing operations use registered Python
handlers and produce an auditable result.

## 2. Entry Point

```text
portal-manager/
  PortalManager.exe
  config/workstation-manager.settings.json
  src/                         React UI
  src-tauri/                   Rust/Tauri host
  map-tiles/                   Portal-owned DuckDB-to-PMTiles builder and registry
  scripts/build_portable.py
```

`PortalManager.exe` is the portable interactive entry point. It is a
Tauri executable with a React UI and Rust native host, without a local web server.
The portable folder includes a `config` directory and the required
`portal-manager/sync`, `portal-manager/source-backup`, `portal-manager/map-tiles`, and coordinator Python/scheduler
files. Source-backup scripts are maintained in this repository and copied into the
portable Manager package; production operation does not depend on
`C:\Users\105692\scripts\backup_scripts`. PMTiles orchestration is also maintained
inside Portal. The primary encoder is a self-contained Tippecanoe runtime packaged
with Portal Manager. GDAL is the native fallback and the Portal-owned Python
encoder is the final diagnostic fallback. It does not call `stm_risk_models` or
another project at runtime. Existing non-GUI launchers may remain for
Task Scheduler, but operators normally use the workstation manager.

## 3. Navigation

The application uses a quiet operational layout with a fixed navigation rail and one
work area:

1. **Overview** - workstation health, running jobs, current releases, latest backup,
   latest snapshot, and recent failures.
2. **Mirrors & Backups** - clean SQL Server-to-DuckDB mirror rebuilds, weekly source-data
   archives, retained archive inventory, Outlook notifications, machine heartbeat,
   Task Scheduler registration, registered DuckDB-to-PMTiles generation, and diagnostic logs. The recent-run history is capped
   at the 10 most recent source-backup tasks and shows the computing duration for each run while retaining its managed log file.
3. **Serving Data** - scheduled serving-table rebuilds, run now, input checks,
   published SQLite versions, and source logs.
4. **Repository** - initialize or inspect the shared protocol root, membership release,
   active epoch, writers, locks, and repository health.
5. **Schema** - catalog validation, release build/test/publish, database status, plan,
   migration, validation, and rollback.
6. **Snapshots** - build, validate, publish, inspect, and retain full snapshots.
7. **Backup** - create, verify, list, restore, and prune independent business-database backups.
8. **Conflicts** - list, export, open, and resolve coordinator conflict reports.
9. **Logs** - filter task results by date, task, severity, and correlation ID.
10. **Settings** - edit validated workstation settings and test configured paths.
11. **Portal Administration** - manage the system catalog and prepare a replacement
    `system.db` release for users, teams, resources, permissions, dictionaries, and
    holidays.
12. **Database Maintenance** - design and review physical business tables, fields,
    indexes, migration plans, schema tests, release publication, and recovery.

Pages are task-focused. A long-running command does not block navigation or freeze the
window.

The Serving Data implementation follows
[`PORTAL_SOURCE_DATA_SYNC_DESIGN.md`](PORTAL_SOURCE_DATA_SYNC_DESIGN.md). It publishes
resource-ready business tables from scoped source-side extracts; it does not maintain
a general Cityworks or ITPipes mirror. Every run rebuilds the required serving tables
from approved source-side business queries; it does not infer changed records or
maintain incremental synchronization state.

## 4. Task Catalog

Every GUI action maps to a registered task ID. The GUI never accepts an arbitrary shell
command from a settings file.

| Area | Task ID | Required behavior |
| --- | --- | --- |
| Serving Data | `source.schedule.start` | Start the single-instance daytime scheduler |
| Serving Data | `source.schedule.stop` | Confirm and stop only the registered scheduler |
| Serving Data | `source.run` | Run one publication immediately |
| Serving Data | `source.check` | Validate selected source connectivity and tables |
| Serving Data | `source.version.open` | Open the active or selected immutable publication |
| Mirrors & Backups | `source-backup.check` | Validate maintained scripts and non-secret configuration |
| Mirrors & Backups | `source-backup.workflow` | Run the daily mirror rebuild and the weekly archive when due; on the configured weekly day, rebuild the separate 68-layer Spatial Data Warehouse DuckDB mirror after the archive, with ST_Hilbert ordering and DuckDB R-Tree indexes for spatial layers, then build, validate, and atomically publish the registered PMTiles archive |
| Mirrors & Backups | `source-backup.refresh` | Cleanly rebuild the standard SQL Server DuckDB mirrors and the separate 68-layer Spatial Data Warehouse mirror, without FileGDB generation or creating an archive |
| Mirrors & Backups | `source-backup.backup` | Create the retained DuckDB and supporting-directory archive immediately |
| Mirrors & Backups | `source-backup.map-tiles` | Read registered authoritative DuckDB spatial tables directly, stage selected fields locally, build with packaged Tippecanoe, validate each archive, and publish it atomically with a manifest |
| Mirrors & Backups | `source-backup.heartbeat` | Send the configured workstation heartbeat test |
| Mirrors & Backups | `source-backup.schedule` | Register, update, or remove only the two approved Windows scheduled tasks: `StormWater Portal Source Backup Workflow` and `StormWater Portal Machine Heartbeat` |
| Repository | `repository.status` | Read-only health and current-pointer inspection |
| Repository | `repository.bootstrap` | Initialize an empty root after a typed confirmation |
| Repository | `repository.validate` | Verify pointers, hashes, membership, and layout |
| Schema | `schema.catalog.validate` | Validate normalized catalog and fingerprint |
| Schema | `schema.release.build` | Build a candidate immutable schema release |
| Schema | `schema.release.test` | Run migration and compatibility fixtures |
| Schema | `schema.release.publish` | Publish a verified release under maintenance lease |
| Schema | `schema.database.status` | Read installed release and migration state |
| Schema | `schema.database.plan` | Produce a read-only migration plan |
| Schema | `schema.database.migrate` | Migrate a local copy and atomically install it |
| Schema | `schema.database.validate` | Run SQLite and GeoPackage validation |
| Schema | `schema.database.rollback` | Restore the retained pre-migration database |
| Schema | `schema.draft.create` | Create a date-based schema draft from the active catalog |
| Schema | `schema.draft.update` | Add, change, deprecate, or remove approved table/field/index definitions |
| Schema | `schema.diff` | Show the ordered structural diff and impact warnings |
| Schema | `schema.release.approve` | Record an authorized review of a tested schema release |
| Administration | `admin.catalog.status` | Inspect the current system catalog publication |
| Administration | `admin.system.release.build` | Build and validate a replacement `system.db` publication |
| Administration | `admin.system.release.publish` | Publish a verified system catalog release |
| Administration | `admin.users.teams` | Maintain users, teams, roles, and manager relationships |
| Administration | `admin.resources.permissions` | Maintain resources and effective permissions |
| Administration | `admin.dictionary.values` | Maintain controlled dictionary/code values and display order |
| Administration | `admin.holidays` | Maintain the approved holiday calendar |
| Snapshots | `snapshot.build` | Build a full-replication candidate from operations |
| Snapshots | `snapshot.validate` | Validate schema, coverage, hashes, and GeoPackage |
| Snapshots | `snapshot.publish` | Activate a verified snapshot and new epoch safely |
| Snapshots | `snapshot.retention` | Keep five verified snapshots subject to log floor |
| Backup | `backup.create` | Create and verify an independent backup |
| Backup | `backup.restore.plan` | Inspect a backup and show the restore impact |
| Backup | `backup.restore` | Restore only after typed confirmation and revalidation |
| Conflicts | `conflict.list` | Read conflict records and status |
| Conflicts | `conflict.export` | Export selected conflicts for local review |
| Conflicts | `conflict.resolve` | Apply an explicit resolution through the coordinator |

Task availability is capability-driven. A button is disabled with a visible reason when
its Python implementation, required configuration, network root, permission, or lease is
unavailable.

## 5. Command Contract

The GUI starts one trusted Python command runner with a registered task ID and a UTF-8
JSON request file. Credentials are never placed on the command line.

```text
portal-workstation run --task <task-id> --request <request.json>
```

The command writes newline-delimited JSON events to standard output:

```json
{"event":"started","task_id":"schema.database.validate","run_id":"..."}
{"event":"progress","current":3,"total":8,"message":"Checking foreign keys"}
{"event":"warning","code":"STALE_BACKUP","message":"..."}
{"event":"completed","result":"succeeded","report_path":"..."}
```

Stable result values are `succeeded`, `failed`, `cancelled`, and `blocked`. Errors include
a stable code, safe operator message, correlation ID, and optional report path. Python
tracebacks go to diagnostic logs and are not used as the primary operator message.

## 6. Job Execution

- Use Rust `std::process::Command` with redirected output and error streams.
- Read output asynchronously and update progress in the Tauri window.
- Permit one heavy workstation job at a time; read-only inspection may run concurrently.
- Use the same named process lock and shared maintenance leases used by scheduled jobs.
- Disable incompatible actions while a task is running.
- A cancel button requests cooperative cancellation. It never terminates a process in the
  middle of atomic publication or database replacement.
- Closing the GUI does not silently terminate a scheduled job. The operator chooses to
  keep it running or request a safe stop.

## 7. Safety Rules

1. Read-only tasks are clearly labeled and may run without confirmation.
2. Every changing task first produces a preview or plan.
3. Migration, restore, bootstrap, publication, and retention require a typed target name.
4. The GUI displays resolved paths and release IDs before confirmation.
5. Database migration uses a temporary local copy, validation, and atomic replacement.
6. Restore never writes directly over the only valid copy.
7. Shared repository changes require the appropriate lease and final revalidation.
8. Passwords and access tokens are masked, excluded from logs, and never passed as CLI
   arguments.
9. Task settings are schema-validated before a command starts.
10. A failed task leaves the last valid database, pointer, snapshot, or publication active.
11. Portal Administration changes are restricted by the currently selected Portal role;
    system-administrator-only actions cannot be authorized by Windows elevation alone.
12. Schema drafts are never installed directly. The GUI must show the diff, affected
    tables/indexes, data-loss warnings, test result, release ID, and rollback material
    before publication.
13. Destructive schema changes require a maintenance lease, a verified backup, typed
    confirmation, and a successful migration test against a production-shaped copy.

## 8. Configuration

The manager reads paths from the existing Portal and source-sync settings. It does not
embed drive letters, server names, passwords, or database paths.

`config/workstation-manager.settings.json` is authoritative for the in-project
source-backup and map-tiles directories, approved Python runtime, daily workflow time, weekly archive
day, heartbeat schedule, and fixed Task Scheduler names. The two source-backup JSON
files define mirror sources, archive inputs, output locations, retention, and
notification recipients. SQL-authenticated source passwords are resolved from named
environment variables and are never committed to the repository, returned by status
commands, passed on command lines, or written to ordinary logs.

`portal-manager/map-tiles/pmtiles.settings.json` is the authoritative map-tile
registry. It declares only approved DuckDB files, spatial tables, exposed fields,
zoom ranges, tilesets, and output paths. `Build map tiles` remains an explicit manual
operation. Ordinary mirror refreshes and non-weekly daily workflows do not start the
potentially long tile build; the configured weekly workflow starts it only after the
Spatial Data Warehouse mirror has been rebuilt successfully.
The current PMTiles registry contains 68 approved Spatial Data Warehouse layers,
split among four thematic archives under `databases_local/tiles`. Eleven Planning Project
layers remain direct DuckDB sources and are never encoded into PMTiles. Their
database, table, geometry, feature-ID, and exposed-field mappings are maintained in
`maps.duckdbGeoJsonLayers` in `portal.settings.json`. The ITPipes display layers use
the risk-ranking `DEFECTS_MOST_RECENT_*` tables so they preserve the legacy
most-recent-inspection semantics. The stable `culverts` layer reads `Culverts_evw`
from the configured Cityworks spatial mirror. No shared-data database path is
embedded in application or builder code.
MapLibre style JSON, sprite assets, and the expected source-layer registry belong to
the Storm Water Asset Risk Map resource and are bundled with Portal Desktop. The
shared tiles directory contains the four configured thematic PMTiles archives and
their build manifests; archive locations and file names come from configuration.
The authoritative DuckDB remains on its configured shared path and is opened
read-only; it is not copied to local SSD. A bounded process pool transforms each
layer and stages only approved fields in disposable local FlatGeobuf files.
Tippecanoe encodes independent zoom-compatible groups concurrently while dividing
the configured CPU allowance across the processes, and `tile-join` combines the
groups within each thematic archive. The Manager
validates the PMTiles header, expected layer IDs, and exact field allowlists before
atomic publication. GDAL and then the Portal-owned Python encoder provide controlled
fallbacks only when an engine is unavailable. The Manager UI reports staging,
encoding, merging, validation, and publication progress.

The Settings page presents fields by logical group, validates them, and writes through a
temporary file plus atomic replacement. It provides:

- path browse buttons;
- share accessibility checks;
- source connectivity checks;
- Python runtime and dependency checks;
- configuration diff before save;
- reset to packaged defaults without deleting credentials.

Secret values remain in the approved credential/configuration mechanism and are shown as
masked values.

All displayed dates and timestamps use the workstation operating system's locale,
date pattern, time pattern, and local timezone. The shared formatter omits fractional
seconds and timezone-name suffixes; canonical stored timestamps remain ISO/UTC values.

## 9. Audit and Logs

Every run records:

- run and correlation IDs;
- task ID and version;
- operator and workstation;
- start/end time and result;
- non-secret input summary;
- affected release, database, snapshot, or backup IDs;
- generated plan/report paths;
- warnings and stable error code.

The GUI status table reads structured run history, while Open Log displays or exports the
corresponding plain-text diagnostic log. Keep operational logs for seven days unless a
task-specific design requires longer evidence.

## 10. Permissions

The GUI does not treat Windows elevation as Portal authorization. Task permissions come
from the packaged system catalog and current operator identity. Administrative Windows
rights are requested only when an operating-system action truly requires them.

The initial deployment may use a workstation-maintainer allowlist. Repository bootstrap,
schema activation, snapshot activation, restore, retention, Portal Administration, and
system publication are restricted tasks. The manager must distinguish at least:

- **Workstation maintainer**: can inspect jobs, logs, repository state, and approved
  operational tasks;
- **Administrator**: can manage users, teams, resources, permissions, dictionaries,
  holidays, and system-catalog drafts;
- **System administrator**: can perform all administrator actions, publish system and
  business schema releases, recover databases, and change maintenance policy.

The selected role is evaluated for every task. Having an elevated role on the account
does not grant its capabilities while the operator is working under a lower selected
role.

## 11. Initial Implementation State

The current source-sync dashboard already implements scheduler state, start/stop,
publication status, run history, logs, and date filtering. The standalone workstation
manager exposes the documented modules in its left navigation. Schema, repository,
snapshot, backup, conflict, Portal Administration, and system-publication pages use the
same command/progress contract even when a particular task is unavailable because a
prerequisite, permission, release, or trusted handler is missing.

The Schema page is the GUI entry point for the workflow in
`DATABASE_SCHEMA_MAINTENANCE_DESIGN.md`: inspect the catalog, create a dated draft,
review the diff, run validation/tests, publish an immutable release, and apply or
recover it through the coordinator. The manager does not contain a second schema
engine.

## 12. Delivery Sequence

1. Add the workstation manager shell and hidden launcher.
2. Integrate the existing source-sync dashboard and configuration checks.
3. Implement the trusted Python task runner and structured progress protocol.
4. Add repository inspection and bootstrap tasks.
5. Add Portal Administration for system catalog drafts, user/team/resource/permission,
   dictionary, holiday, and system-release management.
6. Implement schema draft, diff, plan, validation, migration, approval, and rollback tasks.
7. Add snapshot, backup, restore, retention, and conflict pages.
8. Add Task Scheduler registration and status management.
9. Complete crash-injection, network-loss, permission, and operator usability testing.

## 13. Acceptance Criteria

- all supported workstation commands are available from the GUI;
- the operator never needs to type a shell command for normal operation;
- GUI and scheduled runs call identical versioned Python task implementations;
- long tasks show progress and leave the GUI responsive;
- destructive operations require preview, confirmation, and validated recovery material;
- no configuration secret appears in process arguments, status history, or ordinary logs;
- every task produces an auditable result and stable error code;
- unavailable tasks explain the missing capability or prerequisite.
- Portal Desktop contains no administrative or schema-publication surface;
  `PortalManager.exe` is the documented operator entry point for those tasks;
- no manager operation can execute unregistered SQL, DDL, migration code, or a network
  supplied script.
