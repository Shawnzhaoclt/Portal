from __future__ import annotations

import sys

from dotenv import load_dotenv
from fastapi import FastAPI

from backend.app.dashboards.critical_assets import router as critical_assets_router
from backend.app.dashboards.critical_team import router as critical_team_router
from backend.app.diagnostics.routes import router as diagnostics_router

load_dotenv()

app = FastAPI(
    title="ARF Dashboard API",
    description="REST endpoints for ARF dashboard data, diagnostics, and spatial samples.",
    version="0.1.0",
)

app.include_router(critical_team_router)
app.include_router(critical_assets_router)
app.include_router(diagnostics_router)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "message": "ARF Dashboard API",
        "docs": "/docs",
        "all_tests": "/api/tests/all",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "python": sys.version.split()[0]}
