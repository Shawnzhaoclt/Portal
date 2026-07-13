from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from backend.app.management.models import AuditLog, Resource, ResourcePermission, Team, User
from backend.app.management.resource_ids import normalize_resource_id, resource_id_validation_error
from backend.app.management.security import utc_now_text
from backend.app.resources.metadata import load_resource_metadata

PERMISSION_TYPES = {
    "view": 1,
    "edit": 2,
    "review": 4,
    "create": 8,
    "delete": 16,
    "manage": 32,
    "admin": 64,
}
ALL_PERMISSION_MASK = sum(PERMISSION_TYPES.values())

ROLE_USER = "user"
ROLE_ADMIN = "admin"
ROLE_SYSTEM_ADMIN = "system_admin"
ADMIN_ROLES = {ROLE_ADMIN, ROLE_SYSTEM_ADMIN}
ALL_ROLES = {ROLE_USER, ROLE_ADMIN, ROLE_SYSTEM_ADMIN}


def bool_int(value: bool | int | None) -> int:
    return 1 if bool(value) else 0


def display_name(user: User | None) -> str | None:
    if user is None:
        return None
    return f"{user.first_name} {user.last_name}".strip()


def available_roles(user: User) -> list[str]:
    roles = [ROLE_USER]
    if user.is_admin or user.is_system_admin:
        roles.append(ROLE_ADMIN)
    if user.is_system_admin:
        roles.append(ROLE_SYSTEM_ADMIN)
    return roles


def selected_user_role(user: User) -> str:
    selected = getattr(user, "_portal_selected_role", None)
    if selected in available_roles(user):
        return selected
    if user.is_system_admin:
        return ROLE_SYSTEM_ADMIN
    if user.is_admin:
        return ROLE_ADMIN
    return ROLE_USER


def set_selected_user_role(user: User, role: str) -> None:
    if role not in available_roles(user):
        raise HTTPException(status_code=403, detail="Selected role is not available for this user.")
    setattr(user, "_portal_selected_role", role)


def is_management_admin_session(user: User) -> bool:
    return selected_user_role(user) in ADMIN_ROLES


def is_system_admin_session(user: User) -> bool:
    return selected_user_role(user) == ROLE_SYSTEM_ADMIN


def require_management_admin(user: User) -> None:
    if not is_management_admin_session(user):
        raise HTTPException(status_code=403, detail="Portal admin access is required.")


def require_system_admin(user: User) -> None:
    if not is_system_admin_session(user):
        raise HTTPException(status_code=403, detail="System admin access is required.")


def write_audit_log(
    db: Session,
    actor: User | None,
    action: str,
    target_type: str,
    target_id: int | None,
    details: dict[str, Any] | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_user_id=actor.id if actor else None,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details_json=json.dumps(details or {}, default=str, separators=(",", ":")),
        )
    )


def active_user_query():
    return select(User).where(User.deleted_at.is_(None))


def get_user_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(status_code=404, detail="User was not found.")
    return user


def get_team_or_404(db: Session, team_id: int) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team was not found.")
    return team


