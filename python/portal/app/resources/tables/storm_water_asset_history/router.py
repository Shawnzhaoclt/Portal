from __future__ import annotations

import os
import json
import re
from datetime import date, datetime
from typing import Any, Literal
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.exports import ExcelColumn, ExcelSheet, build_portal_excel_workbook
from portal.app.management.database import get_db
from portal.app.management.models import Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.services import ADMIN_ROLES, effective_resource_permission, selected_user_role
from portal.runtime.transport import APIRouter, Depends, HTTPException, Query, Response

from .source import (
    activity_history,
    asset_summary,
    assignment_status,
    itpipes_defect_count,
    itpipes_defects,
    priority_pipe_risk,
    priority_pipe_risk_count,
    record_detail,
    search_assets,
    source_status,
    timeline_events,
)


RESOURCE_KEY = "storm_water_asset_history"
PARENT_RESOURCE_KEY = "stm_risk_map"
router = APIRouter(prefix="/api/tables/storm-water-asset-history", tags=["Storm Water Asset History"])


def _resources(db: Session) -> list[Resource]:
    return list(
        db.scalars(
            select(Resource).where(
                Resource.resource_key.in_((RESOURCE_KEY, PARENT_RESOURCE_KEY)),
                Resource.is_active == 1,
            )
        )
    )


def _require_view(db: Session, user: User) -> None:
    if selected_user_role(user) in ADMIN_ROLES:
        return
    resources = _resources(db)
    if not resources:
        raise HTTPException(status_code=503, detail="Storm Water Asset History and its Risk Map parent are unavailable.")
    for resource in resources:
        permission = effective_resource_permission(db, user, resource)
        if "view" in set((permission or {}).get("permission_types") or []):
            return
    raise HTTPException(status_code=403, detail="This tool requires View permission on Asset History or the Storm Water Asset Risk Map.")


def _display_name(user: User) -> str:
    full_name = f"{user.first_name} {user.last_name}".strip()
    return full_name or str(user.email or user.employee_id or "Portal user")


def _cityworks_url(kind: str, record_id: str) -> str | None:
    environment = {
        "inspection": "PORTAL_CITYWORKS_INSPECTION_URL_TEMPLATE",
        "investigation": "PORTAL_CITYWORKS_INVESTIGATION_URL_TEMPLATE",
        "work_order": "PORTAL_CITYWORKS_WORKORDER_URL_TEMPLATE",
        "service_request": "PORTAL_CITYWORKS_REQUEST_URL_TEMPLATE",
    }.get(kind)
    template = str(os.getenv(environment or "") or "").strip()
    if not template:
        return None
    encoded = quote(str(record_id), safe="")
    return template.replace("{id}", encoded).replace("{record_id}", encoded)


def _all(asset_type: str, asset_id: str) -> dict[str, Any]:
    asset = asset_summary(asset_type, asset_id)
    assignment = assignment_status(asset["asset_id"])
    history = activity_history(asset_type, asset["asset_id"])
    for values in history.values():
        for item in values:
            item["source_url"] = _cityworks_url(item["kind"], item["record_id"])
    timeline = timeline_events(history, asset)
    return {
        "asset": asset,
        "assignment": assignment,
        "history": history,
        "timeline": timeline,
        "itpipes_defects": itpipes_defects(asset["asset_id"]),
        "pipe_risk": priority_pipe_risk(asset["asset_id"]) if asset_type.casefold() == "pipe" else [],
        "sources": source_status(),
    }


def _unavailable_assignment(error: HTTPException) -> dict[str, Any]:
    message = str(error.detail if getattr(error, "detail", None) else error)
    return {
        "combined": "data_unavailable",
        "branches": {
            "cityworks": {"state": "data_unavailable", "context": {}},
            "itpipes": {"state": "data_unavailable", "context": {}},
        },
        "source_id": "intermediate.riskranking",
        "version": "",
        "published_at": None,
        "error": message,
    }


