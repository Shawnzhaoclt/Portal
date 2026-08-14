from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.management.database import get_db
from portal.app.management.models import Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.services import ADMIN_ROLES, effective_resource_permission, selected_user_role
from portal.runtime.transport import APIRouter, Depends, HTTPException, Response

from .terrain_profile import build_terrain_profile, build_terrain_profile_excel


RESOURCE_KEY = "stm_risk_map"
router = APIRouter(prefix="/api/map/terrain-profile", tags=["STM Risk Map Terrain Profile"])


def _resource(db: Session) -> Resource | None:
    return db.scalar(select(Resource).where(Resource.resource_key == RESOURCE_KEY, Resource.is_active == 1))


def _require_view(db: Session, user: User) -> None:
    if selected_user_role(user) in ADMIN_ROLES:
        return
    resource = _resource(db)
    if resource is None:
        raise HTTPException(status_code=503, detail="Storm Water Asset Risk Map is not registered in the Portal catalog.")
    permission = effective_resource_permission(db, user, resource)
    if "view" not in set((permission or {}).get("permission_types") or []):
        raise HTTPException(status_code=403, detail="This map requires View permission.")


def _display_name(user: User) -> str:
    return f"{user.first_name} {user.last_name}".strip() or str(user.email or user.employee_id or "Portal user")


@router.post("")
def create_profile(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    return build_terrain_profile(payload)


@router.post("/export/excel")
def export_profile(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    _require_view(db, current_user)
    content = build_terrain_profile_excel(payload, _display_name(current_user))
    filename = f"Storm_Water_Terrain_Profile_{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
