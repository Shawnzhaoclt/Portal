from __future__ import annotations

import argparse
import decimal
import getpass
import json
import os
import re
import sqlite3
import sys
import time
import uuid
from contextlib import closing
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


class TeeStream:
    def __init__(self, console: Any, log_file: Any) -> None:
        self.console = console
        self.log_file = log_file

    def write(self, value: str) -> int:
        self.console.write(value)
        self.log_file.write(value)
        return len(value)

    def flush(self) -> None:
        self.console.flush()
        self.log_file.flush()

    def __getattr__(self, name: str) -> Any:
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
        description="Publish Portal source tables from SQL Server as versioned SQLite snapshots."
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

    cutoff = time.time() - retention_days * 24 * 60 * 60
    for pattern in ("portal-sync-*.txt", "portal-sync-*.log"):
        for old_log in log_directory.glob(pattern):
            try:
                if old_log.stat().st_mtime < cutoff:
                    old_log.unlink()
            except OSError as error:
                print(f"WARNING: Unable to remove expired log {old_log}: {error}", file=sys.stderr)

    log_path = log_directory / f"portal-sync-{datetime.now().strftime('%Y%m%d')}.txt"
    global LOG_FILE, STATUS_HISTORY_PATH
    STATUS_HISTORY_PATH = status_history_path
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


