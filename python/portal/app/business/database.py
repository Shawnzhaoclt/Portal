from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker


def business_database_path() -> Path:
    configured = os.getenv("PORTAL_BUSINESS_DB", "").strip()
    if configured:
        return Path(configured)
    data_root = Path(os.getenv("PORTAL_DATA_ROOT", Path.home() / "AppData" / "Local" / "Portal"))
    return data_root / "data" / "business.db"


BUSINESS_DATABASE_PATH = business_database_path()
BUSINESS_DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)

business_engine = create_engine(
    f"sqlite:///{BUSINESS_DATABASE_PATH.as_posix()}",
    connect_args={"check_same_thread": False},
    future=True,
)


@event.listens_for(business_engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    system_database = os.getenv("PORTAL_SYSTEM_DB", os.getenv("PORTAL_MANAGEMENT_DB", "")).strip()
    if system_database and Path(system_database).is_file():
        cursor.execute("ATTACH DATABASE ? AS system", (system_database,))
    cursor.close()


BusinessSessionLocal = sessionmaker(bind=business_engine, autoflush=False, autocommit=False, future=True)


def get_business_db() -> Iterator[Session]:
    db = BusinessSessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def business_session_scope() -> Iterator[Session]:
    db = BusinessSessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
