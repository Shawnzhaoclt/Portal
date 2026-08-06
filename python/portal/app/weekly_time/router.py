from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any, Literal

from portal.runtime.transport import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.management.database import get_db
from portal.app.management.models import CodeDictionary, CodeDictionaryItem, Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.security import utc_now_text
from portal.app.management.services import (
    ADMIN_ROLES,
    effective_resource_permission,
    get_user_or_404,
    managed_team_scope_ids,
    selected_user_role,
    write_audit_log,
)
from portal.app.sync.errors import (
    LockTimeout,
    RevisionChanged,
    SharedRootUnavailable,
    SnapshotRequired,
    SyncError,
)
from portal.app.sync.models import Identity, Mutation
from portal.app.sync.runtime import current_coordinator


RESOURCE_ID = "RPT7K2M9"
SUBMISSION_ENTITY_TYPE = f"{RESOURCE_ID}.weekly_submission"
ENTRY_ENTITY_TYPE = f"{RESOURCE_ID}.time_entry"
SCHEDULE_REQUEST_ENTITY_TYPE = f"{RESOURCE_ID}.schedule_change"
SCHEDULE_OVERRIDE_ENTITY_TYPE = f"{RESOURCE_ID}.schedule_override"
EVENT_ENTITY_TYPE = f"{RESOURCE_ID}.workflow_event"
HOLIDAY_ENTITY_TYPE = "ADMBSHVR.holiday"
WEEKLY_TIME_TYPE_DICTIONARY_KEY = "weekly_time_type"

DEFAULT_DAILY_HOURS = (7.0, 7.0, 7.0, 0.0, 0.0, 0.0, 0.0)
EDITABLE_STATUSES = {"draft", "returned"}
REVIEWABLE_STATUS = "submitted"

router = APIRouter(tags=["weekly-time-reporting"])


class EntrySaveRequest(BaseModel):
    week_start: str
    entry_type: str = Field(default="field_work", min_length=1, max_length=64)
    work_date: str
    hours: float = Field(ge=0.5, le=12)
    start_time: str | None = None
    end_time: str | None = None
    notes: str | None = None


class SubmitWeekRequest(BaseModel):
    week_start: str
    memo: str | None = None


class CopyPreviousWeekRequest(BaseModel):
    week_start: str


class ReviewRequest(BaseModel):
    action: Literal["approve", "return"]
    comments: str | None = None


class ScheduleDayRequest(BaseModel):
    work_date: str
    hours: float = Field(ge=0, le=24)


class ScheduleChangeRequest(BaseModel):
    week_start: str
    reason: str
    days: list[ScheduleDayRequest]


def _display_name(user: User) -> str:
    return f"{user.first_name} {user.last_name}".strip() or user.email


def _serialize_entry_type(entry_type: CodeDictionaryItem) -> dict[str, Any]:
    return {
        "id": entry_type.id,
        "type_key": entry_type.item_code,
        "label": entry_type.label,
        "sort_order": entry_type.sort_order,
        "is_active": bool(entry_type.is_active),
        "created_at": entry_type.created_at,
        "updated_at": entry_type.updated_at,
    }


def _weekly_time_dictionary(db: Session) -> CodeDictionary:
    dictionary = db.scalar(
        select(CodeDictionary).where(
            CodeDictionary.dictionary_key == WEEKLY_TIME_TYPE_DICTIONARY_KEY
        )
    )
    if dictionary is None or not dictionary.is_active:
        raise HTTPException(status_code=503, detail="Weekly time-entry types are not configured.")
    return dictionary


def _entry_types(db: Session, *, include_inactive: bool) -> list[CodeDictionaryItem]:
    dictionary = _weekly_time_dictionary(db)
    statement = select(CodeDictionaryItem).where(
        CodeDictionaryItem.dictionary_id == dictionary.id
    )
    if not include_inactive:
        statement = statement.where(CodeDictionaryItem.is_active == 1)
    return list(
        db.scalars(
            statement.order_by(
                CodeDictionaryItem.sort_order,
                CodeDictionaryItem.label,
                CodeDictionaryItem.id,
            )
        ).all()
    )


def _require_active_entry_type(db: Session, type_key: str) -> CodeDictionaryItem:
    dictionary = _weekly_time_dictionary(db)
    normalized = type_key.strip().lower()
    entry_type = db.scalar(
        select(CodeDictionaryItem).where(
            CodeDictionaryItem.dictionary_id == dictionary.id,
            CodeDictionaryItem.item_code == normalized,
        )
    )
    if entry_type is None:
        raise HTTPException(status_code=422, detail="The selected time-entry type does not exist.")
    if not entry_type.is_active:
        raise HTTPException(status_code=422, detail="The selected time-entry type is inactive.")
    return entry_type


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
            Identity(
                user_id=str(user.id),
                employee_number=str(user.employee_id),
                email=str(user.email),
            )
        )
    except SyncError as error:
        _sync_error(error)


