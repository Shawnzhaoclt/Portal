from __future__ import annotations

from portal.app.management.resource_ids import normalize_resource_id


CRITICAL_TEAM_DASHBOARD_RESOURCE_ID = "DASXKG5R"
CRITICAL_TEAM_DASHBOARD_LEGACY_RESOURCE_IDS = (
    "DASJ11R7",
    "DAS9O16A",
    "DASSXUK2",
    "DASVIE6O",
)
CRITICAL_TEAM_TABLES_RESOURCE_ID = "TABT6GCF"
CRITICAL_TEAM_TABLES_LEGACY_RESOURCE_IDS = (
    "TABBEJ3J",
    "TAB3SJ2X",
    "TABO9VIW",
)

RESOURCE_ID_ALIASES = {
    **{
        resource_id: CRITICAL_TEAM_DASHBOARD_RESOURCE_ID
        for resource_id in CRITICAL_TEAM_DASHBOARD_LEGACY_RESOURCE_IDS
    },
    **{
        resource_id: CRITICAL_TEAM_TABLES_RESOURCE_ID
        for resource_id in CRITICAL_TEAM_TABLES_LEGACY_RESOURCE_IDS
    },
}


def canonical_resource_id(resource_id: str | None) -> str:
    normalized = normalize_resource_id(resource_id)
    return RESOURCE_ID_ALIASES.get(normalized, normalized)
