from __future__ import annotations

import json
import os
import re

from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from portal.runtime.transport import APIRouter, Depends, Header, HTTPException, Query, Request

from portal.app.management.database import get_db
from portal.app.management.models import (
    AuditLog,
    CodeDictionary,
    CodeDictionaryItem,
    Resource,
    ResourcePermission,
    Team,
    TeamFeaturedResource,
    User,
)
from portal.app.management.resource_ids import normalize_resource_id, resource_id_validation_error
from portal.app.management.schemas import (
    AdminStatusRequest,
    BulkPermissionsRequest,
    ChangePasswordRequest,
    DictionaryCreateRequest,
    DictionaryItemCreateRequest,
    DictionaryItemOrderRequest,
    DictionaryItemUpdateRequest,
    DictionaryUpdateRequest,
    FeaturedResourcesRequest,
    LoginRequest,
    PermissionAssignment,
    ResourceCreateRequest,
    ResourceDiscoveryApplyRequest,
    ResourcePermissionsRequest,
    ResourceUpdateRequest,
    SwitchRoleRequest,
    TeamCreateRequest,
    TeamUpdateRequest,
    UserCreateRequest,
    UserUpdateRequest,
)
from portal.app.management.security import create_access_token, decode_access_token, hash_password, utc_now_text, verify_password
from portal.app.management.services import (
    accessible_resources,
    available_roles,
    bool_int,
    creates_team_cycle,
    discover_resource_candidates,
    display_name,
    effective_resource_permission,
    find_login_user,
    get_resource_by_public_id_or_404,
    get_resource_or_404,
    get_team_or_404,
    get_user_or_404,
    mark_login_failure,
    mark_login_success,
    require_management_admin,
    require_system_admin,
    serialize_permission,
    serialize_resource,
    serialize_team,
    serialize_user,
    set_selected_user_role,
    team_ancestor_ids,
    is_management_admin_session,
    is_system_admin_session,
    username_from_name,
    combine_permission_masks,
    is_valid_permission_mask,
    permission_label,
    permission_result,
    permission_types,
    PERMISSION_TYPES,
    write_audit_log,
)
from portal.app.sync.errors import SyncError
from portal.app.sync.models import Identity
from portal.app.sync.runtime import current_coordinator

router = APIRouter(tags=["portal-management"])

FEATURED_CATEGORIES = ("all", "dashboard", "map", "tab", "doc", "report", "dataset")
FEATURED_LIMIT_PER_CATEGORY = 4
SYSTEM_DATABASE_WRITER_EMAIL = "shawn.zhao@charlottenc.gov"
LEGACY_FEATURED_CATEGORY_MAP = {
    "dashboards": "dashboard",
    "maps": "map",
    "tables": "tab",
    "documents": "doc",
    "datasets": "dataset",
    "api": "all",
    "service": "all",
}


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(error.orig)) from error


def _require_system_database_writer(current_user: User) -> None:
    """Keep catalog-only edits behind the manager role boundary.

    Portal Manager is the approved native administration surface. The legacy
    desktop writer allowlist remains in place for browser/development flows,
    while manager requests are authorized by the selected Portal role.
    """
    if os.getenv("PORTAL_MANAGER_MODE", "").strip().lower() in {"1", "true", "yes"}:
        require_management_admin(current_user)
        return
    if current_user.email.strip().casefold() != SYSTEM_DATABASE_WRITER_EMAIL:
        raise HTTPException(
            status_code=403,
            detail="Only shawn.zhao@charlottenc.gov can update the Portal system database.",
        )
    if os.getenv("PORTAL_DESKTOP_MODE", "").strip().lower() in {"1", "true", "yes"}:
        if os.getenv("PORTAL_SYSTEM_DB_WRITE_ENABLED", "").strip() != "1":
            raise HTTPException(
                status_code=403,
                detail="The Portal system database is read-only for this Windows account.",
            )


def _normalize_dictionary_code(value: str, label: str) -> str:
    source = value.strip() or label.strip()
    normalized = re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", source.lower())).strip("_")
    if not normalized:
        raise HTTPException(status_code=422, detail="Code must contain a letter or number.")
    if len(normalized) > 64:
        raise HTTPException(status_code=422, detail="Code cannot exceed 64 characters.")
    return normalized


def _dictionary_or_404(db: Session, dictionary_key: str) -> CodeDictionary:
    dictionary = db.scalar(
        select(CodeDictionary).where(CodeDictionary.dictionary_key == dictionary_key.strip().lower())
    )
    if dictionary is None:
        raise HTTPException(status_code=404, detail="Dictionary was not found.")
    return dictionary


def _dictionary_items(db: Session, dictionary_id: int) -> list[CodeDictionaryItem]:
    return list(
        db.scalars(
            select(CodeDictionaryItem)
            .where(CodeDictionaryItem.dictionary_id == dictionary_id)
            .order_by(CodeDictionaryItem.sort_order, CodeDictionaryItem.label, CodeDictionaryItem.id)
        ).all()
    )


