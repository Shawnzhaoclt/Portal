from __future__ import annotations

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.management.database import Base


class Team(Base):
    __tablename__ = "SYS_TEAMS"
    __table_args__ = (
        CheckConstraint("is_active IN (0, 1)", name="ck_teams_is_active"),
        CheckConstraint("parent_team_id IS NULL OR parent_team_id <> id", name="ck_teams_not_own_parent"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text)
    parent_team_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_TEAMS.id", ondelete="SET NULL"))
    manager_user_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_USERS.id", ondelete="SET NULL"))
    is_active: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp())
    updated_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp(), onupdate=func.current_timestamp())

    parent: Mapped["Team | None"] = relationship("Team", remote_side=[id], foreign_keys=[parent_team_id])


class User(Base):
    __tablename__ = "SYS_USERS"
    __table_args__ = (
        CheckConstraint("is_active IN (0, 1)", name="ck_users_is_active"),
        CheckConstraint("is_system_admin IN (0, 1)", name="ck_users_is_system_admin"),
        CheckConstraint("is_admin IN (0, 1)", name="ck_users_is_admin"),
        CheckConstraint("must_change_password IN (0, 1)", name="ck_users_must_change_password"),
        CheckConstraint("is_system_admin = 0 OR is_active = 1", name="ck_system_admin_active"),
        CheckConstraint("is_system_admin = 0 OR deleted_at IS NULL", name="ck_system_admin_not_deleted"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    first_name: Mapped[str] = mapped_column(String, nullable=False)
    last_name: Mapped[str] = mapped_column(String, nullable=False)
    email: Mapped[str] = mapped_column(String(collation="NOCASE"), nullable=False, unique=True, index=True)
    employee_id: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    team_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_TEAMS.id", ondelete="SET NULL"), index=True)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    is_active: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_system_admin: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_admin: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    must_change_password: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    failed_login_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[str | None] = mapped_column(String)
    last_login_at: Mapped[str | None] = mapped_column(String)
    password_changed_at: Mapped[str | None] = mapped_column(String)
    deleted_at: Mapped[str | None] = mapped_column(String, index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_USERS.id", ondelete="SET NULL"))
    created_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp())
    updated_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp(), onupdate=func.current_timestamp())

    team: Mapped[Team | None] = relationship("Team", foreign_keys=[team_id])


class Resource(Base):
    __tablename__ = "SYS_RESOURCES"
    __table_args__ = (
        CheckConstraint("resource_type IN ('dashboard', 'map', 'tab', 'doc', 'report', 'dataset', 'service', 'admin', 'api')", name="ck_resources_type"),
        CheckConstraint("resource_id GLOB '[A-Z][A-Z][A-Z][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]'", name="ck_resources_resource_id_format"),
        CheckConstraint("is_public IN (0, 1)", name="ck_resources_is_public"),
        CheckConstraint("is_active IN (0, 1)", name="ck_resources_is_active"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    resource_id: Mapped[str] = mapped_column(String(8), nullable=False, unique=True, index=True)
    resource_key: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    resource_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    url: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String)
    icon: Mapped[str | None] = mapped_column(String)
    is_public: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    is_active: Mapped[int] = mapped_column(Integer, nullable=False, default=1, index=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp())
    updated_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp(), onupdate=func.current_timestamp())


class ResourcePermission(Base):
    __tablename__ = "SYS_RESOURCE_PERMISSIONS"
    __table_args__ = (
        CheckConstraint(
            "(user_id IS NOT NULL AND team_id IS NULL) OR (user_id IS NULL AND team_id IS NOT NULL)",
            name="ck_resource_permissions_one_subject",
        ),
        CheckConstraint("permission_level IN (10, 20, 30, 40)", name="ck_resource_permissions_level"),
        UniqueConstraint("resource_id", "user_id", name="uq_resource_permission_user"),
        UniqueConstraint("resource_id", "team_id", name="uq_resource_permission_team"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    resource_id: Mapped[str] = mapped_column(
        String(8),
        ForeignKey("SYS_RESOURCES.resource_id", ondelete="CASCADE", onupdate="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_USERS.id", ondelete="CASCADE"), index=True)
    team_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_TEAMS.id", ondelete="CASCADE"), index=True)
    permission_level: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_USERS.id", ondelete="SET NULL"))
    created_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp())
    updated_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp(), onupdate=func.current_timestamp())

    resource: Mapped[Resource] = relationship("Resource")
    user: Mapped[User | None] = relationship("User", foreign_keys=[user_id])
    team: Mapped[Team | None] = relationship("Team", foreign_keys=[team_id])


class UserFeaturedResource(Base):
    __tablename__ = "SYS_USER_FEATURED_RESOURCES"
    __table_args__ = (
        CheckConstraint(
            "category IN ('all', 'dashboard', 'map', 'tab', 'doc', 'report', 'dataset')",
            name="ck_user_featured_resources_category",
        ),
        UniqueConstraint("user_id", "category", "resource_record_id", name="uq_user_featured_resource_category"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("SYS_USERS.id", ondelete="CASCADE"), nullable=False, index=True)
    category: Mapped[str] = mapped_column(String, nullable=False, default="all", index=True)
    resource_record_id: Mapped[int] = mapped_column(ForeignKey("SYS_RESOURCES.id", ondelete="CASCADE"), nullable=False, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp())
    updated_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp(), onupdate=func.current_timestamp())

    resource: Mapped[Resource] = relationship("Resource")


class TeamFeaturedResource(Base):
    __tablename__ = "SYS_TEAM_FEATURED_RESOURCES"
    __table_args__ = (
        CheckConstraint(
            "category IN ('all', 'dashboard', 'map', 'tab', 'doc', 'report', 'dataset')",
            name="ck_team_featured_resources_category",
        ),
        UniqueConstraint("team_id", "category", "resource_record_id", name="uq_team_featured_resource_category"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("SYS_TEAMS.id", ondelete="CASCADE"), nullable=False, index=True)
    category: Mapped[str] = mapped_column(String, nullable=False, default="all", index=True)
    resource_record_id: Mapped[int] = mapped_column(ForeignKey("SYS_RESOURCES.id", ondelete="CASCADE"), nullable=False, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp())
    updated_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp(), onupdate=func.current_timestamp())

    team: Mapped[Team] = relationship("Team")
    resource: Mapped[Resource] = relationship("Resource")


class PasswordResetToken(Base):
    __tablename__ = "SYS_PASSWORD_RESET_TOKENS"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("SYS_USERS.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    expires_at: Mapped[str] = mapped_column(String, nullable=False, index=True)
    used_at: Mapped[str | None] = mapped_column(String)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_USERS.id", ondelete="SET NULL"))
    created_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp())


class AuditLog(Base):
    __tablename__ = "SYS_AUDIT_LOGS"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("SYS_USERS.id", ondelete="SET NULL"), index=True)
    action: Mapped[str] = mapped_column(String, nullable=False)
    target_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    target_id: Mapped[int | None] = mapped_column(Integer, index=True)
    details_json: Mapped[str | None] = mapped_column(Text)
    ip_address: Mapped[str | None] = mapped_column(String)
    user_agent: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[str] = mapped_column(String, nullable=False, server_default=func.current_timestamp(), index=True)
