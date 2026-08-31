from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.runtime.transport import APIRouter, Depends, HTTPException, Query

from portal.app.management.database import get_db
from portal.app.management.models import Resource, TeamFeaturedResource, User
from portal.app.management.router import get_current_user
from portal.app.management.security import utc_now_text
from portal.app.management.services import effective_resource_permission, serialize_resource
from portal.app.resources.aliases import canonical_resource_id
from portal.app.sync.errors import (
    LockTimeout,
    RevisionChanged,
    SharedRootUnavailable,
    SnapshotRequired,
    SyncError,
)
from portal.app.sync.models import Mutation
from portal.app.sync.physical_entities import USER_FAVORITE_ENTITY_TYPE, stable_global_id
from portal.app.sync.runtime import current_coordinator, sync_identity


router = APIRouter(tags=["user-favorites"])
TEAM_FEATURED_CATEGORY_ORDER = (
    "all",
    "dashboard",
    "map",
    "tab",
    "doc",
    "report",
    "dataset",
)


def normalize_favorite_category(category: str | None) -> str:
    normalized = (category or "all").strip().lower()
    if normalized not in TEAM_FEATURED_CATEGORY_ORDER:
        raise HTTPException(status_code=400, detail=f"Invalid favorites category: {normalized}.")
    return normalized


def favorite_entity_id(
    employee_number: str, resource_id: str, category: str = "all"
) -> str:
    normalized_category = normalize_favorite_category(category)
    # Preserve the first release's IDs for All Resources so existing synced
    # rows are upgraded in place rather than duplicated.
    parts = (
        (employee_number.strip(), canonical_resource_id(resource_id))
        if normalized_category == "all"
        else (
            employee_number.strip(),
            normalized_category,
            canonical_resource_id(resource_id),
        )
    )
    return stable_global_id(
        "favorite",
        *parts,
    )


def _sync_error(error: SyncError) -> None:
    if isinstance(error, RevisionChanged):
        status = 409
    elif isinstance(error, LockTimeout):
        status = 423
    elif isinstance(error, (SharedRootUnavailable, SnapshotRequired)):
        status = 503
    else:
        status = 422
    raise HTTPException(
        status_code=status,
        detail={"code": error.code, "message": str(error), "details": error.details},
    )


def _coordinator(user: User):
    try:
        return current_coordinator(
            sync_identity(user)
        )
    except SyncError as error:
        _sync_error(error)


def _entity_values(entity: dict[str, object] | None) -> dict[str, Any] | None:
    if not entity or bool(entity.get("deleted")):
        return None
    values = entity.get("values")
    return dict(values) if isinstance(values, dict) else None


def owned_favorite_values(
    entities: list[dict[str, object]], employee_number: str, category: str = "all"
) -> list[dict[str, Any]]:
    normalized_category = normalize_favorite_category(category)
    favorites: list[dict[str, Any]] = []
    for entity in entities:
        values = _entity_values(entity)
        if not values or str(values.get("owner_employee_number") or "") != employee_number:
            continue
        row_category = normalize_favorite_category(str(values.get("category") or "all"))
        if row_category != normalized_category:
            continue
        resource_id = canonical_resource_id(str(values.get("resource_id") or ""))
        if not resource_id:
            continue
        favorites.append(
            {
                **values,
                "category": row_category,
                "resource_id": resource_id,
                "sort_order": int(values.get("sort_order") or 0),
            }
        )
    favorites.sort(
        key=lambda item: (
            int(item.get("sort_order") or 0),
            str(item.get("created_at") or ""),
            str(item["resource_id"]),
        )
    )
    deduplicated: list[dict[str, Any]] = []
    seen: set[str] = set()
    for favorite in favorites:
        resource_id = str(favorite["resource_id"])
        if resource_id in seen:
            continue
        seen.add(resource_id)
        deduplicated.append(favorite)
    return deduplicated


def _favorite_entities(user: User, category: str) -> list[dict[str, object]]:
    normalized_category = normalize_favorite_category(category)
    try:
        return _coordinator(user).query_entities(
            USER_FAVORITE_ENTITY_TYPE,
            filters={
                "owner_employee_number": str(user.employee_id),
                "category": normalized_category,
            },
            order_by=(("sort_order", False), ("created_at", False), ("global_id", False)),
        )
    except SyncError as error:
        _sync_error(error)


def _all_favorite_entities(user: User, category: str) -> list[dict[str, object]]:
    normalized_category = normalize_favorite_category(category)
    try:
        return _coordinator(user).query_entities(
            USER_FAVORITE_ENTITY_TYPE,
            filters={
                "owner_employee_number": str(user.employee_id),
                "category": normalized_category,
            },
            order_by=(("sort_order", False), ("created_at", False), ("global_id", False)),
            include_deleted=True,
        )
    except SyncError as error:
        _sync_error(error)


