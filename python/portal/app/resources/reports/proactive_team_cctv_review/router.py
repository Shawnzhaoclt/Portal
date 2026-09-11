from __future__ import annotations

import copy
import hashlib
import re
from datetime import datetime
from typing import Any, Literal
from uuid import uuid4

from portal.runtime.transport import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.management.database import get_db
from portal.app.management.models import Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.security import utc_now_text
from portal.app.management.services import (
    PERMISSION_TYPES,
    effective_resource_permission_types,
)
from portal.app.sync.errors import LockTimeout, RevisionChanged, SharedRootUnavailable, SnapshotRequired, SyncError
from portal.app.sync.models import Mutation
from portal.app.dashboards.amteam import user_observations
from portal.app.sync.physical_entities import (
    CCTV_DISTANCE_GROUP_ENTITY_TYPE,
    CCTV_OBSERVATION_ENTITY_TYPE,
    CCTV_PIPE_ENTITY_TYPE,
    CCTV_REPORT_ENTITY_TYPE,
    MLO_ENTITY_TYPE,
    REVIEW_EVENT_ENTITY_TYPE,
    stable_global_id,
)
from portal.app.sync.runtime import current_coordinator, sync_identity


RESOURCE_ID = "RPT5W1C0"
ENTITY_TYPE = CCTV_REPORT_ENTITY_TYPE

router = APIRouter(tags=["cctv-review-report"])


class ReportStatusActionRequest(BaseModel):
    action: Literal["submit_to_review", "return_to_edit", "complete", "reopen"]
    record_revision: str = Field(min_length=1)
    memo: str | None = None


class ReportObservationSaveRequest(BaseModel):
    mlo_id: str | None = None
    source_observation_key: str
    defect_role: Literal["none", "major", "other"] = "none"
    # Whether the defect is published in the generated report. Older clients omit it, so
    # it falls back to the decision their defect role already carried.
    in_report: bool | None = None
    is_extensive: bool = False
    selected_picture_file_name: str | None = None
    selected_picture_media_id: str | None = None
    defect_callout: str | None = None


class ReportDistanceGroupSaveRequest(BaseModel):
    distance_key: str
    distance_feet: float | None = None
    am_score: int | None = Field(default=None, ge=3, le=5)
    no_am_score_ge_3_confirmed: bool = False
    observations: list[ReportObservationSaveRequest] = Field(default_factory=list)


class ReportPipeSaveRequest(BaseModel):
    ml_id: str
    mli_id: str
    clogging_percent: int = Field(default=0, ge=0, le=100, multiple_of=5)
    clogging_comment: str | None = None
    clogging_frame_seconds: float | None = Field(default=None, ge=0)
    distance_groups: list[ReportDistanceGroupSaveRequest] = Field(default_factory=list)


class ReportSaveRequest(BaseModel):
    report_key: str
    report_name: str
    binding_type: Literal["address", "project_title"]
    binding_text: str
    inspection_date_text: str
    record_revision: str | None = None
    memo: str | None = None
    pipes: list[ReportPipeSaveRequest]


def _normalize_report_key(value: str) -> str:
    compact = re.sub(r"\s*@\s*", "@", value.strip())
    compact = re.sub(r"\s*-\s*", "-", compact)
    return re.sub(r"\s+", "", compact)


def _normalize_binding_text(value: str) -> str:
    return re.sub(r"^_+|_+$", "", re.sub(r"[^A-Za-z0-9]+", "_", value.strip()))


def _report_identity(binding_text: str, inspection_date_text: str) -> tuple[str, str, str]:
    normalized_binding = _normalize_binding_text(binding_text)
    tokens = re.findall(r"\d{8}", inspection_date_text)
    if not normalized_binding or len(tokens) not in {1, 2}:
        raise HTTPException(
            status_code=400,
            detail="A report requires a binding value and an inspection date in MMDDYYYY format.",
        )
    compact_input = re.sub(r"\s+", " ", inspection_date_text.strip())
    expected_input = tokens[0] if len(tokens) == 1 else f"{tokens[0]} - {tokens[1]}"
    if compact_input != expected_input:
        raise HTTPException(
            status_code=400,
            detail="Inspection date must use MMDDYYYY or MMDDYYYY - MMDDYYYY format.",
        )
    try:
        dates = [datetime.strptime(token, "%m%d%Y").date() for token in tokens]
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Inspection date contains an invalid calendar date.") from error
    if len(dates) == 2 and dates[1] < dates[0]:
        raise HTTPException(status_code=400, detail="Inspection date range must be in chronological order.")
    display_date = tokens[0] if len(tokens) == 1 else f"{tokens[0]} - {tokens[1]}"
    machine_date = tokens[0] if len(tokens) == 1 else f"{tokens[0]}-{tokens[1]}"
    return (
        f"{normalized_binding}@{machine_date}",
        f"{normalized_binding} @{display_date}",
        display_date,
    )