def get_resource_or_404(db: Session, resource_id: int) -> Resource:
    resource = db.get(Resource, resource_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Resource was not found.")
    return resource


def get_resource_by_public_id_or_404(db: Session, resource_id: str) -> Resource:
    normalized = normalize_resource_id(resource_id)
    if not normalized:
        raise HTTPException(status_code=404, detail="Resource was not found.")
    resource = db.scalar(select(Resource).where(Resource.resource_id == normalized))
    if resource is None:
        raise HTTPException(status_code=404, detail="Resource was not found.")
    return resource


def team_ancestor_ids(db: Session, team_id: int | None) -> list[int]:
    if team_id is None:
        return []

    ids: list[int] = []
    seen: set[int] = set()
    current_id: int | None = team_id
    while current_id is not None and current_id not in seen:
        seen.add(current_id)
        ids.append(current_id)
        team = db.get(Team, current_id)
        current_id = team.parent_team_id if team else None
    return ids


def team_descendant_ids(db: Session, root_team_ids: list[int]) -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    pending = list(root_team_ids)

    while pending:
        current_id = pending.pop()
        if current_id in seen:
            continue
        seen.add(current_id)
        ids.append(current_id)
        child_ids = db.scalars(select(Team.id).where(Team.parent_team_id == current_id)).all()
        pending.extend(int(child_id) for child_id in child_ids)

    return ids


def managed_team_scope_ids(db: Session, user: User) -> list[int]:
    managed_root_ids = db.scalars(
        select(Team.id).where(
            Team.manager_user_id == user.id,
            Team.is_active == 1,
        )
    ).all()
    return team_descendant_ids(db, [int(team_id) for team_id in managed_root_ids])


def creates_team_cycle(db: Session, team_id: int, parent_team_id: int | None) -> bool:
    current_id = parent_team_id
    seen: set[int] = set()
    while current_id is not None and current_id not in seen:
        if current_id == team_id:
            return True
        seen.add(current_id)
        team = db.get(Team, current_id)
        current_id = team.parent_team_id if team else None
    return False


def permission_label(level: int | None) -> str | None:
    if level is None:
        return None
    labels = permission_types(level)
    return ", ".join(labels) if labels else None


def permission_types(level: int | None) -> list[str]:
    if not level:
        return []
    return [name for name, bit in PERMISSION_TYPES.items() if int(level) & bit]


def is_valid_permission_mask(level: int | None) -> bool:
    return bool(level) and int(level) > 0 and int(level) & ~ALL_PERMISSION_MASK == 0


def combine_permission_masks(levels) -> int:
    result = 0
    for level in levels:
        if level:
            result |= int(level)
    return result


def permission_result(level: int, sources: list[str] | tuple[str, ...]) -> dict[str, Any] | None:
    if not level:
        return None
    unique_sources = list(dict.fromkeys(source for source in sources if source))
    return {
        "permission_level": level,
        "permission": permission_label(level),
        "permission_types": permission_types(level),
        "source": " + ".join(unique_sources),
    }


def effective_resource_permission(db: Session, user: User, resource: Resource) -> dict[str, Any] | None:
    if resource.is_active != 1:
        return None

    permission_mask = 0
    sources: list[str] = []

    if resource.is_public:
        permission_mask |= PERMISSION_TYPES["view"]
        sources.append("public")

    active_role = selected_user_role(user)
    if active_role == ROLE_SYSTEM_ADMIN:
        return permission_result(ALL_PERMISSION_MASK, ["system_admin"])

    if active_role == ROLE_ADMIN:
        return permission_result(ALL_PERMISSION_MASK, ["portal_admin"])

    team_permission_scopes = [
        (team_ancestor_ids(db, user.team_id), "team"),
        (managed_team_scope_ids(db, user), "managed_team"),
    ]
    for team_ids, team_source in team_permission_scopes:
        if not team_ids:
            continue
        team_permission = combine_permission_masks(db.scalars(
            select(ResourcePermission.permission_level).where(
                ResourcePermission.resource_id == resource.resource_id,
                ResourcePermission.team_id.in_(team_ids),
            )
        ).all())
        if team_permission:
            permission_mask |= team_permission
            sources.append(team_source)

    direct_permission = combine_permission_masks(db.scalars(
        select(ResourcePermission.permission_level).where(
            ResourcePermission.resource_id == resource.resource_id,
            ResourcePermission.user_id == user.id,
        )
    ).all())
    if direct_permission:
        permission_mask |= direct_permission
        sources.append("user")

    return permission_result(permission_mask, sources)


def serialize_team(db: Session, team: Team) -> dict[str, Any]:
    manager = db.get(User, team.manager_user_id) if team.manager_user_id else None
    member_count = db.scalar(select(func.count()).select_from(User).where(User.team_id == team.id, User.deleted_at.is_(None))) or 0
    return {
        "id": team.id,
        "name": team.name,
        "description": team.description,
        "parent_team_id": team.parent_team_id,
        "manager_user_id": team.manager_user_id,
        "manager_name": display_name(manager),
        "is_active": bool(team.is_active),
        "member_count": int(member_count),
        "created_at": team.created_at,
        "updated_at": team.updated_at,
    }


def serialize_user(db: Session, user: User) -> dict[str, Any]:
    team = db.get(Team, user.team_id) if user.team_id else None
    manager = db.get(User, team.manager_user_id) if team and team.manager_user_id else None
    return {
        "id": user.id,
        "username": user.username,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "display_name": display_name(user),
        "email": user.email,
        "employee_id": user.employee_id,
        "team_id": user.team_id,
        "team_name": team.name if team else None,
        "manager_user_id": manager.id if manager else None,
        "manager_name": display_name(manager),
        "is_active": bool(user.is_active),
        "is_system_admin": bool(user.is_system_admin),
        "is_admin": bool(user.is_admin),
        "roles": available_roles(user),
        "selected_role": selected_user_role(user),
        "must_change_password": bool(user.must_change_password),
        "last_login_at": user.last_login_at,
        "password_changed_at": user.password_changed_at,
        "deleted_at": user.deleted_at,
        "created_at": user.created_at,
        "updated_at": user.updated_at,
    }


def serialize_resource(resource: Resource, effective: dict[str, Any] | None = None) -> dict[str, Any]:
    metadata = next((item for item in load_resource_metadata() if item.get("resource_slug") == resource.resource_key), {})
    return {
        "id": resource.id,
        "resource_id": resource.resource_id,
        "resource_slug": resource.resource_key,
        "resource_key": resource.resource_key,
        "name": resource.name,
        "resource_type": resource.resource_type,
        "url": resource.url,
        "description": resource.description,
        "category": resource.category,
        "icon": resource.icon,
        "help_url": metadata.get("help_url"),
        "is_public": bool(resource.is_public),
        "is_active": bool(resource.is_active),
        "created_at": resource.created_at,
        "updated_at": resource.updated_at,
        "effective_permission": effective,
    }


def _resource_key_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug or "resource"


def _api_resource_name(path: str) -> str:
    clean = path.strip("/") or "root"
    return clean.replace("_", " ").replace("-", " ").replace("/", " / ").title()


def _discovered_resource(
    *,
    resource_id: str | None,
    resource_key: str,
    name: str,
    resource_type: str,
    url: str,
    description: str | None,
    category: str | None,
    source: str,
    icon: str | None = None,
) -> dict[str, Any]:
    return {
        "resource_id": normalize_resource_id(resource_id) or None,
        "resource_slug": resource_key,
        "resource_key": resource_key,
        "name": name,
        "resource_type": resource_type,
        "url": url,
        "description": description,
        "category": category,
        "icon": icon,
        "is_public": False,
        "is_active": True,
        "source": source,
    }


def _frontend_resource_candidates() -> list[dict[str, Any]]:
    items = []
    for item in load_resource_metadata():
        items.append(
            _discovered_resource(
                resource_id=item.get("resource_id"),
                resource_key=item["resource_slug"],
                name=item["name"],
                resource_type=item["type"],
                url=item["url"],
                description=item.get("description"),
                category=item.get("category"),
                source=item.get("_metadata_path") or "resource_metadata",
                icon=item.get("icon"),
            )
        )
    return items


def _api_resource_candidates(app_routes: list[Any], openapi_paths: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    skip_paths = {"/docs", "/redoc", "/openapi.json"}

    for path, operations in (openapi_paths or {}).items():
        if path in skip_paths:
            continue
        if not (path == "/" or path == "/health" or path.startswith("/api/")):
            continue
        methods = {method.upper() for method in operations if method.upper() not in {"HEAD", "OPTIONS", "PARAMETERS"}}
        if not methods:
            continue
        operation_tags = set()
        operation_summaries = []
        for operation in operations.values():
            if not isinstance(operation, dict):
                continue
            operation_tags.update(operation.get("tags", []) or [])
            if operation.get("summary"):
                operation_summaries.append(operation["summary"])
        grouped[path] = {
            "methods": methods,
            "tags": operation_tags,
            "summary": operation_summaries[0] if operation_summaries else None,
            "name": None,
        }

    for route in app_routes:
        path = getattr(route, "path", "")
        if not path or path in skip_paths:
            continue
        if not (path == "/" or path == "/health" or path.startswith("/api/")):
            continue
        methods = sorted((getattr(route, "methods", set()) or set()) - {"HEAD", "OPTIONS"})
        if not methods:
            continue
        if path not in grouped:
            grouped[path] = {
                "methods": set(),
                "tags": set(getattr(route, "tags", []) or []),
                "summary": getattr(route, "summary", None),
                "name": getattr(route, "name", None),
            }
        grouped[path]["methods"].update(methods)
        grouped[path]["tags"].update(getattr(route, "tags", []) or [])

    items = []
    for path, metadata in sorted(grouped.items()):
        methods = ", ".join(sorted(metadata["methods"]))
        tags = sorted(metadata["tags"])
        category = tags[0].replace("-", " ").title() if tags else "API"
        name = metadata.get("summary") or _api_resource_name(path)
        items.append(
            _discovered_resource(
                resource_id=None,
                resource_key=f"api_{_resource_key_slug(path)}",
                name=name,
                resource_type="api",
                url=path,
                description=f"{methods} {path}",
                category=category,
                source="fastapi_route",
                icon="plug",
            )
        )
    return items


def _resource_changes(resource: Resource, candidate: dict[str, Any]) -> dict[str, dict[str, Any]]:
    changes: dict[str, dict[str, Any]] = {}
    for field in ("resource_id", "resource_key", "name", "resource_type", "url", "description", "category", "icon"):
        current_value = getattr(resource, field)
        candidate_value = candidate.get(field)
        if (current_value or None) != (candidate_value or None):
            changes[field] = {"current": current_value, "detected": candidate_value}
    if resource.is_active != 1:
        changes["is_active"] = {"current": bool(resource.is_active), "detected": True}
    return changes


def discover_resource_candidates(db: Session, app_routes: list[Any], openapi_paths: dict[str, Any] | None = None) -> dict[str, Any]:
    detected_candidates = [*_frontend_resource_candidates(), *_api_resource_candidates(app_routes, openapi_paths)]
    id_counts: dict[str, int] = {}
    for candidate in detected_candidates:
        candidate["resource_id"] = normalize_resource_id(candidate.get("resource_id")) or None
        if candidate["resource_id"]:
            id_counts[candidate["resource_id"]] = id_counts.get(candidate["resource_id"], 0) + 1
    duplicate_detected_ids = {resource_id for resource_id, count in id_counts.items() if count > 1}

    detected: dict[str, dict[str, Any]] = {}
    for candidate in detected_candidates:
        detected[candidate["resource_key"]] = candidate

    resources = db.scalars(select(Resource).order_by(Resource.resource_type, Resource.name)).all()
    existing_by_string_id = {resource.resource_id: resource for resource in resources}
    existing_by_key = {resource.resource_key: resource for resource in resources}
    existing_by_url = {resource.url: resource for resource in resources}

    items: list[dict[str, Any]] = []
    matched_existing_ids: set[int] = set()
    for candidate in sorted(detected.values(), key=lambda item: (item["resource_type"], item["name"], item["url"])):
        id_problem = resource_id_validation_error(candidate.get("resource_id"), candidate["resource_type"])
        if candidate.get("resource_id") in duplicate_detected_ids:
            id_problem = f"Resource ID {candidate['resource_id']} is declared by multiple resources."

        id_match = existing_by_string_id.get(candidate["resource_id"]) if not id_problem else None
        key_match = existing_by_key.get(candidate["resource_key"])
        url_match = existing_by_url.get(candidate["url"])
        matches = [match for match in (id_match, key_match, url_match) if match is not None]
        existing = matches[0] if matches else None

        if id_problem:
            changes = {"resource_id": {"current": getattr(existing, "resource_id", None), "detected": candidate.get("resource_id"), "reason": id_problem}}
            items.append({**candidate, "status": "invalid", "existing_resource_id": getattr(existing, "id", None), "existing_resource_key": getattr(existing, "resource_key", None), "changes": changes})
            if existing is not None:
                matched_existing_ids.add(existing.id)
            continue

        distinct_match_ids = {match.id for match in matches}
        if len(distinct_match_ids) > 1:
            changes = {
                "resource_id": {"current": getattr(id_match, "resource_id", None), "detected": candidate.get("resource_id")},
                "resource_key": {"current": getattr(key_match, "resource_key", None), "detected": candidate["resource_key"]},
                "url": {"current": getattr(url_match, "url", None), "detected": candidate["url"]},
            }
            items.append({**candidate, "status": "conflict", "existing_resource_id": getattr(existing, "id", None), "existing_resource_key": getattr(existing, "resource_key", None), "changes": changes})
            if existing is not None:
                matched_existing_ids.add(existing.id)
            continue

        if existing is None:
            items.append({**candidate, "status": "new", "existing_resource_id": None, "changes": {}})
            continue

        matched_existing_ids.add(existing.id)
        changes = _resource_changes(existing, candidate)
        status = "changed" if changes else "unchanged"
        items.append(
            {
                **candidate,
                "status": status,
                "existing_resource_id": existing.id,
                "existing_resource_key": existing.resource_key,
                "changes": changes,
            }
        )

    detected_urls = {candidate["url"] for candidate in detected.values()}
    detected_keys = set(detected)
    for resource in resources:
        if resource.id in matched_existing_ids or resource.resource_key in detected_keys or resource.url in detected_urls:
            continue
        items.append(
            {
                **serialize_resource(resource),
                "source": "management_database",
                "status": "stale" if resource.is_active else "inactive_stale",
                "existing_resource_id": resource.id,
                "existing_resource_key": resource.resource_key,
                "changes": {"is_active": {"current": bool(resource.is_active), "detected": False}} if resource.is_active else {},
            }
        )

    status_counts: dict[str, int] = {}
    for item in items:
        status_counts[item["status"]] = status_counts.get(item["status"], 0) + 1
    return {"resources": items, "counts": status_counts}


def serialize_permission(db: Session, permission: ResourcePermission) -> dict[str, Any]:
    resource = db.scalar(select(Resource).where(Resource.resource_id == permission.resource_id))
    user = db.get(User, permission.user_id) if permission.user_id else None
    team = db.get(Team, permission.team_id) if permission.team_id else None
    return {
        "id": permission.id,
        "resource_id": permission.resource_id,
        "resource_name": resource.name if resource else None,
        "user_id": permission.user_id,
        "user_name": display_name(user),
        "team_id": permission.team_id,
        "team_name": team.name if team else None,
        "permission_level": permission.permission_level,
        "permission": permission_label(permission.permission_level),
        "permission_types": permission_types(permission.permission_level),
        "created_by_user_id": permission.created_by_user_id,
        "created_at": permission.created_at,
        "updated_at": permission.updated_at,
    }


def accessible_resources(db: Session, user: User) -> list[dict[str, Any]]:
    resources = db.scalars(select(Resource).where(Resource.is_active == 1).order_by(Resource.resource_type, Resource.name)).all()
    result = []
    for resource in resources:
        effective = effective_resource_permission(db, user, resource)
        if effective:
            result.append(serialize_resource(resource, effective))
    return result


def find_login_user(db: Session, login: str) -> User | None:
    value = login.strip()
    if not value:
        return None
    return db.scalar(
        active_user_query().where(
            or_(
                User.username == value,
                User.email == value,
                User.employee_id == value,
            )
        )
    )


def mark_login_success(user: User) -> None:
    user.failed_login_count = 0
    user.last_login_at = utc_now_text()


def mark_login_failure(user: User) -> None:
    user.failed_login_count = int(user.failed_login_count or 0) + 1
