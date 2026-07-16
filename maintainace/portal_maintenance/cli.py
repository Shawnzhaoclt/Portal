from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _default_management_db() -> Path:
    return PROJECT_ROOT / "backend" / "data" / "portal_management.sqlite3"


def _default_backup_path(database_path: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return PROJECT_ROOT / "maintainace" / "backups" / f"{database_path.stem}_{timestamp}.sqlite3"


def _configure_import_path() -> None:
    project_root = str(PROJECT_ROOT)
    if project_root not in sys.path:
        sys.path.insert(0, project_root)


def _database_path(value: str | None) -> Path:
    return Path(value).expanduser().resolve() if value else _default_management_db()


def _configure_database_env(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    import os

    os.environ["PORTAL_MANAGEMENT_DB"] = str(database_path)


def _database_summary(database_path: Path) -> dict[str, Any]:
    if not database_path.exists():
        return {"database": str(database_path), "exists": False}

    with sqlite3.connect(database_path) as connection:
        connection.row_factory = sqlite3.Row
        tables = [
            row["name"]
            for row in connection.execute(
                """
                SELECT name
                FROM sqlite_schema
                WHERE type = 'table'
                  AND (
                    name LIKE 'SYS_%'
                    OR name LIKE 'RPT5W1C0_%'
                  )
                ORDER BY name
                """
            )
        ]
        counts = {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in tables
        }
        resource_permission_columns = [
            row["name"]
            for row in connection.execute('PRAGMA table_info("SYS_RESOURCE_PERMISSIONS")')
        ] if "SYS_RESOURCE_PERMISSIONS" in tables else []
        foreign_key_errors = list(connection.execute("PRAGMA foreign_key_check"))

    return {
        "database": str(database_path),
        "exists": True,
        "tables": tables,
        "counts": counts,
        "resource_permission_columns": resource_permission_columns,
        "foreign_key_errors": len(foreign_key_errors),
    }


def _print_summary(summary: dict[str, Any], *, json_output: bool) -> None:
    if json_output:
        print(json.dumps(summary, indent=2))
        return
    if not summary.get("exists"):
        print(f"Database was not found: {summary.get('database')}")
        return
    print(f"Portal management database: {summary.get('database')}")
    print(f"Tracked tables: {len(summary.get('tables', []))}")
    for table, count in summary.get("counts", {}).items():
        print(f"  {table}: {count}")
    print(f"SYS_RESOURCE_PERMISSIONS columns: {', '.join(summary.get('resource_permission_columns', []))}")
    print(f"Foreign key errors: {summary.get('foreign_key_errors', 0)}")


def _run_upgrade(database_path: Path) -> None:
    _configure_database_env(database_path)
    _configure_import_path()

    from backend.app.management.database import create_management_schema, session_scope
    from backend.app.management.seed import seed_resources
    from backend.app.resources.reports.proactive_team_cctv_review import ensure_report_schema

    create_management_schema()
    with session_scope() as db:
        seed_resources(db)
    ensure_report_schema()


def init_db(args: argparse.Namespace) -> int:
    database_path = _database_path(args.db)
    _configure_database_env(database_path)
    _configure_import_path()

    from backend.app.management.seed import initialize_management_database
    from backend.app.resources.reports.proactive_team_cctv_review import ensure_report_schema

    initialize_management_database()
    ensure_report_schema()
    summary = _database_summary(database_path)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"Portal management database deployed: {database_path}")
        _print_summary(summary, json_output=False)
    return 0


def upgrade_db(args: argparse.Namespace) -> int:
    database_path = _database_path(args.db)
    _run_upgrade(database_path)
    summary = _database_summary(database_path)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"Portal management database upgraded: {database_path}")
        _print_summary(summary, json_output=False)
    return 0