def _resource(db: Session) -> Resource:
    resource = db.scalar(select(Resource).where(Resource.resource_id == RESOURCE_ID))
    if resource is None or resource.is_active != 1:
        raise HTTPException(status_code=503, detail="Proactive Team CCTV Review is not registered in the Portal catalog.")
    return resource


def _resource_permission_types(db: Session, user: User) -> set[str]:
    permissions = effective_resource_permission_types(db, user, _resource(db))
    if not permissions:
        raise HTTPException(status_code=403, detail="You do not have permission to use Proactive Team CCTV Review.")
    return permissions


def _require_resource_permission(db: Session, user: User, *required: str) -> set[str]:
    permissions = _resource_permission_types(db, user)
    _require_permission_types(permissions, *required)
    return permissions


def _require_permission_types(permissions: set[str], *required: str) -> None:
    if not permissions.intersection(required):
        label = " or ".join(required)
        raise HTTPException(
            status_code=403,
            detail=f"Proactive Team CCTV Review requires {label} permission for this action.",
        )


def _pipe_value(value: ReportPipeSaveRequest | dict[str, Any], field: str) -> Any:
    return value.get(field) if isinstance(value, dict) else getattr(value, field)


def _validate_pipe_reviews(pipes: list[ReportPipeSaveRequest] | list[dict[str, Any]]) -> None:
    if not pipes:
        raise HTTPException(status_code=422, detail="At least one reviewed pipe is required.")
    failures: list[str] = []
    for pipe_number, pipe in enumerate(pipes, start=1):
        ml_id = str(_pipe_value(pipe, "ml_id") or "").strip()
        mli_id = str(_pipe_value(pipe, "mli_id") or "").strip()
        pipe_label = f"Pipe {ml_id}" if ml_id else f"Pipe {pipe_number}"
        if not ml_id or not mli_id:
            failures.append(f"{pipe_label}: pipe ID and inspection ID are required")
        clogging_percent = _pipe_value(pipe, "clogging_percent")
        if not isinstance(clogging_percent, int) or clogging_percent < 0 or clogging_percent > 100 or clogging_percent % 5:
            failures.append(f"{pipe_label}: clogging must be 0 through 100 in increments of 5")
        if clogging_percent and _pipe_value(pipe, "clogging_frame_seconds") is None:
            failures.append(f"{pipe_label}: capture a clogging video frame when clogging is greater than 0")

        groups = _pipe_value(pipe, "distance_groups") or []
        for group_number, group in enumerate(groups, start=1):
            group_value = group if isinstance(group, dict) else group.model_dump()
            distance = group_value.get("distance_feet")
            group_label = (
                f"{distance:.1f} ft" if isinstance(distance, (int, float))
                else str(group_value.get("distance_key") or f"location {group_number}").replace("distance:", "Distance ", 1)
            )
            observations = group_value.get("observations") or []
            observation_values = [
                observation if isinstance(observation, dict) else observation.model_dump()
                for observation in observations
            ]
            source_keys = [str(observation.get("source_observation_key") or "").strip() for observation in observation_values]
            if any(not source_key for source_key in source_keys) or len(source_keys) != len(set(source_keys)):
                failures.append(f"{pipe_label}, {group_label}: observation keys must be present and unique")
            major_count = sum(observation.get("defect_role") == "major" for observation in observation_values)
            other_count = sum(observation.get("defect_role") == "other" for observation in observation_values)
            included_observations = [
                observation
                for observation in observation_values
                if bool(
                    observation.get("in_report")
                    if observation.get("in_report") is not None
                    else observation.get("defect_role") in {"major", "other"}
                )
            ]
            included_keys = {
                str(observation.get("source_observation_key") or "").strip()
                for observation in included_observations
            }
            score = group_value.get("am_score")
            confirmed_no_high_score = bool(group_value.get("no_am_score_ge_3_confirmed"))
            if score is not None:
                if not isinstance(score, int) or score < 3 or score > 5:
                    failures.append(f"{pipe_label}, {group_label}: AM score must be 3 through 5")
                if major_count != 1:
                    failures.append(f"{pipe_label}, {group_label}: select exactly one major defect for an AM score of 3 or higher")
                if confirmed_no_high_score:
                    failures.append(f"{pipe_label}, {group_label}: a scored defect cannot also be confirmed as having no score of 3 or higher")
                for observation in included_observations:
                    observation_id = str(observation.get("mlo_id") or "").strip()
                    if not observation_id:
                        observation_id = str(observation.get("source_observation_key") or "").split("|", 1)[0]
                    observation_label = f"{pipe_label}, {group_label}, observation {observation_id}"
                    if observation.get("defect_role") not in {"major", "other"}:
                        failures.append(f"{observation_label}: choose Major Defect or Other Defect, or uncheck In Report.")
                    if not str(observation.get("defect_callout") or "").strip():
                        instruction = (
                            "Enter a defect callout for the Major defect."
                            if observation.get("defect_role") == "major"
                            else "Enter a defect callout, or uncheck In Report."
                        )
                        failures.append(f"{observation_label}: {instruction}")
                major_keys = {
                    str(observation.get("source_observation_key") or "").strip()
                    for observation in observation_values
                    if observation.get("defect_role") == "major"
                }
                if not major_keys.issubset(included_keys):
                    failures.append(f"{pipe_label}, {group_label}: the major defect must be included in the report")
            else:
                if major_count or other_count:
                    failures.append(f"{pipe_label}, {group_label}: defect roles require a major defect and AM score")
                if not confirmed_no_high_score:
                    failures.append(f"{pipe_label}, {group_label}: confirm that no defect has an AM score of 3 or higher")
    if failures:
        visible_failures = failures[:25]
        message = "Please correct the following before saving or submitting:\n" + "\n".join(
            f"- {failure}" for failure in visible_failures
        )
        if len(failures) > len(visible_failures):
            message += f"\nAnd {len(failures) - len(visible_failures)} more issues. Correct these first, then try again."
        raise HTTPException(
            status_code=422,
            detail={
                "message": message,
                "failures": visible_failures,
            },
        )


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
            sync_identity(user)
        )
    except SyncError as error:
        _sync_error(error)


