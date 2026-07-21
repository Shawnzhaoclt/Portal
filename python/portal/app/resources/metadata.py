from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from portal.app.core.paths import PORTAL_PACKAGE_ROOT, PROJECT_ROOT, SOURCE_LAYOUT

RESOURCE_METADATA_ROOT = (
    PROJECT_ROOT / "ui" / "src" / "resources"
    if SOURCE_LAYOUT
    else PORTAL_PACKAGE_ROOT / "resource_metadata"
)


@lru_cache(maxsize=1)
def load_resource_metadata() -> list[dict[str, Any]]:
    resources = []
    for metadata_path in sorted(RESOURCE_METADATA_ROOT.rglob("resource.json")):
        with metadata_path.open("r", encoding="utf-8") as file:
            resource = json.load(file)
        if not isinstance(resource, dict):
            raise ValueError(f"Resource metadata file {metadata_path} must contain a JSON object.")
        resource["_metadata_path"] = str(metadata_path.relative_to(RESOURCE_METADATA_ROOT))
        resources.append(resource)
    return resources


def resource_metadata_by_slug() -> dict[str, dict[str, Any]]:
    return {item["resource_slug"]: item for item in load_resource_metadata()}


def catalog_resource_metadata() -> list[dict[str, Any]]:
    return [item for item in load_resource_metadata() if item.get("show_in_catalog", True)]
