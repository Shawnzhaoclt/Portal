# Portal Desktop Build

This directory contains portable packaging scripts and desktop configuration templates.

## Development

```powershell
pnpm --dir ui desktop:dev
```

Tauri launches Vite for UI development. The production application embeds the compiled UI and does not start Vite or any local server.

## Build

The build workstation needs Node.js, pnpm, the Rust MSVC toolchain, Visual C++ Build Tools, and a Python environment containing Portal's dependencies and PyInstaller.

```powershell
.\desktop\scripts\build-portable.ps1 -PythonExecutable C:\path\to\python.exe
```

Output:

```text
dist\Portal-Desktop\
  Portal.exe
  runtime\
    portal-python\
      portal-python.exe
      _internal\
  config\
    portal.settings.json
    system.db
  data\
    business.db
  README.txt
  VERSION
  manifest.json
```

Client computers extract the folder locally and run `Portal.exe`. No installer, Python runtime, Conda environment, local service, or administrator access is required.

The portable folder intentionally excludes DuckDB, PMTiles, map styles, sprites, and
map configuration. Those immutable inputs are read from the `shared.dataRoot` path in
`config\portal.settings.json`. The default shared layout is:

```text
G:\Strategic Planning\Planning\stm_risk_data\
  intermediate\amteam\amteam.duckdb
  maptiles\
    config\project.toml
    build\staging\duckdb\stm_risk.duckdb
    build\pmtiles\*.pmtiles
    build\maplibre\
```

Use `maintenance\publish_reference_data.ps1` on the build/maintenance workstation to
publish the current map artifacts. A UNC path can replace `G:` for clients that do not
share the same mapped-drive configuration.

`Portal.exe` owns the WebView2 window, Tauri commands, local application directories,
the authenticated desktop session, and the `portal-data` protocol. It owns one
`runtime\portal-python\portal-python.exe --serve` child process for the session. The worker runs one
validated local command at a time over newline-delimited JSON pipes, uses no port or
local service, and exits with Portal. The unpacked runtime avoids PyInstaller's
one-file extraction delay during startup, while keeping the worker warm avoids
repeating Python import cost for every table or dashboard request.

The read-only system publication is opened directly from portable `config\system.db`.
On first use, only the business database seed is copied to
`%LOCALAPPDATA%\Portal\data\business.db`. A legacy
`data\business\portal_business.sqlite3` is copied forward automatically when present.
All resources use the single portable `config\portal.settings.json` file. Do not create
workstation override copies under `%LOCALAPPDATA%`; edit the portable file when a
deployment path or external service changes.

## Network Business Publication

`businessSync.networkRoot` points to the exchange area used by desktop clients and the
merge station. The default is:

```text
G:\Strategic Planning\Planning\stm_risk_data\portal\data\
  master\
    current.json
    versions\
  submissions\
    inbox\
    processed\
    rejected\
  conflicts\
    open\
    resolved\
    archive\
  locks\
  backups\
```

Clients never open a writable SQLite connection on this share. If a workstation has
no local `business.db`, `Portal.exe` checks `master\current.json`, verifies the
published file and optional SHA-256 digest, and copies it to the local data folder.
An existing local database is never replaced during application startup. If no master
has been published or the share is offline, the packaged seed is used for a new local
database.

The version manifest format is:

```json
{
  "schemaVersion": 1,
  "databaseVersion": "000001",
  "databaseFile": "business_000001.db",
  "sha256": "lowercase SHA-256 digest",
  "publishedAt": "2026-07-20T20:00:00Z",
  "publishedBy": "maintenance-station"
}
```

`databaseFile` is relative to `master\versions` and cannot contain `..`. A successful
first download writes `%LOCALAPPDATA%\Portal\data\master-source.json` so later
submission and merge logic can identify the workstation's base version.
