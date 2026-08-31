"""Design Project Close-Out: post-project asset assessments with a review workflow.

Replaces the hand-edited ``DesignProjectCloseOutAssetTable_master.xlsx``. Data arrives
three ways - typed manually, imported from the Excel template, or pulled from a
Cityworks work order - and always lands as a ``pending_review`` project that someone
with review permission approves or returns. Approved data exports back to the exact
template shape, which is what the risk ETL continues to read until the resource is
officially online.
"""

from __future__ import annotations

import base64
import binascii
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import duckdb
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.runtime.transport import APIRouter, Depends, HTTPException, Query, Response

from portal.app.core.desktop_config import configured_asset_history
from portal.app.management.database import get_db
from portal.app.management.models import CodeDictionary, CodeDictionaryItem, Resource, User
from portal.app.management.router import get_current_user
from portal.app.management.security import utc_now_text
from portal.app.management.services import (
    ADMIN_ROLES,
    PERMISSION_TYPES,
    effective_resource_permission,
    selected_user_role,
)
from portal.app.sync.errors import (
    LockTimeout,
    RevisionChanged,
    SharedRootUnavailable,
    SnapshotRequired,
    SyncError,
)
from portal.app.sync.models import Mutation
from portal.app.sync.physical_entities import (
    CLOSEOUT_ASSET_ENTITY_TYPE,
    CLOSEOUT_PROJECT_ENTITY_TYPE,
    REVIEW_EVENT_ENTITY_TYPE,
    stable_global_id,
)
from portal.app.sync.runtime import current_coordinator, sync_identity

from .workbook import (
    ASSET_ID_PATTERN,
    TEMPLATE_HEADINGS,
    build_template_workbook,
    group_rows_into_projects,
    parse_template_workbook,
)


RESOURCE_ID = "FRMDPC01"
RESOURCE_KEY = "design_project_closeout"
SUBJECT_TYPE = "closeout_project"
PROJECT_STATUSES = ("pending_review", "approved", "returned")
# One set per kind of act, so a permission granted in the Manager actually does
# something here. Manage is the "any submitter" escalation rather than a synonym for
# every right, and Admin adds only what is genuinely irreversible.
READ_PERMISSION_TYPES = set(PERMISSION_TYPES)
CREATE_PERMISSION_TYPES = {"create", "manage", "admin"}
EDIT_PERMISSION_TYPES = {"edit", "manage", "admin"}
REVIEWER_PERMISSION_TYPES = {"review", "manage", "admin"}
DELETE_PERMISSION_TYPES = {"delete", "manage", "admin"}
DICTIONARY_FIELDS = {
    "source_of_analysis": "source_of_analysis",
    "flooding_design_standards": "flooding_design_standards",
    "flooding_impact": "flooding_impact",
    "flooding_service_eligibility": "flooding_service_eligibility",
    "post_project_asset_condition": "post_project_asset_condition",
}
PROJECT_ASSET_LIMIT = 2_000
LIST_LIMIT = 1000

router = APIRouter(prefix="/api/forms/design-project-closeout", tags=["design-project-closeout"])


class CloseoutAssetPayload(BaseModel):
    asset_id: str = Field(min_length=3, max_length=64)
    construction_plan_id: str | None = Field(default=None, max_length=64)
    critical_facility_id: str | None = Field(default=None, max_length=64)
    flooding_design_standards: str = Field(min_length=1, max_length=120)
    flooding_impact: str = Field(min_length=1, max_length=120)
    flooding_service_eligibility: str = Field(min_length=1, max_length=120)
    post_project_asset_condition: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=2_000)


class CloseoutProjectPayload(BaseModel):
    project_name: str | None = Field(default=None, max_length=200)
    cityworks_wo_id: str | None = Field(default=None, max_length=32)
    source_of_analysis: str = Field(min_length=1, max_length=120)
    date_of_analysis: str = Field(min_length=10, max_length=10)
    intake_method: Literal["manual", "excel", "cityworks"] = "manual"
    assets: list[CloseoutAssetPayload] = Field(min_length=1)


class CloseoutProjectUpdate(CloseoutProjectPayload):
    record_revision: str = Field(min_length=1)


class CloseoutReviewRequest(BaseModel):
    action: Literal["approve", "return"]
    record_revision: str = Field(min_length=1)
    memo: str | None = Field(default=None, max_length=1_000)


class CloseoutDeleteRequest(BaseModel):
    record_revision: str = Field(min_length=1)


class CloseoutBatchReviewRequest(BaseModel):
    action: Literal["approve", "return"]
    global_ids: list[str] = Field(min_length=1, max_length=1_000)
    memo: str | None = Field(default=None, max_length=1_000)


class CloseoutBatchDeleteRequest(BaseModel):
    global_ids: list[str] = Field(min_length=1, max_length=1_000)


class CloseoutImportRequest(BaseModel):
    file_name: str = Field(min_length=1, max_length=260)
    file_base64: str = Field(min_length=1)
    dry_run: bool = False
    # Administrators may land historical data directly as approved, which is how the
    # existing master file migrates without a thousand-project review queue.
    approve_immediately: bool = False


def _employee_id(user: User) -> str:
    return str(user.employee_id or user.id)


def _display_name(user: User) -> str:
    return f"{user.first_name} {user.last_name}".strip() or str(user.email)


def _is_admin(user: User) -> bool:
    return selected_user_role(user) in ADMIN_ROLES


def _resource(db: Session) -> Resource:
    resource = db.scalar(select(Resource).where(Resource.resource_id == RESOURCE_ID))
    if resource is None or resource.is_active != 1:
        raise HTTPException(
            status_code=503,
            detail="Design Project Close-Out is not registered in the Portal catalog.",
        )
    return resource


def _permission_types(db: Session, user: User) -> set[str]:
    if _is_admin(user):
        return set(PERMISSION_TYPES)
    permission = effective_resource_permission(db, user, _resource(db))
    return set((permission or {}).get("permission_types") or [])


def _require_permission(db: Session, user: User, *permissions: str) -> set[str]:
    current = _permission_types(db, user)
    if _is_admin(user):
        return set(PERMISSION_TYPES)
    if not current.intersection(permissions):
        raise HTTPException(
            status_code=403,
            detail=f"This action requires {' or '.join(permissions)} permission.",
        )
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
    raise HTTPException(status_code=status, detail=str(error)) from error


def _coordinator(user: User):
    try:
        return current_coordinator(
            sync_identity(user)
        )
    except SyncError as error:
        _sync_error(error)


def _commit(user: User, mutations: list[Mutation]) -> None:
    try:
        _coordinator(user).commit(mutations)
    except sqlite3.IntegrityError as error:
        raise HTTPException(
            status_code=409,
            detail="The project conflicts with a record created by another user. Refresh and retry.",
        ) from error
    except SyncError as error:
        _sync_error(error)


def _entity_values(entity: dict[str, object] | None) -> dict[str, Any] | None:
    if not entity or bool(entity.get("deleted")):
        return None
    values = entity.get("values")
    return dict(values) if isinstance(values, dict) else None


def _dictionary_labels(db: Session) -> dict[str, dict[str, str]]:
    """Return {field: {casefolded label: canonical label}} for each controlled field."""
    result: dict[str, dict[str, str]] = {}
    for field, key in DICTIONARY_FIELDS.items():
        dictionary = db.scalar(
            select(CodeDictionary).where(
                CodeDictionary.dictionary_key == key, CodeDictionary.is_active == 1
            )
        )
        labels: dict[str, str] = {}
        if dictionary is not None:
            for item in db.scalars(
                select(CodeDictionaryItem).where(
                    CodeDictionaryItem.dictionary_id == dictionary.id,
                    CodeDictionaryItem.is_active == 1,
                )
            ):
                labels[str(item.label).strip().casefold()] = str(item.label)
        result[field] = labels
    return result


def _canonical_label(
    labels: dict[str, dict[str, str]], field: str, value: str | None, required: bool
) -> str | None:
    text = str(value or "").strip()
    if not text:
        if required:
            raise HTTPException(status_code=422, detail=f"{field} is required.")
        return None
    canonical = labels[field].get(text.casefold())
    if canonical is None:
        raise HTTPException(
            status_code=422,
            detail=f"{field} value {text!r} is not in the {DICTIONARY_FIELDS[field]} dictionary.",
        )
    return canonical


