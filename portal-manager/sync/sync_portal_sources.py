from __future__ import annotations

import argparse
import decimal
import getpass
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pyodbc


SCRIPT_ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_ROOT / "sync.settings.json"
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
CREDENTIAL_CACHE: dict[tuple[str, str], str] = {}
SCHEDULER_MUTEX_HANDLE: int | None = None
LOG_FILE: Any | None = None
STATUS_HISTORY_PATH: Path | None = None
SCHEDULER_STATE_PATH: Path | None = None

CITYWORKS_REQUIRED_TABLES = (
    "WORKORDER",
    "WOCUSTFIELD",
    "WORKORDERENTITY",
    "INSPECTION",
    "ACTIVITYLINK",
)


@dataclass(frozen=True)
class ServingDataset:
    key: str
    columns: tuple[tuple[str, str], ...]
    indexes: tuple[tuple[str, ...], ...]


SERVING_DATASETS = (
    ServingDataset(
        key="critical_asset_work_orders",
        columns=(
            ("workorder_id", "TEXT NOT NULL"),
            ("workorders_id", "INTEGER"),
            ("description", "TEXT"),
            ("submit_to", "TEXT"),
            ("wo_closed_by", "TEXT"),
            ("status", "TEXT"),
            ("project_start_date", "TEXT"),
            ("wo_closed_date", "TEXT"),
            ("facility_id", "TEXT"),
            ("inspection_complete_date", "TEXT"),
            ("report_complete_date", "TEXT"),
            ("critical_team_status", "TEXT"),
            ("condition_risk", "REAL"),
        ),
        indexes=(
            ("workorder_id",),
            ("workorders_id",),
            ("facility_id",),
            ("submit_to",),
            ("wo_closed_by",),
            ("critical_team_status",),
            ("project_start_date",),
            ("inspection_complete_date",),
            ("report_complete_date",),
            ("wo_closed_date",),
            ("condition_risk",),
        ),
    ),
    ServingDataset(
        key="asset_inspection_workflows",
        columns=(
            ("inspection_id", "INTEGER NOT NULL"),
            ("asset_id", "TEXT"),
            ("inspection_date", "TEXT"),
            ("inspection_by", "TEXT"),
            ("inspection_status", "TEXT"),
            ("submit_to", "TEXT"),
            ("related_workorder_id", "INTEGER"),
            ("related_wo_status", "TEXT"),
            ("critical_team_status", "TEXT"),
            ("investigation_id", "INTEGER"),
            ("investigation_status", "TEXT"),
        ),
        indexes=(
            ("inspection_id",),
            ("asset_id",),
            ("inspection_date",),
            ("inspection_by",),
            ("submit_to",),
            ("inspection_status",),
            ("related_workorder_id",),
            ("critical_team_status",),
        ),
    ),
    ServingDataset(
        key="asset_inspection_events",
        columns=(
            ("inspection_id", "INTEGER NOT NULL"),
            ("event_type", "TEXT NOT NULL"),
            ("event_date", "TEXT NOT NULL"),
            ("actor_name", "TEXT"),
            ("inspection_status", "TEXT"),
        ),
        indexes=(("event_type", "event_date"), ("inspection_id",)),
    ),
    ServingDataset(
        key="facility_condition_risk_current",
        columns=(("facility_id", "TEXT NOT NULL"), ("condition_risk", "REAL")),
        indexes=(("facility_id",), ("condition_risk",)),
    ),
)


class TeeStream:
    def __init__(self, console: Any | None, log_file: Any) -> None:
        self.console = console
        self.log_file = log_file

    def write(self, value: str) -> int:
        # pythonw.exe has no console and exposes None for stdout/stderr.
        # Keep logging fully functional in that mode while preserving console
        # output when the script is run interactively.
        if self.console is not None:
            self.console.write(value)
        self.log_file.write(value)
        return len(value)

    def flush(self) -> None:
        if self.console is not None:
            self.console.flush()
        self.log_file.flush()

    def __getattr__(self, name: str) -> Any:
        if self.console is None:
            raise AttributeError(name)
        return getattr(self.console, name)


def acquire_process_lock() -> None:
    """Allow only one sync-script process on the workstation."""
    if os.name != "nt":
        return

    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_bool

    ctypes.set_last_error(0)
    handle = kernel32.CreateMutexW(None, False, "Global\\PortalWorkstationDataSync")
    if not handle:
        raise RuntimeError(f"Unable to create the scheduler lock (Windows error {ctypes.get_last_error()}).")
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        raise RuntimeError("Portal workstation data sync is already running.")

    global SCHEDULER_MUTEX_HANDLE
    SCHEDULER_MUTEX_HANDLE = int(handle)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Rebuild Portal serving tables and publish a versioned SQLite snapshot."
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--output-db",
        type=Path,
        help="Override sqliteDatabase from the configuration file.",
    )
    parser.add_argument(
        "--source",
        action="append",
        dest="sources",
        help="Sync only this source key. Repeat to select multiple sources.",
    )
    schedule_group = parser.add_mutually_exclusive_group()
    schedule_group.add_argument(
        "--schedule",
        action="store_true",
        help="Run on a local-time schedule instead of running once.",
    )
    schedule_group.add_argument(
        "--once",
        action="store_true",
        help="Run one sync. This is the default when calling the Python script directly.",
    )
    parser.add_argument("--interval-minutes", type=int)
    parser.add_argument("--allowed-start-time", help="Earliest permitted scheduler start in HH:MM format.")
    parser.add_argument("--start-time", help="First local run time in HH:MM format.")
    parser.add_argument("--last-run-time", help="Last local run time in HH:MM format.")
    parser.add_argument("--exit-time", help="Local scheduler exit time in HH:MM format.")
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Fail instead of prompting for missing SQL credentials.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check source connections and table access without creating a SQLite snapshot.",
    )
    return parser.parse_args()


