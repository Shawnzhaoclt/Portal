"""Standalone Portal Manager data bridge.

The workstation manager calls this module over JSON lines.  It intentionally
uses only the Python standard library so it can run beside the portable
manager without starting FastAPI or another local service.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


PERMISSIONS = {
    "view": 1,
    "edit": 2,
    "manage": 4,
    "admin": 8,
    "review": 16,
    "create": 32,
    "delete": 64,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def expand_value(value: Any, package_root: Path) -> Any:
    if not isinstance(value, str):
        return value
    value = value.replace("${PORTAL_APP_ROOT}", str(package_root))
    value = value.replace("${PORTAL_PACKAGE_ROOT}", str(package_root))
    value = value.replace("${PORTAL_DATA_ROOT}", str(package_root))
    value = os.path.expandvars(value)
    return value


def nested_value(settings: dict[str, Any], *paths: tuple[str, ...]) -> Any:
    for path in paths:
        current: Any = settings
        for key in path:
            if not isinstance(current, dict) or key not in current:
                current = None
                break
            current = current[key]
        if current not in (None, ""):
            return current
    return None


def resolve_settings(path: Path) -> tuple[Path, Path]:
    # Tauri may pass a relative settings path when the Manager is launched
    # from a shortcut. Normalize it before expanding package-root variables;
    # otherwise a relative expanded value can be joined to config twice.
    path = path.expanduser().resolve()
    settings = json.loads(path.read_text(encoding="utf-8"))
    package_root = path.parent.parent
    system_value = nested_value(
        settings,
        ("system", "database"),
        ("systemDatabase",),
        ("databases", "system"),
    )
    business_value = nested_value(
        settings,
        ("business", "database"),
        ("businessDatabase",),
        ("databases", "business"),
    )
    system_path = Path(expand_value(system_value or "config/system.db", package_root))
    business_path = Path(expand_value(business_value or "data/stormwater.db", package_root))
    if not system_path.is_absolute():
        system_path = (path.parent / system_path).resolve()
    if not business_path.is_absolute():
        business_path = (path.parent / business_path).resolve()
    return system_path, business_path


def open_db(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise RuntimeError(f"Database does not exist: {path}")
    connection = sqlite3.connect(str(path), timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    return connection


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def columns(connection: sqlite3.Connection, table: str) -> set[str]:
    if not table_exists(connection, table):
        return set()
    return {str(row[1]) for row in connection.execute(f'PRAGMA table_info("{table}")')}


def rows(connection: sqlite3.Connection, sql: str, parameters: Iterable[Any] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(sql, tuple(parameters)).fetchall()]


def first_or_none(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    return items[0] if items else None


def display_name(row: dict[str, Any]) -> str:
    return " ".join(part for part in [row.get("first_name"), row.get("last_name")] if part) or str(row.get("username") or row.get("email") or "")


def password_hash(password: str) -> str:
    iterations = 210_000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations,
        salt.hex(),
        digest.hex(),
    )


def actor_record(system: sqlite3.Connection, request: dict[str, Any]) -> dict[str, Any]:
    email = str(
        request.get("_windows_user_email")
        or request.get("actorEmail")
        or os.environ.get("PORTAL_WINDOWS_EMAIL")
        or os.environ.get("USERPRINCIPALNAME")
        or ""
    ).strip()
    username = getpass.getuser().strip()
    user = first_or_none(
        rows(
            system,
            """
            SELECT u.*, t.name AS team_name
            FROM SYS_USERS u
            LEFT JOIN SYS_TEAMS t ON t.id = u.team_id
            WHERE lower(u.email) = lower(?)
               OR lower(u.username) = lower(?)
               OR u.employee_id = ?
            LIMIT 1
            """,
            (email, username, email),
        )
    )
    if not user:
        raise RuntimeError(f"The Windows account is not registered in Portal: {email or username}")
    if not user.get("is_active", 1):
        raise RuntimeError("The signed-in Portal account is disabled.")

    roles = ["user"]
    if user.get("is_admin"):
        roles.append("admin")
    if user.get("is_system_admin"):
        roles.append("system_admin")
    manager_row = system.execute(
        "SELECT 1 FROM SYS_TEAMS WHERE manager_user_id = ? AND is_active = 1 LIMIT 1",
        (user["id"],),
    ).fetchone()
    if manager_row:
        roles.append("manager")
    requested = str(request.get("selectedRole") or "").strip()
    if requested in roles:
        selected = requested
    elif "system_admin" in roles:
        selected = "system_admin"
    elif "admin" in roles:
        selected = "admin"
    elif "manager" in roles:
        selected = "manager"
    else:
        selected = "user"
    return {
        "id": user["id"],
        "name": display_name(user),
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "email": user.get("email"),
        "employee_id": user.get("employee_id"),
        "team_id": user.get("team_id"),
        "team_name": user.get("team_name"),
        "roles": roles,
        "selected_role": selected,
    }


def require_admin(actor: dict[str, Any]) -> None:
    if actor["selected_role"] not in {"admin", "system_admin"}:
        raise RuntimeError("Portal Admin or System Admin role is required.")


def require_system_admin(actor: dict[str, Any]) -> None:
    if actor["selected_role"] != "system_admin":
        raise RuntimeError("System Admin role is required for this operation.")


def audit(system: sqlite3.Connection, actor: dict[str, Any], action: str, target_type: str, target_id: Any, details: dict[str, Any] | None = None) -> None:
    if not table_exists(system, "SYS_AUDIT_LOGS"):
        return
    system.execute(
        """
        INSERT INTO SYS_AUDIT_LOGS
          (id, actor_user_id, action, target_type, target_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(uuid.uuid4()),
            actor["id"],
            action,
            target_type,
            str(target_id),
            json.dumps(details or {}, ensure_ascii=False, sort_keys=True),
            utc_now(),
        ),
    )