def _serialize_dictionary_item(item: CodeDictionaryItem) -> dict[str, object]:
    metadata: dict[str, object] | None = None
    if item.metadata_json:
        try:
            parsed = json.loads(item.metadata_json)
            metadata = parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            metadata = None
    return {
        "id": item.id,
        "dictionary_id": item.dictionary_id,
        "item_code": item.item_code,
        "label": item.label,
        "sort_order": item.sort_order,
        "is_active": bool(item.is_active),
        "metadata": metadata,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def _serialize_dictionary(db: Session, dictionary: CodeDictionary) -> dict[str, object]:
    items = _dictionary_items(db, dictionary.id)
    return {
        "id": dictionary.id,
        "dictionary_key": dictionary.dictionary_key,
        "name": dictionary.name,
        "description": dictionary.description,
        "is_active": bool(dictionary.is_active),
        "item_count": len(items),
        "active_item_count": sum(1 for item in items if item.is_active),
        "created_at": dictionary.created_at,
        "updated_at": dictionary.updated_at,
    }


def _resource_string_id_or_400(
    db: Session,
    resource_string_id: str | None,
    resource_type: str,
    exclude_resource_id: int | None = None,
) -> str:
    resource_string_id = normalize_resource_id(resource_string_id)
    error = resource_id_validation_error(resource_string_id, resource_type)
    if error:
        raise HTTPException(status_code=400, detail=error)

    stmt = select(Resource).where(Resource.resource_id == resource_string_id)
    if exclude_resource_id is not None:
        stmt = stmt.where(Resource.id != exclude_resource_id)
    conflict = db.scalar(stmt)
    if conflict is not None:
        raise HTTPException(status_code=400, detail=f"Resource ID {resource_string_id} is already registered to {conflict.resource_key}.")
    return resource_string_id


def _request_data(payload) -> dict:
    if hasattr(payload, "model_dump"):
        return payload.model_dump(exclude_unset=True)
    return payload.dict(exclude_unset=True)


def _request_all_data(payload) -> dict:
    if hasattr(payload, "model_dump"):
        return payload.model_dump()
    return payload.dict()


def _featured_request_by_category(payload: FeaturedResourcesRequest) -> dict[str, list[int]]:
    if payload.featured is not None:
        raw = payload.featured
    elif payload.resource_ids is not None:
        raw = {"all": payload.resource_ids}
    else:
        raw = {}

    selections: dict[str, list[int]] = {}
    for category, resource_ids in raw.items():
        category = LEGACY_FEATURED_CATEGORY_MAP.get(category, category)
        if category not in FEATURED_CATEGORIES:
            raise HTTPException(status_code=400, detail=f"Invalid featured category: {category}.")
        if len(resource_ids) > FEATURED_LIMIT_PER_CATEGORY:
            raise HTTPException(status_code=400, detail=f"{category} can include at most 4 featured resources.")
        if len(set(resource_ids)) != len(resource_ids):
            raise HTTPException(status_code=400, detail=f"{category} includes duplicate resources.")
        selections[category] = resource_ids
    return selections


def _serialize_featured_rows(rows: list[TeamFeaturedResource], db: Session, current_user: User | None = None) -> tuple[dict[str, list[dict]], set[str]]:
    featured: dict[str, list[dict]] = {category: [] for category in FEATURED_CATEGORIES}
    configured_categories: set[str] = set()

    for row in rows:
        category = LEGACY_FEATURED_CATEGORY_MAP.get(row.category, row.category)
        category = category if category in FEATURED_CATEGORIES else "all"
        if not row.resource or row.resource.resource_type in {"admin", "api", "service"} or len(featured[category]) >= FEATURED_LIMIT_PER_CATEGORY:
            continue
        effective = effective_resource_permission(db, current_user, row.resource) if current_user else None
        if current_user and not effective:
            continue
        if not current_user and row.resource.is_active != 1:
            continue
        item = serialize_resource(row.resource, effective)
        item["sort_order"] = row.sort_order
        item["featured_category"] = category
        featured[category].append(item)
        configured_categories.add(category)

    return featured, configured_categories


def _serialize_featured_resources(current_user: User, db: Session) -> dict:
    default_featured: dict[str, list[dict]] = {category: [] for category in FEATURED_CATEGORIES}
    default_configured_categories: set[str] = set()
    if current_user.team_id is not None:
        default_rows = db.scalars(
            select(TeamFeaturedResource)
            .where(TeamFeaturedResource.team_id == current_user.team_id)
            .order_by(TeamFeaturedResource.category, TeamFeaturedResource.sort_order, TeamFeaturedResource.id)
        ).all()
        default_featured, default_configured_categories = _serialize_featured_rows(default_rows, db, current_user)

    return {
        # Preserve the response shape for older clients while making the
        # selected user's team configuration authoritative.
        "resources": default_featured["all"],
        "featured": default_featured,
        "configured_categories": sorted(default_configured_categories),
        "default_resources": default_featured["all"],
        "default_featured": default_featured,
        "default_configured_categories": sorted(default_configured_categories),
    }


def _serialize_team_featured_resources(team: Team, db: Session) -> dict:
    rows = db.scalars(
        select(TeamFeaturedResource)
        .where(TeamFeaturedResource.team_id == team.id)
        .order_by(TeamFeaturedResource.category, TeamFeaturedResource.sort_order, TeamFeaturedResource.id)
    ).all()
    featured, configured_categories = _serialize_featured_rows(rows, db)
    return {
        "team": serialize_team(db, team),
        "resources": featured["all"],
        "featured": featured,
        "configured_categories": sorted(configured_categories),
    }


def _extract_bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization token.")
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="Invalid authorization token.")
    return authorization[len(prefix):].strip()


def _normalize_windows_identity(value: str | None) -> str:
    return str(value or "").strip().casefold()


def _desktop_identity_values() -> list[str]:
    """Return all Windows identity values that may identify the signed-in user.

    Domain-qualified account names are reduced to their account component as
    well, so both ``CHARLOTTE\\105692`` and ``105692`` can match a Portal
    username or employee ID.
    """
    raw_values = [
        os.getenv("PORTAL_WINDOWS_EMAIL"),
        os.getenv("PORTAL_WINDOWS_EMPLOYEE_ID"),
        os.getenv("PORTAL_WINDOWS_USERNAME"),
        os.getenv("PORTAL_WINDOWS_ACCOUNT"),
        os.getenv("USERPRINCIPALNAME"),
        os.getenv("USERNAME"),
        os.getenv("USER"),
    ]
    domain = _normalize_windows_identity(os.getenv("USERDOMAIN"))
    username = _normalize_windows_identity(os.getenv("USERNAME"))
    if domain and username:
        raw_values.append(f"{domain}\\{username}")

    values: list[str] = []
    for raw_value in raw_values:
        value = _normalize_windows_identity(raw_value)
        if not value:
            continue
        candidates = [value]
        if "\\" in value:
            candidates.append(value.rsplit("\\", 1)[-1])
        if "/" in value:
            candidates.append(value.rsplit("/", 1)[-1])
        for candidate in candidates:
            if candidate and candidate not in values:
                values.append(candidate)
    return values


def _desktop_identity_label() -> str:
    return ", ".join(_desktop_identity_values()) or "unresolved Windows account"


def _desktop_current_user(db: Session) -> User | None:
    if os.getenv("PORTAL_DESKTOP_MODE", "").strip().lower() not in {"1", "true", "yes"}:
        return None

    identity_values = _desktop_identity_values()
    if not identity_values:
        return None

    return db.scalar(
        select(User).where(
            User.deleted_at.is_(None),
            User.is_active == 1,
            or_(
                func.lower(User.email).in_(identity_values),
                func.lower(User.employee_id).in_(identity_values),
                func.lower(User.username).in_(identity_values),
            ),
        )
    )


def _desktop_runtime() -> bool:
    return os.getenv("PORTAL_DESKTOP_MODE", "").strip().lower() in {"1", "true", "yes"}


def _manager_runtime() -> bool:
    return os.getenv("PORTAL_MANAGER_MODE", "").strip().lower() in {"1", "true", "yes"}


