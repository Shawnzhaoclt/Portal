from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from backend.app.core.paths import PROJECT_ROOT
from backend.app.management.resource_ids import is_valid_resource_id, random_resource_id


class Base(DeclarativeBase):
    pass


def management_database_path() -> Path:
    configured = os.getenv("PORTAL_MANAGEMENT_DB", "").strip()
    if configured:
        return Path(configured)
    return PROJECT_ROOT / "backend" / "data" / "portal_management.sqlite3"


DATABASE_PATH = management_database_path()
DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    f"sqlite:///{DATABASE_PATH.as_posix()}",
    connect_args={"check_same_thread": False},
    future=True,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


SYSTEM_TABLES = {
    "teams": "SYS_TEAMS",
    "users": "SYS_USERS",
    "resources": "SYS_RESOURCES",
    "resource_permissions": "SYS_RESOURCE_PERMISSIONS",
    "user_featured_resources": "SYS_USER_FEATURED_RESOURCES",
    "team_featured_resources": "SYS_TEAM_FEATURED_RESOURCES",
    "password_reset_tokens": "SYS_PASSWORD_RESET_TOKENS",
    "audit_logs": "SYS_AUDIT_LOGS",
}

RESOURCE_TABLE = SYSTEM_TABLES["resources"]

LEGACY_TABLE_COPY_ORDER = (
    "teams",
    "users",
    "resources",
    "resource_permissions",
    "user_featured_resources",
    "team_featured_resources",
    "password_reset_tokens",
    "audit_logs",
)

LEGACY_TABLE_COPY_COLUMNS = {
    "teams": (
        "id",
        "name",
        "description",
        "parent_team_id",
        "manager_user_id",
        "is_active",
        "created_at",
        "updated_at",
    ),
    "users": (
        "id",
        "username",
        "first_name",
        "last_name",
        "email",
        "employee_id",
        "team_id",
        "password_hash",
        "is_active",
        "is_system_admin",
        "is_admin",
        "must_change_password",
        "failed_login_count",
        "locked_until",
        "last_login_at",
        "password_changed_at",
        "deleted_at",
        "deleted_by_user_id",
        "created_at",
        "updated_at",
    ),
    "resources": (
        "id",
        "resource_id",
        "resource_key",
        "name",
        "resource_type",
        "url",
        "description",
        "category",
        "icon",
        "is_public",
        "is_active",
        "created_at",
        "updated_at",
    ),
    "resource_permissions": (
        "id",
        "resource_id",
        "user_id",
        "team_id",
        "permission_level",
        "created_by_user_id",
        "created_at",
        "updated_at",
    ),
    "user_featured_resources": (
        "id",
        "user_id",
        "category",
        ("resource_id", "resource_record_id"),
        "sort_order",
        "created_at",
        "updated_at",
    ),
    "team_featured_resources": (
        "id",
        "team_id",
        "category",
        ("resource_id", "resource_record_id"),
        "sort_order",
        "created_at",
        "updated_at",
    ),
    "password_reset_tokens": (
        "id",
        "user_id",
        "token_hash",
        "expires_at",
        "used_at",
        "created_by_user_id",
        "created_at",
    ),
    "audit_logs": (
        "id",
        "actor_user_id",
        "action",
        "target_type",
        "target_id",
        "details_json",
        "ip_address",
        "user_agent",
        "created_at",
    ),
}


def _quote_identifier(identifier: str) -> str:
    return f'"{identifier.replace(chr(34), chr(34) * 2)}"'


def _table_exists(connection, table_name: str) -> bool:
    return bool(
        connection.execute(
            text("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = :table_name"),
            {"table_name": table_name},
        ).first()
    )


def _table_columns(connection, table_name: str) -> set[str]:
    rows = connection.execute(text(f"PRAGMA table_info({_quote_identifier(table_name)})")).fetchall()
    return {str(row[1]) for row in rows}


def _table_count(connection, table_name: str) -> int:
    return int(connection.execute(text(f"SELECT COUNT(*) FROM {_quote_identifier(table_name)}")).scalar() or 0)


