from __future__ import annotations

import csv
import os
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.core.paths import PROJECT_ROOT
from backend.app.dashboards.catalog import DASHBOARDS
from backend.app.management.models import Resource, Team, User
from backend.app.management.security import hash_password
from backend.app.management.services import display_name, write_audit_log


def pto_org_csv_path() -> Path:
    configured = os.getenv("PORTAL_PTO_ORG_CSV", "").strip()
    if configured:
        return Path(configured)
    return PROJECT_ROOT / "PTO_ORG.csv"


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y"}


def _username_from_email(email: str, employee_id: str) -> str:
    local = email.split("@", 1)[0].strip().lower()
    return local or str(employee_id).strip()


def _default_admin_emails() -> set[str]:
    configured = os.getenv(
        "PORTAL_DEFAULT_ADMIN_EMAILS",
        "robert.jarzemsky@charlottenc.gov,shawn.zhao@charlottenc.gov,crystal.williams@charlottenc.gov",
    )
    return {email.strip().lower() for email in configured.split(",") if email.strip()}


def _default_system_admin_emails() -> set[str]:
    configured = os.getenv(
        "PORTAL_DEFAULT_SYSTEM_ADMIN_EMAILS",
        "shawn.zhao@charlottenc.gov",
    )
    return {email.strip().lower() for email in configured.split(",") if email.strip()}


def _read_org_rows() -> list[dict[str, str]]:
    path = pto_org_csv_path()
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [{k.strip(): (v or "").strip() for k, v in row.items()} for row in csv.DictReader(handle)]


def seed_resources(db: Session) -> None:
    for item in DASHBOARDS:
        resource = db.scalar(select(Resource).where(Resource.resource_key == item["id"]))
        if resource is None:
            resource = Resource(resource_key=item["id"])
            db.add(resource)
        resource.name = item["title"]
        resource.resource_type = item.get("kind", "dashboard")
        resource.url = item["path"]
        resource.description = item.get("description")
        resource.category = item.get("category")
        resource.icon = None
        resource.is_active = 1
        resource.is_public = 0

    management_resource = db.scalar(select(Resource).where(Resource.resource_key == "admin_management"))
    if management_resource is None:
        management_resource = Resource(resource_key="admin_management")
        db.add(management_resource)
    management_resource.name = "Portal Management"
    management_resource.resource_type = "admin"
    management_resource.url = "/admin_management"
    management_resource.description = "Manage Portal users, teams, resources, permissions, and personal featured items."
    management_resource.category = "Administration"
    management_resource.icon = "settings"
    management_resource.is_public = 0
    management_resource.is_active = 1


def _team_manager_rows(rows: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    by_employee = {row["employee_id"]: row for row in rows if row.get("employee_id")}
    managers: dict[str, dict[str, str]] = {}

    for team_name in sorted({row.get("team", "") for row in rows if row.get("team")}):
        manager_candidates = [row for row in rows if row.get("team") == team_name and _truthy(row.get("is_manager"))]
        outside_report_candidates = [
            row for row in manager_candidates
            if by_employee.get(row.get("report to", ""), {}).get("team") != team_name
        ]
        if outside_report_candidates:
            managers[team_name] = outside_report_candidates[0]
        elif manager_candidates:
            managers[team_name] = manager_candidates[0]
        else:
            team_rows = [row for row in rows if row.get("team") == team_name]
            if team_rows:
                managers[team_name] = team_rows[0]

    return managers


def seed_org_users(db: Session) -> None:
    rows = _read_org_rows()
    if not rows:
        return

    team_names = sorted({row["team"] for row in rows if row.get("team")})
    teams: dict[str, Team] = {}
    for team_name in team_names:
        team = db.scalar(select(Team).where(Team.name == team_name))
        if team is None:
            team = Team(name=team_name)
            db.add(team)
            db.flush()
        team.description = f"Seeded from {pto_org_csv_path().name}"
        team.is_active = 1
        teams[team_name] = team

    root_row = next((row for row in rows if row.get("report to") not in {r.get("employee_id") for r in rows}), rows[0])
    default_admin_emails = _default_admin_emails()
    default_system_admin_emails = _default_system_admin_emails()

    users_by_employee: dict[str, User] = {}
    for row in rows:
        employee_id = row.get("employee_id", "")
        if not employee_id:
            continue
        user = db.scalar(select(User).where(User.employee_id == employee_id))
        if user is None:
            user = User(
                employee_id=employee_id,
                password_hash=hash_password(employee_id),
                must_change_password=0,
            )
            db.add(user)
        user.first_name = row.get("first_name") or "Unknown"
        user.last_name = row.get("last_name") or "User"
        user.email = row.get("email") or f"{employee_id}@example.local"
        user.username = _username_from_email(user.email, employee_id)
        user.team_id = teams[row["team"]].id if row.get("team") in teams else None
        user.is_active = 1
        user.deleted_at = None
        user.must_change_password = 0
        if user.email.lower() in default_admin_emails:
            user.is_admin = 1
        if user.email.lower() in default_system_admin_emails:
            user.is_system_admin = 1
            user.is_admin = 1
        elif user.email.lower() in default_admin_emails:
            user.is_system_admin = 0
        users_by_employee[employee_id] = user

    db.flush()

    system_admin = db.scalar(select(User).where(User.is_system_admin == 1, User.deleted_at.is_(None)))
    if system_admin is None:
        root_user = users_by_employee.get(root_row.get("employee_id", ""))
        if root_user:
            root_user.is_system_admin = 1
            root_user.is_admin = 1
            system_admin = root_user
            db.flush()

    manager_rows = _team_manager_rows(rows)
    by_employee = {row["employee_id"]: row for row in rows if row.get("employee_id")}
    for team_name, team in teams.items():
        manager_row = manager_rows.get(team_name)
        if not manager_row:
            continue
        manager_user = users_by_employee.get(manager_row.get("employee_id", ""))
        if manager_user:
            team.manager_user_id = manager_user.id

        report_to = by_employee.get(manager_row.get("report to", ""))
        parent_team_name = report_to.get("team") if report_to else ""
        if parent_team_name and parent_team_name != team_name and parent_team_name in teams:
            team.parent_team_id = teams[parent_team_name].id
        elif team.parent_team_id == team.id:
            team.parent_team_id = None

    db.flush()

    write_audit_log(
        db,
        system_admin,
        "seed_org_users",
        "management_database",
        None,
        {"csv": str(pto_org_csv_path()), "users": len(users_by_employee), "teams": len(teams), "system_admin": display_name(system_admin)},
    )


def initialize_management_database() -> None:
    from backend.app.management.database import create_management_schema, session_scope

    create_management_schema()
    with session_scope() as db:
        seed_resources(db)
        seed_org_users(db)
