from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
from pathlib import Path


REPORT_TABLES = (
    "RPT5W1C0_reports",
    "RPT5W1C0_pipes",
    "RPT5W1C0_distance_groups",
    "RPT5W1C0_observations",
    "RPT5W1C0_report_events",
)


def build_desktop_seeds(source: Path, system_target: Path, business_target: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"Management database seed was not found: {source}")
    system_target.parent.mkdir(parents=True, exist_ok=True)
    business_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, system_target)
    business_target.unlink(missing_ok=True)

    os.environ["PORTAL_SYSTEM_DB"] = str(system_target)
    os.environ["PORTAL_MANAGEMENT_DB"] = str(system_target)
    os.environ["PORTAL_BUSINESS_DB"] = str(business_target)

    from portal.app.business.database import business_engine
    from portal.app.resources.reports.proactive_team_cctv_review.router import ensure_report_schema

    ensure_report_schema()
    business_engine.dispose()

    with sqlite3.connect(system_target) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        for table_name in reversed(REPORT_TABLES):
            connection.execute(f'DROP TABLE IF EXISTS "{table_name}"')
        connection.commit()
        connection.execute("VACUUM")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build separated Portal system and business SQLite seeds.")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--system", type=Path, required=True)
    parser.add_argument("--business", type=Path, required=True)
    args = parser.parse_args()
    build_desktop_seeds(args.source.resolve(), args.system.resolve(), args.business.resolve())


if __name__ == "__main__":
    main()
