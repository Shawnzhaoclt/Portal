from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


CCTV_REPORT_ENTITY_TYPE = "RPT5W1C0.report"
CCTV_PIPE_ENTITY_TYPE = "RPT5W1C0.pipe"
CCTV_DISTANCE_GROUP_ENTITY_TYPE = "RPT5W1C0.distance_group"
CCTV_OBSERVATION_ENTITY_TYPE = "RPT5W1C0.observation"
REVIEW_EVENT_ENTITY_TYPE = "SYS.review_event"
AIF_PROACTIVE_INSPECTION_ENTITY_TYPE = "SYS.aif_proactive_inspection"
USER_FAVORITE_ENTITY_TYPE = "SYS.user_favorite"
MLO_ENTITY_TYPE = "RPT5W1C0.mlo"
MEDIA_ENTITY_TYPE = "RPT5W1C0.media"
MLO_MEDIA_ENTITY_TYPE = "RPT5W1C0.mlo_media"


@dataclass(frozen=True)
class PhysicalEntitySpec:
    entity_type: str
    table: str
    value_columns: tuple[str, ...]
    dependency_order: int
    resource_id: str
    integer_columns: frozenset[str] = frozenset()
    real_columns: frozenset[str] = frozenset()
    boolean_columns: frozenset[str] = frozenset()
    datetime_columns: frozenset[str] = frozenset()
    sequence_columns: tuple[tuple[str, tuple[str, ...]], ...] = ()
    indexes: tuple[tuple[str, tuple[str, ...], bool], ...] = ()
    index_name_prefix: str | None = None

    @property
    def storage_columns(self) -> tuple[str, ...]:
        sequences = {name: columns for name, columns in self.sequence_columns}
        result: list[str] = []
        for column in self.value_columns:
            result.extend(sequences.get(column, (column,)))
        return tuple(result)


HOLIDAY_CALENDAR_ENTITY_TYPE = "ADMBSHVR.holiday_calendar"
HOLIDAY_ENTITY_TYPE = "ADMBSHVR.holiday"
WEEKLY_SUBMISSION_ENTITY_TYPE = "RPT7K2M9.weekly_submission"
WEEKLY_TIME_ENTRY_ENTITY_TYPE = "RPT7K2M9.time_entry"
WEEKLY_SCHEDULE_CHANGE_ENTITY_TYPE = "RPT7K2M9.schedule_change"
WEEKLY_SCHEDULE_OVERRIDE_ENTITY_TYPE = "RPT7K2M9.schedule_override"
WEEKLY_WORKFLOW_EVENT_ENTITY_TYPE = "RPT7K2M9.workflow_event"

WEEKLY_TIME_TABLE_RENAMES = {
    "RPT7K2M9_weekly_submissions": "WEEKLY_TIME_SUBMISSIONS",
    "RPT7K2M9_time_entries": "WEEKLY_TIME_ENTRIES",
    "RPT7K2M9_schedule_changes": "WEEKLY_TIME_SCHEDULE_CHANGES",
    "RPT7K2M9_schedule_overrides": "WEEKLY_TIME_SCHEDULE_OVERRIDES",
    "RPT7K2M9_workflow_events": "WEEKLY_TIME_WORKFLOW_EVENTS",
}

DAY_HOUR_COLUMNS = tuple(f"day_{index}_hours" for index in range(7))
SCHEDULE_DAY_COLUMNS = tuple(f"schedule_day_{index}" for index in range(7))
MANAGED_ENTITY_TYPE_PATTERN = re.compile(
    r"^(?:[A-Z]{3}[A-Z0-9]{5}|SYS)\.[a-z][a-z0-9_]*$"
)
RESOURCE_ID_PATTERN = re.compile(r"^[A-Z]{3}[A-Z0-9]{5}$")
SQL_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SYSTEM_RESOURCE_ID = "SYS"
SYSTEM_STORAGE_COLUMNS = (
    "global_id",
    "record_revision",
    "deleted",
    "conflict_state",
    "selected_operation_id",
)


REPORT_COLUMNS = (
    "id",
    "report_key",
    "report_name",
    "binding_type",
    "binding_text",
    "inspection_date_text",
    "status",
    "created_by_user_id",
    "created_by_name",
    "created_at",
    "updated_by_user_id",
    "updated_by_name",
    "updated_at",
    "submitted_by_user_id",
    "submitted_by_name",
    "submitted_at",
    "reviewed_by_user_id",
    "reviewed_by_name",
    "reviewed_at",
)
PIPE_COLUMNS = (
    "id",
    "report_global_id",
    "report_id",
    "ml_id",
    "mli_id",
    "clogging_percent",
    "clogging_comment",
    "clogging_frame_seconds",
)
DISTANCE_GROUP_COLUMNS = (
    "id",
    "report_global_id",
    "report_id",
    "pipe_global_id",
    "pipe_review_id",
    "ml_id",
    "mli_id",
    "distance_key",
    "distance_feet",
    "am_score",
    "defect_comment",
    "no_am_score_ge_3_confirmed",
)
OBSERVATION_COLUMNS = (
    "id",
    "report_global_id",
    "report_id",
    "pipe_global_id",
    "pipe_review_id",
    "distance_group_global_id",
    "distance_group_id",
    "ml_id",
    "mli_id",
    "distance_key",
    "distance_feet",
    "mlo_id",
    "source_observation_key",
    "defect_role",
    "is_extensive",
    "selected_picture_file_name",
)
REVIEW_EVENT_COLUMNS = (
    "resource_id",
    "resource_key",
    "resource_type",
    "subject_type",
    "subject_global_id",
    "subject_display_key",
    "event_type",
    "actor_user_id",
    "actor_name",
    "event_at",
    "from_status",
    "to_status",
    "memo",
    "correlation_id",
)
AIF_PROACTIVE_INSPECTION_COLUMNS = (
    "inspection_id",
    "entity_uid",
    "inspection_date",
    "inspected_by",
    "date_closed",
    "closed_by",
    "initiated_by",
    "date_initiated",
    "submitted_to",
    "date_submitted",
    "status",
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
    "clogging",
    "clogging_defect_callout",
    "clogging_service_eligibility",
    "clogging_related_flooding",
    "clogging_related_flooding_impact",
    "habitual_clogging",
    "engineering_design_project",
)
USER_FAVORITE_COLUMNS = (
    "owner_user_id",
    "owner_employee_number",
    "category",
    "resource_id",
    "sort_order",
    "created_at",
    "updated_at",
)
MLO_COLUMNS = (
    "MLO_ID",
    "MLI_ID",
    "Distance",
    "Code",
    "Observation_Text",
    "Value_1st_Dimension",
    "Value_2nd_Dimension",
    "Value_Percent",
    "Joint",
    "Clock_From",
    "Clock_To",
    "Grade",
    "Remarks",
    "Continuous",
    "VCR_Time",
    "Digital_Time",
    "OBS_Type",
)
MEDIA_COLUMNS = (
    "Media_ID",
    "Media_Path_ID",
    "CRC",
    "File_Name",
    "File_Path",
    "File_Type",
    "MediaExists",
)
MLO_MEDIA_COLUMNS = ("Media_ID", "MLO_ID")


