from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.management.database import get_db
from portal.app.management.models import Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.services import ADMIN_ROLES, effective_resource_permission, selected_user_role
from portal.runtime.transport import APIRouter, Depends, HTTPException, Query, Response

from .asset_extract import boundary_geometry, build_excel, build_geopackage, catalog, preview, search_boundaries


RESOURCE_KEY = "stm_risk_map"
router = APIRouter(prefix="/api/map/asset-data-extract", tags=["STM Risk Map Asset Data Extract"])


def _resource(db: Session) -> Resource | None:
    return db.scalar(select(Resource).where(Resource.resource_key == RESOURCE_KEY, Resource.is_active == 1))


def _permission_types(db: Session, user: User) -> set[str]:
    if selected_user_role(user) in ADMIN_ROLES:
        return {"view", "create", "edit", "manage", "admin"}
    resource = _resource(db)
    if resource is None:
        raise HTTPException(status_code=503, detail="Storm Water Asset Risk Map is not registered in the Portal catalog.")
    permission = effective_resource_permission(db, user, resource)
    return set((permission or {}).get("permission_types") or [])


def _require_view(db: Session, user: User) -> None:
    if "view" not in _permission_types(db, user):
        raise HTTPException(status_code=403, detail="This map requires View permission.")


def _display_name(user: User) -> str:
    return f"{user.first_name} {user.last_name}".strip() or str(user.email or user.employee_id or "Portal user")


@router.get("/catalog")
def get_catalog(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    return catalog()


@router.get("/boundaries/search")
def find_boundaries(
    source_id: str = Query(...),
    q: str = Query(""),
    limit: int = Query(10),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    return search_boundaries(source_id, q, limit)


@router.post("/boundaries/geometry")
def get_boundary_geometry(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    feature_ids = payload.get("feature_ids")
    if not isinstance(feature_ids, list):
        raise HTTPException(status_code=422, detail="feature_ids must be a list.")
    return boundary_geometry(str(payload.get("source_id") or ""), feature_ids)


@router.post("/preview")
def preview_assets(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    return preview(payload)


@router.post("/export/excel")
def export_excel(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    _require_view(db, current_user)
    content = build_excel(payload, _display_name(current_user))
    filename = f"Storm_Water_Asset_Data_Extract_{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/export/geopackage")
def export_geopackage(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    _require_view(db, current_user)
    content = build_geopackage(payload)
    filename = f"Storm_Water_Asset_Data_Extract_{datetime.now().strftime('%Y%m%d-%H%M%S')}.gpkg"
    return Response(
        content=content,
        media_type="application/geopackage+sqlite3",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
