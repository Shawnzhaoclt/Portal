from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any, Literal

from portal.runtime.transport import APIRouter, Depends, HTTPException, Query, Response

from portal.app.exports import ExcelColumn, ExcelSheet, build_portal_excel_workbook
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from portal.app.management.database import get_db
from portal.app.management.models import CodeDictionary, CodeDictionaryItem, Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.security import utc_now_text
from portal.app.management.services import (
    ADMIN_ROLES,
    PERMISSION_TYPES,
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
# Kept under its original name because the operation log is immutable, but it now
# carries time-off requests: the columns are an exact fit - a week, a reason, hours
# per day, and a review outcome - and reusing them avoids a schema change.
TIME_OFF_ENTITY_TYPE = f"{RESOURCE_ID}.schedule_change"
SCHEDULE_OVERRIDE_ENTITY_TYPE = f"{RESOURCE_ID}.schedule_override"
EVENT_ENTITY_TYPE = f"{RESOURCE_ID}.workflow_event"
HOLIDAY_ENTITY_TYPE = "ADMBSHVR.holiday"
WEEKLY_TIME_TYPE_DICTIONARY_KEY = "weekly_time_type"

# The standard week every target is measured against. There is no longer a page for
# editing a schedule, so this is what everyone gets unless an override was recorded
# while that page existed; it matches the eight-hour daily cap and the weekend rule.
DEFAULT_DAILY_HOURS = (8.0, 8.0, 8.0, 8.0, 8.0, 0.0, 0.0)
EDITABLE_STATUSES = {"draft", "returned"}
REVIEWABLE_STATUS = "submitted"
REOPENABLE_STATUS = "approved"
LOCKED_WEEK_DETAIL = (
    "This week is locked. A manager or administrator must reopen it before it can be edited."
)

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
    action: Literal["approve", "return", "reopen"]
    comments: str | None = None


class TimeOffRequest(BaseModel):
    start_date: str
    end_date: str
    reason: str


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
    if selected_user_role(user) in ADMIN_ROLES:
        return set(PERMISSION_TYPES)
    result = effective_resource_permission(db, user, resource)
    return set(result.get("permission_types", [])) if result else set()


def _require_resource_permission(db: Session, user: User, *allowed: str) -> set[str]:
    permissions = _resource_permission_types(db, user)
    if not permissions.intersection(allowed):
        raise HTTPException(status_code=403, detail=f"Weekly Time Reporting requires {' or '.join(allowed)} permission.")
    return permissions


def _can_review(user: User, db: Session) -> bool:
    permissions = _resource_permission_types(db, user)
    if selected_user_role(user) in ADMIN_ROLES or "manage" in permissions:
        return True
    return "review" in permissions and bool(managed_team_scope_ids(db, user))


def _sees_every_employee(user: User) -> bool:
    """Only the admin roles look across the whole organisation.

    The manage permission grants the manager view, not an org-wide one: a manage
    holder sees their own weeks and the teams they manage, the same width as a team
    reviewer. Admin and system admin remain unscoped.
    """
    return selected_user_role(user) in ADMIN_ROLES


def _visible_user_ids(user: User, db: Session) -> set[int] | None:
    """User ids this person may look at, or None when that is everybody.

    Self is always included. A manager records time too, and "my team" reads as
    including the person leading it - a reviewer who sat outside every team they
    managed used to be missing from their own review matrix.
    """
    if _sees_every_employee(user):
        return None
    visible = {user.id}
    managed_ids = list(managed_team_scope_ids(db, user))
    if managed_ids:
        visible.update(
            int(row) for row in db.scalars(
                select(User.id).where(
                    User.team_id.in_(managed_ids),
                    User.is_active == 1,
                    User.deleted_at.is_(None),
                )
            ).all()
        )
    return visible


def _can_decide_for_owner(user: User, owner: User, db: Session) -> bool:
    """Whether this reviewer may approve, return, or reopen that person's week."""
    if _sees_every_employee(user):
        return True
    if owner.id == user.id:
        return True
    return owner.team_id is not None and owner.team_id in managed_team_scope_ids(db, user)


def _can_reopen(user: User, db: Session) -> bool:
    """Who may pull an approved week back to an editable state.

    Deliberately narrower than review: a team reviewer approves and returns weeks that
    are in front of them, but undoing a decision already made belongs to Manage, Admin,
    and system administrators.
    """
    if selected_user_role(user) in ADMIN_ROLES:
        return True
    return bool(_resource_permission_types(db, user) & {"manage", "admin"})


def _can_review_owner(user: User, owner_team_id: int | None, db: Session) -> bool:
    if selected_user_role(user) in ADMIN_ROLES:
        return True
    if "manage" in _resource_permission_types(db, user):
        return True
    return owner_team_id is not None and owner_team_id in managed_team_scope_ids(db, user)


def _require_owner_or_reviewer(user: User, owner: User, db: Session) -> None:
    if user.id != owner.id and not _can_review_owner(user, owner.team_id, db):
        raise HTTPException(status_code=403, detail="You cannot view this employee's weekly report.")


def _schedule_for_week(user: User, owner_id: int, week_start: date) -> list[float]:
    """Every business day is eight hours, for everyone, every week.

    Per-week overrides were removed with the schedule editor. Time away from work is
    recorded as leave hours against the standard week rather than by shrinking the
    week, so the target stays comparable between people and across weeks.
    """
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


MAX_DAILY_HOURS = 8.0


def holiday_on_date(work_date: date, holidays: list[dict[str, Any]]) -> dict[str, Any] | None:
    for holiday in holidays:
        if str(holiday.get("date")) == work_date.isoformat():
            return holiday
    return None


def day_hours_allowance(
    work_date: date,
    holidays: list[dict[str, Any]],
    scheduled_hours: float | None = None,
) -> float:
    """Most hours that may be recorded on one day.

    A holiday reduces the day rather than closing it. The week's target already
    subtracts holiday hours from the scheduled day, so a half-day holiday leaves a
    real target behind; refusing every entry on that date would leave the week unable
    to reach its own number. A holiday that consumes the whole scheduled day still
    comes out at zero, which is the ordinary full-day case.
    """
    if work_date.weekday() >= 5:
        return 0.0
    holiday = holiday_on_date(work_date, holidays)
    if holiday is None:
        return MAX_DAILY_HOURS
    scheduled = MAX_DAILY_HOURS if scheduled_hours is None else float(scheduled_hours)
    return max(0.0, min(MAX_DAILY_HOURS, round(scheduled - float(holiday.get("hours") or 0), 2)))


def _approved_time_off_days(user: User, owner_id: int, week_start: date) -> set[str]:
    """Dates in this week the owner has approved time off for."""
    result: set[str] = set()
    for _, values in _entities(user, TIME_OFF_ENTITY_TYPE):
        if int(values.get("user_id") or 0) != owner_id:
            continue
        if str(values.get("status")) != "approved":
            continue
        if str(values.get("week_start")) != week_start.isoformat():
            continue
        for index, hours in enumerate(values.get("daily_hours") or []):
            if float(hours or 0) > 0:
                result.add((week_start + timedelta(days=index)).isoformat())
    return result


def ensure_entry_type_allowed_on_day(
    work_date: date,
    entry_type: str,
    time_off_days: set[str],
) -> None:
    """A day taken off holds leave and nothing else.

    The eight-hour cap already leaves no room once the approved leave is written, but
    that is arithmetic rather than intent: this says plainly that the day is off, so
    the refusal reads as a rule instead of a full-day error.
    """
    if work_date.isoformat() in time_off_days and entry_type != "leave":
        raise HTTPException(
            status_code=409,
            detail=f"{work_date.isoformat()} is approved time off; only leave can be recorded on it.",
        )


def ensure_work_date_is_enterable(
    work_date: date,
    holidays: list[dict[str, Any]],
    scheduled_hours: float | None = None,
) -> None:
    """Reject dates no time may be recorded on: weekends and fully-observed holidays."""
    if work_date.weekday() >= 5:
        raise HTTPException(
            status_code=409, detail="Time entries cannot be added on Saturdays or Sundays."
        )
    if day_hours_allowance(work_date, holidays, scheduled_hours) <= 0:
        raise HTTPException(status_code=409, detail="Time entries cannot be added on a holiday.")


def ensure_daily_hours_within_limit(
    user: User,
    submission_id: str,
    work_date: date,
    new_hours: float,
    exclude_entry_id: str | None = None,
    allowance: float | None = None,
) -> None:
    """A day holds at most eight hours across every entry type combined.

    On a part-day holiday the ceiling drops to what the holiday left behind, so the
    recorded hours can never exceed that day's own target.
    """
    limit = MAX_DAILY_HOURS if allowance is None else float(allowance)
    existing = round(
        sum(
            float(values.get("hours") or 0)
            for _, values in _entities(user, ENTRY_ENTITY_TYPE)
            if str(values.get("submission_id")) == submission_id
            and str(values.get("work_date")) == work_date.isoformat()
            and str(values.get("entry_id")) != (exclude_entry_id or "")
        ),
        2,
    )
    if round(existing + new_hours, 2) > limit:
        raise HTTPException(
            status_code=409,
            detail=(
                f"A day can hold at most {limit:g} hours; "
                f"{work_date.isoformat()} already has {existing:g} recorded."
            ),
        )


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
    time_off_days = _approved_time_off_days(user, owner.id, week_start)
    for day in schedule_days:
        day["time_off"] = str(day["date"]) in time_off_days
    reported_hours = round(sum(float(entry.get("hours") or 0) for entry in entries), 2)
    field_hours = round(
        sum(float(entry.get("hours") or 0) for entry in entries if entry.get("entry_type") == "field_work"),
        2,
    )
    time_off_requests = [
        dict(values)
        for _, values in _entities(user, TIME_OFF_ENTITY_TYPE)
        if int(values.get("user_id") or 0) == owner.id
        and str(values.get("week_start")) == week_start.isoformat()
    ]
    time_off_requests.sort(key=lambda item: str(item.get("created_at")), reverse=True)
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
        "time_off_requests": time_off_requests,
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
            # Matches what review_submission actually enforces, so the Approve and
            # Return buttons never appear on a week the server would refuse.
            "can_review": status == REVIEWABLE_STATUS and bool(resource_permissions & {"review", "manage", "admin"}) and _can_decide_for_owner(user, owner, db),
            "can_request_schedule_change": own_report and bool(resource_permissions & {"create", "edit", "manage", "admin"}),
            # There is no approval round trip for schedules any more, so people set
            # their own target on a week they can still edit; every change is written
            # to the workflow history, which is where a manager audits it. Manage and
            # Admin keep the wider right, including on a week already submitted and
            # on the weeks of people they review.
            "can_set_schedule": (
                own_report and status in EDITABLE_STATUSES and bool(resource_permissions & {"edit", "manage", "admin"})
            )
            or (
                bool(resource_permissions & {"manage", "admin"})
                and (own_report or _can_review_owner(user, owner.team_id, db))
            ),
        },
    }


