from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.management.database import get_db
from portal.app.management.models import Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.services import ADMIN_ROLES, effective_resource_permission, selected_user_role
from portal.runtime.transport import APIRouter, Depends, HTTPException

from .failure_consequence import build_failure_consequence


RESOURCE_KEY = "stm_risk_map"
router = APIRouter(prefix="/api/map/failure-consequence", tags=["STM Risk Map Failure Consequence"])


def _require_view(db: Session, user: User) -> None:
    if selected_user_role(user) in ADMIN_ROLES:
        return
    resource = db.scalar(
        select(Resource).where(Resource.resource_key == RESOURCE_KEY, Resource.is_active == 1)
    )
    if resource is None:
        raise HTTPException(status_code=503, detail="Storm Water Asset Risk Map is not registered in the Portal catalog.")
    permission = effective_resource_permission(db, user, resource)
    if "view" not in set((permission or {}).get("permission_types") or []):
        raise HTTPException(status_code=403, detail="This map requires View permission.")


@router.post("")
def analyze_failure_consequence(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    return build_failure_consequence(payload)