def _entity_values(entity: dict[str, object] | None) -> dict[str, Any] | None:
    if not entity or bool(entity.get("deleted")):
        return None
    values = entity.get("values")
    return dict(values) if isinstance(values, dict) else None


def _validated_record_revision(
    entity: dict[str, object],
    requested_revision: str | None,
    *,
    action: str,
) -> str:
    requested = str(requested_revision or "")
    current = str(entity.get("record_revision") or "")
    if not requested or requested != current:
        raise HTTPException(
            status_code=409,
            detail=f"This report changed after it was opened. Reload it before {action}.",
        )
    return requested


def _review_event_response(
    entity: dict[str, object],
    values: dict[str, Any],
) -> dict[str, Any]:
    """Keep the existing CCTV event response shape over universal event storage."""
    event_global_id = str(entity["entity_id"])
    report_key = str(values.get("subject_display_key") or "")
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
    report = {
        **report,
        "record_revision": str(report_entity.get("record_revision") or ""),
    }
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
    event_entities = _event_entities_for_report(coordinator, report_global_id, str(report.get("report_key") or ""))

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


def _integer_id(value: Any) -> int | None:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None


def _report_team_id(db: Session, report: dict[str, Any]) -> int | None:
    """Team captured on the report, with a safe fallback for legacy reports."""
    for field in ("assigned_team_id", "created_by_team_id"):
        if team_id := _integer_id(report.get(field)):
            return team_id
    creator_id = _integer_id(report.get("created_by_user_id"))
    creator = db.get(User, creator_id) if creator_id is not None else None
    return _integer_id(creator.team_id) if creator is not None else None


