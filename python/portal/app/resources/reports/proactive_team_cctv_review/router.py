from __future__ import annotations

import copy
import hashlib
import re
from typing import Any, Literal

from portal.runtime.transport import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from portal.app.management.database import get_db
from portal.app.management.models import User
from portal.app.management.router import get_current_user
from portal.app.management.security import utc_now_text
from portal.app.management.services import ADMIN_ROLES, selected_user_role
from portal.app.sync.errors import LockTimeout, RevisionChanged, SharedRootUnavailable, SnapshotRequired, SyncError
from portal.app.sync.models import Identity, Mutation
from portal.app.sync.runtime import current_coordinator


RESOURCE_ID = "RPT5W1C0"
ENTITY_TYPE = f"{RESOURCE_ID}.report"

router = APIRouter(tags=["cctv-review-report"])


class ReportStatusActionRequest(BaseModel):
    action: Literal["submit_to_review", "return_to_edit", "complete"]
    memo: str | None = None


class ReportObservationSaveRequest(BaseModel):
    mlo_id: str | None = None
    source_observation_key: str
    defect_role: Literal["none", "major", "other"] = "none"
    is_extensive: bool = False
    selected_picture_file_name: str | None = None


class ReportDistanceGroupSaveRequest(BaseModel):
    distance_key: str
    distance_feet: float | None = None
    am_score: int | None = None
    defect_comment: str | None = None
    no_am_score_ge_3_confirmed: bool = False
    observations: list[ReportObservationSaveRequest] = Field(default_factory=list)


class ReportPipeSaveRequest(BaseModel):
    ml_id: str
    mli_id: str
    clogging_percent: int = 0
    clogging_comment: str | None = None
    clogging_frame_seconds: float | None = None
    distance_groups: list[ReportDistanceGroupSaveRequest] = Field(default_factory=list)


class ReportSaveRequest(BaseModel):
    report_key: str
    report_name: str
    binding_type: Literal["address", "project_title"]
    binding_text: str
    inspection_date_text: str
    memo: str | None = None
    pipes: list[ReportPipeSaveRequest]


def _normalize_report_key(value: str) -> str:
    compact = re.sub(r"\s*@\s*", "@", value.strip())
    compact = re.sub(r"\s*-\s*", "-", compact)
    return re.sub(r"\s+", "", compact)


def _report_id(report_key: str) -> int:
    # A stable JavaScript-safe identifier lets the existing client keep numeric report URLs.
    return int.from_bytes(hashlib.sha256(report_key.encode("utf-8")).digest()[:6], "big")


def _display_name(user: User) -> str:
    return f"{user.first_name} {user.last_name}".strip() or user.email


def _sync_error(error: SyncError) -> None:
    if isinstance(error, RevisionChanged):
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


def _coordinator(user: User):
    try:
        return current_coordinator(
            Identity(user_id=str(user.id), employee_number=str(user.employee_id), email=str(user.email))
        )
    except SyncError as error:
        _sync_error(error)


def _entity_values(entity: dict[str, object] | None) -> dict[str, Any] | None:
    if not entity or bool(entity.get("deleted")):
        return None
    values = entity.get("values")
    return dict(values) if isinstance(values, dict) else None


def _entities(user: User) -> list[dict[str, object]]:
    coordinator = _coordinator(user)
    return coordinator.list_entities(ENTITY_TYPE)


def _find_by_report_id(user: User, report_id: int) -> tuple[dict[str, object], dict[str, Any]] | None:
    for entity in _entities(user):
        values = _entity_values(entity)
        report = values.get("report") if values else None
        if isinstance(report, dict) and int(report.get("id", -1)) == report_id:
            return entity, values
    return None


def _manager_can_delete_report(db: Session, user: User, created_by_user_id: int | None) -> bool:
    if created_by_user_id is None:
        return False
    manager_id = db.execute(
        text(
            """
            SELECT team.manager_user_id
            FROM SYS_USERS creator
            INNER JOIN SYS_TEAMS team ON team.id = creator.team_id
            WHERE creator.id = :created_by_user_id
            """
        ),
        {"created_by_user_id": created_by_user_id},
    ).scalar()
    return manager_id is not None and int(manager_id) == user.id


def _is_manager_or_admin(db: Session, user: User) -> bool:
    if selected_user_role(user) in ADMIN_ROLES:
        return True
    return db.execute(
        text("SELECT 1 FROM SYS_TEAMS WHERE manager_user_id = :user_id LIMIT 1"),
        {"user_id": user.id},
    ).scalar() is not None


def _can_delete_report(db: Session, user: User, report: dict[str, Any]) -> bool:
    if selected_user_role(user) in ADMIN_ROLES:
        return True
    if report.get("status") != "pending":
        return False
    if report.get("created_by_user_id") == user.id:
        return True
    return _manager_can_delete_report(db, user, report.get("created_by_user_id"))


def _report_row(values: dict[str, Any], can_delete: bool | None = None) -> dict[str, Any]:
    report = dict(values["report"])
    if can_delete is not None:
        report["can_delete"] = can_delete
    return report


