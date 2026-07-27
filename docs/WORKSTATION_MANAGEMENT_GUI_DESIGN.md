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

## 2. Entry Point

```text
workstation-manager/
  PortalWorkstationManager.exe
  config/workstation-manager.settings.json
  src/                         React UI
  src-tauri/                   Rust/Tauri host
  scripts/build-portable.ps1
```

`PortalWorkstationManager.exe` is the portable interactive entry point. It is a
Tauri executable with a React UI and Rust native host, without a local web server.
The portable folder includes a `config` directory and the required
`workstation-manager/sync` Python/scheduler files. Existing non-GUI launchers may remain for
Task Scheduler, but operators normally use the workstation manager.

## 3. Navigation

The application uses a quiet operational layout with a fixed navigation rail and one
work area:

1. **Overview** - workstation health, running jobs, current releases, latest backup,
   latest snapshot, and recent failures.
2. **Source Data** - scheduled Cityworks/ITPipes publication, run now, source checks,
   published SQLite versions, and source logs.
3. **Repository** - initialize or inspect the shared protocol root, membership release,
   active epoch, writers, locks, and repository health.
4. **Schema** - catalog validation, release build/test/publish, database status, plan,
   migration, validation, and rollback.
5. **Snapshots** - build, validate, publish, inspect, and retain full snapshots.
6. **Backup** - create, verify, list, restore, and prune independent backups.
7. **Conflicts** - list, export, open, and resolve coordinator conflict reports.
8. **Logs** - filter task results by date, task, severity, and correlation ID.
9. **Settings** - edit validated workstation settings and test configured paths.

Pages are task-focused. A long-running command does not block navigation or freeze the
window.

## 4. Task Catalog

Every GUI action maps to a registered task ID. The GUI never accepts an arbitrary shell
command from a settings file.

| Area | Task ID | Required behavior |
| --- | --- | --- |
| Source Data | `source.schedule.start` | Start the single-instance daytime scheduler |
| Source Data | `source.schedule.stop` | Confirm and stop only the registered scheduler |
| Source Data | `source.run` | Run one publication immediately |
| Source Data | `source.check` | Validate selected source connectivity and tables |
| Source Data | `source.version.open` | Open the active or selected immutable publication |
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

## 8. Configuration

The manager reads paths from the existing Portal and source-sync settings. It does not
embed drive letters, server names, passwords, or database paths.

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
schema activation, snapshot activation, restore, and retention are restricted tasks.

## 11. Initial Implementation State

The current source-sync dashboard already implements scheduler state, start/stop,
publication status, run history, logs, and date filtering. The standalone workstation
manager exposes every documented module in its left navigation. Source Data is available;
the other modules show their documented operations as unavailable until their registered
Python task implementations are packaged.

Schema operations remain unavailable until the Python schema module described in
`DATABASE_SCHEMA_MAINTENANCE_DESIGN.md` is implemented. Their GUI locations and command
contracts are fixed now so implementation does not require redesigning the workstation
interface.

## 12. Delivery Sequence

1. Add the workstation manager shell and hidden launcher.
2. Integrate the existing source-sync dashboard and configuration checks.
3. Implement the trusted Python task runner and structured progress protocol.
4. Add repository inspection and bootstrap tasks.
5. Implement schema catalog, plan, validation, migration, and rollback tasks.
6. Add snapshot, backup, restore, retention, and conflict pages.
7. Add Task Scheduler registration and status management.
8. Complete crash-injection, network-loss, permission, and operator usability testing.

## 13. Acceptance Criteria

- all supported workstation commands are available from the GUI;
- the operator never needs to type a shell command for normal operation;
- GUI and scheduled runs call identical versioned Python task implementations;
- long tasks show progress and leave the GUI responsive;
- destructive operations require preview, confirmation, and validated recovery material;
- no configuration secret appears in process arguments, status history, or ordinary logs;
- every task produces an auditable result and stable error code;
- unavailable tasks explain the missing capability or prerequisite.
