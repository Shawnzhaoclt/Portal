from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from portal.app.schema.catalog import BUSINESS_TABLES, register_business_schema
from portal.app.schema.manager import SchemaManager, SchemaManagerError


def _create_business_database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        for table_name, *_ in BUSINESS_TABLES:
            connection.execute(
                f'''CREATE TABLE "{table_name}" (
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    body_json TEXT NOT NULL,
                    geometry BLOB,
                    record_revision TEXT NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    conflict_state TEXT NOT NULL DEFAULT 'none',
                    selected_operation_id TEXT,
                    PRIMARY KEY(entity_type, entity_id)
                )'''
            )


def test_initialize_validate_and_plan(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    register_business_schema(system, business)
    manager = SchemaManager(system, business)

    installed = manager.initialize()
    assert installed["installed_release_id"] == "portal-coordinator-v1"
    assert manager.validate()["valid"] is True
    assert manager.plan()["migrations"] == []

    with sqlite3.connect(business) as connection:
        history = connection.execute("SELECT migration_id, status FROM SW_SCHEMA_MIGRATION_HISTORY").fetchall()
    assert history == [("PORTAL_COORDINATOR_BASELINE_001", "installed")]


def test_validate_detects_missing_registered_field(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    register_business_schema(system, business)
    manager = SchemaManager(system, business)
    manager.initialize()

    with sqlite3.connect(business) as connection:
        connection.execute('DROP TABLE "sw_sync_entity"')
        connection.execute('CREATE TABLE "sw_sync_entity" (entity_type TEXT PRIMARY KEY)')

    with pytest.raises(SchemaManagerError, match="Missing required field"):
        manager.validate()
