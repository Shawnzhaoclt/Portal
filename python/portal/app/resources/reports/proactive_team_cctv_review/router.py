from __future__ import annotations

import copy
import hashlib
import re
from typing import Any, Literal
from uuid import uuid4

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
from portal.app.sync.physical_entities import (
    CCTV_DISTANCE_GROUP_ENTITY_TYPE,
    CCTV_OBSERVATION_ENTITY_TYPE,
    CCTV_PIPE_ENTITY_TYPE,
    CCTV_REPORT_ENTITY_TYPE,
    REVIEW_EVENT_ENTITY_TYPE,
    stable_global_id,
)
from portal.app.sync.runtime import current_coordinator


RESOURCE_ID = "RPT5W1C0"
ENTITY_TYPE = CCTV_REPORT_ENTITY_TYPE

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


def _review_event_response(
    entity: dict[str, object],
    values: dict[str, Any],
) -> dict[str, Any]:
    """Keep the existing CCTV event response shape over universal event storage."""
    event_global_id = str(entity["entity_id"])
    report_key = str(values.get("resource_key") or values.get("subject_display_key") or "")
    event_id = int.from_bytes(
        hashlib.sha256(event_global_id.encode("utf-8")).digest()[:6],
        "big",
    )
    return {
        "id": event_id,
        "report_id": _report_id(report_key),
        "event_type": values.get("event_type"),
        "event_by_user_id": values.get("actor_user_id"),
        "event_by_name": values.get("actor_name"),
        "event_at": values.get("event_at"),
        "from_status": values.get("from_status"),
        "to_status": values.get("to_status"),
        "memo": values.get("memo"),
    }


def _report_entities(
    user: User,
    *,
    limit: int | None = None,
    offset: int = 0,
) -> list[dict[str, object]]:
    return _coordinator(user).query_entities(
        ENTITY_TYPE,
        order_by=(("updated_at", True), ("id", True)),
        limit=limit,
        offset=offset,
    )


def _report_values(coordinator: Any, report_entity: dict[str, object]) -> dict[str, Any]:
    report = _entity_values(report_entity)
    if report is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    report_global_id = str(report_entity["entity_id"])
    pipe_entities = coordinator.query_entities(
        CCTV_PIPE_ENTITY_TYPE,
        filters={"report_global_id": report_global_id},
        order_by=(("id", False),),
    )
    group_entities = coordinator.query_entities(
        CCTV_DISTANCE_GROUP_ENTITY_TYPE,
        filters={"report_global_id": report_global_id},
        order_by=(("pipe_review_id", False), ("id", False)),
    )
    observation_entities = coordinator.query_entities(
        CCTV_OBSERVATION_ENTITY_TYPE,
        filters={"report_global_id": report_global_id},
        order_by=(("pipe_review_id", False), ("distance_group_id", False), ("id", False)),
    )
    event_entities = coordinator.query_entities(
        REVIEW_EVENT_ENTITY_TYPE,
        filters={
            "resource_key": str(report.get("report_key") or report_global_id),
            "subject_type": "report",
            "subject_global_id": report_global_id,
        },
        order_by=(("event_at", False), ("global_id", False)),
    )

    observations_by_group: dict[str, list[dict[str, Any]]] = {}
    for entity in observation_entities:
        values = _entity_values(entity)
        if values is not None:
            observations_by_group.setdefault(
                str(values.get("distance_group_global_id") or ""), []
            ).append(values)

    groups_by_pipe: dict[str, list[dict[str, Any]]] = {}
    for entity in group_entities:
        values = _entity_values(entity)
        if values is not None:
            values["observations"] = observations_by_group.get(str(entity["entity_id"]), [])
            groups_by_pipe.setdefault(str(values.get("pipe_global_id") or ""), []).append(values)

    pipes: list[dict[str, Any]] = []
    for entity in pipe_entities:
        values = _entity_values(entity)
        if values is not None:
            values["distance_groups"] = groups_by_pipe.get(str(entity["entity_id"]), [])
            pipes.append(values)

    events = [
        _review_event_response(entity, values)
        for entity in event_entities
        if (values := _entity_values(entity)) is not None
    ]
    return {"report": report, "pipes": pipes, "events": events}


def _find_by_report_id(user: User, report_id: int) -> tuple[dict[str, object], dict[str, Any]] | None:
    coordinator = _coordinator(user)
    matches = coordinator.query_entities(ENTITY_TYPE, filters={"id": report_id}, limit=1)
    if not matches:
        return None
    entity = matches[0]
    return entity, _report_values(coordinator, entity)


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
    _events: list[dict[str, Any]],
    _report_id: int,
    user: User,
    event_type: str,
    from_status: str | None,
    to_status: str | None,
    memo: str | None,
) -> dict[str, Any]:
    return {
        "event_type": event_type,
        "event_by_user_id": user.id,
        "event_by_name": _display_name(user),
        "event_at": utc_now_text(),
        "from_status": from_status,
        "to_status": to_status,
        "memo": memo,
        "correlation_id": uuid4().hex,
    }