def load_config(path: Path) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as error:
        raise RuntimeError(f"Sync configuration was not found: {path}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Sync configuration is invalid JSON: {path}: {error}") from error
    if not isinstance(config.get("sources"), list) or not config["sources"]:
        raise RuntimeError("The sync configuration must contain at least one source.")
    return config


def resolved_path(value: Any, config_path: Path) -> Path:
    path = Path(os.path.expandvars(str(value))).expanduser()
    return path if path.is_absolute() else (config_path.parent / path).resolve()


def apply_schedule_config(args: argparse.Namespace) -> None:
    config_path = args.config.expanduser().resolve()
    config = load_config(config_path)
    schedule = config.get("schedule", {})
    if not isinstance(schedule, dict):
        raise RuntimeError("The sync schedule configuration must be an object.")
    if args.interval_minutes is None:
        args.interval_minutes = int(schedule.get("intervalMinutes", 5))
    if args.allowed_start_time is None:
        args.allowed_start_time = str(schedule.get("allowedStartTime", "07:00"))
    if args.start_time is None:
        args.start_time = str(schedule.get("firstRunTime", "07:30"))
    if args.last_run_time is None:
        args.last_run_time = str(schedule.get("lastRunTime", "16:30"))
    if args.exit_time is None:
        args.exit_time = str(schedule.get("exitTime", "16:35"))


def configure_logging(args: argparse.Namespace) -> Path:
    config_path = args.config.expanduser().resolve()
    config = load_config(config_path)
    output_value = args.output_db if args.output_db else config.get("sqliteDatabase", config["outputDatabase"])
    output_path = resolved_path(output_value, config_path)
    configured_log_directory = config.get("syncLogsDirectory")
    log_directory = (
        resolved_path(configured_log_directory, config_path)
        if configured_log_directory
        else output_path.parent / "logs"
    )
    retention_days = max(1, int(config.get("logRetentionDays", 14)))
    log_directory.mkdir(parents=True, exist_ok=True)

    configured_status_history = config.get("syncStatusFile")
    status_history_path = (
        resolved_path(configured_status_history, config_path)
        if configured_status_history
        else log_directory / "portal-sync-status.json"
    )
    configured_scheduler_state = config.get("schedulerStateFile")
    scheduler_state_path = (
        resolved_path(configured_scheduler_state, config_path)
        if configured_scheduler_state
        else log_directory / "portal-sync-scheduler.json"
    )

    cutoff = time.time() - retention_days * 24 * 60 * 60
    for pattern in ("portal-sync-*.txt", "portal-sync-*.log"):
        for old_log in log_directory.glob(pattern):
            try:
                if old_log.stat().st_mtime < cutoff:
                    old_log.unlink()
            except OSError as error:
                print(f"WARNING: Unable to remove expired log {old_log}: {error}", file=sys.stderr)

    log_path = log_directory / f"portal-sync-{datetime.now().strftime('%Y%m%d')}.txt"
    global LOG_FILE, STATUS_HISTORY_PATH, SCHEDULER_STATE_PATH
    STATUS_HISTORY_PATH = status_history_path
    SCHEDULER_STATE_PATH = scheduler_state_path
    LOG_FILE = log_path.open("a", encoding="utf-8", errors="replace", buffering=1)
    sys.stdout = TeeStream(sys.stdout, LOG_FILE)
    sys.stderr = TeeStream(sys.stderr, LOG_FILE)
    print(f"\n[{datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}] Sync process started.")
    print(f"Log: {log_path}")
    return log_path


