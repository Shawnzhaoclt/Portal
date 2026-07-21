from __future__ import annotations

import re
import secrets
import string
from collections.abc import Iterable

RESOURCE_TYPE_PREFIXES = {
    "report": "RPT",
    "doc": "DOC",
    "map": "MAP",
    "dashboard": "DAS",
    "tab": "TAB",
    "dataset": "DST",
    "service": "SEV",
    "api": "API",
    "admin": "ADM",
}

RESOURCE_ID_RANDOM_ALPHABET = string.ascii_uppercase + string.digits
RESOURCE_ID_PATTERN = re.compile(r"^[A-Z]{3}[A-Z0-9]{5}$")


def resource_type_prefix(resource_type: str) -> str:
    try:
        return RESOURCE_TYPE_PREFIXES[resource_type]
    except KeyError as exc:
        raise ValueError(f"Unsupported resource type: {resource_type}") from exc


def normalize_resource_id(resource_id: str | None) -> str:
    return (resource_id or "").strip().upper()


def is_valid_resource_id(resource_id: str | None, resource_type: str | None = None) -> bool:
    normalized = normalize_resource_id(resource_id)
    if not normalized or not RESOURCE_ID_PATTERN.fullmatch(normalized):
        return False
    if resource_type is None:
        return normalized[:3] in set(RESOURCE_TYPE_PREFIXES.values())
    return normalized.startswith(resource_type_prefix(resource_type))


def resource_id_validation_error(resource_id: str | None, resource_type: str) -> str | None:
    normalized = normalize_resource_id(resource_id)
    if not normalized:
        return "Resource ID is required."
    if not RESOURCE_ID_PATTERN.fullmatch(normalized):
        return "Resource ID must use a three-letter type prefix followed by five uppercase letters or digits."
    expected_prefix = resource_type_prefix(resource_type)
    if not normalized.startswith(expected_prefix):
        return f"Resource ID for {resource_type} resources must start with {expected_prefix}."
    return None


def random_resource_id(existing_ids: Iterable[str | None], resource_type: str) -> str:
    prefix = resource_type_prefix(resource_type)
    used = {resource_id for resource_id in existing_ids if resource_id and RESOURCE_ID_PATTERN.fullmatch(resource_id)}

    for _ in range(10000):
        suffix = "".join(secrets.choice(RESOURCE_ID_RANDOM_ALPHABET) for _ in range(5))
        candidate = f"{prefix}{suffix}"
        if candidate not in used:
            return candidate

    raise ValueError(f"Unable to allocate a legacy migration resource ID for type {resource_type}")
