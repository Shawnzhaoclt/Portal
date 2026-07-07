from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from backend.app.core.paths import PROJECT_ROOT


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


def _resources_table_allows_current_types(connection) -> bool:
    sql = connection.execute(
        text("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'resources'")
    ).scalar()
    return not sql or all(resource_type in sql for resource_type in ("'report'", "'dataset'", "'service'"))


def _migrate_resource_types() -> None:
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        if _resources_table_allows_current_types(connection):
            return

        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.exec_driver_sql("BEGIN")
        try:
            connection.execute(
                text(
                    """
                    CREATE TABLE resources_new (
                        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
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
                        CONSTRAINT ck_resources_is_public CHECK (is_public IN (0, 1)),
                        CONSTRAINT ck_resources_is_active CHECK (is_active IN (0, 1)),
                        UNIQUE (resource_key),
                        UNIQUE (url)
                    )
                    """
                )
            )
            connection.execute(
                text(
                    """
                    INSERT INTO resources_new (
                        id, resource_key, name, resource_type, url, description, category, icon,
                        is_public, is_active, created_at, updated_at
                    )
                    SELECT
                        id, resource_key, name, resource_type, url, description, category, icon,
                        is_public, is_active, created_at, updated_at
                    FROM resources
                    """
                )
            )
            connection.execute(text("DROP TABLE resources"))
            connection.execute(text("ALTER TABLE resources_new RENAME TO resources"))
            connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_resources_resource_key ON resources (resource_key)"))
            connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_resources_url ON resources (url)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_resources_resource_type ON resources (resource_type)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_resources_is_public ON resources (is_public)"))
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_resources_is_active ON resources (is_active)"))
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
    columns = connection.execute(text(f"PRAGMA table_info({table_name})")).fetchall()
    return any(row[1] == "category" for row in columns)


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
        singular_name = table_name.removesuffix("_featured_resources")
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.exec_driver_sql("BEGIN")
        try:
            connection.execute(
                text(
                    f"""
                    CREATE TABLE {table_name}_new (
                        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                        {owner_column} INTEGER NOT NULL,
                        category VARCHAR NOT NULL,
                        resource_id INTEGER NOT NULL,
                        sort_order INTEGER NOT NULL,
                        created_at VARCHAR DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        updated_at VARCHAR DEFAULT CURRENT_TIMESTAMP NOT NULL,
                        CONSTRAINT ck_{table_name}_category CHECK (
                            category IN ('all', 'dashboard', 'map', 'tab', 'doc', 'report', 'dataset')
                        ),
                        CONSTRAINT uq_{singular_name}_resource_category UNIQUE ({owner_column}, category, resource_id),
                        FOREIGN KEY({owner_column}) REFERENCES {owner_table} (id) ON DELETE CASCADE,
                        FOREIGN KEY(resource_id) REFERENCES resources (id) ON DELETE CASCADE
                    )
                    """
                )
            )
            connection.execute(
                text(
                    f"""
                    INSERT OR IGNORE INTO {table_name}_new (
                        id, {owner_column}, category, resource_id, sort_order, created_at, updated_at
                    )
                    SELECT
                        id, {owner_column}, {category_select}, resource_id, sort_order, created_at, updated_at
                    FROM {table_name}
                    """
                )
            )
            connection.execute(text(f"DROP TABLE {table_name}"))
            connection.execute(text(f"ALTER TABLE {table_name}_new RENAME TO {table_name}"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_{owner_column} ON {table_name} ({owner_column})"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_category ON {table_name} (category)"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table_name}_resource_id ON {table_name} (resource_id)"))
            connection.exec_driver_sql("COMMIT")
        except Exception:
            connection.exec_driver_sql("ROLLBACK")
            raise
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")


def create_management_schema() -> None:
    from backend.app.management import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_resource_types()
    _migrate_featured_resource_categories("user_featured_resources", "user_id", "users")
    _migrate_featured_resource_categories("team_featured_resources", "team_id", "teams")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TRIGGER IF NOT EXISTS prevent_system_admin_delete
                BEFORE DELETE ON users
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