def read_run_history() -> list[dict[str, Any]]:
    if STATUS_HISTORY_PATH is None or not STATUS_HISTORY_PATH.exists():
        return []
    try:
        payload = json.loads(STATUS_HISTORY_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return []
    runs = payload.get("runs", []) if isinstance(payload, dict) else []
    return [record for record in runs if isinstance(record, dict)]


def write_run_history(runs: list[dict[str, Any]]) -> None:
    if STATUS_HISTORY_PATH is None:
        return
    STATUS_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = STATUS_HISTORY_PATH.with_suffix(f"{STATUS_HISTORY_PATH.suffix}.tmp")
    payload = {"runs": runs[:5000]}
    temporary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(temporary_path, STATUS_HISTORY_PATH)


def write_scheduler_state(status: str, details: str) -> None:
    """Publish a lightweight heartbeat for native clients to inspect scheduler status."""
    if SCHEDULER_STATE_PATH is None:
        return
    SCHEDULER_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = SCHEDULER_STATE_PATH.with_suffix(f"{SCHEDULER_STATE_PATH.suffix}.tmp")
    payload = {
        "status": status,
        "pid": os.getpid(),
        "updated_at": datetime.now().astimezone().isoformat(),
        "details": details,
    }
    temporary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(temporary_path, SCHEDULER_STATE_PATH)


def clear_scheduler_state() -> None:
    if SCHEDULER_STATE_PATH is None or not SCHEDULER_STATE_PATH.exists():
        return
    try:
        payload = json.loads(SCHEDULER_STATE_PATH.read_text(encoding="utf-8-sig"))
        if int(payload.get("pid", -1)) == os.getpid():
            SCHEDULER_STATE_PATH.unlink(missing_ok=True)
    except (OSError, ValueError, json.JSONDecodeError):
        pass


def start_run_record(args: argparse.Namespace) -> tuple[str, float]:
    run_id = uuid.uuid4().hex
    now = datetime.now().astimezone()
    record = {
        "run_id": run_id,
        "status": "Running",
        "started_at": now.isoformat(),
        "finished_at": None,
        "duration_seconds": None,
        "details": "Checking serving-data inputs" if args.check else "Rebuilding Portal serving tables",
    }
    runs = read_run_history()
    for existing in runs:
        if existing.get("status") == "Running":
            existing["status"] = "Interrupted"
            existing["finished_at"] = now.isoformat()
            existing["details"] = "The previous synchronization did not finish normally."
    write_run_history([record, *runs])
    return run_id, time.perf_counter()


def finish_run_record(run_id: str, started: float, status: str, details: str) -> None:
    now = datetime.now().astimezone()
    runs = read_run_history()
    for record in runs:
        if record.get("run_id") == run_id:
            record["status"] = status
            record["finished_at"] = now.isoformat()
            record["duration_seconds"] = round(time.perf_counter() - started, 1)
            record["details"] = details
            break
    write_run_history(runs)


def identifier(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not IDENTIFIER_PATTERN.fullmatch(text):
        raise RuntimeError(f"Invalid {label}: {text!r}")
    return text


def sql_server_identifier(value: Any, label: str) -> str:
    return f"[{identifier(value, label)}]"


def sqlite_identifier(value: Any, label: str) -> str:
    return f'"{identifier(value, label)}"'


def select_odbc_driver() -> str:
    configured = os.getenv("PORTAL_SYNC_SQL_DRIVER", "").strip()
    if configured:
        return configured
    installed = set(pyodbc.drivers())
    for candidate in (
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server",
    ):
        if candidate in installed:
            return candidate
    raise RuntimeError("No supported SQL Server ODBC driver is installed.")


def credential(source: dict[str, Any], kind: str, non_interactive: bool) -> str:
    cache_key = (str(source.get("key", "")), kind)
    if cache_key in CREDENTIAL_CACHE:
        return CREDENTIAL_CACHE[cache_key]

    configured_value = str(source.get(kind, ""))
    if configured_value:
        CREDENTIAL_CACHE[cache_key] = configured_value
        return configured_value

    setting = "usernameEnvironmentVariable" if kind == "username" else "passwordEnvironmentVariable"
    environment_name = str(source.get(setting, "")).strip()
    value = os.getenv(environment_name, "").strip() if environment_name else ""
    if value:
        CREDENTIAL_CACHE[cache_key] = value
        return value
    if non_interactive:
        raise RuntimeError(
            f"{source['key']} {kind} is required. Add {kind!r} to its source configuration"
            f" or set environment variable {environment_name or setting}."
        )
    prompt = f"{source['key']} SQL {kind}: "
    value = getpass.getpass(prompt) if kind == "password" else input(prompt).strip()
    CREDENTIAL_CACHE[cache_key] = value
    return value


def connection_string(source: dict[str, Any], non_interactive: bool) -> str:
    driver = str(source.get("driver") or select_odbc_driver()).strip()
    encrypt = "yes" if source.get("encrypt", True) else "no"
    trust_certificate = "yes" if source.get("trustServerCertificate", True) else "no"
    parts = [
        f"Driver={{{driver}}}",
        f"Server={source['server']}",
        f"Database={source['database']}",
        f"Encrypt={encrypt}",
        f"TrustServerCertificate={trust_certificate}",
    ]
    if source.get("trustedConnection", False):
        parts.append("Trusted_Connection=yes")
    else:
        parts.extend(
            (
                f"UID={credential(source, 'username', non_interactive)}",
                f"PWD={credential(source, 'password', non_interactive)}",
            )
        )
    return ";".join(parts) + ";"


def sqlite_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bytes)):
        return value
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (datetime,)):
        return value.isoformat(sep=" ")
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, (bytearray, memoryview)):
        return bytes(value)
    return str(value)


def normalized_datetime(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    text = str(value).strip()
    if not text:
        return None
    normalized = re.sub(r"\s+", " ", text)
    try:
        return datetime.fromisoformat(normalized.replace("Z", "+00:00")).isoformat(sep=" ")
    except ValueError:
        pass
    for pattern in (
        "%m/%d/%Y %I:%M:%S %p",
        "%m/%d/%Y %I:%M %p",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y",
        "%Y%m%d",
    ):
        try:
            return datetime.strptime(normalized, pattern).isoformat(sep=" ")
        except ValueError:
            continue
    return None


def normalized_date(value: Any) -> str | None:
    normalized = normalized_datetime(value)
    return normalized[:10] if normalized else None


def normalized_int(value: Any) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError, OverflowError):
        return None


def normalized_text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def source_text(value: Any) -> str | None:
    return str(value) if value is not None else None


def create_serving_table(destination: sqlite3.Connection, dataset: ServingDataset) -> None:
    table_name = sqlite_identifier(dataset.key, "serving table")
    columns = ", ".join(
        f"{sqlite_identifier(name, 'serving column')} {data_type}"
        for name, data_type in dataset.columns
    )
    destination.execute(f"CREATE TABLE {table_name} ({columns})")