def summary(system: sqlite3.Connection) -> dict[str, int]:
    def count(table: str, where: str = "") -> int:
        if not table_exists(system, table):
            return 0
        return int(system.execute(f"SELECT COUNT(*) FROM {table} {where}").fetchone()[0])

    return {
        "users": count("SYS_USERS", "WHERE deleted_at IS NULL"),
        "teams": count("SYS_TEAMS"),
        "resources": count("SYS_RESOURCES"),
        "permissions": count("SYS_RESOURCE_PERMISSIONS"),
        "dictionaries": count("SYS_DICTIONARIES"),
        "audit_events": count("SYS_AUDIT_LOGS"),
    }


def users_list(system: sqlite3.Connection) -> list[dict[str, Any]]:
    return rows(
        system,
        """
        SELECT u.id, u.first_name, u.last_name, u.username, u.email, u.employee_id,
               u.team_id, t.name AS team_name, u.is_active, u.is_admin,
               u.is_system_admin, u.created_at, u.updated_at
        FROM SYS_USERS u
        LEFT JOIN SYS_TEAMS t ON t.id = u.team_id
        WHERE u.deleted_at IS NULL
        ORDER BY lower(u.last_name), lower(u.first_name), lower(u.email)
        """,
    )


def teams_list(system: sqlite3.Connection) -> list[dict[str, Any]]:
    return rows(
        system,
        """
        SELECT t.id, t.name, t.description, t.parent_team_id, p.name AS parent_name,
               t.manager_user_id, trim(coalesce(m.first_name, '') || ' ' || coalesce(m.last_name, '')) AS manager_name,
               t.is_active, t.created_at, t.updated_at,
               (SELECT COUNT(*) FROM SYS_USERS u WHERE u.team_id = t.id AND u.deleted_at IS NULL) AS member_count
        FROM SYS_TEAMS t
        LEFT JOIN SYS_TEAMS p ON p.id = t.parent_team_id
        LEFT JOIN SYS_USERS m ON m.id = t.manager_user_id
        ORDER BY lower(t.name)
        """,
    )


def resources_list(system: sqlite3.Connection) -> list[dict[str, Any]]:
    return rows(
        system,
        """
        SELECT id, resource_id, resource_key, name, resource_type, url, category,
               description, icon, is_public, is_active, created_at, updated_at
        FROM SYS_RESOURCES
        ORDER BY lower(category), lower(name)
        """,
    )


def permission_subject_column(system: sqlite3.Connection) -> tuple[str, str]:
    fields = columns(system, "SYS_RESOURCE_PERMISSIONS")
    resource_column = "resource_id" if "resource_id" in fields else "resource_record_id"
    if "team_id" in fields:
        return resource_column, "team_id"
    return resource_column, "user_id"


def resolve_resource_record(system: sqlite3.Connection, reference: Any) -> tuple[str, Any, dict[str, Any]]:
    """Resolve either the internal FK, public resource id, or resource key.

    SYS_RESOURCE_PERMISSIONS may use either the public SYS_RESOURCES.resource_id
    or the legacy internal SYS_RESOURCES.id, depending on the installed catalog
    schema. The returned resource record id is always the internal SYS_RESOURCES.id;
    callers that write permissions must convert it back to the permission column's
    representation with permission_resource_reference().
    """
    value = str(reference or "").strip()
    if not value:
        raise RuntimeError("A resource id is required.")
    fields = columns(system, "SYS_RESOURCES")
    candidates = [field for field in ("id", "resource_id", "resource_key") if field in fields]
    for field in candidates:
        row = first_or_none(rows(system, f'SELECT * FROM SYS_RESOURCES WHERE "{field}" = ? LIMIT 1', (value,)))
        if row:
            identity = "id" if "id" in fields else field
            return identity, row[identity], row
    raise RuntimeError(f"Resource was not found: {value}")


def permission_resource_reference_mode(system: sqlite3.Connection, resource_column: str) -> str:
    """Identify whether a permission table stores public or internal resource IDs."""
    if resource_column == "resource_record_id":
        return "internal"

    for foreign_key in system.execute('PRAGMA foreign_key_list("SYS_RESOURCE_PERMISSIONS")').fetchall():
        if str(foreign_key[2]).upper() == "SYS_RESOURCES" and str(foreign_key[3]) == resource_column:
            return "public" if str(foreign_key[4]) == "resource_id" else "internal"

    total = int(system.execute("SELECT COUNT(*) FROM SYS_RESOURCE_PERMISSIONS").fetchone()[0])
    if total == 0:
        return "public"
    public_matches = int(
        system.execute(
            """
            SELECT COUNT(*)
            FROM SYS_RESOURCE_PERMISSIONS p
            INNER JOIN SYS_RESOURCES r ON r.resource_id = p.resource_id
            """
        ).fetchone()[0]
    )
    return "public" if public_matches * 2 >= total else "internal"


def permission_resource_reference(
    system: sqlite3.Connection,
    resource_column: str,
    resource_record_id: Any,
    resource: dict[str, Any],
) -> Any:
    if permission_resource_reference_mode(system, resource_column) == "public":
        return resource.get("resource_id") or resource_record_id
    return resource_record_id


def permission_types(level: Any) -> list[str]:
    numeric = int(level or 0)
    return [name for name, bit in PERMISSIONS.items() if numeric & bit]


def permission_label(level: Any) -> str | None:
    values = permission_types(level)
    return ", ".join(value.title() for value in values) if values else None