def _validated_assets(
    labels: dict[str, dict[str, str]], assets: list[CloseoutAssetPayload]
) -> list[dict[str, Any]]:
    if len(assets) > PROJECT_ASSET_LIMIT:
        raise HTTPException(
            status_code=422, detail=f"A project can hold at most {PROJECT_ASSET_LIMIT:,} assets."
        )
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for order, asset in enumerate(assets, start=1):
        # Field crews write P-123456 and p_123456 interchangeably; the inventory
        # convention is an uppercase prefix with an underscore.
        asset_id = asset.asset_id.strip().replace("-", "_")
        if asset_id[:1].islower():
            asset_id = asset_id[:1].upper() + asset_id[1:]
        if not ASSET_ID_PATTERN.fullmatch(asset_id):
            raise HTTPException(
                status_code=422,
                detail=f"Asset ID {asset_id!r} must look like P_123456, S_123456, or D_123456.",
            )
        if asset_id in seen:
            raise HTTPException(
                status_code=422, detail=f"Asset {asset_id} appears more than once in the project."
            )
        seen.add(asset_id)
        rows.append(
            {
                "asset_id": asset_id,
                "construction_plan_id": (asset.construction_plan_id or "").strip() or None,
                "critical_facility_id": (asset.critical_facility_id or "").strip() or None,
                "flooding_design_standards": _canonical_label(
                    labels, "flooding_design_standards", asset.flooding_design_standards, True
                ),
                "flooding_impact": _canonical_label(
                    labels, "flooding_impact", asset.flooding_impact, True
                ),
                "flooding_service_eligibility": _canonical_label(
                    labels, "flooding_service_eligibility", asset.flooding_service_eligibility, True
                ),
                "post_project_asset_condition": _canonical_label(
                    labels, "post_project_asset_condition", asset.post_project_asset_condition, False
                ),
                "notes": (asset.notes or "").strip() or None,
                "sort_order": order,
            }
        )
    return rows


def _collect_group_issues(
    labels: dict[str, dict[str, str]], group: dict[str, Any], label: str
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], list[str]]:
    """Validate one imported project group, reporting every QA/QC issue it has.

    Unlike the API validators, nothing raises on first failure: a group with twenty bad
    rows reports twenty problems, so the whole cleanup happens in one Excel pass.
    """
    issues: list[str] = []

    source = str(group.get("source_of_analysis") or "").strip()
    canonical_source = labels["source_of_analysis"].get(source.casefold()) if source else None
    if not source:
        issues.append(f"{label}: Source of Analysis is required.")
    elif canonical_source is None:
        issues.append(f"{label}: Source of Analysis {source!r} is not in the dictionary.")
    date_text = str(group.get("date_of_analysis") or "").strip()
    if not date_text:
        issues.append(f"{label}: Date of Analysis is required.")

    assets: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(group.get("assets") or [], start=1):
        raw_id = str(raw.get("asset_id") or "").strip()
        asset_id = raw_id.replace("-", "_")
        if asset_id[:1].islower():
            asset_id = asset_id[:1].upper() + asset_id[1:]
        context = f"{label}, asset {asset_id or f'#{index}'}"
        if not asset_id:
            issues.append(f"{context}: Asset ID is missing.")
            continue
        # Imports report notation problems instead of silently rewriting the source
        # file, so the workbook gets corrected and stays the record of what was loaded.
        if "-" in raw_id:
            issues.append(
                f"{context}: Asset ID {raw_id!r} uses '-'; the inventory convention is '_' "
                f"(expected {asset_id})."
            )
        if not ASSET_ID_PATTERN.fullmatch(asset_id):
            issues.append(f"{context}: Asset ID must look like P_123456, S_123456, or D_123456.")
        if asset_id in seen:
            issues.append(f"{context}: appears more than once in the project.")
        seen.add(asset_id)

        row: dict[str, Any] = {
            "asset_id": asset_id,
            "construction_plan_id": str(raw.get("construction_plan_id") or "").strip() or None,
            "critical_facility_id": str(raw.get("critical_facility_id") or "").strip() or None,
            "notes": str(raw.get("notes") or "").strip() or None,
            "sort_order": index,
        }
        for field, heading, required in (
            ("flooding_design_standards", "Flooding Design Standards", True),
            ("flooding_impact", "Flooding Impact", True),
            ("flooding_service_eligibility", "Flooding Service Eligibility", True),
            ("post_project_asset_condition", "Post Project Asset Condition", False),
        ):
            text = str(raw.get(field) or "").strip()
            if not text:
                row[field] = None
                if required:
                    issues.append(f"{context}: {heading} is required.")
                continue
            canonical = labels[field].get(text.casefold())
            if canonical is None:
                issues.append(f"{context}: {heading} {text!r} is not in the dictionary.")
                row[field] = None
            else:
                row[field] = canonical
        if row["notes"] and len(row["notes"]) > 2_000:
            issues.append(f"{context}: Notes exceed 2,000 characters.")
        assets.append(row)

    if not assets:
        issues.append(f"{label}: the project has no asset rows.")
        return None, [], issues

    project = {
        "project_name": group.get("project_name"),
        "cityworks_wo_id": group.get("cityworks_wo_id"),
        "source_of_analysis": canonical_source,
        "date_of_analysis": date_text or None,
        "intake_method": "excel",
    }
    return project, assets, issues


def _validated_date(value: str) -> str:
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError as error:
        raise HTTPException(
            status_code=422, detail="date_of_analysis must be a YYYY-MM-DD date."
        ) from error


def _event_mutation(
    project_global_id: str,
    display_key: str,
    event_type: str,
    user: User,
    from_status: str | None,
    to_status: str | None,
    memo: str | None,
    correlation_id: str,
) -> Mutation:
    event_at = utc_now_text()
    event_id = stable_global_id(
        "closeout-event", project_global_id, event_type, event_at, correlation_id
    )
    return Mutation(
        entity_type=REVIEW_EVENT_ENTITY_TYPE,
        entity_id=event_id,
        operation_type="insert_entity",
        base_record_revision=None,
        values={
            "resource_id": None,
            "resource_key": RESOURCE_KEY,
            "resource_type": "form",
            "subject_type": SUBJECT_TYPE,
            "subject_global_id": project_global_id,
            "subject_display_key": display_key,
            "event_type": event_type,
            "actor_user_id": _employee_id(user),
            "actor_name": _display_name(user),
            "event_at": event_at,
            "from_status": from_status,
            "to_status": to_status,
            "memo": (memo or "").strip() or None,
            "correlation_id": correlation_id,
        },
    )


def _asset_sort_key(asset_id: str) -> str:
    """Order P_9 before P_10: pad the numeric tail so string comparison is numeric."""
    prefix, _, tail = asset_id.partition("_")
    return f"{prefix}_{tail.zfill(12)}" if tail.isdigit() else asset_id


def _existing_records_index(
    coordinator: Any, exclude_global_id: str | None = None
) -> dict[str, dict[Any, str]]:
    """Index every stored close-out for duplicate checks.

    One asset may be analysed only once per date; the same work order appearing on
    several projects is normal. The index maps each analysed (asset, date) pair to a
    human-readable project label so a rejection can name the record it collides with.
    """
    asset_dates: dict[tuple[str, str], str] = {}
    projects: dict[str, tuple[str, str]] = {}
    for entity in coordinator.query_entities(CLOSEOUT_PROJECT_ENTITY_TYPE):
        values = _entity_values(entity)
        if values is None:
            continue
        global_id = str(entity["entity_id"])
        if exclude_global_id and global_id == exclude_global_id:
            continue
        display = f"{_project_display_key(values)} ({str(values.get('status') or '')})"
        date_text = str(values.get("date_of_analysis") or "")[:10]
        projects[global_id] = (date_text, display)
    for entity in coordinator.query_entities(CLOSEOUT_ASSET_ENTITY_TYPE):
        values = _entity_values(entity)
        if values is None:
            continue
        parent = projects.get(str(values.get("project_global_id") or ""))
        if parent is None:
            continue
        date_text, display = parent
        asset_id = str(values.get("asset_id") or "").strip()
        if asset_id and date_text:
            asset_dates.setdefault((asset_id, date_text), display)
    return {"asset_dates": asset_dates}