def _filter(
    rows: list[dict[str, Any]],
    *,
    search: str,
    status: str,
    relationship: str,
    from_date: str,
    to_date: str,
) -> list[dict[str, Any]]:
    needle = search.strip().casefold()
    status_value = status.strip().casefold()
    relationship_value = relationship.strip().casefold()
    result: list[dict[str, Any]] = []
    for row in rows:
        if status_value and str(row.get("status") or "").casefold() != status_value:
            continue
        if relationship_value and relationship_value not in str(row.get("relationship") or "").casefold():
            continue
        event_date = str(row.get("event_date") or "")[:10]
        if from_date and event_date and event_date < from_date:
            continue
        if to_date and event_date and event_date > to_date:
            continue
        if needle:
            haystack = " ".join(
                str(row.get(key) or "")
                for key in ("record_id", "event_name", "event_field", "status", "title", "summary", "relationship", "related_id", "person")
            ).casefold()
            if needle not in haystack:
                continue
        result.append(row)
    return result


def _filter_itpipes_defects(
    rows: list[dict[str, Any]],
    *,
    search: str,
    from_date: str,
    to_date: str,
) -> list[dict[str, Any]]:
    needle = search.strip().casefold()
    result: list[dict[str, Any]] = []
    for row in rows:
        inspection_date = str(row.get("inspection_date") or "")[:10]
        if from_date and inspection_date and inspection_date < from_date:
            continue
        if to_date and inspection_date and inspection_date > to_date:
            continue
        if needle:
            haystack = " ".join(
                str(row.get(key) or "")
                for key in (
                    "mli_id",
                    "mlo_id",
                    "ml_id",
                    "inspection_direction",
                    "observation_text",
                    "distance",
                    "relative_depth",
                    "condition_risk",
                    "flood_risk",
                    "clogging_risk",
                    "risk",
                )
            ).casefold()
            if needle not in haystack:
                continue
        result.append(row)
    return result


def _filter_pipe_risk(rows: list[dict[str, Any]], *, search: str) -> list[dict[str, Any]]:
    needle = search.strip().casefold()
    if not needle:
        return rows
    return [
        row
        for row in rows
        if needle in " ".join(
            str(row.get(key) or "")
            for key in ("asset_id", "basin_name", "work_zone_id", "cl_score", "lof_score", "cof_score", "risk")
        ).casefold()
    ]


@router.get("/source-status")
def get_source_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    return {"sources": source_status()}