def permissions_list(system: sqlite3.Connection) -> list[dict[str, Any]]:
    resource_column, _ = permission_subject_column(system)
    resource_identity = "id" if "id" in columns(system, "SYS_RESOURCES") else "resource_id"
    public_resource = "resource_id" if "resource_id" in columns(system, "SYS_RESOURCES") else resource_identity
    resource_mode = permission_resource_reference_mode(system, resource_column)
    resource_join = (
        f"r.resource_id = p.{resource_column}"
        if resource_mode == "public"
        else f"r.id = p.{resource_column}"
    )
    return rows(
        system,
        f"""
        SELECT p.id, p.{resource_column} AS resource_record_id,
               r.{public_resource} AS resource_id, r.resource_key,
               p.user_id, p.team_id,
               p.permission_level, r.name AS resource_name, r.url,
               trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) AS user_name,
               t.name AS team_name
        FROM SYS_RESOURCE_PERMISSIONS p
        LEFT JOIN SYS_RESOURCES r ON {resource_join}
        LEFT JOIN SYS_USERS u ON u.id = p.user_id
        LEFT JOIN SYS_TEAMS t ON t.id = p.team_id
        ORDER BY lower(coalesce(r.name, '')), lower(coalesce(t.name, u.last_name, ''))
        """,
    )


def permission_matrix(system: sqlite3.Connection, data: dict[str, Any]) -> dict[str, Any]:
    subject_type = str(data.get("subject_type") or "").strip().lower()
    if subject_type not in {"team", "user"}:
        raise RuntimeError("Permission subject type must be team or user.")
    subject_id = data.get("subject_id")
    if subject_id in (None, ""):
        raise RuntimeError("A permission subject is required.")
    subject_table = "SYS_TEAMS" if subject_type == "team" else "SYS_USERS"
    if system.execute(f'SELECT 1 FROM "{subject_table}" WHERE id = ? LIMIT 1', (subject_id,)).fetchone() is None:
        raise RuntimeError("The selected permission subject was not found.")

    where = []
    parameters: list[Any] = []
    if not data.get("include_inactive"):
        where.append("is_active = 1")
    resource_type = str(data.get("resource_type") or "").strip()
    if resource_type:
        where.append("resource_type = ?")
        parameters.append(resource_type)
    category = str(data.get("category") or "").strip()
    if category:
        where.append("category = ?")
        parameters.append(category)
    search = str(data.get("search") or "").strip().lower()
    if search:
        where.append("lower(resource_id || ' ' || resource_key || ' ' || name || ' ' || url || ' ' || coalesce(category, '')) LIKE ?")
        parameters.append(f"%{search}%")
    predicate = f"WHERE {' AND '.join(where)}" if where else ""
    resources = rows(
        system,
        f"""
        SELECT id, resource_id, resource_key, name, resource_type, url, category,
               description, icon, is_public, is_active, created_at, updated_at
        FROM SYS_RESOURCES {predicate}
        ORDER BY resource_type, category, lower(name)
        """,
        parameters,
    )
    resource_column, _ = permission_subject_column(system)
    resource_mode = permission_resource_reference_mode(system, resource_column)
    subject_column = "team_id" if subject_type == "team" else "user_id"
    result_rows: list[dict[str, Any]] = []
    for resource in resources:
        reference = permission_resource_reference(system, resource_column, resource["id"], resource)
        direct = first_or_none(
            rows(
                system,
                f"SELECT id, permission_level FROM SYS_RESOURCE_PERMISSIONS WHERE {resource_column} = ? AND {subject_column} = ? LIMIT 1",
                (reference, subject_id),
            )
        )
        effective_level = int(direct["permission_level"] if direct else 0)
        sources: list[str] = []
        if resource.get("is_public"):
            effective_level |= PERMISSIONS["view"]
            sources.append("public")
        if direct:
            sources.append("team" if subject_type == "team" else "user")
        if subject_type == "user":
            user = first_or_none(rows(system, "SELECT team_id FROM SYS_USERS WHERE id = ?", (subject_id,)))
            team_id = user.get("team_id") if user else None
            if team_id:
                team_permission = first_or_none(
                    rows(
                        system,
                        f"SELECT permission_level FROM SYS_RESOURCE_PERMISSIONS WHERE {resource_column} = ? AND team_id = ? LIMIT 1",
                        (reference, team_id),
                    )
                )
                if team_permission:
                    effective_level |= int(team_permission["permission_level"] or 0)
                    sources.append("team")
        result_rows.append(
            {
                "resource": resource,
                "direct_permission_id": direct.get("id") if direct else None,
                "direct_permission_level": direct.get("permission_level") if direct else None,
                "direct_permission": permission_label(direct.get("permission_level")) if direct else None,
                "direct_permission_types": permission_types(direct.get("permission_level")) if direct else [],
                "effective_permission": {
                    "permission_level": effective_level,
                    "permission": permission_label(effective_level) or "None",
                    "permission_types": permission_types(effective_level),
                    "source": " + ".join(dict.fromkeys(sources)),
                } if effective_level else None,
            }
        )
    return {"subject_type": subject_type, "subject_id": subject_id, "rows": result_rows}


def dictionary_by_reference(system: sqlite3.Connection, reference: Any) -> dict[str, Any]:
    value = str(reference or "").strip()
    if not value:
        raise RuntimeError("A dictionary is required.")
    row = first_or_none(rows(system, "SELECT * FROM SYS_DICTIONARIES WHERE id = ? OR dictionary_key = ? LIMIT 1", (value, value)))
    if not row:
        raise RuntimeError(f"Dictionary was not found: {value}")
    return row


def dictionaries_list(system: sqlite3.Connection) -> list[dict[str, Any]]:
    dictionaries = rows(
        system,
        "SELECT id, dictionary_key, name, description, is_active, created_at, updated_at FROM SYS_DICTIONARIES ORDER BY lower(name)",
    )
    for item in dictionaries:
        item["items"] = rows(
            system,
            """
            SELECT id, item_code, label, sort_order, is_active, metadata_json
            FROM SYS_DICTIONARY_ITEMS WHERE dictionary_id = ?
            ORDER BY sort_order, lower(label)
            """,
            (item["id"],),
        )
    return dictionaries


