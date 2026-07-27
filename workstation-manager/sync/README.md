# Portal Workstation Data Sync

This folder contains workstation-side utilities that copy the SQL Server tables
required by Portal into versioned, read-only SQLite snapshots.

## Workstation Manager

The supported operator GUI is the standalone Tauri application in
`../workstation-manager`. It is compiled as `PortalWorkstationManager.exe` and
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

Each sync builds a uniquely named SQLite file, commits the complete load, creates
the configured indexes, runs `PRAGMA integrity_check`, and closes the database.
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

1. Enter the ITPipes `username` and `password` in the ITPipes source inside
   `sync.settings.json`.
2. Select **Start** in the Workstation Manager.
3. Review `logs\portal-sync-YYYYMMDD.txt` for progress or errors.

The password is stored as plain text in the configuration file. Restrict file
permissions to the Windows accounts that run or maintain the sync. A named Windows
lock prevents duplicate scheduler processes across user and Task Scheduler sessions.
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

Cityworks uses the signed-in Windows account. ITPipes uses the `username` and
`password` values in `sync.settings.json`. The workstation requires Microsoft ODBC
Driver 17 or 18 for SQL Server and network access to both sources and the `G:` drive.

## Configuration

Edit `sync.settings.json` to change credentials, the logical SQLite filename,
manifest and versions paths, retained version count, log settings, source systems,
table list, indexes, or transfer chunk size.

`outputDatabase` is retained temporarily as a legacy compatibility value for the
scheduler process that was already running when SQLite publication was introduced.
New scheduler processes use `sqliteDatabase`.

The initial table set supports the current Cityworks dashboards and ITPipes CCTV
review data. `azteca_WOCUSTFIELD` is intentionally included because Critical Team
status and completion-date metrics depend on custom field IDs 7, 10, and 17.

`PORTAL_SYNC_METADATA` records each source table, row count, duration, and UTC sync
time in every published snapshot.