def backup_db(args: argparse.Namespace) -> int:
    database_path = _database_path(args.db)
    if not database_path.exists():
        print(f"Database was not found: {database_path}", file=sys.stderr)
        return 1

    backup_path = Path(args.backup).expanduser().resolve() if args.backup else _default_backup_path(database_path)
    if backup_path.exists() and not args.force:
        print(f"Backup already exists. Use --force to overwrite: {backup_path}", file=sys.stderr)
        return 1
    backup_path.parent.mkdir(parents=True, exist_ok=True)

    with closing(sqlite3.connect(database_path)) as source, closing(sqlite3.connect(backup_path)) as destination:
        source.backup(destination)

    result = {
        "database": str(database_path),
        "backup": str(backup_path),
        "bytes": backup_path.stat().st_size,
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Backup created: {backup_path}")
        print(f"Source database: {database_path}")
        print(f"Bytes: {result['bytes']}")
    return 0


def restore_db(args: argparse.Namespace) -> int:
    database_path = _database_path(args.db)
    backup_path = Path(args.backup).expanduser().resolve()
    if not backup_path.exists():
        print(f"Backup was not found: {backup_path}", file=sys.stderr)
        return 1
    if database_path.exists() and not args.force:
        print(f"Target database exists. Use --force to restore over it: {database_path}", file=sys.stderr)
        return 1

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safety_backup_path: Path | None = None
    if database_path.exists() and not args.no_safety_backup:
        safety_backup_path = database_path.with_name(f"{database_path.stem}.pre_restore_{timestamp}{database_path.suffix}")
        with closing(sqlite3.connect(database_path)) as source, closing(sqlite3.connect(safety_backup_path)) as destination:
            source.backup(destination)

    database_path.parent.mkdir(parents=True, exist_ok=True)
    temp_restore_path = database_path.with_name(f"{database_path.name}.restore_tmp")
    if temp_restore_path.exists():
        temp_restore_path.unlink()
    try:
        with closing(sqlite3.connect(backup_path)) as source, closing(sqlite3.connect(temp_restore_path)) as destination:
            source.backup(destination)
        temp_restore_path.replace(database_path)
    finally:
        if temp_restore_path.exists():
            temp_restore_path.unlink()

    summary = _database_summary(database_path)
    result = {
        "database": str(database_path),
        "restored_from": str(backup_path),
        "safety_backup": str(safety_backup_path) if safety_backup_path else None,
        "foreign_key_errors": summary.get("foreign_key_errors", 0),
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Database restored: {database_path}")
        print(f"Restored from: {backup_path}")
        if safety_backup_path:
            print(f"Previous database backup: {safety_backup_path}")
        print(f"Foreign key errors: {result['foreign_key_errors']}")
    return 0 if result["foreign_key_errors"] == 0 else 2


def summary(args: argparse.Namespace) -> int:
    database_path = _database_path(args.db)
    data = _database_summary(database_path)
    _print_summary(data, json_output=args.json)
    if not data.get("exists"):
        return 1
    return 0 if data.get("foreign_key_errors", 0) == 0 else 2


def _add_common_db_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--db", help="SQLite management DB path. Defaults to backend/data/portal_management.sqlite3.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Portal database maintainace utilities.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init-db", help="Deploy the management DB.")
    _add_common_db_argument(init_parser)
    init_parser.add_argument("--json", action="store_true", help="Print JSON summary.")
    init_parser.set_defaults(func=init_db)

    upgrade_parser = subparsers.add_parser("upgrade-db", help="Apply database upgrades and refresh resource metadata.")
    _add_common_db_argument(upgrade_parser)
    upgrade_parser.add_argument("--json", action="store_true", help="Print JSON summary.")
    upgrade_parser.set_defaults(func=upgrade_db)

    backup_parser = subparsers.add_parser("backup-db", help="Create a SQLite backup of the management DB.")
    _add_common_db_argument(backup_parser)
    backup_parser.add_argument("--backup", help="Backup file path. Defaults to maintainace/backups/<db>_<timestamp>.sqlite3.")
    backup_parser.add_argument("--force", action="store_true", help="Overwrite an existing backup path.")
    backup_parser.add_argument("--json", action="store_true", help="Print JSON summary.")
    backup_parser.set_defaults(func=backup_db)

    restore_parser = subparsers.add_parser("restore-db", help="Restore the management DB from a backup.")
    _add_common_db_argument(restore_parser)
    restore_parser.add_argument("--backup", required=True, help="Backup file to restore from.")
    restore_parser.add_argument("--force", action="store_true", help="Allow overwriting an existing target database.")
    restore_parser.add_argument("--no-safety-backup", action="store_true", help="Do not create a pre-restore backup of the existing target.")
    restore_parser.add_argument("--json", action="store_true", help="Print JSON summary.")
    restore_parser.set_defaults(func=restore_db)

    summary_parser = subparsers.add_parser("summary", help="Print a management DB summary.")
    _add_common_db_argument(summary_parser)
    summary_parser.add_argument("--json", action="store_true", help="Print JSON summary.")
    summary_parser.set_defaults(func=summary)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))