def cityworks_dataset_query(source: dict[str, Any], dataset_key: str) -> tuple[str, list[Any]]:
    schema = sql_server_identifier(source["schema"], "source schema")
    workorder = f"{schema}.{sql_server_identifier('WORKORDER', 'source table')}"
    custom_field = f"{schema}.{sql_server_identifier('WOCUSTFIELD', 'source table')}"
    workorder_entity = f"{schema}.{sql_server_identifier('WORKORDERENTITY', 'source table')}"
    inspection = f"{schema}.{sql_server_identifier('INSPECTION', 'source table')}"
    activity_link = f"{schema}.{sql_server_identifier('ACTIVITYLINK', 'source table')}"
    description = str(source.get("criticalWorkOrderDescription") or "Critical Asset Inspection")

    if dataset_key == "critical_asset_work_orders":
        return (
            f"""
            WITH custom_fields AS (
                SELECT
                    WORKORDERID,
                    MAX(WORKORDERSID) AS WORKORDERSID,
                    MAX(CASE WHEN CUSTFIELDID = 6 THEN NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(4000), CUSTFIELDVALUE))), '') END) AS facility_id,
                    MAX(CASE WHEN CUSTFIELDID = 7 THEN NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(4000), CUSTFIELDVALUE))), '') END) AS inspection_complete_date,
                    MAX(CASE WHEN CUSTFIELDID = 10 THEN NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(4000), CUSTFIELDVALUE))), '') END) AS report_complete_date,
                    MAX(CASE WHEN CUSTFIELDID = 17 THEN NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(4000), CUSTFIELDVALUE))), '') END) AS critical_team_status
                FROM {custom_field}
                WHERE CUSTFIELDID IN (6, 7, 10, 17)
                GROUP BY WORKORDERID
            )
            SELECT
                CONVERT(nvarchar(64), wo.WORKORDERID) AS workorder_id,
                cf.WORKORDERSID AS workorders_id,
                CONVERT(nvarchar(255), wo.DESCRIPTION) AS description,
                CONVERT(nvarchar(255), wo.SUBMITTO) AS submit_to,
                CONVERT(nvarchar(255), wo.WOCLOSEDBY) AS wo_closed_by,
                CONVERT(nvarchar(255), wo.STATUS) AS status,
                wo.PROJSTARTDATE AS project_start_date,
                wo.DATEWOCLOSED AS wo_closed_date,
                cf.facility_id,
                cf.inspection_complete_date,
                cf.report_complete_date,
                cf.critical_team_status,
                CAST(NULL AS float) AS condition_risk
            FROM {workorder} AS wo
            LEFT JOIN custom_fields AS cf ON cf.WORKORDERID = wo.WORKORDERID
            WHERE wo.DESCRIPTION = ?
            """,
            [description],
        )

    if dataset_key == "asset_inspection_workflows":
        return (
            f"""
            WITH asset_inspections AS (
                SELECT
                    i.INSPECTIONID AS inspection_id,
                    CONVERT(nvarchar(255), i.ENTITYUID) AS asset_id,
                    i.INSPDATE AS inspection_date,
                    CONVERT(nvarchar(255), i.INSPECTEDBY) AS inspection_by,
                    CONVERT(nvarchar(255), i.STATUS) AS inspection_status,
                    CONVERT(nvarchar(255), i.SUBMITTONAME) AS submit_to
                FROM {inspection} AS i
                WHERE i.INSPTEMPLATENAME LIKE '%Asset Insp%'
                  AND i.ENTITYTYPE IN ('CHANNELS', 'PIPES', 'STRUCTURES')
                  AND i.STATUS = 'PENDING'
            ),
            custom_status AS (
                SELECT
                    WORKORDERID,
                    MAX(CASE WHEN CUSTFIELDID = 17 THEN CONVERT(nvarchar(255), CUSTFIELDVALUE) END) AS critical_team_status
                FROM {custom_field}
                WHERE CUSTFIELDID = 17
                GROUP BY WORKORDERID
            ),
            asset_workorders_ranked AS (
                SELECT
                    CONVERT(nvarchar(255), woe.ENTITYUID) AS asset_id,
                    wo.WORKORDERID AS related_workorder_id,
                    CONVERT(nvarchar(255), wo.STATUS) AS related_wo_status,
                    cs.critical_team_status,
                    ROW_NUMBER() OVER (PARTITION BY woe.ENTITYUID ORDER BY wo.WORKORDERID DESC) AS rn
                FROM {workorder_entity} AS woe
                INNER JOIN {workorder} AS wo ON wo.WORKORDERID = woe.WORKORDERID
                LEFT JOIN custom_status AS cs ON cs.WORKORDERID = wo.WORKORDERID
                WHERE woe.ENTITYTYPE IN ('PIPES', 'STRUCTURES', 'CHANNELS')
                  AND woe.ENTITYUID IS NOT NULL
                  AND wo.DESCRIPTION = ?
            ),
            asset_workorders AS (
                SELECT asset_id, related_workorder_id, related_wo_status, critical_team_status
                FROM asset_workorders_ranked
                WHERE rn = 1
            ),
            investigations_raw AS (
                SELECT
                    al.DESTACTIVITYID AS inspection_id,
                    al.SOURCEACTIVITYID AS investigation_id,
                    CONVERT(nvarchar(255), inv.STATUS) AS investigation_status
                FROM {activity_link} AS al
                INNER JOIN {inspection} AS inv ON al.SOURCEACTIVITYID = inv.INSPECTIONID
                WHERE inv.INSPTEMPLATENAME NOT LIKE '%Asset Insp%'
                  AND al.SOURCEACTIVITYTYPE = 'Inspection'
                  AND al.DESTACTIVITYTYPE = 'Inspection'
                UNION ALL
                SELECT
                    al.SOURCEACTIVITYID AS inspection_id,
                    al.DESTACTIVITYID AS investigation_id,
                    CONVERT(nvarchar(255), inv.STATUS) AS investigation_status
                FROM {activity_link} AS al
                INNER JOIN {inspection} AS inv ON al.DESTACTIVITYID = inv.INSPECTIONID
                WHERE inv.INSPTEMPLATENAME NOT LIKE '%Asset Insp%'
                  AND al.SOURCEACTIVITYTYPE = 'Inspection'
                  AND al.DESTACTIVITYTYPE = 'Inspection'
            ),
            investigations_ranked AS (
                SELECT
                    inspection_id,
                    investigation_id,
                    investigation_status,
                    ROW_NUMBER() OVER (PARTITION BY inspection_id ORDER BY investigation_id DESC) AS rn
                FROM investigations_raw
            )
            SELECT
                i.inspection_id,
                i.asset_id,
                i.inspection_date,
                i.inspection_by,
                i.inspection_status,
                i.submit_to,
                w.related_workorder_id,
                w.related_wo_status,
                w.critical_team_status,
                inv.investigation_id,
                inv.investigation_status
            FROM asset_inspections AS i
            LEFT JOIN asset_workorders AS w ON i.asset_id = w.asset_id
            LEFT JOIN investigations_ranked AS inv ON i.inspection_id = inv.inspection_id AND inv.rn = 1
            """,
            [description],
        )

    if dataset_key == "asset_inspection_events":
        return (
            f"""
            WITH aif_forms AS (
                SELECT
                    i.INSPECTIONID AS inspection_id,
                    CONVERT(nvarchar(255), i.INSPECTEDBY) AS inspected_by,
                    CONVERT(nvarchar(255), i.STATUS) AS inspection_status,
                    i.INSPDATE AS inspection_date,
                    i.PRJSTARTDATE AS project_start_date,
                    i.DATECLOSED AS completed_date
                FROM {inspection} AS i
                WHERE i.INSPTEMPLATENAME LIKE '%Asset Insp%'
                  AND i.ENTITYTYPE IN ('CHANNELS', 'PIPES', 'STRUCTURES')
            ),
            events AS (
                SELECT inspection_id, 'completed' AS event_type, completed_date AS event_date,
                       inspected_by AS actor_name, inspection_status
                FROM aif_forms
                WHERE completed_date IS NOT NULL
                  AND UPPER(LTRIM(RTRIM(inspection_status))) IN ('COMPLETED', 'CLOSED')
                UNION ALL
                SELECT inspection_id, 'inspection' AS event_type, inspection_date AS event_date,
                       inspected_by AS actor_name, inspection_status
                FROM aif_forms
                WHERE inspection_date IS NOT NULL
                UNION ALL
                SELECT inspection_id, 'project_started' AS event_type, project_start_date AS event_date,
                       inspected_by AS actor_name, inspection_status
                FROM aif_forms
                WHERE project_start_date IS NOT NULL
            )
            SELECT inspection_id, event_type, event_date, actor_name, inspection_status
            FROM events
            """,
            [],
        )

    raise RuntimeError(f"Unsupported Cityworks serving dataset: {dataset_key}")


