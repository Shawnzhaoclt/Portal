#!/usr/bin/env python
"""Zip local DuckDB databases into a date-stamped backup archive."""

from __future__ import annotations

from datetime import date, datetime, timedelta
import json
from pathlib import Path, PurePosixPath
import re
from zipfile import ZIP_DEFLATED, ZipFile


SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "backup_duckdb_files.json"


def load_config(path: Path) -> dict:
    try:
        with path.open(encoding="utf-8") as config_file:
            config = json.load(config_file)
    except FileNotFoundError as exc:
        raise SystemExit(f"Configuration file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in configuration file {path}: {exc}") from exc

    required = {
        "duckdb_source_dir",
        "backup_dir",
        "directory_sources",
        "archive_prefix",
        "retention_days",
    }
    missing = sorted(required - set(config))
    if missing:
        raise SystemExit(f"Missing configuration setting(s): {', '.join(missing)}")
    return config


def configured_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else CONFIG_PATH.parent / path


CONFIG = load_config(CONFIG_PATH)
SOURCE_DIR = configured_path(CONFIG["duckdb_source_dir"])
BACKUP_DIR = configured_path(CONFIG["backup_dir"])
DIRECTORY_SOURCES = {
    configured_path(item["source"]): PurePosixPath(item["archive_path"])
    for item in CONFIG["directory_sources"]
}
ARCHIVE_PREFIX = str(CONFIG["archive_prefix"])
RETENTION_DAYS = int(CONFIG["retention_days"])
EXCLUDED_DUCKDB_FILES = {
    str(value).lower()
    for value in CONFIG.get("exclude_duckdb_files", [])
    if str(value).strip()
}
ARCHIVE_NAME_PATTERN = re.compile(
    rf"^{re.escape(ARCHIVE_PREFIX)}_(\d{{4}}-\d{{2}}-\d{{2}})\.zip$",
    re.IGNORECASE,
)


def delete_expired_backups(today: date | None = None) -> int:
    cutoff_date = (today or date.today()) - timedelta(days=RETENTION_DAYS)
    deleted_count = 0

    for path in BACKUP_DIR.iterdir():
        if not path.is_file():
            continue
        match = ARCHIVE_NAME_PATTERN.fullmatch(path.name)
        if not match:
            continue
        try:
            archive_date = datetime.strptime(match.group(1), "%Y-%m-%d").date()
        except ValueError:
            continue
        if archive_date < cutoff_date:
            print(f"Deleting expired backup: {path}")
            path.unlink()
            deleted_count += 1

    return deleted_count


def add_directory_to_archive(
    archive: ZipFile,
    source_dir: Path,
    archive_dir: PurePosixPath,
) -> int:
    if not source_dir.is_dir():
        raise RuntimeError(f"Source directory does not exist: {source_dir}")

    files = sorted(path for path in source_dir.rglob("*") if path.is_file())
    for path in files:
        relative_path = PurePosixPath(*path.relative_to(source_dir).parts)
        archive_path = archive_dir / relative_path
        print(f"Adding: {archive_path}")
        archive.write(path, arcname=str(archive_path))
    return len(files)


def backup_duckdb_files() -> Path:
    if not SOURCE_DIR.is_dir():
        raise RuntimeError(f"Source directory does not exist: {SOURCE_DIR}")

    duckdb_files = sorted(
        path for path in SOURCE_DIR.iterdir()
        if (
            path.is_file()
            and path.suffix.lower() == ".duckdb"
            and path.name.lower() not in EXCLUDED_DUCKDB_FILES
        )
    )
    if not duckdb_files:
        raise RuntimeError(f"No DuckDB files found in: {SOURCE_DIR}")

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    expired_count = delete_expired_backups()
    print(f"Expired backups deleted: {expired_count}")

    archive_path = BACKUP_DIR / f"{ARCHIVE_PREFIX}_{date.today():%Y-%m-%d}.zip"
    temporary_path = archive_path.with_suffix(".zip.tmp")

    if archive_path.exists():
        print(f"Deleting existing backup: {archive_path}")
        archive_path.unlink()
    if temporary_path.exists():
        temporary_path.unlink()

    try:
        archived_count = 0
        with ZipFile(temporary_path, mode="w", compression=ZIP_DEFLATED) as archive:
            for duckdb_path in duckdb_files:
                print(f"Adding: {duckdb_path.name}")
                archive.write(
                    duckdb_path,
                    arcname=str(PurePosixPath("datasources", duckdb_path.name)),
                )
                archived_count += 1
            for source_dir, archive_dir in DIRECTORY_SOURCES.items():
                archived_count += add_directory_to_archive(
                    archive,
                    source_dir,
                    archive_dir,
                )
        temporary_path.replace(archive_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise

    print(f"Created backup: {archive_path}")
    print(f"Files archived: {archived_count}")
    return archive_path


def main() -> int:
    try:
        backup_duckdb_files()
    except Exception as exc:
        print(f"Backup failed: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