INSIGHTS_WEEKS = 12
# Only weeks that reached the manager count: drafts and returned weeks are unfinished.
INSIGHTS_COUNTED_STATUSES = {"submitted", "approved"}
INSIGHTS_RANGES = ("12w", "6m", "ytd", "year", "all", "custom")


def _parse_insights_date(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"{field} must use YYYY-MM-DD format.") from error


def _insights_window(
    anchor_week: date,
    window: str,
    year: int | None,
    start: str | None = None,
    end: str | None = None,
) -> tuple[date, date, str]:
    """Return (first day, last day, bucket size) for a requested range.

    Long ranges bucket by month or year so the matrix stays a readable width instead
    of spilling into fifty-two week columns.
    """
    week_end = anchor_week + timedelta(days=6)
    if window == "12w":
        return anchor_week - timedelta(days=7 * (INSIGHTS_WEEKS - 1)), week_end, "week"
    if window == "6m":
        first = anchor_week - timedelta(days=7 * 25)
        return first, week_end, "month"
    if window == "ytd":
        return date(anchor_week.year, 1, 1), week_end, "month"
    if window == "year":
        chosen = year or anchor_week.year
        return date(chosen, 1, 1), date(chosen, 12, 31), "month"
    if window == "custom":
        if not start or not end:
            raise HTTPException(status_code=422, detail="A custom range needs a start and end date.")
        first = _parse_insights_date(start, "start")
        last = _parse_insights_date(end, "end")
        if last < first:
            raise HTTPException(status_code=422, detail="The end date must not precede the start date.")
        span_days = (last - first).days
        # Keep the matrix a readable width: weeks for a short span, months for a
        # few years, years beyond that.
        bucket = "week" if span_days <= 120 else ("month" if span_days <= 1100 else "year")
        return first, last, bucket
    return date(2000, 1, 1), week_end, "year"