def _create_resource_indexes(connection, table_name: str = RESOURCE_TABLE) -> None:
    quoted_table = _quote_identifier(table_name)
    connection.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table_name}_resource_id ON {quoted_table} (resource_id)"))
    connection.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table_name}_resource_key ON {quoted_table} (resource_key)"))
    connection.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table_name}_url ON {quoted_table} (url)"))
    connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_resource_type ON {quoted_table} (resource_type)"))
    connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_is_public ON {quoted_table} (is_public)"))
    connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_is_active ON {quoted_table} (is_active)"))


def _create_resource_permission_indexes(connection, table_name: str = "SYS_RESOURCE_PERMISSIONS") -> None:
    if not _table_exists(connection, table_name):
        return
    quoted_table = _quote_identifier(table_name)
    connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_resource_id ON {quoted_table} (resource_id)"))
    connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_user_id ON {quoted_table} (user_id)"))
    connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_team_id ON {quoted_table} (team_id)"))


def _ensure_resource_ids(connection, table_name: str = RESOURCE_TABLE) -> None:
    if not _table_exists(connection, table_name):
        return

    quoted_table = _quote_identifier(table_name)
    if "resource_id" not in _table_columns(connection, table_name):
        connection.execute(text(f"ALTER TABLE {quoted_table} ADD COLUMN resource_id VARCHAR"))

    rows = connection.execute(
        text(f"SELECT id, resource_type, resource_id FROM {quoted_table} ORDER BY id")
    ).mappings().all()

    assigned_ids: set[str] = set()
    updates: list[dict[str, str | int]] = []
    for row in rows:
        current_id = row["resource_id"]
        resource_type = row["resource_type"]
        if is_valid_resource_id(current_id, resource_type) and current_id not in assigned_ids:
            assigned_ids.add(current_id)
            continue

        next_id = random_resource_id(assigned_ids, resource_type)
        assigned_ids.add(next_id)
        updates.append({"id": row["id"], "resource_id": next_id})

    for update in updates:
        connection.execute(
            text(f"UPDATE {quoted_table} SET resource_id = :resource_id WHERE id = :id"),
            update,
        )

    _create_resource_indexes(connection, table_name)


def _resources_table_allows_current_types(connection, table_name: str = RESOURCE_TABLE) -> bool:
    sql = connection.execute(
        text("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = :table_name"),
        {"table_name": table_name},
    ).scalar()
    return not sql or all(resource_type in sql for resource_type in ("'report'", "'dataset'", "'service'"))


def _migrate_resource_types() -> None:
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        if not _table_exists(connection, RESOURCE_TABLE):
            return
        if _resources_table_allows_current_types(connection):
            return

        _ensure_resource_ids(connection, RESOURCE_TABLE)
        quoted_table = _quote_identifier(RESOURCE_TABLE)
        replacement_table = f"{RESOURCE_TABLE}_NEW"
        quoted_replacement = _quote_identifier(replacement_table)
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.exec_driver_sql("BEGIN")
        try:
            connection.execute(
                text(
                    f"""
                    DROP TABLE IF EXISTS {quoted_replacement}
                    """
                )
            )
            connection.execute(
                text(
                    f"""
                    CREATE TABLE {quoted_replacement} (
                        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                        resource_id VARCHAR(8) NOT NULL,
                        resource_key VARCHAR NOT NULL,
                        name VARCHAR NOT NULL,
                        resource_type VARCHAR NOT NULL,
                        url VARCHAR NOT NULL,
                        description TEXT,
                        category VARCHAR,
                        icon VARCHAR,
                        is_public INTEGER NOT NULL,
                        is_active INTEGER NOT NULL,
                        created_at VARCHAR DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        updated_at VARCHAR DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        CONSTRAINT ck_resources_type CHECK (resource_type IN ('dashboard', 'map', 'tab', 'doc', 'report', 'dataset', 'service', 'admin', 'api')),
                        CONSTRAINT ck_resources_resource_id_format CHECK (resource_id GLOB '[A-Z][A-Z][A-Z][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]'),
                        CONSTRAINT ck_resources_is_public CHECK (is_public IN (0, 1)),
                        CONSTRAINT ck_resources_is_active CHECK (is_active IN (0, 1)),
                        UNIQUE (resource_id),
                        UNIQUE (resource_key),
                        UNIQUE (url)
                    )
                    """
                )
            )
            connection.execute(
                text(
                    f"""
                    INSERT INTO {quoted_replacement} (
                        id, resource_id, resource_key, name, resource_type, url, description, category, icon,
                        is_public, is_active, created_at, updated_at
                    )
                    SELECT
                        id, resource_id, resource_key, name, resource_type, url, description, category, icon,
                        is_public, is_active, created_at, updated_at
                    FROM {quoted_table}
                    """
                )
            )
            connection.execute(text(f"DROP TABLE {quoted_table}"))
            connection.execute(text(f"ALTER TABLE {quoted_replacement} RENAME TO {quoted_table}"))
            _create_resource_indexes(connection, RESOURCE_TABLE)
            connection.exec_driver_sql("COMMIT")
        except Exception:
            connection.exec_driver_sql("ROLLBACK")
            raise
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")


