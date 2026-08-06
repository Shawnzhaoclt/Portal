from __future__ import annotations

import copy
import uuid
from datetime import date
from typing import Any, Literal

from portal.runtime.transport import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from portal.app.management.models import User
from portal.app.management.router import get_current_user
from portal.app.management.security import utc_now_text
from portal.app.management.services import require_management_admin
from portal.app.sync.errors import (
    LockTimeout,
    RevisionChanged,
    SharedRootUnavailable,
    SnapshotRequired,
    SyncError,
)
from portal.app.sync.models import Identity, Mutation
from portal.app.sync.runtime import current_coordinator


RESOURCE_ID = "ADMBSHVR"
CALENDAR_ENTITY_TYPE = f"{RESOURCE_ID}.holiday_calendar"
HOLIDAY_ENTITY_TYPE = f"{RESOURCE_ID}.holiday"

router = APIRouter(tags=["holiday-calendar"])


class CalendarCreateRequest(BaseModel):
    calendar_year: int = Field(ge=2000, le=2100)
    label: str | None = None
    notes: str | None = None
    copy_from_calendar_id: str | None = None


class CalendarUpdateRequest(BaseModel):
    label: str | None = None
    notes: str | None = None


class HolidaySaveRequest(BaseModel):
    holiday_name: str
    holiday_date: str
    holiday_hours: float = Field(gt=0, le=24)
    day_type: Literal["full_day", "partial_day"] = "full_day"
    applies_to_weekly_target: bool = True
    extends_deliverable_deadline: bool = True
    is_active: bool = True
    notes: str | None = None


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
            Identity(
                user_id=str(user.id),
                employee_number=str(user.employee_id),
                email=str(user.email),
            )
        )
    except SyncError as error:
        _sync_error(error)


def _entity_values(entity: dict[str, object] | None) -> dict[str, Any] | None:
    if not entity or bool(entity.get("deleted")):
        return None
    values = entity.get("values")
    return dict(values) if isinstance(values, dict) else None