@router.get("/asset-candidates")
def get_asset_candidates(
    query: str = Query(min_length=2, max_length=100),
    limit: int = Query(default=10, ge=1, le=10),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    results = search_assets(query, limit)
    return {"query": query, "results": results, "returned": len(results)}


@router.get("/assets/{asset_type}/{asset_id}/summary")
def get_asset_summary(
    asset_type: str,
    asset_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    asset = asset_summary(asset_type, asset_id)
    errors: dict[str, str] = {}
    try:
        assignment = assignment_status(asset["asset_id"])
    except HTTPException as error:
        assignment = _unavailable_assignment(error)
        errors["assignment"] = str(assignment["error"])
    try:
        history = activity_history(asset_type, asset["asset_id"])
        counts = {key: len(value) for key, value in history.items()}
        counts["timeline"] = len(timeline_events(history, asset))
    except HTTPException as error:
        errors["history"] = str(error.detail if getattr(error, "detail", None) else error)
        counts = {key: 0 for key in ("service_requests", "investigations", "inspections", "work_orders", "timeline")}
    try:
        counts["itpipes_defects"] = itpipes_defect_count(asset["asset_id"])
    except HTTPException as error:
        errors["itpipes_defects"] = str(error.detail if getattr(error, "detail", None) else error)
        counts["itpipes_defects"] = 0
    if asset_type.casefold() == "pipe":
        try:
            counts["pipe_risk"] = priority_pipe_risk_count(asset["asset_id"])
        except HTTPException as error:
            errors["pipe_risk"] = str(error.detail if getattr(error, "detail", None) else error)
            counts["pipe_risk"] = 0
    else:
        counts["pipe_risk"] = 0
    return {
        "asset": asset,
        "assignment": assignment,
        "counts": counts,
        "sources": source_status(),
        "errors": errors,
    }


@router.get("/assets/{asset_type}/{asset_id}/records")
def get_asset_records(
    asset_type: str,
    asset_id: str,
    kind: Literal["timeline", "service_requests", "investigations", "inspections", "work_orders", "itpipes_defects", "pipe_risk"] = "timeline",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=10, le=100),
    search: str = Query(default="", max_length=200),
    status: str = Query(default="", max_length=100),
    relationship: str = Query(default="", max_length=100),
    from_date: str = Query(default="", max_length=10),
    to_date: str = Query(default="", max_length=10),
    sort: Literal["event_date", "record_id", "status", "title"] = "event_date",
    direction: Literal["asc", "desc"] = "desc",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    asset = asset_summary(asset_type, asset_id)
    if kind == "itpipes_defects":
        rows = _filter_itpipes_defects(
            itpipes_defects(asset["asset_id"]),
            search=search,
            from_date=from_date,
            to_date=to_date,
        )
        total = len(rows)
        start = (page - 1) * page_size
        return {
            "kind": kind,
            "page": page,
            "page_size": page_size,
            "total": total,
            "items": rows[start:start + page_size],
        }
    if kind == "pipe_risk":
        rows = _filter_pipe_risk(
            priority_pipe_risk(asset["asset_id"]) if asset_type.casefold() == "pipe" else [],
            search=search,
        )
        rows.sort(key=lambda row: float(row.get("risk") or 0), reverse=True)
        total = len(rows)
        start = (page - 1) * page_size
        return {
            "kind": kind,
            "page": page,
            "page_size": page_size,
            "total": total,
            "items": rows[start:start + page_size],
        }
    history = activity_history(asset_type, asset["asset_id"])
    timeline = timeline_events(history, asset)
    rows = timeline if kind == "timeline" else history[kind]
    for item in rows:
        item["source_url"] = _cityworks_url(item["kind"], item["record_id"])
    rows = _filter(rows, search=search, status=status, relationship=relationship, from_date=from_date, to_date=to_date)
    rows.sort(key=lambda row: str(row.get(sort) or "").casefold(), reverse=direction == "desc")
    total = len(rows)
    start = (page - 1) * page_size
    return {
        "kind": kind,
        "page": page,
        "page_size": page_size,
        "total": total,
        "record_total": len({(row.get("kind"), row.get("record_id")) for row in rows}) if kind == "timeline" else total,
        "items": rows[start:start + page_size],
    }


@router.get("/records/{kind}/{record_id}")
def get_record_detail(
    kind: str,
    record_id: str,
    work_zone_id: str = Query(default=""),
    asset_type: str = Query(default=""),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    if kind == "asset":
        if asset_type.casefold() not in {"structure", "pipe", "channel"}:
            raise HTTPException(status_code=422, detail="Asset type is required for an inventory record.")
        asset = asset_summary(asset_type, record_id)
        result = {
            "kind": "asset",
            "record_id": asset["asset_id"],
            "fields": asset["all_fields"],
            "questions": [],
        }
    else:
        result = record_detail(kind, record_id, work_zone_id=work_zone_id)
    result["source_url"] = _cityworks_url(kind, record_id)
    return result


SUMMARY_COLUMNS = (
    ExcelColumn("field", "Field", 26),
    ExcelColumn("value", "Value", 42, wrap_text=True),
)


def _record_type_label(value: Any) -> str:
    return str(value or "").replace("_", " ").title()


ACTIVITY_COLUMNS = (
    ExcelColumn("event_date", "Event date", 22, "datetime"),
    ExcelColumn("kind", "Type", 18, transform=_record_type_label),
    ExcelColumn("record_id", "Record ID", 18),
    ExcelColumn("status", "Status", 16),
    ExcelColumn("title", "Title", 34, wrap_text=True),
    ExcelColumn("summary", "Summary", 44, wrap_text=True),
    ExcelColumn("relationship", "Relationship", 28, wrap_text=True),
    ExcelColumn("priority", "Priority", 14),
    ExcelColumn("person", "Person", 20),
    ExcelColumn("related_id", "Related record", 22),
)
TIMELINE_COLUMNS = (
    ExcelColumn("event_date", "Event date", 22, "datetime"),
    ExcelColumn("event_name", "Event", 24),
    ExcelColumn("kind", "Record type", 18),
    ExcelColumn("record_id", "Record ID", 18),
    ExcelColumn("status", "Current status", 16),
    ExcelColumn("title", "Title", 34, wrap_text=True),
    ExcelColumn("summary", "Summary", 44, wrap_text=True),
    ExcelColumn("relationship", "Relationship", 28, wrap_text=True),
    ExcelColumn("event_field", "Source date field", 24),
)
INSPECTION_COLUMNS = (
    ExcelColumn("event_date", "Inspection date", 22, "datetime"),
    ExcelColumn("kind", "Type", 18, transform=_record_type_label),
    ExcelColumn("record_id", "Inspection ID", 18),
    ExcelColumn("status", "Status", 16),
    ExcelColumn("condition_risk", "Condition Risk", 16, "number"),
    ExcelColumn("flood_risk", "Flood Risk", 14, "number"),
    ExcelColumn("clogging_risk", "Clogging Risk", 16, "number"),
    ExcelColumn("risk", "Risk", 14, "number"),
    ExcelColumn("title", "Title", 34, wrap_text=True),
    ExcelColumn("summary", "Summary", 44, wrap_text=True),
    ExcelColumn("person", "Inspector", 20),
    ExcelColumn("relationship", "Relationship", 28, wrap_text=True),
)
ITPIPES_DEFECT_COLUMNS = (
    ExcelColumn("inspection_date", "Inspection Date", 20, "datetime"),
    ExcelColumn("mli_id", "MLI ID", 14),
    ExcelColumn("mlo_id", "MLO ID", 14),
    ExcelColumn("ml_id", "ML ID", 14),
    ExcelColumn("inspection_direction", "Inspection Direction", 20),
    ExcelColumn("is_continuous", "Is Continuous", 14),
    ExcelColumn("observation_text", "Observation Text", 42, wrap_text=True),
    ExcelColumn("distance", "Distance", 14, "number"),
    ExcelColumn("relative_depth", "Relative Depth", 16, "number"),
    ExcelColumn("condition_risk", "Condition Risk", 16, "number"),
    ExcelColumn("flood_risk", "Flood Risk", 14, "number"),
    ExcelColumn("clogging_risk", "Clogging Risk", 16, "number"),
    ExcelColumn("risk", "Risk", 14, "number"),
)
PIPE_RISK_COLUMNS = (
    ExcelColumn("basin_name", "Basin Name", 22),
    ExcelColumn("work_zone_id", "Work Zone ID", 18),
    ExcelColumn("cl_score", "CL Score", 14),
    ExcelColumn("lof_score", "LOF Score", 14),
    ExcelColumn("cof_score", "COF Score", 14),
    ExcelColumn("risk", "Risk", 14),
)

EXPORT_KINDS = ("service_requests", "investigations", "inspections", "work_orders", "itpipes_defects", "pipe_risk")
VISIBLE_SOURCE_FIELDS = {
    "service_requests": {"REQUESTID", "DATETIMEINIT", "DATETIMECLOSED", "STATUS", "PRIORITY", "DESCRIPTION", "PROBLEMCODE", "DETAILS", "PROBADDRESS", "INITIATEDBY"},
    "investigations": {"INSPECTIONID", "INSPDATE", "INITIATEDATE", "DATECLOSED", "STATUS", "PRIORITY", "INSPTEMPLATENAME", "DESCRIPTION", "OBSERVATIONSUM", "LOCATION", "INSPECTEDBY", "INITIATEDBY"},
    "inspections": {"INSPECTIONID", "INSPDATE", "INITIATEDATE", "DATECLOSED", "STATUS", "PRIORITY", "INSPTEMPLATENAME", "DESCRIPTION", "OBSERVATIONSUM", "LOCATION", "INSPECTEDBY", "INITIATEDBY", "COND_RISK", "FLOOD_RISK", "CLOG_RISK", "RISK"},
    "work_orders": {"WORKORDERID", "INITIATEDATE", "ACTUALSTARTDATE", "DATEWOCLOSED", "STATUS", "PRIORITY", "DESCRIPTION", "PROJECTNAME", "LOCATION", "WORKCOMPLETEDBY", "SUPERVISOR", "INITIATEDBY"},
    "itpipes_defects": {"ITPIPE_ASSETID", "MLI_ID", "MLO_ID", "ML_ID", "INSPECTION_DATE", "INSPECTION_DIRECTION", "IS_CONTINUOUS", "OBSERVATION_TEXT", "DISTANCE", "RELATIVE_DEPTH", "COND_RISK", "FLOOD_RISK", "CLOG_RISK", "RISK"},
    "pipe_risk": {"ITPIPE_ASSETID", "BASIN_NAME", "WORKZONEID", "CL_SCORE", "LOF_SCORE", "COF_SCORE", "RISK"},
}


def _field_label(field: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", field.replace("_", " "))).strip().title()


def _additional_field_catalog(payload: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    result: dict[str, list[dict[str, str]]] = {}
    for kind in EXPORT_KINDS:
        rows = payload["history"].get(kind, []) if kind in payload["history"] else payload[kind]
        hidden = VISIBLE_SOURCE_FIELDS.get(kind, set())
        fields = sorted({str(key) for row in rows for key in (row.get("source_attributes") or {}) if str(key).upper() not in hidden}, key=str.casefold)
        result[kind] = [{"key": field, "label": _field_label(field)} for field in fields]
    return result


def _selected_export_fields(raw: str, catalog: dict[str, list[dict[str, str]]]) -> dict[str, list[str]]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="Additional export fields are invalid.") from error
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=422, detail="Additional export fields must be grouped by worksheet.")
    selected: dict[str, list[str]] = {}
    for kind, values in parsed.items():
        if kind not in EXPORT_KINDS or not isinstance(values, list):
            continue
        allowed = {field["key"] for field in catalog.get(kind, [])}
        cleaned = list(dict.fromkeys(str(value) for value in values if str(value) in allowed))[:100]
        if cleaned:
            selected[kind] = cleaned
    return selected


def _with_additional_fields(
    rows: list[dict[str, Any]],
    fields: list[str],
) -> tuple[list[ExcelColumn], list[dict[str, Any]]]:
    def data_type(field: str) -> Literal["text", "number", "integer", "date", "datetime"]:
        values = [(row.get("source_attributes") or {}).get(field) for row in rows]
        value = next((candidate for candidate in values if candidate is not None), None)
        if isinstance(value, datetime):
            return "datetime"
        if isinstance(value, date):
            return "date"
        if isinstance(value, bool):
            return "text"
        if isinstance(value, int):
            return "integer"
        if isinstance(value, float):
            return "number"
        return "text"

    columns = [ExcelColumn(f"source::{field}", _field_label(field), 22, data_type(field), wrap_text=True) for field in fields]
    enriched: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        attributes = row.get("source_attributes") or {}
        for field in fields:
            item[f"source::{field}"] = attributes.get(field)
        enriched.append(item)
    return columns, enriched


@router.get("/assets/{asset_type}/{asset_id}/export-fields")
def get_export_fields(
    asset_type: str,
    asset_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    payload = _all(asset_type, asset_id)
    return {"worksheets": _additional_field_catalog(payload)}


@router.get("/assets/{asset_type}/{asset_id}/export")
def export_asset_history(
    asset_type: str,
    asset_id: str,
    search: str = Query(default="", max_length=200),
    status: str = Query(default="", max_length=100),
    relationship: str = Query(default="", max_length=100),
    from_date: str = Query(default="", max_length=10),
    to_date: str = Query(default="", max_length=10),
    additional_fields: str = Query(default="", max_length=12000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    _require_view(db, current_user)
    payload = _all(asset_type, asset_id)
    filters = {"Search": search, "Status": status, "Relationship": relationship, "From": from_date, "To": to_date}
    history = {
        key: _filter(value, search=search, status=status, relationship=relationship, from_date=from_date, to_date=to_date)
        for key, value in payload["history"].items()
    }
    timeline = _filter(payload["timeline"], search=search, status=status, relationship=relationship, from_date=from_date, to_date=to_date)
    defects = _filter_itpipes_defects(
        payload["itpipes_defects"],
        search=search,
        from_date=from_date,
        to_date=to_date,
    )
    pipe_risk = _filter_pipe_risk(payload["pipe_risk"], search=search)
    catalog = _additional_field_catalog(payload)
    selected_fields = _selected_export_fields(additional_fields, catalog)
    sheet_rows = {
        "service_requests": history["service_requests"],
        "investigations": history["investigations"],
        "inspections": history["inspections"],
        "work_orders": history["work_orders"],
        "itpipes_defects": defects,
        "pipe_risk": pipe_risk,
    }
    extra_columns: dict[str, list[ExcelColumn]] = {}
    for kind, rows in sheet_rows.items():
        extra_columns[kind], sheet_rows[kind] = _with_additional_fields(rows, selected_fields.get(kind, []))
    asset_rows = [
        {"field": "Asset ID", "value": payload["asset"]["asset_id"]},
        {"field": "Asset type", "value": payload["asset"]["asset_type"].title()},
        {"field": "Inventory status", "value": payload["asset"].get("status")},
        {"field": "Combined Step 401 status", "value": payload["assignment"]["combined"].replace("_", " ").title()},
        *({"field": key, "value": value} for key, value in payload["asset"]["summary"].items()),
        *({"field": f"{key.title()} source version", "value": source.get("version") or source.get("published_at") or "Unavailable"} for key, source in payload["sources"].items()),
    ]
    sheets = [
        ExcelSheet("Asset Summary", "Asset Summary", SUMMARY_COLUMNS, asset_rows),
        ExcelSheet("Timeline", "Asset Lifecycle Timeline", TIMELINE_COLUMNS, timeline, filters),
        ExcelSheet("Service Requests", "Service Requests", (*ACTIVITY_COLUMNS, *extra_columns["service_requests"]), sheet_rows["service_requests"], filters),
        ExcelSheet("Investigations", "Investigations", (*ACTIVITY_COLUMNS, *extra_columns["investigations"]), sheet_rows["investigations"], filters),
        ExcelSheet("Inspections", "Inspections", (*INSPECTION_COLUMNS, *extra_columns["inspections"]), sheet_rows["inspections"], filters),
        ExcelSheet("Work Orders", "Work Orders", (*ACTIVITY_COLUMNS, *extra_columns["work_orders"]), sheet_rows["work_orders"], filters),
        ExcelSheet("ITPipes Defects", "ITPipes Defects", (*ITPIPES_DEFECT_COLUMNS, *extra_columns["itpipes_defects"]), sheet_rows["itpipes_defects"], filters),
    ]
    if pipe_risk:
        sheets.append(ExcelSheet("Pipe Risk", "Pipe Risk Information", (*PIPE_RISK_COLUMNS, *extra_columns["pipe_risk"]), sheet_rows["pipe_risk"], {"Search": search}))
    filename = f"Storm_Water_Asset_History_{payload['asset']['asset_id']}_{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"
    workbook = build_portal_excel_workbook(
        report_title=f"Storm Water Asset History - {payload['asset']['asset_id']}",
        sheets=sheets,
        exported_by=_display_name(current_user),
        vertical_alignment="center",
        number_format="0.###",
    )
    return Response(content=workbook, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f'attachment; filename="{filename}"'})