def _saved_pipes(pipes: list[ReportPipeSaveRequest], report_id: int) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for pipe_index, pipe in enumerate(pipes, start=1):
        pipe_id = pipe_index
        groups: list[dict[str, Any]] = []
        for group_index, group in enumerate(pipe.distance_groups, start=1):
            group_id = pipe_id * 10_000 + group_index
            observations = [
                {
                    "id": group_id * 10_000 + observation_index,
                    "distance_group_id": group_id,
                    "mlo_id": observation.mlo_id,
                    "source_observation_key": observation.source_observation_key,
                    "defect_role": observation.defect_role,
                    "is_extensive": observation.is_extensive,
                    "selected_picture_file_name": observation.selected_picture_file_name,
                }
                for observation_index, observation in enumerate(group.observations, start=1)
            ]
            groups.append(
                {
                    "id": group_id,
                    "pipe_review_id": pipe_id,
                    "distance_key": group.distance_key,
                    "distance_feet": group.distance_feet,
                    "am_score": group.am_score,
                    "defect_comment": group.defect_comment,
                    "no_am_score_ge_3_confirmed": group.no_am_score_ge_3_confirmed,
                    "observations": observations,
                }
            )
        result.append(
            {
                "id": pipe_id,
                "report_id": report_id,
                "ml_id": pipe.ml_id,
                "mli_id": pipe.mli_id,
                "clogging_percent": pipe.clogging_percent,
                "clogging_comment": pipe.clogging_comment,
                "clogging_frame_seconds": pipe.clogging_frame_seconds,
                "distance_groups": groups,
            }
        )
    return result


def _event(
    events: list[dict[str, Any]],
    report_id: int,
    user: User,
    event_type: str,
    from_status: str | None,
    to_status: str | None,
    memo: str | None,
) -> dict[str, Any]:
    return {
        "id": len(events) + 1,
        "report_id": report_id,
        "event_type": event_type,
        "event_by_user_id": user.id,
        "event_by_name": _display_name(user),
        "event_at": utc_now_text(),
        "from_status": from_status,
        "to_status": to_status,
        "memo": memo,
    }


def _commit(user: User, mutation: Mutation) -> None:
    try:
        _coordinator(user).commit([mutation])
    except SyncError as error:
        _sync_error(error)