PHYSICAL_ENTITY_SPECS = {
    CCTV_REPORT_ENTITY_TYPE: PhysicalEntitySpec(
        CCTV_REPORT_ENTITY_TYPE,
        "CCTV_REVIEW_REPORTS",
        REPORT_COLUMNS,
        100,
        "RPT5W1C0",
        integer_columns=frozenset({"id", "created_by_user_id", "updated_by_user_id", "submitted_by_user_id", "reviewed_by_user_id"}),
        indexes=(
            ("binding", ("binding_type", "binding_text"), False),
            ("inspection_date", ("inspection_date_text",), False),
            ("status_updated", ("status", "updated_at"), False),
            ("updated", ("updated_at", "id"), False),
        ),
    ),
    CCTV_PIPE_ENTITY_TYPE: PhysicalEntitySpec(
        CCTV_PIPE_ENTITY_TYPE,
        "CCTV_REVIEW_PIPES",
        PIPE_COLUMNS,
        110,
        "RPT5W1C0",
        integer_columns=frozenset({"id", "report_id", "clogging_percent"}),
        real_columns=frozenset({"clogging_frame_seconds"}),
        indexes=(
            ("report", ("report_global_id", "id"), False),
            ("source", ("ml_id", "mli_id"), False),
        ),
    ),
    CCTV_DISTANCE_GROUP_ENTITY_TYPE: PhysicalEntitySpec(
        CCTV_DISTANCE_GROUP_ENTITY_TYPE,
        "CCTV_REVIEW_DISTANCE_GROUPS",
        DISTANCE_GROUP_COLUMNS,
        120,
        "RPT5W1C0",
        integer_columns=frozenset({"id", "report_id", "pipe_review_id", "am_score", "no_am_score_ge_3_confirmed"}),
        real_columns=frozenset({"distance_feet"}),
        boolean_columns=frozenset({"no_am_score_ge_3_confirmed"}),
        indexes=(
            ("pipe", ("pipe_global_id", "id"), False),
            ("report", ("report_global_id", "pipe_review_id", "id"), False),
        ),
    ),
    CCTV_OBSERVATION_ENTITY_TYPE: PhysicalEntitySpec(
        CCTV_OBSERVATION_ENTITY_TYPE,
        "CCTV_REVIEW_OBSERVATIONS",
        OBSERVATION_COLUMNS,
        130,
        "RPT5W1C0",
        integer_columns=frozenset({"id", "report_id", "pipe_review_id", "distance_group_id", "is_extensive"}),
        real_columns=frozenset({"distance_feet"}),
        boolean_columns=frozenset({"is_extensive"}),
        indexes=(
            ("group", ("distance_group_global_id", "id"), False),
            ("report", ("report_global_id", "pipe_review_id", "distance_group_id", "id"), False),
            ("source", ("mlo_id", "source_observation_key"), False),
        ),
    ),
    REVIEW_EVENT_ENTITY_TYPE: PhysicalEntitySpec(
        REVIEW_EVENT_ENTITY_TYPE,
        "SYS_RESOURCE_REVIEW_EVENTS",
        REVIEW_EVENT_COLUMNS,
        140,
        SYSTEM_RESOURCE_ID,
        integer_columns=frozenset({"resource_id", "actor_user_id"}),
        indexes=(
            (
                "subject_time",
                (
                    "resource_key",
                    "subject_type",
                    "subject_global_id",
                    "deleted",
                    "event_at",
                    "global_id",
                ),
                False,
            ),
            ("resource_time", ("resource_key", "deleted", "event_at", "global_id"), False),
            ("actor_time", ("actor_user_id", "deleted", "event_at", "global_id"), False),
            (
                "type_time",
                ("resource_key", "event_type", "deleted", "event_at", "global_id"),
                False,
            ),
            (
                "correlation",
                ("resource_key", "correlation_id", "event_at", "global_id"),
                False,
            ),
            (
                "conflict",
                ("resource_key", "conflict_state", "event_at", "global_id"),
                False,
            ),
        ),
        index_name_prefix="SYS_RRE",
    ),
    AIF_PROACTIVE_INSPECTION_ENTITY_TYPE: PhysicalEntitySpec(
        AIF_PROACTIVE_INSPECTION_ENTITY_TYPE,
        "AIF_PROACTIVE_INSPECTIONS",
        AIF_PROACTIVE_INSPECTION_COLUMNS,
        150,
        SYSTEM_RESOURCE_ID,
        integer_columns=frozenset({"inspection_direction"}),
        real_columns=frozenset({"defect_stationing", "clogging"}),
        datetime_columns=frozenset({
            "inspection_date",
            "date_closed",
            "date_initiated",
            "date_submitted",
        }),
        indexes=(
            ("inspection_id", ("inspection_id",), True),
            ("entity_uid", ("entity_uid",), False),
            ("status", ("status",), False),
        ),
    ),
    USER_FAVORITE_ENTITY_TYPE: PhysicalEntitySpec(
        USER_FAVORITE_ENTITY_TYPE,
        "PORTAL_USER_FAVORITES",
        USER_FAVORITE_COLUMNS,
        160,
        SYSTEM_RESOURCE_ID,
        integer_columns=frozenset({"owner_user_id", "sort_order"}),
        datetime_columns=frozenset({"created_at", "updated_at"}),
        indexes=(
            ("owner_order", ("owner_employee_number", "category", "deleted", "sort_order", "global_id"), False),
            ("owner_category_resource", ("owner_employee_number", "category", "resource_id"), True),
        ),
        index_name_prefix="PORTAL_UF",
    ),
    MLO_ENTITY_TYPE: PhysicalEntitySpec(
        MLO_ENTITY_TYPE,
        "MLO",
        MLO_COLUMNS,
        400,
        "RPT5W1C0",
        real_columns=frozenset(
            {
                "Distance",
                "Value_1st_Dimension",
                "Value_2nd_Dimension",
                "Value_Percent",
                "Clock_From",
                "Clock_To",
                "Grade",
            }
        ),
        boolean_columns=frozenset({"Joint"}),
        indexes=(
            ("MLO_ID", ("MLO_ID",), True),
            ("MLI_ID", ("MLI_ID",), False),
            ("Code", ("Code",), False),
        ),
    ),
    MEDIA_ENTITY_TYPE: PhysicalEntitySpec(
        MEDIA_ENTITY_TYPE,
        "Media",
        MEDIA_COLUMNS,
        410,
        "RPT5W1C0",
        boolean_columns=frozenset({"MediaExists"}),
        indexes=(("Media_ID", ("Media_ID",), True),),
    ),
    MLO_MEDIA_ENTITY_TYPE: PhysicalEntitySpec(
        MLO_MEDIA_ENTITY_TYPE,
        "MLO_Media",
        MLO_MEDIA_COLUMNS,
        420,
        "RPT5W1C0",
        indexes=(
            ("Media_ID", ("Media_ID",), False),
            ("MLO_ID", ("MLO_ID",), False),
            ("relationship", ("MLO_ID", "Media_ID"), True),
        ),
    ),
    HOLIDAY_CALENDAR_ENTITY_TYPE: PhysicalEntitySpec(
        HOLIDAY_CALENDAR_ENTITY_TYPE,
        "ADMBSHVR_holiday_calendars",
        (
            "calendar_id", "calendar_year", "label", "notes",
            "created_by_user_id", "created_by_name", "created_at",
            "updated_by_user_id", "updated_by_name", "updated_at",
        ),
        200,
        "ADMBSHVR",
        integer_columns=frozenset({"calendar_year", "created_by_user_id", "updated_by_user_id"}),
        indexes=(("year", ("calendar_year",), True),),
    ),
    HOLIDAY_ENTITY_TYPE: PhysicalEntitySpec(
        HOLIDAY_ENTITY_TYPE,
        "ADMBSHVR_holidays",
        (
            "holiday_id", "calendar_id", "holiday_name", "holiday_date", "holiday_hours",
            "day_type", "applies_to_weekly_target", "extends_deliverable_deadline",
            "is_active", "notes", "created_by_user_id", "created_by_name", "created_at",
            "updated_by_user_id", "updated_by_name", "updated_at",
        ),
        210,
        "ADMBSHVR",
        integer_columns=frozenset({"created_by_user_id", "updated_by_user_id"}),
        real_columns=frozenset({"holiday_hours"}),
        boolean_columns=frozenset({"applies_to_weekly_target", "extends_deliverable_deadline", "is_active"}),
        indexes=(
            ("calendar_date", ("calendar_id", "holiday_date"), True),
            ("active_date", ("is_active", "holiday_date"), False),
        ),
    ),
    WEEKLY_SUBMISSION_ENTITY_TYPE: PhysicalEntitySpec(
        WEEKLY_SUBMISSION_ENTITY_TYPE,
        "WEEKLY_TIME_SUBMISSIONS",
        (
            "submission_id", "user_id", "employee_id", "employee_name", "team_id", "team_name",
            "week_start", "week_end", "status", "created_at", "updated_at", "submitted_at",
            "reviewed_at", "reviewed_by_user_id", "reviewed_by_name", "review_comments",
            "submitted_target_hours", "submitted_schedule_days",
        ),
        300,
        "RPT7K2M9",
        integer_columns=frozenset({"user_id", "team_id", "reviewed_by_user_id"}),
        real_columns=frozenset({"submitted_target_hours", *SCHEDULE_DAY_COLUMNS}),
        sequence_columns=(("submitted_schedule_days", SCHEDULE_DAY_COLUMNS),),
        indexes=(
            ("user_week", ("user_id", "week_start"), True),
            ("team_status_week", ("team_id", "status", "week_start"), False),
        ),
    ),
    WEEKLY_TIME_ENTRY_ENTITY_TYPE: PhysicalEntitySpec(
        WEEKLY_TIME_ENTRY_ENTITY_TYPE,
        "WEEKLY_TIME_ENTRIES",
        (
            "entry_id", "submission_id", "user_id", "employee_id", "entry_type", "work_date",
            "hours", "start_time", "end_time", "notes", "created_at", "updated_at",
        ),
        310,
        "RPT7K2M9",
        integer_columns=frozenset({"user_id"}),
        real_columns=frozenset({"hours"}),
        indexes=(
            ("submission_date", ("submission_id", "work_date"), False),
            ("user_date", ("user_id", "work_date"), False),
        ),
    ),
    WEEKLY_SCHEDULE_CHANGE_ENTITY_TYPE: PhysicalEntitySpec(
        WEEKLY_SCHEDULE_CHANGE_ENTITY_TYPE,
        "WEEKLY_TIME_SCHEDULE_CHANGES",
        (
            "request_id", "user_id", "employee_id", "employee_name", "team_id", "team_name",
            "week_start", "week_end", "reason", "daily_hours", "status", "created_at", "updated_at",
            "submitted_at", "reviewed_at", "reviewed_by_user_id", "reviewed_by_name", "review_comments",
        ),
        320,
        "RPT7K2M9",
        integer_columns=frozenset({"user_id", "team_id", "reviewed_by_user_id"}),
        real_columns=frozenset(DAY_HOUR_COLUMNS),
        sequence_columns=(("daily_hours", DAY_HOUR_COLUMNS),),
        indexes=(
            ("user_week", ("user_id", "week_start"), False),
            ("team_status_week", ("team_id", "status", "week_start"), False),
        ),
    ),
    WEEKLY_SCHEDULE_OVERRIDE_ENTITY_TYPE: PhysicalEntitySpec(
        WEEKLY_SCHEDULE_OVERRIDE_ENTITY_TYPE,
        "WEEKLY_TIME_SCHEDULE_OVERRIDES",
        (
            "override_id", "request_id", "user_id", "week_start", "daily_hours",
            "approved_by_user_id", "approved_by_name", "approved_at",
        ),
        330,
        "RPT7K2M9",
        integer_columns=frozenset({"user_id", "approved_by_user_id"}),
        real_columns=frozenset(DAY_HOUR_COLUMNS),
        sequence_columns=(("daily_hours", DAY_HOUR_COLUMNS),),
        indexes=(
            ("user_week", ("user_id", "week_start"), True),
            ("request", ("request_id",), False),
        ),
    ),
    WEEKLY_WORKFLOW_EVENT_ENTITY_TYPE: PhysicalEntitySpec(
        WEEKLY_WORKFLOW_EVENT_ENTITY_TYPE,
        "WEEKLY_TIME_WORKFLOW_EVENTS",
        (
            "event_id", "submission_id", "subject_user_id", "event_type", "week_start",
            "from_status", "to_status", "memo", "actor_user_id", "actor_name", "event_at",
        ),
        340,
        "RPT7K2M9",
        integer_columns=frozenset({"subject_user_id", "actor_user_id"}),
        indexes=(
            ("submission_time", ("submission_id", "event_at"), False),
            ("subject_week_time", ("subject_user_id", "week_start", "event_at"), False),
        ),
    ),
}