def _bucket_key(week_start_value: date, bucket: str) -> tuple[str, str]:
    if bucket == "week":
        return week_start_value.isoformat(), week_start_value.isoformat()[5:]
    if bucket == "month":
        return week_start_value.strftime("%Y-%m"), week_start_value.strftime("%b %Y")
    return week_start_value.strftime("%Y"), week_start_value.strftime("%Y")


@router.get("/api/reports/weekly-time/insights")
def weekly_insights(
    week_start: str,
    scope: str = "self",
    window: str = "12w",
    year: int | None = None,
    start: str | None = None,
    end: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Hours by entry type over a chosen range, bucketed by week, month, or year.

    Everyone may chart their own hours; the everyone-wide scope is a management view
    and is enforced here rather than hidden in the client.
    """
    permissions = _require_resource_permission(
        db, current_user, "view", "edit", "review", "create", "delete", "manage", "admin"
    )
    can_view_all = bool(permissions & {"manage", "admin"})
    # "All" is bounded by the same roster as the review matrix, so a manager charts
    # their team rather than the organisation.
    visible_ids = _visible_user_ids(current_user, db)
    if scope not in ("self", "all"):
        raise HTTPException(status_code=422, detail="scope must be self or all.")
    if scope == "all" and not can_view_all:
        raise HTTPException(status_code=403, detail="Viewing everyone's hours requires Manage permission.")
    if window not in INSIGHTS_RANGES:
        raise HTTPException(status_code=422, detail=f"window must be one of {', '.join(INSIGHTS_RANGES)}.")

    anchor_week = parse_week_start(week_start)
    first_day, last_day, bucket = _insights_window(anchor_week, window, year, start, end)

    submissions: dict[str, dict[str, Any]] = {}
    counted_years: set[int] = set()
    for _, values in _entities(current_user, SUBMISSION_ENTITY_TYPE):
        if str(values.get("status")) not in INSIGHTS_COUNTED_STATUSES:
            continue
        owner_id = int(values.get("user_id") or 0)
        if scope == "self" and owner_id != current_user.id:
            continue
        if scope == "all" and visible_ids is not None and owner_id not in visible_ids:
            continue
        try:
            submission_week = date.fromisoformat(str(values.get("week_start")))
        except ValueError:
            continue
        counted_years.add(submission_week.year)
        if submission_week < first_day or submission_week > last_day:
            continue
        submissions[str(values.get("submission_id"))] = values

    ordered_keys: list[tuple[str, str]] = []
    seen_keys: set[str] = set()
    cursor = first_day if bucket != "week" else first_day - timedelta(days=first_day.weekday())
    while cursor <= last_day:
        key, label = _bucket_key(cursor, bucket)
        if key not in seen_keys:
            seen_keys.add(key)
            ordered_keys.append((key, label))
        if bucket == "week":
            cursor += timedelta(days=7)
        elif bucket == "month":
            cursor = date(cursor.year + (cursor.month == 12), (cursor.month % 12) + 1, 1)
        else:
            cursor = date(cursor.year + 1, 1, 1)

    bucket_totals: dict[str, dict[str, float]] = {key: {} for key, _ in ordered_keys}
    people: dict[int, dict[str, Any]] = {}
    used_types: set[str] = set()
    for _, values in _entities(current_user, ENTRY_ENTITY_TYPE):
        submission = submissions.get(str(values.get("submission_id")))
        if submission is None:
            continue
        try:
            submission_week = date.fromisoformat(str(submission.get("week_start")))
        except ValueError:
            continue
        key, _label = _bucket_key(submission_week, bucket)
        type_key = str(values.get("entry_type") or "other")
        hours = float(values.get("hours") or 0)
        used_types.add(type_key)
        totals = bucket_totals.setdefault(key, {})
        totals[type_key] = totals.get(type_key, 0.0) + hours
        if scope == "all":
            person = people.setdefault(
                int(submission.get("user_id") or 0),
                {
                    "name": str(submission.get("employee_name") or submission.get("employee_id") or "Unknown"),
                    "team": submission.get("team_name"),
                    "totals": {},
                    "total": 0.0,
                },
            )
            person["totals"][type_key] = person["totals"].get(type_key, 0.0) + hours
            person["total"] = round(person["total"] + hours, 2)

    labels = {item.item_code: item.label for item in _entry_types(db, include_inactive=True)}
    entry_types = [
        {"key": key, "label": labels.get(key, key.replace("_", " ").title())}
        for key in sorted(used_types, key=lambda key: labels.get(key, key))
    ]
    return {
        "scope": scope,
        "window": window,
        "bucket": bucket,
        "start": first_day.isoformat(),
        "end": last_day.isoformat(),
        "year": year or anchor_week.year,
        "available_years": sorted(counted_years, reverse=True),
        "can_view_all": can_view_all,
        "entry_types": entry_types,
        "buckets": [
            {
                "key": key,
                "label": label,
                "totals": {name: round(total, 2) for name, total in bucket_totals.get(key, {}).items()},
                "total": round(sum(bucket_totals.get(key, {}).values()), 2),
            }
            for key, label in ordered_keys
        ],
        "people": sorted(
            (
                {**person, "totals": {key: round(total, 2) for key, total in person["totals"].items()}}
                for person in people.values()
            ),
            key=lambda person: -float(person["total"]),
        ),
    }


@router.get("/api/reports/weekly-time/insights/export")
def export_weekly_insights(
    week_start: str,
    scope: str = "self",
    window: str = "12w",
    year: int | None = None,
    start: str | None = None,
    end: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The insights matrix as a styled workbook, matching what the page shows."""
    insights = weekly_insights(
        week_start=week_start,
        scope=scope,
        window=window,
        year=year,
        start=start,
        end=end,
        current_user=current_user,
        db=db,
    )
    buckets = insights["buckets"]
    entry_types = insights["entry_types"]
    active_buckets = max(1, sum(1 for bucket in buckets if bucket["total"] > 0))

    columns = [ExcelColumn("work_type", "Work type", 26)]
    columns.extend(
        ExcelColumn(f"bucket_{bucket['key']}", str(bucket["label"]), 13, "number")
        for bucket in buckets
    )
    columns.append(ExcelColumn("row_total", "Total", 12, "number"))
    columns.append(ExcelColumn("row_average", "Average", 12, "number"))

    rows: list[dict[str, Any]] = []
    for entry_type in entry_types:
        values = [float(bucket["totals"].get(entry_type["key"], 0) or 0) for bucket in buckets]
        row: dict[str, Any] = {"work_type": entry_type["label"]}
        for bucket, value in zip(buckets, values):
            row[f"bucket_{bucket['key']}"] = value or None
        row["row_total"] = round(sum(values), 2)
        row["row_average"] = round(sum(values) / active_buckets, 2)
        rows.append(row)
    total_row: dict[str, Any] = {"work_type": "Period total"}
    for bucket in buckets:
        total_row[f"bucket_{bucket['key']}"] = float(bucket["total"]) or None
    total_row["row_total"] = round(sum(float(bucket["total"]) for bucket in buckets), 2)
    rows.append(total_row)

    scope_label = "Everyone" if insights["scope"] == "all" else "My hours"
    sheets = [
        ExcelSheet(
            name="Hours by work type",
            title="Weekly time by work type",
            columns=columns,
            rows=rows,
            filters={
                "Scope": scope_label,
                "Range": f"{insights['start']} to {insights['end']}",
                "Bucket": str(insights["bucket"]).title(),
                "Included": "Submitted and approved weeks only",
            },
        )
    ]
    if insights["people"]:
        people_columns = [
            ExcelColumn("name", "Person", 26),
            ExcelColumn("team", "Team", 22),
            *(ExcelColumn(f"type_{item['key']}", str(item["label"]), 14, "number") for item in entry_types),
            ExcelColumn("total", "Total", 12, "number"),
        ]
        people_rows = [
            {
                "name": person["name"],
                "team": person["team"],
                **{
                    f"type_{item['key']}": float(person["totals"].get(item["key"], 0) or 0) or None
                    for item in entry_types
                },
                "total": float(person["total"]),
            }
            for person in insights["people"]
        ]
        sheets.append(
            ExcelSheet(name="By person", title="Hours by person", columns=people_columns, rows=people_rows)
        )

    content = build_portal_excel_workbook(
        report_title="Weekly Time Insights",
        sheets=sheets,
        exported_by=f"{_display_name(current_user)} ({current_user.employee_id})",
    )
    filename = f"Weekly-Time-Insights-{insights['start']}-to-{insights['end']}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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
    holidays = _holidays_for_week(current_user, week_start)
    schedule = _schedule_for_week(current_user, current_user.id, week_start)
    scheduled_today = schedule[work_date.weekday()]
    ensure_work_date_is_enterable(work_date, holidays, scheduled_today)
    ensure_entry_type_allowed_on_day(
        work_date,
        entry_type.item_code,
        _approved_time_off_days(current_user, current_user.id, week_start),
    )
    found = _find_submission(current_user, owner_user_id=current_user.id, week_start=week_start)
    submission_entity, submission = found if found else (None, _submission_values(current_user, week_start))
    if str(submission.get("status")) not in EDITABLE_STATUSES:
        raise HTTPException(status_code=409, detail=LOCKED_WEEK_DETAIL)
    entry_hours = calculate_entry_hours(payload.hours, payload.start_time, payload.end_time)
    ensure_daily_hours_within_limit(
        current_user,
        str(submission["submission_id"]),
        work_date,
        entry_hours,
        allowance=day_hours_allowance(work_date, holidays, scheduled_today),
    )
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
        "hours": entry_hours,
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
    holidays = _holidays_for_week(current_user, week_start)
    schedule = _schedule_for_week(current_user, current_user.id, week_start)
    scheduled_today = schedule[work_date.weekday()]
    ensure_work_date_is_enterable(work_date, holidays, scheduled_today)
    time_off_days = _approved_time_off_days(current_user, current_user.id, week_start)
    entity = _coordinator(current_user).get_entity(ENTRY_ENTITY_TYPE, entry_id)
    values = _entity_values(entity)
    if not entity or not values or int(values.get("user_id") or 0) != current_user.id:
        raise HTTPException(status_code=404, detail="Time entry was not found.")
    found = _find_submission(current_user, submission_id=str(values.get("submission_id")))
    if not found or str(found[1].get("status")) not in EDITABLE_STATUSES:
        raise HTTPException(status_code=409, detail=LOCKED_WEEK_DETAIL)
    requested_entry_type = payload.entry_type.strip().lower()
    ensure_entry_type_allowed_on_day(work_date, requested_entry_type, time_off_days)
    if requested_entry_type != str(values.get("entry_type") or ""):
        _require_active_entry_type(db, requested_entry_type)
    entry_hours = calculate_entry_hours(payload.hours, payload.start_time, payload.end_time)
    ensure_daily_hours_within_limit(
        current_user,
        str(values.get("submission_id")),
        work_date,
        entry_hours,
        exclude_entry_id=entry_id,
        allowance=day_hours_allowance(work_date, holidays, scheduled_today),
    )
    values.update(
        {
            "entry_type": requested_entry_type,
            "work_date": work_date.isoformat(),
            "hours": entry_hours,
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


class GridCell(BaseModel):
    work_date: str
    entry_type: str
    hours: float


class GridSaveRequest(BaseModel):
    week_start: str
    cells: list[GridCell]


@router.put("/api/reports/weekly-time/entries/grid")
def save_week_grid(
    payload: GridSaveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Save a whole week of time from one work-type by day grid.

    Each cell is the total hours for one work type on one day. A cell backed by a
    single entry is updated in place, an emptied cell deletes it, and a new value
    creates one. Cells already holding several entries (each with its own note or
    time span) are refused rather than silently collapsed into one row - those stay
    editable per entry on My week.
    """
    _require_resource_permission(db, current_user, "edit", "create", "manage", "admin")
    week_start = parse_week_start(payload.week_start)
    found = _find_submission(current_user, owner_user_id=current_user.id, week_start=week_start)
    submission_entity, submission = found if found else (None, _submission_values(current_user, week_start))
    if str(submission.get("status")) not in EDITABLE_STATUSES:
        raise HTTPException(status_code=409, detail=LOCKED_WEEK_DETAIL)
    submission_id = str(submission["submission_id"])
    holidays = _holidays_for_week(current_user, week_start)
    schedule = _schedule_for_week(current_user, current_user.id, week_start)
    time_off_days = _approved_time_off_days(current_user, current_user.id, week_start)

    existing: dict[tuple[str, str], list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for entity, values in _entities(current_user, ENTRY_ENTITY_TYPE):
        if str(values.get("submission_id")) != submission_id:
            continue
        key = (str(values.get("work_date")), str(values.get("entry_type")))
        existing.setdefault(key, []).append((entity, values))

    requested: dict[tuple[str, str], float] = {}
    for cell in payload.cells:
        work_date = parse_work_date(cell.work_date, week_start)
        hours = round(float(cell.hours or 0), 2)
        entry_type = cell.entry_type.strip().lower()
        if hours < 0:
            raise HTTPException(status_code=400, detail="Hours cannot be negative.")
        if hours:
            ensure_work_date_is_enterable(work_date, holidays, schedule[work_date.weekday()])
            ensure_entry_type_allowed_on_day(work_date, entry_type, time_off_days)
            _require_active_entry_type(db, entry_type)
        requested[(work_date.isoformat(), entry_type)] = hours

    daily_totals: dict[str, float] = {}
    for (work_date_text, _type), hours in requested.items():
        daily_totals[work_date_text] = round(daily_totals.get(work_date_text, 0.0) + hours, 2)
    # Days the grid does not mention keep whatever they already hold.
    for (work_date_text, entry_type), rows in existing.items():
        if (work_date_text, entry_type) in requested:
            continue
        daily_totals[work_date_text] = round(
            daily_totals.get(work_date_text, 0.0)
            + sum(float(values.get("hours") or 0) for _entity, values in rows),
            2,
        )
    for work_date_text, total in daily_totals.items():
        day = date.fromisoformat(work_date_text)
        limit = day_hours_allowance(day, holidays, schedule[day.weekday()])
        if total > limit:
            raise HTTPException(
                status_code=409,
                detail=f"{work_date_text} totals {total:g} hours; a day can hold at most {limit:g}.",
            )

    now = utc_now_text()
    mutations: list[Mutation] = []
    created = updated = removed = 0
    for key, hours in requested.items():
        work_date_text, entry_type = key
        rows = existing.get(key, [])
        current_total = round(sum(float(values.get("hours") or 0) for _entity, values in rows), 2)
        if len(rows) > 1:
            if abs(current_total - hours) > 0.001:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"{work_date_text} has several {entry_type} entries; edit them individually "
                        "on My week instead of in the grid."
                    ),
                )
            continue
        if not rows:
            if not hours:
                continue
            entry_id = str(uuid.uuid4())
            mutations.append(
                Mutation(
                    entity_type=ENTRY_ENTITY_TYPE,
                    entity_id=entry_id,
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values={
                        "entry_id": entry_id,
                        "submission_id": submission_id,
                        "user_id": current_user.id,
                        "employee_id": current_user.employee_id,
                        "entry_type": entry_type,
                        "work_date": work_date_text,
                        "hours": hours,
                        "start_time": None,
                        "end_time": None,
                        "notes": None,
                        "created_at": now,
                        "updated_at": now,
                    },
                )
            )
            created += 1
            continue
        entity, values = rows[0]
        if not hours:
            mutations.append(
                Mutation(
                    entity_type=ENTRY_ENTITY_TYPE,
                    entity_id=str(entity["entity_id"]),
                    operation_type="delete_entity",
                    base_record_revision=str(entity["record_revision"]),
                )
            )
            removed += 1
            continue
        if abs(current_total - hours) < 0.001:
            continue
        mutations.append(
            Mutation(
                entity_type=ENTRY_ENTITY_TYPE,
                entity_id=str(entity["entity_id"]),
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values={
                    **values,
                    "hours": hours,
                    # A typed total no longer matches a clock span, so clear it.
                    "start_time": None,
                    "end_time": None,
                    "updated_at": now,
                },
            )
        )
        updated += 1

    if mutations:
        submission["updated_at"] = now
        mutations.insert(
            0,
            Mutation(
                entity_type=SUBMISSION_ENTITY_TYPE,
                entity_id=submission_id,
                operation_type="update_entity" if submission_entity else "insert_entity",
                base_record_revision=str(submission_entity["record_revision"]) if submission_entity else None,
                values=submission,
                unique_lock_keys=(f"weekly:{current_user.id}:{week_start.isoformat()}",),
            ),
        )
        _commit(current_user, mutations)
    return {
        "context": _context_for(current_user, current_user, week_start, db),
        "created": created,
        "updated": updated,
        "removed": removed,
    }


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
    skipped_limited = 0
    daily_totals: dict[str, float] = {}
    for values in target_entries:
        key = str(values.get("work_date") or "")
        daily_totals[key] = daily_totals.get(key, 0.0) + float(values.get("hours") or 0)
    mutations: list[Mutation] = []

    for source in source_entries:
        try:
            source_date = date.fromisoformat(str(source.get("work_date")))
        except ValueError:
            continue
        target_date = source_date + timedelta(days=7)
        if target_date.weekday() >= 5 or target_date.isoformat() in holiday_dates:
            skipped_holidays += 1
            continue
        source_hours = float(source.get("hours") or 0)
        running = daily_totals.get(target_date.isoformat(), 0.0)
        if round(running + source_hours, 2) > MAX_DAILY_HOURS:
            skipped_limited += 1
            continue
        daily_totals[target_date.isoformat()] = running + source_hours
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
                memo=(
                    f"{copied} entries copied; {skipped_holidays} holidays/weekends, "
                    f"{skipped_duplicates} duplicates, and {skipped_limited} over the "
                    f"{MAX_DAILY_HOURS:g}-hour day limit skipped."
                ),
            )
        )
        _commit(current_user, mutations)

    return {
        "context": _context_for(current_user, current_user, week_start, db),
        "copied": copied,
        "skipped_holidays": skipped_holidays,
        "skipped_duplicates": skipped_duplicates,
        "skipped_limited": skipped_limited,
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
        raise HTTPException(status_code=409, detail=LOCKED_WEEK_DETAIL)
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
            # The registry maps this to seven REAL columns, so it stores the per-day
            # target hours; schedule_days itself is a richer per-day dict for the UI.
            "submitted_schedule_days": [float(day["target_hours"]) for day in schedule_days],
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
    status: str = "submitted",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_resource_permission(db, current_user, "review", "manage", "admin")
    if not _can_review(current_user, db):
        raise HTTPException(status_code=403, detail="Manager review access is required.")
    visible = _visible_user_ids(current_user, db)
    wanted = {item.strip() for item in status.split(",") if item.strip()} if status != "all" else None
    submissions = []
    for _, values in _entities(current_user, SUBMISSION_ENTITY_TYPE):
        row_status = str(values.get("status") or "draft")
        if wanted is not None and row_status not in wanted:
            continue
        # A draft nobody has sent in is not a reviewer's business at any filter.
        if row_status == "draft":
            continue
        if visible is None or int(values.get("user_id") or 0) in visible:
            submissions.append(dict(values))
    submissions.sort(
        key=lambda item: str(item.get("submitted_at") or item.get("updated_at") or ""),
        reverse=True,
    )
    time_off_requests = []
    for _, values in _entities(current_user, TIME_OFF_ENTITY_TYPE):
        if str(values.get("status")) != "pending":
            continue
        if visible is None or int(values.get("user_id") or 0) in visible:
            time_off_requests.append(dict(values))
    time_off_requests.sort(key=lambda item: str(item.get("created_at")), reverse=True)
    return {
        "submissions": submissions,
        "time_off_requests": time_off_requests,
        "can_reopen": _can_reopen(current_user, db),
    }


REVIEW_MATRIX_MAX_WEEKS = 26


def _reviewable_people(current_user: User, db: Session) -> tuple[list[User], bool]:
    """Everyone whose weeks this reviewer may see, plus whether that is everyone.

    The roster is the point of the matrix: a person with no submission at all has no
    row in the operation log, so they can only appear if the people come from the
    directory rather than from the weeks themselves. Without this, "who has not
    turned theirs in" stays unanswerable.
    """
    everyone = _sees_every_employee(current_user)
    query = select(User).where(User.is_active == 1, User.deleted_at.is_(None))
    if not everyone:
        managed_ids = list(managed_team_scope_ids(db, current_user))
        condition = User.id == current_user.id
        if managed_ids:
            condition = or_(condition, User.team_id.in_(managed_ids))
        query = query.where(condition)
    people = list(db.scalars(query).all())
    people.sort(key=lambda item: _display_name(item).lower())
    return people, everyone


@router.get("/api/reports/weekly-time/review-matrix")
def review_matrix(
    end_week: str | None = None,
    weeks: int = 12,
    people: str | None = None,
    team_id: int | None = None,
    status: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """People down, weeks across, one cell per person-week.

    Bounded by design: the old queue listed every submission ever recorded and filtered
    in Python, which grows without limit. This walks a fixed window of at most
    REVIEW_MATRIX_MAX_WEEKS columns and never returns more than the roster in scope.
    """
    _require_resource_permission(db, current_user, "review", "manage", "admin")
    if not _can_review(current_user, db):
        raise HTTPException(status_code=403, detail="Manager review access is required.")
    span = max(1, min(int(weeks or 12), REVIEW_MATRIX_MAX_WEEKS))
    today = date.today()
    last_week = parse_week_start(end_week) if end_week else today - timedelta(days=today.weekday())
    first_week = last_week - timedelta(days=7 * (span - 1))
    week_starts = [first_week + timedelta(days=7 * index) for index in range(span)]
    window = {week.isoformat() for week in week_starts}

    roster, _admin = _reviewable_people(current_user, db)
    if team_id is not None:
        roster = [person for person in roster if person.team_id == team_id]
    if people:
        wanted_ids = {int(value) for value in people.split(",") if value.strip().isdigit()}
        roster = [person for person in roster if person.id in wanted_ids]
    roster_ids = {person.id: person for person in roster}

    cells: dict[int, dict[str, dict[str, Any]]] = {person_id: {} for person_id in roster_ids}
    in_window: dict[str, tuple[int, str]] = {}
    for _, values in _entities(current_user, SUBMISSION_ENTITY_TYPE):
        week_text = str(values.get("week_start") or "")
        owner_id = int(values.get("user_id") or 0)
        if week_text not in window or owner_id not in roster_ids:
            continue
        submission_id = str(values.get("submission_id"))
        in_window[submission_id] = (owner_id, week_text)
        cells[owner_id][week_text] = {
            "submission_id": submission_id,
            "status": str(values.get("status") or "draft"),
            "target_hours": float(values.get("submitted_target_hours") or 0) or None,
            "hours": 0.0,
            "submitted_at": values.get("submitted_at"),
        }

    # Recorded hours are not stored on the submission, so they are totalled from the
    # entries of the weeks in this window only.
    for _, values in _entities(current_user, ENTRY_ENTITY_TYPE):
        placement = in_window.get(str(values.get("submission_id")))
        if placement is None:
            continue
        owner_id, week_text = placement
        cells[owner_id][week_text]["hours"] += float(values.get("hours") or 0)
    for person_cells in cells.values():
        for cell in person_cells.values():
            cell["hours"] = round(cell["hours"], 2) or None

    wanted_status = {item.strip() for item in status.split(",") if item.strip()} if status else None
    rows = []
    for person in roster:
        person_cells = cells[person.id]
        if wanted_status is not None and not any(
            cell["status"] in wanted_status for cell in person_cells.values()
        ):
            continue
        rows.append(
            {
                "user_id": person.id,
                "name": _display_name(person),
                "employee_id": person.employee_id,
                "team_id": person.team_id,
                "team_name": person.team.name if person.team else None,
                "cells": person_cells,
            }
        )

    counts: dict[str, int] = {}
    for row in rows:
        for cell in row["cells"].values():
            counts[cell["status"]] = counts.get(cell["status"], 0) + 1
    missing = sum(len(window) - len(row["cells"]) for row in rows)

    teams: dict[int, str] = {}
    for person in roster:
        if person.team_id and person.team:
            teams[person.team_id] = person.team.name
    all_people, _ = _reviewable_people(current_user, db)
    return {
        "weeks": [
            {
                "week_start": week.isoformat(),
                "week_end": (week + timedelta(days=6)).isoformat(),
            }
            for week in week_starts
        ],
        "rows": rows,
        "counts": {**counts, "not_submitted": missing},
        "teams": [{"team_id": key, "name": value} for key, value in sorted(teams.items(), key=lambda item: item[1])],
        "people": [
            {"user_id": person.id, "name": _display_name(person), "team_id": person.team_id}
            for person in all_people
        ],
        "end_week": last_week.isoformat(),
        "weeks_shown": span,
        "max_weeks": REVIEW_MATRIX_MAX_WEEKS,
        "can_reopen": _can_reopen(current_user, db),
    }


class BulkReviewRequest(BaseModel):
    submission_ids: list[str]
    action: Literal["approve", "return", "reopen"]
    comments: str | None = None


@router.post("/api/reports/weekly-time/submissions/bulk-review")
def bulk_review_submissions(
    payload: BulkReviewRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Decide a column of the matrix in one pass.

    Every submission is checked individually and one that fails is reported by name
    rather than aborting the batch: a manager selecting a whole week should not lose
    the other thirteen approvals because one person's week moved underneath them.
    """
    _require_resource_permission(db, current_user, "review", "manage", "admin")
    comments = (payload.comments or "").strip()
    if payload.action != "approve" and not comments:
        raise HTTPException(status_code=400, detail="Comments are required for this action.")
    if payload.action == "reopen" and not _can_reopen(current_user, db):
        raise HTTPException(
            status_code=403, detail="Only a manager or administrator can reopen an approved week."
        )
    now = utc_now_text()
    mutations: list[Mutation] = []
    done: list[str] = []
    skipped: list[str] = []
    for submission_id in dict.fromkeys(payload.submission_ids):
        found = _find_submission(current_user, submission_id=submission_id)
        if not found:
            skipped.append(f"{submission_id}: not found")
            continue
        entity, submission = found
        owner = get_user_or_404(db, int(submission["user_id"]))
        label = f"{_display_name(owner)} {submission.get('week_start')}"
        if not _can_decide_for_owner(current_user, owner, db):
            skipped.append(f"{label}: outside your review scope")
            continue
        from_status = str(submission.get("status") or "draft")
        if payload.action == "reopen":
            if from_status != REOPENABLE_STATUS:
                skipped.append(f"{label}: not approved")
                continue
        elif from_status != REVIEWABLE_STATUS:
            skipped.append(f"{label}: not waiting on review")
            continue
        to_status = "approved" if payload.action == "approve" else "returned"
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
        mutations.append(
            Mutation(
                entity_type=SUBMISSION_ENTITY_TYPE,
                entity_id=submission_id,
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values=submission,
            )
        )
        mutations.append(
            _event_mutation(
                current_user,
                subject_user_id=owner.id,
                submission_id=submission_id,
                event_type=(
                    "week_reopened"
                    if payload.action == "reopen"
                    else "week_approved" if to_status == "approved" else "week_returned"
                ),
                week_start=str(submission["week_start"]),
                from_status=from_status,
                to_status=to_status,
                memo=comments,
            )
        )
        done.append(label)
    if mutations:
        _commit(current_user, mutations)
    return {"changed": len(done), "skipped": skipped}


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
    if not _can_decide_for_owner(current_user, owner, db):
        raise HTTPException(status_code=403, detail="You cannot review this employee's week.")
    from_status = str(submission.get("status") or "draft")
    comments = (payload.comments or "").strip()
    if payload.action == "reopen":
        # Undoing an approval, so it takes the wider permission and says why.
        if not _can_reopen(current_user, db):
            raise HTTPException(
                status_code=403,
                detail="Only a manager or administrator can reopen an approved week.",
            )
        if from_status != REOPENABLE_STATUS:
            raise HTTPException(status_code=409, detail="Only approved weeks can be reopened.")
        if not comments:
            raise HTTPException(status_code=400, detail="Say why the week is being reopened.")
    elif from_status != REVIEWABLE_STATUS:
        raise HTTPException(status_code=409, detail="Only submitted weeks can be reviewed.")
    elif payload.action == "return" and not comments:
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
                event_type=(
                    "week_reopened"
                    if payload.action == "reopen"
                    else "week_approved" if to_status == "approved" else "week_returned"
                ),
                week_start=str(submission["week_start"]),
                from_status=from_status,
                to_status=to_status,
                memo=comments,
            ),
        ],
    )
    return _context_for(current_user, owner, parse_week_start(str(submission["week_start"])), db)


def _time_off_row(owner: User, week_start: date, daily_hours: list[float], reason: str) -> dict[str, Any]:
    now = utc_now_text()
    return {
        "request_id": str(uuid.uuid4()),
        "user_id": owner.id,
        "employee_id": owner.employee_id,
        "employee_name": _display_name(owner),
        "team_id": owner.team_id,
        "team_name": owner.team.name if owner.team else None,
        "week_start": week_start.isoformat(),
        "week_end": (week_start + timedelta(days=6)).isoformat(),
        "reason": reason,
        "daily_hours": daily_hours,
        "status": "pending",
        "created_at": now,
        "updated_at": now,
        "submitted_at": now,
        "reviewed_at": None,
        "reviewed_by_user_id": None,
        "reviewed_by_name": None,
        "review_comments": None,
    }


@router.post("/api/reports/weekly-time/time-off")
def request_time_off(
    payload: TimeOffRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Ask for paid time off across a range of business days.

    Stored one row per week because that is the shape the record has, so a range that
    straddles a Monday becomes two requests the manager sees together. Weekends and
    holidays drop out of the range rather than rejecting it: asking for "next week
    off" should not fail because the range contains a Saturday.
    """
    _require_resource_permission(db, current_user, "create", "edit", "manage", "admin")
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Say what the time off is for.")
    try:
        first = date.fromisoformat(payload.start_date)
        last = date.fromisoformat(payload.end_date)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Dates must use YYYY-MM-DD format.") from error
    if last < first:
        raise HTTPException(status_code=400, detail="The end date must not precede the start date.")
    if (last - first).days > 180:
        raise HTTPException(status_code=400, detail="Request at most six months at a time.")
    by_week: dict[date, list[float]] = {}
    working_days = 0
    cursor = first
    while cursor <= last:
        week_start = cursor - timedelta(days=cursor.weekday())
        allowance = day_hours_allowance(
            cursor, _holidays_for_week(current_user, week_start), DEFAULT_DAILY_HOURS[cursor.weekday()]
        )
        if allowance > 0:
            days = by_week.setdefault(week_start, [0.0] * 7)
            # A day off is the whole scheduled day; a part-day holiday leaves less.
            days[cursor.weekday()] = allowance
            working_days += 1
        cursor += timedelta(days=1)
    if not by_week:
        raise HTTPException(
            status_code=400,
            detail="That range has no working days - it is all weekends and holidays.",
        )

    existing_weeks = {
        str(values.get("week_start"))
        for _, values in _entities(current_user, TIME_OFF_ENTITY_TYPE)
        if int(values.get("user_id") or 0) == current_user.id
        and str(values.get("status")) in ("pending", "approved")
    }
    mutations: list[Mutation] = []
    for week_start, daily_hours in sorted(by_week.items()):
        if week_start.isoformat() in existing_weeks:
            raise HTTPException(
                status_code=409,
                detail=(
                    "You already have a time-off request covering the week of "
                    f"{week_start.isoformat()}. Withdraw it before asking again."
                ),
            )
        row = _time_off_row(current_user, week_start, daily_hours, reason)
        mutations.append(
            Mutation(
                entity_type=TIME_OFF_ENTITY_TYPE,
                entity_id=row["request_id"],
                operation_type="insert_entity",
                base_record_revision=None,
                values=row,
                unique_lock_keys=(f"weekly-timeoff:{current_user.id}:{week_start.isoformat()}",),
            )
        )
        mutations.append(
            _event_mutation(
                current_user,
                subject_user_id=current_user.id,
                submission_id=None,
                event_type="time_off_requested",
                week_start=week_start,
                from_status=None,
                to_status="pending",
                memo=f"{round(sum(daily_hours), 2):g}h of time off requested: {reason}",
            )
        )
    _commit(current_user, mutations)
    return {
        "weeks": len(by_week),
        "working_days": working_days,
        "context": _context_for(current_user, current_user, first - timedelta(days=first.weekday()), db),
    }


@router.post("/api/reports/weekly-time/time-off/{request_id}/withdraw")
def withdraw_time_off(
    request_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Take back a request that has not been decided yet."""
    _require_resource_permission(db, current_user, "create", "edit", "manage", "admin")
    entity = _coordinator(current_user).get_entity(TIME_OFF_ENTITY_TYPE, request_id)
    values = _entity_values(entity)
    if not entity or not values or int(values.get("user_id") or 0) != current_user.id:
        raise HTTPException(status_code=404, detail="Time-off request was not found.")
    if str(values.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Only a pending request can be withdrawn.")
    week_start = parse_week_start(str(values["week_start"]))
    _commit(
        current_user,
        [
            Mutation(
                entity_type=TIME_OFF_ENTITY_TYPE,
                entity_id=request_id,
                operation_type="delete_entity",
                base_record_revision=str(entity["record_revision"]),
            ),
            _event_mutation(
                current_user,
                subject_user_id=current_user.id,
                submission_id=None,
                event_type="time_off_withdrawn",
                week_start=week_start,
                from_status="pending",
                to_status=None,
                memo=None,
            ),
        ],
    )
    return _context_for(current_user, current_user, week_start, db)


@router.post("/api/reports/weekly-time/time-off/{request_id}/review")
def review_time_off(
    request_id: str,
    payload: ReviewRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Approve or return a time-off request.

    Approving writes the leave entries the person would otherwise type by hand, so the
    week reaches its ordinary target with the time accounted for as leave. A day that
    already holds hours receives only what is left under the daily cap, and the week
    has to be open: approving into a submitted week would rewrite time a reviewer has
    already seen.
    """
    _require_resource_permission(db, current_user, "review", "manage", "admin")
    entity = _coordinator(current_user).get_entity(TIME_OFF_ENTITY_TYPE, request_id)
    values = _entity_values(entity)
    if not entity or not values:
        raise HTTPException(status_code=404, detail="Time-off request was not found.")
    owner = get_user_or_404(db, int(values["user_id"]))
    if not _can_decide_for_owner(current_user, owner, db):
        raise HTTPException(status_code=403, detail="You cannot review this employee's time off.")
    if str(values.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Only a pending request can be reviewed.")
    if payload.action not in ("approve", "return"):
        raise HTTPException(status_code=400, detail="A time-off request is approved or returned.")
    comments = (payload.comments or "").strip()
    if payload.action == "return" and not comments:
        raise HTTPException(status_code=400, detail="Comments are required when returning a request.")

    week_start = parse_week_start(str(values["week_start"]))
    daily_hours = [float(item or 0) for item in (values.get("daily_hours") or [0] * 7)]
    to_status = "approved" if payload.action == "approve" else "returned"
    now = utc_now_text()
    values.update(
        {
            "status": to_status,
            "updated_at": now,
            "reviewed_at": now,
            "reviewed_by_user_id": current_user.id,
            "reviewed_by_name": _display_name(current_user),
            "review_comments": comments or None,
        }
    )
    mutations: list[Mutation] = [
        Mutation(
            entity_type=TIME_OFF_ENTITY_TYPE,
            entity_id=request_id,
            operation_type="update_entity",
            base_record_revision=str(entity["record_revision"]),
            values=values,
        )
    ]

    created = 0
    if to_status == "approved":
        found = _find_submission(current_user, owner_user_id=owner.id, week_start=week_start)
        submission_entity, submission = found if found else (None, _submission_values(owner, week_start))
        if str(submission.get("status")) not in EDITABLE_STATUSES:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{_display_name(owner)}'s week of {week_start.isoformat()} is already "
                    "submitted. Reopen it before approving this time off."
                ),
            )
        submission_id = str(submission["submission_id"])
        recorded: dict[str, float] = {}
        for _, entry in _entities(current_user, ENTRY_ENTITY_TYPE):
            if str(entry.get("submission_id")) != submission_id:
                continue
            key = str(entry.get("work_date"))
            recorded[key] = recorded.get(key, 0.0) + float(entry.get("hours") or 0)
        holidays = _holidays_for_week(current_user, week_start)
        for index, hours in enumerate(daily_hours):
            if hours <= 0:
                continue
            work_date = week_start + timedelta(days=index)
            allowance = day_hours_allowance(work_date, holidays, DEFAULT_DAILY_HOURS[index])
            room = round(allowance - recorded.get(work_date.isoformat(), 0.0), 2)
            grant = min(round(hours, 2), room)
            if grant <= 0:
                continue
            entry_id = str(uuid.uuid4())
            mutations.append(
                Mutation(
                    entity_type=ENTRY_ENTITY_TYPE,
                    entity_id=entry_id,
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values={
                        "entry_id": entry_id,
                        "submission_id": submission_id,
                        "user_id": owner.id,
                        "employee_id": owner.employee_id,
                        "entry_type": "leave",
                        "work_date": work_date.isoformat(),
                        "hours": grant,
                        "start_time": None,
                        "end_time": None,
                        "notes": f"Approved time off: {values.get('reason')}",
                        "created_at": now,
                        "updated_at": now,
                    },
                )
            )
            created += 1
        submission["updated_at"] = now
        mutations.insert(
            0,
            Mutation(
                entity_type=SUBMISSION_ENTITY_TYPE,
                entity_id=submission_id,
                operation_type="update_entity" if submission_entity else "insert_entity",
                base_record_revision=str(submission_entity["record_revision"]) if submission_entity else None,
                values=submission,
                unique_lock_keys=(f"weekly:{owner.id}:{week_start.isoformat()}",),
            ),
        )

    mutations.append(
        _event_mutation(
            current_user,
            subject_user_id=owner.id,
            submission_id=None,
            event_type="time_off_approved" if to_status == "approved" else "time_off_returned",
            week_start=week_start,
            from_status="pending",
            to_status=to_status,
            memo=comments or (f"{created} leave entries added." if created else None),
        )
    )
    _commit(current_user, mutations)
    return {"status": to_status, "leave_entries": created}