def _initialize_desktop_business_sync(user: User) -> None:
    """Install or refresh the mutable-data replica during desktop startup."""
    try:
        coordinator = current_coordinator(
            Identity(
                user_id=str(user.id),
                employee_number=str(user.employee_id),
                email=str(user.email),
            ),
            initialize=False,
        )
        # Always synchronize when Portal starts. A missing local database is
        # installed from the current verified snapshot by initialize().
        coordinator.initialize()
    except SyncError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def _apply_test_access(
    user: User,
    db: Session,
    enabled: str | None,
    user_id: int | None,
    role: str | None,
) -> User:
    if str(enabled or "").strip().lower() not in {"1", "true", "yes"}:
        return user
    if not is_management_admin_session(user):
        raise HTTPException(status_code=403, detail="An Admin or System Admin role is required to view another user's access.")
    if user_id is None:
        raise HTTPException(status_code=400, detail="A user is required for access preview.")

    preview_user = db.get(User, user_id)
    if preview_user is None or preview_user.deleted_at is not None or preview_user.is_active != 1:
        raise HTTPException(status_code=400, detail="The selected preview user is not active.")
    if role not in available_roles(preview_user):
        raise HTTPException(status_code=400, detail="The selected role is not available for this user.")

    set_selected_user_role(preview_user, role)
    setattr(
        preview_user,
        "_portal_test_access",
        {
            "actor_user_id": user.id,
            "actor_name": display_name(user),
            "read_only": True,
        },
    )
    return preview_user


def get_current_user(
    request: Request,
    authorization: str | None = Header(default=None),
    test_access: str | None = Header(default=None, alias="X-Portal-Test-Access"),
    test_user_id: int | None = Header(default=None, alias="X-Portal-Test-User-Id"),
    test_role: str | None = Header(default=None, alias="X-Portal-Test-Role"),
    db: Session = Depends(get_db),
) -> User:
    if _desktop_runtime() and not _manager_runtime() and request.path.startswith("/api/admin"):
        raise HTTPException(status_code=403, detail="Portal Administration is available only in Portal Manager.")

    payload = None
    if authorization:
        token = _extract_bearer_token(authorization)
        payload = decode_access_token(token)

    if payload is None:
        desktop_user = _desktop_current_user(db)
        if desktop_user is not None:
            # Desktop authentication is based on the signed-in Windows account.
            # Do not silently downgrade an Admin or System Admin account before
            # evaluating access-preview authorization. selected_user_role()
            # already resolves the user's highest available role when no role
            # has been explicitly selected for this request.
            current_user = _apply_test_access(desktop_user, db, test_access, test_user_id, test_role)
            if getattr(current_user, "_portal_test_access", None) and request.method.upper() not in {"GET", "HEAD", "OPTIONS"}:
                raise HTTPException(status_code=403, detail="Access preview is read-only. Stop viewing as this user before making changes.")
            return current_user
        if authorization:
            raise HTTPException(status_code=401, detail="Invalid or expired authorization token.")
        raise HTTPException(status_code=401, detail="Missing authorization token.")

    user = db.get(User, int(payload.get("sub", 0)))
    if user is None or user.deleted_at is not None or user.is_active != 1:
        raise HTTPException(status_code=401, detail="User is not active.")
    selected_role = str(payload.get("role") or "")
    if selected_role:
        set_selected_user_role(user, selected_role)
    current_user = _apply_test_access(user, db, test_access, test_user_id, test_role)
    if getattr(current_user, "_portal_test_access", None) and request.method.upper() not in {"GET", "HEAD", "OPTIONS"}:
        raise HTTPException(status_code=403, detail="Access preview is read-only. Stop viewing as this user before making changes.")
    return current_user


def get_current_admin_user(current_user: User = Depends(get_current_user)) -> User:
    require_management_admin(current_user)
    return current_user


