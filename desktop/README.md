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
    duckdb\
      extensions\
        spatial.duckdb_extension
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

Client computers extract the folder locally and run `Portal.exe`. No installer, Python runtime, Conda environment, local service, or administrator access is required. The signed DuckDB spatial extension is packaged in the runtime and loaded only from that local file, so map queries do not download extensions from the internet.

Source DuckDB, `system.db`, PMTiles, and terrain files are resolved through the
versioned cache under `%LOCALAPPDATA%\StormWaterPortal\data\source-cache`. The shared
drive is checked once at startup for the central publication manifest; cache-backed
resources never fall back to direct shared-drive reads. The small, five-minute
`portal.serving` SQLite publication is the sole exception: resources read its atomic
`portal_sources.current.json` publication directly from the shared drive. Portal
requires at least 15 GB of free space on the drive containing the local cache;
otherwise startup stops with a clear message. Cache-backed DuckDB and PMTiles settings
use logical source IDs, and the portable build rejects any cache-backed fallback that
points to `PORTAL_SHARED_DATA_ROOT`.

## Shared Release Distribution

Publish portable releases to the shared release folder with an explicitly selected
update scope. The package `VERSION` is the only software version entered into the
release workflow.

```powershell
# First release or any mixed/runtime/structural change.
.\desktop\scripts\publish-portable-release.ps1 -UpdateMode full

# Portal host executable only.
.\desktop\scripts\publish-portable-release.ps1 -UpdateMode portal-exe
```

The release path comes from `updates.releaseRoot` in
`config\portal.settings.json`; the standard shared folder is
`G:\Strategic Planning\Planning\stm_risk_app`. The publisher always reads the
semantic version from the portable folder's `VERSION` file.

Every publication atomically replaces one `portal-release.json`. It contains one
release version, the selected `updateMode`, the payload for existing installations,
and a complete `installationPayload` for installation and recovery. New users run
`Download-Portal.bat`; it reads this same manifest, installs the complete package to
`%LOCALAPPDATA%\StormWaterPortal\app`, and creates a Desktop shortcut.

Users can run `Remove-Portal.bat` from the shared release folder to remove Portal.
The script warns that the operation is permanent and requires explicit confirmation
before deleting `%LOCALAPPDATA%\StormWaterPortal`, including the application, local
databases, downloaded source cache, settings, and exports. It also removes the Portal
Desktop shortcut.

`portal-exe` tells existing installations to replace only `Portal.exe`; `full` tells
them to replace the complete application folder. Both scopes publish a complete ZIP
for new installation, repair, and recovery. A Python runtime update, any change that
requires multiple files, a DuckDB runtime or spatial-extension change, or a folder-structure change must use `full`. The read-only
system catalog is published independently as the `system.catalog` data source from
Portal Manager; it does not use a semantic software version.

Every update scope preserves `%LOCALAPPDATA%\StormWaterPortal\data` exactly as it
is. The publisher excludes `data` from the complete ZIP, the manifest declares
`preservePaths: ["data"]`, and the updater independently rejects targets under that
directory. Full releases replace `%LOCALAPPDATA%\StormWaterPortal\app` and managed
configuration only; data synchronization owns the data directory.

On startup, Portal checks the current `portal-release.json` after validating the
shared data drive. When its version is newer, Portal closes itself, starts the
bundled updater, applies the selected payload, and restarts. The updater records
the applied release in `config\update-state.json`.

Portal is temporarily unavailable during the daily maintenance window from 10:00 PM through
5:00 AM local time. A launch during that window shows the maintenance splash for
15 seconds and then exits. A Portal session that is already open replaces its current
view with the same dynamic 15-second shutdown countdown when the maintenance window
begins, including after the workstation resumes or regains focus, and exits only after
the countdown completes.

The portable folder intentionally excludes source-data DuckDB databases and PMTiles. Map styles and sprites
are packaged with the map resource, and the map project catalog is copied to the
portable `config\project.toml` file. The default shared layout is:

```text
G:\Strategic Planning\Planning\stm_risk_data\
  intermediate\amteam\amteam.duckdb
  intermediate\cityworks\cityworks.db
  intermediate\riskranking\riskranking.db
  intermediate\inventory\inventory.db
  databases_local\tiles\*.pmtiles
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