def _resources_table_has_column(connection, column_name: str) -> bool:
    return column_name in _table_columns(connection, RESOURCE_TABLE)


def _migrate_resource_ids() -> None:
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        _ensure_resource_ids(connection, RESOURCE_TABLE)


def _copy_legacy_resource_permissions(connection) -> None:
    legacy_table = "resource_permissions"
    target_table = SYSTEM_TABLES[legacy_table]
    if not _table_exists(connection, legacy_table) or not _table_exists(connection, target_table):
        return
    if _table_count(connection, target_table) > 0:
        return
    if _table_count(connection, legacy_table) == 0:
        return

    legacy_columns = _table_columns(connection, legacy_table)
    target_columns = _table_columns(connection, target_table)
    required_legacy = {"id", "resource_id", "user_id", "team_id", "permission_level", "created_by_user_id", "created_at", "updated_at"}
    required_target = {"id", "resource_id", "user_id", "team_id", "permission_level", "created_by_user_id", "created_at", "updated_at"}
    if not required_legacy.issubset(legacy_columns) or not required_target.issubset(target_columns):
        raise RuntimeError("Cannot migrate resource_permissions; missing columns for resource ID translation.")

    connection.execute(
        text(
            f"""
            INSERT OR IGNORE INTO {_quote_identifier(target_table)} (
                id, resource_id, user_id, team_id, permission_level, created_by_user_id, created_at, updated_at
            )
            SELECT
                p.id, r.resource_id, p.user_id, p.team_id, p.permission_level, p.created_by_user_id,
                p.created_at, p.updated_at
            FROM {_quote_identifier(legacy_table)} p
            INNER JOIN {_quote_identifier(RESOURCE_TABLE)} r
                ON r.id = p.resource_id
            WHERE r.resource_id IS NOT NULL
            """
        )
    )


def _copy_legacy_table(connection, legacy_table: str) -> None:
    if legacy_table == "resource_permissions":
        _copy_legacy_resource_permissions(connection)
        return

    target_table = SYSTEM_TABLES[legacy_table]
    if not _table_exists(connection, legacy_table) or not _table_exists(connection, target_table):
        return
    if _table_count(connection, target_table) > 0:
        return
    if _table_count(connection, legacy_table) == 0:
        return

    required_columns = LEGACY_TABLE_COPY_COLUMNS[legacy_table]
    column_pairs = [
        column if isinstance(column, tuple) else (column, column)
        for column in required_columns
    ]
    legacy_columns = _table_columns(connection, legacy_table)
    target_columns = _table_columns(connection, target_table)
    missing_columns = [
        f"{source_column}->{target_column}"
        for source_column, target_column in column_pairs
        if source_column not in legacy_columns or target_column not in target_columns
    ]
    if missing_columns:
        missing = ", ".join(missing_columns)
        raise RuntimeError(f"Cannot migrate {legacy_table}; missing columns: {missing}")

    target_column_list = ", ".join(_quote_identifier(target_column) for _, target_column in column_pairs)
    source_column_list = ", ".join(_quote_identifier(source_column) for source_column, _ in column_pairs)
    connection.execute(
        text(
            f"""
            INSERT OR IGNORE INTO {_quote_identifier(target_table)} ({target_column_list})
            SELECT {source_column_list}
            FROM {_quote_identifier(legacy_table)}
            """
        )
    )