def _duplicate_issues(
    index: dict[str, dict[Any, str]],
    project: dict[str, Any],
    assets: list[dict[str, Any]],
    label: str | None = None,
) -> list[str]:
    prefix = f"{label}: " if label else ""
    issues: list[str] = []
    date_text = str(project.get("date_of_analysis") or "")[:10]
    for asset in assets:
        asset_id = str(asset.get("asset_id") or "")
        existing = index["asset_dates"].get((asset_id, date_text))
        if existing:
            issues.append(
                f"{prefix}asset {asset_id} was already analysed on {date_text}: {existing}."
            )
    return issues


def _project_display_key(values: dict[str, Any]) -> str:
    name = str(values.get("project_name") or "").strip()
    if name:
        return name
    source = str(values.get("source_of_analysis") or "Close-Out").strip()
    return f"{source} · {str(values.get('date_of_analysis') or '')}".strip(" ·")


def _project_assets(coordinator: Any, project_global_id: str) -> list[dict[str, Any]]:
    rows = [
        {**values, "global_id": entity["entity_id"], "record_revision": entity["record_revision"]}
        for entity in coordinator.query_entities(
            CLOSEOUT_ASSET_ENTITY_TYPE, filters={"project_global_id": project_global_id}
        )
        if (values := _entity_values(entity)) is not None
    ]
    rows.sort(key=lambda row: (int(row.get("sort_order") or 0), str(row.get("asset_id") or "")))
    return rows


def _project_row(
    entity: dict[str, Any], values: dict[str, Any], asset_count: int | None = None
) -> dict[str, Any]:
    row = {
        **values,
        "global_id": entity["entity_id"],
        "record_revision": entity["record_revision"],
        "display_key": _project_display_key(values),
    }
    if asset_count is not None:
        row["asset_count"] = asset_count
    return row


def _insert_project_mutations(
    user: User,
    project: dict[str, Any],
    assets: list[dict[str, Any]],
    status: str,
    correlation_id: str,
) -> tuple[str, list[Mutation]]:
    now = utc_now_text()
    project_global_id = stable_global_id("closeout-project", uuid4().hex)
    values = {
        **project,
        "status": status,
        "submitted_at": now,
        "submitted_by_user_id": _employee_id(user),
        "submitted_by": _display_name(user),
        "reviewed_at": None,
        "reviewed_by_user_id": None,
        "reviewed_by": None,
        "review_memo": None,
        "updated_at": now,
        "updated_by_user_id": _employee_id(user),
        "updated_by": _display_name(user),
    }
    if status == "approved":
        values["reviewed_at"] = now
        values["reviewed_by_user_id"] = _employee_id(user)
        values["reviewed_by"] = _display_name(user)
    mutations = [
        Mutation(
            entity_type=CLOSEOUT_PROJECT_ENTITY_TYPE,
            entity_id=project_global_id,
            operation_type="insert_entity",
            base_record_revision=None,
            values=values,
        )
    ]
    for asset in assets:
        mutations.append(
            Mutation(
                entity_type=CLOSEOUT_ASSET_ENTITY_TYPE,
                entity_id=stable_global_id("closeout-asset", project_global_id, asset["asset_id"]),
                operation_type="insert_entity",
                base_record_revision=None,
                values={**asset, "project_global_id": project_global_id},
            )
        )
    mutations.append(
        _event_mutation(
            project_global_id,
            _project_display_key(values),
            "approved" if status == "approved" else "submitted",
            user,
            None,
            status,
            None,
            correlation_id,
        )
    )
    return project_global_id, mutations


