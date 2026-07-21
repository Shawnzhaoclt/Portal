from __future__ import annotations

import sys

from dotenv import load_dotenv
from portal.runtime.transport import LocalApplication

load_dotenv()

from portal.app.core.desktop_config import configure_environment

configure_environment()

from portal.app.dashboards.catalog import router as dashboard_catalog_router
from portal.app.dashboards.amteam import router as amteam_router
from portal.app.dashboards.critical_assets import router as critical_assets_router
from portal.app.dashboards.critical_team import router as critical_team_router
from portal.app.dashboards.gis import router as gis_router
from portal.app.dashboards.planning import router as planning_router
from portal.app.resources.maps.stm_risk_map import router as map_tiles_router
from portal.app.resources.reports.proactive_team_cctv_review import ensure_report_schema, router as cctv_review_report_router
from portal.app.diagnostics.routes import router as diagnostics_router
from portal.app.management import router as management_router
from portal.app.management.seed import initialize_management_database

app = LocalApplication(
    title="Portal Local Command Registry",
    description="In-process commands for Portal data, diagnostics, and spatial resources.",
    version="0.1.0",
)

app.include_router(dashboard_catalog_router)
app.include_router(amteam_router)
app.include_router(critical_team_router)
app.include_router(critical_assets_router)
app.include_router(gis_router)
app.include_router(planning_router)
app.include_router(map_tiles_router)
app.include_router(cctv_review_report_router)
app.include_router(diagnostics_router)
app.include_router(management_router)


@app.on_event("startup")
def startup() -> None:
    initialize_management_database()
    ensure_report_schema()


@app.get("/")
def root() -> dict[str, str]:
    return {
        "message": "Portal local Python runtime",
        "transport": "tauri-ipc",
        "all_tests": "/api/tests/all",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "python": sys.version.split()[0]}
