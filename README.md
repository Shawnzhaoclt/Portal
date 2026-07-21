# Storm Water Asset Intelligence Portal

Portal is a portable Windows desktop application built with React, Tauri, Rust, and bundled Python. It does not run a local HTTP server, expose REST endpoints, install a Windows service, or require Python on client computers.

## Repository Layout

```text
ui/             React and TypeScript application and resource metadata
src-tauri/      Tauri/Rust desktop host and native IPC/file protocol
python/portal/  Local Python commands, data access, reports, and GIS logic
maintenance/    SQLite deployment, upgrade, backup, and restore utilities
desktop/        Portable-build scripts and desktop configuration templates
docs/           Architecture and resource design documents
```

## Desktop Data Layout

Portal keeps writable and workstation-specific data under `%LOCALAPPDATA%\Portal`:

```text
config/          Application settings and the read-only system.db publication
data/business.db Writable resource data, including CCTV review reports
exports/         User-generated documents and spreadsheets
logs/            Application diagnostics
inbox/ outbox/   Business database exchange packages
temp/            Disposable working files
```

The authoritative source paths are declared in `config/portal.settings.json`. Large
read-only DuckDB, PMTiles, map styles, sprites, and map configuration live under the
configured shared data root and are never packaged with the application. The system
database is read directly from portable `config/system.db`; `data/business.db` is
copied to the user profile and is the only database writable at runtime.

## Development

```powershell
pnpm --dir ui desktop:dev
```

Vite is used only while developing the Tauri UI. Data calls travel through Tauri IPC to an on-demand Python worker; no localhost data service is started.

## Portable Build

```powershell
.\desktop\scripts\build-portable.ps1 `
  -PythonExecutable C:\Users\105692\AppData\Local\miniconda3\envs\arf\python.exe
```

The output is `dist\Portal-Desktop`. Copy or ZIP that whole folder and run `Portal.exe` locally on Windows 11.