def _drop_legacy_tables_when_copied(connection) -> None:
    for legacy_table in reversed(LEGACY_TABLE_COPY_ORDER):
        target_table = SYSTEM_TABLES[legacy_table]
        if not _table_exists(connection, legacy_table) or not _table_exists(connection, target_table):
            continue
        legacy_count = _table_count(connection, legacy_table)
        target_count = _table_count(connection, target_table)
        if legacy_count > 0 and target_count < legacy_count:
            continue
        connection.execute(text(f"DROP TABLE {_quote_identifier(legacy_table)}"))


def _migrate_legacy_management_tables() -> None:
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        if not any(_table_exists(connection, legacy_table) for legacy_table in LEGACY_TABLE_COPY_ORDER):
            return

        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.exec_driver_sql("BEGIN")
        try:
            _ensure_resource_ids(connection, "resources")
            for legacy_table in LEGACY_TABLE_COPY_ORDER:
                _copy_legacy_table(connection, legacy_table)
            _drop_legacy_tables_when_copied(connection)
            connection.exec_driver_sql("COMMIT")
        except Exception:
            connection.exec_driver_sql("ROLLBACK")
            raise
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")


def _migrate_resource_link_column_names() -> None:
    rename_targets = (
        "SYS_USER_FEATURED_RESOURCES",
        "SYS_TEAM_FEATURED_RESOURCES",
    )
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        for table_name in rename_targets:
            if not _table_exists(connection, table_name):
                continue
            columns = _table_columns(connection, table_name)
            if "resource_record_id" in columns or "resource_id" not in columns:
                continue
            connection.execute(
                text(
                    f"""
                    ALTER TABLE {_quote_identifier(table_name)}
                    RENAME COLUMN resource_id TO resource_record_id
                    """
                )
            )
            quoted_table = _quote_identifier(table_name)
            connection.execute(
                text(
                    f"CREATE INDEX IF NOT EXISTS ix_{table_name}_resource_record_id ON {quoted_table} (resource_record_id)"
                )
            )


def _resource_permission_has_public_resource_fk(connection, table_name: str = "SYS_RESOURCE_PERMISSIONS") -> bool:
    if not _table_exists(connection, table_name):
        return False
    rows = connection.execute(text(f"PRAGMA foreign_key_list({_quote_identifier(table_name)})")).fetchall()
    return any(str(row[2]) == RESOURCE_TABLE and str(row[3]) == "resource_id" and str(row[4]) == "resource_id" for row in rows)


def _permission_resource_value_sql(connection, table_name: str) -> tuple[str, str]:
    columns = _table_columns(connection, table_name)
    quoted_table = _quote_identifier(table_name)
    quoted_resources = _quote_identifier(RESOURCE_TABLE)
    if "resource_record_id" in columns:
        return "r.resource_id", f"INNER JOIN {quoted_resources} r ON r.id = p.resource_record_id"

    if "resource_id" not in columns:
        raise RuntimeError(f"Cannot migrate {table_name}; no resource link column was found.")

    total_count = _table_count(connection, table_name)
    public_match_count = int(
        connection.execute(
            text(
                f"""
                SELECT COUNT(*)
                FROM {quoted_table} p
                INNER JOIN {quoted_resources} r
                    ON r.resource_id = p.resource_id
                """
            )
        ).scalar()
        or 0
    )
    if total_count == 0 or public_match_count == total_count:
        return "p.resource_id", ""
    return "r.resource_id", f"INNER JOIN {quoted_resources} r ON r.id = CAST(p.resource_id AS INTEGER)"