def _commit(user: User, mutations: list[Mutation]) -> None:
    try:
        _coordinator(user).commit(mutations)
    except SyncError as error:
        _sync_error(error)


def _upsert_mutation(
    coordinator: Any,
    entity_type: str,
    entity_id: str,
    values: dict[str, Any],
    *,
    unique_lock_keys: tuple[str, ...] = (),
) -> Mutation:
    current = coordinator.get_entity(entity_type, entity_id)
    if current is None:
        operation_type = "insert_entity"
        revision = None
    elif bool(current.get("deleted")):
        operation_type = "restore_entity"
        revision = str(current["record_revision"])
    else:
        operation_type = "update_entity"
        revision = str(current["record_revision"])
    return Mutation(
        entity_type=entity_type,
        entity_id=entity_id,
        operation_type=operation_type,
        base_record_revision=revision,
        values=values,
        unique_lock_keys=unique_lock_keys,
    )


def _delete_mutations(
    coordinator: Any,
    entity_type: str,
    entities: list[dict[str, object]],
) -> list[Mutation]:
    return [
        Mutation(
            entity_type=entity_type,
            entity_id=str(entity["entity_id"]),
            operation_type="delete_entity",
            base_record_revision=str(entity["record_revision"]),
        )
        for entity in entities
        if not bool(entity.get("deleted"))
    ]


def _entities_for_report(
    coordinator: Any,
    entity_type: str,
    report_global_id: str,
    *,
    report_key: str | None = None,
    include_deleted: bool = False,
) -> list[dict[str, object]]:
    filters = (
        {
            "resource_key": report_key or report_global_id,
            "subject_type": "report",
            "subject_global_id": report_global_id,
        }
        if entity_type == REVIEW_EVENT_ENTITY_TYPE
        else {"report_global_id": report_global_id}
    )
    return coordinator.query_entities(
        entity_type,
        filters=filters,
        include_deleted=include_deleted,
    )


def _event_mutation(
    coordinator: Any,
    report_global_id: str,
    report_key: str,
    event: dict[str, Any],
) -> Mutation:
    event_at = str(event.get("event_at") or utc_now_text())
    event_type = str(event.get("event_type") or "saved")
    correlation_id = str(event.get("correlation_id") or uuid4().hex)
    values = {
        "resource_id": None,
        "resource_key": report_key,
        "resource_type": "report",
        "subject_type": "report",
        "subject_global_id": report_global_id,
        "subject_display_key": report_key,
        "event_type": event_type,
        "actor_user_id": event.get("event_by_user_id"),
        "actor_name": event.get("event_by_name"),
        "event_at": event_at,
        "from_status": event.get("from_status"),
        "to_status": event.get("to_status"),
        "memo": event.get("memo"),
        "correlation_id": correlation_id,
    }
    entity_id = stable_global_id(
        "review_event",
        RESOURCE_ID,
        report_key,
        report_global_id,
        event_type,
        event_at,
        correlation_id,
    )
    return _upsert_mutation(coordinator, REVIEW_EVENT_ENTITY_TYPE, entity_id, values)