def _require_project(coordinator: Any, global_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    entity = coordinator.get_entity(CLOSEOUT_PROJECT_ENTITY_TYPE, global_id)
    values = _entity_values(entity)
    if values is None:
        raise HTTPException(status_code=404, detail="Close-out project was not found.")
    return entity, values


def _owns(user: User, values: dict[str, Any]) -> bool:
    return str(values.get("submitted_by_user_id") or "") == _employee_id(user)


def _can_edit(db: Session, user: User, values: dict[str, Any]) -> bool:
    if _is_admin(user):
        return True
    permissions = _permission_types(db, user)
    if permissions.intersection({"manage", "admin"}):
        return True
    return "edit" in permissions and _owns(user, values)


def _can_delete(db: Session, user: User, values: dict[str, Any]) -> bool:
    """Deleting is deliberately separate from editing.

    Someone who fixes a typo should not also be able to destroy the project and its
    whole review history by accident, so Delete is its own permission. Manage covers
    any submitter; an approved project still takes an administrator.
    """
    if _is_admin(user):
        return True
    permissions = _permission_types(db, user)
    if permissions.intersection({"manage", "admin"}):
        return True
    return "delete" in permissions and _owns(user, values)


@router.get("/projects")
def list_projects(
    status: str | None = Query(default=None),
    search: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=LIST_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *READ_PERMISSION_TYPES)
    filters: dict[str, Any] = {}
    if status:
        if status not in PROJECT_STATUSES:
            raise HTTPException(status_code=422, detail=f"Unknown status {status!r}.")
        filters["status"] = status
    coordinator = _coordinator(current_user)
    search_clause = ((["project_name", "cityworks_wo_id"], search.strip()) if search and search.strip() else None)
    entities = coordinator.query_entities(
        CLOSEOUT_PROJECT_ENTITY_TYPE,
        filters=filters or None,
        search=search_clause,
        order_by=(("submitted_at", True), ("global_id", True)),
        limit=limit,
        offset=offset,
    )
    rows = []
    counts = {value: 0 for value in PROJECT_STATUSES}
    for entity in coordinator.query_entities(CLOSEOUT_PROJECT_ENTITY_TYPE):
        values = _entity_values(entity)
        if values is not None and str(values.get("status")) in counts:
            counts[str(values.get("status"))] += 1
    for entity in entities:
        values = _entity_values(entity)
        if values is None:
            continue
        assets = _project_assets(coordinator, str(entity["entity_id"]))
        row = _project_row(entity, values, asset_count=len(assets))
        row["_sort_asset"] = max(
            (_asset_sort_key(str(asset.get("asset_id") or "")) for asset in assets),
            default="",
        )
        rows.append(row)
    # Newest input first; bulk imports share one submission timestamp, so ties fall
    # back to the analysis date and then the project's highest asset identifier.
    rows.sort(
        key=lambda row: (
            str(row.get("submitted_at") or ""),
            str(row.get("date_of_analysis") or ""),
            str(row.get("_sort_asset") or ""),
        ),
        reverse=True,
    )
    for row in rows:
        row.pop("_sort_asset", None)
    permissions = _permission_types(db, current_user)
    return {
        "rows": rows,
        "status_counts": counts,
        "can_create": bool(permissions.intersection(CREATE_PERMISSION_TYPES)),
        "can_submit": bool(permissions.intersection(EDIT_PERMISSION_TYPES)),
        "can_review": bool(permissions.intersection(REVIEWER_PERMISSION_TYPES)),
        "can_delete": bool(permissions.intersection(DELETE_PERMISSION_TYPES)),
    }


@router.get("/projects/{global_id}")
def get_project(
    global_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *READ_PERMISSION_TYPES)
    coordinator = _coordinator(current_user)
    entity, values = _require_project(coordinator, global_id)
    assets = _project_assets(coordinator, global_id)
    return {
        "project": _project_row(entity, values, asset_count=len(assets)),
        "assets": assets,
        "can_edit": _can_edit(db, current_user, values) and values.get("status") != "approved",
        "can_delete": _can_delete(db, current_user, values)
        and (values.get("status") != "approved" or _is_admin(current_user)),
        "can_review": bool(
            _permission_types(db, current_user).intersection(REVIEWER_PERMISSION_TYPES)
        ),
    }


@router.post("/projects")
def create_project(
    payload: CloseoutProjectPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *CREATE_PERMISSION_TYPES)
    # Entering a project by hand requires a name. The Excel and Cityworks intake paths
    # deliberately still accept a blank one, because the historical master is full of
    # nameless Planning analyses and importing must not rewrite them.
    project_name = (payload.project_name or "").strip()
    if not project_name:
        raise HTTPException(status_code=422, detail="Project name is required.")
    labels = _dictionary_labels(db)
    project = {
        "project_name": project_name,
        "cityworks_wo_id": _validated_workorder_id(payload.cityworks_wo_id),
        "source_of_analysis": _canonical_label(
            labels, "source_of_analysis", payload.source_of_analysis, True
        ),
        "date_of_analysis": _validated_date(payload.date_of_analysis),
        "intake_method": payload.intake_method,
    }
    assets = _validated_assets(labels, payload.assets)
    coordinator = _coordinator(current_user)
    duplicates = _duplicate_issues(_existing_records_index(coordinator), project, assets)
    if duplicates:
        raise HTTPException(status_code=409, detail="Duplicate record. " + " ".join(duplicates))
    global_id, mutations = _insert_project_mutations(
        current_user, project, assets, "pending_review", uuid4().hex
    )
    _commit(current_user, mutations)
    coordinator = _coordinator(current_user)
    entity, values = _require_project(coordinator, global_id)
    return {"project": _project_row(entity, values, asset_count=len(assets))}


@router.put("/projects/{global_id}")
def update_project(
    global_id: str,
    payload: CloseoutProjectUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *EDIT_PERMISSION_TYPES)
    coordinator = _coordinator(current_user)
    entity, values = _require_project(coordinator, global_id)
    status = str(values.get("status") or "")
    if status == "approved":
        raise HTTPException(status_code=409, detail="An approved project can no longer be edited.")
    if not _can_edit(db, current_user, values):
        raise HTTPException(
            status_code=403,
            detail="Only the submitter or a user with Manage or Admin permission can edit this project.",
        )

    labels = _dictionary_labels(db)
    now = utc_now_text()
    updated = {
        "project_name": (payload.project_name or "").strip() or None,
        "cityworks_wo_id": _validated_workorder_id(payload.cityworks_wo_id),
        "source_of_analysis": _canonical_label(
            labels, "source_of_analysis", payload.source_of_analysis, True
        ),
        "date_of_analysis": _validated_date(payload.date_of_analysis),
        # Editing a returned project resubmits it for review.
        "status": "pending_review",
        "review_memo": None,
        "updated_at": now,
        "updated_by_user_id": _employee_id(current_user),
        "updated_by": _display_name(current_user),
    }
    assets = _validated_assets(labels, payload.assets)
    duplicates = _duplicate_issues(
        _existing_records_index(coordinator, exclude_global_id=global_id),
        {"cityworks_wo_id": updated["cityworks_wo_id"], "date_of_analysis": updated["date_of_analysis"]},
        assets,
    )
    if duplicates:
        raise HTTPException(status_code=409, detail="Duplicate record. " + " ".join(duplicates))

    existing = {
        str(row.get("asset_id")): row for row in _project_assets(coordinator, global_id)
    }
    # An asset removed by an earlier edit leaves a tombstone under the same
    # deterministic id. Re-adding that asset must restore the tombstoned record;
    # inserting a fresh one under the taken identifier would be rejected.
    tombstoned: dict[str, dict[str, str]] = {}
    for entity in coordinator.query_entities(
        CLOSEOUT_ASSET_ENTITY_TYPE,
        filters={"project_global_id": global_id},
        include_deleted=True,
    ):
        if not bool(entity.get("deleted")):
            continue
        values_for_ghost = _entity_values(entity)
        if values_for_ghost is None:
            continue
        tombstoned[str(values_for_ghost.get("asset_id"))] = {
            "global_id": str(entity["entity_id"]),
            "record_revision": str(entity["record_revision"]),
        }
    mutations: list[Mutation] = [
        Mutation(
            entity_type=CLOSEOUT_PROJECT_ENTITY_TYPE,
            entity_id=global_id,
            operation_type="update_fields",
            base_record_revision=payload.record_revision,
            values=updated,
        )
    ]
    desired: set[str] = set()
    for asset in assets:
        desired.add(asset["asset_id"])
        current = existing.get(asset["asset_id"])
        asset_values = {**asset, "project_global_id": global_id}
        if current is None:
            ghost = tombstoned.get(asset["asset_id"])
            if ghost is not None:
                mutations.append(
                    Mutation(
                        entity_type=CLOSEOUT_ASSET_ENTITY_TYPE,
                        entity_id=ghost["global_id"],
                        operation_type="restore_entity",
                        base_record_revision=ghost["record_revision"],
                        values=asset_values,
                    )
                )
            else:
                mutations.append(
                    Mutation(
                        entity_type=CLOSEOUT_ASSET_ENTITY_TYPE,
                        entity_id=stable_global_id("closeout-asset", global_id, asset["asset_id"]),
                        operation_type="insert_entity",
                        base_record_revision=None,
                        values=asset_values,
                    )
                )
        else:
            mutations.append(
                Mutation(
                    entity_type=CLOSEOUT_ASSET_ENTITY_TYPE,
                    entity_id=str(current["global_id"]),
                    operation_type="update_fields",
                    base_record_revision=str(current["record_revision"]),
                    values=asset_values,
                )
            )
    for asset_id, current in existing.items():
        if asset_id not in desired:
            mutations.append(
                Mutation(
                    entity_type=CLOSEOUT_ASSET_ENTITY_TYPE,
                    entity_id=str(current["global_id"]),
                    operation_type="delete_entity",
                    base_record_revision=str(current["record_revision"]),
                )
            )
    mutations.append(
        _event_mutation(
            global_id,
            _project_display_key({**values, **updated}),
            "resubmitted" if status == "returned" else "updated",
            current_user,
            status,
            "pending_review",
            None,
            uuid4().hex,
        )
    )
    _commit(current_user, mutations)
    entity, values = _require_project(_coordinator(current_user), global_id)
    return {"project": _project_row(entity, values, asset_count=len(assets))}


@router.post("/projects/{global_id}/review")
def review_project(
    global_id: str,
    payload: CloseoutReviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *REVIEWER_PERMISSION_TYPES)
    coordinator = _coordinator(current_user)
    entity, values = _require_project(coordinator, global_id)
    status = str(values.get("status") or "")
    allowed = ("pending_review",) if payload.action == "approve" else ("pending_review", "approved")
    if status not in allowed:
        raise HTTPException(
            status_code=409,
            detail=f"A project can be approved only while pending; this one is {status}."
            if payload.action == "approve"
            else f"This project is {status} and cannot be returned.",
        )
    if payload.action == "return" and not (payload.memo or "").strip():
        raise HTTPException(
            status_code=422, detail="Returning a project requires a memo explaining what to fix."
        )
    now = utc_now_text()
    next_status = "approved" if payload.action == "approve" else "returned"
    mutations = [
        Mutation(
            entity_type=CLOSEOUT_PROJECT_ENTITY_TYPE,
            entity_id=global_id,
            operation_type="update_fields",
            base_record_revision=payload.record_revision,
            values={
                "status": next_status,
                "reviewed_at": now,
                "reviewed_by_user_id": _employee_id(current_user),
                "reviewed_by": _display_name(current_user),
                "review_memo": (payload.memo or "").strip() or None,
                "updated_at": now,
                "updated_by_user_id": _employee_id(current_user),
                "updated_by": _display_name(current_user),
            },
        ),
        _event_mutation(
            global_id,
            _project_display_key(values),
            next_status,
            current_user,
            status,
            next_status,
            payload.memo,
            uuid4().hex,
        ),
    ]
    _commit(current_user, mutations)
    entity, values = _require_project(_coordinator(current_user), global_id)
    return {"project": _project_row(entity, values)}


@router.post("/projects/batch-review")
def batch_review_projects(
    payload: CloseoutBatchReviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Approve or return many pending projects as one atomic decision."""
    _require_permission(db, current_user, *REVIEWER_PERMISSION_TYPES)
    if payload.action == "return" and not (payload.memo or "").strip():
        raise HTTPException(
            status_code=422, detail="Returning projects requires a memo explaining what to fix."
        )
    coordinator = _coordinator(current_user)
    now = utc_now_text()
    next_status = "approved" if payload.action == "approve" else "returned"
    correlation_id = uuid4().hex
    mutations: list[Mutation] = []
    skipped: list[dict[str, str]] = []
    reviewed = 0
    for global_id in dict.fromkeys(payload.global_ids):
        entity = coordinator.get_entity(CLOSEOUT_PROJECT_ENTITY_TYPE, global_id)
        values = _entity_values(entity)
        if values is None:
            skipped.append({"global_id": global_id, "reason": "The project was not found."})
            continue
        status = str(values.get("status") or "")
        # Approval only moves pending work forward; a return may also pull an
        # already-approved project back into editing.
        allowed = ("pending_review",) if payload.action == "approve" else ("pending_review", "approved")
        if status not in allowed:
            skipped.append(
                {"global_id": global_id, "reason": f"{_project_display_key(values)} is {status}."}
            )
            continue
        reviewed += 1
        mutations.append(
            Mutation(
                entity_type=CLOSEOUT_PROJECT_ENTITY_TYPE,
                entity_id=global_id,
                operation_type="update_fields",
                base_record_revision=str(entity["record_revision"]),
                values={
                    "status": next_status,
                    "reviewed_at": now,
                    "reviewed_by_user_id": _employee_id(current_user),
                    "reviewed_by": _display_name(current_user),
                    "review_memo": (payload.memo or "").strip() or None,
                    "updated_at": now,
                    "updated_by_user_id": _employee_id(current_user),
                    "updated_by": _display_name(current_user),
                },
            )
        )
        mutations.append(
            _event_mutation(
                global_id,
                _project_display_key(values),
                next_status,
                current_user,
                status,
                next_status,
                payload.memo,
                correlation_id,
            )
        )
    if mutations:
        _commit(current_user, mutations)
    return {"reviewed": reviewed, "action": payload.action, "skipped": skipped}


@router.post("/projects/batch-delete")
def batch_delete_projects(
    payload: CloseoutBatchDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete many projects, each with its assets and review history, in one commit."""
    _require_permission(db, current_user, *DELETE_PERMISSION_TYPES)
    coordinator = _coordinator(current_user)
    mutations: list[Mutation] = []
    skipped: list[dict[str, str]] = []
    deleted = 0
    for global_id in dict.fromkeys(payload.global_ids):
        entity = coordinator.get_entity(CLOSEOUT_PROJECT_ENTITY_TYPE, global_id)
        values = _entity_values(entity)
        if values is None:
            skipped.append({"global_id": global_id, "reason": "The project was not found."})
            continue
        if str(values.get("status") or "") == "approved" and not _is_admin(current_user):
            skipped.append(
                {"global_id": global_id, "reason": f"{_project_display_key(values)} is approved; only an administrator can delete it."}
            )
            continue
        if not _can_delete(db, current_user, values):
            skipped.append(
                {"global_id": global_id, "reason": f"{_project_display_key(values)} belongs to another submitter."}
            )
            continue
        deleted += 1
        for row in _project_assets(coordinator, global_id):
            mutations.append(
                Mutation(
                    entity_type=CLOSEOUT_ASSET_ENTITY_TYPE,
                    entity_id=str(row["global_id"]),
                    operation_type="delete_entity",
                    base_record_revision=str(row["record_revision"]),
                )
            )
        for event in coordinator.query_entities(
            REVIEW_EVENT_ENTITY_TYPE,
            filters={
                "resource_key": RESOURCE_KEY,
                "subject_type": SUBJECT_TYPE,
                "subject_global_id": global_id,
            },
        ):
            if not bool(event.get("deleted")):
                mutations.append(
                    Mutation(
                        entity_type=REVIEW_EVENT_ENTITY_TYPE,
                        entity_id=str(event["entity_id"]),
                        operation_type="delete_entity",
                        base_record_revision=str(event["record_revision"]),
                    )
                )
        mutations.append(
            Mutation(
                entity_type=CLOSEOUT_PROJECT_ENTITY_TYPE,
                entity_id=global_id,
                operation_type="delete_entity",
                base_record_revision=str(entity["record_revision"]),
            )
        )
    if mutations:
        _commit(current_user, mutations)
    return {"deleted": deleted, "skipped": skipped}


@router.delete("/projects/{global_id}")
def delete_project(
    global_id: str,
    payload: CloseoutDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *DELETE_PERMISSION_TYPES)
    coordinator = _coordinator(current_user)
    entity, values = _require_project(coordinator, global_id)
    if str(values.get("status") or "") == "approved" and not _is_admin(current_user):
        raise HTTPException(status_code=409, detail="Only an administrator can delete an approved project.")
    if not _can_delete(db, current_user, values):
        raise HTTPException(
            status_code=403,
            detail="Only the submitter or a user with Manage or Admin permission can delete this project.",
        )
    assets = _project_assets(coordinator, global_id)
    events = [
        event
        for event in coordinator.query_entities(
            REVIEW_EVENT_ENTITY_TYPE,
            filters={
                "resource_key": RESOURCE_KEY,
                "subject_type": SUBJECT_TYPE,
                "subject_global_id": global_id,
            },
        )
        if not bool(event.get("deleted"))
    ]
    mutations = [
        Mutation(
            entity_type=CLOSEOUT_ASSET_ENTITY_TYPE,
            entity_id=str(row["global_id"]),
            operation_type="delete_entity",
            base_record_revision=str(row["record_revision"]),
        )
        for row in assets
    ]
    mutations.extend(
        Mutation(
            entity_type=REVIEW_EVENT_ENTITY_TYPE,
            entity_id=str(event["entity_id"]),
            operation_type="delete_entity",
            base_record_revision=str(event["record_revision"]),
        )
        for event in events
    )
    mutations.append(
        Mutation(
            entity_type=CLOSEOUT_PROJECT_ENTITY_TYPE,
            entity_id=global_id,
            operation_type="delete_entity",
            base_record_revision=payload.record_revision,
        )
    )
    _commit(current_user, mutations)
    return {"ok": True, "deleted": {"projects": 1, "assets": len(assets), "events": len(events)}}


@router.get("/projects/{global_id}/events")
def project_events(
    global_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *READ_PERMISSION_TYPES)
    rows = []
    for entity in _coordinator(current_user).query_entities(
        REVIEW_EVENT_ENTITY_TYPE,
        filters={
            "resource_key": RESOURCE_KEY,
            "subject_type": SUBJECT_TYPE,
            "subject_global_id": global_id,
        },
        order_by=(("event_at", True), ("global_id", True)),
    ):
        values = _entity_values(entity)
        if values is not None:
            rows.append({**values, "global_id": entity["entity_id"]})
    return {"events": rows}


def _import_workbook_content(
    content: bytes,
    file_name: str,
    *,
    dry_run: bool,
    approve_immediately: bool,
    db: Session,
    current_user: User,
    default_workorder: str | None = None,
    intake_method: str = "excel",
) -> dict[str, Any]:
    """Validate and import one close-out workbook; the QA/QC report lists every issue."""
    rows, errors = parse_template_workbook(content)
    labels = _dictionary_labels(db)
    groups = group_rows_into_projects(rows)
    if default_workorder:
        # An attachment belongs to the selected work order; rows that leave the WO
        # column blank inherit it rather than importing as unlinked projects.
        for group in groups:
            if not str(group.get("cityworks_wo_id") or "").strip():
                group["cityworks_wo_id"] = default_workorder
    duplicate_index = _existing_records_index(_coordinator(current_user))
    seen_asset_dates: dict[tuple[str, str], str] = {}
    prepared: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for group in groups:
        label = str(
            group.get("project_name")
            or f"{group.get('source_of_analysis')} · {group.get('date_of_analysis')}"
        )
        project, assets, group_issues = _collect_group_issues(labels, group, label)
        if project is not None:
            group_issues.extend(_duplicate_issues(duplicate_index, project, assets, label))
            date_text = str(project.get("date_of_analysis") or "")[:10]
            for asset in assets:
                key = (str(asset.get("asset_id") or ""), date_text)
                if key[0] and key in seen_asset_dates:
                    group_issues.append(
                        f"{label}: asset {key[0]} on {date_text} appears more than once in "
                        f"this file (also under {seen_asset_dates[key]})."
                    )
                elif key[0]:
                    seen_asset_dates[key] = label
        errors.extend(group_issues)
        if project is not None and not group_issues:
            prepared.append((project, assets))

    summary = {
        "file_name": file_name,
        "row_count": len(rows),
        "project_count": len(prepared),
        "errors": errors,
        "imported": False,
    }
    if dry_run or errors:
        return summary

    status = "approved" if approve_immediately else "pending_review"
    correlation_id = uuid4().hex
    mutations: list[Mutation] = []
    for project, assets in prepared:
        project = {**project, "intake_method": intake_method}
        _global_id, project_mutations = _insert_project_mutations(
            current_user, project, assets, status, correlation_id
        )
        mutations.extend(project_mutations)
    _commit(current_user, mutations)
    summary["imported"] = True
    return summary


@router.post("/import-excel")
def import_excel(
    payload: CloseoutImportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *CREATE_PERMISSION_TYPES)
    if payload.approve_immediately and not _is_admin(current_user):
        raise HTTPException(
            status_code=403, detail="Only an administrator can import directly as approved."
        )
    try:
        content = base64.b64decode(payload.file_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail="The uploaded file is not valid base64.") from error
    return _import_workbook_content(
        content,
        payload.file_name,
        dry_run=payload.dry_run,
        approve_immediately=payload.approve_immediately,
        db=db,
        current_user=current_user,
    )


def _cityworks_database() -> Path:
    config = configured_asset_history()
    return Path(str(config["sources"]["cityworks"]["database"]))


CITYWORKS_STORM_ENTITY_TYPES = ("PIPES", "STRUCTURES", "CHANNELS", "CITY CULVERTS")
WORKORDER_ID_MAX_DIGITS = 10
# Close-out starts from the workbook attached to the work order, so one without a
# spreadsheet has nothing to import. Guarded by a table check because a mirror built
# before WORKORDERIMG was synced has no attachments at all.
HAS_CLOSEOUT_EXCEL_SQL = """EXISTS (
    SELECT 1 FROM {table} i
    WHERE CAST(i.WORKORDERID AS VARCHAR) = CAST(w.WORKORDERID AS VARCHAR)
      AND lower(CAST(i.IMAGEPATH AS VARCHAR)) LIKE '%.xls%'
)"""
# The work order kinds this resource closes out. Design Team Project is the bulk of
# it; the other three appear in the historical master and are treated as eligible too.
ELIGIBLE_WORKORDER_DESCRIPTIONS = (
    "Design Team Project",
    "Repair",
    "Street Maintenance",
    "Universal",
)
# STATUS is compared upper-cased because the mirror holds one row spelled "Closed".
ELIGIBLE_WORKORDER_STATUSES = ("CLOSED", "COMPLETE")
# COMPLETE work orders never carry DATEWOCLOSED, so the finish date stands in for it.
# Both are needed: 12,092 closed rows have DATEWOCLOSED and 142 complete ones only
# have ACTUALFINISHDATE.
WORKORDER_CLOSED_DATE_SQL = "COALESCE(w.DATEWOCLOSED, w.ACTUALFINISHDATE)"


def _validated_workorder_id(value: str | None) -> str | None:
    """A work order is digits, and it has to be one Cityworks actually holds.

    Absence is only asserted when the mirror can answer: if it is missing or
    unreadable the value passes, because "we cannot check" is not "it does not
    exist" and blocking entry on an unavailable mirror would be worse than
    accepting an id that a later import would flag anyway.
    """
    text = (value or "").strip()
    if not text:
        return None
    if not text.isdigit():
        raise HTTPException(status_code=422, detail="Cityworks WO must be a number.")
    try:
        database = _cityworks_database()
        if not database.is_file():
            return text
        with closing(duckdb.connect(str(database), read_only=True)) as connection:
            found = connection.execute(
                "SELECT 1 FROM azteca_WORKORDER WHERE CAST(WORKORDERID AS VARCHAR) = ? LIMIT 1",
                [text],
            ).fetchone()
    except HTTPException:
        raise
    except Exception:
        return text
    if found is None:
        raise HTTPException(
            status_code=422,
            detail=f"Work order {text} was not found in Cityworks.",
        )
    return text


@router.get("/cityworks/workorders/{workorder_id}/exists")
def cityworks_workorder_exists(
    workorder_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Check one work order id without pulling its assets, for live form feedback."""
    _require_permission(db, current_user, *READ_PERMISSION_TYPES)
    text = workorder_id.strip()
    if not text.isdigit():
        return {"workorder_id": text, "exists": False, "checked": True, "reason": "not_a_number"}
    try:
        database = _cityworks_database()
        if not database.is_file():
            return {"workorder_id": text, "exists": True, "checked": False, "reason": "mirror_unavailable"}
        with closing(duckdb.connect(str(database), read_only=True)) as connection:
            row = connection.execute(
                "SELECT COALESCE(NULLIF(TRIM(CAST(PROJECTNAME AS VARCHAR)), ''), "
                "regexp_replace(NULLIF(TRIM(CAST(LOCATION AS VARCHAR)), ''), ' +', ' ', 'g')) "
                "FROM azteca_WORKORDER WHERE CAST(WORKORDERID AS VARCHAR) = ? LIMIT 1",
                [text],
            ).fetchone()
    except Exception:
        return {"workorder_id": text, "exists": True, "checked": False, "reason": "mirror_unavailable"}
    if row is None:
        return {"workorder_id": text, "exists": False, "checked": True, "reason": "not_found"}
    return {"workorder_id": text, "exists": True, "checked": True, "project_name": row[0]}


def _latest_analysis_date(coordinator: Any) -> str | None:
    """The most recent date_of_analysis across approved and pending projects.

    Pending records count: an analysis that is entered but not yet reviewed still
    marks its work orders as handled, so the backlog should not resurface them.
    """
    latest: str | None = None
    for entity in coordinator.query_entities(CLOSEOUT_PROJECT_ENTITY_TYPE):
        values = _entity_values(entity)
        if values is None:
            continue
        if str(values.get("status") or "") not in ("approved", "pending_review"):
            continue
        date_text = str(values.get("date_of_analysis") or "")[:10]
        if date_text and (latest is None or date_text > latest):
            latest = date_text
    return latest


@router.get("/cityworks/workorders")
def cityworks_workorders(
    search: str | None = Query(default=None, max_length=80),
    closed_since: str | None = Query(default=None, max_length=10),
    spreadsheet: Literal["with", "without", "any"] = Query(default="with"),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Closed Design Team Project work orders - the close-out backlog.

    Only work orders with STATUS CLOSED and DESCRIPTION 'Design Team Project' ever
    appear. Two pull modes: by closed date (``closed_since`` lists everything closed on
    or after that day) or by work order number (``search``). With neither, the list is
    the backlog - work orders closed after the most recent analysis date among the
    approved projects.
    """
    _require_permission(db, current_user, *CREATE_PERMISSION_TYPES)
    database = _cityworks_database()
    if not database.is_file():
        raise HTTPException(status_code=503, detail="The Cityworks work order mirror is not available.")
    # A work order id is a number of at most ten digits; anything else the user typed
    # or pasted is stripped rather than rejected, so a copied "WO 6196" still searches.
    query = re.sub(r"\D+", "", (search or ""))[:WORKORDER_ID_MAX_DIGITS]
    since = (closed_since or "").strip()
    if since:
        try:
            datetime.strptime(since, "%Y-%m-%d")
        except ValueError as error:
            raise HTTPException(status_code=422, detail="closed_since must be a YYYY-MM-DD date.") from error
    cutoff = None if (query or since) else _latest_analysis_date(_coordinator(current_user))
    status_slots = ", ".join("?" for _ in ELIGIBLE_WORKORDER_STATUSES)
    description_slots = ", ".join("?" for _ in ELIGIBLE_WORKORDER_DESCRIPTIONS)
    filters = [
        f"upper(CAST(w.STATUS AS VARCHAR)) IN ({status_slots})",
        f"w.DESCRIPTION IN ({description_slots})",
    ]
    filter_parameters: list[Any] = [
        *ELIGIBLE_WORKORDER_STATUSES,
        *ELIGIBLE_WORKORDER_DESCRIPTIONS,
    ]
    if query:
        # Contains, plus a small edit distance so a mistyped digit still finds it.
        filters.append(
            "(CAST(w.WORKORDERID AS VARCHAR) LIKE '%' || ? || '%'"
            " OR levenshtein(CAST(w.WORKORDERID AS VARCHAR), ?) <= 2)"
        )
        filter_parameters.extend([query, query])
    elif since:
        filters.append(f"CAST({WORKORDER_CLOSED_DATE_SQL} AS DATE) >= CAST(? AS DATE)")
        filter_parameters.append(since)
    elif cutoff is not None:
        filters.append(f"CAST({WORKORDER_CLOSED_DATE_SQL} AS DATE) > CAST(? AS DATE)")
        filter_parameters.append(cutoff)
    with closing(duckdb.connect(str(database), read_only=True)) as connection:
        attachments_available = bool(
            connection.execute(
                "SELECT 1 FROM information_schema.tables WHERE table_name = ? LIMIT 1",
                [CLOSEOUT_ATTACHMENT_TABLE],
            ).fetchone()
        )
        # An attached workbook is the usual starting point but not the only one: a work
        # order without one can still be closed out from its assets by hand, so which
        # side of that line to show is the caller's choice.
        exists_sql = HAS_CLOSEOUT_EXCEL_SQL.format(table=CLOSEOUT_ATTACHMENT_TABLE)
        excel_filter = None
        if attachments_available and spreadsheet == "with":
            excel_filter = exists_sql
        elif attachments_available and spreadsheet == "without":
            excel_filter = f"NOT {exists_sql}"
        # Counted before the close-out requirements are applied, so the page can say
        # what it left out rather than quietly showing a shorter list.
        matched_total = connection.execute(
            f"SELECT COUNT(DISTINCT w.WORKORDERID) FROM azteca_WORKORDER w WHERE {' AND '.join(filters)}",
            filter_parameters,
        ).fetchone()[0]
        if excel_filter:
            filters.append(excel_filter)
        # The entity types belong to the LEFT JOIN and the limit to the tail, so the
        # row query's values are assembled here rather than carried along in one list.
        parameters = [*CITYWORKS_STORM_ENTITY_TYPES, *filter_parameters, limit]
        rows = connection.execute(
            f"""
            SELECT w.WORKORDERID, w.DESCRIPTION,
                   COALESCE(NULLIF(TRIM(CAST(w.PROJECTNAME AS VARCHAR)), ''), regexp_replace(NULLIF(TRIM(CAST(w.LOCATION AS VARCHAR)), ''), ' +', ' ', 'g')) AS project_name,
                   w.STATUS,
                   CAST(CAST(COALESCE(w.DATEWOCLOSED, w.ACTUALFINISHDATE) AS DATE) AS VARCHAR) AS date_wo_closed,
                   COUNT(e.ENTITYUID) AS storm_assets
            FROM azteca_WORKORDER w
            LEFT JOIN azteca_WORKORDERENTITY e
              ON e.WORKORDERID = w.WORKORDERID AND e.ENTITYTYPE IN (?, ?, ?, ?)
            WHERE {" AND ".join(filters)}
            GROUP BY 1, 2, 3, 4, 5
            HAVING COUNT(e.ENTITYUID) > 0
            ORDER BY date_wo_closed DESC NULLS LAST,
                     try_cast(w.WORKORDERID AS BIGINT) DESC NULLS LAST
            LIMIT ?
            """,
            parameters,
        ).fetchall()
    results = [
        {
            "workorder_id": str(row[0]),
            "description": row[1],
            "project_name": row[2],
            "status": row[3],
            "date_wo_closed": row[4],
            "storm_asset_count": int(row[5] or 0),
        }
        for row in rows
    ]
    if query:
        # Ranked in Python rather than SQL: the result set is already bounded by LIMIT,
        # and keeping the ranking out of the GROUP BY leaves the query readable.
        def rank(item: dict[str, Any]) -> tuple[int, int, str]:
            value = str(item["workorder_id"])
            if value == query:
                order = 0
            elif value.startswith(query):
                order = 1
            elif query in value:
                order = 2
            else:
                order = 3
            return (order, len(value), value)

        results.sort(key=rank)
    # Only meaningful when the page is not simply hitting its row limit.
    hidden = max(0, int(matched_total) - len(results)) if len(results) < limit else 0
    return {
        "cutoff": cutoff,
        "rows": results,
        "hidden_without_excel": hidden,
        "spreadsheet": spreadsheet,
        "workorder_url_template": str(os.getenv("PORTAL_CITYWORKS_WORKORDER_URL_TEMPLATE") or "").strip() or None,
    }


@router.get("/cityworks/workorders/{workorder_id}/assets")
def cityworks_workorder_assets(
    workorder_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_permission(db, current_user, *CREATE_PERMISSION_TYPES)
    database = _cityworks_database()
    if not database.is_file():
        raise HTTPException(status_code=503, detail="The Cityworks work order mirror is not available.")
    with closing(duckdb.connect(str(database), read_only=True)) as connection:
        workorder = connection.execute(
            "SELECT w.WORKORDERID, w.DESCRIPTION, "
            "COALESCE(NULLIF(TRIM(CAST(w.PROJECTNAME AS VARCHAR)), ''), regexp_replace(NULLIF(TRIM(CAST(w.LOCATION AS VARCHAR)), ''), ' +', ' ', 'g')), "
            "CAST(w.ACTUALFINISHDATE AS VARCHAR) "
            "FROM azteca_WORKORDER w WHERE CAST(w.WORKORDERID AS VARCHAR) = ? "
            f"AND w.DESCRIPTION IN ({', '.join('?' for _ in ELIGIBLE_WORKORDER_DESCRIPTIONS)})",
            [workorder_id.strip(), *ELIGIBLE_WORKORDER_DESCRIPTIONS],
        ).fetchone()
        if workorder is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Work order {workorder_id} is not one of the work order kinds this "
                    f"resource closes out ({', '.join(ELIGIBLE_WORKORDER_DESCRIPTIONS)})."
                ),
            )
        rows = connection.execute(
            """
            SELECT DISTINCT ENTITYUID, ENTITYTYPE FROM azteca_WORKORDERENTITY
            WHERE CAST(WORKORDERID AS VARCHAR) = ? AND ENTITYTYPE IN (?, ?, ?, ?)
            ORDER BY ENTITYTYPE, ENTITYUID
            """,
            [workorder_id.strip(), *CITYWORKS_STORM_ENTITY_TYPES],
        ).fetchall()
    assets = [
        {"asset_id": str(row[0]), "entity_type": row[1]}
        for row in rows
        if ASSET_ID_PATTERN.fullmatch(str(row[0]) or "")
    ]
    return {
        "workorder": {
            "workorder_id": str(workorder[0]),
            "description": workorder[1],
            "project_name": workorder[2],
            "actual_finish": workorder[3],
        },
        "assets": assets,
    }


def _validated_export_status(status: str) -> str:
    if status != "all" and status not in PROJECT_STATUSES:
        raise HTTPException(status_code=422, detail=f"Unknown status {status!r}.")
    return status


def _flat_template_rows(coordinator: Any, status: str) -> list[dict[str, Any]]:
    """One row per asset in the master workbook's column order, plus review context."""
    rows: list[dict[str, Any]] = []
    for entity in coordinator.query_entities(
        CLOSEOUT_PROJECT_ENTITY_TYPE,
        filters=None if status == "all" else {"status": status},
        order_by=(("date_of_analysis", False), ("global_id", False)),
    ):
        values = _entity_values(entity)
        if values is None:
            continue
        for asset in _project_assets(coordinator, str(entity["entity_id"])):
            row = dict(
                zip(
                    TEMPLATE_HEADINGS,
                    (
                        asset.get("asset_id"),
                        asset.get("construction_plan_id"),
                        asset.get("critical_facility_id"),
                        values.get("source_of_analysis"),
                        values.get("cityworks_wo_id"),
                        values.get("project_name"),
                        values.get("date_of_analysis"),
                        asset.get("flooding_design_standards"),
                        asset.get("flooding_impact"),
                        asset.get("flooding_service_eligibility"),
                        asset.get("post_project_asset_condition"),
                        asset.get("notes"),
                    ),
                )
            )
            row["Status"] = values.get("status")
            row["project_global_id"] = str(entity["entity_id"])
            rows.append(row)
    return rows


@router.get("/asset-candidates")
def asset_candidates(
    query: str = Query(min_length=3, max_length=10),
    limit: int = Query(default=10, ge=1, le=10),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Asset IDs from the live inventory, for the picker on the new-project dialog.

    Delegates to the Asset History search so pipes, structures and ditches all resolve
    through one definition of what an asset is, but is gated on this resource's own
    permission rather than that one's.
    """
    _require_permission(db, current_user, *READ_PERMISSION_TYPES)
    from portal.app.resources.tables.storm_water_asset_history.source import search_assets

    try:
        matches = search_assets(query.strip(), limit)
    except Exception:
        # A missing or unreadable inventory mirror must not break project entry, and an
        # error on every keystroke is worse than an empty list. HTTPException is caught
        # too: search_assets raises 503 when the inventory source is not configured.
        return {"query": query.strip(), "candidates": []}
    return {
        "query": query.strip(),
        "candidates": [
            {
                "asset_id": item["asset_id"],
                "asset_type": item.get("asset_type"),
                "subtitle": item.get("subtitle"),
            }
            for item in matches
        ],
    }


@router.get("/rows")
def flat_rows(
    status: str = Query(default="all"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """The spreadsheet view: every asset row in the master workbook's shape."""
    _require_permission(db, current_user, *READ_PERMISSION_TYPES)
    rows = _flat_template_rows(_coordinator(current_user), _validated_export_status(status))
    # The same template the asset-history and planning resources link through, so a
    # deployment configures the Cityworks host in one place.
    template = str(os.getenv("PORTAL_CITYWORKS_WORKORDER_URL_TEMPLATE") or "").strip()
    return {
        "headings": list(TEMPLATE_HEADINGS),
        "rows": rows,
        "workorder_url_template": template or None,
    }


CLOSEOUT_ATTACHMENT_TABLE = "azteca_WORKORDERIMG"
ATTACHMENT_FILE_LIMIT_BYTES = 30 * 1024 * 1024


class CloseoutAttachmentImportRequest(BaseModel):
    dry_run: bool = True


def _workorder_attachments(workorder_id: str) -> list[dict[str, Any]]:
    database = _cityworks_database()
    if not database.is_file():
        raise HTTPException(status_code=503, detail="The Cityworks work order mirror is not available.")
    with closing(duckdb.connect(str(database), read_only=True)) as connection:
        try:
            rows = connection.execute(
                f"""
                SELECT IMAGEPATH, TITLE, ATTACHEDBY,
                       CAST(DATETIMEATTACHED AS VARCHAR) AS attached_at
                FROM {CLOSEOUT_ATTACHMENT_TABLE}
                WHERE CAST(WORKORDERID AS VARCHAR) = ?
                ORDER BY DATETIMEATTACHED DESC NULLS LAST
                """,
                [workorder_id.strip()],
            ).fetchall()
        except duckdb.CatalogException as error:
            raise HTTPException(
                status_code=503,
                detail=(
                    "The Cityworks mirror does not include azteca_WORKORDERIMG yet. "
                    "Run the source refresh on the Manager workstation first."
                ),
            ) from error
    return [
        {
            "image_path": str(row[0] or ""),
            "title": row[1],
            "attached_by": row[2],
            "attached_at": row[3],
        }
        for row in rows
    ]


def _scan_attachment_candidates(
    attachments: list[dict[str, Any]]
) -> tuple[dict[str, Any] | None, bytes | None, list[dict[str, Any]]]:
    """Return (newest eligible attachment, its bytes, every candidate with its verdict).

    Eligible means: an .xlsx file, reachable on the share, whose sheet carries every
    required close-out column. Attachments are already newest-first, so the first
    eligible one is the import source.
    """
    candidates: list[dict[str, Any]] = []
    selected: dict[str, Any] | None = None
    selected_content: bytes | None = None
    for attachment in attachments:
        path_text = attachment["image_path"]
        entry = {**attachment, "file_name": Path(path_text).name, "eligible": False, "reason": ""}
        lowered = path_text.lower()
        if not lowered.endswith((".xlsx", ".xls")):
            # A work order carries plans, photos and PDFs; listing every one of them as
            # "not an Excel file" buries the reason the Excel that is there was rejected.
            continue
        if lowered.endswith(".xls"):
            entry["reason"] = "Legacy .xls format; save it as .xlsx to import."
            candidates.append(entry)
            continue
        path = Path(path_text)
        try:
            if not path.is_file():
                entry["reason"] = "The file is not reachable on the attachment share."
                candidates.append(entry)
                continue
            if path.stat().st_size > ATTACHMENT_FILE_LIMIT_BYTES:
                entry["reason"] = "The file is larger than 30 MB."
                candidates.append(entry)
                continue
            content = path.read_bytes()
        except OSError:
            entry["reason"] = "The attachment share could not be read."
            candidates.append(entry)
            continue
        rows, errors = parse_template_workbook(content)
        if not rows and errors:
            entry["reason"] = errors[0]
            candidates.append(entry)
            continue
        entry["eligible"] = True
        if selected is None:
            entry["reason"] = "Newest eligible close-out table."
            selected = entry
            selected_content = content
        candidates.append(entry)
    return selected, selected_content, candidates


@router.post("/cityworks/workorders/{workorder_id}/import-attachment")
def import_workorder_attachment(
    workorder_id: str,
    payload: CloseoutAttachmentImportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Import the newest eligible close-out Excel attached to a work order."""
    _require_permission(db, current_user, *CREATE_PERMISSION_TYPES)
    attachments = _workorder_attachments(workorder_id)
    selected, content, candidates = _scan_attachment_candidates(attachments)
    result: dict[str, Any] = {
        "workorder_id": workorder_id,
        "candidates": candidates,
        "selected": selected,
        "summary": None,
    }
    if selected is None or content is None:
        return result
    result["summary"] = _import_workbook_content(
        content,
        str(selected["file_name"]),
        dry_run=payload.dry_run,
        approve_immediately=False,
        db=db,
        current_user=current_user,
        default_workorder=workorder_id.strip(),
        intake_method="cityworks",
    )
    return result


class CloseoutExportRequest(BaseModel):
    status: str = "all"
    # "<project_global_id>|<Asset ID>" for the spreadsheet view, project ids for the
    # card view. Both empty means the whole status.
    asset_keys: list[str] | None = None
    project_global_ids: list[str] | None = None


@router.post("/export")
def export_selection(
    payload: CloseoutExportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Export exactly the rows the page is showing.

    The page filters client-side, so it sends back which rows survived rather than a
    filter expression: the workbook then cannot disagree with the screen, and the
    filter semantics stay defined in one place.
    """
    _require_permission(db, current_user, *READ_PERMISSION_TYPES)
    _validated_export_status(payload.status)
    coordinator = _coordinator(current_user)
    rows = _flat_template_rows(coordinator, payload.status)
    if payload.asset_keys is not None:
        wanted = set(payload.asset_keys)
        rows = [
            row for row in rows
            if f"{row.get('project_global_id')}|{row.get('Asset ID')}" in wanted
        ]
    elif payload.project_global_ids is not None:
        projects = set(payload.project_global_ids)
        rows = [row for row in rows if str(row.get("project_global_id")) in projects]
    filename = f"DesignProjectCloseOutAssetTable_{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"
    return Response(
        content=build_template_workbook(rows),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export")
def export_projects(
    status: str = Query(default="approved"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    _require_permission(db, current_user, *READ_PERMISSION_TYPES)
    _validated_export_status(status)
    coordinator = _coordinator(current_user)
    rows = _flat_template_rows(coordinator, status)
    label = "master" if status == "approved" else ("all" if status == "all" else status)
    filename = f"DesignProjectCloseOutAssetTable_{label}_{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"
    return Response(
        content=build_template_workbook(rows),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