def _normalize_calendar(values: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(values)
    normalized.pop("version", None)
    normalized.pop("status", None)
    normalized.pop("published_by_user_id", None)
    normalized.pop("published_by_name", None)
    normalized.pop("published_at", None)
    return normalized


def _normalize_holiday(values: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(values)
    holiday_date = (
        normalized.get("holiday_date")
        or normalized.get("observed_date")
        or normalized.get("actual_date")
    )
    normalized["holiday_date"] = str(holiday_date or "")
    normalized.pop("actual_date", None)
    normalized.pop("observed_date", None)
    return normalized


def _require_admin(user: User) -> None:
    require_management_admin(user)


def _commit(user: User, mutations: list[Mutation]) -> None:
    try:
        _coordinator(user).commit(mutations)
    except SyncError as error:
        _sync_error(error)


def _calendar_entities(user: User) -> list[tuple[dict[str, object], dict[str, Any]]]:
    result: list[tuple[dict[str, object], dict[str, Any]]] = []
    for entity in _coordinator(user).list_entities(CALENDAR_ENTITY_TYPE):
        values = _entity_values(entity)
        if values:
            result.append((entity, _normalize_calendar(values)))
    return result


def _holiday_entities(user: User) -> list[tuple[dict[str, object], dict[str, Any]]]:
    result: list[tuple[dict[str, object], dict[str, Any]]] = []
    for entity in _coordinator(user).list_entities(HOLIDAY_ENTITY_TYPE):
        values = _entity_values(entity)
        if values:
            result.append((entity, _normalize_holiday(values)))
    return result


def _calendar_or_404(
    user: User, calendar_id: str
) -> tuple[dict[str, object], dict[str, Any]]:
    entity = _coordinator(user).get_entity(CALENDAR_ENTITY_TYPE, calendar_id)
    values = _entity_values(entity)
    if entity is None or values is None:
        raise HTTPException(status_code=404, detail="Holiday calendar was not found.")
    return entity, _normalize_calendar(values)


def _holiday_or_404(
    user: User, calendar_id: str, holiday_id: str
) -> tuple[dict[str, object], dict[str, Any]]:
    entity = _coordinator(user).get_entity(HOLIDAY_ENTITY_TYPE, holiday_id)
    values = _entity_values(entity)
    if entity is None or values is None or values.get("calendar_id") != calendar_id:
        raise HTTPException(status_code=404, detail="Holiday was not found.")
    return entity, _normalize_holiday(values)


def _parse_date(value: str, field_name: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise HTTPException(
            status_code=400, detail=f"{field_name} must use YYYY-MM-DD format."
        ) from error


def _clean_holiday(payload: HolidaySaveRequest, calendar_year: int) -> dict[str, Any]:
    holiday_name = payload.holiday_name.strip()
    if not holiday_name:
        raise HTTPException(status_code=400, detail="Holiday name is required.")
    holiday_date = _parse_date(payload.holiday_date, "Holiday date")
    allowed_years = {calendar_year - 1, calendar_year, calendar_year + 1}
    if holiday_date.year not in allowed_years:
        raise HTTPException(
            status_code=400,
            detail="Holiday date must be within one year of the calendar year.",
        )
    return {
        "holiday_name": holiday_name,
        "holiday_date": holiday_date.isoformat(),
        "holiday_hours": payload.holiday_hours,
        "day_type": payload.day_type,
        "applies_to_weekly_target": payload.applies_to_weekly_target,
        "extends_deliverable_deadline": payload.extends_deliverable_deadline,
        "is_active": payload.is_active,
        "notes": (payload.notes or "").strip() or None,
    }


def validate_calendar_values(
    calendar: dict[str, Any], holidays: list[dict[str, Any]]
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    active = [holiday for holiday in holidays if holiday.get("is_active", True)]
    if not active:
        issues.append(
            {
                "severity": "error",
                "code": "no_active_holidays",
                "message": "Add at least one active holiday to this calendar.",
                "holiday_id": None,
            }
        )

    holiday_dates: dict[str, str] = {}
    names: dict[str, str] = {}
    calendar_year = int(calendar["calendar_year"])
    for holiday in active:
        holiday_id = str(holiday.get("holiday_id") or "")
        name = str(holiday.get("holiday_name") or "").strip()
        normalized_name = name.casefold()
        holiday_date = str(
            holiday.get("holiday_date")
            or holiday.get("observed_date")
            or holiday.get("actual_date")
            or ""
        )
        if not name:
            issues.append(
                {
                    "severity": "error",
                    "code": "missing_name",
                    "message": "Holiday name is required.",
                    "holiday_id": holiday_id,
                }
            )
        elif normalized_name in names:
            issues.append(
                {
                    "severity": "error",
                    "code": "duplicate_name",
                    "message": f"{name} is listed more than once.",
                    "holiday_id": holiday_id,
                }
            )
        else:
            names[normalized_name] = holiday_id

        try:
            parsed_date = date.fromisoformat(holiday_date)
        except ValueError:
            issues.append(
                {
                    "severity": "error",
                    "code": "invalid_holiday_date",
                    "message": f"{name or 'Holiday'} has an invalid holiday date.",
                    "holiday_id": holiday_id,
                }
            )
            continue
        if holiday_date in holiday_dates:
            issues.append(
                {
                    "severity": "error",
                    "code": "duplicate_holiday_date",
                    "message": f"More than one active holiday uses {holiday_date}.",
                    "holiday_id": holiday_id,
                }
            )
        else:
            holiday_dates[holiday_date] = holiday_id
        if parsed_date.year != calendar_year:
            issues.append(
                {
                    "severity": "warning",
                    "code": "cross_year_holiday_date",
                    "message": f"{name} is outside calendar year {calendar_year}.",
                    "holiday_id": holiday_id,
                }
            )

    return {
        "valid": not any(issue["severity"] == "error" for issue in issues),
        "issues": issues,
        "active_holiday_count": len(active),
    }


def _holidays_for_calendar(user: User, calendar_id: str) -> list[dict[str, Any]]:
    holidays = [
        values
        for _entity, values in _holiday_entities(user)
        if values.get("calendar_id") == calendar_id
    ]
    holidays.sort(
        key=lambda holiday: (
            str(holiday.get("holiday_date") or ""),
            str(holiday.get("holiday_name") or ""),
        )
    )
    return holidays


def _calendar_row(
    calendar: dict[str, Any], holiday_count: int | None = None
) -> dict[str, Any]:
    row = _normalize_calendar(calendar)
    if holiday_count is not None:
        row["holiday_count"] = holiday_count
    return row


def _one_calendar_per_year(
    calendars: list[tuple[dict[str, object], dict[str, Any]]],
) -> list[dict[str, Any]]:
    selected: dict[int, dict[str, Any]] = {}
    for _entity, values in calendars:
        year = int(values.get("calendar_year") or 0)
        current = selected.get(year)
        if current is None:
            selected[year] = values
            continue
        updated_at = str(values.get("updated_at") or values.get("created_at") or "")
        current_updated_at = str(
            current.get("updated_at") or current.get("created_at") or ""
        )
        if updated_at > current_updated_at:
            selected[year] = values
    return list(selected.values())


@router.get("/api/holidays/published")
def get_published_calendar(
    year: int = Query(ge=2000, le=2100),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    matches = [
        values
        for _entity, values in _calendar_entities(current_user)
        if int(values.get("calendar_year") or 0) == year
    ]
    if not matches:
        raise HTTPException(
            status_code=404, detail=f"No holiday calendar exists for {year}."
        )
    matches.sort(
        key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""),
        reverse=True,
    )
    calendar = matches[0]
    return {
        "calendar": _calendar_row(calendar),
        "holidays": _holidays_for_calendar(
            current_user, str(calendar["calendar_id"])
        ),
    }


@router.get("/api/admin/holidays/calendars")
def list_calendars(
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    holidays = _holiday_entities(current_user)
    counts: dict[str, int] = {}
    for _entity, values in holidays:
        calendar_id = str(values.get("calendar_id") or "")
        counts[calendar_id] = counts.get(calendar_id, 0) + 1
    calendars = [
        _calendar_row(values, counts.get(str(values["calendar_id"]), 0))
        for values in _one_calendar_per_year(_calendar_entities(current_user))
    ]
    calendars.sort(
        key=lambda item: int(item.get("calendar_year") or 0),
        reverse=True,
    )
    return {"calendars": calendars, "total": len(calendars)}


@router.get("/api/admin/holidays/calendars/{calendar_id}")
def get_calendar(
    calendar_id: str,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    _entity, calendar = _calendar_or_404(current_user, calendar_id)
    holidays = _holidays_for_calendar(current_user, calendar_id)
    return {
        "calendar": _calendar_row(calendar, len(holidays)),
        "holidays": holidays,
        "validation": validate_calendar_values(calendar, holidays),
    }


@router.post("/api/admin/holidays/calendars")
def create_calendar(
    payload: CalendarCreateRequest,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    calendars = _calendar_entities(current_user)
    if any(
        int(values.get("calendar_year") or 0) == payload.calendar_year
        for _entity, values in calendars
    ):
        raise HTTPException(
            status_code=409,
            detail=f"A holiday calendar already exists for {payload.calendar_year}.",
        )
    calendar_id = str(uuid.uuid4())
    now = utc_now_text()
    calendar = {
        "calendar_id": calendar_id,
        "calendar_year": payload.calendar_year,
        "label": (payload.label or "").strip()
        or f"{payload.calendar_year} City-Observed Holidays",
        "notes": (payload.notes or "").strip() or None,
        "created_by_user_id": current_user.id,
        "created_by_name": _display_name(current_user),
        "created_at": now,
        "updated_by_user_id": current_user.id,
        "updated_by_name": _display_name(current_user),
        "updated_at": now,
    }
    mutations = [
        Mutation(
            entity_type=CALENDAR_ENTITY_TYPE,
            entity_id=calendar_id,
            operation_type="insert_entity",
            base_record_revision=None,
            values=calendar,
            unique_lock_keys=(
                f"holiday-calendar:{payload.calendar_year}",
            ),
        )
    ]

    if payload.copy_from_calendar_id:
        _source_entity, source = _calendar_or_404(
            current_user, payload.copy_from_calendar_id
        )
        source_year = int(source["calendar_year"])
        for source_holiday in _holidays_for_calendar(
            current_user, payload.copy_from_calendar_id
        ):
            holiday_id = str(uuid.uuid4())

            def shifted(value: Any) -> str:
                parsed = date.fromisoformat(str(value))
                try:
                    return parsed.replace(
                        year=parsed.year + payload.calendar_year - source_year
                    ).isoformat()
                except ValueError:
                    return parsed.replace(
                        year=parsed.year + payload.calendar_year - source_year,
                        day=28,
                    ).isoformat()

            holiday = {
                **{
                    key: value
                    for key, value in source_holiday.items()
                    if key
                    not in {
                        "holiday_id",
                        "calendar_id",
                        "created_by_user_id",
                        "created_by_name",
                        "created_at",
                        "updated_by_user_id",
                        "updated_by_name",
                        "updated_at",
                    }
                },
                "holiday_id": holiday_id,
                "calendar_id": calendar_id,
                "holiday_date": shifted(source_holiday["holiday_date"]),
                "created_by_user_id": current_user.id,
                "created_by_name": _display_name(current_user),
                "created_at": now,
                "updated_by_user_id": current_user.id,
                "updated_by_name": _display_name(current_user),
                "updated_at": now,
            }
            mutations.append(
                Mutation(
                    entity_type=HOLIDAY_ENTITY_TYPE,
                    entity_id=holiday_id,
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values=holiday,
                )
            )

    _commit(current_user, mutations)
    return {
        "ok": True,
        "calendar": _calendar_row(calendar, len(mutations) - 1),
    }


@router.patch("/api/admin/holidays/calendars/{calendar_id}")
def update_calendar(
    calendar_id: str,
    payload: CalendarUpdateRequest,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    entity, current = _calendar_or_404(current_user, calendar_id)
    calendar = copy.deepcopy(current)
    if payload.label is not None:
        label = payload.label.strip()
        if not label:
            raise HTTPException(status_code=400, detail="Calendar label is required.")
        calendar["label"] = label
    if payload.notes is not None:
        calendar["notes"] = payload.notes.strip() or None
    calendar.update(
        {
            "updated_by_user_id": current_user.id,
            "updated_by_name": _display_name(current_user),
            "updated_at": utc_now_text(),
        }
    )
    _commit(
        current_user,
        [
            Mutation(
                entity_type=CALENDAR_ENTITY_TYPE,
                entity_id=calendar_id,
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values=calendar,
            )
        ],
    )
    return {"ok": True, "calendar": calendar}


@router.post("/api/admin/holidays/calendars/{calendar_id}/holidays")
def create_holiday(
    calendar_id: str,
    payload: HolidaySaveRequest,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    _entity, calendar = _calendar_or_404(current_user, calendar_id)
    holiday_id = str(uuid.uuid4())
    now = utc_now_text()
    holiday = {
        "holiday_id": holiday_id,
        "calendar_id": calendar_id,
        **_clean_holiday(payload, int(calendar["calendar_year"])),
        "created_by_user_id": current_user.id,
        "created_by_name": _display_name(current_user),
        "created_at": now,
        "updated_by_user_id": current_user.id,
        "updated_by_name": _display_name(current_user),
        "updated_at": now,
    }
    _commit(
        current_user,
        [
            Mutation(
                entity_type=HOLIDAY_ENTITY_TYPE,
                entity_id=holiday_id,
                operation_type="insert_entity",
                base_record_revision=None,
                values=holiday,
                unique_lock_keys=(
                    f"holiday-calendar:{calendar_id}:date:{holiday['holiday_date']}",
                ),
            )
        ],
    )
    return {"ok": True, "holiday": holiday}


@router.patch(
    "/api/admin/holidays/calendars/{calendar_id}/holidays/{holiday_id}"
)
def update_holiday(
    calendar_id: str,
    holiday_id: str,
    payload: HolidaySaveRequest,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    _calendar_entity, calendar = _calendar_or_404(current_user, calendar_id)
    entity, current = _holiday_or_404(current_user, calendar_id, holiday_id)
    holiday = {
        **copy.deepcopy(current),
        **_clean_holiday(payload, int(calendar["calendar_year"])),
        "updated_by_user_id": current_user.id,
        "updated_by_name": _display_name(current_user),
        "updated_at": utc_now_text(),
    }
    holiday.pop("actual_date", None)
    holiday.pop("observed_date", None)
    _commit(
        current_user,
        [
            Mutation(
                entity_type=HOLIDAY_ENTITY_TYPE,
                entity_id=holiday_id,
                operation_type="update_entity",
                base_record_revision=str(entity["record_revision"]),
                values=holiday,
                unique_lock_keys=(
                    f"holiday-calendar:{calendar_id}:date:{holiday['holiday_date']}",
                ),
            )
        ],
    )
    return {"ok": True, "holiday": holiday}


@router.delete(
    "/api/admin/holidays/calendars/{calendar_id}/holidays/{holiday_id}"
)
def delete_holiday(
    calendar_id: str,
    holiday_id: str,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    _calendar_entity, calendar = _calendar_or_404(current_user, calendar_id)
    entity, _holiday = _holiday_or_404(current_user, calendar_id, holiday_id)
    _commit(
        current_user,
        [
            Mutation(
                entity_type=HOLIDAY_ENTITY_TYPE,
                entity_id=holiday_id,
                operation_type="delete_entity",
                base_record_revision=str(entity["record_revision"]),
            )
        ],
    )
    return {"ok": True, "holiday_id": holiday_id}


@router.delete("/api/admin/holidays/calendars/{calendar_id}")
def delete_calendar(
    calendar_id: str,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    calendar_entity, calendar = _calendar_or_404(current_user, calendar_id)
    mutations = [
        Mutation(
            entity_type=HOLIDAY_ENTITY_TYPE,
            entity_id=str(values["holiday_id"]),
            operation_type="delete_entity",
            base_record_revision=str(entity["record_revision"]),
        )
        for entity, values in _holiday_entities(current_user)
        if values.get("calendar_id") == calendar_id
    ]
    mutations.append(
        Mutation(
            entity_type=CALENDAR_ENTITY_TYPE,
            entity_id=calendar_id,
            operation_type="delete_entity",
            base_record_revision=str(calendar_entity["record_revision"]),
            unique_lock_keys=(
                f"holiday-calendar:{int(calendar['calendar_year'])}",
            ),
        )
    )
    _commit(current_user, mutations)
    return {
        "ok": True,
        "calendar_id": calendar_id,
        "deleted_holiday_count": len(mutations) - 1,
    }


@router.post("/api/admin/holidays/calendars/{calendar_id}/validate")
def validate_calendar(
    calendar_id: str,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(current_user)
    _entity, calendar = _calendar_or_404(current_user, calendar_id)
    return validate_calendar_values(
        calendar, _holidays_for_calendar(current_user, calendar_id)
    )
