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
# The CCTV review page embeds the same read-only screening for the pipe being reviewed,
# so View on either resource is enough to read it.
CONSEQUENCE_RESOURCE_IDS = ("RPT5W1C0",)
router = APIRouter(prefix="/api/map/failure-consequence", tags=["STM Risk Map Failure Consequence"])


def _consequence_resources(db: Session) -> list[Resource]:
    resources = [
        db.scalar(select(Resource).where(Resource.resource_key == RESOURCE_KEY, Resource.is_active == 1))
    ]
    resources.extend(
        db.scalar(select(Resource).where(Resource.resource_id == resource_id, Resource.is_active == 1))
        for resource_id in CONSEQUENCE_RESOURCE_IDS
    )
    return [resource for resource in resources if resource is not None]


def _require_view(db: Session, user: User) -> None:
    if selected_user_role(user) in ADMIN_ROLES:
        return
    resources = _consequence_resources(db)
    if not resources:
        raise HTTPException(status_code=503, detail="Storm Water Asset Risk Map is not registered in the Portal catalog.")
    for resource in resources:
        permission = effective_resource_permission(db, user, resource)
        if "view" in set((permission or {}).get("permission_types") or []):
            return
    raise HTTPException(
        status_code=403,
        detail="Consequence analysis requires View permission on the risk map or the CCTV review.",
    )


@router.post("")
def analyze_failure_consequence(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_view(db, current_user)
    return build_failure_consequence(payload)
