from __future__ import annotations

import sys
import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.dashboards.catalog import router as dashboard_catalog_router
from backend.app.dashboards.critical_assets import router as critical_assets_router
from backend.app.dashboards.critical_team import router as critical_team_router
from backend.app.dashboards.gis import router as gis_router
from backend.app.diagnostics.routes import router as diagnostics_router

load_dotenv()

app = FastAPI(
    title="Portal Dashboard API",
    description="REST endpoints for Portal dashboard data, diagnostics, and spatial samples.",
    version="0.1.0",
)

DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://10.40.68.23:5173",
]


def cors_origins() -> list[str]:
    configured = os.getenv("PORTAL_CORS_ORIGINS", os.getenv("ARF_CORS_ORIGINS", ""))
    extra_origins = [origin.strip() for origin in configured.split(",") if origin.strip()]
    return [*DEFAULT_CORS_ORIGINS, *extra_origins]


app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_origin_regex=os.getenv("PORTAL_CORS_ORIGIN_REGEX", os.getenv("ARF_CORS_ORIGIN_REGEX", "")) or None,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dashboard_catalog_router)
app.include_router(critical_team_router)
app.include_router(critical_assets_router)
app.include_router(gis_router)
app.include_router(diagnostics_router)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "message": "Portal Dashboard API",
        "docs": "/docs",
        "all_tests": "/api/tests/all",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "python": sys.version.split()[0]}
