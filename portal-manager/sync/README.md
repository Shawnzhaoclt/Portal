# Portal Workstation Data Sync

This folder contains workstation-side utilities that execute approved business
queries against source systems and publish only resource-ready business tables in
versioned, read-only SQLite snapshots. It does not replicate Cityworks or ITPipes
source tables.

The authoritative architecture and serving-table contracts are documented in
[`../../docs/PORTAL_SOURCE_DATA_SYNC_DESIGN.md`](../../docs/PORTAL_SOURCE_DATA_SYNC_DESIGN.md).

## Workstation Manager

The supported operator GUI is the standalone Tauri application in
`../portal-manager`. It is compiled as `PortalManager.exe` and
does not depend on the Portal application or a local web server.

This folder contains only the non-GUI Python synchronization process, its
configuration, and its silent scheduler launchers. The standalone manager reads the
same status and configuration files, so Task Scheduler and the GUI use identical
publication behavior.

## Output

The active publication is identified by:

`G:\Strategic Planning\Planning\stm_risk_data\databases_local\portal\portal_sources.current.json`

SQLite snapshots are stored under:

`G:\Strategic Planning\Planning\stm_risk_data\databases_local\portal\versions`

Daily sync logs are written to:

`G:\Strategic Planning\Planning\stm_risk_data\databases_local\portal\logs`

The sync removes log files older than 14 calendar days whenever it starts.
`portal-sync-status.json` in the same directory retains the latest 5,000 run results
for the monitor dashboard.

Each sync completely rebuilds `critical_asset_work_orders`,
`asset_inspection_workflows`, `asset_inspection_events`, and
`facility_condition_risk_current` in a uniquely named SQLite file, creates the
required indexes, validates the serving-data contracts, runs
`PRAGMA integrity_check`, and closes the database.
Only then does it atomically replace `portal_sources.current.json`. A client that
already has the previous snapshot open can continue reading it while later requests
resolve the newly published snapshot. The publisher retains three snapshots by
default and removes older versions on a best-effort basis.

Clients must resolve `database` from the manifest before every new read operation.
A relative database path is relative to the manifest directory. The Portal client
uses `portal_sources_connection()`, which opens the snapshot read-only and immutable
and closes the connection in a `finally` block when the operation ends. The underlying
SQLite connection uses:

```python
connection = sqlite3.connect(
    f"{database_path.as_uri()}?mode=ro&immutable=1",
    uri=True,
)
connection.execute("PRAGMA query_only = ON")
```

Do not update a published snapshot in place and do not use SQLite WAL mode on the
shared network drive. Immutable versioned publication is what allows refreshes and
client reads to overlap safely.

## Run

### Hidden daily scheduler

The scheduler is started and stopped by the **Source Data** page in Portal Workstation
Manager, without opening a command window:

1. Confirm that the signed-in Windows account can read the configured Cityworks
   database and condition-risk DuckDB file.
2. Select **Start** in the Workstation Manager.
3. Review `logs\portal-sync-YYYYMMDD.txt` for progress or errors.

Passwords are not stored in the sync configuration. A named Windows lock prevents
duplicate scheduler processes across user and Task Scheduler sessions.
The scheduler runs according to the values under `schedule` in `sync.settings.json`,
using the workstation's local time. A scheduler can only be started from `07:00` through
`16:30`; it exits at `16:35`. If a sync fails, the last valid SQLite snapshot remains
available and the scheduler retries at the next interval. Stopping during a copy does not
change the manifest, so clients retain the last valid publication. A
temporary `.building` file may remain until maintenance removes it.

Open **Source Data** in Portal Workstation Manager to inspect scheduler state, next
run, active snapshot timestamp and size, and the latest result. Its run table supports
a selected date, defaults to today, and refreshes automatically. Plain-text logs remain
available through **Open logs**.

### Batch launcher

`start-source-sync.bat` is provided for an administrator or Task Scheduler task that
needs to start the source-data scheduler without opening the Workstation Manager. It
reads `pythonExecutable` from `sync.settings.json` (or `PORTAL_SYNC_PYTHON` when set),
checks that the runtime can import `pyodbc`, and launches the normal scheduled worker.
The worker's named Windows mutex still prevents a second scheduler from running.

Double-click the batch file or use it as the Program/script in a Task Scheduler action.
Monitor and stop the process from **Source Data** in Portal Workstation Manager.

For command-line diagnostics, run one immediate sync with:

```bat
conda run -n portal python sync_portal_sources.py --once
```

Before the first full sync, verify Cityworks access without copying data:

```bat
conda run -n portal python sync_portal_sources.py --check --source cityworks
```

For testing, `--output-db` can use a different logical SQLite filename without
changing the saved configuration.

The manager first uses `pythonExecutable` from `sync.settings.json`, then the
manager-level `config/workstation-manager.settings.json` value, the optional
`PORTAL_SYNC_PYTHON` environment variable, `python.exe`, and supported Conda
environments. The selected runtime must import `pyodbc`. SQLite support is
provided by Python's standard library.

Cityworks uses the signed-in Windows account. The workstation requires Microsoft ODBC
Driver 17 or 18 for SQL Server and network access to Cityworks, the configured
condition-risk DuckDB file, and the `G:` drive.

## Configuration

Edit `sync.settings.json` to change the logical SQLite filename, manifest and versions
paths, retained version count, log settings, Cityworks connection, condition-risk
source, or transfer chunk size. Source business queries and serving-table definitions
are versioned application code and are not arbitrary SQL stored in settings.

`outputDatabase` is retained temporarily as a legacy compatibility value for the
scheduler process that was already running when SQLite publication was introduced.
New scheduler processes use `sqliteDatabase`.

ITPipes CCTV resources continue to use their separately configured read-only DuckDB
sources. They are not part of this publication.

`PORTAL_SYNC_METADATA` records each serving dataset, row count, build duration,
content fingerprint, and UTC sync time in every published snapshot.