def holiday_list(business: sqlite3.Connection | None) -> dict[str, Any]:
    calendars = []
    holidays = []
    if business is None:
        return {"available": False, "calendars": calendars, "holidays": holidays}
    if table_exists(business, "ADMBSHVR_holiday_calendars"):
        calendars = rows(business, "SELECT * FROM ADMBSHVR_holiday_calendars ORDER BY calendar_year DESC")
    if table_exists(business, "ADMBSHVR_holidays"):
        holidays = rows(business, "SELECT * FROM ADMBSHVR_holidays ORDER BY holiday_date")
    for calendar in calendars:
        calendar["holiday_count"] = sum(1 for holiday in holidays if holiday.get("calendar_id") == calendar.get("calendar_id"))
    return {"available": bool(calendars or holidays or table_exists(business, "ADMBSHVR_holidays")), "calendars": calendars, "holidays": holidays}


def require_business(business: sqlite3.Connection | None) -> sqlite3.Connection:
    if business is None:
        raise RuntimeError("The local business database is not available. Sync stormwater.db before changing business data.")
    return business


def insert_with_known_columns(connection: sqlite3.Connection, table: str, values: dict[str, Any]) -> str:
    available = columns(connection, table)
    values = {key: value for key, value in values.items() if key in available}
    if not values:
        raise RuntimeError(f"No compatible columns were found in {table}.")
    keys = list(values)
    quoted = ", ".join(f'"{key}"' for key in keys)
    marks = ", ".join("?" for _ in keys)
    connection.execute(f'INSERT INTO "{table}" ({quoted}) VALUES ({marks})', [values[key] for key in keys])
    return str(values.get("id") or values.get("holiday_id") or values.get("item_id") or "")


