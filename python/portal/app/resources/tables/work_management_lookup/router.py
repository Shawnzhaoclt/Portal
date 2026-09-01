"""Work Management Lookup: find a Cityworks record and everything around it."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.management.database import get_db
from portal.app.management.models import Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.services import ADMIN_ROLES, effective_resource_permission, selected_user_role
from portal.runtime.transport import APIRouter, Depends, HTTPException, Query

from . import source


# The lookup reads the same Cityworks activity as Asset History, so it answers to
# the same permission rather than introducing a second one to keep in step.
RESOURCE_KEY = "work_management_lookup"
ASSET_HISTORY_RESOURCE_KEY = "storm_water_asset_history"
PARENT_RESOURCE_KEY = "stm_risk_map"

router = APIRouter(prefix="/api/tables/work-management-lookup", tags=["Work Management Lookup"])


def _resources(db: Session) -> list[Resource]:
    return list(
        db.scalars(
            select(Resource).where(
                Resource.resource_key.in_(
                    (RESOURCE_KEY, ASSET_HISTORY_RESOURCE_KEY, PARENT_RESOURCE_KEY)
                ),
                Resource.is_active == 1,
            )
        )
    )


def _require_view(db: Session, user: User) -> None:
    if selected_user_role(user) in ADMIN_ROLES:
        return
    resources = _resources(db)
    if not resources:
        raise HTTPException(
            status_code=503,
            detail="Work Management Lookup and the resources it reads are unavailable.",
        )
    for resource in resources:
        permission = effective_resource_permission(db, user, resource)
        if "view" in set((permission or {}).get("permission_types") or []):
            return
    raise HTTPException(
        status_code=403,
        detail="This tool requires View permission on Work Management Lookup, Asset History, or the Storm Water Asset Risk Map.",
    )


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


def _with_links(payload: dict[str, Any]) -> dict[str, Any]:
    record = payload.get("record") or {}
    record["cityworks_url"] = _cityworks_url(str(record.get("kind")), str(record.get("id")))
    for item in payload.get("related") or []:
        item["cityworks_url"] = _cityworks_url(str(item.get("kind")), str(item.get("id")))
    return payload


@router.get("/resolve")
def resolve_record(
    query: str = Query(..., min_length=1, max_length=64),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Which records carry this id - ids repeat across kinds, so this may be several."""
    _require_view(db, current_user)
    matches = source.resolve(query)
    for match in matches:
        match["cityworks_url"] = _cityworks_url(str(match.get("kind")), str(match.get("id")))
    return {"query": query, "matches": matches}


@router.get("/search")
def search_records(
    query: str = Query(..., min_length=2, max_length=120),
    limit: int = Query(10, ge=1, le=25),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Type-ahead candidates by number, problem, template or address."""
    _require_view(db, current_user)
    matches = source.search(query, limit)
    for match in matches:
        match["cityworks_url"] = _cityworks_url(str(match.get("kind")), str(match.get("id")))
    return {"query": query, "matches": matches}


@router.get("/records/{kind}/{record_id}")
def get_record(
    kind: str,
    record_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    return _with_links(source.record_detail(kind, record_id))