def _accessible_resource(
    db: Session, user: User, resource_id: str
) -> tuple[Resource, dict[str, Any]]:
    resource = db.scalar(
        select(Resource).where(Resource.resource_id == canonical_resource_id(resource_id))
    )
    effective = effective_resource_permission(db, user, resource) if resource else None
    if (
        resource is None
        or effective is None
        or resource.resource_type in {"admin", "api", "service"}
    ):
        raise HTTPException(status_code=404, detail="An accessible Portal resource was not found.")
    return resource, effective


def _serialize_favorites(user: User, db: Session, category: str) -> dict[str, Any]:
    normalized_category = normalize_favorite_category(category)
    values = owned_favorite_values(
        _favorite_entities(user, normalized_category),
        str(user.employee_id),
        normalized_category,
    )
    favorites: list[dict[str, Any]] = []
    for favorite in values:
        resource = db.scalar(
            select(Resource).where(Resource.resource_id == favorite["resource_id"])
        )
        effective = effective_resource_permission(db, user, resource) if resource else None
        if (
            resource is None
            or effective is None
            or resource.resource_type in {"admin", "api", "service"}
        ):
            continue
        favorites.append(
            {
                "category": normalized_category,
                "resource_id": resource.resource_id,
                "sort_order": favorite["sort_order"],
                "created_at": favorite.get("created_at"),
                "updated_at": favorite.get("updated_at"),
                "resource": serialize_resource(resource, effective),
            }
        )
    return {
        "category": normalized_category,
        "favorites": favorites,
        "total": len(favorites),
    }


def _commit(user: User, mutations: Mutation | list[Mutation]) -> None:
    pending = [mutations] if isinstance(mutations, Mutation) else mutations
    if not pending:
        return
    try:
        _coordinator(user).commit(pending)
    except SyncError as error:
        _sync_error(error)


def _team_default_resources(
    user: User, db: Session, category: str
) -> list[Resource]:
    normalized_category = normalize_favorite_category(category)
    if user.team_id is None:
        return []
    rows = db.scalars(
        select(TeamFeaturedResource).where(
            TeamFeaturedResource.team_id == user.team_id,
            TeamFeaturedResource.category == normalized_category,
        )
    ).all()
    rows.sort(
        key=lambda row: (
            int(row.sort_order),
            int(row.id),
        )
    )
    resources: list[Resource] = []
    seen: set[str] = set()
    for row in rows:
        resource = row.resource or db.get(Resource, row.resource_record_id)
        if resource is None or resource.resource_id in seen:
            continue
        effective = effective_resource_permission(db, user, resource)
        if (
            effective is None
            or resource.resource_type in {"admin", "api", "service"}
        ):
            continue
        seen.add(resource.resource_id)
        resources.append(resource)
    return resources


def _replace_with_team_defaults(
    user: User, db: Session, category: str
) -> dict[str, Any]:
    normalized_category = normalize_favorite_category(category)
    resources = _team_default_resources(user, db, normalized_category)
    if not resources:
        return {
            "ok": True,
            "loaded": False,
            "message": f"This user's team has no accessible {normalized_category} featured resources.",
            **_serialize_favorites(user, db, normalized_category),
        }

    employee_number = str(user.employee_id)
    existing_entities = _all_favorite_entities(user, normalized_category)
    existing_by_resource: dict[str, dict[str, object]] = {}
    for entity in existing_entities:
        values = entity.get("values")
        if not isinstance(values, dict):
            continue
        if str(values.get("owner_employee_number") or "") != employee_number:
            continue
        resource_id = canonical_resource_id(str(values.get("resource_id") or ""))
        if resource_id:
            existing_by_resource[resource_id] = entity

    now = utc_now_text()
    desired_ids = {resource.resource_id for resource in resources}
    mutations: list[Mutation] = []
    for sort_order, resource in enumerate(resources):
        existing = existing_by_resource.get(resource.resource_id)
        entity_id = (
            str(existing["entity_id"])
            if existing is not None
            else favorite_entity_id(
                employee_number, resource.resource_id, normalized_category
            )
        )
        prior_values = (
            dict(existing.get("values"))
            if existing and isinstance(existing.get("values"), dict)
            else {}
        )
        values = {
            **prior_values,
            "owner_user_id": user.id,
            "owner_employee_number": employee_number,
            "category": normalized_category,
            "resource_id": resource.resource_id,
            "sort_order": sort_order,
            "created_at": prior_values.get("created_at") or now,
            "updated_at": now,
        }
        if existing is None:
            operation_type = "insert_entity"
            base_revision = None
        elif bool(existing.get("deleted")):
            operation_type = "restore_entity"
            base_revision = str(existing["record_revision"])
        elif (
            int(prior_values.get("owner_user_id") or 0) == int(user.id)
            and str(prior_values.get("owner_employee_number") or "")
            == employee_number
            and normalize_favorite_category(str(prior_values.get("category") or "all"))
            == normalized_category
            and canonical_resource_id(str(prior_values.get("resource_id") or ""))
            == resource.resource_id
            and int(prior_values.get("sort_order") or 0) == sort_order
        ):
            continue
        else:
            operation_type = "update_entity"
            base_revision = str(existing["record_revision"])
        mutations.append(
            Mutation(
                entity_type=USER_FAVORITE_ENTITY_TYPE,
                entity_id=entity_id,
                operation_type=operation_type,
                base_record_revision=base_revision,
                values=values,
                unique_lock_keys=(
                    f"user-favorite:{employee_number}:{normalized_category}:{resource.resource_id}",
                ),
            )
        )

    for resource_id, existing in existing_by_resource.items():
        if resource_id in desired_ids or bool(existing.get("deleted")):
            continue
        mutations.append(
            Mutation(
                entity_type=USER_FAVORITE_ENTITY_TYPE,
                entity_id=str(existing["entity_id"]),
                operation_type="delete_entity",
                base_record_revision=str(existing["record_revision"]),
                unique_lock_keys=(
                    f"user-favorite:{employee_number}:{normalized_category}:{resource_id}",
                ),
            )
        )

    _commit(user, mutations)
    return {
        "ok": True,
        "loaded": True,
        "message": f"Loaded {len(resources)} team {normalized_category} resources into My Favorites.",
        **_serialize_favorites(user, db, normalized_category),
    }