TYPED_BUSINESS_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS CCTV_REVIEW_REPORTS (
    global_id TEXT PRIMARY KEY,
    id INTEGER NOT NULL UNIQUE,
    report_key TEXT NOT NULL UNIQUE,
    report_name TEXT NOT NULL,
    binding_type TEXT NOT NULL CHECK (binding_type IN ('address', 'project_title')),
    binding_text TEXT NOT NULL,
    inspection_date_text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready_to_review', 'completed')),
    created_by_user_id INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by_user_id INTEGER NOT NULL,
    updated_by_name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submitted_by_user_id INTEGER,
    submitted_by_name TEXT,
    submitted_at TEXT,
    reviewed_by_user_id INTEGER,
    reviewed_by_name TEXT,
    reviewed_at TEXT,
    record_revision TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    conflict_state TEXT NOT NULL DEFAULT 'none',
    selected_operation_id TEXT
);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_REPORTS_binding ON CCTV_REVIEW_REPORTS(binding_type, binding_text);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_REPORTS_inspection_date ON CCTV_REVIEW_REPORTS(inspection_date_text);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_REPORTS_status_updated ON CCTV_REVIEW_REPORTS(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_REPORTS_updated ON CCTV_REVIEW_REPORTS(updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS CCTV_REVIEW_PIPES (
    global_id TEXT PRIMARY KEY,
    id INTEGER NOT NULL,
    report_global_id TEXT NOT NULL,
    report_id INTEGER NOT NULL,
    ml_id TEXT NOT NULL,
    mli_id TEXT NOT NULL,
    clogging_percent INTEGER NOT NULL DEFAULT 0,
    clogging_comment TEXT,
    clogging_frame_seconds REAL,
    record_revision TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    conflict_state TEXT NOT NULL DEFAULT 'none',
    selected_operation_id TEXT,
    FOREIGN KEY (report_global_id) REFERENCES CCTV_REVIEW_REPORTS(global_id),
    UNIQUE (report_global_id, ml_id, mli_id)
);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_PIPES_report ON CCTV_REVIEW_PIPES(report_global_id, id);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_PIPES_source ON CCTV_REVIEW_PIPES(ml_id, mli_id);

CREATE TABLE IF NOT EXISTS CCTV_REVIEW_DISTANCE_GROUPS (
    global_id TEXT PRIMARY KEY,
    id INTEGER NOT NULL,
    report_global_id TEXT NOT NULL,
    report_id INTEGER NOT NULL,
    pipe_global_id TEXT NOT NULL,
    pipe_review_id INTEGER NOT NULL,
    ml_id TEXT NOT NULL,
    mli_id TEXT NOT NULL,
    distance_key TEXT NOT NULL,
    distance_feet REAL,
    am_score INTEGER,
    defect_comment TEXT,
    no_am_score_ge_3_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (no_am_score_ge_3_confirmed IN (0, 1)),
    record_revision TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    conflict_state TEXT NOT NULL DEFAULT 'none',
    selected_operation_id TEXT,
    FOREIGN KEY (report_global_id) REFERENCES CCTV_REVIEW_REPORTS(global_id),
    FOREIGN KEY (pipe_global_id) REFERENCES CCTV_REVIEW_PIPES(global_id),
    UNIQUE (pipe_global_id, distance_key)
);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_DISTANCE_GROUPS_pipe ON CCTV_REVIEW_DISTANCE_GROUPS(pipe_global_id, id);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_DISTANCE_GROUPS_report ON CCTV_REVIEW_DISTANCE_GROUPS(report_global_id, pipe_review_id, id);

CREATE TABLE IF NOT EXISTS CCTV_REVIEW_OBSERVATIONS (
    global_id TEXT PRIMARY KEY,
    id INTEGER NOT NULL,
    report_global_id TEXT NOT NULL,
    report_id INTEGER NOT NULL,
    pipe_global_id TEXT NOT NULL,
    pipe_review_id INTEGER NOT NULL,
    distance_group_global_id TEXT NOT NULL,
    distance_group_id INTEGER NOT NULL,
    ml_id TEXT NOT NULL,
    mli_id TEXT NOT NULL,
    distance_key TEXT NOT NULL,
    distance_feet REAL,
    mlo_id TEXT,
    source_observation_key TEXT NOT NULL,
    defect_role TEXT NOT NULL DEFAULT 'none' CHECK (defect_role IN ('none', 'major', 'other')),
    is_extensive INTEGER NOT NULL DEFAULT 0 CHECK (is_extensive IN (0, 1)),
    selected_picture_file_name TEXT,
    record_revision TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    conflict_state TEXT NOT NULL DEFAULT 'none',
    selected_operation_id TEXT,
    FOREIGN KEY (report_global_id) REFERENCES CCTV_REVIEW_REPORTS(global_id),
    FOREIGN KEY (pipe_global_id) REFERENCES CCTV_REVIEW_PIPES(global_id),
    FOREIGN KEY (distance_group_global_id) REFERENCES CCTV_REVIEW_DISTANCE_GROUPS(global_id),
    UNIQUE (distance_group_global_id, source_observation_key)
);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_OBSERVATIONS_group ON CCTV_REVIEW_OBSERVATIONS(distance_group_global_id, id);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_OBSERVATIONS_report ON CCTV_REVIEW_OBSERVATIONS(report_global_id, pipe_review_id, distance_group_id, id);
CREATE INDEX IF NOT EXISTS CCTV_REVIEW_OBSERVATIONS_source ON CCTV_REVIEW_OBSERVATIONS(mlo_id, source_observation_key);

CREATE TABLE IF NOT EXISTS SYS_RESOURCE_REVIEW_EVENTS (
    global_id TEXT PRIMARY KEY,
    resource_id INTEGER,
    resource_key TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_global_id TEXT NOT NULL,
    subject_display_key TEXT,
    event_type TEXT NOT NULL,
    actor_user_id INTEGER,
    actor_name TEXT,
    event_at TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    memo TEXT,
    correlation_id TEXT,
    record_revision TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    conflict_state TEXT NOT NULL DEFAULT 'none',
    selected_operation_id TEXT
);
CREATE INDEX IF NOT EXISTS SYS_RRE_subject_time ON SYS_RESOURCE_REVIEW_EVENTS(resource_key, subject_type, subject_global_id, deleted, event_at DESC, global_id DESC);
CREATE INDEX IF NOT EXISTS SYS_RRE_resource_time ON SYS_RESOURCE_REVIEW_EVENTS(resource_key, deleted, event_at DESC, global_id DESC);
CREATE INDEX IF NOT EXISTS SYS_RRE_actor_time ON SYS_RESOURCE_REVIEW_EVENTS(actor_user_id, deleted, event_at DESC, global_id DESC);
CREATE INDEX IF NOT EXISTS SYS_RRE_type_time ON SYS_RESOURCE_REVIEW_EVENTS(resource_key, event_type, deleted, event_at DESC, global_id DESC);
CREATE INDEX IF NOT EXISTS SYS_RRE_correlation ON SYS_RESOURCE_REVIEW_EVENTS(resource_key, correlation_id, event_at DESC, global_id DESC);
CREATE INDEX IF NOT EXISTS SYS_RRE_conflict ON SYS_RESOURCE_REVIEW_EVENTS(resource_key, conflict_state, event_at DESC, global_id DESC);
"""


def validate_physical_registry(
    registry: Mapping[str, PhysicalEntitySpec] | None = None,
) -> tuple[PhysicalEntitySpec, ...]:
    """Validate the complete allowlist for current and future business entities."""
    registered = registry or PHYSICAL_ENTITY_SPECS
    errors: list[str] = []
    tables: set[str] = set()
    dependency_orders: set[int] = set()
    index_names: set[str] = set()

    for key, spec in registered.items():
        if key != spec.entity_type:
            errors.append(f"Registry key {key!r} does not match {spec.entity_type!r}.")
        if not MANAGED_ENTITY_TYPE_PATTERN.fullmatch(spec.entity_type):
            errors.append(f"Invalid managed entity type: {spec.entity_type!r}.")
        valid_resource_id = (
            spec.resource_id == SYSTEM_RESOURCE_ID
            or RESOURCE_ID_PATTERN.fullmatch(spec.resource_id)
        )
        if not valid_resource_id:
            errors.append(f"Invalid resource ID for {spec.entity_type}: {spec.resource_id!r}.")
        elif not spec.entity_type.startswith(f"{spec.resource_id}."):
            errors.append(f"Resource ID does not own entity type {spec.entity_type!r}.")
        if not SQL_IDENTIFIER_PATTERN.fullmatch(spec.table):
            errors.append(f"Invalid physical table name: {spec.table!r}.")
        elif spec.table in tables:
            errors.append(f"Duplicate physical table name: {spec.table!r}.")
        tables.add(spec.table)
        if spec.dependency_order in dependency_orders:
            errors.append(f"Duplicate dependency order: {spec.dependency_order}.")
        dependency_orders.add(spec.dependency_order)

        logical_columns = tuple(spec.value_columns)
        storage_columns = tuple(spec.storage_columns)
        if not logical_columns:
            errors.append(f"{spec.entity_type} has no business columns.")
        if len(logical_columns) != len(set(logical_columns)):
            errors.append(f"{spec.entity_type} has duplicate logical columns.")
        if len(storage_columns) != len(set(storage_columns)):
            errors.append(f"{spec.entity_type} has duplicate physical columns.")
        invalid_columns = [
            column for column in (*logical_columns, *storage_columns)
            if not SQL_IDENTIFIER_PATTERN.fullmatch(column)
        ]
        if invalid_columns:
            errors.append(f"{spec.entity_type} has invalid columns: {', '.join(invalid_columns)}.")
        collisions = sorted(set(storage_columns) & set(SYSTEM_STORAGE_COLUMNS))
        if collisions:
            errors.append(f"{spec.entity_type} reuses system columns: {', '.join(collisions)}.")

        sequence_names = [name for name, _ in spec.sequence_columns]
        if len(sequence_names) != len(set(sequence_names)):
            errors.append(f"{spec.entity_type} has duplicate sequence definitions.")
        for name, columns in spec.sequence_columns:
            if name not in logical_columns or not columns:
                errors.append(f"Invalid sequence mapping {spec.entity_type}.{name}.")

        typed_columns = (
            set(spec.integer_columns)
            | set(spec.real_columns)
            | set(spec.boolean_columns)
            | set(spec.datetime_columns)
        )
        unknown_typed = sorted(typed_columns - set(storage_columns))
        if unknown_typed:
            errors.append(f"{spec.entity_type} types unknown columns: {', '.join(unknown_typed)}.")
        if set(spec.integer_columns) & set(spec.real_columns):
            errors.append(f"{spec.entity_type} assigns columns to both INTEGER and REAL.")
        if set(spec.boolean_columns) & set(spec.real_columns):
            errors.append(f"{spec.entity_type} assigns columns to both BOOLEAN and REAL.")
        non_datetime_columns = (
            set(spec.integer_columns)
            | set(spec.real_columns)
            | set(spec.boolean_columns)
        )
        if set(spec.datetime_columns) & non_datetime_columns:
            errors.append(
                f"{spec.entity_type} assigns columns to both DATETIME and another SQLite type."
            )

        available_index_columns = set(storage_columns) | set(SYSTEM_STORAGE_COLUMNS)
        for suffix, columns, _ in spec.indexes:
            if not SQL_IDENTIFIER_PATTERN.fullmatch(suffix) or not columns:
                errors.append(f"Invalid index definition {spec.table}_{suffix}.")
                continue
            index_name = f"{spec.index_name_prefix or spec.table}_{suffix}"
            if index_name in index_names:
                errors.append(f"Duplicate physical index name: {index_name!r}.")
            index_names.add(index_name)
            unknown_index_columns = sorted(set(columns) - available_index_columns)
            if unknown_index_columns:
                errors.append(
                    f"{index_name} references unknown columns: {', '.join(unknown_index_columns)}."
                )

    if errors:
        raise ValueError("Invalid physical entity registry:\n- " + "\n- ".join(errors))
    return tuple(sorted(registered.values(), key=lambda spec: spec.dependency_order))


def all_physical_specs() -> tuple[PhysicalEntitySpec, ...]:
    return validate_physical_registry()


def physical_spec(entity_type: str) -> PhysicalEntitySpec | None:
    return PHYSICAL_ENTITY_SPECS.get(entity_type)


def is_managed_entity_type(entity_type: str) -> bool:
    """Return whether an entity name belongs to a registered Portal resource namespace."""
    return bool(MANAGED_ENTITY_TYPE_PATTERN.fullmatch(entity_type))


def dependency_order(entity_type: str) -> int:
    spec = physical_spec(entity_type)
    return spec.dependency_order if spec else 10_000


def stable_global_id(kind: str, *parts: object) -> str:
    canonical = "\x1f".join(str(part) for part in parts)
    return f"{kind}_{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:32]}"


def _sqlite_type(spec: PhysicalEntitySpec, column: str) -> str:
    if column in spec.integer_columns or column in spec.boolean_columns:
        return "INTEGER"
    if column in spec.real_columns:
        return "REAL"
    if column in spec.datetime_columns:
        return "DATETIME"
    return "TEXT"


def _create_registered_table(connection: sqlite3.Connection, spec: PhysicalEntitySpec) -> None:
    definitions = ["global_id TEXT PRIMARY KEY"]
    definitions.extend(
        f'"{column}" {_sqlite_type(spec, column)}' for column in spec.storage_columns
    )
    definitions.extend(
        (
            "record_revision TEXT NOT NULL",
            "deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))",
            "conflict_state TEXT NOT NULL DEFAULT 'none'",
            "selected_operation_id TEXT",
        )
    )
    connection.execute(
        f'CREATE TABLE IF NOT EXISTS "{spec.table}" ({", ".join(definitions)})'
    )
    existing_columns = {
        row[1] for row in connection.execute(f'PRAGMA table_info("{spec.table}")')
    }
    for column in spec.storage_columns:
        if column not in existing_columns:
            connection.execute(
                f'ALTER TABLE "{spec.table}" ADD COLUMN "{column}" {_sqlite_type(spec, column)}'
            )
    system_definitions = {
        "record_revision": "TEXT NOT NULL DEFAULT ''",
        "deleted": "INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))",
        "conflict_state": "TEXT NOT NULL DEFAULT 'none'",
        "selected_operation_id": "TEXT",
    }
    for column, definition in system_definitions.items():
        if column not in existing_columns:
            connection.execute(
                f'ALTER TABLE "{spec.table}" ADD COLUMN "{column}" {definition}'
            )
    for suffix, columns, unique in spec.indexes:
        index_name = f"{spec.index_name_prefix or spec.table}_{suffix}"
        quoted_columns = ", ".join(f'"{column}"' for column in columns)
        connection.execute(
            f'CREATE {"UNIQUE " if unique else ""}INDEX IF NOT EXISTS '
            f'"{index_name}" ON "{spec.table}" ({quoted_columns})'
        )


def migrate_legacy_physical_table_names(connection: sqlite3.Connection) -> None:
    """Rename resource-prefixed weekly-time tables without changing entity IDs."""
    specs_by_table = {spec.table: spec for spec in all_physical_specs()}
    for legacy_table, current_table in WEEKLY_TIME_TABLE_RENAMES.items():
        legacy = connection.execute(
            "SELECT type FROM sqlite_master WHERE name=? COLLATE NOCASE",
            (legacy_table,),
        ).fetchone()
        if legacy is None:
            continue
        if legacy[0] != "table":
            raise ValueError(f"Legacy physical entity is not a table: {legacy_table}.")

        current = connection.execute(
            "SELECT type FROM sqlite_master WHERE name=? COLLATE NOCASE",
            (current_table,),
        ).fetchone()
        if current is not None:
            if current[0] != "table":
                raise ValueError(f"Current physical entity is not a table: {current_table}.")
            legacy_count = connection.execute(
                f'SELECT COUNT(*) FROM "{legacy_table}"'
            ).fetchone()[0]
            current_count = connection.execute(
                f'SELECT COUNT(*) FROM "{current_table}"'
            ).fetchone()[0]
            if legacy_count and current_count:
                raise ValueError(
                    "Cannot safely rename weekly-time storage because both "
                    f"{legacy_table} and {current_table} contain rows."
                )
            if legacy_count:
                connection.execute(f'DROP TABLE "{current_table}"')
            else:
                connection.execute(f'DROP TABLE "{legacy_table}"')
                continue

        connection.execute(
            f'ALTER TABLE "{legacy_table}" RENAME TO "{current_table}"'
        )
        spec = specs_by_table[current_table]
        for suffix, _, _ in spec.indexes:
            connection.execute(
                f'DROP INDEX IF EXISTS "{legacy_table}_{suffix}"'
            )


def initialize_physical_schema(connection: sqlite3.Connection) -> None:
    # The first favorites release used one flattened list and a two-column
    # uniqueness index. Drop that managed index before adding category-aware
    # uniqueness; existing rows are retained as the All Resources list.
    connection.execute('DROP INDEX IF EXISTS "PORTAL_UF_owner_resource"')
    connection.execute('DROP INDEX IF EXISTS "PORTAL_UF_owner_order"')
    migrate_legacy_physical_table_names(connection)
    for table in tuple(spec.table for spec in all_physical_specs()):
        row = connection.execute(
            "SELECT type FROM sqlite_master WHERE name=? COLLATE NOCASE", (table,)
        ).fetchone()
        if row and row[0] == "view":
            connection.execute(f'DROP VIEW "{table}"')
    connection.executescript(TYPED_BUSINESS_SCHEMA_SQL)
    for spec in all_physical_specs():
        _create_registered_table(connection, spec)
    migrate_legacy_cctv_aggregates(connection)
    migrate_registered_generic_entities(connection)
    connection.execute(
        "UPDATE PORTAL_USER_FAVORITES SET category='all' "
        "WHERE category IS NULL OR TRIM(category)=''"
    )


def _coerce_value(spec: PhysicalEntitySpec, column: str, value: object) -> object:
    if value is None:
        return None
    if column in spec.boolean_columns:
        return int(bool(value))
    if column in spec.integer_columns:
        return int(value)
    if column in spec.real_columns:
        return float(value)
    return str(value)


def _storage_values(spec: PhysicalEntitySpec, values: Mapping[str, object]) -> list[object]:
    sequence_map = {name: columns for name, columns in spec.sequence_columns}
    result: list[object] = []
    for column in spec.value_columns:
        storage_columns = sequence_map.get(column)
        if storage_columns is None:
            result.append(_coerce_value(spec, column, values.get(column)))
            continue
        raw_sequence = values.get(column)
        sequence = list(raw_sequence) if isinstance(raw_sequence, (list, tuple)) else []
        for index, storage_column in enumerate(storage_columns):
            result.append(
                _coerce_value(
                    spec,
                    storage_column,
                    sequence[index] if index < len(sequence) else None,
                )
            )
    return result


def materialize_physical_entity(
    connection: sqlite3.Connection,
    entity_type: str,
    entity_id: str,
    values: Mapping[str, object],
    *,
    record_revision: str,
    deleted: bool,
    conflict_state: str,
    selected_operation_id: str | None,
) -> None:
    spec = physical_spec(entity_type)
    if spec is None:
        raise KeyError(entity_type)
    row_values = _storage_values(spec, values)
    available_columns = {
        str(row[1])
        for row in connection.execute(f'PRAGMA table_info("{spec.table}")')
    }
    storage_values = dict(zip(spec.storage_columns, row_values, strict=True))
    business_columns = tuple(
        column for column in spec.storage_columns if column in available_columns
    )
    system_values = {
        "record_revision": record_revision,
        "deleted": int(deleted),
        "conflict_state": conflict_state,
        "selected_operation_id": selected_operation_id,
    }
    system_columns = tuple(
        column
        for column in SYSTEM_STORAGE_COLUMNS
        if column != "global_id" and column in available_columns
    )
    columns = ("global_id", *business_columns, *system_columns)
    parameters = (
        entity_id,
        *(storage_values[column] for column in business_columns),
        *(system_values[column] for column in system_columns),
    )
    assignments = ", ".join(f'"{column}"=excluded."{column}"' for column in columns[1:])
    placeholders = ", ".join("?" for _ in columns)
    connection.execute(
        f'INSERT INTO "{spec.table}" ({", ".join(f"\"{column}\"" for column in columns)}) '
        f'VALUES ({placeholders}) ON CONFLICT(global_id) DO UPDATE SET {assignments}',
        parameters,
    )
    connection.execute(
        "DELETE FROM sw_sync_entity WHERE entity_type=? AND entity_id=?",
        (entity_type, entity_id),
    )


def delete_physical_entity(connection: sqlite3.Connection, entity_type: str, entity_id: str) -> None:
    spec = physical_spec(entity_type)
    if spec:
        connection.execute(f'DELETE FROM "{spec.table}" WHERE global_id=?', (entity_id,))


def _entity_from_row(spec: PhysicalEntitySpec, row: sqlite3.Row) -> dict[str, object]:
    values: dict[str, object] = {}
    sequence_map = {name: columns for name, columns in spec.sequence_columns}
    for column in spec.value_columns:
        storage_columns = sequence_map.get(column)
        if storage_columns is not None:
            values[column] = [row[storage_column] for storage_column in storage_columns]
            continue
        value = row[column]
        values[column] = bool(value) if column in spec.boolean_columns and value is not None else value
    return {
        "entity_type": spec.entity_type,
        "entity_id": row["global_id"],
        "values": values,
        "geometry": None,
        "record_revision": row["record_revision"],
        "deleted": bool(row["deleted"]),
        "conflict_state": row["conflict_state"],
    }


def get_physical_entity(
    connection: sqlite3.Connection, entity_type: str, entity_id: str
) -> dict[str, object] | None:
    spec = physical_spec(entity_type)
    if not spec:
        return None
    row = connection.execute(f'SELECT * FROM "{spec.table}" WHERE global_id=?', (entity_id,)).fetchone()
    return _entity_from_row(spec, row) if row else None


def query_physical_entities(
    connection: sqlite3.Connection,
    entity_type: str,
    *,
    filters: Mapping[str, object] | None = None,
    order_by: Sequence[tuple[str, bool]] | None = None,
    limit: int | None = None,
    offset: int = 0,
    include_deleted: bool = False,
) -> list[dict[str, object]]:
    spec = physical_spec(entity_type)
    if not spec:
        raise KeyError(entity_type)
    allowed = {"global_id", *spec.storage_columns, "record_revision", "deleted", "conflict_state"}
    clauses = [] if include_deleted else ["deleted=0"]
    params: list[object] = []
    for column, value in (filters or {}).items():
        if column not in allowed:
            raise ValueError(f"Unsupported {entity_type} filter: {column}")
        clauses.append(f'"{column}"=?')
        params.append(value)
    sql = f'SELECT * FROM "{spec.table}"'
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    if order_by:
        terms = []
        for column, descending in order_by:
            if column not in allowed:
                raise ValueError(f"Unsupported {entity_type} sort: {column}")
            terms.append(f'"{column}" {"DESC" if descending else "ASC"}')
        sql += " ORDER BY " + ", ".join(terms)
    else:
        sql += " ORDER BY global_id"
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params.extend((limit, offset))
    rows = connection.execute(sql, tuple(params)).fetchall()
    return [_entity_from_row(spec, row) for row in rows]


def count_physical_entities(
    connection: sqlite3.Connection,
    entity_type: str,
    *,
    filters: Mapping[str, object] | None = None,
    include_deleted: bool = False,
) -> int:
    spec = physical_spec(entity_type)
    if not spec:
        raise KeyError(entity_type)
    allowed = {"global_id", *spec.storage_columns, "record_revision", "deleted", "conflict_state"}
    clauses = [] if include_deleted else ["deleted=0"]
    params: list[object] = []
    for column, value in (filters or {}).items():
        if column not in allowed:
            raise ValueError(f"Unsupported {entity_type} filter: {column}")
        clauses.append(f'"{column}"=?')
        params.append(value)
    sql = f'SELECT COUNT(*) FROM "{spec.table}"'
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    return int(connection.execute(sql, tuple(params)).fetchone()[0])


def count_all_physical_entities(connection: sqlite3.Connection) -> int:
    return sum(
        int(connection.execute(f'SELECT COUNT(*) FROM "{spec.table}"').fetchone()[0])
        for spec in all_physical_specs()
    )


def _seed(connection: sqlite3.Connection, entity_type: str, entity_id: str, revision: str, values: Mapping[str, object], deleted: bool = False) -> None:
    connection.execute(
        """
        INSERT INTO sw_sync_entity_seed(
            entity_type, entity_id, base_record_revision, body_json, geometry, deleted
        ) VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            base_record_revision=excluded.base_record_revision,
            body_json=excluded.body_json,
            geometry=excluded.geometry,
            deleted=excluded.deleted
        """,
        (entity_type, entity_id, revision, json.dumps(dict(values), sort_keys=True, separators=(",", ":")), int(deleted)),
    )


def registered_generic_entity_count(connection: sqlite3.Connection) -> int:
    """Count registered business entities that still use generic JSON storage."""
    entity_types = tuple(spec.entity_type for spec in all_physical_specs())
    if not entity_types:
        return 0
    placeholders = ", ".join("?" for _ in entity_types)
    return int(
        connection.execute(
            f"SELECT COUNT(*) FROM sw_sync_entity WHERE entity_type IN ({placeholders})",
            entity_types,
        ).fetchone()[0]
    )


def migrate_registered_generic_entities(connection: sqlite3.Connection) -> int:
    """Move normalized registered rows from legacy JSON storage to physical tables."""
    entity_types = tuple(spec.entity_type for spec in all_physical_specs())
    if not entity_types:
        return 0
    placeholders = ", ".join("?" for _ in entity_types)
    rows = connection.execute(
        f"""
        SELECT entity_type, entity_id, body_json, record_revision, deleted,
               conflict_state, selected_operation_id
        FROM sw_sync_entity
        WHERE entity_type IN ({placeholders})
        ORDER BY entity_type, entity_id
        """,
        entity_types,
    ).fetchall()
    parsed_rows: list[tuple[sqlite3.Row, dict[str, object]]] = []
    for row in rows:
        entity_type = str(row["entity_type"])
        entity_id = str(row["entity_id"])
        try:
            values = json.loads(row["body_json"])
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError(
                f"Registered entity {entity_type}/{entity_id} has invalid JSON storage."
            ) from error
        if not isinstance(values, dict):
            raise ValueError(
                f"Registered entity {entity_type}/{entity_id} must contain a JSON object."
            )
        parsed_rows.append((row, values))

    # Older holiday maintenance builds allowed multiple calendar versions for
    # one year. The current model permits exactly one calendar per year and the
    # holiday UI historically selected the most recently updated version. Keep
    # that behavior during the one-time physical-table conversion and discard
    # the superseded calendar's children as a complete prior version.
    calendars_by_year: dict[int, list[tuple[sqlite3.Row, dict[str, object]]]] = {}
    for row, values in parsed_rows:
        if str(row["entity_type"]) != HOLIDAY_CALENDAR_ENTITY_TYPE or bool(row["deleted"]):
            continue
        year = int(values.get("calendar_year") or 0)
        calendars_by_year.setdefault(year, []).append((row, values))

    retained_calendar_ids: set[str] = set()
    superseded_calendar_ids: set[str] = set()
    superseded_entity_keys: set[tuple[str, str]] = set()
    for calendar_rows in calendars_by_year.values():
        selected_row, _selected_values = max(
            calendar_rows,
            key=lambda item: (
                str(item[1].get("updated_at") or item[1].get("created_at") or ""),
                str(item[0]["entity_id"]),
            ),
        )
        retained_calendar_ids.add(str(selected_row["entity_id"]))
        for row, _values in calendar_rows:
            entity_id = str(row["entity_id"])
            if entity_id != str(selected_row["entity_id"]):
                superseded_calendar_ids.add(entity_id)
                superseded_entity_keys.add((HOLIDAY_CALENDAR_ENTITY_TYPE, entity_id))

    for row, values in parsed_rows:
        if str(row["entity_type"]) != HOLIDAY_ENTITY_TYPE:
            continue
        calendar_id = str(values.get("calendar_id") or "")
        if calendar_id in superseded_calendar_ids:
            superseded_entity_keys.add((HOLIDAY_ENTITY_TYPE, str(row["entity_id"])))

    migrated = 0
    for row, source_values in parsed_rows:
        entity_type = str(row["entity_type"])
        entity_id = str(row["entity_id"])
        if (entity_type, entity_id) in superseded_entity_keys:
            continue
        values = dict(source_values)
        if entity_type == HOLIDAY_CALENDAR_ENTITY_TYPE:
            for legacy_column in (
                "version", "status", "published_by_user_id",
                "published_by_name", "published_at",
            ):
                values.pop(legacy_column, None)
        elif entity_type == HOLIDAY_ENTITY_TYPE:
            values["holiday_date"] = str(
                values.get("holiday_date")
                or values.get("observed_date")
                or values.get("actual_date")
                or ""
            )
            values.pop("actual_date", None)
            values.pop("observed_date", None)
        revision = str(row["record_revision"])
        deleted = bool(row["deleted"])
        materialize_physical_entity(
            connection,
            entity_type,
            entity_id,
            values,
            record_revision=revision,
            deleted=deleted,
            conflict_state=str(row["conflict_state"]),
            selected_operation_id=row["selected_operation_id"],
        )
        _seed(connection, entity_type, entity_id, revision, values, deleted)
        migrated += 1

    for entity_type, entity_id in superseded_entity_keys:
        connection.execute(
            "DELETE FROM sw_sync_entity WHERE entity_type=? AND entity_id=?",
            (entity_type, entity_id),
        )
        connection.execute(
            "DELETE FROM sw_sync_entity_seed WHERE entity_type=? AND entity_id=?",
            (entity_type, entity_id),
        )
    return migrated


def migrate_legacy_cctv_aggregates(connection: sqlite3.Connection) -> None:
    rows = connection.execute(
        "SELECT entity_id, body_json, record_revision, deleted, conflict_state, selected_operation_id FROM sw_sync_entity WHERE entity_type=?",
        (CCTV_REPORT_ENTITY_TYPE,),
    ).fetchall()
    for row in rows:
        try:
            aggregate = json.loads(row["body_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        report = aggregate.get("report")
        if not isinstance(report, dict):
            continue
        report_global_id = str(row["entity_id"])
        revision = str(row["record_revision"])
        materialize_physical_entity(
            connection,
            CCTV_REPORT_ENTITY_TYPE,
            report_global_id,
            report,
            record_revision=revision,
            deleted=bool(row["deleted"]),
            conflict_state=str(row["conflict_state"]),
            selected_operation_id=row["selected_operation_id"],
        )
        _seed(connection, CCTV_REPORT_ENTITY_TYPE, report_global_id, revision, report, bool(row["deleted"]))
        for pipe in aggregate.get("pipes") or []:
            pipe_id = int(pipe.get("id") or 0)
            pipe_global_id = stable_global_id("pipe", report_global_id, pipe.get("ml_id"), pipe.get("mli_id"))
            pipe_values = {**pipe, "report_global_id": report_global_id}
            pipe_values.pop("distance_groups", None)
            materialize_physical_entity(connection, CCTV_PIPE_ENTITY_TYPE, pipe_global_id, pipe_values, record_revision=revision, deleted=False, conflict_state="none", selected_operation_id=None)
            _seed(connection, CCTV_PIPE_ENTITY_TYPE, pipe_global_id, revision, pipe_values)
            for group in pipe.get("distance_groups") or []:
                group_global_id = stable_global_id("group", pipe_global_id, group.get("distance_key"))
                group_values = {
                    **group,
                    "report_global_id": report_global_id,
                    "report_id": report.get("id"),
                    "pipe_global_id": pipe_global_id,
                    "pipe_review_id": pipe_id,
                    "ml_id": pipe.get("ml_id"),
                    "mli_id": pipe.get("mli_id"),
                }
                group_values.pop("observations", None)
                materialize_physical_entity(connection, CCTV_DISTANCE_GROUP_ENTITY_TYPE, group_global_id, group_values, record_revision=revision, deleted=False, conflict_state="none", selected_operation_id=None)
                _seed(connection, CCTV_DISTANCE_GROUP_ENTITY_TYPE, group_global_id, revision, group_values)
                for observation in group.get("observations") or []:
                    observation_global_id = stable_global_id("observation", group_global_id, observation.get("source_observation_key"))
                    observation_values = {
                        **observation,
                        "report_global_id": report_global_id,
                        "report_id": report.get("id"),
                        "pipe_global_id": pipe_global_id,
                        "pipe_review_id": pipe_id,
                        "distance_group_global_id": group_global_id,
                        "distance_group_id": group.get("id"),
                        "ml_id": pipe.get("ml_id"),
                        "mli_id": pipe.get("mli_id"),
                        "distance_key": group.get("distance_key"),
                        "distance_feet": group.get("distance_feet"),
                    }
                    materialize_physical_entity(connection, CCTV_OBSERVATION_ENTITY_TYPE, observation_global_id, observation_values, record_revision=revision, deleted=False, conflict_state="none", selected_operation_id=None)
                    _seed(connection, CCTV_OBSERVATION_ENTITY_TYPE, observation_global_id, revision, observation_values)