def mutate(system: sqlite3.Connection, business: sqlite3.Connection | None, actor: dict[str, Any], request: dict[str, Any]) -> Any:
    action = str(request.get("action") or "").strip()
    data = request.get("data") if isinstance(request.get("data"), dict) else {}

    if action == "context":
        return {"actor": actor, "summary": summary(system)}
    if action == "summary":
        require_admin(actor)
        return summary(system)
    if action == "users_list":
        require_admin(actor)
        return users_list(system)
    if action == "teams_list":
        require_admin(actor)
        return teams_list(system)
    if action == "resources_list":
        require_admin(actor)
        return resources_list(system)
    if action == "permissions_list":
        require_admin(actor)
        return permissions_list(system)
    if action == "permission_matrix":
        require_admin(actor)
        return permission_matrix(system, data)
    if action == "dictionaries_list":
        require_admin(actor)
        return dictionaries_list(system)
    if action == "holidays_list":
        require_admin(actor)
        return holiday_list(business)
    if action == "holiday_calendar_detail":
        require_admin(actor)
        if business is None or not table_exists(business, "ADMBSHVR_holiday_calendars"):
            raise RuntimeError("The local business database is not available. Sync stormwater.db before viewing holiday calendars.")
        calendar_id = str(data.get("calendar_id") or "")
        calendar = first_or_none(rows(business, "SELECT * FROM ADMBSHVR_holiday_calendars WHERE calendar_id = ?", (calendar_id,)))
        if not calendar:
            raise RuntimeError("Holiday calendar was not found.")
        holidays = rows(business, "SELECT * FROM ADMBSHVR_holidays WHERE calendar_id = ? ORDER BY holiday_date", (calendar_id,)) if table_exists(business, "ADMBSHVR_holidays") else []
        return {"calendar": calendar, "holidays": holidays}
    if action == "audit_list":
        require_admin(actor)
        return rows(system, "SELECT * FROM SYS_AUDIT_LOGS ORDER BY created_at DESC LIMIT 500")

    require_admin(actor)
    now = utc_now()

    if action == "user_create":
        first = str(data.get("first_name") or "").strip()
        last = str(data.get("last_name") or "").strip()
        email = str(data.get("email") or "").strip()
        employee_id = str(data.get("employee_id") or "").strip()
        if not first or not last or not email or not employee_id:
            raise RuntimeError("First name, last name, email, and employee ID are required.")
        duplicate = system.execute("SELECT 1 FROM SYS_USERS WHERE lower(email) = lower(?) OR employee_id = ?", (email, employee_id)).fetchone()
        if duplicate:
            raise RuntimeError("Email address or employee ID already exists.")
        user_id = str(uuid.uuid4())
        username = (first[:1] + last).lower().replace(" ", "")
        team_id = data.get("team_id") or None
        system.execute(
            """
            INSERT INTO SYS_USERS
              (id, username, first_name, last_name, email, employee_id, team_id,
               password_hash, is_active, is_system_admin, is_admin, must_change_password,
               failed_login_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 0, 0, ?, ?)
            """,
            (user_id, username, first, last, email, employee_id, team_id, password_hash(employee_id), int(bool(data.get("is_admin"))), now, now),
        )
        audit(system, actor, "create_user", "user", user_id, {"email": email})
        system.commit()
        return {"id": user_id}

    if action == "user_update":
        user_id = str(data.get("id") or "")
        allowed = {key: data[key] for key in ("first_name", "last_name", "email", "employee_id", "team_id", "is_active") if key in data}
        if not user_id or not allowed:
            raise RuntimeError("A user ID and at least one editable field are required.")
        if "employee_id" in allowed:
            duplicate = system.execute("SELECT 1 FROM SYS_USERS WHERE employee_id = ? AND id <> ?", (allowed["employee_id"], user_id)).fetchone()
            if duplicate:
                raise RuntimeError("Employee ID already exists.")
        assignments = ", ".join(f'"{key}" = ?' for key in allowed)
        system.execute(f'UPDATE SYS_USERS SET {assignments}, updated_at = ? WHERE id = ?', [*allowed.values(), now, user_id])
        audit(system, actor, "update_user", "user", user_id, {"fields": list(allowed)})
        system.commit()
        return {"id": user_id}

    if action == "user_disable":
        user_id = str(data.get("id") or "")
        target = first_or_none(rows(system, "SELECT is_admin, is_system_admin FROM SYS_USERS WHERE id = ?", (user_id,)))
        if not target:
            raise RuntimeError("User was not found.")
        if target.get("is_admin") and actor["selected_role"] not in {"admin", "system_admin"}:
            raise RuntimeError("Only an Admin or System Admin can change an administrator account.")
        if target.get("is_admin") and actor["selected_role"] == "admin":
            raise RuntimeError("Only a System Admin can change an administrator account.")
        if target.get("is_system_admin") and actor["selected_role"] != "system_admin":
            raise RuntimeError("Only a System Admin can disable a System Admin account.")
        if target.get("is_system_admin") and user_id == actor["id"]:
            raise RuntimeError("You cannot disable your own System Admin account.")
        system.execute("UPDATE SYS_USERS SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?", (now, user_id))
        audit(system, actor, "toggle_user", "user", user_id)
        system.commit()
        return {"id": user_id}

    if action == "user_delete":
        require_system_admin(actor)
        user_id = str(data.get("id") or "")
        if not user_id:
            raise RuntimeError("A user ID is required.")
        if user_id == actor["id"]:
            raise RuntimeError("You cannot delete your own account.")
        target = first_or_none(rows(system, "SELECT is_system_admin FROM SYS_USERS WHERE id = ?", (user_id,)))
        if not target:
            raise RuntimeError("User was not found.")
        if target.get("is_system_admin"):
            active_system_admins = int(system.execute("SELECT COUNT(*) FROM SYS_USERS WHERE is_system_admin = 1 AND is_active = 1 AND deleted_at IS NULL").fetchone()[0])
            if active_system_admins <= 1:
                raise RuntimeError("At least one active System Admin must remain.")
        system.execute("UPDATE SYS_USERS SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ?", (now, now, user_id))
        audit(system, actor, "delete_user", "user", user_id)
        system.commit()
        return {"id": user_id}

    if action == "user_reset":
        user_id = str(data.get("id") or "")
        target = first_or_none(rows(system, "SELECT employee_id FROM SYS_USERS WHERE id = ?", (user_id,)))
        if not target:
            raise RuntimeError("User was not found.")
        system.execute("UPDATE SYS_USERS SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?", (password_hash(str(target.get("employee_id") or "")), now, user_id))
        audit(system, actor, "reset_user_password", "user", user_id)
        system.commit()
        return {"id": user_id}

    if action == "user_set_role":
        user_id = str(data.get("id") or "")
        role = str(data.get("role") or "user")
        if role not in {"user", "admin", "system_admin"}:
            raise RuntimeError("Unsupported role.")
        if role == "system_admin" or actor["selected_role"] == "system_admin":
            require_system_admin(actor)
        system_admin_count = int(system.execute("SELECT COUNT(*) FROM SYS_USERS WHERE is_system_admin = 1 AND is_active = 1").fetchone()[0])
        target_is_system = bool(system.execute("SELECT is_system_admin FROM SYS_USERS WHERE id = ?", (user_id,)).fetchone()[0])
        if target_is_system and role != "system_admin" and system_admin_count <= 1:
            raise RuntimeError("At least one active System Admin must remain.")
        system.execute("UPDATE SYS_USERS SET is_admin = ?, is_system_admin = ?, updated_at = ? WHERE id = ?", (int(role in {"admin", "system_admin"}), int(role == "system_admin"), now, user_id))
        audit(system, actor, "set_user_role", "user", user_id, {"role": role})
        system.commit()
        return {"id": user_id, "role": role}

    if action == "team_create":
        team_id = str(uuid.uuid4())
        system.execute("INSERT INTO SYS_TEAMS (id, name, description, parent_team_id, manager_user_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", (team_id, str(data.get("name") or "New Team").strip(), data.get("description"), data.get("parent_team_id") or None, data.get("manager_user_id") or None, now, now))
        audit(system, actor, "create_team", "team", team_id)
        system.commit()
        return {"id": team_id}

    if action == "team_update":
        team_id = str(data.get("id") or "")
        fields = {key: data[key] for key in ("name", "description", "parent_team_id", "manager_user_id", "is_active") if key in data}
        if not fields:
            raise RuntimeError("No team fields were supplied.")
        assignments = ", ".join(f'"{key}" = ?' for key in fields)
        system.execute(f'UPDATE SYS_TEAMS SET {assignments}, updated_at = ? WHERE id = ?', [*fields.values(), now, team_id])
        audit(system, actor, "update_team", "team", team_id, {"fields": list(fields)})
        system.commit()
        return {"id": team_id}

    if action == "team_delete":
        require_system_admin(actor)
        team_id = str(data.get("id") or "")
        if system.execute("SELECT 1 FROM SYS_USERS WHERE team_id = ? AND deleted_at IS NULL LIMIT 1", (team_id,)).fetchone():
            raise RuntimeError("Move or remove team members before deleting the team.")
        system.execute("DELETE FROM SYS_TEAMS WHERE id = ?", (team_id,))
        audit(system, actor, "delete_team", "team", team_id)
        system.commit()
        return {"id": team_id}

    if action == "resource_update":
        resource_identity, resource_record_id, resource = resolve_resource_record(
            system, data.get("resource_id") or data.get("id")
        )
        fields = {key: data[key] for key in ("name", "description", "category", "is_public", "is_active") if key in data}
        if not fields:
            raise RuntimeError("No resource fields were supplied.")
        assignments = ", ".join(f'"{key}" = ?' for key in fields)
        system.execute(f'UPDATE SYS_RESOURCES SET {assignments}, updated_at = ? WHERE "{resource_identity}" = ?', [*fields.values(), now, resource_record_id])
        public_id = resource.get("resource_id") or resource_record_id
        audit(system, actor, "update_resource", "resource", public_id, {"fields": list(fields)})
        system.commit()
        return {"id": resource_record_id, "resource_id": public_id}

    if action == "resource_delete":
        require_system_admin(actor)
        resource_identity, resource_record_id, resource = resolve_resource_record(
            system, data.get("resource_id") or data.get("id")
        )
        permission_column, _ = permission_subject_column(system)
        permission_reference = permission_resource_reference(system, permission_column, resource_record_id, resource)
        system.execute(f"DELETE FROM SYS_RESOURCE_PERMISSIONS WHERE {permission_column} = ?", (permission_reference,))
        system.execute(f'DELETE FROM SYS_RESOURCES WHERE "{resource_identity}" = ?', (resource_record_id,))
        public_id = resource.get("resource_id") or resource_record_id
        audit(system, actor, "delete_resource", "resource", public_id)
        system.commit()
        return {"id": resource_record_id, "resource_id": public_id}

    if action == "dictionary_create":
        dictionary_name = str(data.get("name") or "").strip()
        dictionary_key = str(data.get("dictionary_key") or "").strip()
        if not dictionary_name:
            raise RuntimeError("Dictionary name is required.")
        if not dictionary_key:
            dictionary_key = "_".join(part for part in dictionary_name.lower().replace("-", " ").split() if part)
        if system.execute("SELECT 1 FROM SYS_DICTIONARIES WHERE dictionary_key = ? LIMIT 1", (dictionary_key,)).fetchone():
            raise RuntimeError("Dictionary key already exists.")
        cursor = system.execute(
            "INSERT INTO SYS_DICTIONARIES (dictionary_key, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (dictionary_key, dictionary_name, str(data.get("description") or "").strip() or None, int(bool(data.get("is_active", True))), now, now),
        )
        dictionary_id = cursor.lastrowid
        audit(system, actor, "create_dictionary", "dictionary", dictionary_id)
        system.commit()
        return {"id": dictionary_id, "dictionary_key": dictionary_key}

    if action == "dictionary_update":
        dictionary = dictionary_by_reference(system, data.get("id") or data.get("dictionary_key"))
        fields = {key: data[key] for key in ("name", "description", "is_active") if key in data}
        if not fields:
            raise RuntimeError("No dictionary fields were supplied.")
        fields["updated_at"] = now
        assignments = ", ".join(f'"{key}" = ?' for key in fields)
        system.execute(f'UPDATE SYS_DICTIONARIES SET {assignments} WHERE id = ?', [*fields.values(), dictionary["id"]])
        audit(system, actor, "update_dictionary", "dictionary", dictionary["id"])
        system.commit()
        return {"id": dictionary["id"], "dictionary_key": dictionary["dictionary_key"]}

    if action == "dictionary_item_reorder":
        dictionary = dictionary_by_reference(system, data.get("dictionary_id") or data.get("dictionary_key"))
        item_ids = data.get("item_ids") if isinstance(data.get("item_ids"), list) else []
        for index, item_id in enumerate(item_ids, start=1):
            system.execute(
                "UPDATE SYS_DICTIONARY_ITEMS SET sort_order = ?, updated_at = ? WHERE id = ? AND dictionary_id = ?",
                (index, now, item_id, dictionary["id"]),
            )
        audit(system, actor, "reorder_dictionary_items", "dictionary", dictionary["id"])
        system.commit()
        return {"id": dictionary["id"]}

    if action in {"permission_set", "permission_clear"}:
        resource_column, _ = permission_subject_column(system)
        _, resource_record_id, resource = resolve_resource_record(system, data.get("resource_id"))
        permission_reference = permission_resource_reference(system, resource_column, resource_record_id, resource)
        user_id = data.get("user_id") or None
        team_id = data.get("team_id") or None
        if bool(user_id) == bool(team_id):
            raise RuntimeError("Provide a resource and exactly one user or team subject.")
        if action == "permission_clear":
            require_system_admin(actor)
            where_subject = "user_id = ?" if user_id else "team_id = ?"
            system.execute(f"DELETE FROM SYS_RESOURCE_PERMISSIONS WHERE {resource_column} = ? AND {where_subject}", (permission_reference, user_id or team_id))
        else:
            level = data.get("permission_level", data.get("permission"))
            if isinstance(level, list):
                level = sum(PERMISSIONS.get(str(item), 0) for item in level)
            if isinstance(level, str) and not level.isdigit():
                level = PERMISSIONS.get(level, 0)
            level = int(level or 0)
            if not level:
                raise RuntimeError("Select at least one permission.")
            if user_id:
                system.execute(f"DELETE FROM SYS_RESOURCE_PERMISSIONS WHERE {resource_column} = ? AND user_id = ?", (permission_reference, user_id))
            else:
                system.execute(f"DELETE FROM SYS_RESOURCE_PERMISSIONS WHERE {resource_column} = ? AND team_id = ?", (permission_reference, team_id))
            system.execute(
                f"INSERT INTO SYS_RESOURCE_PERMISSIONS (id, {resource_column}, user_id, team_id, permission_level, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), permission_reference, user_id, team_id, level, actor["id"], now, now),
            )
        public_id = resource.get("resource_id") or resource_record_id
        audit(system, actor, action, "resource_permission", public_id, {"user_id": user_id, "team_id": team_id})
        system.commit()
        return {"id": resource_record_id, "resource_id": public_id}

    if action == "permission_matrix_save":
        subject_type = str(data.get("subject_type") or "").strip().lower()
        subject_id = data.get("subject_id")
        if subject_type not in {"team", "user"} or subject_id in (None, ""):
            raise RuntimeError("A valid permission subject is required.")
        subject_column = "team_id" if subject_type == "team" else "user_id"
        subject_table = "SYS_TEAMS" if subject_type == "team" else "SYS_USERS"
        if system.execute(f'SELECT 1 FROM "{subject_table}" WHERE id = ? LIMIT 1', (subject_id,)).fetchone() is None:
            raise RuntimeError("The selected permission subject was not found.")
        assignments = data.get("assignments") if isinstance(data.get("assignments"), list) else []
        resource_column, _ = permission_subject_column(system)
        created = updated = deleted = 0
        for assignment in assignments:
            if not isinstance(assignment, dict):
                continue
            _, resource_record_id, resource = resolve_resource_record(system, assignment.get("resource_id"))
            reference = permission_resource_reference(system, resource_column, resource_record_id, resource)
            level = assignment.get("permission_level")
            if level in (None, "", 0, "0"):
                require_system_admin(actor)
                system.execute(
                    f"DELETE FROM SYS_RESOURCE_PERMISSIONS WHERE {resource_column} = ? AND {subject_column} = ?",
                    (reference, subject_id),
                )
                deleted += system.execute("SELECT changes()").fetchone()[0]
                continue
            level = int(level)
            if level < 1 or level > 127:
                raise RuntimeError("Invalid permission type selection.")
            existing = system.execute(
                f"SELECT id, permission_level FROM SYS_RESOURCE_PERMISSIONS WHERE {resource_column} = ? AND {subject_column} = ? LIMIT 1",
                (reference, subject_id),
            ).fetchone()
            if existing:
                if int(existing["permission_level"]) != level:
                    system.execute("UPDATE SYS_RESOURCE_PERMISSIONS SET permission_level = ?, updated_at = ? WHERE id = ?", (level, now, existing["id"]))
                    updated += 1
            else:
                system.execute(
                    f"INSERT INTO SYS_RESOURCE_PERMISSIONS ({resource_column}, user_id, team_id, permission_level, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (reference, subject_id if subject_type == "user" else None, subject_id if subject_type == "team" else None, level, actor["id"], now, now),
                )
                created += 1
        audit(system, actor, "update_permission_matrix", "permission_subject", subject_id, {"subject_type": subject_type, "created": created, "updated": updated, "deleted": deleted})
        system.commit()
        return {"created": created, "updated": updated, "deleted": deleted}

    if action == "dictionary_item_upsert":
        dictionary_id = str(data.get("dictionary_id") or "")
        item_id = str(data.get("id") or "")
        values = {
            "dictionary_id": dictionary_id,
            "item_code": str(data.get("item_code") or data.get("code") or "").strip(),
            "label": str(data.get("label") or "").strip(),
            "sort_order": int(data.get("sort_order") or 0),
            "is_active": int(bool(data.get("is_active", True))),
            "metadata_json": json.dumps(data.get("metadata") or {}, ensure_ascii=False),
            "updated_at": now,
        }
        if not values["label"]:
            raise RuntimeError("Dictionary item label is required.")
        if item_id:
            assignments = ", ".join(f'"{key}" = ?' for key in values if key != "dictionary_id")
            system.execute(f'UPDATE SYS_DICTIONARY_ITEMS SET {assignments} WHERE id = ? AND dictionary_id = ?', [*[values[key] for key in values if key != "dictionary_id"], item_id, dictionary_id])
        else:
            item_id = str(uuid.uuid4())
            system.execute("INSERT INTO SYS_DICTIONARY_ITEMS (id, dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (item_id, dictionary_id, values["item_code"], values["label"], values["sort_order"], values["is_active"], values["metadata_json"], now, now))
        audit(system, actor, "upsert_dictionary_item", "dictionary_item", item_id)
        system.commit()
        return {"id": item_id}

    if action in {"dictionary_item_disable", "dictionary_item_delete"}:
        item_id = str(data.get("id") or "")
        if action == "dictionary_item_delete":
            require_system_admin(actor)
            system.execute("DELETE FROM SYS_DICTIONARY_ITEMS WHERE id = ?", (item_id,))
        else:
            system.execute("UPDATE SYS_DICTIONARY_ITEMS SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?", (now, item_id))
        audit(system, actor, action, "dictionary_item", item_id)
        system.commit()
        return {"id": item_id}

    if action == "holiday_calendar_create":
        require_admin(actor)
        business = require_business(business)
        if not table_exists(business, "ADMBSHVR_holiday_calendars"):
            raise RuntimeError("Holiday calendar table is not installed in the business database.")
        year = int(data.get("calendar_year") or 0)
        if year < 2000 or year > 2100:
            raise RuntimeError("Calendar year must be between 2000 and 2100.")
        if business.execute("SELECT 1 FROM ADMBSHVR_holiday_calendars WHERE calendar_year = ? LIMIT 1", (year,)).fetchone():
            raise RuntimeError(f"A holiday calendar already exists for {year}.")
        calendar_id = str(uuid.uuid4())
        insert_with_known_columns(
            business,
            "ADMBSHVR_holiday_calendars",
            {
                "calendar_id": calendar_id,
                "calendar_year": year,
                "label": str(data.get("label") or f"{year} City-Observed Holidays").strip(),
                "notes": str(data.get("notes") or "").strip() or None,
                "created_by_user_id": actor["id"],
                "created_by_name": actor["name"],
                "created_at": now,
                "updated_by_user_id": actor["id"],
                "updated_by_name": actor["name"],
                "updated_at": now,
            },
        )
        business.commit()
        audit(system, actor, "create_holiday_calendar", "holiday_calendar", calendar_id)
        system.commit()
        return {"calendar_id": calendar_id}

    if action == "holiday_calendar_update":
        require_admin(actor)
        business = require_business(business)
        calendar_id = str(data.get("calendar_id") or "")
        fields = columns(business, "ADMBSHVR_holiday_calendars")
        values = {key: data[key] for key in ("label", "notes") if key in data and key in fields}
        if "updated_at" in fields:
            values["updated_at"] = now
        if "updated_by_user_id" in fields:
            values["updated_by_user_id"] = actor["id"]
        if "updated_by_name" in fields:
            values["updated_by_name"] = actor["name"]
        if not values:
            raise RuntimeError("No holiday calendar fields were supplied.")
        assignments = ", ".join(f'"{field}" = ?' for field in values)
        business.execute(f'UPDATE ADMBSHVR_holiday_calendars SET {assignments} WHERE calendar_id = ?', [*values.values(), calendar_id])
        business.commit()
        audit(system, actor, "update_holiday_calendar", "holiday_calendar", calendar_id)
        system.commit()
        return {"calendar_id": calendar_id}

    if action == "holiday_calendar_delete":
        require_admin(actor)
        business = require_business(business)
        calendar_id = str(data.get("calendar_id") or "")
        if table_exists(business, "ADMBSHVR_holidays"):
            business.execute("DELETE FROM ADMBSHVR_holidays WHERE calendar_id = ?", (calendar_id,))
        business.execute("DELETE FROM ADMBSHVR_holiday_calendars WHERE calendar_id = ?", (calendar_id,))
        business.commit()
        audit(system, actor, "delete_holiday_calendar", "holiday_calendar", calendar_id)
        system.commit()
        return {"calendar_id": calendar_id}

    if action == "holiday_validate":
        require_admin(actor)
        business = require_business(business)
        calendar_id = str(data.get("calendar_id") or "")
        calendar = first_or_none(rows(business, "SELECT * FROM ADMBSHVR_holiday_calendars WHERE calendar_id = ?", (calendar_id,)))
        if not calendar:
            raise RuntimeError("Holiday calendar was not found.")
        holidays = rows(business, "SELECT * FROM ADMBSHVR_holidays WHERE calendar_id = ?", (calendar_id,)) if table_exists(business, "ADMBSHVR_holidays") else []
        active = [holiday for holiday in holidays if holiday.get("is_active", 1)]
        issues: list[dict[str, Any]] = []
        if not active:
            issues.append({"severity": "error", "code": "no_active_holidays", "message": "Add at least one active holiday to this calendar.", "holiday_id": None})
        dates: set[str] = set()
        names: set[str] = set()
        for holiday in active:
            holiday_date = str(holiday.get("holiday_date") or "")
            name = str(holiday.get("holiday_name") or "").strip()
            if holiday_date in dates:
                issues.append({"severity": "error", "code": "duplicate_holiday_date", "message": f"More than one active holiday uses {holiday_date}.", "holiday_id": holiday.get("holiday_id")})
            dates.add(holiday_date)
            if name.casefold() in names:
                issues.append({"severity": "error", "code": "duplicate_name", "message": f"{name} is listed more than once.", "holiday_id": holiday.get("holiday_id")})
            names.add(name.casefold())
        return {"valid": not any(issue["severity"] == "error" for issue in issues), "issues": issues, "active_holiday_count": len(active)}

    if action == "holiday_create":
        require_admin(actor)
        business = require_business(business)
        if not table_exists(business, "ADMBSHVR_holidays"):
            raise RuntimeError("Holiday table is not installed in the business database.")
        holiday_id = str(uuid.uuid4())
        data = {**data, "holiday_id": holiday_id, "created_at": now, "updated_at": now, "is_active": int(bool(data.get("is_active", True)))}
        insert_with_known_columns(business, "ADMBSHVR_holidays", data)
        business.commit()
        audit(system, actor, "create_holiday", "holiday", holiday_id)
        system.commit()
        return {"id": holiday_id}

    if action == "holiday_update":
        require_admin(actor)
        business = require_business(business)
        holiday_id = str(data.get("id") or data.get("holiday_id") or "")
        fields = columns(business, "ADMBSHVR_holidays")
        values = {key: data[key] for key in data if key in fields and key not in {"id", "holiday_id"}}
        if "updated_at" in fields:
            values["updated_at"] = now
        if not values:
            raise RuntimeError("No holiday fields were supplied.")
        key = "id" if "id" in fields else "holiday_id"
        assignments = ", ".join(f'"{field}" = ?' for field in values)
        business.execute(f'UPDATE ADMBSHVR_holidays SET {assignments} WHERE "{key}" = ?', [*values.values(), holiday_id])
        business.commit()
        audit(system, actor, "update_holiday", "holiday", holiday_id)
        system.commit()
        return {"id": holiday_id}

    if action == "holiday_delete":
        require_admin(actor)
        business = require_business(business)
        holiday_id = str(data.get("id") or data.get("holiday_id") or "")
        key = "id" if "id" in columns(business, "ADMBSHVR_holidays") else "holiday_id"
        business.execute(f'DELETE FROM ADMBSHVR_holidays WHERE "{key}" = ?', (holiday_id,))
        business.commit()
        audit(system, actor, "delete_holiday", "holiday", holiday_id)
        system.commit()
        return {"id": holiday_id}

    raise RuntimeError(f"Unsupported management action: {action}")


def run(request: dict[str, Any], settings_path: Path) -> dict[str, Any]:
    system_path, business_path = resolve_settings(settings_path)
    system = open_db(system_path)
    # Never fall back to system.db for business writes. A missing local
    # business replica must be reported explicitly instead of risking a
    # write into the system catalog.
    business = open_db(business_path) if business_path.exists() else None
    try:
        actor = actor_record(system, request)
        result = mutate(system, business, actor, request)
        return {"ok": True, "result": result}
    finally:
        if business is not None:
            business.close()
        system.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--portal-settings", required=True, type=Path)
    args = parser.parse_args()
    try:
        request = json.loads(sys.stdin.read() or "{}")
        response = run(request, args.portal_settings)
    except Exception as exc:  # bridge errors must remain JSON parseable by Rust
        response = {"ok": False, "error": str(exc)}
    print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    return 0 if response.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