@router.post("/api/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> dict:
    user = find_login_user(db, payload.login)
    if user is None or user.is_active != 1 or user.deleted_at is not None:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    if not verify_password(payload.password, user.password_hash):
        mark_login_failure(user)
        _commit(db)
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    roles = available_roles(user)
    requested_role = payload.role.strip() if payload.role else ""
    if requested_role and requested_role not in roles:
        raise HTTPException(status_code=403, detail="Selected role is not available for this user.")

    if not requested_role and len(roles) > 1:
        return {
            "requires_role_selection": True,
            "roles": roles,
            "user": serialize_user(db, user),
        }

    selected_role = requested_role or roles[0]
    set_selected_user_role(user, selected_role)
    mark_login_success(user)
    write_audit_log(db, user, "login", "user", user.id, {"role": selected_role})
    serialized_user = serialize_user(db, user)
    _commit(db)
    return {
        "token": create_access_token(user.id, selected_role),
        "token_type": "bearer",
        "user": serialized_user,
    }


@router.post("/api/auth/desktop-login")
def desktop_login(db: Session = Depends(get_db)) -> dict:
    if os.getenv("PORTAL_DESKTOP_MODE", "").strip().lower() not in {"1", "true", "yes"}:
        raise HTTPException(status_code=404, detail="Desktop sign-in is not available in this runtime.")

    identity_values = _desktop_identity_values()
    if not identity_values:
        raise HTTPException(status_code=401, detail="The signed-in Windows account identity could not be resolved.")

    user = _desktop_current_user(db)
    if user is None:
        raise HTTPException(
            status_code=401,
            detail=f"The Windows account identity ({_desktop_identity_label()}) is not an active Portal user.",
        )

    selected_role = "user"
    set_selected_user_role(user, selected_role)
    # Portal Manager authenticates against the same Windows identity, but it
    # is an operator/administration host and must not block on the desktop
    # business-data replica or network synchronization during sign-in.
    if os.getenv("PORTAL_MANAGER_MODE", "").strip().lower() not in {"1", "true", "yes"}:
        _initialize_desktop_business_sync(user)
    return {
        "token": create_access_token(user.id, selected_role),
        "token_type": "bearer",
        "user": serialize_user(db, user),
    }


@router.post("/api/auth/switch-role")
def switch_role(
    payload: SwitchRoleRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    role = payload.role.strip()
    if not role:
        raise HTTPException(status_code=400, detail="Role is required.")
    if _desktop_runtime() and not _manager_runtime() and role != "user":
        raise HTTPException(status_code=403, detail="Elevated Portal roles are available only in Portal Manager.")

    user = db.merge(current_user)
    set_selected_user_role(user, role)
    serialized_user = serialize_user(db, user)
    if os.getenv("PORTAL_DESKTOP_MODE", "").strip().lower() not in {"1", "true", "yes"}:
        write_audit_log(db, user, "switch_role", "user", user.id, {"role": role})
        _commit(db)
    return {
        "token": create_access_token(user.id, role),
        "token_type": "bearer",
        "user": serialized_user,
    }


@router.post("/api/auth/change-password")
def change_password(
    payload: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    user = db.merge(current_user)
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is not correct.")
    if payload.new_password == user.employee_id:
        raise HTTPException(status_code=400, detail="New password cannot be the employee ID.")
    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = 0
    user.password_changed_at = utc_now_text()
    write_audit_log(db, user, "change_password", "user", user.id)
    _commit(db)
    return {"ok": True, "user": serialize_user(db, user)}


@router.get("/api/me")
def my_profile(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    return {"user": serialize_user(db, current_user)}


@router.get("/api/me/resources")
def my_resources(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    return {"resources": accessible_resources(db, current_user)}


@router.get("/api/me/featured-resources")
def my_featured_resources(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    return _serialize_featured_resources(current_user, db)


@router.put("/api/me/featured-resources")
def update_my_featured_resources(
    _payload: FeaturedResourcesRequest,
    _current_user: User = Depends(get_current_user),
) -> dict:
    raise HTTPException(
        status_code=405,
        detail="Personal featured-item configuration is no longer supported. Featured items are managed by team.",
    )


@router.get("/api/admin/summary")
def admin_summary(
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    return {
        "users": db.scalar(select(func.count()).select_from(User).where(User.deleted_at.is_(None))) or 0,
        "teams": db.scalar(select(func.count()).select_from(Team)) or 0,
        "resources": db.scalar(select(func.count()).select_from(Resource)) or 0,
        "permissions": db.scalar(select(func.count()).select_from(ResourcePermission)) or 0,
    }


@router.get("/api/admin/users")
def list_users(
    search: str = Query(default=""),
    include_deleted: bool = Query(default=False),
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(User)
    if not include_deleted:
        stmt = stmt.where(User.deleted_at.is_(None))
    if search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(
            (User.first_name.ilike(term))
            | (User.last_name.ilike(term))
            | (User.email.ilike(term))
            | (User.employee_id.ilike(term))
            | (User.username.ilike(term))
        )
    users = db.scalars(stmt.order_by(User.last_name, User.first_name)).all()
    return {"users": [serialize_user(db, user) for user in users]}


@router.post("/api/admin/users")
def create_user(
    payload: UserCreateRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    if payload.is_admin:
        require_system_admin(current_user)
    first_name = payload.first_name.strip()
    last_name = payload.last_name.strip()
    try:
        username = username_from_name(first_name, last_name)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    employee_id = payload.employee_id.strip()
    if db.scalar(select(User).where(User.employee_id == employee_id)):
        raise HTTPException(status_code=409, detail="Employee ID already exists.")
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(status_code=409, detail=f"Generated username '{username}' already exists.")
    user = User(
        username=username,
        first_name=first_name,
        last_name=last_name,
        email=str(payload.email),
        employee_id=employee_id,
        team_id=payload.team_id,
        password_hash=hash_password(payload.employee_id.strip()),
        is_active=bool_int(payload.is_active),
        is_admin=bool_int(payload.is_admin),
        is_system_admin=0,
        must_change_password=0,
    )
    if user.team_id is not None:
        get_team_or_404(db, user.team_id)
    db.add(user)
    _commit(db)
    write_audit_log(db, current_user, "create_user", "user", user.id, {"employee_id": user.employee_id})
    _commit(db)
    return {"user": serialize_user(db, user)}


@router.patch("/api/admin/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserUpdateRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    target = get_user_or_404(db, user_id)
    updates = _request_data(payload)
    first_name = str(updates.get("first_name", target.first_name) or "").strip()
    last_name = str(updates.get("last_name", target.last_name) or "").strip()
    try:
        username = username_from_name(first_name, last_name)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if db.scalar(select(User).where(User.username == username, User.id != target.id)):
        raise HTTPException(status_code=409, detail=f"Generated username '{username}' already exists.")
    updates["username"] = username
    if "first_name" in updates:
        updates["first_name"] = first_name
    if "last_name" in updates:
        updates["last_name"] = last_name
    if target.is_system_admin and not is_system_admin_session(current_user):
        raise HTTPException(status_code=403, detail="Portal admins cannot modify system admin accounts.")
    if "is_active" in updates and not updates["is_active"] and target.is_system_admin:
        raise HTTPException(status_code=400, detail="System admins cannot be deactivated.")
    if "team_id" in updates and updates["team_id"] is not None:
        get_team_or_404(db, int(updates["team_id"]))
    if "employee_id" in updates and updates["employee_id"] is not None:
        employee_id = str(updates["employee_id"]).strip()
        if db.scalar(select(User).where(User.employee_id == employee_id, User.id != target.id)):
            raise HTTPException(status_code=409, detail="Employee ID already exists.")
        updates["employee_id"] = employee_id

    for field, value in updates.items():
        if field == "email" and value is not None:
            value = str(value)
        if field == "is_active" and value is not None:
            value = bool_int(value)
        setattr(target, field, value)
    write_audit_log(db, current_user, "update_user", "user", target.id, updates)
    _commit(db)
    return {"user": serialize_user(db, target)}


@router.delete("/api/admin/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    require_system_admin(current_user)
    target = get_user_or_404(db, user_id)
    if target.id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    if target.is_system_admin:
        raise HTTPException(status_code=400, detail="System admins cannot be deleted.")
    target.deleted_at = utc_now_text()
    target.deleted_by_user_id = current_user.id
    target.is_active = 0
    write_audit_log(db, current_user, "delete_user", "user", target.id)
    _commit(db)
    return {"ok": True, "user": serialize_user(db, target)}


@router.patch("/api/admin/users/{user_id}/admin-status")
def update_admin_status(
    user_id: int,
    payload: AdminStatusRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_system_admin(current_user)
    target = get_user_or_404(db, user_id)
    if target.is_system_admin:
        raise HTTPException(status_code=400, detail="System admin status is protected.")
    target.is_admin = bool_int(payload.is_admin)
    write_audit_log(db, current_user, "update_admin_status", "user", target.id, {"is_admin": payload.is_admin})
    _commit(db)
    return {"user": serialize_user(db, target)}


@router.post("/api/admin/users/{user_id}/reset-password")
def reset_user_password(
    user_id: int,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    target = get_user_or_404(db, user_id)
    if target.is_system_admin and not is_system_admin_session(current_user):
        raise HTTPException(status_code=403, detail="Portal admins cannot reset system admin passwords.")
    if target.is_admin and not is_system_admin_session(current_user) and target.id != current_user.id:
        raise HTTPException(status_code=403, detail="Only system admins can reset portal admin passwords.")
    target.password_hash = hash_password(target.employee_id)
    target.must_change_password = 0
    target.password_changed_at = None
    write_audit_log(db, current_user, "reset_password", "user", target.id)
    _commit(db)
    return {"ok": True, "temporary_password": "employee_id", "user": serialize_user(db, target)}


@router.get("/api/admin/teams")
def list_teams(
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    teams = db.scalars(select(Team).order_by(Team.name)).all()
    return {"teams": [serialize_team(db, team) for team in teams]}


@router.post("/api/admin/teams")
def create_team(
    payload: TeamCreateRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    if payload.parent_team_id is not None:
        get_team_or_404(db, payload.parent_team_id)
    if payload.manager_user_id is not None:
        get_user_or_404(db, payload.manager_user_id)
    team = Team(
        name=payload.name.strip(),
        description=payload.description,
        parent_team_id=payload.parent_team_id,
        manager_user_id=payload.manager_user_id,
        is_active=bool_int(payload.is_active),
    )
    db.add(team)
    _commit(db)
    write_audit_log(db, current_user, "create_team", "team", team.id)
    _commit(db)
    return {"team": serialize_team(db, team)}


@router.patch("/api/admin/teams/{team_id}")
def update_team(
    team_id: int,
    payload: TeamUpdateRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    team = get_team_or_404(db, team_id)
    updates = _request_data(payload)
    if "parent_team_id" in updates:
        parent_team_id = updates["parent_team_id"]
        if parent_team_id is not None:
            get_team_or_404(db, int(parent_team_id))
        if creates_team_cycle(db, team.id, parent_team_id):
            raise HTTPException(status_code=400, detail="A team cannot be moved under one of its descendants.")
    if "manager_user_id" in updates and updates["manager_user_id"] is not None:
        get_user_or_404(db, int(updates["manager_user_id"]))

    for field, value in updates.items():
        if field == "is_active" and value is not None:
            value = bool_int(value)
        setattr(team, field, value)
    write_audit_log(db, current_user, "update_team", "team", team.id, updates)
    _commit(db)
    return {"team": serialize_team(db, team)}


@router.get("/api/admin/teams/{team_id}/featured-resources")
def get_team_featured_resources(
    team_id: int,
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    team = get_team_or_404(db, team_id)
    return _serialize_team_featured_resources(team, db)


@router.put("/api/admin/teams/{team_id}/featured-resources")
def update_team_featured_resources(
    team_id: int,
    payload: FeaturedResourcesRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    team = get_team_or_404(db, team_id)
    selections = _featured_request_by_category(payload)
    resource_ids = sorted({resource_id for category_ids in selections.values() for resource_id in category_ids})
    resources_by_id = {resource_id: get_resource_or_404(db, resource_id) for resource_id in resource_ids}
    for resource in resources_by_id.values():
        if resource.is_active != 1:
            raise HTTPException(status_code=400, detail=f"Resource {resource.id} is inactive.")
        if resource.resource_type in {"admin", "api", "service"}:
            raise HTTPException(status_code=400, detail="Admin, API, and service resources cannot be featured on the portal home page.")

    db.execute(delete(TeamFeaturedResource).where(TeamFeaturedResource.team_id == team.id))
    for category, category_resource_ids in selections.items():
        for index, resource_id in enumerate(category_resource_ids):
            db.add(
                TeamFeaturedResource(
                    team_id=team.id,
                    category=category,
                    resource_record_id=resources_by_id[resource_id].id,
                    sort_order=index,
                )
            )
    write_audit_log(db, current_user, "update_team_featured_resources", "team", team.id, {"featured": selections})
    _commit(db)
    return _serialize_team_featured_resources(team, db)


@router.delete("/api/admin/teams/{team_id}")
def delete_team(
    team_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_system_admin(current_user)
    team = get_team_or_404(db, team_id)
    write_audit_log(db, current_user, "delete_team", "team", team.id, {"name": team.name})
    db.delete(team)
    _commit(db)
    return {"ok": True}


@router.get("/api/admin/resources")
def list_resources(
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    resources = db.scalars(select(Resource).order_by(Resource.resource_type, Resource.name)).all()
    return {"resources": [serialize_resource(resource) for resource in resources]}


@router.get("/api/admin/resources/discovery")
def discover_resources(
    request: Request,
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    return discover_resource_candidates(db, list(request.app.routes), request.app.openapi().get("paths", {}))


@router.post("/api/admin/resources")
def create_resource(
    payload: ResourceCreateRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    resource = Resource(
        resource_id=_resource_string_id_or_400(db, payload.resource_id, payload.resource_type),
        resource_key=payload.resource_key.strip(),
        name=payload.name.strip(),
        resource_type=payload.resource_type,
        url=payload.url.strip(),
        description=payload.description,
        category=payload.category,
        icon=payload.icon,
        is_public=bool_int(payload.is_public),
        is_active=bool_int(payload.is_active),
    )
    db.add(resource)
    _commit(db)
    write_audit_log(db, current_user, "create_resource", "resource", resource.id)
    _commit(db)
    return {"resource": serialize_resource(resource)}


@router.post("/api/admin/resources/discovery/apply")
def apply_resource_discovery(
    payload: ResourceDiscoveryApplyRequest,
    request: Request,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    openapi_paths = request.app.openapi().get("paths", {})
    discovery = discover_resource_candidates(db, list(request.app.routes), openapi_paths)
    candidates = {item["resource_key"]: item for item in discovery["resources"]}
    applied = []
    skipped = []

    for requested_action in payload.actions:
        action = requested_action.action.strip().lower()
        candidate = candidates.get(requested_action.resource_key)
        if action not in {"add", "update", "disable"}:
            skipped.append({"resource_key": requested_action.resource_key, "action": action, "reason": "Invalid action."})
            continue
        if candidate is None:
            skipped.append({"resource_key": requested_action.resource_key, "action": action, "reason": "Resource was not discovered."})
            continue

        existing = db.get(Resource, candidate["existing_resource_id"]) if candidate.get("existing_resource_id") else None
        if action == "add":
            if existing is not None or candidate["status"] in {"conflict", "invalid", "stale", "inactive_stale"}:
                skipped.append({"resource_key": requested_action.resource_key, "action": action, "reason": "Resource cannot be added from this status."})
                continue
            resource_string_id = _resource_string_id_or_400(db, candidate.get("resource_id"), candidate["resource_type"])
            resource = Resource(
                resource_id=resource_string_id,
                resource_key=candidate["resource_key"],
                name=candidate["name"],
                resource_type=candidate["resource_type"],
                url=candidate["url"],
                description=candidate.get("description"),
                category=candidate.get("category"),
                icon=candidate.get("icon"),
                is_public=0,
                is_active=1,
            )
            db.add(resource)
            applied.append({"resource_key": candidate["resource_key"], "action": action})
            continue

        if existing is None:
            skipped.append({"resource_key": requested_action.resource_key, "action": action, "reason": "Existing resource was not found."})
            continue

        if action == "disable":
            existing.is_active = 0
            applied.append({"resource_key": existing.resource_key, "action": action})
            continue

        if candidate["status"] in {"conflict", "invalid", "stale", "inactive_stale"}:
            skipped.append({"resource_key": requested_action.resource_key, "action": action, "reason": "Resource cannot be updated from this status."})
            continue

        candidate["resource_id"] = _resource_string_id_or_400(db, candidate.get("resource_id"), candidate["resource_type"], existing.id)
        for field in ("resource_id", "resource_key", "name", "resource_type", "url", "description", "category", "icon"):
            setattr(existing, field, candidate.get(field))
        existing.is_active = 1
        applied.append({"resource_key": candidate["resource_key"], "action": action})

    write_audit_log(
        db,
        current_user,
        "apply_resource_discovery",
        "resource",
        None,
        {"applied": applied, "skipped": skipped},
    )
    _commit(db)
    return {
        "applied": applied,
        "skipped": skipped,
        "discovery": discover_resource_candidates(db, list(request.app.routes), openapi_paths),
    }


@router.patch("/api/admin/resources/{resource_id}")
def update_resource(
    resource_id: int,
    payload: ResourceUpdateRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    resource = get_resource_or_404(db, resource_id)
    updates = _request_data(payload)
    if "resource_id" in updates or "resource_type" in updates:
        resource_type = updates.get("resource_type", resource.resource_type)
        updates["resource_id"] = _resource_string_id_or_400(db, updates.get("resource_id", resource.resource_id), resource_type, resource.id)
    for field, value in updates.items():
        if field in {"is_public", "is_active"} and value is not None:
            value = bool_int(value)
        setattr(resource, field, value)
    write_audit_log(db, current_user, "update_resource", "resource", resource.id, updates)
    _commit(db)
    return {"resource": serialize_resource(resource)}


@router.delete("/api/admin/resources/{resource_id}")
def delete_resource(
    resource_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_system_admin(current_user)
    resource = get_resource_or_404(db, resource_id)
    write_audit_log(db, current_user, "delete_resource", "resource", resource.id, {"resource_key": resource.resource_key})
    db.delete(resource)
    _commit(db)
    return {"ok": True}


def _permission_subject_or_404(db: Session, subject_type: str, subject_id: int) -> User | Team:
    if subject_type == "user":
        return get_user_or_404(db, subject_id)
    if subject_type == "team":
        return get_team_or_404(db, subject_id)
    raise HTTPException(status_code=400, detail="Permission subject type must be user or team.")


def _subject_permission_filter(subject_type: str, subject_id: int):
    if subject_type == "user":
        return ResourcePermission.user_id == subject_id
    if subject_type == "team":
        return ResourcePermission.team_id == subject_id
    raise HTTPException(status_code=400, detail="Permission subject type must be user or team.")


def _effective_team_permission(db: Session, team: Team, resource: Resource) -> dict | None:
    if resource.is_active != 1:
        return None

    permission_mask = PERMISSION_TYPES["view"] if resource.is_public else 0
    sources = ["public"] if resource.is_public else []
    ancestor_ids = team_ancestor_ids(db, team.id)
    if ancestor_ids:
        direct_level = combine_permission_masks(db.scalars(
            select(ResourcePermission.permission_level).where(
                ResourcePermission.resource_id == resource.resource_id,
                ResourcePermission.team_id == team.id,
            )
        ).all())
        if direct_level:
            permission_mask |= direct_level
            sources.append("team")

        parent_ids = [team_id for team_id in ancestor_ids if team_id != team.id]
        if parent_ids:
            parent_level = combine_permission_masks(db.scalars(
                select(ResourcePermission.permission_level).where(
                    ResourcePermission.resource_id == resource.resource_id,
                    ResourcePermission.team_id.in_(parent_ids),
                )
            ).all())
            if parent_level:
                permission_mask |= parent_level
                sources.append("parent_team")

    return permission_result(permission_mask, sources)


@router.get("/api/admin/permissions/matrix")
def permission_matrix(
    subject_type: str = Query(...),
    subject_id: int = Query(...),
    search: str = Query(default=""),
    resource_type: str = Query(default=""),
    category: str = Query(default=""),
    include_inactive: bool = Query(default=False),
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    subject = _permission_subject_or_404(db, subject_type, subject_id)

    stmt = select(Resource)
    stmt = stmt.where(Resource.is_public == 0)
    if not include_inactive:
        stmt = stmt.where(Resource.is_active == 1)
    if resource_type.strip():
        stmt = stmt.where(Resource.resource_type == resource_type.strip())
    if category.strip():
        stmt = stmt.where(Resource.category == category.strip())
    if search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(
            (Resource.resource_id.ilike(term))
            | (Resource.name.ilike(term))
            | (Resource.url.ilike(term))
            | (Resource.resource_key.ilike(term))
            | (Resource.category.ilike(term))
            | (Resource.description.ilike(term))
        )

    resources = db.scalars(stmt.order_by(Resource.resource_type, Resource.category, Resource.name)).all()
    resource_ids = [resource.resource_id for resource in resources]
    direct_permissions = {}
    if resource_ids:
        direct_permissions = {
            permission.resource_id: permission
            for permission in db.scalars(
                select(ResourcePermission).where(
                    ResourcePermission.resource_id.in_(resource_ids),
                    _subject_permission_filter(subject_type, subject_id),
                )
            ).all()
        }

    rows = []
    for resource in resources:
        direct = direct_permissions.get(resource.resource_id)
        if subject_type == "user":
            effective = effective_resource_permission(db, subject, resource)  # type: ignore[arg-type]
        else:
            effective = _effective_team_permission(db, subject, resource)  # type: ignore[arg-type]
        rows.append(
            {
                "resource": serialize_resource(resource),
                "direct_permission_id": direct.id if direct else None,
                "direct_permission_level": direct.permission_level if direct else None,
                "direct_permission": permission_label(direct.permission_level) if direct else None,
                "direct_permission_types": permission_types(direct.permission_level) if direct else [],
                "effective_permission": effective,
            }
        )

    return {
        "subject_type": subject_type,
        "subject_id": subject_id,
        "rows": rows,
    }


@router.put("/api/admin/permissions/matrix")
def update_permission_matrix(
    payload: BulkPermissionsRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    subject_type = payload.subject_type.strip().lower()
    _permission_subject_or_404(db, subject_type, payload.subject_id)

    resource_ids = [assignment.resource_id for assignment in payload.assignments]
    if len(resource_ids) != len(set(resource_ids)):
        raise HTTPException(status_code=400, detail="Duplicate resource assignments are not allowed.")
    for assignment in payload.assignments:
        if assignment.permission_level is not None and not is_valid_permission_mask(assignment.permission_level):
            raise HTTPException(status_code=400, detail="Invalid permission type selection.")
        get_resource_by_public_id_or_404(db, assignment.resource_id)

    existing_permissions = {}
    if resource_ids:
        existing_permissions = {
            permission.resource_id: permission
            for permission in db.scalars(
                select(ResourcePermission).where(
                    ResourcePermission.resource_id.in_(resource_ids),
                    _subject_permission_filter(subject_type, payload.subject_id),
                )
            ).all()
        }

    if any(assignment.permission_level is None and assignment.resource_id in existing_permissions for assignment in payload.assignments):
        require_system_admin(current_user)

    created = 0
    updated = 0
    deleted_count = 0
    for assignment in payload.assignments:
        existing = existing_permissions.get(assignment.resource_id)
        if assignment.permission_level is None:
            if existing:
                db.delete(existing)
                deleted_count += 1
            continue

        if existing:
            if existing.permission_level != assignment.permission_level:
                existing.permission_level = assignment.permission_level
                updated += 1
            continue

        db.add(
            ResourcePermission(
                resource_id=assignment.resource_id,
                user_id=payload.subject_id if subject_type == "user" else None,
                team_id=payload.subject_id if subject_type == "team" else None,
                permission_level=assignment.permission_level,
                created_by_user_id=current_user.id,
            )
        )
        created += 1

    write_audit_log(
        db,
        current_user,
        "update_permission_matrix",
        "resource_permission",
        None,
        {
            "subject_type": subject_type,
            "subject_id": payload.subject_id,
            "created": created,
            "updated": updated,
            "deleted": deleted_count,
            "assignments": [_request_all_data(assignment) for assignment in payload.assignments],
        },
    )
    _commit(db)
    return {"ok": True, "created": created, "updated": updated, "deleted": deleted_count}


@router.get("/api/admin/resources/{resource_id}/permissions")
def get_resource_permissions(
    resource_id: int,
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    resource = get_resource_or_404(db, resource_id)
    permissions = db.scalars(
        select(ResourcePermission).where(ResourcePermission.resource_id == resource.resource_id).order_by(ResourcePermission.team_id, ResourcePermission.user_id)
    ).all()
    return {"resource": serialize_resource(resource), "permissions": [serialize_permission(db, item) for item in permissions]}


def _validate_permission_assignment(db: Session, assignment: PermissionAssignment) -> None:
    if not is_valid_permission_mask(assignment.permission_level):
        raise HTTPException(status_code=400, detail="Invalid permission type selection.")
    if bool(assignment.user_id) == bool(assignment.team_id):
        raise HTTPException(status_code=400, detail="Each permission must target exactly one user or one team.")
    if assignment.user_id is not None:
        get_user_or_404(db, assignment.user_id)
    if assignment.team_id is not None:
        get_team_or_404(db, assignment.team_id)


def _permission_subject_key(permission: ResourcePermission | PermissionAssignment) -> tuple[str, int]:
    if permission.user_id is not None:
        return ("user", int(permission.user_id))
    if permission.team_id is not None:
        return ("team", int(permission.team_id))
    raise HTTPException(status_code=400, detail="Permission assignment is missing a subject.")


@router.put("/api/admin/resources/{resource_id}/permissions")
def replace_resource_permissions(
    resource_id: int,
    payload: ResourcePermissionsRequest,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    resource = get_resource_or_404(db, resource_id)
    seen: set[tuple[str, int]] = set()
    for assignment in payload.permissions:
        _validate_permission_assignment(db, assignment)
        key = ("user", assignment.user_id) if assignment.user_id is not None else ("team", assignment.team_id)
        if key in seen:
            raise HTTPException(status_code=400, detail="Duplicate permission assignment.")
        seen.add(key)  # type: ignore[arg-type]

    existing_permissions = db.scalars(
        select(ResourcePermission).where(ResourcePermission.resource_id == resource.resource_id)
    ).all()
    existing_keys = {_permission_subject_key(permission) for permission in existing_permissions}
    incoming_keys = {_permission_subject_key(assignment) for assignment in payload.permissions}
    removed_keys = existing_keys - incoming_keys
    if removed_keys:
        require_system_admin(current_user)

    db.execute(delete(ResourcePermission).where(ResourcePermission.resource_id == resource.resource_id))
    for assignment in payload.permissions:
        db.add(
            ResourcePermission(
                resource_id=resource.resource_id,
                user_id=assignment.user_id,
                team_id=assignment.team_id,
                permission_level=assignment.permission_level,
                created_by_user_id=current_user.id,
            )
        )
    write_audit_log(
        db,
        current_user,
        "replace_resource_permissions",
        "resource",
        resource.id,
        {"permissions": [_request_all_data(assignment) for assignment in payload.permissions]},
    )
    _commit(db)
    return get_resource_permissions(resource.id, current_user, db)


@router.delete("/api/admin/resources/{resource_id}/permissions/{permission_id}")
def delete_resource_permission(
    resource_id: int,
    permission_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_system_admin(current_user)
    resource = get_resource_or_404(db, resource_id)
    permission = db.get(ResourcePermission, permission_id)
    if permission is None or permission.resource_id != resource.resource_id:
        raise HTTPException(status_code=404, detail="Permission was not found.")
    details = serialize_permission(db, permission)
    write_audit_log(db, current_user, "delete_resource_permission", "resource_permission", permission.id, details)
    db.delete(permission)
    _commit(db)
    return {"ok": True}


@router.get("/api/admin/dictionaries")
def list_dictionaries(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_management_admin(current_user)
    dictionaries = db.scalars(
        select(CodeDictionary).order_by(CodeDictionary.name, CodeDictionary.id)
    ).all()
    return {
        "dictionaries": [_serialize_dictionary(db, dictionary) for dictionary in dictionaries]
    }


@router.post("/api/admin/dictionaries")
def create_dictionary(
    payload: DictionaryCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_management_admin(current_user)
    _require_system_database_writer(current_user)
    name = payload.name.strip()
    dictionary_key = _normalize_dictionary_code(payload.dictionary_key or "", name)
    if db.scalar(
        select(CodeDictionary).where(CodeDictionary.dictionary_key == dictionary_key)
    ):
        raise HTTPException(status_code=409, detail="That dictionary key already exists.")
    dictionary = CodeDictionary(
        dictionary_key=dictionary_key,
        name=name,
        description=(payload.description or "").strip() or None,
        is_active=1,
    )
    db.add(dictionary)
    db.flush()
    write_audit_log(
        db,
        current_user,
        "create_dictionary",
        "dictionary",
        dictionary.id,
        {"dictionary_key": dictionary_key, "name": name},
    )
    _commit(db)
    db.refresh(dictionary)
    return {"dictionary": _serialize_dictionary(db, dictionary)}


@router.patch("/api/admin/dictionaries/{dictionary_key}")
def update_dictionary(
    dictionary_key: str,
    payload: DictionaryUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_management_admin(current_user)
    _require_system_database_writer(current_user)
    dictionary = _dictionary_or_404(db, dictionary_key)
    changes: dict[str, object] = {}
    if payload.name is not None:
        dictionary.name = payload.name.strip()
        changes["name"] = dictionary.name
    if payload.description is not None:
        dictionary.description = payload.description.strip() or None
        changes["description"] = dictionary.description
    if payload.is_active is not None:
        dictionary.is_active = 1 if payload.is_active else 0
        changes["is_active"] = payload.is_active
    if changes:
        write_audit_log(
            db,
            current_user,
            "update_dictionary",
            "dictionary",
            dictionary.id,
            changes,
        )
        _commit(db)
        db.refresh(dictionary)
    return {"dictionary": _serialize_dictionary(db, dictionary)}


@router.get("/api/admin/dictionaries/{dictionary_key}/items")
def list_dictionary_items(
    dictionary_key: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_management_admin(current_user)
    dictionary = _dictionary_or_404(db, dictionary_key)
    return {
        "dictionary": _serialize_dictionary(db, dictionary),
        "items": [
            _serialize_dictionary_item(item)
            for item in _dictionary_items(db, dictionary.id)
        ],
    }


@router.post("/api/admin/dictionaries/{dictionary_key}/items")
def create_dictionary_item(
    dictionary_key: str,
    payload: DictionaryItemCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_management_admin(current_user)
    _require_system_database_writer(current_user)
    dictionary = _dictionary_or_404(db, dictionary_key)
    label = payload.label.strip()
    item_code = _normalize_dictionary_code(payload.item_code or "", label)
    duplicate = db.scalar(
        select(CodeDictionaryItem).where(
            CodeDictionaryItem.dictionary_id == dictionary.id,
            (CodeDictionaryItem.item_code == item_code)
            | (CodeDictionaryItem.label == label),
        )
    )
    if duplicate:
        raise HTTPException(status_code=409, detail="That item code or label already exists.")
    existing_items = _dictionary_items(db, dictionary.id)
    sort_order = payload.sort_order or (
        max((item.sort_order for item in existing_items), default=0) + 1
    )
    item = CodeDictionaryItem(
        dictionary_id=dictionary.id,
        item_code=item_code,
        label=label,
        sort_order=sort_order,
        is_active=1,
        metadata_json=json.dumps(payload.metadata, sort_keys=True) if payload.metadata else None,
    )
    db.add(item)
    db.flush()
    write_audit_log(
        db,
        current_user,
        "create_dictionary_item",
        "dictionary_item",
        item.id,
        {
            "dictionary_key": dictionary.dictionary_key,
            "item_code": item_code,
            "label": label,
        },
    )
    _commit(db)
    db.refresh(item)
    return {"item": _serialize_dictionary_item(item)}


@router.patch("/api/admin/dictionaries/{dictionary_key}/items/{item_id}")
def update_dictionary_item(
    dictionary_key: str,
    item_id: int,
    payload: DictionaryItemUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_management_admin(current_user)
    _require_system_database_writer(current_user)
    dictionary = _dictionary_or_404(db, dictionary_key)
    item = db.get(CodeDictionaryItem, item_id)
    if item is None or item.dictionary_id != dictionary.id:
        raise HTTPException(status_code=404, detail="Dictionary item was not found.")
    changes: dict[str, object] = {}
    if payload.label is not None:
        label = payload.label.strip()
        duplicate = db.scalar(
            select(CodeDictionaryItem).where(
                CodeDictionaryItem.dictionary_id == dictionary.id,
                CodeDictionaryItem.label == label,
                CodeDictionaryItem.id != item.id,
            )
        )
        if duplicate:
            raise HTTPException(status_code=409, detail="That item label already exists.")
        item.label = label
        changes["label"] = label
    if payload.sort_order is not None:
        item.sort_order = payload.sort_order
        changes["sort_order"] = payload.sort_order
    if payload.is_active is not None:
        item.is_active = 1 if payload.is_active else 0
        changes["is_active"] = payload.is_active
    if payload.metadata is not None:
        item.metadata_json = json.dumps(payload.metadata, sort_keys=True)
        changes["metadata"] = payload.metadata
    if changes:
        write_audit_log(
            db,
            current_user,
            "update_dictionary_item",
            "dictionary_item",
            item.id,
            {"dictionary_key": dictionary.dictionary_key, **changes},
        )
        _commit(db)
        db.refresh(item)
    return {"item": _serialize_dictionary_item(item)}


@router.put("/api/admin/dictionaries/{dictionary_key}/items-order")
def reorder_dictionary_items(
    dictionary_key: str,
    payload: DictionaryItemOrderRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_management_admin(current_user)
    _require_system_database_writer(current_user)
    dictionary = _dictionary_or_404(db, dictionary_key)
    items = _dictionary_items(db, dictionary.id)
    item_ids = payload.item_ids
    if len(item_ids) != len(set(item_ids)) or set(item_ids) != {item.id for item in items}:
        raise HTTPException(
            status_code=422,
            detail="The display order must include every dictionary item exactly once.",
        )
    by_id = {item.id: item for item in items}
    previous_order = [item.id for item in items]
    for sort_order, item_id in enumerate(item_ids, start=1):
        by_id[item_id].sort_order = sort_order
    write_audit_log(
        db,
        current_user,
        "reorder_dictionary_items",
        "dictionary",
        dictionary.id,
        {"previous_order": previous_order, "item_ids": item_ids},
    )
    _commit(db)
    return {
        "items": [
            _serialize_dictionary_item(item)
            for item in _dictionary_items(db, dictionary.id)
        ]
    }


@router.get("/api/admin/audit-logs")
def list_audit_logs(
    limit: int = Query(default=100, ge=1, le=500),
    _current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    logs = db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)).all()
    return {
        "logs": [
            {
                "id": item.id,
                "actor_user_id": item.actor_user_id,
                "action": item.action,
                "target_type": item.target_type,
                "target_id": item.target_id,
                "details_json": item.details_json,
                "created_at": item.created_at,
            }
            for item in logs
        ]
    }


@router.get("/api/admin/audit")
def list_audit_logs_legacy(
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    return list_audit_logs(limit, current_user, db)