def _migrate_resource_permission_resource_ids() -> None:
    table_name = "SYS_RESOURCE_PERMISSIONS"
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        if not _table_exists(connection, table_name):
            return
        columns = _table_columns(connection, table_name)
        if "resource_record_id" not in columns and _resource_permission_has_public_resource_fk(connection, table_name):
            _create_resource_permission_indexes(connection, table_name)
            return

        quoted_table = _quote_identifier(table_name)
        new_table = f"{table_name}_NEW"
        quoted_new_table = _quote_identifier(new_table)
        resource_value_sql, resource_join_sql = _permission_resource_value_sql(connection, table_name)

        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.exec_driver_sql("BEGIN")
        try:
            connection.execute(text(f"DROP TABLE IF EXISTS {quoted_new_table}"))
            connection.execute(
                text(
                    f"""
                    CREATE TABLE {quoted_new_table} (
                        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                        resource_id VARCHAR(8) NOT NULL,
                        user_id INTEGER,
                        team_id INTEGER,
                        permission_level INTEGER NOT NULL,
                        created_by_user_id INTEGER,
                        created_at VARCHAR DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        updated_at VARCHAR DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        CONSTRAINT ck_resource_permissions_one_subject CHECK (
                            (user_id IS NOT NULL AND team_id IS NULL)
                            OR
                            (user_id IS NULL AND team_id IS NOT NULL)
                        ),
                        CONSTRAINT ck_resource_permissions_level CHECK (permission_level IN (10, 20, 30, 40)),
                        CONSTRAINT uq_resource_permission_user UNIQUE (resource_id, user_id),
                        CONSTRAINT uq_resource_permission_team UNIQUE (resource_id, team_id),
                        FOREIGN KEY(resource_id) REFERENCES {RESOURCE_TABLE} (resource_id) ON DELETE CASCADE ON UPDATE CASCADE,
                        FOREIGN KEY(user_id) REFERENCES SYS_USERS (id) ON DELETE CASCADE,
                        FOREIGN KEY(team_id) REFERENCES SYS_TEAMS (id) ON DELETE CASCADE,
                        FOREIGN KEY(created_by_user_id) REFERENCES SYS_USERS (id) ON DELETE SET NULL
                    )
                    """
                )
            )
            connection.execute(
                text(
                    f"""
                    INSERT OR IGNORE INTO {quoted_new_table} (
                        id, resource_id, user_id, team_id, permission_level, created_by_user_id, created_at, updated_at
                    )
                    SELECT
                        p.id, {resource_value_sql}, p.user_id, p.team_id, p.permission_level,
                        p.created_by_user_id, p.created_at, p.updated_at
                    FROM {quoted_table} p
                    {resource_join_sql}
                    WHERE {resource_value_sql} IS NOT NULL
                    """
                )
            )
            connection.execute(text(f"DROP TABLE {quoted_table}"))
            connection.execute(text(f"ALTER TABLE {quoted_new_table} RENAME TO {quoted_table}"))
            _create_resource_permission_indexes(connection, table_name)
            connection.exec_driver_sql("COMMIT")
        except Exception:
            connection.exec_driver_sql("ROLLBACK")
            raise
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")


def _featured_table_uses_source_categories(connection, table_name: str) -> bool:
    sql = connection.execute(
        text("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = :table_name"),
        {"table_name": table_name},
    ).scalar()
    return not sql or (
        "category" in sql
        and "'dashboard'" in sql
        and "'report'" in sql
        and "'dataset'" in sql
        and "'api'" not in sql
        and "'dashboards'" not in sql
    )


def _featured_table_has_category(connection, table_name: str) -> bool:
    return "category" in _table_columns(connection, table_name)


