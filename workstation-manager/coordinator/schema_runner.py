"""GUI-facing task boundary for Portal local database schema maintenance."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


_RUNNER_DIRECTORY = Path(__file__).resolve().parent
for _candidate in (_RUNNER_DIRECTORY / "python", _RUNNER_DIRECTORY.parent.parent / "python"):
    if (_candidate / "portal" / "app" / "schema").is_dir():
        sys.path.insert(0, str(_candidate))
        break

from portal.app.schema.manager import SchemaManager


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object in {path}.")
    return payload


def _expand(value: str, *, settings_path: Path, data_root: str) -> Path:
    application_root = settings_path.resolve().parent.parent
    replacements = {
        "${PORTAL_APP_ROOT}": str(application_root),
        "${PORTAL_DATA_ROOT}": str(application_root),
        "${PORTAL_SHARED_DATA_ROOT}": data_root,
        "${PORTAL_BUSINESS_NETWORK_ROOT}": str(Path(data_root) / "portal" / "data"),
    }
    for token, replacement in replacements.items():
        value = value.replace(token, replacement)
    candidate = Path(os.path.expandvars(value))
    return candidate if candidate.is_absolute() else (settings_path.parent / candidate).resolve()


def _configured_databases(settings_path: Path) -> tuple[Path, Path]:
    settings = _read_json(settings_path)
    data_root = str(settings.get("shared", {}).get("dataRoot", "")).strip()
    system_database = str(settings.get("system", {}).get("database", "")).strip()
    business_database = str(settings.get("business", {}).get("database", "")).strip()
    if not data_root or not system_database or not business_database:
        raise ValueError("Portal settings must define shared.dataRoot, system.database, and business.database.")
    return (
        _expand(system_database, settings_path=settings_path, data_root=data_root),
        _expand(business_database, settings_path=settings_path, data_root=data_root),
    )


def _response(manager: SchemaManager, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "system_database": str(manager.system_database),
        "business_database": str(manager.business_database),
        **manager.status(),
        **result,
    }


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portal Workstation Manager schema task runner")
    parser.add_argument(
        "--task",
        choices=("schema.status", "schema.validate", "schema.plan", "schema.initialize", "schema.migrate", "schema.rollback"),
        required=True,
    )
    parser.add_argument("--portal-settings", type=Path, required=True)
    parser.add_argument("--confirmation", default="")
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    try:
        system_database, business_database = _configured_databases(args.portal_settings)
        manager = SchemaManager(system_database, business_database)
        if args.task == "schema.status":
            result = manager.status()
        elif args.task == "schema.validate":
            result = manager.validate()
        elif args.task == "schema.plan":
            result = manager.plan()
        elif args.task == "schema.initialize":
            if args.confirmation.strip() != str(business_database):
                raise ValueError("Type the configured local business database path exactly to initialize it.")
            result = manager.initialize()
        elif args.task == "schema.migrate":
            if args.confirmation.strip() != str(business_database):
                raise ValueError("Type the configured local business database path exactly to apply migrations.")
            result = manager.migrate()
        else:
            if args.confirmation.strip() != str(business_database):
                raise ValueError("Type the configured local business database path exactly to restore the previous copy.")
            result = manager.rollback()
        print(json.dumps({"ok": True, "result": _response(manager, result)}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
