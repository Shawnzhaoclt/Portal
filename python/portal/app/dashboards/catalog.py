from __future__ import annotations

import os
from typing import Any

from portal.runtime.transport import APIRouter, Request

from portal.app.resources.metadata import catalog_resource_metadata

router = APIRouter(prefix="/api/dashboards", tags=["dashboard-catalog"])

CRITICAL_TEAM_SHEET_ROUTES = {
    "overview": "/dashboard_critical_team_overview",
    "insp-proj-start-date": "/dashboard_critical_team_inspection_project_start_date",
    "insp-comp-date-bar-chart": "/dashboard_critical_team_inspection_completion_date_chart",
    "report-comp-date-chart": "/dashboard_critical_team_report_completion_date_chart",
    "insp-comp-date-reviews": "/dashboard_critical_team_inspection_completion_date_reviews",
    "insp-comp-date-table": "/tab_critical_team_inspection_completion_date",
    "report-comp-date-table": "/tab_critical_team_report_completion_date",
    "insp-comp-date-reviews-table": "/tab_critical_team_review_completion_date",
    "workorders": "/tab_critical_team_work_order_detail",
}

CRITICAL_ASSET_SHEET_ROUTES = {
    "condition-facility-aggregate-both": "/dashboard_critical_asset_condition_facility_aggregate_both",
    "clog-facility-aggregate-pipes": "/dashboard_critical_asset_clog_facility_aggregate_pipes",
    "history-table-both": "/tab_critical_asset_history_both",
}

def _catalog_item_from_metadata(item: dict[str, Any]) -> dict[str, str]:
    return {
        "resource_id": item["resource_id"],
        "id": item["resource_slug"],
        "title": item["name"],
        "description": item.get("description") or "",
        "path": item["url"],
        "category": item.get("category") or "",
        "kind": item["type"],
    }


DASHBOARDS: list[dict[str, str]] = [_catalog_item_from_metadata(item) for item in catalog_resource_metadata()]


def _frontend_base_url(request: Request) -> str:
    configured = os.getenv("PORTAL_PUBLIC_FRONTEND_BASE_URL", "").strip()
    if configured:
        return configured.rstrip("/")

    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    if forwarded_proto and forwarded_host:
        return f"{forwarded_proto}://{forwarded_host}".rstrip("/")

    configured_default = os.getenv("PORTAL_DEFAULT_FRONTEND_BASE_URL", "").strip()
    if configured_default:
        return configured_default.rstrip("/")

    return str(request.base_url).rstrip("/")


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