def _report_capabilities(
    db: Session,
    user: User,
    report: dict[str, Any],
    permissions: set[str],
) -> dict[str, bool]:
    status = str(report.get("status") or "pending")
    can_view = "view" in permissions
    return {
        "can_view": can_view,
        "can_edit": status == "pending" and "edit" in permissions,
        "can_submit": status == "pending" and "edit" in permissions,
        "can_return_to_edit": status == "ready_to_review" and "review" in permissions,
        "can_complete": status == "ready_to_review" and "review" in permissions,
        "can_reopen": status == "completed" and "review" in permissions,
        "can_delete": status == "pending" and "delete" in permissions,
        "can_view_events": can_view,
        "can_download": can_view,
    }


def _resource_capabilities(permissions: set[str]) -> dict[str, Any]:
    return {
        "can_view": "view" in permissions,
        "can_create": "create" in permissions,
        "permission_types": [name for name in PERMISSION_TYPES if name in permissions],
    }


def _report_row(values: dict[str, Any], capabilities: dict[str, bool] | None = None) -> dict[str, Any]:
    report = dict(values["report"])
    if capabilities is not None:
        report.update(capabilities)
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
                    "in_report": (
                        observation.defect_role in {"major", "other"}
                        if observation.in_report is None
                        else observation.in_report
                    ),
                    "is_extensive": observation.is_extensive,
                    "selected_picture_file_name": observation.selected_picture_file_name,
                    "selected_picture_media_id": observation.selected_picture_media_id,
                    "defect_callout": observation.defect_callout,
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
            "resource_key": RESOURCE_ID,
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


def _event_entities_for_report(
    coordinator: Any,
    report_global_id: str,
    report_key: str,
    *,
    include_deleted: bool = False,
) -> list[dict[str, object]]:
    canonical_event_entities = _entities_for_report(
        coordinator,
        REVIEW_EVENT_ENTITY_TYPE,
        report_global_id,
        include_deleted=include_deleted,
    )
    # Releases before the universal review-event contract used the report key as
    # resource_key. Keep those immutable audit rows visible while all new events
    # use the stable resource ID required by the schema and its indexes.
    legacy_resource_key = report_key or report_global_id
    legacy_event_entities = (
        coordinator.query_entities(
            REVIEW_EVENT_ENTITY_TYPE,
            filters={
                "resource_key": legacy_resource_key,
                "subject_type": "report",
                "subject_global_id": report_global_id,
            },
            include_deleted=include_deleted,
        )
        if legacy_resource_key != RESOURCE_ID
        else []
    )
    event_entities = list(
        {
            str(entity["entity_id"]): entity
            for entity in [*canonical_event_entities, *legacy_event_entities]
        }.values()
    )
    event_entities.sort(
        key=lambda entity: (
            str((_entity_values(entity) or {}).get("event_at") or ""),
            str(entity["entity_id"]),
        )
    )
    return event_entities


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
        "resource_key": RESOURCE_ID,
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
    permissions = _require_resource_permission(db, current_user, "view")
    reports = []
    for entity in _report_entities(current_user):
        values = _entity_values(entity)
        if values is None:
            continue
        report = {
            **values,
            "record_revision": str(entity.get("record_revision") or ""),
        }
        reports.append(
            _report_row(
                {"report": report},
                _report_capabilities(db, current_user, report, permissions),
            )
        )
    page = reports[offset:offset + limit]
    return {
        "reports": page,
        "total": len(reports),
        "capabilities": _resource_capabilities(permissions),
    }