def _commit(user: User, mutations: list[Mutation]) -> None:
    try:
        _coordinator(user).commit(mutations)
    except SyncError as error:
        _sync_error(error)


def _entity_values(entity: dict[str, object] | None) -> dict[str, Any] | None:
    if not entity or bool(entity.get("deleted")):
        return None
    values = entity.get("values")
    return dict(values) if isinstance(values, dict) else None


def _entities(user: User, entity_type: str) -> list[tuple[dict[str, object], dict[str, Any]]]:
    result: list[tuple[dict[str, object], dict[str, Any]]] = []
    for entity in _coordinator(user).list_entities(entity_type):
        values = _entity_values(entity)
        if values is not None:
            result.append((entity, values))
    return result


def parse_week_start(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Week start must use YYYY-MM-DD format.") from error
    if parsed.weekday() != 0:
        raise HTTPException(status_code=400, detail="Week start must be a Monday.")
    return parsed


def parse_work_date(value: str, week_start: date) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Work date must use YYYY-MM-DD format.") from error
    if parsed < week_start or parsed > week_start + timedelta(days=6):
        raise HTTPException(status_code=400, detail="Work date must be inside the selected week.")
    return parsed


def calculate_entry_hours(
    hours: float,
    start_time: str | None,
    end_time: str | None,
) -> float:
    start = (start_time or "").strip()
    end = (end_time or "").strip()
    if bool(start) != bool(end):
        raise HTTPException(status_code=400, detail="Provide both start and end time, or leave both blank.")
    if not start:
        normalized_hours = round(float(hours), 2)
        if normalized_hours < 0.5 or normalized_hours > 12:
            raise HTTPException(status_code=400, detail="Hours must be between 0.5 and 12.")
        return normalized_hours
    try:
        start_value = datetime.strptime(start, "%H:%M")
        end_value = datetime.strptime(end, "%H:%M")
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Start and end time must use HH:MM format.") from error
    minutes = int((end_value - start_value).total_seconds() // 60)
    if minutes <= 0:
        raise HTTPException(status_code=400, detail="End time must be later than start time.")
    calculated_hours = round(minutes / 60, 2)
    if calculated_hours < 0.5 or calculated_hours > 12:
        raise HTTPException(status_code=400, detail="The time span must be between 0.5 and 12 hours.")
    if abs(round(float(hours), 2) - calculated_hours) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Hours must equal the {calculated_hours}-hour time span.",
        )
    return calculated_hours


def _submission_id(user_id: int, week_start: date) -> str:
    return f"weekly-{user_id}-{week_start.isoformat()}"


def _find_submission(
    user: User, *, submission_id: str | None = None, owner_user_id: int | None = None, week_start: date | None = None
) -> tuple[dict[str, object], dict[str, Any]] | None:
    for entity, values in _entities(user, SUBMISSION_ENTITY_TYPE):
        if submission_id and str(values.get("submission_id")) != submission_id:
            continue
        if owner_user_id is not None and int(values.get("user_id") or 0) != owner_user_id:
            continue
        if week_start and str(values.get("week_start")) != week_start.isoformat():
            continue
        return entity, values
    return None


def _submission_values(owner: User, week_start: date, status: str = "draft") -> dict[str, Any]:
    now = utc_now_text()
    return {
        "submission_id": _submission_id(owner.id, week_start),
        "user_id": owner.id,
        "employee_id": owner.employee_id,
        "employee_name": _display_name(owner),
        "team_id": owner.team_id,
        "team_name": owner.team.name if owner.team else None,
        "week_start": week_start.isoformat(),
        "week_end": (week_start + timedelta(days=6)).isoformat(),
        "status": status,
        "created_at": now,
        "updated_at": now,
        "submitted_at": None,
        "reviewed_at": None,
        "reviewed_by_user_id": None,
        "reviewed_by_name": None,
        "review_comments": None,
    }


def _event_mutation(
    actor: User,
    *,
    subject_user_id: int,
    submission_id: str | None,
    event_type: str,
    week_start: date | str,
    from_status: str | None,
    to_status: str | None,
    memo: str | None = None,
) -> Mutation:
    event_id = str(uuid.uuid4())
    return Mutation(
        entity_type=EVENT_ENTITY_TYPE,
        entity_id=event_id,
        operation_type="insert_entity",
        base_record_revision=None,
        values={
            "event_id": event_id,
            "submission_id": submission_id,
            "subject_user_id": subject_user_id,
            "event_type": event_type,
            "week_start": week_start.isoformat() if isinstance(week_start, date) else str(week_start),
            "from_status": from_status,
            "to_status": to_status,
            "memo": (memo or "").strip() or None,
            "actor_user_id": actor.id,
            "actor_name": _display_name(actor),
            "event_at": utc_now_text(),
        },
    )


def _resource_permission_types(db: Session, user: User) -> set[str]:
    resource = db.scalar(select(Resource).where(Resource.resource_id == RESOURCE_ID))
    if resource is None:
        raise HTTPException(status_code=503, detail="Weekly Time Reporting is not registered.")
    result = effective_resource_permission(db, user, resource)
    return set(result.get("permission_types", [])) if result else set()


def _require_resource_permission(db: Session, user: User, *allowed: str) -> set[str]:
    permissions = _resource_permission_types(db, user)
    if not permissions.intersection(allowed):
        raise HTTPException(status_code=403, detail=f"Weekly Time Reporting requires {' or '.join(allowed)} permission.")
    return permissions


def _can_review(user: User, db: Session) -> bool:
    return (
        "review" in _resource_permission_types(db, user)
        and (selected_user_role(user) in ADMIN_ROLES or bool(managed_team_scope_ids(db, user)))
    )


def _can_review_owner(user: User, owner_team_id: int | None, db: Session) -> bool:
    if selected_user_role(user) in ADMIN_ROLES:
        return True
    return owner_team_id is not None and owner_team_id in managed_team_scope_ids(db, user)


def _require_owner_or_reviewer(user: User, owner: User, db: Session) -> None:
    if user.id != owner.id and not _can_review_owner(user, owner.team_id, db):
        raise HTTPException(status_code=403, detail="You cannot view this employee's weekly report.")


def _schedule_for_week(user: User, owner_id: int, week_start: date) -> list[float]:
    override_id = f"schedule-{owner_id}-{week_start.isoformat()}"
    entity = _coordinator(user).get_entity(SCHEDULE_OVERRIDE_ENTITY_TYPE, override_id)
    values = _entity_values(entity)
    if values and isinstance(values.get("daily_hours"), list) and len(values["daily_hours"]) == 7:
        return [max(0.0, float(value or 0)) for value in values["daily_hours"]]
    return list(DEFAULT_DAILY_HOURS)


def _holidays_for_week(user: User, week_start: date) -> list[dict[str, Any]]:
    week_end = week_start + timedelta(days=6)
    result: list[dict[str, Any]] = []
    for _, values in _entities(user, HOLIDAY_ENTITY_TYPE):
        if not values.get("is_active", True) or not values.get("applies_to_weekly_target", True):
            continue
        raw_date = values.get("holiday_date") or values.get("observed_date") or values.get("actual_date")
        try:
            holiday_date = date.fromisoformat(str(raw_date))
        except ValueError:
            continue
        if week_start <= holiday_date <= week_end:
            result.append(
                {
                    "holiday_id": values.get("holiday_id"),
                    "name": values.get("holiday_name"),
                    "date": holiday_date.isoformat(),
                    "hours": float(values.get("holiday_hours") or 0),
                }
            )
    return sorted(result, key=lambda item: item["date"])


def ensure_work_date_is_not_holiday(
    work_date: date,
    holidays: list[dict[str, Any]],
) -> None:
    if any(str(holiday.get("date")) == work_date.isoformat() for holiday in holidays):
        raise HTTPException(status_code=409, detail="Time entries cannot be added on a holiday.")


def _entry_fingerprint(values: dict[str, Any]) -> tuple[object, ...]:
    return (
        str(values.get("work_date") or ""),
        str(values.get("entry_type") or ""),
        round(float(values.get("hours") or 0), 2),
        str(values.get("start_time") or ""),
        str(values.get("end_time") or ""),
        str(values.get("notes") or ""),
    )


def calculate_week_target(
    week_start: date,
    daily_hours: list[float],
    holidays: list[dict[str, Any]],
) -> tuple[float, list[dict[str, Any]]]:
    adjusted = list(daily_hours)
    holiday_by_date = {str(item["date"]): item for item in holidays}
    days: list[dict[str, Any]] = []
    for index in range(7):
        work_date = week_start + timedelta(days=index)
        scheduled = float(adjusted[index])
        holiday = holiday_by_date.get(work_date.isoformat())
        reduction = min(scheduled, float(holiday["hours"])) if holiday else 0.0
        adjusted[index] = max(0.0, scheduled - reduction)
        days.append(
            {
                "date": work_date.isoformat(),
                "scheduled_hours": scheduled,
                "target_hours": adjusted[index],
                "holiday": holiday,
            }
        )
    return round(sum(adjusted), 2), days


def _serialize_submission(values: dict[str, Any] | None, owner: User, week_start: date) -> dict[str, Any]:
    if values is None:
        values = _submission_values(owner, week_start)
    return dict(values)


def _context_for(user: User, owner: User, week_start: date, db: Session) -> dict[str, Any]:
    resource_permissions = _require_resource_permission(db, user, "view", "edit", "review", "create", "delete", "manage", "admin")
    _require_owner_or_reviewer(user, owner, db)
    found = _find_submission(user, owner_user_id=owner.id, week_start=week_start)
    submission = _serialize_submission(found[1] if found else None, owner, week_start)
    submission_id = str(submission["submission_id"])
    entries = [
        dict(values)
        for _, values in _entities(user, ENTRY_ENTITY_TYPE)
        if str(values.get("submission_id")) == submission_id
    ]
    entries.sort(key=lambda item: (str(item.get("work_date")), str(item.get("created_at"))))
    schedule = _schedule_for_week(user, owner.id, week_start)
    holidays = _holidays_for_week(user, week_start)
    target_hours, schedule_days = calculate_week_target(week_start, schedule, holidays)
    reported_hours = round(sum(float(entry.get("hours") or 0) for entry in entries), 2)
    field_hours = round(
        sum(float(entry.get("hours") or 0) for entry in entries if entry.get("entry_type") == "field_work"),
        2,
    )
    schedule_requests = [
        dict(values)
        for _, values in _entities(user, SCHEDULE_REQUEST_ENTITY_TYPE)
        if int(values.get("user_id") or 0) == owner.id
        and str(values.get("week_start")) == week_start.isoformat()
    ]
    schedule_requests.sort(key=lambda item: str(item.get("created_at")), reverse=True)
    events = [
        dict(values)
        for _, values in _entities(user, EVENT_ENTITY_TYPE)
        if str(values.get("submission_id") or "") == submission_id
        or (
            not values.get("submission_id")
            and int(values.get("subject_user_id") or 0) == owner.id
            and str(values.get("week_start") or "") == week_start.isoformat()
        )
    ]
    events.sort(key=lambda item: str(item.get("event_at")), reverse=True)
    status = str(submission.get("status") or "draft")
    own_report = owner.id == user.id
    return {
        "resource_id": RESOURCE_ID,
        "user": {
            "id": owner.id,
            "employee_id": owner.employee_id,
            "display_name": _display_name(owner),
            "team_id": owner.team_id,
            "team_name": owner.team.name if owner.team else None,
        },
        "viewer": {
            "id": user.id,
            "display_name": _display_name(user),
            "role": selected_user_role(user),
            "can_review": _can_review(user, db),
        },
        "week_start": week_start.isoformat(),
        "week_end": (week_start + timedelta(days=6)).isoformat(),
        "submission": submission,
        "entries": entries,
        "entry_types": [_serialize_entry_type(item) for item in _entry_types(db, include_inactive=True)],
        "schedule_days": schedule_days,
        "holidays": holidays,
        "schedule_requests": schedule_requests,
        "events": events,
        "summary": {
            "target_hours": target_hours,
            "reported_hours": reported_hours,
            "field_hours": field_hours,
            "remaining_hours": round(target_hours - reported_hours, 2),
        },
        "permissions": {
            "can_edit": own_report and status in EDITABLE_STATUSES and bool(resource_permissions & {"edit", "manage", "admin"}),
            "can_create": own_report and status in EDITABLE_STATUSES and bool(resource_permissions & {"create", "manage", "admin"}),
            "can_delete": own_report and status in EDITABLE_STATUSES and bool(resource_permissions & {"delete", "manage", "admin"}),
            "can_submit": own_report and status in EDITABLE_STATUSES and bool(entries) and bool(resource_permissions & {"edit", "manage", "admin"}),
            "can_review": status == REVIEWABLE_STATUS and "review" in resource_permissions and _can_review_owner(user, owner.team_id, db),
            "can_request_schedule_change": own_report and bool(resource_permissions & {"create", "edit", "manage", "admin"}),
        },
    }


@router.get("/api/reports/weekly-time/context")
def weekly_context(
    week_start: str = Query(...),
    user_id: int | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    owner = get_user_or_404(db, user_id) if user_id else current_user
    return _context_for(current_user, owner, parse_week_start(week_start), db)


@router.get("/api/reports/weekly-time/entry-types")
def list_weekly_entry_types(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "view", "edit", "review", "create", "delete", "manage", "admin")
    return {"entry_types": [_serialize_entry_type(item) for item in _entry_types(db, include_inactive=False)]}


@router.post("/api/reports/weekly-time/entries")
def create_entry(
    payload: EntrySaveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "create", "manage", "admin")
    week_start = parse_week_start(payload.week_start)
    work_date = parse_work_date(payload.work_date, week_start)
    entry_type = _require_active_entry_type(db, payload.entry_type)
    ensure_work_date_is_not_holiday(work_date, _holidays_for_week(current_user, week_start))
    found = _find_submission(current_user, owner_user_id=current_user.id, week_start=week_start)
    submission_entity, submission = found if found else (None, _submission_values(current_user, week_start))
    if str(submission.get("status")) not in EDITABLE_STATUSES:
        raise HTTPException(status_code=409, detail="Only draft or returned weeks can be edited.")
    now = utc_now_text()
    submission["updated_at"] = now
    entry_id = str(uuid.uuid4())
    entry_values = {
        "entry_id": entry_id,
        "submission_id": submission["submission_id"],
        "user_id": current_user.id,
        "employee_id": current_user.employee_id,
        "entry_type": entry_type.item_code,
        "work_date": work_date.isoformat(),
        "hours": calculate_entry_hours(payload.hours, payload.start_time, payload.end_time),
        "start_time": (payload.start_time or "").strip() or None,
        "end_time": (payload.end_time or "").strip() or None,
        "notes": (payload.notes or "").strip() or None,
        "created_at": now,
        "updated_at": now,
    }
    _commit(
        current_user,
        [
            Mutation(
                entity_type=SUBMISSION_ENTITY_TYPE,
                entity_id=str(submission["submission_id"]),
                operation_type="update_entity" if submission_entity else "insert_entity",
                base_record_revision=str(submission_entity["record_revision"]) if submission_entity else None,
                values=submission,
                unique_lock_keys=(f"weekly:{current_user.id}:{week_start.isoformat()}",),
            ),
            Mutation(
                entity_type=ENTRY_ENTITY_TYPE,
                entity_id=entry_id,
                operation_type="insert_entity",
                base_record_revision=None,
                values=entry_values,
            ),
        ],
    )
    return _context_for(current_user, current_user, week_start, db)


@router.put("/api/reports/weekly-time/entries/{entry_id}")
def update_entry(
    entry_id: str,
    payload: EntrySaveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "edit", "manage", "admin")
    week_start = parse_week_start(payload.week_start)
    work_date = parse_work_date(payload.work_date, week_start)
    ensure_work_date_is_not_holiday(work_date, _holidays_for_week(current_user, week_start))
    entity = _coordinator(current_user).get_entity(ENTRY_ENTITY_TYPE, entry_id)
    values = _entity_values(entity)
    if not entity or not values or int(values.get("user_id") or 0) != current_user.id:
        raise HTTPException(status_code=404, detail="Time entry was not found.")
    found = _find_submission(current_user, submission_id=str(values.get("submission_id")))
    if not found or str(found[1].get("status")) not in EDITABLE_STATUSES:
        raise HTTPException(status_code=409, detail="Only draft or returned weeks can be edited.")
    requested_entry_type = payload.entry_type.strip().lower()
    if requested_entry_type != str(values.get("entry_type") or ""):
        _require_active_entry_type(db, requested_entry_type)
    values.update(
        {
            "entry_type": requested_entry_type,
            "work_date": work_date.isoformat(),
            "hours": calculate_entry_hours(payload.hours, payload.start_time, payload.end_time),
            "start_time": (payload.start_time or "").strip() or None,
            "end_time": (payload.end_time or "").strip() or None,
            "notes": (payload.notes or "").strip() or None,
            "updated_at": utc_now_text(),
        }
    )
    _commit(
        current_user,
        [
            Mutation(
                entity_type=ENTRY_ENTITY_TYPE,
                entity_id=entry_id,
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values=values,
            )
        ],
    )
    return _context_for(current_user, current_user, week_start, db)


@router.post("/api/reports/weekly-time/copy-previous-week")
def copy_previous_week(
    payload: CopyPreviousWeekRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "create", "manage", "admin")
    week_start = parse_week_start(payload.week_start)
    previous_week_start = week_start - timedelta(days=7)
    source_found = _find_submission(
        current_user,
        owner_user_id=current_user.id,
        week_start=previous_week_start,
    )
    if not source_found:
        raise HTTPException(status_code=404, detail="The previous week has no time entries to copy.")

    source_submission_id = str(source_found[1]["submission_id"])
    source_entries = [
        dict(values)
        for _, values in _entities(current_user, ENTRY_ENTITY_TYPE)
        if str(values.get("submission_id")) == source_submission_id
    ]
    if not source_entries:
        raise HTTPException(status_code=404, detail="The previous week has no time entries to copy.")

    target_found = _find_submission(
        current_user,
        owner_user_id=current_user.id,
        week_start=week_start,
    )
    target_entity, target_submission = (
        target_found if target_found else (None, _submission_values(current_user, week_start))
    )
    if str(target_submission.get("status")) not in EDITABLE_STATUSES:
        raise HTTPException(status_code=409, detail="Only draft or returned weeks can receive copied entries.")

    target_submission_id = str(target_submission["submission_id"])
    target_entries = [
        dict(values)
        for _, values in _entities(current_user, ENTRY_ENTITY_TYPE)
        if str(values.get("submission_id")) == target_submission_id
    ]
    existing_fingerprints = {_entry_fingerprint(values) for values in target_entries}
    holiday_dates = {
        str(holiday["date"])
        for holiday in _holidays_for_week(current_user, week_start)
    }
    now = utc_now_text()
    copied = 0
    skipped_holidays = 0
    skipped_duplicates = 0
    mutations: list[Mutation] = []

    for source in source_entries:
        try:
            source_date = date.fromisoformat(str(source.get("work_date")))
        except ValueError:
            continue
        target_date = source_date + timedelta(days=7)
        if target_date.isoformat() in holiday_dates:
            skipped_holidays += 1
            continue
        entry_id = str(uuid.uuid4())
        values = {
            "entry_id": entry_id,
            "submission_id": target_submission_id,
            "user_id": current_user.id,
            "employee_id": current_user.employee_id,
            "entry_type": source.get("entry_type"),
            "work_date": target_date.isoformat(),
            "hours": float(source.get("hours") or 0),
            "start_time": source.get("start_time"),
            "end_time": source.get("end_time"),
            "notes": source.get("notes"),
            "created_at": now,
            "updated_at": now,
        }
        fingerprint = _entry_fingerprint(values)
        if fingerprint in existing_fingerprints:
            skipped_duplicates += 1
            continue
        existing_fingerprints.add(fingerprint)
        mutations.append(
            Mutation(
                entity_type=ENTRY_ENTITY_TYPE,
                entity_id=entry_id,
                operation_type="insert_entity",
                base_record_revision=None,
                values=values,
            )
        )
        copied += 1

    if copied:
        target_submission["updated_at"] = now
        mutations.insert(
            0,
            Mutation(
                entity_type=SUBMISSION_ENTITY_TYPE,
                entity_id=target_submission_id,
                operation_type="update_entity" if target_entity else "insert_entity",
                base_record_revision=str(target_entity["record_revision"]) if target_entity else None,
                values=target_submission,
                unique_lock_keys=(f"weekly:{current_user.id}:{week_start.isoformat()}",),
            ),
        )
        mutations.append(
            _event_mutation(
                current_user,
                subject_user_id=current_user.id,
                submission_id=target_submission_id,
                event_type="previous_week_copied",
                week_start=week_start,
                from_status=str(target_submission.get("status")),
                to_status=str(target_submission.get("status")),
                memo=f"{copied} entries copied; {skipped_holidays} holidays and {skipped_duplicates} duplicates skipped.",
            )
        )
        _commit(current_user, mutations)

    return {
        "context": _context_for(current_user, current_user, week_start, db),
        "copied": copied,
        "skipped_holidays": skipped_holidays,
        "skipped_duplicates": skipped_duplicates,
    }


@router.delete("/api/reports/weekly-time/entries/{entry_id}")
def delete_entry(
    entry_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "delete", "manage", "admin")
    entity = _coordinator(current_user).get_entity(ENTRY_ENTITY_TYPE, entry_id)
    values = _entity_values(entity)
    if not entity or not values or int(values.get("user_id") or 0) != current_user.id:
        raise HTTPException(status_code=404, detail="Time entry was not found.")
    found = _find_submission(current_user, submission_id=str(values.get("submission_id")))
    if not found or str(found[1].get("status")) not in EDITABLE_STATUSES:
        raise HTTPException(status_code=409, detail="Only draft or returned weeks can be edited.")
    week_start = parse_week_start(str(found[1]["week_start"]))
    _commit(
        current_user,
        [
            Mutation(
                entity_type=ENTRY_ENTITY_TYPE,
                entity_id=entry_id,
                operation_type="delete_entity",
                base_record_revision=str(entity["record_revision"]),
            )
        ],
    )
    return _context_for(current_user, current_user, week_start, db)


@router.post("/api/reports/weekly-time/submit")
def submit_week(
    payload: SubmitWeekRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "edit", "manage", "admin")
    week_start = parse_week_start(payload.week_start)
    found = _find_submission(current_user, owner_user_id=current_user.id, week_start=week_start)
    if not found:
        raise HTTPException(status_code=409, detail="Add at least one time entry before submitting.")
    entity, submission = found
    if str(submission.get("status")) not in EDITABLE_STATUSES:
        raise HTTPException(status_code=409, detail="This week cannot be submitted in its current status.")
    entries = [
        values
        for _, values in _entities(current_user, ENTRY_ENTITY_TYPE)
        if str(values.get("submission_id")) == str(submission["submission_id"])
    ]
    if not entries:
        raise HTTPException(status_code=409, detail="Add at least one time entry before submitting.")
    from_status = str(submission.get("status"))
    now = utc_now_text()
    schedule = _schedule_for_week(current_user, current_user.id, week_start)
    holidays = _holidays_for_week(current_user, week_start)
    target_hours, schedule_days = calculate_week_target(week_start, schedule, holidays)
    submission.update(
        {
            "status": "submitted",
            "submitted_at": now,
            "updated_at": now,
            "reviewed_at": None,
            "reviewed_by_user_id": None,
            "reviewed_by_name": None,
            "review_comments": None,
            "submitted_target_hours": target_hours,
            "submitted_schedule_days": schedule_days,
        }
    )
    _commit(
        current_user,
        [
            Mutation(
                entity_type=SUBMISSION_ENTITY_TYPE,
                entity_id=str(submission["submission_id"]),
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values=submission,
            ),
            _event_mutation(
                current_user,
                subject_user_id=current_user.id,
                submission_id=str(submission["submission_id"]),
                event_type="week_submitted",
                week_start=week_start,
                from_status=from_status,
                to_status="submitted",
                memo=payload.memo,
            ),
        ],
    )
    return _context_for(current_user, current_user, week_start, db)


@router.get("/api/reports/weekly-time/review-queue")
def review_queue(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "review", "manage", "admin")
    if not _can_review(current_user, db):
        raise HTTPException(status_code=403, detail="Manager review access is required.")
    managed_ids = set(managed_team_scope_ids(db, current_user))
    admin = selected_user_role(current_user) in ADMIN_ROLES
    submissions = []
    for _, values in _entities(current_user, SUBMISSION_ENTITY_TYPE):
        if str(values.get("status")) != "submitted":
            continue
        if admin or int(values.get("team_id") or 0) in managed_ids:
            submissions.append(dict(values))
    submissions.sort(key=lambda item: str(item.get("submitted_at")), reverse=True)
    schedule_requests = []
    for _, values in _entities(current_user, SCHEDULE_REQUEST_ENTITY_TYPE):
        if str(values.get("status")) != "pending":
            continue
        if admin or int(values.get("team_id") or 0) in managed_ids:
            schedule_requests.append(dict(values))
    schedule_requests.sort(key=lambda item: str(item.get("created_at")), reverse=True)
    return {"submissions": submissions, "schedule_requests": schedule_requests}


@router.post("/api/reports/weekly-time/submissions/{submission_id}/review")
def review_submission(
    submission_id: str,
    payload: ReviewRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "review", "manage", "admin")
    found = _find_submission(current_user, submission_id=submission_id)
    if not found:
        raise HTTPException(status_code=404, detail="Weekly submission was not found.")
    entity, submission = found
    owner = get_user_or_404(db, int(submission["user_id"]))
    if not _can_review_owner(current_user, owner.team_id, db):
        raise HTTPException(status_code=403, detail="You cannot review this employee's week.")
    if str(submission.get("status")) != REVIEWABLE_STATUS:
        raise HTTPException(status_code=409, detail="Only submitted weeks can be reviewed.")
    comments = (payload.comments or "").strip()
    if payload.action == "return" and not comments:
        raise HTTPException(status_code=400, detail="Comments are required when returning a week.")
    to_status = "approved" if payload.action == "approve" else "returned"
    now = utc_now_text()
    submission.update(
        {
            "status": to_status,
            "updated_at": now,
            "reviewed_at": now,
            "reviewed_by_user_id": current_user.id,
            "reviewed_by_name": _display_name(current_user),
            "review_comments": comments or None,
        }
    )
    _commit(
        current_user,
        [
            Mutation(
                entity_type=SUBMISSION_ENTITY_TYPE,
                entity_id=submission_id,
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values=submission,
            ),
            _event_mutation(
                current_user,
                subject_user_id=owner.id,
                submission_id=submission_id,
                event_type="week_approved" if to_status == "approved" else "week_returned",
                week_start=str(submission["week_start"]),
                from_status="submitted",
                to_status=to_status,
                memo=comments,
            ),
        ],
    )
    return _context_for(current_user, owner, parse_week_start(str(submission["week_start"])), db)


@router.post("/api/reports/weekly-time/schedule-changes")
def create_schedule_change(
    payload: ScheduleChangeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "create", "edit", "manage", "admin")
    week_start = parse_week_start(payload.week_start)
    reason = payload.reason.strip()
    if not reason:
        raise HTTPException(status_code=400, detail="A reason is required.")
    proposed = {parse_work_date(day.work_date, week_start).isoformat(): day.hours for day in payload.days}
    if len(proposed) != 7:
        raise HTTPException(status_code=400, detail="Provide planned hours for all seven days.")
    existing_requests = [
        (entity, values)
        for entity, values in _entities(current_user, SCHEDULE_REQUEST_ENTITY_TYPE)
        if int(values.get("user_id") or 0) == current_user.id
        and str(values.get("week_start")) == week_start.isoformat()
    ]
    if any(str(values.get("status")) == "pending" for _, values in existing_requests):
        raise HTTPException(status_code=409, detail="A schedule change is already pending for this week.")
    returned = next(
        ((entity, values) for entity, values in existing_requests if str(values.get("status")) == "returned"),
        None,
    )
    request_id = str(returned[1]["request_id"]) if returned else str(uuid.uuid4())
    now = utc_now_text()
    values = {
        "request_id": request_id,
        "user_id": current_user.id,
        "employee_id": current_user.employee_id,
        "employee_name": _display_name(current_user),
        "team_id": current_user.team_id,
        "team_name": current_user.team.name if current_user.team else None,
        "week_start": week_start.isoformat(),
        "week_end": (week_start + timedelta(days=6)).isoformat(),
        "reason": reason,
        "daily_hours": [float(proposed[(week_start + timedelta(days=index)).isoformat()]) for index in range(7)],
        "status": "pending",
        "created_at": str(returned[1].get("created_at")) if returned else now,
        "updated_at": now,
        "submitted_at": now,
        "reviewed_at": None,
        "reviewed_by_user_id": None,
        "reviewed_by_name": None,
        "review_comments": None,
    }
    _commit(
        current_user,
        [
            Mutation(
                entity_type=SCHEDULE_REQUEST_ENTITY_TYPE,
                entity_id=request_id,
                operation_type="update_entity" if returned else "insert_entity",
                base_record_revision=str(returned[0]["record_revision"]) if returned else None,
                values=values,
            ),
            _event_mutation(
                current_user,
                subject_user_id=current_user.id,
                submission_id=None,
                event_type="schedule_change_resubmitted" if returned else "schedule_change_requested",
                week_start=week_start,
                from_status="returned" if returned else None,
                to_status="pending",
                memo=reason,
            ),
        ],
    )
    return _context_for(current_user, current_user, week_start, db)


@router.post("/api/reports/weekly-time/schedule-changes/{request_id}/withdraw")
def withdraw_schedule_change(
    request_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "edit", "manage", "admin")
    entity = _coordinator(current_user).get_entity(SCHEDULE_REQUEST_ENTITY_TYPE, request_id)
    values = _entity_values(entity)
    if not entity or not values or int(values.get("user_id") or 0) != current_user.id:
        raise HTTPException(status_code=404, detail="Schedule request was not found.")
    if str(values.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Only pending schedule requests can be withdrawn.")
    values.update({"status": "withdrawn", "updated_at": utc_now_text()})
    week_start = parse_week_start(str(values["week_start"]))
    _commit(
        current_user,
        [
            Mutation(
                entity_type=SCHEDULE_REQUEST_ENTITY_TYPE,
                entity_id=request_id,
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values=values,
            ),
            _event_mutation(
                current_user,
                subject_user_id=current_user.id,
                submission_id=None,
                event_type="schedule_change_withdrawn",
                week_start=week_start,
                from_status="pending",
                to_status="withdrawn",
            ),
        ],
    )
    return _context_for(current_user, current_user, week_start, db)


@router.post("/api/reports/weekly-time/schedule-changes/{request_id}/review")
def review_schedule_change(
    request_id: str,
    payload: ReviewRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "review", "manage", "admin")
    entity = _coordinator(current_user).get_entity(SCHEDULE_REQUEST_ENTITY_TYPE, request_id)
    values = _entity_values(entity)
    if not entity or not values:
        raise HTTPException(status_code=404, detail="Schedule request was not found.")
    owner = get_user_or_404(db, int(values["user_id"]))
    if not _can_review_owner(current_user, owner.team_id, db):
        raise HTTPException(status_code=403, detail="You cannot review this employee's schedule.")
    if str(values.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Only pending schedule requests can be reviewed.")
    comments = (payload.comments or "").strip()
    if payload.action == "return" and not comments:
        raise HTTPException(status_code=400, detail="Comments are required when returning a request.")
    to_status = "approved" if payload.action == "approve" else "returned"
    values.update(
        {
            "status": to_status,
            "reviewed_at": utc_now_text(),
            "reviewed_by_user_id": current_user.id,
            "reviewed_by_name": _display_name(current_user),
            "review_comments": comments or None,
        }
    )
    mutations = [
        Mutation(
            entity_type=SCHEDULE_REQUEST_ENTITY_TYPE,
            entity_id=request_id,
            operation_type="update_entity",
            base_record_revision=str(entity["record_revision"]),
            values=values,
        ),
        _event_mutation(
            current_user,
            subject_user_id=owner.id,
            submission_id=None,
            event_type="schedule_change_approved" if to_status == "approved" else "schedule_change_returned",
            week_start=str(values["week_start"]),
            from_status="pending",
            to_status=to_status,
            memo=comments,
        ),
    ]
    if to_status == "approved":
        override_id = f"schedule-{owner.id}-{values['week_start']}"
        override_entity = _coordinator(current_user).get_entity(SCHEDULE_OVERRIDE_ENTITY_TYPE, override_id)
        mutations.append(
            Mutation(
                entity_type=SCHEDULE_OVERRIDE_ENTITY_TYPE,
                entity_id=override_id,
                operation_type="update_entity" if override_entity else "insert_entity",
                base_record_revision=str(override_entity["record_revision"]) if override_entity else None,
                values={
                    "override_id": override_id,
                    "request_id": request_id,
                    "user_id": owner.id,
                    "week_start": values["week_start"],
                    "daily_hours": values["daily_hours"],
                    "approved_by_user_id": current_user.id,
                    "approved_by_name": _display_name(current_user),
                    "approved_at": utc_now_text(),
                },
                unique_lock_keys=(f"weekly-schedule:{owner.id}:{values['week_start']}",),
            )
        )
    _commit(current_user, mutations)
    return _context_for(current_user, owner, parse_week_start(str(values["week_start"])), db)
