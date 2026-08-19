from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from portal.app.management.models import (
    CodeDictionary,
    CodeDictionaryItem,
    Resource,
    ResourcePermission,
    TeamFeaturedResource,
    UserFeaturedResource,
)
from portal.app.management.resource_ids import normalize_resource_id, resource_id_validation_error
from portal.app.resources.aliases import (
    CRITICAL_TEAM_DASHBOARD_LEGACY_RESOURCE_IDS,
    CRITICAL_TEAM_DASHBOARD_RESOURCE_ID,
    CRITICAL_TEAM_TABLES_LEGACY_RESOURCE_IDS,
    CRITICAL_TEAM_TABLES_RESOURCE_ID,
)
from portal.app.resources.metadata import load_resource_metadata


def _merge_featured_resource_rows(
    db: Session,
    model: type[TeamFeaturedResource] | type[UserFeaturedResource],
    owner_field: str,
    canonical_resource: Resource,
    legacy_resources: list[Resource],
) -> None:
    resource_record_ids = [canonical_resource.id, *(resource.id for resource in legacy_resources)]
    rows = db.scalars(
        select(model).where(model.resource_record_id.in_(resource_record_ids))
    ).all()
    groups: dict[tuple[int, str], list[TeamFeaturedResource | UserFeaturedResource]] = {}
    for row in rows:
        groups.setdefault((int(getattr(row, owner_field)), str(row.category)), []).append(row)

    for group_rows in groups.values():
        group_rows.sort(key=lambda row: (int(row.sort_order), int(row.id)))
        canonical_row = next(
            (
                row
                for row in group_rows
                if row.resource_record_id == canonical_resource.id
            ),
            None,
        )
        retained = canonical_row or group_rows[0]
        retained.sort_order = min(int(row.sort_order) for row in group_rows)
        for row in group_rows:
            if row is not retained:
                db.delete(row)
        db.flush()
        retained.resource_record_id = canonical_resource.id


def _consolidate_resource_group(
    db: Session,
    canonical_resource_id: str,
    legacy_resource_ids: tuple[str, ...],
) -> None:
    canonical_resource = db.scalar(
        select(Resource).where(
            Resource.resource_id == canonical_resource_id
        )
    )
    if canonical_resource is None:
        return

    legacy_resources = db.scalars(
        select(Resource).where(
            Resource.resource_id.in_(legacy_resource_ids)
        )
    ).all()
    if not legacy_resources:
        return

    merged_resource_ids = {
        canonical_resource_id,
        *(resource.resource_id for resource in legacy_resources),
    }
    permissions = db.scalars(
        select(ResourcePermission).where(
            ResourcePermission.resource_id.in_(merged_resource_ids)
        )
    ).all()
    permission_groups: dict[
        tuple[int | None, int | None], list[ResourcePermission]
    ] = {}
    for permission in permissions:
        permission_groups.setdefault(
            (permission.user_id, permission.team_id), []
        ).append(permission)

    for group_permissions in permission_groups.values():
        group_permissions.sort(key=lambda permission: int(permission.id))
        canonical_permission = next(
            (
                permission
                for permission in group_permissions
                if permission.resource_id == canonical_resource_id
            ),
            None,
        )
        retained = canonical_permission or group_permissions[0]
        permission_mask = 0
        for permission in group_permissions:
            permission_mask |= int(permission.permission_level)
            if permission is not retained:
                db.delete(permission)
        db.flush()
        retained.resource_id = canonical_resource_id
        retained.permission_level = permission_mask

    _merge_featured_resource_rows(
        db,
        TeamFeaturedResource,
        "team_id",
        canonical_resource,
        legacy_resources,
    )
    _merge_featured_resource_rows(
        db,
        UserFeaturedResource,
        "user_id",
        canonical_resource,
        legacy_resources,
    )

    for resource in legacy_resources:
        db.delete(resource)
    db.flush()


