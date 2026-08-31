from __future__ import annotations

import base64
import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field
from sqlalchemy import inspect as sqlalchemy_inspect, select
from sqlalchemy.orm import Session

from portal.runtime.transport import APIRouter, Depends, HTTPException, Query, Response

from portal.app.exports import ExcelColumn, build_portal_excel_export
from portal.app.management.database import get_db
from portal.app.management.models import CodeDictionary, CodeDictionaryItem, Resource, Team, User
from portal.app.management.router import get_current_user
from portal.app.management.security import utc_now_text
from portal.app.management.services import (
    ADMIN_ROLES,
    PERMISSION_TYPES,
    effective_resource_permission,
    selected_user_role,
)
from portal.app.sync.errors import LockTimeout, RevisionChanged, SharedRootUnavailable, SnapshotRequired, SyncError
from portal.app.sync.models import Mutation
from portal.app.sync.physical_entities import (
    AIF_PROACTIVE_INSPECTION_ENTITY_TYPE,
    CCTV_DISTANCE_GROUP_ENTITY_TYPE,
    CCTV_OBSERVATION_ENTITY_TYPE,
    CCTV_PIPE_ENTITY_TYPE,
    REVIEW_EVENT_ENTITY_TYPE,
    physical_spec,
    stable_global_id,
)
from portal.app.sync.runtime import current_coordinator, sync_identity

from .source import (
    cityworks_history,
    list_asset_candidates,
    list_observations,
    normalize_source_identifier,
    search_asset,
    verify_source_schema,
)


RESOURCE_ID = "FRMAIF01"
RESOURCE_KEY = "create_aif_from_itpipes"
ENTITY_TYPE = AIF_PROACTIVE_INSPECTION_ENTITY_TYPE
SUBJECT_TYPE = "aif_proactive_inspection"
ALLOWED_STATUSES = {"pending", "ready_to_review", "completed"}
EDITABLE_FIELDS = (
    "inspection_direction",
    "flooding_impact",
    "flooding_service_eligibility",
    "flooding_design_standards",
    "defect_severity",
    "defect_callout",
    "consequence_location",
    "consequence_location_zol",
    "service_eligibility",
    "defect_stationing",
    "limited_extensive",
)
REGISTER_SEARCH_COLUMNS = (
    "inspection_id",
    "entity_uid",
    "source_mli_id",
    "source_mlo_id",
    "initiated_by",
    "initiated_by_user_id",
    "submitted_to",
    "submitted_to_user_id",
    "closed_by",
    "closed_by_user_id",
)
REGISTER_SORTS = {
    "updated_at": "updated_at",
    "inspection_id": "inspection_id",
    "entity_uid": "entity_uid",
    "source_inspection_date": "source_inspection_date",
    "defect_severity": "defect_severity",
    "status": "status",
    "initiated_by": "initiated_by",
    "date_initiated": "date_initiated",
    "submitted_to": "submitted_to",
    "date_submitted": "date_submitted",
    "date_closed": "date_closed",
}
EXPORT_LIMIT = 10_000
# One digit: an asset is not inspected more than a handful of times in a single day.
IDENTIFIER_SEQUENCE_LIMIT = 9
IDENTIFIER_COLLISION_RETRIES = 3
REVIEWER_PERMISSION_TYPES = {"review", "manage", "admin"}
CONTROLLED_DICTIONARY_FIELDS = {
    "flooding_impact": "flooding_impact",
    "flooding_service_eligibility": "flooding_service_eligibility",
    "flooding_design_standards": "flooding_design_standards",
    "defect_severity": "defect_severity",
    "consequence_location": "consequence_location",
    "consequence_location_zol": "consequence_location_zoi",
    "service_eligibility": "service_eligibility",
}
SYSTEM_DATA_TABLES = (
    "SYS_TEAMS",
    "SYS_USERS",
    "SYS_RESOURCES",
    "SYS_RESOURCE_PERMISSIONS",
    "SYS_DICTIONARIES",
    "SYS_DICTIONARY_ITEMS",
)
BUSINESS_ENTITY_TABLES = {
    AIF_PROACTIVE_INSPECTION_ENTITY_TYPE: "AIF_PROACTIVE_INSPECTIONS",
    CCTV_PIPE_ENTITY_TYPE: "CCTV_REVIEW_PIPES",
    CCTV_DISTANCE_GROUP_ENTITY_TYPE: "CCTV_REVIEW_DISTANCE_GROUPS",
    CCTV_OBSERVATION_ENTITY_TYPE: "CCTV_REVIEW_OBSERVATIONS",
    REVIEW_EVENT_ENTITY_TYPE: "SYS_RESOURCE_REVIEW_EVENTS",
}

router = APIRouter(prefix="/api/forms/create-aif-from-itpipes", tags=["create-aif-from-itpipes"])


class AifFieldsRequest(BaseModel):
    inspection_direction: Literal[0, 1] | None = None
    flooding_impact: str | None = None
    flooding_service_eligibility: str | None = None
    flooding_design_standards: str | None = None
    defect_severity: str | None = None
    defect_callout: str | None = None
    consequence_location: str | None = None
    consequence_location_zol: str | None = None
    service_eligibility: str | None = None
    defect_stationing: float | None = None
    limited_extensive: Literal["Limited", "Extensive"] | None = None


class AifCreateRequest(AifFieldsRequest):
    asset_id: str = Field(min_length=1, max_length=128)
    source_mli_id: str = Field(min_length=1, max_length=128)
    source_mlo_id: str = Field(min_length=1, max_length=128)


class AifSaveRequest(AifFieldsRequest):
    record_revision: str = Field(min_length=1)
    memo: str | None = Field(default=None, max_length=2000)


class AifDeleteRequest(BaseModel):
    record_revision: str = Field(min_length=1)


class AifSubmitRequest(BaseModel):
    record_revision: str = Field(min_length=1)
    reviewer_employee_id: str = Field(min_length=1, max_length=64)
    memo: str | None = Field(default=None, max_length=2000)
    defect_severity_unavailable: bool = False
    defect_callout_unavailable: bool = False


class AifWorkflowRequest(BaseModel):
    record_revision: str = Field(min_length=1)
    action: Literal["return_to_edit", "complete", "reopen"]
    memo: str | None = Field(default=None, max_length=2000)


def _display_name(user: User) -> str:
    full_name = f"{user.last_name}, {user.first_name}".strip(" ,")
    return full_name or user.email


def _employee_id(user: User) -> str:
    value = str(user.employee_id or "").strip()
    if not value:
        raise HTTPException(status_code=422, detail="The current Portal account does not have an employee ID.")
    return value


