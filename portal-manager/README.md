# Portal Workstation Manager

`Portal Workstation Manager` is the standalone React, Rust, and Tauri operator
application for Portal administration and workstation maintenance. It is
independent of the Portal end-user window and does not host a local web server.

The **Portal Administration** module manages users, teams, roles, resources,
permissions, dictionaries, holidays, and the independent system-catalog publication.
The **Schema**, repository, snapshot, backup, conflict, and source-data pages
provide the separate Database Maintenance surface. Portal Desktop exposes only
account/self-service functions and never publishes the system catalog.

The maintenance UI reads status from `sync/sync.settings.json`, Windows Task
Scheduler, and the source-sync run-history file. Administration requests use the
bundled persistent Portal Python worker through Tauri IPC; no localhost HTTP
server is started. Scheduled features are enabled or disabled through their
registered Windows tasks for the signed-in Windows user.

At startup, Manager resolves the signed-in Windows account and checks it against
the active users in `config\system.db`. Only active Portal Admin and System Admin
accounts may enter the Manager workspace. The Manager package's
`config\system.db` is the authoritative writable administration database. Portal
Desktop software packages contain no database copy; each Desktop encrypts the
published catalog locally with SQLCipher.

## Source Layout

\`\`\`text
portal-manager/
  config/workstation-manager.settings.json
  config/portal.settings.json
  config/system.db                 authoritative Manager administration database
  sync/                        Python coordinator
  src/                         React UI
  src-tauri/                   Rust/Tauri host
  scripts/build_portable.py
\`\`\`

The configured `syncDirectory` is relative to the configuration file. In this
repository it resolves to `../sync`; in a portable build, the same relative
layout is preserved.

## Development

\`\`\`text
pnpm install
pnpm tauri:dev
\`\`\`

## Portable Build

\`\`\`text
pnpm tauri:build
pnpm portable
\`\`\`

`pnpm portable` always writes to:
`C:\\Users\\105692\\webapps\\Portal\\portal-manager\\dist\\Portal-Manager`.

The client receives the generated portable folder only. Rust, Node.js, and the
development source tree are not required on the client workstation.

## Portal Releases

The **Releases** page publishes Portal desktop updates to the configured shared
release directory. It reads both the Portal portable folder and
`updates.releaseRoot` from the configured Portal settings file; it does not use
hard-coded deployment paths.

Software release publication is a System Admin operation. The **Releases** page does
not publish `system.db`; catalog data has an independent publication lifecycle.

The page shows one release version read from the built Portal package. Select a
release channel and update scope:

- **Production** publishes the standard root manifest for all installed clients.
- **Test** publishes under `releaseRoot\test` and requires one or more allowlisted
  Windows computer names.

The Test channel's **Save computers** action stores the normalized allowlist in
`config\workstation-manager.settings.json` as `releaseTestMachines`, so the same
names are available the next time the Manager is opened. Publishing a Test release
also persists the current list.

- **Portal executable only** replaces only `Portal.exe`.
- **Complete application** replaces the complete application folder.

Every channel publication writes one `portal-release.json`. It records the single version,
selected update scope, update payload, SHA-256 values, and a complete installation
payload. The complete package is always produced for new installation, repair, and
recovery, even when existing clients need only `Portal.exe`.

The Test view also provides **Promote to production**. Promotion verifies and copies
the exact test ZIP/EXE, updater, removal script, payload sizes, and SHA-256 values;
it does not rebuild the application. This makes the production artifact identical
to the one validated by the test computers. Production retains schema version 1
for compatibility with previously installed clients; targeted test manifests use
schema version 2.

The user-owned `%LOCALAPPDATA%\StormWaterPortal\data` directory is excluded from
packages and permanently protected by the updater. Full updates replace application
files and managed configuration but never remove or overwrite synchronized data.

## System Catalog Publication

The authoritative writable catalog remains at `config\system.db` in Portal Manager.
A System Admin publishes it from **Portal Administration > System Catalog** by
selecting **Publish system catalog**. No software or semantic version is entered.

The Manager closes its catalog worker and publishes `system.catalog` through the same
central data-manifest workflow used by DuckDB and PMTiles sources. The publisher calculates the checksum, schema
fingerprint, and immutable data version. Changed content receives a generated
timestamp-and-hash version; unchanged content keeps the existing version. Portal
Desktop checks this required source at its next startup, encrypts the verified content
with a per-user SQLCipher key protected by Windows DPAPI, then activates only the
encrypted read-only copy before user authentication. The Manager's authoritative
database remains writable and is never replaced by Desktop ciphertext.

## Python Sync Worker

This initial manager build controls the existing Python source-sync worker and
therefore expects its configured Python runtime to be available. The manager
itself is independent of Portal and has no local web service. Bundling the
Python runtime with the worker is a separate packaging step, so the same
portable manager can later be deployed without a Conda installation.

## Scheduled Tasks

The **Source Data** page manages **StormWater Portal Serving Data Sync**. Each run
rebuilds only the four approved business tables; it does not copy Cityworks or ITPipes
source tables. Use
**Enable automatic** to register it for the configured `allowedStartTime` and
**Disable automatic** to remove it. The Python worker still uses its configured
first-run time, interval, and exit time after Task Scheduler launches it.

The Source Data page also provides the **Rebuild interval** control. Enter a whole
number from 1 through 1440 minutes and save it while the scheduler is stopped. The
setting is written to the authoritative `sync.settings.json` and takes effect the
next time the scheduler starts.

The **Snapshots** page manages the nightly checkpoint task and the weekly
retention-and-backup task in the same way. The manager reports each task as
`Running`, `Ready`, or `Not registered`; manual start, stop, and run-now
controls are intentionally not provided in the UI.

## Business Repository Retention

The portable folder also includes a safe weekly business-data retention task.
It creates and verifies independent snapshot and operation-package backups,
archives eligible shared `.opdb` operation packages only after a minimum
seven-day workstation observation period, and publishes a replacement snapshot
with an advanced log floor. Backup artifacts older than 90 days are removed
only after the protected retained-snapshot backups and required archive copies
have been verified.

Configure the policy in the Portal settings file under
`maintenance.businessRetention`:

- `enabled`: enables the coordinator's approved business-retention policy.
- `automaticEnabled`: permits the scheduled run.
- `operationOnlineDays`: minimum online age; must be at least `7`.
- `verifiedSnapshotCount`: retained verified snapshots; must be at least `5`.
- `backupRetentionDays`: backup-artifact retention window; fixed at `90`.
- `schedule.dayOfWeek` and `schedule.time`: the default retention window is
  Friday at `21:00` local time.

The preferred way to enable the Windows scheduled task is through the
Workstation Manager **Snapshots** page: select **Enable** in the
**Automatic archive** row. The same page shows whether the task is registered
for the current Windows user and lets you disable it.

Snapshot backups are named `backup-YYYYMMDD-{snapshot_id}-{sha256}.db`.
Operation-package backups are grouped as
`backups/operations/YYYYMMDD/actor-{actor_id}/{original-package-name}.opdb`.
The date is the workstation-local Friday backup date; same-day reruns reuse
the same immutable destination.

The **Backup** page includes a guarded emergency recovery action. It can repair
only a missing or corrupt active snapshot, and only from a verified `.db`
backup with the exact same snapshot ID, epoch, hash, size, and coverage. It
does not restore an older snapshot or discard later operation packages. Type
the active snapshot ID to enable the action. A repository with no matching
verified backup cannot be recovered through this control.

For unattended deployment, the portable folder also includes:

```text
coordinator\register-weekly-business-retention-task.bat
```

It creates **StormWater Portal Business Retention** in Task Scheduler. Use
`coordinator\remove-weekly-business-retention-task.bat` to remove it. The
**Snapshots** page is a monitoring surface: it shows checkpoint history and
lets an operator enable or disable the approved scheduled tasks. Checkpoint
publication and online-package retention run only through those tasks.

## Nightly Business Maintenance

The **Snapshots** page also manages the opt-in nightly maintenance task. Its
default schedule is daily at `02:00` local time. A run publishes one verified
checkpoint snapshot only. Backup creation, verification, retention, and online
operation-package archival are handled exclusively by the Friday retention
task.

Use **Enable** in the **Nightly maintenance** row to register the current
Windows user's task. For unattended deployment, use:

```text
coordinator\register-nightly-business-maintenance-task.bat
```

Use `coordinator\remove-nightly-business-maintenance-task.bat` to remove it.