@router.get("/api/reports/proactive-team-cctv-review/reports/{report_id}")
def get_report_detail(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    permissions = _require_resource_permission(db, current_user, "view")
    found = _find_by_report_id(current_user, report_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    _entity, values = found
    report = dict(values["report"])
    return {
        "report": _report_row(values, _report_capabilities(db, current_user, report, permissions)),
        "pipes": values.get("pipes", []),
    }


@router.post("/api/reports/proactive-team-cctv-review/reports/save")
def save_report(
    payload: ReportSaveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    permissions = _resource_permission_types(db, current_user)
    binding_text = payload.binding_text.strip()
    report_key, report_name, inspection_date_text = _report_identity(
        binding_text,
        payload.inspection_date_text,
    )
    requested_report_key = _normalize_report_key(payload.report_key)
    if requested_report_key and requested_report_key != report_key:
        raise HTTPException(
            status_code=400,
            detail="Report key does not match the selected binding and inspection date.",
        )
    _validate_pipe_reviews(payload.pipes)

    coordinator = _coordinator(current_user)
    existing = coordinator.get_entity(ENTITY_TYPE, report_key)
    existing_report = _entity_values(existing)
    created = existing_report is None
    now = utc_now_text()
    report_id = _report_id(report_key)
    if created:
        _require_permission_types(permissions, "create")
        report = {
            "id": report_id,
            "report_key": report_key,
            "report_name": report_name,
            "binding_type": payload.binding_type,
            "binding_text": binding_text,
            "inspection_date_text": inspection_date_text,
            "status": "pending",
            "created_by_user_id": current_user.id,
            "created_by_team_id": current_user.team_id,
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
        _require_permission_types(permissions, "edit")
        from_status = str(report.get("status") or "pending")
        _validated_record_revision(existing, payload.record_revision, action="saving")
        if from_status == "ready_to_review":
            raise HTTPException(status_code=400, detail="Return the report to edit before saving changes.")
        if from_status == "completed":
            raise HTTPException(status_code=400, detail="Completed reports cannot be edited.")
        if not _integer_id(report.get("created_by_team_id")):
            report["created_by_team_id"] = _report_team_id(db, report)
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
    report_mutation = (
        _upsert_mutation(
            coordinator,
            ENTITY_TYPE,
            report_key,
            report,
            unique_lock_keys=(f"cctv-report:{report_key}",),
        )
        if created
        else Mutation(
            entity_type=ENTITY_TYPE,
            entity_id=report_key,
            operation_type="update_entity",
            base_record_revision=str(payload.record_revision),
            values=report,
            unique_lock_keys=(f"cctv-report:{report_key}",),
        )
    )
    mutations = [
        report_mutation,
        *_review_mutations(coordinator, report_key, report_id, pipes),
        _event_mutation(coordinator, report_key, report_key, event),
    ]
    _commit(current_user, mutations)
    saved_entity = coordinator.get_entity(ENTITY_TYPE, report_key)
    saved_report = _entity_values(saved_entity) or report
    saved_report = {
        **saved_report,
        "record_revision": str((saved_entity or {}).get("record_revision") or ""),
    }
    return {
        "ok": True,
        "created": created,
        "report": _report_row(
            {"report": saved_report},
            _report_capabilities(db, current_user, saved_report, permissions),
        ),
    }


@router.delete("/api/reports/proactive-team-cctv-review/reports/{report_id}")
def _user_defect_mlo_ids(pipes: list[Any]) -> set[str]:
    """Reviewer-entered MLO ids referenced by a report's saved observation rows."""
    found: set[str] = set()
    for pipe in pipes:
        if not isinstance(pipe, dict):
            continue
        for group in pipe.get("distance_groups") or []:
            if not isinstance(group, dict):
                continue
            for observation in group.get("observations") or []:
                mlo_id = str((observation or {}).get("mlo_id") or "")
                if mlo_id.split("_", 1)[0] in user_observations.USER_MLO_PREFIXES:
                    found.add(mlo_id)
    return found


def _user_defect_delete_mutations(
    coordinator: Any, report_global_id: str, pipes: list[Any]
) -> list[Mutation]:
    """Delete the custom defects this report owns, sparing any another report uses.

    A reviewer-entered defect lives in the shared MLO table, not inside the report,
    so deleting the report alone would leave it behind to resurface in the next
    report on the same pipe. The guard matters for the same reason in reverse: two
    reports can cover one inspection, and the first deletion must not take defects
    the surviving report still shows.
    """
    candidates = _user_defect_mlo_ids(pipes)
    if not candidates:
        return []
    for observation_entity in coordinator.query_entities(CCTV_OBSERVATION_ENTITY_TYPE):
        values = _entity_values(observation_entity) or {}
        if str(values.get("report_global_id") or "") == report_global_id:
            continue
        candidates.discard(str(values.get("mlo_id") or ""))
        if not candidates:
            return []
    entities = []
    for mlo_id in sorted(candidates):
        entity = coordinator.get_entity(
            MLO_ENTITY_TYPE, stable_global_id("mlo", mlo_id)
        )
        if entity and not bool(entity.get("deleted")):
            entities.append(entity)
    return user_observations.delete_mutations(entities)


def delete_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    permissions = _require_resource_permission(db, current_user, "delete")
    found = _find_by_report_id(current_user, report_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    entity, values = found
    report = dict(values["report"])
    if report.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Only pending reports can be deleted.")
    report_global_id = str(entity["entity_id"])
    report_key = str(report.get("report_key") or "")
    coordinator = _coordinator(current_user)
    child_entities = {
        entity_type: _entities_for_report(
            coordinator,
            entity_type,
            report_global_id,
            report_key=report_key,
        )
        for entity_type in (
            CCTV_OBSERVATION_ENTITY_TYPE,
            CCTV_DISTANCE_GROUP_ENTITY_TYPE,
            CCTV_PIPE_ENTITY_TYPE,
        )
    }
    event_entities = _event_entities_for_report(coordinator, report_global_id, report_key)
    mutations = [
        mutation
        for entity_type, entities in child_entities.items()
        for mutation in _delete_mutations(coordinator, entity_type, entities)
    ]
    mutations.extend(_delete_mutations(coordinator, REVIEW_EVENT_ENTITY_TYPE, event_entities))
    pipes = list(values.get("pipes") or [])
    custom_defect_mutations = _user_defect_delete_mutations(coordinator, report_global_id, pipes)
    mutations.extend(custom_defect_mutations)
    mutations.append(
        Mutation(
            entity_type=ENTITY_TYPE,
            entity_id=report_global_id,
            operation_type="delete_entity",
            base_record_revision=str(entity["record_revision"]),
        )
    )
    _commit(current_user, mutations)
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
            "events": len(event_entities),
            "custom_defects": len(custom_defect_mutations),
        },
    }


@router.get("/api/reports/proactive-team-cctv-review/reports/{report_id}/events")
def list_report_events(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    permissions = _require_resource_permission(db, current_user, "view")
    found = _find_by_report_id(current_user, report_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    report = dict(found[1]["report"])
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
    permissions = _resource_permission_types(db, current_user)
    found = _find_by_report_id(current_user, report_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Report was not found.")
    entity, current = found
    values = copy.deepcopy(current)
    report = dict(values["report"])
    if payload.action == "submit_to_review":
        _require_permission_types(permissions, "edit")
    else:
        _require_permission_types(permissions, "review")
    _validated_record_revision(entity, payload.record_revision, action="changing status")
    report.pop("record_revision", None)
    if not _integer_id(report.get("created_by_team_id")):
        report["created_by_team_id"] = _report_team_id(db, report)
    from_status = str(report.get("status") or "pending")
    now = utc_now_text()
    if payload.action == "submit_to_review":
        if from_status != "pending":
            raise HTTPException(status_code=400, detail="Only pending reports can be submitted to review.")
        _validate_pipe_reviews(list(values.get("pipes") or []))
        to_status, event_type = "ready_to_review", "submitted_to_review"
        report.update({"submitted_by_user_id": current_user.id, "submitted_by_name": _display_name(current_user), "submitted_at": now})
    elif payload.action == "return_to_edit":
        if from_status != "ready_to_review":
            raise HTTPException(status_code=400, detail="Only ready-to-review reports can be returned to edit.")
        to_status, event_type = "pending", "returned_to_edit"
        report.update({"submitted_by_user_id": None, "submitted_by_name": None, "submitted_at": None, "reviewed_by_user_id": None, "reviewed_by_name": None, "reviewed_at": None})
    elif payload.action == "complete":
        if from_status != "ready_to_review":
            raise HTTPException(status_code=400, detail="Only ready-to-review reports can be completed.")
        to_status, event_type = "completed", "completed"
        report.update({"reviewed_by_user_id": current_user.id, "reviewed_by_name": _display_name(current_user), "reviewed_at": now})
    else:
        if from_status != "completed":
            raise HTTPException(status_code=400, detail="Only completed reports can be reopened.")
        to_status, event_type = "pending", "reopened"
        report.update({"submitted_by_user_id": None, "submitted_by_name": None, "submitted_at": None, "reviewed_by_user_id": None, "reviewed_by_name": None, "reviewed_at": None})
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
                base_record_revision=payload.record_revision,
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
