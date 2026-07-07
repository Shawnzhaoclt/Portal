from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Request

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


DASHBOARDS: list[dict[str, str]] = [
    {
        "id": "proactive_team_cctv_review",
        "title": "Proactive Team CCTV Review",
        "description": "Search CCTV pipe records, choose inspections, and compile proactive team review reports with defects and media.",
        "path": "/dashboard_proactive_team_cctv_review",
        "category": "Operations",
        "kind": "report",
    },
    {
        "id": "amteam_inspection_viewer",
        "title": "Proactive Team CCTV Review Report",
        "description": "Search CCTV pipe records, choose inspections, and compile review reports with defects and media.",
        "path": "/dashboard_amteam_inspection_viewer",
        "category": "Operations",
        "kind": "dashboard",
    },
    {
        "id": "critical_team",
        "title": "Critical Team Dashboard",
        "description": "Work order status, milestone trends, and critical team inspection details.",
        "path": "/dashboard_critical_team",
        "category": "Operations",
        "kind": "dashboard",
    },
    {
        "id": "critical_team_overview",
        "title": "Critical Team Overview",
        "description": "Cityworks Critical Asset Inspection work-order source and completion summary.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["overview"],
        "category": "Operations",
        "kind": "dashboard",
    },
    {
        "id": "critical_team_inspection_project_start_date",
        "title": "Inspection Project Start Date",
        "description": "Count of inspection work orders by project start month and assigned submitter.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["insp-proj-start-date"],
        "category": "Operations",
        "kind": "dashboard",
    },
    {
        "id": "critical_team_inspection_completion_date_chart",
        "title": "Inspection Completion Date Chart",
        "description": "Inspection completion date counts grouped by submitter.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["insp-comp-date-bar-chart"],
        "category": "Operations",
        "kind": "dashboard",
    },
    {
        "id": "critical_team_report_completion_date_chart",
        "title": "Report Completion Date Chart",
        "description": "Report completion date counts grouped by submitter.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["report-comp-date-chart"],
        "category": "Operations",
        "kind": "dashboard",
    },
    {
        "id": "critical_team_inspection_completion_date_reviews",
        "title": "Inspection Completion Date Reviews",
        "description": "Ready-for-review and review-complete work orders by closed date and reviewer.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["insp-comp-date-reviews"],
        "category": "Operations",
        "kind": "dashboard",
    },
    {
        "id": "critical_team_inspection_completion_date",
        "title": "Inspection Completion Date",
        "description": "Inspection completion date cross-tab by submitter.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["insp-comp-date-table"],
        "category": "Operations",
        "kind": "tab",
    },
    {
        "id": "critical_team_report_completion_date",
        "title": "Report Completion Date",
        "description": "Report completion date cross-tab by submitter.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["report-comp-date-table"],
        "category": "Operations",
        "kind": "tab",
    },
    {
        "id": "critical_team_review_completion_date",
        "title": "Review Completion Date",
        "description": "Review-complete cross-tab by reviewer and closed month.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["insp-comp-date-reviews-table"],
        "category": "Operations",
        "kind": "tab",
    },
    {
        "id": "critical_team_work_order_detail",
        "title": "Work Order Detail",
        "description": "Operational detail rows from the Cityworks Critical Asset Inspection source.",
        "path": CRITICAL_TEAM_SHEET_ROUTES["workorders"],
        "category": "Operations",
        "kind": "tab",
    },
    {
        "id": "planning_pending_aif_qa",
        "title": "Planning Pending AIF QA/QC",
        "description": "Pending Asset Inspection Form records for planning team QA/QC review.",
        "path": "/tab_planning_pending_aif_qa",
        "category": "Planning",
        "kind": "tab",
    },
    {
        "id": "critical_asset_tracking",
        "title": "Critical Asset Tracking",
        "description": "Risk assessment tables and facility aggregate views for tracked critical assets.",
        "path": "/dashboard_critical_asset_tracking",
        "category": "Risk",
        "kind": "dashboard",
    },
    {
        "id": "critical_asset_condition_facility_aggregate_both",
        "title": "Condition Risk Facility Aggregate - Both",
        "description": "Condition risk summarized by facility across pipes and structures.",
        "path": CRITICAL_ASSET_SHEET_ROUTES["condition-facility-aggregate-both"],
        "category": "Risk",
        "kind": "dashboard",
    },
    {
        "id": "critical_asset_clog_facility_aggregate_pipes",
        "title": "Clog Risk Facility Aggregate - Pipes",
        "description": "Clog risk summarized by facility for pipe assets.",
        "path": CRITICAL_ASSET_SHEET_ROUTES["clog-facility-aggregate-pipes"],
        "category": "Risk",
        "kind": "dashboard",
    },
    {
        "id": "critical_asset_history_both",
        "title": "History - Both",
        "description": "Paged, sortable inspection history across pipes and structures.",
        "path": CRITICAL_ASSET_SHEET_ROUTES["history-table-both"],
        "category": "Risk",
        "kind": "tab",
    },
    {
        "id": "gis_critical_asset_facility",
        "title": "Critical Asset Facility",
        "description": "Spatial view of culvert facilities, pipes, structures, and current risk values.",
        "path": "/map_critical_asset_facility",
        "category": "Maps",
        "kind": "map",
    },
    {
        "id": "gis_critical_asset_history",
        "title": "Critical Asset History",
        "description": "Spatial view focused on assets with multiple inspections and risk changes over time.",
        "path": "/map_critical_asset_history",
        "category": "Maps",
        "kind": "map",
    },
    {
        "id": "stm_risk_map",
        "title": "Storm Water Asset Risk Map",
        "description": "MapLibre PMTiles viewer for planning-team risk layers, asset search, inventory metrics, and risk summaries.",
        "path": "/map_stm_risk",
        "category": "Maps",
        "kind": "map",
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
