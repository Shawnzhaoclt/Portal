# Portal Workstation Manager

`Portal Workstation Manager` is a standalone React, Rust, and Tauri desktop
application for workstation-side source synchronization. It is independent of the
Portal application and does not host a local web server.

The UI reads status from `sync/sync.settings.json`, Windows Task Scheduler,
and the source-sync run-history file. It does not start or stop Python worker
processes directly: each scheduled feature is enabled or disabled through its
current Windows task for the signed-in Windows user.

## Source Layout

\`\`\`text
workstation-manager/
  config/workstation-manager.settings.json
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
`C:\\Users\\105692\\webapps\\Portal\\workstation-manager\\dist\\Portal-Workstation-Manager`.

The client receives the generated portable folder only. Rust, Node.js, and the
development source tree are not required on the client workstation.

## Portal Releases

The **Releases** page publishes Portal desktop updates to the configured shared
release directory. It reads both the Portal portable folder and
`updates.releaseRoot` from the configured Portal settings file; it does not use
hard-coded deployment paths.

Choose the update type explicitly:

- **System database only** replaces only `config\system.db`.
- **Portal executable only** replaces only `Portal.exe`.
- **Full portable folder** publishes the complete ZIP and refreshes the
  first-time installation bundle.

Provide a newer semantic release version such as `0.2.1`. Full releases must
match the `VERSION` file in the Portal portable folder. The manager rejects an
older or duplicate shared-release version.

## Python Sync Worker

This initial manager build controls the existing Python source-sync worker and
therefore expects its configured Python runtime to be available. The manager
itself is independent of Portal and has no local web service. Bundling the
Python runtime with the worker is a separate packaging step, so the same
portable manager can later be deployed without a Conda installation.

## Scheduled Tasks

The **Source Data** page manages **StormWater Portal Source Data Sync**. Use
**Enable automatic** to register it for the configured `allowedStartTime` and
**Disable automatic** to remove it. The Python worker still uses its configured
first-run time, interval, and exit time after Task Scheduler launches it.

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