def consolidate_critical_team_dashboard_resources(db: Session) -> None:
    _consolidate_resource_group(
        db,
        CRITICAL_TEAM_DASHBOARD_RESOURCE_ID,
        CRITICAL_TEAM_DASHBOARD_LEGACY_RESOURCE_IDS,
    )


def consolidate_critical_team_table_resources(db: Session) -> None:
    _consolidate_resource_group(
        db,
        CRITICAL_TEAM_TABLES_RESOURCE_ID,
        CRITICAL_TEAM_TABLES_LEGACY_RESOURCE_IDS,
    )


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
        is_new_resource = resource is None
        if resource is None:
            resource = Resource(
                resource_key=resource_slug,
                resource_id=resource_string_id,
                is_active=1 if item.get("is_active", True) else 0,
                is_public=1 if item.get("is_public", False) else 0,
                is_released=0,
            )
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
        # is_active and is_public become administrator-owned after the first
        # registration. Startup metadata reconciliation may refresh resource
        # identity and display fields, but must not undo saved Manager choices.
        if is_new_resource:
            resource.is_active = 1 if item.get("is_active", True) else 0
            resource.is_public = 1 if item.get("is_public", False) else 0
        db.flush()


WEEKLY_TIME_TYPE_DICTIONARY_KEY = "weekly_time_type"
DEFAULT_WEEKLY_TIME_ENTRY_TYPES = (
    ("field_work", "Field work", 1),
    ("office_work", "Office work", 2),
    ("leave", "Leave", 3),
    ("meeting", "Meeting", 4),
    ("training", "Training", 5),
    ("conference", "Conference attendance", 6),
    ("emergency_response", "Emergency response", 7),
    ("special_assignment", "Special assignment", 8),
    ("other", "Other", 9),
)

DEFAULT_INSPECTION_DIRECTION_DICTIONARY = (
    "inspection_direction",
    "Inspection Direction",
    "Controlled inspection direction labels and persisted numeric codes.",
    (
        ("1", "Upstream to downstream", 1),
        ("0", "Downstream to upstream", 2),
    ),
)

DEFAULT_FLOODING_DICTIONARIES = (
    (
        "flooding_design_standards",
        "Flooding Design Standards",
        "Controlled flooding design standard values used by AIF records.",
        (
            ("meets_cds", "Meets CDS", 1),
            ("fails_cds_meets_retrofit", "Fails CDS, meets Retrofit", 2),
            ("fails_retrofit", "Fails Retrofit", 3),
            ("culvert_failing_retrofit", "Culvert Failing Retrofit", 4),
        ),
    ),
    (
        "flooding_impact",
        "Flooding Impact",
        "Controlled flooding impact values used by AIF records.",
        (
            ("meets_cds_na", "Meets CDS - N/A", 1),
            ("emergency_route", "Emergency Route", 2),
            ("critical_facility", "Critical Facility", 3),
            ("thoroughfare", "Thoroughfare", 4),
            ("collector", "Collector", 5),
            ("local_limited", "Local Limited", 6),
            ("ffe_principal_structure", "FFE Principal Structure", 7),
            ("local", "Local", 8),
            ("sidewalk", "Sidewalk", 9),
            ("driveway_private_drive", "Driveway/Private Drive", 10),
            ("attached_garage", "Attached Garage", 11),
            ("crawl_space", "Crawl space", 12),
            ("detached_garage_shed_gt_150_sq_ft", "Detached Garage/Shed > 150 sq ft", 13),
            ("hvac", "HVAC", 14),
        ),
    ),
    (
        "flooding_service_eligibility",
        "Flooding Service Eligibility",
        "Controlled flooding service eligibility values used by AIF records.",
        (
            ("meets_cds_na", "Meets CDS - N/A", 1),
            ("city_row", "City ROW", 2),
            ("private_property_with_sde", "Private property with SDE", 3),
            (
                "private_property_system_benefit_no_sde",
                "Private property with system benefit but no SDE",
                4,
            ),
            (
                "private_property_no_sde_no_system_benefit",
                "Private property with no SDE and no system benefit",
                5,
            ),
        ),
    ),
)

