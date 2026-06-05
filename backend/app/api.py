from __future__ import annotations

import sys

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.dashboards.critical_assets import router as critical_assets_router
from backend.app.dashboards.critical_team import router as critical_team_router
from backend.app.dashboards.gis import router as gis_router
from backend.app.diagnostics.routes import router as diagnostics_router

load_dotenv()

app = FastAPI(
    title="ARF Dashboard API",
    description="REST endpoints for ARF dashboard data, diagnostics, and spatial samples.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://10.40.68.23:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(critical_team_router)
app.include_router(critical_assets_router)
app.include_router(gis_router)
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
