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

The packaging script always uses the standard output directory below; staging
folders are not supported for Desktop builds.

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
  README.txt
  VERSION
  manifest.json
```

Client computers extract the folder locally and run `Portal.exe`. No installer, Python runtime, Conda environment, local service, or administrator access is required.

## Shared Release Distribution

Publish portable releases to the shared release folder with an explicitly selected
update type. The publisher never guesses the type from the changed files.

```powershell
# First release or any mixed/runtime/structural change. The portable folder's
# VERSION must already be 0.2.0.
.\desktop\scripts\publish-portable-release.ps1 -UpdateMode full

# Read-only system publication only. No Portal rebuild is required.
.\desktop\scripts\publish-portable-release.ps1 -UpdateMode system-db -ReleaseVersion 0.2.1

# Portal host executable only.
.\desktop\scripts\publish-portable-release.ps1 -UpdateMode portal-exe -ReleaseVersion 0.2.2
```

The release path comes from `updates.releaseRoot` in
`config\portal.settings.json`; the standard shared folder is
`G:\Strategic Planning\Planning\stm_risk_app`. Every release uses a newer
semantic version. For targeted updates, provide it with `-ReleaseVersion`; for a
full release it must equal the package `VERSION`.

`full` publishes a complete ZIP and refreshes `portal-bootstrap.json`. New users
run `Download-Portal.bat` from the shared release folder; it installs to
`%LOCALAPPDATA%\StormWaterPortal\app` and creates a Desktop shortcut. The bootstrap
manifest is intentionally always a full release.

`system-db` replaces only `config\system.db`. `portal-exe` replaces only
`Portal.exe`. Both publish `portal-release.json` without replacing the bootstrap
bundle. A Python runtime update, any change that requires multiple files, or a
folder-structure change must use `full`.

Every release mode preserves `%LOCALAPPDATA%\StormWaterPortal\data` exactly as it
is. Full releases replace only `%LOCALAPPDATA%\StormWaterPortal\app`; they discard
any legacy `app\data` folder and never package or overwrite the user-owned data
directory.

On startup, Portal checks the current `portal-release.json` after validating the
shared data drive. When its version is newer, Portal closes itself, starts the
bundled updater, applies the selected payload, and restarts. The updater records
the applied release in `config\update-state.json`, so an already applied
database-only release is not offered again.

Portal is temporarily unavailable during the daily maintenance window from 10:00 PM through
5:00 AM local time. A launch during that window shows the maintenance splash for
15 seconds and then exits. A Portal session that is already open replaces its current
view with the same dynamic 15-second shutdown countdown when the maintenance window
begins, including after the workstation resumes or regains focus, and exits only after
the countdown completes.

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

Reference data is published by the workstation data-build process. A UNC path can
replace `G:` for clients that do not share the same mapped-drive configuration.

`Portal.exe` owns the WebView2 window, Tauri commands, local application directories,
the authenticated desktop session, and the `portal-data` protocol. It owns one
`runtime\portal-python\portal-python.exe --serve` child process for the session. The worker runs one
validated local command at a time over newline-delimited JSON pipes, uses no port or
local service, and exits with Portal. The unpacked runtime avoids PyInstaller's
one-file extraction delay during startup, while keeping the worker warm avoids
repeating Python import cost for every table or dashboard request.

The read-only system publication is opened directly from portable `config\system.db`.
Portal Manager refreshes this file from its authoritative writable `system.db`,
verifies the copy, and marks the Desktop file read-only before every release.
No business database is packaged. On first use, Portal verifies the active shared
protocol snapshot and copies it to `%LOCALAPPDATA%\StormWaterPortal\data\stormwater.db`.
If the shared snapshot is unavailable or invalid, Portal stops rather than creating a
blank or seed database. Legacy `business.db` and
`data\business\portal_business.sqlite3` files are renamed forward automatically when present.
All resources use the single portable `config\portal.settings.json` file. Do not create
workstation override copies under `%LOCALAPPDATA%\StormWaterPortal\config`; edit the portable file when a
deployment path or external service changes.

## Network Business Publication

`businessSync.networkRoot` points to the exchange area used by desktop clients and the
merge station. The active local-replica source is
`protocol-v1\snapshots\current.json`; its referenced immutable SQLite snapshot is
verified before being copied to a new client. The default protocol layout is:

```text
G:\Strategic Planning\Planning\stm_risk_data\portal\data\
  protocol-v1\
    snapshots\
      current.json
      snapshot-<id>-<sha256>.db
    membership\
    users\
    coordination\
    audit\
```

Clients never open a writable SQLite connection on this share. If a workstation has
no local `stormwater.db`, `Portal.exe` checks `protocol-v1\snapshots\current.json`,
verifies the published snapshot and required SHA-256 digest, then copies it to the
local data folder. An existing local database is never replaced during application
startup. If no active snapshot has been published or the share is offline, Portal does
not start a new business database.

The version manifest format is:

```json
{
  "schemaVersion": 1,
  "databaseVersion": "000001",
  "databaseFile": "stormwater_000001.db",
  "sha256": "lowercase SHA-256 digest",
  "publishedAt": "2026-07-20T20:00:00Z",
  "publishedBy": "maintenance-station"
}
```

`databaseFile` is relative to `master\versions` and cannot contain `..`. A successful
first download writes `%LOCALAPPDATA%\StormWaterPortal\data\master-source.json` so later
submission and merge logic can identify the workstation's base version.
