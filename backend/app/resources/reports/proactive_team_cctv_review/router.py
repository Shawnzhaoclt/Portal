from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.app.management.database import engine, get_db
from backend.app.management.models import Team, User
from backend.app.management.router import get_current_user
from backend.app.management.security import utc_now_text
from backend.app.management.services import ADMIN_ROLES, selected_user_role, write_audit_log


RESOURCE_ID = "RPT5W1C0"
REPORTS_TABLE = f"{RESOURCE_ID}_reports"
PIPES_TABLE = f"{RESOURCE_ID}_pipes"
DISTANCE_GROUPS_TABLE = f"{RESOURCE_ID}_distance_groups"
OBSERVATIONS_TABLE = f"{RESOURCE_ID}_observations"
EVENTS_TABLE = f"{RESOURCE_ID}_report_events"

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


def ensure_report_schema() -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                f"""
                CREATE TABLE IF NOT EXISTS "{REPORTS_TABLE}" (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    report_key TEXT NOT NULL UNIQUE,
                    report_name TEXT NOT NULL,
                    binding_type TEXT NOT NULL CHECK (binding_type IN ('address', 'project_title')),
                    binding_text TEXT NOT NULL,
                    inspection_date_text TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'ready_to_review', 'completed')),
                    created_by_user_id INTEGER,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_by_user_id INTEGER,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    submitted_by_user_id INTEGER,
                    submitted_at TEXT,
                    reviewed_by_user_id INTEGER,
                    reviewed_at TEXT,
                    FOREIGN KEY(created_by_user_id) REFERENCES SYS_USERS (id) ON DELETE SET NULL,
                    FOREIGN KEY(updated_by_user_id) REFERENCES SYS_USERS (id) ON DELETE SET NULL,
                    FOREIGN KEY(submitted_by_user_id) REFERENCES SYS_USERS (id) ON DELETE SET NULL,
                    FOREIGN KEY(reviewed_by_user_id) REFERENCES SYS_USERS (id) ON DELETE SET NULL
                )
                """
            )
        )
        connection.execute(
            text(
                f"""
                CREATE TABLE IF NOT EXISTS "{PIPES_TABLE}" (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    report_id INTEGER NOT NULL,
                    ml_id TEXT NOT NULL,
                    mli_id TEXT NOT NULL,
                    clogging_percent INTEGER NOT NULL DEFAULT 0,
                    clogging_comment TEXT,
                    clogging_frame_seconds REAL,
                    FOREIGN KEY(report_id) REFERENCES "{REPORTS_TABLE}" (id) ON DELETE CASCADE
                )
                """
            )
        )
        connection.execute(
            text(
                f"""
                CREATE TABLE IF NOT EXISTS "{DISTANCE_GROUPS_TABLE}" (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    pipe_review_id INTEGER NOT NULL,
                    distance_key TEXT NOT NULL,
                    distance_feet REAL,
                    am_score INTEGER,
                    defect_comment TEXT,
                    no_am_score_ge_3_confirmed INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY(pipe_review_id) REFERENCES "{PIPES_TABLE}" (id) ON DELETE CASCADE
                )
                """
            )
        )
        connection.execute(
            text(
                f"""
                CREATE TABLE IF NOT EXISTS "{OBSERVATIONS_TABLE}" (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    distance_group_id INTEGER NOT NULL,
                    mlo_id TEXT,
                    source_observation_key TEXT NOT NULL,
                    defect_role TEXT NOT NULL CHECK (defect_role IN ('none', 'major', 'other')),
                    is_extensive INTEGER NOT NULL DEFAULT 0,
                    selected_picture_file_name TEXT,
                    FOREIGN KEY(distance_group_id) REFERENCES "{DISTANCE_GROUPS_TABLE}" (id) ON DELETE CASCADE
                )
                """
            )
        )
        connection.execute(
            text(
                f"""
                CREATE TABLE IF NOT EXISTS "{EVENTS_TABLE}" (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    report_id INTEGER NOT NULL,
                    event_type TEXT NOT NULL CHECK (
                        event_type IN (
                            'report_saved',
                            'submitted_to_review',
                            'returned_to_edit',
                            'completed',
                            'export_generated',
                            'export_failed'
                        )
                    ),
                    event_by_user_id INTEGER NOT NULL,
                    event_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    from_status TEXT,
                    to_status TEXT,
                    memo TEXT,
                    FOREIGN KEY(report_id) REFERENCES "{REPORTS_TABLE}" (id) ON DELETE CASCADE,
                    FOREIGN KEY(event_by_user_id) REFERENCES SYS_USERS (id) ON DELETE CASCADE
                )
                """
            )
        )
        connection.execute(text(f'CREATE UNIQUE INDEX IF NOT EXISTS "ux_{REPORTS_TABLE}_report_key" ON "{REPORTS_TABLE}" (report_key)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{REPORTS_TABLE}_binding" ON "{REPORTS_TABLE}" (binding_type, binding_text)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{REPORTS_TABLE}_inspection_date_text" ON "{REPORTS_TABLE}" (inspection_date_text)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{REPORTS_TABLE}_status" ON "{REPORTS_TABLE}" (status)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{REPORTS_TABLE}_updated_at" ON "{REPORTS_TABLE}" (updated_at)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{PIPES_TABLE}_report_id" ON "{PIPES_TABLE}" (report_id)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{DISTANCE_GROUPS_TABLE}_pipe_review_id" ON "{DISTANCE_GROUPS_TABLE}" (pipe_review_id)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{OBSERVATIONS_TABLE}_distance_group_id" ON "{OBSERVATIONS_TABLE}" (distance_group_id)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{EVENTS_TABLE}_report_id" ON "{EVENTS_TABLE}" (report_id)'))

        report_rows = connection.execute(
            text(f'SELECT id, report_key, report_name FROM "{REPORTS_TABLE}"')
        ).mappings().all()
        for row in report_rows:
            report_id = int(row["id"])
            current_key = str(row["report_key"] or "")
            normalized_key = _normalize_report_key(current_key)
            current_name = str(row["report_name"] or "")
            normalized_name = _normalize_report_key(current_name) or normalized_key

            key_can_be_updated = bool(normalized_key and normalized_key != current_key)
            if key_can_be_updated:
                duplicate = connection.execute(
                    text(f'SELECT id FROM "{REPORTS_TABLE}" WHERE report_key = :report_key AND id <> :report_id LIMIT 1'),
                    {"report_key": normalized_key, "report_id": report_id},
                ).first()
                key_can_be_updated = duplicate is None

            if key_can_be_updated:
                connection.execute(
                    text(f'UPDATE "{REPORTS_TABLE}" SET report_key = :report_key, report_name = :report_name WHERE id = :report_id'),
                    {"report_key": normalized_key, "report_name": normalized_name, "report_id": report_id},
                )
            elif normalized_name and normalized_name != current_name:
                connection.execute(
                    text(f'UPDATE "{REPORTS_TABLE}" SET report_name = :report_name WHERE id = :report_id'),
                    {"report_name": normalized_name, "report_id": report_id},
                )