def transform_serving_row(dataset_key: str, row: Any) -> tuple[Any, ...]:
    values = list(row)
    if dataset_key == "critical_asset_work_orders":
        values[0] = normalized_text(values[0])
        values[1] = normalized_int(values[1])
        for index in (2, 3, 4, 5):
            values[index] = source_text(values[index])
        for index in (8, 11):
            values[index] = normalized_text(values[index])
        values[6] = normalized_datetime(values[6])
        values[7] = normalized_datetime(values[7])
        values[9] = normalized_date(values[9])
        values[10] = normalized_date(values[10])
        values[12] = None
    elif dataset_key == "asset_inspection_workflows":
        values[0] = normalized_int(values[0])
        values[1] = source_text(values[1])
        values[2] = normalized_datetime(values[2])
        for index in (3, 4, 5, 7, 8, 10):
            values[index] = source_text(values[index])
        values[6] = normalized_int(values[6])
        values[9] = normalized_int(values[9])
    elif dataset_key == "asset_inspection_events":
        values[0] = normalized_int(values[0])
        values[1] = source_text(values[1])
        values[2] = normalized_datetime(values[2])
        values[3] = source_text(values[3])
        values[4] = source_text(values[4])
    return tuple(sqlite_value(value) for value in values)


def copy_serving_dataset(
    source_connection: pyodbc.Connection,
    destination: sqlite3.Connection,
    source: dict[str, Any],
    dataset: ServingDataset,
    chunk_size: int,
) -> int:
    query, params = cityworks_dataset_query(source, dataset.key)
    cursor = source_connection.cursor()
    cursor.execute(query, params)
    if len(cursor.description) != len(dataset.columns):
        raise RuntimeError(
            f"{dataset.key} returned {len(cursor.description)} columns; expected {len(dataset.columns)}."
        )
    create_serving_table(destination, dataset)
    target = sqlite_identifier(dataset.key, "serving table")
    placeholders = ", ".join("?" for _ in dataset.columns)
    insert_sql = f"INSERT INTO {target} VALUES ({placeholders})"
    row_count = 0
    while True:
        rows = cursor.fetchmany(chunk_size)
        if not rows:
            break
        values = [transform_serving_row(dataset.key, row) for row in rows]
        destination.executemany(insert_sql, values)
        row_count += len(values)
        print(f"    {row_count:,} rows", end="\r", flush=True)
    print(f"    {row_count:,} rows")
    return row_count


def load_condition_risk(
    destination: sqlite3.Connection,
    config: dict[str, Any],
    config_path: Path,
) -> int:
    settings = config.get("conditionRisk")
    if not isinstance(settings, dict):
        raise RuntimeError("conditionRisk configuration is required for the serving publication.")
    database = resolved_path(settings.get("database"), config_path)
    if not database.is_file():
        raise RuntimeError(f"Condition-risk database was not found: {database}")
    table = identifier(settings.get("table", "critical_facility_highest_risk_assets_by_facility"), "condition-risk table")
    facility_column = identifier(settings.get("facilityIdColumn", "FacilityID"), "condition-risk facility column")
    risk_column = identifier(settings.get("riskColumn", "COND_RISK"), "condition-risk value column")
    try:
        import duckdb
    except ImportError as error:
        raise RuntimeError("The Portal sync Python environment must include duckdb.") from error

    dataset = next(item for item in SERVING_DATASETS if item.key == "facility_condition_risk_current")
    create_serving_table(destination, dataset)
    connection = duckdb.connect(str(database), read_only=True)
    try:
        rows = connection.execute(
            f"""
            SELECT
                trim(cast(\"{facility_column}\" AS varchar)) AS facility_id,
                max(try_cast(\"{risk_column}\" AS double)) AS condition_risk
            FROM \"{table}\"
            WHERE \"{facility_column}\" IS NOT NULL
            GROUP BY trim(cast(\"{facility_column}\" AS varchar))
            """
        ).fetchall()
    finally:
        connection.close()
    normalized_rows = [
        (normalized_text(facility_id), float(condition_risk) if condition_risk is not None else None)
        for facility_id, condition_risk in rows
        if normalized_text(facility_id)
    ]
    destination.executemany(
        "INSERT INTO facility_condition_risk_current (facility_id, condition_risk) VALUES (?, ?)",
        normalized_rows,
    )
    destination.execute(
        """
        UPDATE critical_asset_work_orders
        SET condition_risk = (
            SELECT risk.condition_risk
            FROM facility_condition_risk_current AS risk
            WHERE risk.facility_id = critical_asset_work_orders.facility_id
        )
        WHERE EXISTS (
            SELECT 1
            FROM facility_condition_risk_current AS risk
            WHERE risk.facility_id = critical_asset_work_orders.facility_id
        )
        """
    )
    print(f"    {len(normalized_rows):,} facility risk rows")
    return len(normalized_rows)