def _resource(db: Session) -> Resource:
    resource = db.scalar(select(Resource).where(Resource.resource_id == RESOURCE_ID))
    if resource is None or resource.is_active != 1:
        raise HTTPException(status_code=503, detail="Create AIF from ITPipes is not registered in the Portal catalog.")
    return resource


def _permission_types(db: Session, user: User) -> set[str]:
    result = effective_resource_permission(db, user, _resource(db))
    return set(result.get("permission_types") or []) if result else set()


def _is_admin(user: User) -> bool:
    return selected_user_role(user) in ADMIN_ROLES


def _direct_manager_user_id(db: Session, user: User) -> int | None:
    if user.team_id is None:
        return None
    return db.scalar(
        select(Team.manager_user_id).where(
            Team.id == user.team_id,
            Team.is_active == 1,
        )
    )


def _reviewer_eligibility(
    db: Session,
    submitter: User,
    candidate: User,
    resource: Resource | None = None,
    permission_types: set[str] | None = None,
) -> tuple[bool, bool]:
    is_direct_manager = _direct_manager_user_id(db, submitter) == candidate.id
    if permission_types is None:
        effective = effective_resource_permission(db, candidate, resource or _resource(db))
        permission_types = set(effective.get("permission_types") or []) if effective else set()
    has_reviewer_permission = _is_admin(candidate) or bool(permission_types.intersection(REVIEWER_PERMISSION_TYPES))
    return is_direct_manager, has_reviewer_permission


def _record_submitter(db: Session, values: dict[str, Any]) -> User | None:
    employee_id = str(values.get("inspected_by_user_id") or "").strip()
    if not employee_id:
        return None
    return db.scalar(select(User).where(User.employee_id == employee_id))


def _require_permission(db: Session, user: User, *permissions: str) -> set[str]:
    current = _permission_types(db, user)
    if _is_admin(user):
        return set(PERMISSION_TYPES)
    if not current.intersection(permissions):
        raise HTTPException(status_code=403, detail=f"This action requires {' or '.join(permissions)} permission.")
    return current


def _sync_error(error: SyncError) -> None:
    if isinstance(error, RevisionChanged):
        status = 409
    elif isinstance(error, LockTimeout):
        status = 423
    elif isinstance(error, (SharedRootUnavailable, SnapshotRequired)):
        status = 503
    else:
        status = 422
    raise HTTPException(status_code=status, detail={"code": error.code, "message": str(error), "details": error.details})


def _coordinator(user: User):
    try:
        return current_coordinator(
            sync_identity(user)
        )
    except SyncError as error:
        _sync_error(error)


def _verify_system_datasource(db: Session) -> list[str]:
    actual_tables = set(sqlalchemy_inspect(db.get_bind()).get_table_names())
    missing = [table for table in SYSTEM_DATA_TABLES if table not in actual_tables]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"The Portal system database is missing required AIF table(s): {', '.join(missing)}.",
        )
    return list(SYSTEM_DATA_TABLES)