def _display_name(first_name: str | None, last_name: str | None) -> str | None:
    name = f"{first_name or ''} {last_name or ''}".strip()
    return name or None


def _normalize_report_key(value: str) -> str:
    compact = re.sub(r"\s*@\s*", "@", value.strip())
    compact = re.sub(r"\s*-\s*", "-", compact)
    return re.sub(r"\s+", "", compact)


def _report_row(row: Any, can_delete: bool | None = None) -> dict[str, Any]:
    report = {
        "id": row.id,
        "report_key": row.report_key,
        "report_name": row.report_name,
        "binding_type": row.binding_type,
        "binding_text": row.binding_text,
        "inspection_date_text": row.inspection_date_text,
        "status": row.status,
        "created_by_user_id": row.created_by_user_id,
        "created_by_name": _display_name(row.created_first_name, row.created_last_name),
        "created_at": row.created_at,
        "updated_by_user_id": row.updated_by_user_id,
        "updated_by_name": _display_name(row.updated_first_name, row.updated_last_name),
        "updated_at": row.updated_at,
        "submitted_by_user_id": row.submitted_by_user_id,
        "submitted_by_name": _display_name(row.submitted_first_name, row.submitted_last_name),
        "submitted_at": row.submitted_at,
        "reviewed_by_user_id": row.reviewed_by_user_id,
        "reviewed_by_name": _display_name(row.reviewed_first_name, row.reviewed_last_name),
        "reviewed_at": row.reviewed_at,
    }
    if can_delete is not None:
        report["can_delete"] = can_delete
    return report