@router.get("/api/reports/proactive-team-cctv-review/reports")
def list_reports(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    reports: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for entity in _entities(current_user):
        values = _entity_values(entity)
        if values and isinstance(values.get("report"), dict):
            reports.append((dict(values["report"]), values))
    reports.sort(key=lambda item: (str(item[0].get("updated_at") or ""), int(item[0].get("id") or 0)), reverse=True)
    page = reports[offset : offset + limit]
    return {
        "reports": [_report_row(values, _can_delete_report(db, current_user, report)) for report, values in page],
        "total": len(reports),
    }


@router.get("/api/reports/proactive-team-cctv-review/reports/{report_id}")
def get_report_detail(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    found = _find_by_report_id(current_user, report_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    _entity, values = found
    return {
        "report": _report_row(values, _can_delete_report(db, current_user, dict(values["report"]))),
        "pipes": values.get("pipes", []),
    }


@router.post("/api/reports/proactive-team-cctv-review/reports/save")
def save_report(
    payload: ReportSaveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    report_key = _normalize_report_key(payload.report_key)
    report_name = _normalize_report_key(payload.report_name) or report_key
    binding_text = payload.binding_text.strip()
    inspection_date_text = payload.inspection_date_text.strip()
    if not report_key or not report_name or not binding_text or not inspection_date_text:
        raise HTTPException(status_code=400, detail="Report key, name, binding text, and inspection date are required.")
    if not payload.pipes:
        raise HTTPException(status_code=400, detail="At least one reviewed pipe is required.")

    coordinator = _coordinator(current_user)
    existing = coordinator.get_entity(ENTITY_TYPE, report_key)
    existing_values = _entity_values(existing)
    created = existing_values is None
    now = utc_now_text()
    report_id = _report_id(report_key)
    if created:
        report = {
            "id": report_id,
            "report_key": report_key,
            "report_name": report_name,
            "binding_type": payload.binding_type,
            "binding_text": binding_text,
            "inspection_date_text": inspection_date_text,
            "status": "pending",
            "created_by_user_id": current_user.id,
            "created_by_name": _display_name(current_user),
            "created_at": now,
            "updated_by_user_id": current_user.id,
            "updated_by_name": _display_name(current_user),
            "updated_at": now,
            "submitted_by_user_id": None,
            "submitted_by_name": None,
            "submitted_at": None,
            "reviewed_by_user_id": None,
            "reviewed_by_name": None,
            "reviewed_at": None,
        }
        events: list[dict[str, Any]] = []
        base_revision = None
        operation_type = "insert_entity"
        from_status = None
    else:
        report = copy.deepcopy(dict(existing_values["report"]))
        from_status = str(report.get("status") or "pending")
        if from_status == "ready_to_review":
            raise HTTPException(status_code=400, detail="Return the report to edit before saving changes.")
        if from_status == "completed":
            raise HTTPException(status_code=400, detail="Completed reports cannot be edited.")
        report.update(
            {
                "report_name": report_name,
                "binding_type": payload.binding_type,
                "binding_text": binding_text,
                "inspection_date_text": inspection_date_text,
                "status": "pending",
                "updated_by_user_id": current_user.id,
                "updated_by_name": _display_name(current_user),
                "updated_at": now,
            }
        )
        events = copy.deepcopy(list(existing_values.get("events") or []))
        base_revision = str(existing["record_revision"])
        operation_type = "update_entity"

    events.append(_event(events, report_id, current_user, "report_saved", from_status, "pending", payload.memo))
    values = {"report": report, "pipes": _saved_pipes(payload.pipes, report_id), "events": events}
    _commit(
        current_user,
        Mutation(
            entity_type=ENTITY_TYPE,
            entity_id=report_key,
            operation_type=operation_type,
            base_record_revision=base_revision,
            values=values,
        ),
    )
    return {"ok": True, "created": created, "report": _report_row(values, _can_delete_report(db, current_user, report))}


@router.delete("/api/reports/proactive-team-cctv-review/reports/{report_id}")
def delete_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    found = _find_by_report_id(current_user, report_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    entity, values = found
    report = dict(values["report"])
    if not _can_delete_report(db, current_user, report):
        raise HTTPException(status_code=403, detail="Only the owner, the owner's manager, or an administrator can delete this report.")
    _commit(
        current_user,
        Mutation(
            entity_type=ENTITY_TYPE,
            entity_id=str(entity["entity_id"]),
            operation_type="delete_entity",
            base_record_revision=str(entity["record_revision"]),
        ),
    )
    pipes = list(values.get("pipes") or [])
    return {
        "ok": True,
        "report_id": report_id,
        "deleted": {
            "reports": 1,
            "pipes": len(pipes),
            "distance_groups": sum(len(pipe.get("distance_groups") or []) for pipe in pipes if isinstance(pipe, dict)),
            "observations": sum(
                len(group.get("observations") or [])
                for pipe in pipes if isinstance(pipe, dict)
                for group in pipe.get("distance_groups") or []
                if isinstance(group, dict)
            ),
            "events": len(values.get("events") or []),
        },
    }


@router.get("/api/reports/proactive-team-cctv-review/reports/{report_id}/events")
def list_report_events(
    report_id: int,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    found = _find_by_report_id(current_user, report_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    events = list(found[1].get("events") or [])
    events.sort(key=lambda event: (str(event.get("event_at") or ""), int(event.get("id") or 0)), reverse=True)
    return {"events": events, "total": len(events)}


@router.patch("/api/reports/proactive-team-cctv-review/reports/{report_id}/status")
def update_report_status(
    report_id: int,
    payload: ReportStatusActionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    found = _find_by_report_id(current_user, report_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    entity, current = found
    values = copy.deepcopy(current)
    report = dict(values["report"])
    from_status = str(report.get("status") or "pending")
    now = utc_now_text()
    if payload.action == "submit_to_review":
        if from_status != "pending":
            raise HTTPException(status_code=400, detail="Only pending reports can be submitted to review.")
        to_status, event_type = "ready_to_review", "submitted_to_review"
        report.update({"submitted_by_user_id": current_user.id, "submitted_by_name": _display_name(current_user), "submitted_at": now})
    elif payload.action == "return_to_edit":
        if from_status != "ready_to_review":
            raise HTTPException(status_code=400, detail="Only ready-to-review reports can be returned to edit.")
        to_status, event_type = "pending", "returned_to_edit"
        report.update({"submitted_by_user_id": None, "submitted_by_name": None, "submitted_at": None, "reviewed_by_user_id": None, "reviewed_by_name": None, "reviewed_at": None})
    else:
        if from_status != "ready_to_review":
            raise HTTPException(status_code=400, detail="Only ready-to-review reports can be completed.")
        if not _is_manager_or_admin(db, current_user):
            raise HTTPException(status_code=403, detail="Only a manager or administrator can complete a report.")
        to_status, event_type = "completed", "completed"
        report.update({"reviewed_by_user_id": current_user.id, "reviewed_by_name": _display_name(current_user), "reviewed_at": now})
    report.update({"status": to_status, "updated_by_user_id": current_user.id, "updated_by_name": _display_name(current_user), "updated_at": now})
    events = list(values.get("events") or [])
    events.append(_event(events, report_id, current_user, event_type, from_status, to_status, payload.memo))
    values.update({"report": report, "events": events})
    _commit(
        current_user,
        Mutation(
            entity_type=ENTITY_TYPE,
            entity_id=str(entity["entity_id"]),
            operation_type="update_entity",
            base_record_revision=str(entity["record_revision"]),
            values=values,
        ),
    )
    return {"ok": True, "report_id": report_id, "from_status": from_status, "to_status": to_status}