def create_serving_indexes(destination: sqlite3.Connection) -> None:
    unique_indexes = {
        "critical_asset_work_orders": ("workorder_id",),
        "asset_inspection_workflows": ("inspection_id",),
        "asset_inspection_events": ("inspection_id", "event_type"),
        "facility_condition_risk_current": ("facility_id",),
    }
    for dataset in SERVING_DATASETS:
        target = sqlite_identifier(dataset.key, "serving table")
        unique_columns = unique_indexes[dataset.key]
        unique_name = sqlite_identifier(f"ux_{dataset.key}_identity", "unique index")
        unique_sql = ", ".join(sqlite_identifier(column, "index column") for column in unique_columns)
        destination.execute(f"CREATE UNIQUE INDEX {unique_name} ON {target} ({unique_sql})")
        for position, column_group in enumerate(dataset.indexes, start=1):
            if tuple(column_group) == tuple(unique_columns):
                continue
            columns = ", ".join(sqlite_identifier(value, "index column") for value in column_group)
            index_name = sqlite_identifier(f"idx_{dataset.key}_{position}", "index name")
            destination.execute(f"CREATE INDEX {index_name} ON {target} ({columns})")


def dataset_fingerprint(destination: sqlite3.Connection, dataset: ServingDataset) -> str:
    digest = hashlib.sha256()
    columns = [name for name, _data_type in dataset.columns]
    select_columns = ", ".join(sqlite_identifier(column, "serving column") for column in columns)
    identity = {
        "critical_asset_work_orders": ("workorder_id",),
        "asset_inspection_workflows": ("inspection_id",),
        "asset_inspection_events": ("inspection_id", "event_type"),
        "facility_condition_risk_current": ("facility_id",),
    }[dataset.key]
    order_sql = ", ".join(sqlite_identifier(column, "serving column") for column in identity)
    for row in destination.execute(
        f"SELECT {select_columns} FROM {sqlite_identifier(dataset.key, 'serving table')} ORDER BY {order_sql}"
    ):
        digest.update(json.dumps(list(row), ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def validate_serving_tables(destination: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    for dataset in SERVING_DATASETS:
        table = sqlite_identifier(dataset.key, "serving table")
        columns = [row[1] for row in destination.execute(f"PRAGMA table_info({table})")]
        expected = [name for name, _data_type in dataset.columns]
        if columns != expected:
            raise RuntimeError(f"{dataset.key} columns do not match the serving-data contract.")
        row_count = int(destination.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        if dataset.key in {"critical_asset_work_orders", "asset_inspection_events"} and row_count == 0:
            raise RuntimeError(f"{dataset.key} is unexpectedly empty.")
        results[dataset.key] = {
            "row_count": row_count,
            "sha256": dataset_fingerprint(destination, dataset),
        }
    return results


def metadata_schema(destination: sqlite3.Connection) -> None:
    destination.execute(
        """
        CREATE TABLE PORTAL_SYNC_METADATA (
            dataset_key TEXT NOT NULL,
            source_key TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            duration_seconds REAL NOT NULL,
            content_sha256 TEXT NOT NULL,
            synced_at_utc TEXT NOT NULL
        )
        """
    )


def selected_sources(config: dict[str, Any], requested: list[str] | None) -> list[dict[str, Any]]:
    sources = config["sources"]
    if not requested:
        return sources
    requested_keys = {value.casefold() for value in requested}
    selected = [source for source in sources if str(source.get("key", "")).casefold() in requested_keys]
    missing = requested_keys - {str(source.get("key", "")).casefold() for source in selected}
    if missing:
        raise RuntimeError(f"Unknown source key(s): {', '.join(sorted(missing))}")
    return selected


def check_source_tables(sources: list[dict[str, Any]], non_interactive: bool) -> None:
    for source in sources:
        source["key"] = identifier(source.get("key"), "source key")
        if source["key"].casefold() != "cityworks":
            raise RuntimeError(f"Unsupported serving-data source: {source['key']}")
        print(f"Checking {source['key']} ({source['server']} / {source['database']})...")
        with pyodbc.connect(connection_string(source, non_interactive), timeout=30) as connection:
            cursor = connection.cursor()
            for table in CITYWORKS_REQUIRED_TABLES:
                schema_name = sql_server_identifier(source["schema"], "source schema")
                source_name = sql_server_identifier(table, "source table")
                cursor.execute(f"SELECT TOP (0) * FROM {schema_name}.{source_name}")
                print(f"  OK  {source['schema']}.{table} ({len(cursor.description)} source columns available)")


def publication_paths(
    config: dict[str, Any],
    config_path: Path,
    output_path: Path,
    output_overridden: bool = False,
) -> tuple[Path, Path]:
    if output_overridden:
        return (
            output_path.parent / f"{output_path.stem}_versions",
            output_path.parent / f"{output_path.stem}.current.json",
        )
    versions_value = config.get("sqliteVersionsDirectory")
    manifest_value = config.get("sqliteManifest")
    versions_directory = (
        resolved_path(versions_value, config_path)
        if versions_value
        else output_path.parent / f"{output_path.stem}_versions"
    )
    manifest_path = (
        resolved_path(manifest_value, config_path)
        if manifest_value
        else output_path.parent / f"{output_path.stem}.current.json"
    )
    return versions_directory, manifest_path


def publish_database(
    staging_path: Path,
    final_path: Path,
    manifest_path: Path,
    keep_versions: int,
    datasets: dict[str, dict[str, Any]],
) -> None:
    final_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staging_path, final_path)

    try:
        manifest_database = final_path.relative_to(manifest_path.parent).as_posix()
    except ValueError:
        manifest_database = str(final_path)
    manifest = {
        "format": "sqlite",
        "schema_version": 2,
        "source_profile": "portal_serving_v2",
        "database": manifest_database,
        "published_at_utc": datetime.now(timezone.utc).isoformat(),
        "size_bytes": final_path.stat().st_size,
        "content_sha256": hashlib.sha256(
            "\n".join(f"{key}:{value['sha256']}" for key, value in sorted(datasets.items())).encode("utf-8")
        ).hexdigest(),
        "datasets": datasets,
        "validation": "ok",
    }
    temporary_manifest = manifest_path.with_name(f"{manifest_path.name}.{uuid.uuid4().hex}.tmp")
    temporary_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    os.replace(temporary_manifest, manifest_path)

    candidates = sorted(
        (
            path
            for path in final_path.parent.glob(f"{final_path.stem.rsplit('_', 2)[0]}_*{final_path.suffix}")
            if path != final_path and ".building." not in path.name
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for expired in candidates[max(0, keep_versions - 1):]:
        try:
            expired.unlink()
        except OSError as error:
            print(f"WARNING: Unable to remove old snapshot {expired}: {error}", file=sys.stderr)


def publish_desktop_data_version(config: dict[str, Any], config_path: Path) -> None:
    script_value = str(config.get("dataPublicationScript") or "").strip()
    settings_value = str(config.get("dataPublicationSettings") or "").strip()
    if not script_value or not settings_value:
        raise RuntimeError(
            "dataPublicationScript and dataPublicationSettings are required for serving-data publication."
        )
    script_path = resolved_path(script_value, config_path)
    settings_path = resolved_path(settings_value, config_path)
    command = [
        sys.executable,
        str(script_path),
        "--config",
        str(settings_path),
        "--producer",
        str(config.get("dataPublicationProducer") or "portal-serving-data"),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "Data publication failed.").strip()
        raise RuntimeError(detail)
    if completed.stdout.strip():
        print(completed.stdout.strip())


def run(args: argparse.Namespace) -> Path:
    config_path = args.config.expanduser().resolve()
    config = load_config(config_path)
    configured_output = args.output_db if args.output_db else config.get("sqliteDatabase", config["outputDatabase"])
    output_path = resolved_path(configured_output, config_path)
    versions_directory, manifest_path = publication_paths(
        config,
        config_path,
        output_path,
        output_overridden=args.output_db is not None,
    )
    versions_directory.mkdir(parents=True, exist_ok=True)
    for abandoned in versions_directory.glob(f".{output_path.stem}.building.*{output_path.suffix}"):
        try:
            abandoned.unlink()
        except OSError as error:
            print(f"WARNING: Unable to remove abandoned snapshot {abandoned}: {error}", file=sys.stderr)
    version_token = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    version_token = f"{version_token}_{uuid.uuid4().hex[:8]}"
    final_path = versions_directory / f"{output_path.stem}_{version_token}{output_path.suffix}"
    staging_path = versions_directory / f".{output_path.stem}.building.{uuid.uuid4().hex}{output_path.suffix}"
    chunk_size = max(1, int(config.get("chunkSize", 50000)))
    keep_versions = max(2, int(config.get("sqliteKeepVersions", 3)))
    sources = selected_sources(config, args.sources)
    total_started = time.perf_counter()

    if args.check:
        check_source_tables(sources, args.non_interactive)
        risk_settings = config.get("conditionRisk")
        if not isinstance(risk_settings, dict):
            raise RuntimeError("conditionRisk configuration is required for the serving publication.")
        risk_database = resolved_path(risk_settings.get("database"), config_path)
        if not risk_database.is_file():
            raise RuntimeError(f"Condition-risk database was not found: {risk_database}")
        print(f"  OK  condition risk database: {risk_database}")
        print("All serving-data sources are accessible.")
        return output_path

    cityworks_sources = [source for source in sources if str(source.get("key", "")).casefold() == "cityworks"]
    if len(cityworks_sources) != 1:
        raise RuntimeError("The serving publication requires exactly one Cityworks source.")
    cityworks = cityworks_sources[0]

    try:
        with closing(sqlite3.connect(staging_path)) as destination:
            destination.execute("PRAGMA journal_mode=OFF")
            destination.execute("PRAGMA synchronous=OFF")
            destination.execute("PRAGMA temp_store=MEMORY")
            destination.execute("PRAGMA cache_size=-262144")
            destination.execute("PRAGMA locking_mode=EXCLUSIVE")
            destination.execute("PRAGMA application_id=1347572812")
            destination.execute("PRAGMA user_version=2")
            destination.execute("BEGIN IMMEDIATE")
            metadata_schema(destination)
            cityworks["key"] = identifier(cityworks.get("key"), "source key")
            durations: dict[str, float] = {}
            print(f"Connecting to Cityworks ({cityworks['server']} / {cityworks['database']})...")
            with pyodbc.connect(connection_string(cityworks, args.non_interactive), timeout=30) as connection:
                for dataset in SERVING_DATASETS[:3]:
                    print(f"  Building {dataset.key}")
                    started = time.perf_counter()
                    copy_serving_dataset(connection, destination, cityworks, dataset, chunk_size)
                    durations[dataset.key] = round(time.perf_counter() - started, 3)
            print("  Building facility_condition_risk_current")
            started = time.perf_counter()
            load_condition_risk(destination, config, config_path)
            durations["facility_condition_risk_current"] = round(time.perf_counter() - started, 3)
            create_serving_indexes(destination)
            dataset_results = validate_serving_tables(destination)
            synced_at = datetime.now(timezone.utc).isoformat()
            for dataset_key, result in dataset_results.items():
                destination.execute(
                    "INSERT INTO PORTAL_SYNC_METADATA VALUES (?, ?, ?, ?, ?, ?)",
                    [
                        dataset_key,
                        "cityworks" if dataset_key != "facility_condition_risk_current" else "condition_risk",
                        result["row_count"],
                        durations[dataset_key],
                        result["sha256"],
                        synced_at,
                    ],
                )
            destination.commit()
            destination.execute("ANALYZE")
            destination.execute("PRAGMA optimize")
            destination.commit()
            integrity = destination.execute("PRAGMA integrity_check").fetchone()
            if not integrity or str(integrity[0]).casefold() != "ok":
                raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        publish_database(staging_path, final_path, manifest_path, keep_versions, dataset_results)
        if not args.output_db:
            publish_desktop_data_version(config, config_path)
    except Exception:
        staging_path.unlink(missing_ok=True)
        raise

    print(f"Published snapshot: {final_path}")
    print(f"Current manifest: {manifest_path}")
    print(f"Elapsed: {time.perf_counter() - total_started:,.1f} seconds")
    return final_path


def run_tracked(args: argparse.Namespace) -> Path:
    run_id, started = start_run_record(args)
    try:
        output_path = run(args)
    except Exception as error:
        finish_run_record(run_id, started, "Failed", str(error))
        raise
    details = "Source check passed" if args.check else f"Published {output_path.name}"
    finish_run_record(run_id, started, "Succeeded", details)
    return output_path


def parse_clock(value: str, label: str) -> Any:
    try:
        return datetime.strptime(value, "%H:%M").time()
    except ValueError as error:
        raise RuntimeError(f"{label} must use 24-hour HH:MM format: {value}") from error


def next_run_time(now: datetime, start_at: datetime, interval_minutes: int) -> datetime:
    if now <= start_at:
        return start_at
    elapsed_seconds = (now - start_at).total_seconds()
    interval_seconds = interval_minutes * 60
    elapsed_intervals = int(elapsed_seconds // interval_seconds)
    candidate = start_at + timedelta(minutes=elapsed_intervals * interval_minutes)
    if candidate < now:
        candidate += timedelta(minutes=interval_minutes)
    return candidate


def sleep_until(target: datetime) -> None:
    while True:
        seconds = (target - datetime.now().astimezone()).total_seconds()
        if seconds <= 0:
            return
        write_scheduler_state("Running", f"Waiting for the next scheduled run at {target.strftime('%H:%M')}.")
        time.sleep(min(seconds, 30))


def run_schedule(args: argparse.Namespace) -> None:
    if args.check:
        raise RuntimeError("--check cannot be combined with --schedule.")
    if args.interval_minutes < 1:
        raise RuntimeError("--interval-minutes must be at least 1.")

    allowed_start_clock = parse_clock(args.allowed_start_time, "--allowed-start-time")
    start_clock = parse_clock(args.start_time, "--start-time")
    last_run_clock = parse_clock(args.last_run_time, "--last-run-time")
    exit_clock = parse_clock(args.exit_time, "--exit-time")
    if not allowed_start_clock <= start_clock <= last_run_clock < exit_clock:
        raise RuntimeError(
            "Schedule times must satisfy allowed-start-time <= start-time <= last-run-time < exit-time."
        )

    launched_at = datetime.now().astimezone()
    allowed_start_at = datetime.combine(launched_at.date(), allowed_start_clock, tzinfo=launched_at.tzinfo)
    last_start_at = datetime.combine(launched_at.date(), last_run_clock, tzinfo=launched_at.tzinfo)
    if launched_at < allowed_start_at or launched_at > last_start_at:
        print(
            f"Scheduler start blocked. Start is permitted from {args.allowed_start_time} "
            f"through {args.last_run_time} local time."
        )
        return

    print(
        f"Scheduler active: every {args.interval_minutes} minutes from {args.start_time} "
        f"through {args.last_run_time}; exits at {args.exit_time} local time."
    )
    write_scheduler_state("Running", "Scheduler started.")
    while True:
        now = datetime.now().astimezone()
        start_at = datetime.combine(now.date(), start_clock, tzinfo=now.tzinfo)
        last_run_at = datetime.combine(now.date(), last_run_clock, tzinfo=now.tzinfo)
        exit_at = datetime.combine(now.date(), exit_clock, tzinfo=now.tzinfo)

        if now >= exit_at:
            print(f"Exit time reached ({args.exit_time}). Scheduler stopped.")
            return

        scheduled_at = next_run_time(now, start_at, args.interval_minutes)
        if scheduled_at > last_run_at:
            print(f"No runs remain today. Waiting to exit at {args.exit_time}...")
            sleep_until(exit_at)
            continue

        print(f"Next sync: {scheduled_at.strftime('%m/%d/%Y %I:%M %p %Z')}")
        write_scheduler_state("Running", f"Next sync at {scheduled_at.strftime('%H:%M')}.")
        sleep_until(scheduled_at)
        print(f"\nSync started: {datetime.now().astimezone().strftime('%m/%d/%Y %I:%M:%S %p %Z')}")
        try:
            run_tracked(args)
        except (RuntimeError, pyodbc.Error, sqlite3.Error, OSError, ValueError) as error:
            print(f"ERROR: {error}", file=sys.stderr)
            print("The scheduler will retry at the next scheduled time.")


def main() -> int:
    args = parse_args()
    try:
        acquire_process_lock()
        apply_schedule_config(args)
        configure_logging(args)
        if args.schedule:
            try:
                run_schedule(args)
            finally:
                clear_scheduler_state()
        else:
            run_tracked(args)
    except (RuntimeError, pyodbc.Error, sqlite3.Error, OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
