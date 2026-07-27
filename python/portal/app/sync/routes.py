from __future__ import annotations

from typing import Any

from portal.runtime.transport import APIRouter, HTTPException

from .errors import (
    IdentityRejected,
    LockTimeout,
    RevisionChanged,
    SharedRootUnavailable,
    SnapshotRequired,
    SyncError,
)
from .models import Identity, Mutation
from .runtime import current_coordinator

router = APIRouter(prefix="/api/sync", tags=["business-sync"])

def _identity(payload: dict[str, Any]) -> Identity:
    value = payload.get("identity") if isinstance(payload.get("identity"), dict) else payload
    return Identity(
        user_id=str(value.get("user_id", "")),
        employee_number=str(value.get("employee_number", "")),
        email=str(value.get("email", "")),
    )


def _current(payload: dict[str, Any]):
    return current_coordinator(_identity(payload))


def _raise_transport(error: SyncError) -> None:
    if isinstance(error, IdentityRejected):
        status = 403
    elif isinstance(error, RevisionChanged):
        status = 409
    elif isinstance(error, LockTimeout):
        status = 423
    elif isinstance(error, (SharedRootUnavailable, SnapshotRequired)):
        status = 503
    else:
        status = 422
    raise HTTPException(
        status_code=status,
        detail={"code": error.code, "message": str(error), "details": error.details},
    )


@router.post("/initialize")
def initialize_sync(payload: dict[str, Any]) -> dict[str, object]:
    try:
        return _current(payload).status()
    except SyncError as error:
        _raise_transport(error)


@router.post("/status")
def sync_status(payload: dict[str, Any]) -> dict[str, object]:
    try:
        return _current(payload).status()
    except SyncError as error:
        _raise_transport(error)


@router.post("/pull")
def pull_sync(payload: dict[str, Any]) -> dict[str, object]:
    try:
        coordinator = _current(payload)
        return {"cursors": coordinator.sync(), "status": coordinator.status()}
    except SyncError as error:
        _raise_transport(error)


@router.post("/recover")
def recover_sync(payload: dict[str, Any]) -> dict[str, object]:
    try:
        return _current(payload).recover()
    except SyncError as error:
        _raise_transport(error)


@router.post("/commit")
def commit_sync(payload: dict[str, Any]) -> dict[str, object]:
    try:
        mutation_values = payload.get("mutations")
        if not isinstance(mutation_values, list):
            raise HTTPException(status_code=422, detail="mutations must be an array")
        if not all(isinstance(item, dict) for item in mutation_values):
            raise HTTPException(status_code=422, detail="each mutation must be an object")
        try:
            mutations = [Mutation(**item) for item in mutation_values]
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=f"invalid mutation: {error}") from error
        return vars(_current(payload).commit(mutations))
    except SyncError as error:
        _raise_transport(error)


@router.post("/entity")
def get_sync_entity(payload: dict[str, Any]) -> dict[str, object]:
    try:
        entity_type = str(payload.get("entity_type", ""))
        entity_id = str(payload.get("entity_id", ""))
        entity = _current(payload).get_entity(entity_type, entity_id)
        return {"found": entity is not None, "entity": entity}
    except SyncError as error:
        _raise_transport(error)