def _verify_business_datasource(coordinator: Any) -> list[str]:
    registry_mismatches = [
        f"{entity_type} -> {physical_spec(entity_type).table}"
        for entity_type, expected_table in BUSINESS_ENTITY_TABLES.items()
        if physical_spec(entity_type).table != expected_table
    ]
    if registry_mismatches:
        raise HTTPException(
            status_code=503,
            detail="The Portal business entity registry does not match the AIF design: "
            + "; ".join(registry_mismatches),
        )

    database_path = coordinator.database_path
    if database_path.name.casefold() != "stormwater.db":
        raise HTTPException(
            status_code=503,
            detail="Create AIF from ITPipes must use the configured stormwater.db business database.",
        )
    try:
        with closing(sqlite3.connect(database_path.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
            actual_tables = {
                str(row[0])
                for row in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'table'").fetchall()
            }
    except (OSError, sqlite3.Error) as error:
        raise HTTPException(
            status_code=503,
            detail="The configured stormwater.db business database is unavailable.",
        ) from error
    missing = [table for table in BUSINESS_ENTITY_TABLES.values() if table not in actual_tables]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"stormwater.db is missing required AIF table(s): {', '.join(missing)}.",
        )
    return list(BUSINESS_ENTITY_TABLES.values())


def _entity_values(entity: dict[str, object] | None) -> dict[str, Any] | None:
    if not entity or bool(entity.get("deleted")):
        return None
    values = entity.get("values")
    return dict(values) if isinstance(values, dict) else None


def _action_flags(db: Session, user: User, values: dict[str, Any]) -> dict[str, bool]:
    permissions = _permission_types(db, user)
    admin = _is_admin(user)
    status = str(values.get("status") or "pending")
    assigned = str(values.get("submitted_to_user_id") or "") == _employee_id(user)
    manage = admin or "manage" in permissions or "admin" in permissions
    edit = admin or bool(permissions.intersection({"edit", "manage", "admin"}))
    submitter = _record_submitter(db, values)
    eligible = False
    if assigned and submitter is not None:
        is_direct_manager, has_reviewer_permission = _reviewer_eligibility(
            db,
            submitter,
            user,
            permission_types=permissions,
        )
        eligible = is_direct_manager or has_reviewer_permission
    review = manage or eligible
    return {
        "can_view": admin or "view" in permissions or bool(permissions),
        "can_edit": status == "pending" and edit,
        "can_submit": status == "pending" and edit,
        "can_delete": _can_delete_aif(db, user, values, permissions=permissions, admin=admin),
        "can_review": status == "ready_to_review" and review,
        "can_reopen": status == "completed" and manage,
    }


def _can_delete_aif(
    db: Session,
    user: User,
    values: dict[str, Any],
    *,
    permissions: set[str] | None = None,
    admin: bool | None = None,
) -> bool:
    if str(values.get("status") or "") != "pending":
        return False
    current_employee_id = _employee_id(user)
    if str(values.get("initiated_by_user_id") or "").strip() == current_employee_id:
        return True
    current_permissions = permissions if permissions is not None else _permission_types(db, user)
    is_admin = _is_admin(user) if admin is None else admin
    return is_admin or bool(current_permissions.intersection({"delete", "manage", "admin"}))


def _aif_response(db: Session, user: User, entity: dict[str, object]) -> dict[str, Any]:
    values = _entity_values(entity)
    if values is None:
        raise HTTPException(status_code=404, detail="AIF was not found.")
    return {
        **values,
        "global_id": str(entity["entity_id"]),
        "record_revision": str(entity.get("record_revision") or ""),
        "conflict_state": str(entity.get("conflict_state") or "none"),
        "actions": _action_flags(db, user, values),
    }


def _normalize_text(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _canonical_dictionary_label(db: Session, dictionary_key: str, value: object) -> str | None:
    normalized = _normalize_text(value)
    if normalized is None:
        return None
    dictionary = db.scalar(
        select(CodeDictionary).where(
            CodeDictionary.dictionary_key == dictionary_key,
            CodeDictionary.is_active == 1,
        )
    )
    if dictionary is None:
        raise HTTPException(
            status_code=503,
            detail=f"The required {dictionary_key} system dictionary is unavailable.",
        )
    items = db.scalars(
        select(CodeDictionaryItem).where(
            CodeDictionaryItem.dictionary_id == dictionary.id,
            CodeDictionaryItem.is_active == 1,
        )
    ).all()
    match = next((item.label for item in items if item.label.casefold() == normalized.casefold()), None)
    if match is None:
        raise HTTPException(
            status_code=422,
            detail=f"{normalized} is not an active value in the {dictionary.name} dictionary.",
        )
    return match


def _validated_inspection_direction(db: Session, value: object) -> int | None:
    if value is None:
        return None
    dictionary = db.scalar(
        select(CodeDictionary).where(
            CodeDictionary.dictionary_key == "inspection_direction",
            CodeDictionary.is_active == 1,
        )
    )
    if dictionary is None:
        raise HTTPException(status_code=503, detail="The required inspection_direction system dictionary is unavailable.")
    code = str(int(value))
    item = db.scalar(
        select(CodeDictionaryItem).where(
            CodeDictionaryItem.dictionary_id == dictionary.id,
            CodeDictionaryItem.item_code == code,
            CodeDictionaryItem.is_active == 1,
        )
    )
    if item is None:
        raise HTTPException(status_code=422, detail="The selected inspection direction is not active in the system dictionary.")
    return int(code)


def _clean_fields(db: Session, payload: AifFieldsRequest) -> dict[str, Any]:
    raw = payload.model_dump()
    values: dict[str, Any] = {}
    for field in EDITABLE_FIELDS:
        value = raw.get(field)
        if isinstance(value, str):
            value = _normalize_text(value)
        if field in CONTROLLED_DICTIONARY_FIELDS:
            value = _canonical_dictionary_label(db, CONTROLLED_DICTIONARY_FIELDS[field], value)
        elif field == "inspection_direction":
            value = _validated_inspection_direction(db, value)
        values[field] = value
    return values


def _next_aif_identity(coordinator: Any, asset_id: str, local_date: str) -> tuple[str, str]:
    safe_asset = re.sub(r"[^A-Z0-9_-]+", "", asset_id) or "ASSET"
    prefix = f"AIF-{safe_asset}-{local_date}-"
    highest = 0
    # Deleted AIFs included: a tombstone keeps its identifier forever, so allocation
    # must see it or the sequence restarts and reissues a number whose global id
    # collides with the dead record - the same failure the MLO allocator had.
    for entity in coordinator.query_entities(
        ENTITY_TYPE, filters={"entity_uid": asset_id}, include_deleted=True
    ):
        # Not _entity_values: that helper hides deleted entities, which are
        # exactly the rows this scan exists to see.
        raw_values = entity.get("values")
        values = raw_values if isinstance(raw_values, dict) else None
        if values is None:
            continue
        # Reads any width so identifiers issued before the sequence was shortened to one
        # digit still count; otherwise numbering would restart and reissue a taken number.
        match = re.fullmatch(re.escape(prefix) + r"(\d+)", str(values.get("inspection_id") or ""))
        if match:
            highest = max(highest, int(match.group(1)))
    sequence = highest + 1
    if sequence > IDENTIFIER_SEQUENCE_LIMIT:
        raise HTTPException(
            status_code=409,
            detail=(
                f"All {IDENTIFIER_SEQUENCE_LIMIT} AIF identifiers for this Asset ID and date "
                "are already in use."
            ),
        )
    inspection_id = f"{prefix}{sequence}"
    return inspection_id, stable_global_id("aif", inspection_id)


def _severity_label(db: Session, am_score: object) -> str | None:
    if am_score is None:
        return None
    dictionary = db.scalar(select(CodeDictionary).where(CodeDictionary.dictionary_key == "defect_severity"))
    if dictionary is None:
        return None
    item = db.scalar(
        select(CodeDictionaryItem).where(
            CodeDictionaryItem.dictionary_id == dictionary.id,
            CodeDictionaryItem.item_code == str(am_score).strip(),
            CodeDictionaryItem.is_active == 1,
        )
    )
    return item.label if item else None


def _cctv_enrichment(db: Session, user: User, mli_id: str, mlo_id: str) -> dict[str, Any]:
    mli_id = normalize_source_identifier(mli_id)
    mlo_id = normalize_source_identifier(mlo_id)
    coordinator = _coordinator(user)
    matches = []
    for entity in coordinator.query_entities(CCTV_OBSERVATION_ENTITY_TYPE, filters={"mlo_id": mlo_id}):
        values = _entity_values(entity)
        if values and normalize_source_identifier(values.get("mli_id")) == mli_id:
            matches.append((entity, values))
    if not matches:
        return {"available": False, "ambiguous": False, "message": "No CCTV Review value available"}
    if len(matches) != 1:
        return {"available": False, "ambiguous": True, "message": "Multiple CCTV Review matches require resolution."}
    _, observation = matches[0]
    group_entity = coordinator.get_entity(
        CCTV_DISTANCE_GROUP_ENTITY_TYPE,
        str(observation.get("distance_group_global_id") or ""),
    )
    pipe_entity = coordinator.get_entity(
        CCTV_PIPE_ENTITY_TYPE,
        str(observation.get("pipe_global_id") or ""),
    )
    group = _entity_values(group_entity) or {}
    pipe = _entity_values(pipe_entity) or {}
    # defect_callout moved from the distance group to each observation; fall back to the
    # legacy group-level comment only for the major observation of a report saved before that.
    defect_callout = observation.get("defect_callout")
    if defect_callout is None and observation.get("defect_role") == "major":
        defect_callout = group.get("defect_comment")
    return {
        "available": True,
        "ambiguous": False,
        "limited_extensive": "Extensive" if bool(observation.get("is_extensive")) else "Limited",
        "defect_severity": _severity_label(db, group.get("am_score")),
        "defect_callout": defect_callout,
        "clogging_evidence": pipe.get("clogging_percent"),
    }


def _source_selection(db: Session, user: User, asset_id: str, mli_id: str, mlo_id: str) -> dict[str, Any]:
    mli_id = normalize_source_identifier(mli_id)
    mlo_id = normalize_source_identifier(mlo_id)
    source = list_observations(asset_id, mli_id)
    observation = next(
        (
            row
            for row in source["observations"]
            if normalize_source_identifier(row.get("mlo_id")) == mlo_id
            and normalize_source_identifier(row.get("mli_id")) == mli_id
        ),
        None,
    )
    if observation is None:
        raise HTTPException(status_code=404, detail=f"MLO_ID {mlo_id} was not found under MLI_ID {mli_id}.")
    enrichment = _cctv_enrichment(db, user, mli_id, mlo_id)
    return {"source": source, "observation": observation, "enrichment": enrichment}


def _event_entities_for_aif(coordinator: Any, global_id: str) -> list[dict[str, Any]]:
    """Every review event recorded against one AIF, ignoring rows already removed."""
    return [
        entity
        for entity in coordinator.query_entities(
            REVIEW_EVENT_ENTITY_TYPE,
            filters={
                "resource_key": RESOURCE_KEY,
                "subject_type": SUBJECT_TYPE,
                "subject_global_id": global_id,
            },
        )
        if not bool(entity.get("deleted"))
    ]


def _event_delete_mutations(entities: list[dict[str, Any]]) -> list[Mutation]:
    return [
        Mutation(
            entity_type=REVIEW_EVENT_ENTITY_TYPE,
            entity_id=str(entity["entity_id"]),
            operation_type="delete_entity",
            base_record_revision=str(entity["record_revision"]),
        )
        for entity in entities
    ]


def _event_mutation(
    coordinator: Any,
    resource: Resource,
    aif_global_id: str,
    inspection_id: str,
    event_type: str,
    user: User,
    from_status: str | None,
    to_status: str | None,
    memo: str | None,
    correlation_id: str,
) -> Mutation:
    event_at = utc_now_text()
    event_id = stable_global_id("aif-event", aif_global_id, event_type, event_at, correlation_id)
    values = {
        "resource_id": resource.id,
        "resource_key": RESOURCE_KEY,
        "resource_type": "form",
        "subject_type": SUBJECT_TYPE,
        "subject_global_id": aif_global_id,
        "subject_display_key": inspection_id,
        "event_type": event_type,
        "actor_user_id": _employee_id(user),
        "actor_name": _display_name(user),
        "event_at": event_at,
        "from_status": from_status,
        "to_status": to_status,
        "memo": _normalize_text(memo),
        "correlation_id": correlation_id,
    }
    return Mutation(
        entity_type=REVIEW_EVENT_ENTITY_TYPE,
        entity_id=event_id,
        operation_type="insert_entity",
        base_record_revision=None,
        values=values,
    )


def _commit(user: User, mutations: list[Mutation]) -> None:
    try:
        _coordinator(user).commit(mutations)
    except sqlite3.IntegrityError as error:
        raise HTTPException(
            status_code=409,
            detail="The AIF conflicts with a record created by another user. Refresh and retry.",
        ) from error
    except SyncError as error:
        _sync_error(error)


def _encode_cursor(values: dict[str, Any], sort_column: str, descending: bool) -> str:
    payload = {"column": sort_column, "value": values.get(sort_column), "global_id": values["global_id"], "descending": descending}
    return base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")


def _decode_cursor(cursor: str | None, sort_column: str, descending: bool) -> list[tuple[str, object, bool]] | None:
    if not cursor:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if payload.get("column") != sort_column or bool(payload.get("descending")) != descending:
            raise ValueError
        return [(sort_column, payload["value"], descending), ("global_id", payload["global_id"], descending)]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="The AIF Register cursor is invalid for the current sort.") from error


def _register_query(
    user: User,
    *,
    saved_view: str,
    search: str,
    status: str | None,
    source_date_from: str | None,
    source_date_to: str | None,
    initiated_from: str | None,
    initiated_to: str | None,
    submitted_from: str | None,
    submitted_to: str | None,
    closed_from: str | None,
    closed_to: str | None,
    initiator_employee_id: str | None,
    reviewer_employee_id: str | None,
    defect_severity: str | None,
) -> tuple[dict[str, object], list[tuple[str, str, object]], tuple[tuple[str, ...], str] | None]:
    filters: dict[str, object] = {}
    predicates: list[tuple[str, str, object]] = []
    employee_id = _employee_id(user)
    if saved_view == "my_drafts":
        filters.update({"status": "pending", "initiated_by_user_id": employee_id})
    elif saved_view == "assigned_to_me":
        filters["submitted_to_user_id"] = employee_id
        if not status:
            filters["status"] = "ready_to_review"
    elif saved_view == "ready_to_review":
        filters["status"] = "ready_to_review"
    elif saved_view == "completed":
        filters["status"] = "completed"
    elif saved_view != "all":
        raise HTTPException(status_code=422, detail="Unsupported AIF Register view.")
    if status:
        if status not in ALLOWED_STATUSES:
            raise HTTPException(status_code=422, detail="Unsupported AIF status filter.")
        filters["status"] = status
    if initiator_employee_id:
        filters["initiated_by_user_id"] = initiator_employee_id.strip()
    if reviewer_employee_id:
        filters["submitted_to_user_id"] = reviewer_employee_id.strip()
    if defect_severity:
        filters["defect_severity"] = defect_severity.strip()
    for column, minimum, maximum in (
        ("source_inspection_date", source_date_from, source_date_to),
        ("date_initiated", initiated_from, initiated_to),
        ("date_submitted", submitted_from, submitted_to),
        ("date_closed", closed_from, closed_to),
    ):
        if minimum:
            predicates.append((column, "gte", minimum))
        if maximum:
            predicates.append((column, "lte", maximum + "T23:59:59" if len(maximum) == 10 else maximum))
    normalized_search = search.strip()
    search_clause = (REGISTER_SEARCH_COLUMNS, normalized_search) if normalized_search else None
    return filters, predicates, search_clause


def _register_parameters(
    saved_view: str = Query(default="all"),
    search: str = Query(default="", max_length=200),
    status: str | None = Query(default=None),
    source_date_from: str | None = Query(default=None),
    source_date_to: str | None = Query(default=None),
    initiated_from: str | None = Query(default=None),
    initiated_to: str | None = Query(default=None),
    submitted_from: str | None = Query(default=None),
    submitted_to: str | None = Query(default=None),
    closed_from: str | None = Query(default=None),
    closed_to: str | None = Query(default=None),
    initiator_employee_id: str | None = Query(default=None),
    reviewer_employee_id: str | None = Query(default=None),
    defect_severity: str | None = Query(default=None),
) -> dict[str, Any]:
    return locals()


@router.get("/source-status")
def source_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    status = verify_source_schema()
    coordinator = _coordinator(current_user)
    status.update(
        {
            "business_database": "stormwater.db",
            "business_tables": _verify_business_datasource(coordinator),
            "system_database": "system.db",
            "system_tables": _verify_system_datasource(db),
        }
    )
    return status


@router.get("/asset-candidates")
def asset_candidates(
    query: str = Query(min_length=1, max_length=100),
    limit: int = Query(default=10, ge=1, le=10),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    return {"query": query.strip(), "candidates": list_asset_candidates(query, limit=limit)}


@router.get("/assets/{asset_id}")
def asset_search(
    asset_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    result = search_asset(asset_id)
    try:
        history = cityworks_history(result["asset_id"])
        history_warning = None
    except HTTPException as error:
        history = []
        history_warning = str(error.detail)
    coordinator = _coordinator(current_user)
    for entity in coordinator.query_entities(ENTITY_TYPE, filters={"entity_uid": result["asset_id"]}, order_by=(("updated_at", True),)):
        values = _entity_values(entity)
        if values:
            history.append({
                "inspection_id": values.get("inspection_id"),
                "inspection_date": values.get("source_inspection_date") or values.get("inspection_date") or values.get("date_initiated"),
                "source": "Portal AIF",
                "status": values.get("status"),
                "actor": values.get("inspected_by") or values.get("initiated_by"),
                "global_id": entity["entity_id"],
            })
    history.sort(key=lambda row: str(row.get("inspection_date") or ""), reverse=True)
    return {**result, "history": history, "history_warning": history_warning}


@router.get("/assets/{asset_id}/inspections/{mli_id}/observations")
def observations(
    asset_id: str,
    mli_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    result = list_observations(asset_id, mli_id)
    return result


@router.get("/assets/{asset_id}/inspections/{mli_id}/observations/{mlo_id}/enrichment")
def observation_enrichment(
    asset_id: str,
    mli_id: str,
    mlo_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    selected = _source_selection(db, current_user, asset_id, mli_id, mlo_id)
    return {"observation": selected["observation"], "enrichment": selected["enrichment"], "source_inspection_date": selected["source"]["source_inspection_date"]}


@router.get("/reviewers")
def reviewers(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    resource = _resource(db)
    rows: list[dict[str, Any]] = []
    for user in db.scalars(select(User).where(User.is_active == 1, User.deleted_at.is_(None)).order_by(User.last_name, User.first_name)).all():
        employee_id = str(user.employee_id or "").strip()
        if not employee_id:
            continue
        permission = effective_resource_permission(db, user, resource)
        types = set(permission.get("permission_types") or []) if permission else set()
        is_direct_manager, has_reviewer_permission = _reviewer_eligibility(
            db,
            current_user,
            user,
            resource=resource,
            permission_types=types,
        )
        if is_direct_manager or has_reviewer_permission:
            rows.append(
                {
                    "employee_id": employee_id,
                    "display_name": _display_name(user),
                    "email": user.email,
                    "is_direct_manager": is_direct_manager,
                }
            )
    rows.sort(
        key=lambda row: (
            not bool(row["is_direct_manager"]),
            str(row["display_name"]).casefold(),
            str(row["employee_id"]).casefold(),
        )
    )
    return {"reviewers": rows}


@router.get("/aifs")
def list_aifs(
    parameters: dict[str, Any] = Depends(_register_parameters),
    sort: str = Query(default="updated_at"),
    direction: Literal["asc", "desc"] = Query(default="desc"),
    page_size: int = Query(default=25),
    cursor: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    if page_size not in {25, 50, 100}:
        raise HTTPException(status_code=422, detail="Page size must be 25, 50, or 100.")
    sort_column = REGISTER_SORTS.get(sort)
    if sort_column is None:
        raise HTTPException(status_code=422, detail="Unsupported AIF Register sort column.")
    descending = direction == "desc"
    filters, predicates, search_clause = _register_query(current_user, **parameters)
    coordinator = _coordinator(current_user)
    keyset = _decode_cursor(cursor, sort_column, descending)
    entities = coordinator.query_entities(
        ENTITY_TYPE,
        filters=filters,
        predicates=predicates,
        search=search_clause,
        order_by=((sort_column, descending), ("global_id", descending)),
        keyset_after=keyset,
        limit=page_size + 1,
    )
    has_more = len(entities) > page_size
    entities = entities[:page_size]
    rows = [_aif_response(db, current_user, entity) for entity in entities]
    total = coordinator.count_entities(ENTITY_TYPE, filters=filters, predicates=predicates, search=search_clause)
    status_counts = {
        item: coordinator.count_entities(
            ENTITY_TYPE,
            filters={**{key: value for key, value in filters.items() if key != "status"}, "status": item},
            predicates=predicates,
            search=search_clause,
        )
        for item in sorted(ALLOWED_STATUSES)
    }
    next_cursor = _encode_cursor(rows[-1], sort_column, descending) if has_more and rows else None
    return {
        "rows": rows,
        "total": total,
        "status_counts": status_counts,
        "next_cursor": next_cursor,
        "current_cursor": cursor,
        "filters": parameters,
        "can_create": _is_admin(current_user) or bool(_permission_types(db, current_user).intersection({"create", "admin"})),
        "can_export": True,
    }


@router.get("/aifs/{global_id}")
def get_aif(
    global_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    entity = _coordinator(current_user).get_entity(ENTITY_TYPE, global_id)
    if _entity_values(entity) is None:
        raise HTTPException(status_code=404, detail="AIF was not found.")
    return {"aif": _aif_response(db, current_user, entity)}


@router.post("/aifs")
def create_aif(
    payload: AifCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "create", "admin")
    asset_id = payload.asset_id.strip().upper()
    mli_id = normalize_source_identifier(payload.source_mli_id)
    mlo_id = normalize_source_identifier(payload.source_mlo_id)
    selected = _source_selection(db, current_user, asset_id, mli_id, mlo_id)
    coordinator = _coordinator(current_user)
    if coordinator.query_entities(ENTITY_TYPE, filters={"active_source_mlo_id": mlo_id}, limit=1):
        raise HTTPException(status_code=409, detail="An active AIF already exists for the selected ITPipes observation.")
    today = datetime.now().strftime("%Y%m%d")
    now = utc_now_text()
    actor_id = _employee_id(current_user)
    actor_name = _display_name(current_user)
    observation = selected["observation"]
    enrichment = selected["enrichment"]
    inspection_direction = observation.get("inspection_direction")
    if inspection_direction is None:
        inspection_direction = selected["source"]["inspection"].get("inspection_direction")
    values = {
        "entity_uid": asset_id,
        "inspection_date": None,
        "inspected_by": None,
        "date_closed": None,
        "closed_by": None,
        "initiated_by": actor_name,
        "date_initiated": now,
        "submitted_to": None,
        "date_submitted": None,
        "status": "pending",
        "inspection_direction": inspection_direction,
        "flooding_impact": observation.get("flooding_impact"),
        "flooding_service_eligibility": observation.get("flooding_service_eligibility"),
        "flooding_design_standards": observation.get("flooding_design_standards"),
        "defect_severity": enrichment.get("defect_severity"),
        "defect_callout": enrichment.get("defect_callout"),
        "consequence_location": observation.get("consequence_location"),
        "consequence_location_zol": observation.get("consequence_location_zol"),
        "service_eligibility": observation.get("service_eligibility"),
        "defect_stationing": observation.get("stationing"),
        "limited_extensive": enrichment.get("limited_extensive"),
        "source_system": "itpipes",
        "source_mli_id": mli_id,
        "source_mlo_id": mlo_id,
        "source_inspection_date": selected["source"].get("source_inspection_date"),
        "initiated_by_user_id": actor_id,
        "inspected_by_user_id": None,
        "submitted_to_user_id": None,
        "closed_by_user_id": None,
        "updated_at": now,
        "updated_by": actor_name,
        "updated_by_user_id": actor_id,
        "active_source_mlo_id": mlo_id,
        **_clean_fields(db, payload),
    }
    resource = _resource(db)
    last_collision: HTTPException | None = None
    for _attempt in range(IDENTIFIER_COLLISION_RETRIES):
        if coordinator.query_entities(ENTITY_TYPE, filters={"active_source_mlo_id": mlo_id}, limit=1):
            raise HTTPException(status_code=409, detail="An active AIF already exists for the selected ITPipes observation.")
        inspection_id, global_id = _next_aif_identity(coordinator, asset_id, today)
        candidate_values = {**values, "inspection_id": inspection_id}
        correlation_id = uuid4().hex
        mutation = Mutation(
            entity_type=ENTITY_TYPE,
            entity_id=global_id,
            operation_type="insert_entity",
            base_record_revision=None,
            values=candidate_values,
            unique_lock_keys=(f"aif-sequence:{asset_id}:{today}", f"aif-active-mlo:{mlo_id}"),
        )
        try:
            _commit(
                current_user,
                [
                    mutation,
                    _event_mutation(
                        coordinator,
                        resource,
                        global_id,
                        inspection_id,
                        "created",
                        current_user,
                        None,
                        "pending",
                        None,
                        correlation_id,
                    ),
                ],
            )
        except HTTPException as error:
            if error.status_code != 409:
                raise
            last_collision = error
            continue
        entity = coordinator.get_entity(ENTITY_TYPE, global_id)
        return {"aif": _aif_response(db, current_user, entity)}
    raise HTTPException(
        status_code=409,
        detail="Another user created an AIF at the same time. Refresh and retry.",
    ) from last_collision


@router.put("/aifs/{global_id}")
def save_aif(
    global_id: str,
    payload: AifSaveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "edit", "manage", "admin")
    coordinator = _coordinator(current_user)
    entity = coordinator.get_entity(ENTITY_TYPE, global_id)
    values = _entity_values(entity)
    if values is None:
        raise HTTPException(status_code=404, detail="AIF was not found.")
    if values.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Only pending AIFs can be edited.")
    now = utc_now_text()
    updated = {**values, **_clean_fields(db, payload), "updated_at": now, "updated_by": _display_name(current_user), "updated_by_user_id": _employee_id(current_user)}
    correlation_id = uuid4().hex
    mutation = Mutation(ENTITY_TYPE, global_id, "update_entity", payload.record_revision, updated)
    event = _event_mutation(coordinator, _resource(db), global_id, str(values["inspection_id"]), "saved", current_user, "pending", "pending", payload.memo, correlation_id)
    _commit(current_user, [mutation, event])
    return {"aif": _aif_response(db, current_user, coordinator.get_entity(ENTITY_TYPE, global_id))}


@router.delete("/aifs/{global_id}")
def delete_aif(
    global_id: str,
    payload: AifDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    coordinator = _coordinator(current_user)
    entity = coordinator.get_entity(ENTITY_TYPE, global_id)
    values = _entity_values(entity)
    if values is None:
        raise HTTPException(status_code=404, detail="AIF was not found.")
    if str(values.get("status") or "") != "pending":
        raise HTTPException(status_code=409, detail="Only draft or pending AIFs can be deleted.")
    if not _can_delete_aif(db, current_user, values):
        raise HTTPException(
            status_code=403,
            detail="Only the draft owner or a user with Delete, Manage, or Admin permission can delete this AIF.",
        )
    # Deleting an AIF removes its whole history with it, so no review events are left
    # referring to a subject that no longer exists.
    event_entities = _event_entities_for_aif(coordinator, global_id)
    mutations = _event_delete_mutations(event_entities)
    mutations.append(
        Mutation(
            entity_type=ENTITY_TYPE,
            entity_id=global_id,
            operation_type="delete_entity",
            base_record_revision=payload.record_revision,
            unique_lock_keys=(f"aif-active-mlo:{values.get('source_mlo_id')}",),
        )
    )
    _commit(current_user, mutations)
    return {
        "ok": True,
        "global_id": global_id,
        "inspection_id": str(values["inspection_id"]),
        "deleted": {"aifs": 1, "events": len(event_entities)},
    }


def _reviewer(db: Session, submitter: User, employee_id: str) -> User:
    reviewer = db.scalar(
        select(User).where(
            User.employee_id == employee_id.strip(),
            User.is_active == 1,
            User.deleted_at.is_(None),
        )
    )
    if reviewer is None:
        raise HTTPException(status_code=422, detail="The selected reviewer is not an active Portal user.")
    is_direct_manager, has_reviewer_permission = _reviewer_eligibility(db, submitter, reviewer)
    if not (is_direct_manager or has_reviewer_permission):
        raise HTTPException(
            status_code=422,
            detail="The selected reviewer must be your direct manager or have Review, Manage, or Admin permission for this resource.",
        )
    return reviewer


@router.post("/aifs/{global_id}/submit")
def submit_aif(
    global_id: str,
    payload: AifSubmitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "edit", "manage", "admin")
    coordinator = _coordinator(current_user)
    entity = coordinator.get_entity(ENTITY_TYPE, global_id)
    values = _entity_values(entity)
    if values is None:
        raise HTTPException(status_code=404, detail="AIF was not found.")
    if values.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Only pending AIFs can be submitted.")
    enrichment = _cctv_enrichment(
        db,
        current_user,
        str(values.get("source_mli_id") or ""),
        str(values.get("source_mlo_id") or ""),
    )
    if enrichment.get("ambiguous"):
        raise HTTPException(
            status_code=409,
            detail=enrichment.get("message") or "The CCTV Review match must be resolved before submission.",
        )
    missing = []
    if not _normalize_text(values.get("defect_severity")) and not payload.defect_severity_unavailable:
        missing.append("Defect severity is required or must be confirmed unavailable.")
    if not _normalize_text(values.get("defect_callout")) and not payload.defect_callout_unavailable:
        missing.append("Defect callout is required or must be confirmed unavailable.")
    if missing:
        raise HTTPException(status_code=422, detail={"message": "Review the required AIF fields.", "fields": missing})
    reviewer = _reviewer(db, current_user, payload.reviewer_employee_id)
    now = utc_now_text()
    updated = {
        **values,
        "status": "ready_to_review",
        "inspection_date": now,
        "inspected_by": _display_name(current_user),
        "inspected_by_user_id": _employee_id(current_user),
        "submitted_to": _display_name(reviewer),
        "submitted_to_user_id": _employee_id(reviewer),
        "date_submitted": now,
        "updated_at": now,
        "updated_by": _display_name(current_user),
        "updated_by_user_id": _employee_id(current_user),
    }
    correlation_id = uuid4().hex
    _commit(current_user, [
        Mutation(ENTITY_TYPE, global_id, "update_entity", payload.record_revision, updated),
        _event_mutation(coordinator, _resource(db), global_id, str(values["inspection_id"]), "submitted_to_review", current_user, "pending", "ready_to_review", payload.memo, correlation_id),
    ])
    return {"aif": _aif_response(db, current_user, coordinator.get_entity(ENTITY_TYPE, global_id))}


@router.post("/aifs/{global_id}/workflow")
def workflow_aif(
    global_id: str,
    payload: AifWorkflowRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    coordinator = _coordinator(current_user)
    entity = coordinator.get_entity(ENTITY_TYPE, global_id)
    values = _entity_values(entity)
    if values is None:
        raise HTTPException(status_code=404, detail="AIF was not found.")
    status = str(values.get("status") or "")
    permissions = _permission_types(db, current_user)
    manage = _is_admin(current_user) or bool(permissions.intersection({"manage", "admin"}))
    assigned = str(values.get("submitted_to_user_id") or "") == _employee_id(current_user)
    submitter = _record_submitter(db, values)
    assigned_eligible = False
    if assigned and submitter is not None:
        is_direct_manager, has_reviewer_permission = _reviewer_eligibility(
            db,
            submitter,
            current_user,
            permission_types=permissions,
        )
        assigned_eligible = is_direct_manager or has_reviewer_permission
    now = utc_now_text()
    updated = dict(values)
    if payload.action in {"return_to_edit", "complete"}:
        if status != "ready_to_review":
            raise HTTPException(status_code=409, detail="Only ready-to-review AIFs can use this action.")
        if not manage and not assigned_eligible:
            raise HTTPException(
                status_code=403,
                detail="This AIF is not assigned to you, or you are no longer an eligible reviewer.",
            )
    if payload.action == "return_to_edit":
        to_status, event_type = "pending", "returned_to_edit"
        updated.update({"status": to_status, "submitted_to": None, "submitted_to_user_id": None, "date_submitted": None, "date_closed": None, "closed_by": None, "closed_by_user_id": None})
    elif payload.action == "complete":
        to_status, event_type = "completed", "completed"
        updated.update({"status": to_status, "date_closed": now, "closed_by": _display_name(current_user), "closed_by_user_id": _employee_id(current_user), "active_source_mlo_id": None})
    else:
        _require_permission(db, current_user, "manage", "admin")
        if status != "completed":
            raise HTTPException(status_code=409, detail="Only completed AIFs can be reopened.")
        if not _normalize_text(payload.memo):
            raise HTTPException(status_code=422, detail="A memo is required to reopen a completed AIF.")
        mlo_id = str(values.get("source_mlo_id") or "")
        duplicate = coordinator.query_entities(ENTITY_TYPE, filters={"active_source_mlo_id": mlo_id}, limit=1)
        if duplicate:
            raise HTTPException(status_code=409, detail="Another active AIF already uses this ITPipes observation.")
        to_status, event_type = "ready_to_review", "reopened"
        updated.update({"status": to_status, "date_closed": None, "closed_by": None, "closed_by_user_id": None, "active_source_mlo_id": mlo_id})
    updated.update({"updated_at": now, "updated_by": _display_name(current_user), "updated_by_user_id": _employee_id(current_user)})
    correlation_id = uuid4().hex
    _commit(current_user, [
        Mutation(ENTITY_TYPE, global_id, "update_entity", payload.record_revision, updated, unique_lock_keys=(f"aif-active-mlo:{values.get('source_mlo_id')}",)),
        _event_mutation(coordinator, _resource(db), global_id, str(values["inspection_id"]), event_type, current_user, status, to_status, payload.memo, correlation_id),
    ])
    return {"aif": _aif_response(db, current_user, coordinator.get_entity(ENTITY_TYPE, global_id))}


@router.get("/aifs/{global_id}/events")
def aif_events(
    global_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, "view")
    rows = []
    for entity in _coordinator(current_user).query_entities(
        REVIEW_EVENT_ENTITY_TYPE,
        filters={"resource_key": RESOURCE_KEY, "subject_type": SUBJECT_TYPE, "subject_global_id": global_id},
        order_by=(("event_at", True), ("global_id", True)),
    ):
        if values := _entity_values(entity):
            rows.append({**values, "global_id": entity["entity_id"]})
    return {"events": rows}


def _status_label(value: Any) -> str:
    return {
        "pending": "Pending",
        "ready_to_review": "Ready for review",
        "completed": "Completed",
    }.get(str(value or ""), str(value or ""))


def _inspection_direction_label(value: Any) -> str:
    if value in (1, "1", True):
        return "Upstream to downstream"
    if value in (0, "0", False):
        return "Downstream to upstream"
    return str(value or "")


def _source_system_label(value: Any) -> str:
    return "ITPipes" if str(value or "").strip().lower() == "itpipes" else str(value or "")


def _workbook(
    rows: list[dict[str, Any]],
    title: str,
    *,
    exported_by: str,
    filters: dict[str, Any] | None = None,
) -> bytes:
    columns = (
        ExcelColumn("inspection_id", "AIF ID", 30),
        ExcelColumn("entity_uid", "Asset ID", 16),
        ExcelColumn("source_system", "Source system", 14, transform=_source_system_label),
        ExcelColumn("source_inspection_date", "Source inspection date", 20, "date"),
        ExcelColumn("source_mli_id", "MLI ID", 14),
        ExcelColumn("source_mlo_id", "MLO ID", 14),
        ExcelColumn("inspection_direction", "Inspection direction", 28, transform=_inspection_direction_label),
        ExcelColumn("defect_stationing", "Defect stationing", 16, "number"),
        ExcelColumn("defect_severity", "Defect severity", 20),
        ExcelColumn("defect_callout", "Defect callout", 38, wrap_text=True),
        ExcelColumn("limited_extensive", "Classification", 18),
        ExcelColumn("flooding_impact", "Flooding impact", 34, wrap_text=True),
        ExcelColumn("flooding_service_eligibility", "Flooding service eligibility", 36, wrap_text=True),
        ExcelColumn("flooding_design_standards", "Flooding design standards", 32, wrap_text=True),
        ExcelColumn("consequence_location", "Consequence location", 30, wrap_text=True),
        ExcelColumn("consequence_location_zol", "Consequence location zone of influence", 42, wrap_text=True),
        ExcelColumn("service_eligibility", "Service eligibility", 36, wrap_text=True),
        ExcelColumn("status", "Status", 19, transform=_status_label),
        ExcelColumn("initiated_by", "Initiated by", 24),
        ExcelColumn("initiated_by_user_id", "Initiator employee ID", 20),
        ExcelColumn("date_initiated", "Date initiated", 23, "datetime"),
        ExcelColumn("inspected_by", "Inspected by", 24),
        ExcelColumn("inspected_by_user_id", "Inspector employee ID", 20),
        ExcelColumn("inspection_date", "Inspection date", 23, "datetime"),
        ExcelColumn("submitted_to", "Submitted to", 24),
        ExcelColumn("submitted_to_user_id", "Reviewer employee ID", 20),
        ExcelColumn("date_submitted", "Date submitted", 23, "datetime"),
        ExcelColumn("closed_by", "Closed by", 24),
        ExcelColumn("closed_by_user_id", "Closer employee ID", 20),
        ExcelColumn("date_closed", "Date closed", 23, "datetime"),
        ExcelColumn("updated_by", "Updated by", 24),
        ExcelColumn("updated_by_user_id", "Updater employee ID", 20),
        ExcelColumn("updated_at", "Last updated", 23, "datetime"),
    )
    return build_portal_excel_export(
        report_title=title,
        columns=columns,
        rows=rows,
        exported_by=exported_by,
        filters=filters,
        sheet_name="Asset Inspection Form Register",
    )


def _date_range_label(start: Any, end: Any) -> str | None:
    if start and end:
        return f"{start} through {end}"
    if start:
        return f"From {start}"
    if end:
        return f"Through {end}"
    return None


def _export_filter_summary(parameters: dict[str, Any], sort: str, direction: str) -> dict[str, Any]:
    view_labels = {
        "all": "All AIFs",
        "my_drafts": "My drafts",
        "assigned_to_me": "Assigned to me",
        "ready_to_review": "Ready for review",
        "completed": "Completed",
    }
    sort_labels = {
        "updated_at": "Last updated",
        "inspection_id": "AIF ID",
        "entity_uid": "Asset ID",
        "source_inspection_date": "Source inspection date",
        "defect_severity": "Defect severity",
        "status": "Status",
        "date_initiated": "Date initiated",
        "date_submitted": "Date submitted",
        "date_closed": "Date closed",
    }
    return {
        "View": view_labels.get(str(parameters.get("saved_view") or "all"), "All AIFs"),
        "Search": parameters.get("search"),
        "Status": _status_label(parameters.get("status")) if parameters.get("status") else None,
        "Source inspection date": _date_range_label(parameters.get("source_date_from"), parameters.get("source_date_to")),
        "Date initiated": _date_range_label(parameters.get("initiated_from"), parameters.get("initiated_to")),
        "Date submitted": _date_range_label(parameters.get("submitted_from"), parameters.get("submitted_to")),
        "Date closed": _date_range_label(parameters.get("closed_from"), parameters.get("closed_to")),
        "Initiator employee ID": parameters.get("initiator_employee_id"),
        "Reviewer employee ID": parameters.get("reviewer_employee_id"),
        "Defect severity": parameters.get("defect_severity"),
        "Sort": f"{sort_labels.get(sort, sort)} {direction.upper()}",
    }


@router.get("/export")
def export_register(
    parameters: dict[str, Any] = Depends(_register_parameters),
    sort: str = Query(default="updated_at"),
    direction: Literal["asc", "desc"] = Query(default="desc"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    _require_permission(db, current_user, "view")
    sort_column = REGISTER_SORTS.get(sort)
    if sort_column is None:
        raise HTTPException(status_code=422, detail="Unsupported AIF Register sort column.")
    filters, predicates, search_clause = _register_query(current_user, **parameters)
    coordinator = _coordinator(current_user)
    total = coordinator.count_entities(ENTITY_TYPE, filters=filters, predicates=predicates, search=search_clause)
    if total > EXPORT_LIMIT:
        raise HTTPException(status_code=422, detail=f"The filtered export contains {total:,} AIFs. Narrow it to {EXPORT_LIMIT:,} or fewer rows.")
    rows = [
        _aif_response(db, current_user, entity)
        for entity in coordinator.query_entities(
            ENTITY_TYPE,
            filters=filters,
            predicates=predicates,
            search=search_clause,
            order_by=((sort_column, direction == "desc"), ("global_id", direction == "desc")),
            limit=EXPORT_LIMIT,
        )
    ]
    filename = f"Asset-Inspection-Form-Register-{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"
    return Response(
        content=_workbook(
            rows,
            "Asset Inspection Form Register",
            exported_by=f"{_display_name(current_user)} ({_employee_id(current_user)})",
            filters=_export_filter_summary(parameters, sort, direction),
        ),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