def _event_row(row: Any) -> dict[str, Any]:
    return {
        "id": row.id,
        "report_id": row.report_id,
        "event_type": row.event_type,
        "event_by_user_id": row.event_by_user_id,
        "event_by_name": _display_name(row.event_first_name, row.event_last_name),
        "event_at": row.event_at,
        "from_status": row.from_status,
        "to_status": row.to_status,
        "memo": row.memo,
    }


def _saved_observation_row(row: Any) -> dict[str, Any]:
    return {
        "id": row.id,
        "distance_group_id": row.distance_group_id,
        "mlo_id": row.mlo_id,
        "source_observation_key": row.source_observation_key,
        "defect_role": row.defect_role,
        "is_extensive": bool(row.is_extensive),
        "selected_picture_file_name": row.selected_picture_file_name,
    }


def _saved_distance_group_row(row: Any, observations: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": row.id,
        "pipe_review_id": row.pipe_review_id,
        "distance_key": row.distance_key,
        "distance_feet": row.distance_feet,
        "am_score": row.am_score,
        "defect_comment": row.defect_comment,
        "no_am_score_ge_3_confirmed": bool(row.no_am_score_ge_3_confirmed),
        "observations": observations,
    }


def _saved_pipe_row(row: Any, distance_groups: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": row.id,
        "report_id": row.report_id,
        "ml_id": row.ml_id,
        "mli_id": row.mli_id,
        "clogging_percent": row.clogging_percent,
        "clogging_comment": row.clogging_comment,
        "clogging_frame_seconds": row.clogging_frame_seconds,
        "distance_groups": distance_groups,
    }


def _select_report_row(db: Session, report_id: int) -> Any:
    return db.execute(
        text(
            f"""
            SELECT
                r.*,
                created.first_name AS created_first_name,
                created.last_name AS created_last_name,
                updated.first_name AS updated_first_name,
                updated.last_name AS updated_last_name,
                submitted.first_name AS submitted_first_name,
                submitted.last_name AS submitted_last_name,
                reviewed.first_name AS reviewed_first_name,
                reviewed.last_name AS reviewed_last_name
            FROM "{REPORTS_TABLE}" r
            LEFT JOIN SYS_USERS created ON created.id = r.created_by_user_id
            LEFT JOIN SYS_USERS updated ON updated.id = r.updated_by_user_id
            LEFT JOIN SYS_USERS submitted ON submitted.id = r.submitted_by_user_id
            LEFT JOIN SYS_USERS reviewed ON reviewed.id = r.reviewed_by_user_id
            WHERE r.id = :report_id
            """
        ),
        {"report_id": report_id},
    ).mappings().first()


def _is_manager_or_admin(db: Session, user: User) -> bool:
    if selected_user_role(user) in ADMIN_ROLES:
        return True
    managed_team = db.scalar(select(Team.id).where(Team.manager_user_id == user.id).limit(1))
    return managed_team is not None


def _manager_can_delete_report(db: Session, user: User, created_by_user_id: int | None) -> bool:
    if created_by_user_id is None:
        return False
    creator_team_manager_id = db.scalar(
        select(Team.manager_user_id)
        .join(User, User.team_id == Team.id)
        .where(User.id == created_by_user_id)
    )
    if creator_team_manager_id is None:
        return False
    return int(creator_team_manager_id) == user.id


def _can_delete_report(db: Session, user: User, row: Any) -> bool:
    if selected_user_role(user) in ADMIN_ROLES:
        return True
    if str(row.status) != "pending":
        return False
    if row.created_by_user_id == user.id:
        return True
    return _manager_can_delete_report(db, user, row.created_by_user_id)


