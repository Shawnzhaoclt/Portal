from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.management.models import Resource
from portal.app.management.resource_ids import normalize_resource_id, resource_id_validation_error
from portal.app.resources.metadata import load_resource_metadata


def seed_resources(db: Session) -> None:
    def declared_id(resource_id: str | None, resource_type: str) -> str:
        error = resource_id_validation_error(resource_id, resource_type)
        if error:
            raise ValueError(error)
        return normalize_resource_id(resource_id)

    def ensure_id_available(resource: Resource, resource_string_id: str) -> None:
        conflict = db.scalar(select(Resource).where(Resource.resource_id == resource_string_id, Resource.id != resource.id))
        if conflict is not None:
            raise ValueError(f"Resource ID {resource_string_id} is already registered to {conflict.resource_key}.")

    for item in load_resource_metadata():
        resource_type = item["type"]
        resource_string_id = declared_id(item.get("resource_id"), resource_type)
        resource_slug = item["resource_slug"]
        resource = db.scalar(select(Resource).where(Resource.resource_id == resource_string_id))
        key_match = db.scalar(select(Resource).where(Resource.resource_key == resource_slug))
        if resource is not None and key_match is not None and resource.id != key_match.id:
            raise ValueError(f"Resource ID {resource_string_id} and slug {resource_slug} are already registered to different resources.")
        resource = resource or key_match
        if resource is None:
            resource = Resource(resource_key=resource_slug, resource_id=resource_string_id)
            db.add(resource)
        elif resource.resource_id != resource_string_id:
            ensure_id_available(resource, resource_string_id)
            resource.resource_id = resource_string_id
        resource.resource_key = resource_slug
        resource.name = item["name"]
        resource.resource_type = resource_type
        resource.url = item["url"]
        resource.description = item.get("description")
        resource.category = item.get("category")
        resource.icon = item.get("icon")
        resource.is_active = 1 if item.get("is_active", True) else 0
        resource.is_public = 1 if item.get("is_public", False) else 0
        db.flush()


def initialize_management_database() -> None:
    from portal.app.management.database import create_management_schema, session_scope

    create_management_schema()
    with session_scope() as db:
        seed_resources(db)