def _migrate_featured_resource_categories(table_name: str, owner_column: str, owner_table: str) -> None:
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        if _featured_table_uses_source_categories(connection, table_name):
            return

        has_category = _featured_table_has_category(connection, table_name)
        category_select = (
            """
            CASE category
              WHEN 'dashboards' THEN 'dashboard'
              WHEN 'maps' THEN 'map'
              WHEN 'tables' THEN 'tab'
              WHEN 'documents' THEN 'doc'
              WHEN 'datasets' THEN 'dataset'
              WHEN 'dataset' THEN 'dataset'
              WHEN 'dashboard' THEN 'dashboard'
              WHEN 'map' THEN 'map'
              WHEN 'tab' THEN 'tab'
              WHEN 'doc' THEN 'doc'
              WHEN 'report' THEN 'report'
              WHEN 'api' THEN 'all'
              WHEN 'service' THEN 'all'
              ELSE 'all'
            END
            """
            if has_category
            else "'all'"
        )
        singular_name = table_name.lower().removeprefix("sys_").removesuffix("_featured_resources")
        quoted_table = _quote_identifier(table_name)
        new_table = f"{table_name}_NEW"
        quoted_new_table = _quote_identifier(new_table)
        resource_link_column = "resource_record_id" if "resource_record_id" in _table_columns(connection, table_name) else "resource_id"
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.exec_driver_sql("BEGIN")
        try:
            connection.execute(
                text(
                    f"""
                    DROP TABLE IF EXISTS {quoted_new_table}
                    """
                )
            )
            connection.execute(
                text(
                    f"""
                    CREATE TABLE {quoted_new_table} (
                        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                        {owner_column} INTEGER NOT NULL,
                        category VARCHAR NOT NULL,
                        resource_record_id INTEGER NOT NULL,
                        sort_order INTEGER NOT NULL,
                        created_at VARCHAR DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        updated_at VARCHAR DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        CONSTRAINT ck_{table_name}_category CHECK (
                            category IN ('all', 'dashboard', 'map', 'tab', 'doc', 'report', 'dataset')
                        ),
                        CONSTRAINT uq_{singular_name}_resource_category UNIQUE ({owner_column}, category, resource_record_id),
                        FOREIGN KEY({owner_column}) REFERENCES {owner_table} (id) ON DELETE CASCADE,
                        FOREIGN KEY(resource_record_id) REFERENCES {RESOURCE_TABLE} (id) ON DELETE CASCADE
                    )
                    """
                )
            )
            connection.execute(
                text(
                    f"""
                    INSERT OR IGNORE INTO {quoted_new_table} (
                        id, {owner_column}, category, resource_record_id, sort_order, created_at, updated_at
                    )
                    SELECT
                        id, {owner_column}, {category_select}, {resource_link_column}, sort_order, created_at, updated_at
                    FROM {quoted_table}
                    """
                )
            )
            connection.execute(text(f"DROP TABLE {quoted_table}"))
            connection.execute(text(f"ALTER TABLE {quoted_new_table} RENAME TO {quoted_table}"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_{owner_column} ON {quoted_table} ({owner_column})"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_category ON {quoted_table} (category)"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_resource_record_id ON {quoted_table} (resource_record_id)"))
            connection.exec_driver_sql("COMMIT")
        except Exception:
            connection.exec_driver_sql("ROLLBACK")
            raise
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")


def create_management_schema() -> None:
    from backend.app.management import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_legacy_management_tables()
    _migrate_resource_types()
    _migrate_resource_ids()
    _migrate_resource_permission_resource_ids()
    _migrate_resource_link_column_names()
    _migrate_featured_resource_categories("SYS_USER_FEATURED_RESOURCES", "user_id", "SYS_USERS")
    _migrate_featured_resource_categories("SYS_TEAM_FEATURED_RESOURCES", "team_id", "SYS_TEAMS")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TRIGGER IF NOT EXISTS prevent_sys_system_admin_delete
                BEFORE DELETE ON SYS_USERS
                WHEN OLD.is_system_admin = 1
                BEGIN
                  SELECT RAISE(ABORT, 'system admin users cannot be deleted');
                END
                """
            )
        )


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
