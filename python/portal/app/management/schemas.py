from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


class LoginRequest(BaseModel):
    login: str
    password: str
    role: str | None = None


class SwitchRoleRequest(BaseModel):
    role: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


class FeaturedResourcesRequest(BaseModel):
    resource_ids: list[int] | None = None
    featured: dict[str, list[int]] | None = None


class UserCreateRequest(BaseModel):
    first_name: str
    last_name: str
    email: EmailStr
    employee_id: str
    # Kept for backward-compatible clients; the server derives this value from the name.
    username: str | None = None
    team_id: int | None = None
    is_admin: bool = False
    is_active: bool = True


class UserUpdateRequest(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    email: EmailStr | None = None
    employee_id: str | None = None
    # Kept for backward-compatible clients; the server derives this value from the name.
    username: str | None = None
    team_id: int | None = None
    is_active: bool | None = None


class AdminStatusRequest(BaseModel):
    is_admin: bool


class TeamCreateRequest(BaseModel):
    name: str
    description: str | None = None
    parent_team_id: int | None = None
    manager_user_id: int | None = None
    is_active: bool = True


class TeamUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    parent_team_id: int | None = None
    manager_user_id: int | None = None
    is_active: bool | None = None


class ResourceCreateRequest(BaseModel):
    resource_id: str
    resource_key: str
    name: str
    resource_type: str
    url: str
    description: str | None = None
    category: str | None = None
    icon: str | None = None
    is_public: bool = False
    is_active: bool = True


class ResourceUpdateRequest(BaseModel):
    resource_id: str | None = None
    resource_key: str | None = None
    name: str | None = None
    resource_type: str | None = None
    url: str | None = None
    description: str | None = None
    category: str | None = None
    icon: str | None = None
    is_public: bool | None = None
    is_active: bool | None = None


class PermissionAssignment(BaseModel):
    user_id: int | None = None
    team_id: int | None = None
    permission_level: int


class ResourcePermissionsRequest(BaseModel):
    permissions: list[PermissionAssignment]


class BulkPermissionAssignment(BaseModel):
    resource_id: str
    permission_level: int | None = None


class BulkPermissionsRequest(BaseModel):
    subject_type: str
    subject_id: int
    assignments: list[BulkPermissionAssignment]


class ResourceDiscoveryApplyItem(BaseModel):
    resource_key: str
    action: str


class ResourceDiscoveryApplyRequest(BaseModel):
    actions: list[ResourceDiscoveryApplyItem]


class DictionaryCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    dictionary_key: str | None = Field(default=None, max_length=64)
    description: str | None = Field(default=None, max_length=500)


class DictionaryUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    is_active: bool | None = None


class DictionaryItemCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    item_code: str | None = Field(default=None, max_length=64)
    sort_order: int | None = Field(default=None, ge=1, le=9999)
    metadata: dict[str, object] | None = None


class DictionaryItemUpdateRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    sort_order: int | None = Field(default=None, ge=1, le=9999)
    is_active: bool | None = None
    metadata: dict[str, object] | None = None


class DictionaryItemOrderRequest(BaseModel):
    item_ids: list[int] = Field(min_length=1)
