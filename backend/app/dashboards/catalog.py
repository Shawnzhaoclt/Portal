from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/dashboards", tags=["dashboard-catalog"])


DASHBOARDS: list[dict[str, str]] = [
    {
        "id": "critical_team",
        "title": "Critical Team Dashboard",
        "description": "Work order status, milestone trends, and critical team inspection details.",
        "path": "/dashboard_critical_team",
        "category": "Operations",
    },
    {
        "id": "critical_asset_tracking",
        "title": "Critical Asset Tracking",
        "description": "Risk assessment tables and facility aggregate views for tracked critical assets.",
        "path": "/dashboard_critical_asset_tracking",
        "category": "Risk",
    },
    {
        "id": "gis_critical_asset_facility",
        "title": "Critical Asset Facility",
        "description": "Spatial view of culvert facilities, pipes, structures, and current risk values.",
        "path": "/dashboard_gis_critical_asset_facility",
        "category": "Maps",
    },
    {
        "id": "gis_critical_asset_history",
        "title": "Critical Asset History",
        "description": "Spatial view focused on assets with multiple inspections and risk changes over time.",
        "path": "/dashboard_gis_critical_asset_history",
        "category": "Maps",
    },
]


def _frontend_base_url(request: Request) -> str:
    configured = os.getenv("PORTAL_PUBLIC_FRONTEND_BASE_URL", os.getenv("ARF_PUBLIC_FRONTEND_BASE_URL", "")).strip()
    if configured:
        return configured.rstrip("/")

    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    if forwarded_proto and forwarded_host:
        return f"{forwarded_proto}://{forwarded_host}".rstrip("/")

    return os.getenv(
        "PORTAL_DEFAULT_FRONTEND_BASE_URL",
        os.getenv("ARF_DEFAULT_FRONTEND_BASE_URL", "http://10.40.68.23:5173"),
    ).rstrip("/")


@router.get("")
def dashboard_catalog(request: Request) -> dict[str, Any]:
    base_url = _frontend_base_url(request)
    dashboards = []
    for dashboard in DASHBOARDS:
        url = f"{base_url}{dashboard['path']}"
        dashboards.append(
            {
                **dashboard,
                "url": url,
                "embed_url": f"{url}?embed=1",
                "iframe": (
                    f'<iframe src="{url}?embed=1" width="100%" height="900" '
                    f'style="border:0;" loading="lazy" title="{dashboard["title"]}"></iframe>'
                ),
            }
        )

    return {
        "base_url": base_url,
        "dashboards": dashboards,
        "integration_page": f"{base_url}/dashboard_links",
    }