@router.get("/api/me/favorites")
def list_my_favorites(
    category: str = Query(default="all"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return _serialize_favorites(current_user, db, category)


@router.post("/api/me/favorites/load-team-settings")
def load_team_settings_into_my_favorites(
    category: str = Query(default="all"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return _replace_with_team_defaults(current_user, db, category)


@router.put("/api/me/favorites/{resource_id}")
def add_my_favorite(
    resource_id: str,
    category: str = Query(default="all"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    normalized_category = normalize_favorite_category(category)
    resource, _effective = _accessible_resource(db, current_user, resource_id)
    employee_number = str(current_user.employee_id)
    entity_id = favorite_entity_id(
        employee_number, resource.resource_id, normalized_category
    )
    current_values = owned_favorite_values(
        _favorite_entities(current_user, normalized_category),
        employee_number,
        normalized_category,
    )
    if any(item["resource_id"] == resource.resource_id for item in current_values):
        return {
            "ok": True,
            **_serialize_favorites(current_user, db, normalized_category),
        }

    coordinator = _coordinator(current_user)
    try:
        existing = coordinator.get_entity(USER_FAVORITE_ENTITY_TYPE, entity_id)
    except SyncError as error:
        _sync_error(error)

    existing_values = _entity_values(existing)
    if existing_values is not None:
        return {
            "ok": True,
            **_serialize_favorites(current_user, db, normalized_category),
        }

    now = utc_now_text()
    next_sort_order = max(
        (int(item.get("sort_order") or 0) for item in current_values),
        default=-1,
    ) + 1
    prior_values = (
        dict(existing.get("values"))
        if existing and isinstance(existing.get("values"), dict)
        else {}
    )
    values = {
        **prior_values,
        "owner_user_id": current_user.id,
        "owner_employee_number": employee_number,
        "category": normalized_category,
        "resource_id": resource.resource_id,
        "sort_order": next_sort_order,
        "created_at": prior_values.get("created_at") or now,
        "updated_at": now,
    }
    operation_type = "restore_entity" if existing else "insert_entity"
    _commit(
        current_user,
        Mutation(
            entity_type=USER_FAVORITE_ENTITY_TYPE,
            entity_id=entity_id,
            operation_type=operation_type,
            base_record_revision=(
                str(existing["record_revision"]) if existing else None
            ),
            values=values,
            unique_lock_keys=(
                f"user-favorite:{employee_number}:{normalized_category}:{resource.resource_id}",
            ),
        ),
    )
    return {
        "ok": True,
        **_serialize_favorites(current_user, db, normalized_category),
    }


@router.delete("/api/me/favorites/{resource_id}")
def remove_my_favorite(
    resource_id: str,
    category: str = Query(default="all"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    normalized_category = normalize_favorite_category(category)
    normalized_resource_id = canonical_resource_id(resource_id)
    employee_number = str(current_user.employee_id)
    matching_entities = []
    for entity in _favorite_entities(current_user, normalized_category):
        values = _entity_values(entity)
        if (
            values is not None
            and str(values.get("owner_employee_number") or "") == employee_number
            and canonical_resource_id(str(values.get("resource_id") or ""))
            == normalized_resource_id
        ):
            matching_entities.append(entity)
    if not matching_entities:
        return {
            "ok": True,
            **_serialize_favorites(current_user, db, normalized_category),
        }

    _commit(
        current_user,
        [
            Mutation(
                entity_type=USER_FAVORITE_ENTITY_TYPE,
                entity_id=str(existing["entity_id"]),
                operation_type="delete_entity",
                base_record_revision=str(existing["record_revision"]),
                unique_lock_keys=(
                    f"user-favorite:{employee_number}:{normalized_category}:{normalized_resource_id}",
                ),
            )
            for existing in matching_entities
        ],
    )
    return {
        "ok": True,
        **_serialize_favorites(current_user, db, normalized_category),
    }
