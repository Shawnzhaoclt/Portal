# Portal Backend

FastAPI code now lives under `backend/app` instead of the repository root.

## Layout

```text
backend/
  app/
    api.py                          # Creates the FastAPI app and mounts routers
    core/                           # Shared paths, SQL, and record utilities
    diagnostics/                    # Environment and package-check endpoints
    dashboards/
      critical_team/                # Critical Team dashboard API
```

Add future team dashboards as sibling router modules under `backend/app/dashboards`.

## Run

Use the package path:

```powershell
conda run -n portal uvicorn backend.app.api:app --host 127.0.0.1 --port 8000
```

Runtime logs are written under `backend/app`:

```text
backend/app/api.log
backend/app/api.err.log
```