def _delete_report_related_rows(db: Session, report_id: int) -> dict[str, int]:
    observations_result = db.execute(
        text(
            f"""
            DELETE FROM "{OBSERVATIONS_TABLE}"
            WHERE distance_group_id IN (
                SELECT dg.id
                FROM "{DISTANCE_GROUPS_TABLE}" dg
                INNER JOIN "{PIPES_TABLE}" p ON p.id = dg.pipe_review_id
                WHERE p.report_id = :report_id
            )
            """
        ),
        {"report_id": report_id},
    )
    distance_groups_result = db.execute(
        text(
            f"""
            DELETE FROM "{DISTANCE_GROUPS_TABLE}"
            WHERE pipe_review_id IN (
                SELECT id FROM "{PIPES_TABLE}" WHERE report_id = :report_id
            )
            """
        ),
        {"report_id": report_id},
    )
    pipes_result = db.execute(text(f'DELETE FROM "{PIPES_TABLE}" WHERE report_id = :report_id'), {"report_id": report_id})
    events_result = db.execute(text(f'DELETE FROM "{EVENTS_TABLE}" WHERE report_id = :report_id'), {"report_id": report_id})
    report_result = db.execute(text(f'DELETE FROM "{REPORTS_TABLE}" WHERE id = :report_id'), {"report_id": report_id})
    return {
        "observations": max(observations_result.rowcount or 0, 0),
        "distance_groups": max(distance_groups_result.rowcount or 0, 0),
        "pipes": max(pipes_result.rowcount or 0, 0),
        "events": max(events_result.rowcount or 0, 0),
        "reports": max(report_result.rowcount or 0, 0),
    }