def _review_mutations(
    coordinator: Any,
    report_global_id: str,
    report_id: int,
    pipes: list[dict[str, Any]],
) -> list[Mutation]:
    mutations: list[Mutation] = []
    desired_ids: dict[str, set[str]] = {
        CCTV_PIPE_ENTITY_TYPE: set(),
        CCTV_DISTANCE_GROUP_ENTITY_TYPE: set(),
        CCTV_OBSERVATION_ENTITY_TYPE: set(),
    }
    for pipe in pipes:
        pipe_global_id = stable_global_id(
            "pipe", report_global_id, pipe.get("ml_id"), pipe.get("mli_id")
        )
        desired_ids[CCTV_PIPE_ENTITY_TYPE].add(pipe_global_id)
        pipe_values = {
            **pipe,
            "report_global_id": report_global_id,
            "report_id": report_id,
        }
        pipe_values.pop("distance_groups", None)
        mutations.append(
            _upsert_mutation(
                coordinator,
                CCTV_PIPE_ENTITY_TYPE,
                pipe_global_id,
                pipe_values,
            )
        )
        for group in pipe.get("distance_groups") or []:
            group_global_id = stable_global_id(
                "group", pipe_global_id, group.get("distance_key")
            )
            desired_ids[CCTV_DISTANCE_GROUP_ENTITY_TYPE].add(group_global_id)
            group_values = {
                **group,
                "report_global_id": report_global_id,
                "report_id": report_id,
                "pipe_global_id": pipe_global_id,
                "pipe_review_id": pipe.get("id"),
                "ml_id": pipe.get("ml_id"),
                "mli_id": pipe.get("mli_id"),
            }
            group_values.pop("observations", None)
            mutations.append(
                _upsert_mutation(
                    coordinator,
                    CCTV_DISTANCE_GROUP_ENTITY_TYPE,
                    group_global_id,
                    group_values,
                )
            )
            for observation in group.get("observations") or []:
                observation_global_id = stable_global_id(
                    "observation",
                    group_global_id,
                    observation.get("source_observation_key"),
                )
                desired_ids[CCTV_OBSERVATION_ENTITY_TYPE].add(observation_global_id)
                observation_values = {
                    **observation,
                    "report_global_id": report_global_id,
                    "report_id": report_id,
                    "pipe_global_id": pipe_global_id,
                    "pipe_review_id": pipe.get("id"),
                    "distance_group_global_id": group_global_id,
                    "distance_group_id": group.get("id"),
                    "ml_id": pipe.get("ml_id"),
                    "mli_id": pipe.get("mli_id"),
                    "distance_key": group.get("distance_key"),
                    "distance_feet": group.get("distance_feet"),
                }
                mutations.append(
                    _upsert_mutation(
                        coordinator,
                        CCTV_OBSERVATION_ENTITY_TYPE,
                        observation_global_id,
                        observation_values,
                    )
                )

    for entity_type, retained_ids in desired_ids.items():
        existing = _entities_for_report(
            coordinator,
            entity_type,
            report_global_id,
            include_deleted=True,
        )
        mutations.extend(
            _delete_mutations(
                coordinator,
                entity_type,
                [
                    entity
                    for entity in existing
                    if str(entity["entity_id"]) not in retained_ids
                ],
            )
        )
    return mutations


@router.get("/api/reports/proactive-team-cctv-review/reports")
def list_reports(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    coordinator = _coordinator(current_user)
    page = coordinator.query_entities(
        ENTITY_TYPE,
        order_by=(("updated_at", True), ("id", True)),
        limit=limit,
        offset=offset,
    )
    reports = [values for entity in page if (values := _entity_values(entity)) is not None]
    return {
        "reports": [
            _report_row(
                {"report": report},
                _can_delete_report(db, current_user, report),
            )
            for report in reports
        ],
        "total": coordinator.count_entities(ENTITY_TYPE),
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
    existing_report = _entity_values(existing)
    created = existing_report is None
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
        from_status = None
    else:
        report = copy.deepcopy(existing_report)
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
    event = _event(
        [],
        report_id,
        current_user,
        "saved",
        from_status,
        "pending",
        payload.memo,
    )
    pipes = _saved_pipes(payload.pipes, report_id)
    mutations = [
        _upsert_mutation(
            coordinator,
            ENTITY_TYPE,
            report_key,
            report,
            unique_lock_keys=(f"cctv-report:{report_key}",),
        ),
        *_review_mutations(coordinator, report_key, report_id, pipes),
        _event_mutation(coordinator, report_key, report_key, event),
    ]
    _commit(current_user, mutations)
    return {
        "ok": True,
        "created": created,
        "report": _report_row(
            {"report": report},
            _can_delete_report(db, current_user, report),
        ),
    }


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
    report_global_id = str(entity["entity_id"])
    coordinator = _coordinator(current_user)
    child_entities = {
        entity_type: _entities_for_report(
            coordinator,
            entity_type,
            report_global_id,
            report_key=str(report.get("report_key") or ""),
        )
        for entity_type in (
            CCTV_OBSERVATION_ENTITY_TYPE,
            CCTV_DISTANCE_GROUP_ENTITY_TYPE,
            CCTV_PIPE_ENTITY_TYPE,
            REVIEW_EVENT_ENTITY_TYPE,
        )
    }
    mutations = [
        mutation
        for entity_type, entities in child_entities.items()
        for mutation in _delete_mutations(coordinator, entity_type, entities)
    ]
    mutations.append(
        Mutation(
            entity_type=ENTITY_TYPE,
            entity_id=report_global_id,
            operation_type="delete_entity",
            base_record_revision=str(entity["record_revision"]),
        )
    )
    _commit(current_user, mutations)
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
    events.sort(
        key=lambda event: (str(event.get("event_at") or ""), str(event.get("id") or "")),
        reverse=True,
    )
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
    event = _event(
        events,
        report_id,
        current_user,
        event_type,
        from_status,
        to_status,
        payload.memo,
    )
    report_global_id = str(entity["entity_id"])
    coordinator = _coordinator(current_user)
    _commit(
        current_user,
        [
            Mutation(
                entity_type=ENTITY_TYPE,
                entity_id=report_global_id,
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values=report,
            ),
            _event_mutation(
                coordinator,
                report_global_id,
                str(report.get("report_key") or report_global_id),
                event,
            ),
        ],
    )
    return {"ok": True, "report_id": report_id, "from_status": from_status, "to_status": to_status}