DEFAULT_CONSEQUENCE_AND_ELIGIBILITY_DICTIONARIES = (
    (
        "consequence_location",
        "Consequence Location",
        "Controlled consequence location values used by AIF records.",
        (
            ("thoroughfare", "Thoroughfare", 1),
            ("collector", "Collector", 2),
            ("local_limited", "Local Limited", 3),
            ("principal_structure", "Principal Structure", 4),
            ("local", "Local", 5),
            ("sidewalk", "Sidewalk", 6),
            ("driveway", "Driveway", 7),
            ("accessory_structure", "Accessory Structure", 8),
            ("right_of_way", "Right-of-Way", 9),
            ("non_city", "Non-City", 10),
        ),
    ),
    (
        "service_eligibility",
        "Service Eligibility",
        "Controlled service eligibility values used by AIF records.",
        (
            ("city_row", "City RoW", 1),
            ("private_property_with_sde", "Private Property with SDE", 2),
            (
                "private_property_system_benefit_no_sde",
                "Private Property with system benefit but no SDE",
                3,
            ),
            (
                "private_property_no_sde_no_system_benefit",
                "Private Property with no SDE and no system benefit",
                4,
            ),
        ),
    ),
    (
        "consequence_location_zoi",
        "Consequence Location ZoI",
        "Controlled zone-of-influence values used by AIF records.",
        (
            (
                "problem_directly_under_consequence_location",
                "Problem directly under Consequence Location",
                1,
            ),
            (
                "problem_within_zoi_of_consequence_location",
                "Problem within ZoI of Consequence Location",
                2,
            ),
        ),
    ),
)


def _seed_system_dictionary(
    db: Session,
    dictionary_key: str,
    name: str,
    description: str,
    items: tuple[tuple[str, str, int], ...],
) -> None:
    dictionary = db.scalar(
        select(CodeDictionary).where(
            CodeDictionary.dictionary_key == dictionary_key
        )
    )
    if dictionary is None:
        dictionary = CodeDictionary(
            dictionary_key=dictionary_key,
            name=name,
            description=description,
            is_active=1,
        )
        db.add(dictionary)
        db.flush()

    for item_code, label, sort_order in items:
        item = db.scalar(
            select(CodeDictionaryItem).where(
                CodeDictionaryItem.dictionary_id == dictionary.id,
                CodeDictionaryItem.item_code == item_code,
            )
        )
        if item is None:
            db.add(
                CodeDictionaryItem(
                    dictionary_id=dictionary.id,
                    item_code=item_code,
                    label=label,
                    sort_order=sort_order,
                    is_active=1,
                )
            )


def seed_system_dictionaries(db: Session) -> None:
    _seed_system_dictionary(
        db,
        WEEKLY_TIME_TYPE_DICTIONARY_KEY,
        "Weekly Time Entry Types",
        "Activity choices used by weekly time reporting.",
        DEFAULT_WEEKLY_TIME_ENTRY_TYPES,
    )
    _seed_system_dictionary(db, *DEFAULT_INSPECTION_DIRECTION_DICTIONARY)
    for dictionary_key, name, description, items in DEFAULT_FLOODING_DICTIONARIES:
        _seed_system_dictionary(db, dictionary_key, name, description, items)
    for dictionary_key, name, description, items in DEFAULT_CONSEQUENCE_AND_ELIGIBILITY_DICTIONARIES:
        _seed_system_dictionary(db, dictionary_key, name, description, items)
    db.flush()


def initialize_management_database() -> None:
    from portal.app.management.database import create_management_schema, session_scope

    create_management_schema()
    with session_scope() as db:
        seed_resources(db)
        consolidate_critical_team_dashboard_resources(db)
        consolidate_critical_team_table_resources(db)
        seed_system_dictionaries(db)
