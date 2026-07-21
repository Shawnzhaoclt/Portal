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
    username: str | None = None
    team_id: int | None = None
    is_admin: bool = False
    is_active: bool = True


class UserUpdateRequest(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    email: EmailStr | None = None
    employee_id: str | None = None
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
