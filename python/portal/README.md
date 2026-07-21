# Portal Local Python Logic

This package contains Portal's local data access, reporting, GIS, media, management, and resource logic. It is invoked by the Rust/Tauri host and never opens a listening port.

## Layout

```text
app/       Resource and management command implementations
runtime/   Local route registry, dependency resolution, and dispatcher
ipc/       JSON stdin/stdout worker packaged as portal-python.exe
data/      Seed SQLite database used for first-run initialization
```

Existing `/api/...` strings are internal command identifiers retained to keep resource code stable. They are not HTTP endpoints.

## Source Smoke Test

```powershell
$request = @{ method = 'GET'; path = '/health'; query = @{}; headers = @{}; body = $null } | ConvertTo-Json -Compress
$request | python python\portal\ipc\portal_worker.py --job request --request-stdin
```

The portable build bundles this package and its native dependencies into `portal-python.exe`; target computers do not receive loose Python scripts.
