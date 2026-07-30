"""GUI-facing task boundary for shared Portal schema publication."""

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

from portal.app.schema.shared_publisher import SharedSchemaPublisher


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


def _configured_paths(settings_path: Path) -> tuple[Path, Path]:
    settings = _read_json(settings_path)
    data_root = str(settings.get("shared", {}).get("dataRoot", "")).strip()
    system_database = str(settings.get("system", {}).get("database", "")).strip()
    network_root = str(settings.get("businessSync", {}).get("networkRoot", "")).strip()
    if not data_root or not system_database or not network_root:
        raise ValueError("Portal settings must define shared.dataRoot, system.database, and businessSync.networkRoot.")
    return (
        _expand(system_database, settings_path=settings_path, data_root=data_root),
        _expand(network_root, settings_path=settings_path, data_root=data_root),
    )


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portal Workstation Manager schema task runner")
    parser.add_argument(
        "--task",
        choices=("schema.status", "schema.validate", "schema.plan", "schema.initialize", "schema.migrate"),
        required=True,
    )
    parser.add_argument("--portal-settings", type=Path, required=True)
    parser.add_argument("--confirmation", default="")
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    try:
        system_database, network_root = _configured_paths(args.portal_settings)
        publisher = SharedSchemaPublisher(system_database, network_root)
        if args.task == "schema.status":
            result = publisher.status()
        elif args.task == "schema.validate":
            result = publisher.validate()
        elif args.task == "schema.plan":
            result = publisher.plan()
        elif args.task == "schema.initialize":
            result = publisher.publish("baseline", args.confirmation)
        else:
            result = publisher.publish("migration", args.confirmation)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