@router.get("/api/reports/proactive-team-cctv-review/reports")
def list_reports(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    ensure_report_schema()
    rows = db.execute(
        text(
            f"""
            SELECT
                r.*,
                created.first_name AS created_first_name,
                created.last_name AS created_last_name,
                updated.first_name AS updated_first_name,
                updated.last_name AS updated_last_name,
                submitted.first_name AS submitted_first_name,
                submitted.last_name AS submitted_last_name,
                reviewed.first_name AS reviewed_first_name,
                reviewed.last_name AS reviewed_last_name
            FROM "{REPORTS_TABLE}" r
            LEFT JOIN SYS_USERS created ON created.id = r.created_by_user_id
            LEFT JOIN SYS_USERS updated ON updated.id = r.updated_by_user_id
            LEFT JOIN SYS_USERS submitted ON submitted.id = r.submitted_by_user_id
            LEFT JOIN SYS_USERS reviewed ON reviewed.id = r.reviewed_by_user_id
            ORDER BY r.updated_at DESC, r.id DESC
            LIMIT :limit OFFSET :offset
            """
        ),
        {"limit": limit, "offset": offset},
    ).mappings().all()
    total = db.execute(text(f'SELECT COUNT(*) FROM "{REPORTS_TABLE}"')).scalar_one()
    return {"reports": [_report_row(row, can_delete=_can_delete_report(db, current_user, row)) for row in rows], "total": int(total)}


@router.get("/api/reports/proactive-team-cctv-review/reports/{report_id}")
def get_report_detail(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ensure_report_schema()
    report = _select_report_row(db, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report was not found.")

    pipe_rows = db.execute(
        text(
            f"""
            SELECT *
            FROM "{PIPES_TABLE}"
            WHERE report_id = :report_id
            ORDER BY id ASC
            """
        ),
        {"report_id": report_id},
    ).mappings().all()

    pipes: list[dict[str, Any]] = []
    for pipe in pipe_rows:
        distance_rows = db.execute(
            text(
                f"""
                SELECT *
                FROM "{DISTANCE_GROUPS_TABLE}"
                WHERE pipe_review_id = :pipe_review_id
                ORDER BY id ASC
                """
            ),
            {"pipe_review_id": pipe.id},
        ).mappings().all()

        distance_groups: list[dict[str, Any]] = []
        for distance_group in distance_rows:
            observation_rows = db.execute(
                text(
                    f"""
                    SELECT *
                    FROM "{OBSERVATIONS_TABLE}"
                    WHERE distance_group_id = :distance_group_id
                    ORDER BY id ASC
                    """
                ),
                {"distance_group_id": distance_group.id},
            ).mappings().all()
            distance_groups.append(_saved_distance_group_row(distance_group, [_saved_observation_row(row) for row in observation_rows]))

        pipes.append(_saved_pipe_row(pipe, distance_groups))

    return {
        "report": _report_row(report, can_delete=_can_delete_report(db, current_user, report)),
        "pipes": pipes,
    }


@router.post("/api/reports/proactive-team-cctv-review/reports/save")
def save_report(
    payload: ReportSaveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ensure_report_schema()
    report_key = _normalize_report_key(payload.report_key)
    report_name = _normalize_report_key(payload.report_name) or report_key
    binding_text = payload.binding_text.strip()
    inspection_date_text = payload.inspection_date_text.strip()
    if not report_key:
        raise HTTPException(status_code=400, detail="Report key is required.")
    if not report_name:
        raise HTTPException(status_code=400, detail="Report name is required.")
    if not binding_text:
        raise HTTPException(status_code=400, detail="Report binding text is required.")
    if not inspection_date_text:
        raise HTTPException(status_code=400, detail="Inspection date text is required.")
    if not payload.pipes:
        raise HTTPException(status_code=400, detail="At least one reviewed pipe is required.")

    now = utc_now_text()
    report = db.execute(
        text(f'SELECT id, status FROM "{REPORTS_TABLE}" WHERE report_key = :report_key'),
        {"report_key": report_key},
    ).mappings().first()
    created = report is None

    try:
        if report is None:
            db.execute(
                text(
                    f"""
                    INSERT INTO "{REPORTS_TABLE}" (
                        report_key, report_name, binding_type, binding_text, inspection_date_text,
                        status, created_by_user_id, created_at, updated_by_user_id, updated_at
                    )
                    VALUES (
                        :report_key, :report_name, :binding_type, :binding_text, :inspection_date_text,
                        'pending', :user_id, :now, :user_id, :now
                    )
                    """
                ),
                {
                    "report_key": report_key,
                    "report_name": report_name,
                    "binding_type": payload.binding_type,
                    "binding_text": binding_text,
                    "inspection_date_text": inspection_date_text,
                    "user_id": current_user.id,
                    "now": now,
                },
            )
            report_id = int(db.execute(text("SELECT last_insert_rowid()")).scalar_one())
            from_status = None
            to_status = "pending"
        else:
            report_id = int(report["id"])
            from_status = str(report["status"])
            if from_status == "ready_to_review":
                raise HTTPException(status_code=400, detail="Return the report to edit before saving changes.")
            if from_status == "completed":
                raise HTTPException(status_code=400, detail="Completed reports cannot be edited.")

            db.execute(
                text(
                    f"""
                    UPDATE "{REPORTS_TABLE}"
                    SET report_name = :report_name,
                        binding_type = :binding_type,
                        binding_text = :binding_text,
                        inspection_date_text = :inspection_date_text,
                        status = 'pending',
                        updated_by_user_id = :user_id,
                        updated_at = :now
                    WHERE id = :report_id
                    """
                ),
                {
                    "report_name": report_name,
                    "binding_type": payload.binding_type,
                    "binding_text": binding_text,
                    "inspection_date_text": inspection_date_text,
                    "user_id": current_user.id,
                    "now": now,
                    "report_id": report_id,
                },
            )
            to_status = "pending"

        db.execute(
            text(
                f"""
                DELETE FROM "{OBSERVATIONS_TABLE}"
                WHERE distance_group_id IN (
                    SELECT dg.id
                    FROM "{DISTANCE_GROUPS_TABLE}" dg
                    INNER JOIN "{PIPES_TABLE}" p ON p.id = dg.pipe_review_id
                    WHERE p.report_id = :report_id
                )
                """
            ),
            {"report_id": report_id},
        )
        db.execute(
            text(
                f"""
                DELETE FROM "{DISTANCE_GROUPS_TABLE}"
                WHERE pipe_review_id IN (
                    SELECT id FROM "{PIPES_TABLE}" WHERE report_id = :report_id
                )
                """
            ),
            {"report_id": report_id},
        )
        db.execute(text(f'DELETE FROM "{PIPES_TABLE}" WHERE report_id = :report_id'), {"report_id": report_id})

        for pipe in payload.pipes:
            pipe_result = db.execute(
                text(
                    f"""
                    INSERT INTO "{PIPES_TABLE}" (
                        report_id, ml_id, mli_id, clogging_percent, clogging_comment, clogging_frame_seconds
                    )
                    VALUES (
                        :report_id, :ml_id, :mli_id, :clogging_percent, :clogging_comment, :clogging_frame_seconds
                    )
                    """
                ),
                {
                    "report_id": report_id,
                    "ml_id": pipe.ml_id,
                    "mli_id": pipe.mli_id,
                    "clogging_percent": pipe.clogging_percent,
                    "clogging_comment": pipe.clogging_comment,
                    "clogging_frame_seconds": pipe.clogging_frame_seconds,
                },
            )
            pipe_review_id = int(pipe_result.lastrowid or db.execute(text("SELECT last_insert_rowid()")).scalar_one())

            for distance_group in pipe.distance_groups:
                distance_result = db.execute(
                    text(
                        f"""
                        INSERT INTO "{DISTANCE_GROUPS_TABLE}" (
                            pipe_review_id, distance_key, distance_feet, am_score, defect_comment, no_am_score_ge_3_confirmed
                        )
                        VALUES (
                            :pipe_review_id, :distance_key, :distance_feet, :am_score, :defect_comment, :no_am_score_ge_3_confirmed
                        )
                        """
                    ),
                    {
                        "pipe_review_id": pipe_review_id,
                        "distance_key": distance_group.distance_key,
                        "distance_feet": distance_group.distance_feet,
                        "am_score": distance_group.am_score,
                        "defect_comment": distance_group.defect_comment,
                        "no_am_score_ge_3_confirmed": 1 if distance_group.no_am_score_ge_3_confirmed else 0,
                    },
                )
                distance_group_id = int(distance_result.lastrowid or db.execute(text("SELECT last_insert_rowid()")).scalar_one())

                for observation in distance_group.observations:
                    db.execute(
                        text(
                            f"""
                            INSERT INTO "{OBSERVATIONS_TABLE}" (
                                distance_group_id, mlo_id, source_observation_key, defect_role, is_extensive, selected_picture_file_name
                            )
                            VALUES (
                                :distance_group_id, :mlo_id, :source_observation_key, :defect_role, :is_extensive, :selected_picture_file_name
                            )
                            """
                        ),
                        {
                            "distance_group_id": distance_group_id,
                            "mlo_id": observation.mlo_id,
                            "source_observation_key": observation.source_observation_key,
                            "defect_role": observation.defect_role,
                            "is_extensive": 1 if observation.is_extensive else 0,
                            "selected_picture_file_name": observation.selected_picture_file_name,
                        },
                    )

        db.execute(
            text(
                f"""
                INSERT INTO "{EVENTS_TABLE}" (
                    report_id, event_type, event_by_user_id, event_at, from_status, to_status, memo
                )
                VALUES (
                    :report_id, 'report_saved', :user_id, :now, :from_status, :to_status, :memo
                )
                """
            ),
            {
                "report_id": report_id,
                "user_id": current_user.id,
                "now": now,
                "from_status": from_status,
                "to_status": to_status,
                "memo": payload.memo,
            },
        )
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(error.orig)) from error

    saved_report = _select_report_row(db, report_id)
    if saved_report is None:
        raise HTTPException(status_code=404, detail="Saved report was not found.")
    return {"ok": True, "created": created, "report": _report_row(saved_report, can_delete=_can_delete_report(db, current_user, saved_report))}


@router.delete("/api/reports/proactive-team-cctv-review/reports/{report_id}")
def delete_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ensure_report_schema()
    report = db.execute(
        text(
            f"""
            SELECT id, report_key, report_name, status, created_by_user_id
            FROM "{REPORTS_TABLE}"
            WHERE id = :report_id
            """
        ),
        {"report_id": report_id},
    ).mappings().first()
    if report is None:
        raise HTTPException(status_code=404, detail="Report was not found.")

    is_admin_session = selected_user_role(current_user) in ADMIN_ROLES
    is_pending = str(report["status"]) == "pending"
    is_owner = report["created_by_user_id"] == current_user.id
    is_creator_manager = _manager_can_delete_report(db, current_user, report["created_by_user_id"])
    if not is_admin_session:
        if not is_pending:
            raise HTTPException(status_code=403, detail="Only administrators can delete reports that are not pending.")
        if not is_owner and not is_creator_manager:
            raise HTTPException(status_code=403, detail="Only the owner or a manager can delete this pending report.")

    deleted_counts = _delete_report_related_rows(db, report_id)
    write_audit_log(
        db,
        current_user,
        "delete_cctv_review_report",
        "report",
        report_id,
        {
            "resource_id": RESOURCE_ID,
            "report_key": report["report_key"],
            "report_name": report["report_name"],
            "status": report["status"],
        },
    )
    db.commit()
    return {"ok": True, "report_id": report_id, "deleted": deleted_counts}


@router.get("/api/reports/proactive-team-cctv-review/reports/{report_id}/events")
def list_report_events(
    report_id: int,
    _current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ensure_report_schema()
    report_exists = db.execute(
        text(f'SELECT id FROM "{REPORTS_TABLE}" WHERE id = :report_id'),
        {"report_id": report_id},
    ).first()
    if report_exists is None:
        raise HTTPException(status_code=404, detail="Report was not found.")

    rows = db.execute(
        text(
            f"""
            SELECT
                e.*,
                event_user.first_name AS event_first_name,
                event_user.last_name AS event_last_name
            FROM "{EVENTS_TABLE}" e
            LEFT JOIN SYS_USERS event_user ON event_user.id = e.event_by_user_id
            WHERE e.report_id = :report_id
            ORDER BY e.event_at DESC, e.id DESC
            """
        ),
        {"report_id": report_id},
    ).mappings().all()
    return {"events": [_event_row(row) for row in rows], "total": len(rows)}


@router.patch("/api/reports/proactive-team-cctv-review/reports/{report_id}/status")
def update_report_status(
    report_id: int,
    payload: ReportStatusActionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ensure_report_schema()
    report = db.execute(
        text(f'SELECT id, status FROM "{REPORTS_TABLE}" WHERE id = :report_id'),
        {"report_id": report_id},
    ).mappings().first()
    if report is None:
        raise HTTPException(status_code=404, detail="Report was not found.")

    from_status = str(report["status"])
    now = utc_now_text()
    action = payload.action
    event_type = ""
    to_status = from_status
    extra_updates = ""

    if action == "submit_to_review":
        if from_status != "pending":
            raise HTTPException(status_code=400, detail="Only pending reports can be submitted to review.")
        to_status = "ready_to_review"
        event_type = "submitted_to_review"
        extra_updates = ", submitted_by_user_id = :user_id, submitted_at = :now"
    elif action == "return_to_edit":
        if from_status != "ready_to_review":
            raise HTTPException(status_code=400, detail="Only ready-to-review reports can be returned to edit.")
        to_status = "pending"
        event_type = "returned_to_edit"
        extra_updates = ", submitted_by_user_id = NULL, submitted_at = NULL, reviewed_by_user_id = NULL, reviewed_at = NULL"
    elif action == "complete":
        if from_status != "ready_to_review":
            raise HTTPException(status_code=400, detail="Only ready-to-review reports can be completed.")
        if not _is_manager_or_admin(db, current_user):
            raise HTTPException(status_code=403, detail="Only a manager or administrator can complete a report.")
        to_status = "completed"
        event_type = "completed"
        extra_updates = ", reviewed_by_user_id = :user_id, reviewed_at = :now"

    db.execute(
        text(
            f"""
            UPDATE "{REPORTS_TABLE}"
            SET status = :to_status,
                updated_by_user_id = :user_id,
                updated_at = :now
                {extra_updates}
            WHERE id = :report_id
            """
        ),
        {"to_status": to_status, "user_id": current_user.id, "now": now, "report_id": report_id},
    )
    db.execute(
        text(
            f"""
            INSERT INTO "{EVENTS_TABLE}" (
                report_id, event_type, event_by_user_id, event_at, from_status, to_status, memo
            )
            VALUES (
                :report_id, :event_type, :user_id, :now, :from_status, :to_status, :memo
            )
            """
        ),
        {
            "report_id": report_id,
            "event_type": event_type,
            "user_id": current_user.id,
            "now": now,
            "from_status": from_status,
            "to_status": to_status,
            "memo": payload.memo,
        },
    )
    db.commit()
    return {"ok": True, "report_id": report_id, "from_status": from_status, "to_status": to_status}