def start_run_record(args: argparse.Namespace) -> tuple[str, float]:
    run_id = uuid.uuid4().hex
    now = datetime.now().astimezone()
    record = {
        "run_id": run_id,
        "status": "Running",
        "started_at": now.isoformat(),
        "finished_at": None,
        "duration_seconds": None,
        "details": "Checking source tables" if args.check else "Synchronizing portal source data",
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


def sqlite_type(description: tuple[Any, ...]) -> str:
    type_code = description[1]
    name = getattr(type_code, "__name__", str(type_code)).casefold()
    if "bool" in name:
        return "INTEGER"
    if "int" in name:
        return "INTEGER"
    if "float" in name or "decimal" in name:
        return "REAL"
    if "byte" in name or "binary" in name:
        return "BLOB"
    return "TEXT"


def create_table(
    destination: sqlite3.Connection,
    target_table: str,
    description: tuple[Any, ...],
) -> None:
    columns = []
    for item in description:
        column_name = sqlite_identifier(item[0], "column name")
        columns.append(f"{column_name} {sqlite_type(item)}")
    destination.execute(f"CREATE TABLE {target_table} ({', '.join(columns)})")


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


def copy_table(
    source_connection: pyodbc.Connection,
    destination: sqlite3.Connection,
    source: dict[str, Any],
    table: dict[str, Any],
    chunk_size: int,
) -> int:
    schema_name = sql_server_identifier(source["schema"], "source schema")
    source_name = sql_server_identifier(table["source"], "source table")
    target_name = sqlite_identifier(table["target"], "target table")
    cursor = source_connection.cursor()
    cursor.execute(f"SELECT * FROM {schema_name}.{source_name}")
    row_count = 0
    create_table(destination, target_name, cursor.description)
    placeholders = ", ".join("?" for _ in cursor.description)
    insert_sql = f"INSERT INTO {target_name} VALUES ({placeholders})"

    while True:
        rows = cursor.fetchmany(chunk_size)
        if not rows:
            break
        values = [tuple(sqlite_value(value) for value in row) for row in rows]
        destination.executemany(insert_sql, values)
        row_count += len(values)
        print(f"    {row_count:,} rows", end="\r", flush=True)

    print(f"    {row_count:,} rows")
    return row_count


def create_indexes(
    destination: sqlite3.Connection,
    source_key: str,
    table: dict[str, Any],
) -> None:
    target = identifier(table["target"], "target table")
    target_sql = sqlite_identifier(target, "target table")
    for position, column_group in enumerate(table.get("indexes", []), start=1):
        if not isinstance(column_group, list) or not column_group:
            continue
        columns = ", ".join(sqlite_identifier(value, "index column") for value in column_group)
        index_name = sqlite_identifier(f"idx_{source_key}_{target}_{position}", "index name")
        destination.execute(f"CREATE INDEX {index_name} ON {target_sql} ({columns})")


def metadata_schema(destination: sqlite3.Connection) -> None:
    destination.execute(
        """
        CREATE TABLE PORTAL_SYNC_METADATA (
            source_key TEXT NOT NULL,
            source_server TEXT NOT NULL,
            source_database TEXT NOT NULL,
            source_schema TEXT NOT NULL,
            source_table TEXT NOT NULL,
            target_table TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            duration_seconds REAL NOT NULL,
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
        print(f"Checking {source['key']} ({source['server']} / {source['database']})...")
        with pyodbc.connect(connection_string(source, non_interactive), timeout=30) as connection:
            cursor = connection.cursor()
            for table in source.get("tables", []):
                schema_name = sql_server_identifier(source["schema"], "source schema")
                source_name = sql_server_identifier(table.get("source"), "source table")
                cursor.execute(f"SELECT TOP (0) * FROM {schema_name}.{source_name}")
                print(f"  OK  {source['schema']}.{table['source']} ({len(cursor.description)} columns)")


def publication_paths(
    config: dict[str, Any],
    config_path: Path,
    output_path: Path,
) -> tuple[Path, Path]:
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
        "schema_version": 1,
        "database": manifest_database,
        "published_at_utc": datetime.now(timezone.utc).isoformat(),
        "size_bytes": final_path.stat().st_size,
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


def run(args: argparse.Namespace) -> Path:
    config_path = args.config.expanduser().resolve()
    config = load_config(config_path)
    configured_output = args.output_db if args.output_db else config.get("sqliteDatabase", config["outputDatabase"])
    output_path = resolved_path(configured_output, config_path)
    versions_directory, manifest_path = publication_paths(config, config_path, output_path)
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
        print("All selected source tables are accessible.")
        return output_path

    try:
        with closing(sqlite3.connect(staging_path)) as destination:
            destination.execute("PRAGMA journal_mode=OFF")
            destination.execute("PRAGMA synchronous=OFF")
            destination.execute("PRAGMA temp_store=MEMORY")
            destination.execute("PRAGMA cache_size=-262144")
            destination.execute("PRAGMA locking_mode=EXCLUSIVE")
            destination.execute("PRAGMA application_id=1347572812")
            destination.execute("PRAGMA user_version=1")
            destination.execute("BEGIN IMMEDIATE")
            metadata_schema(destination)
            for source in sources:
                source["key"] = identifier(source.get("key"), "source key")
                print(f"Connecting to {source['key']} ({source['server']} / {source['database']})...")
                with pyodbc.connect(connection_string(source, args.non_interactive), timeout=30) as connection:
                    for table in source.get("tables", []):
                        source_table = identifier(table.get("source"), "source table")
                        target_table = identifier(table.get("target"), "target table")
                        print(f"  {source['schema']}.{source_table} -> {target_table}")
                        started = time.perf_counter()
                        row_count = copy_table(connection, destination, source, table, chunk_size)
                        create_indexes(destination, source["key"], table)
                        destination.execute(
                            "INSERT INTO PORTAL_SYNC_METADATA VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            [
                                source["key"],
                                source["server"],
                                source["database"],
                                source["schema"],
                                source_table,
                                target_table,
                                row_count,
                                round(time.perf_counter() - started, 3),
                                datetime.now(timezone.utc).isoformat(),
                            ],
                        )
            destination.commit()
            destination.execute("ANALYZE")
            destination.execute("PRAGMA optimize")
            destination.commit()
            integrity = destination.execute("PRAGMA integrity_check").fetchone()
            if not integrity or str(integrity[0]).casefold() != "ok":
                raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        publish_database(staging_path, final_path, manifest_path, keep_versions)
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
            run_schedule(args)
        else:
            run_tracked(args)
    except (RuntimeError, pyodbc.Error, sqlite3.Error, OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
