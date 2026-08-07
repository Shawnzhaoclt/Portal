from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import pytest

from portal.app.schema.catalog import (
    ALEMBIC_SCHEMA_HANDLER,
    BUSINESS_TABLES,
    COMPATIBLE_SQLITE_HANDLER,
    apply_compatible_schema_draft,
    apply_schema_draft,
    dated_migration_id,
    dated_release_id,
    ensure_compatible_schema_transition,
    prepare_schema_migration_operations,
    register_business_schema,
    registered_business_catalog,
    schema_draft_catalog_for_registration,
)
from portal.app.schema.manager import SchemaManager, SchemaManagerError
from portal.app.sync.local_store import LocalStore
from portal.app.sync.physical_entities import (
    HOLIDAY_ENTITY_TYPE,
    WEEKLY_TIME_TABLE_RENAMES,
    all_physical_specs,
    initialize_physical_schema,
)


def _create_business_database(path: Path) -> None:
    LocalStore(path).initialize()


def test_dated_release_names_are_descriptive_and_sortable() -> None:
    published_at = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)

    assert dated_release_id(published_at) == "portal-coordinator-2026-215"
    assert dated_migration_id(published_at) == "PORTAL_COORDINATOR_2026_215"
    assert "v1" not in dated_release_id(published_at).lower()
    assert "v2" not in dated_release_id(published_at).lower()


def test_initialize_validate_and_plan(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    published_at = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)
    register_business_schema(system, business, registered_at=published_at)
    manager = SchemaManager(system, business)

    installed = manager.initialize()
    assert installed["installed_release_id"] == dated_release_id(published_at)
    assert manager.validate()["valid"] is True
    assert manager.plan()["migrations"] == []

    with sqlite3.connect(business) as connection:
        history = connection.execute("SELECT migration_id, status FROM SW_SCHEMA_MIGRATION_HISTORY").fetchall()
    assert history == [(dated_migration_id(published_at), "installed")]
    with sqlite3.connect(system) as connection:
        schema_table_columns = {
            row[1] for row in connection.execute('PRAGMA table_info("SYS_SCHEMA_TABLES")')
        }
    assert "resource_id" not in schema_table_columns
    assert all("resource_id" not in table for table in registered_business_catalog(system)["tables"])


def test_registration_removes_legacy_schema_ownership_column(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    register_business_schema(system, business)

    with sqlite3.connect(system) as connection:
        connection.execute(
            "ALTER TABLE SYS_SCHEMA_TABLES ADD COLUMN resource_id TEXT NOT NULL DEFAULT 'legacy'"
        )
        connection.commit()

    register_business_schema(
        system,
        business,
        release_id="legacy-compatible-release",
        migration_id="LEGACY_COMPATIBLE_MIGRATION",
    )

    with sqlite3.connect(system) as connection:
        schema_table_columns = {
            row[1] for row in connection.execute('PRAGMA table_info("SYS_SCHEMA_TABLES")')
        }
    assert "resource_id" not in schema_table_columns
    assert all("resource_id" not in table for table in registered_business_catalog(system)["tables"])


def test_validate_detects_missing_registered_table(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    register_business_schema(
        system,
        business,
        registered_at=datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc),
    )
    manager = SchemaManager(system, business)
    manager.initialize()

    with sqlite3.connect(business) as connection:
        connection.execute('DROP TABLE "WEEKLY_TIME_WORKFLOW_EVENTS"')

    with pytest.raises(SchemaManagerError, match="missing registered tables"):
        manager.validate()


def test_initialize_renames_legacy_weekly_time_tables_without_losing_rows(
    tmp_path: Path,
) -> None:
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    specs_by_table = {spec.table: spec for spec in all_physical_specs()}

    with sqlite3.connect(business) as connection:
        for position, (legacy_table, current_table) in enumerate(
            WEEKLY_TIME_TABLE_RENAMES.items(), start=1
        ):
            spec = specs_by_table[current_table]
            connection.execute(
                f'ALTER TABLE "{current_table}" RENAME TO "{legacy_table}"'
            )
            for suffix, columns, unique in spec.indexes:
                connection.execute(
                    f'DROP INDEX "{current_table}_{suffix}"'
                )
                quoted_columns = ", ".join(f'"{column}"' for column in columns)
                connection.execute(
                    f'CREATE {"UNIQUE " if unique else ""}INDEX '
                    f'"{legacy_table}_{suffix}" ON "{legacy_table}" ({quoted_columns})'
                )
            connection.execute(
                f'INSERT INTO "{legacy_table}" '
                '(global_id, record_revision, deleted, conflict_state) '
                "VALUES (?, 'revision-1', 0, 'none')",
                (f"legacy-weekly-row-{position}",),
            )

        initialize_physical_schema(connection)

        available_tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        available_indexes = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
        for position, (legacy_table, current_table) in enumerate(
            WEEKLY_TIME_TABLE_RENAMES.items(), start=1
        ):
            assert legacy_table not in available_tables
            assert current_table in available_tables
            assert connection.execute(
                f'SELECT global_id FROM "{current_table}"'
            ).fetchall() == [(f"legacy-weekly-row-{position}",)]
            spec = specs_by_table[current_table]
            for suffix, _, _ in spec.indexes:
                assert f"{legacy_table}_{suffix}" not in available_indexes
                assert f"{current_table}_{suffix}" in available_indexes


def test_validate_rejects_registered_rows_left_in_generic_storage(
    tmp_path: Path,
) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    register_business_schema(system, business)
    manager = SchemaManager(system, business)
    manager.initialize()
    with closing(sqlite3.connect(business)) as connection:
        connection.execute(
            """
            INSERT INTO sw_sync_entity(
                entity_type, entity_id, body_json, record_revision, deleted, conflict_state
            ) VALUES (?, 'legacy-row', '{}', 'legacy-revision', 0, 'none')
            """,
            (HOLIDAY_ENTITY_TYPE,),
        )
        connection.commit()

    with pytest.raises(SchemaManagerError, match="generic JSON storage"):
        manager.validate()


def test_schema_registration_is_idempotent_until_registry_changes(
    tmp_path: Path,
) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    first = register_business_schema(
        system,
        business,
        registered_at=datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc),
    )
    second = register_business_schema(
        system,
        business,
        registered_at=datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc),
    )

    assert first["release_id"] == second["release_id"]
    assert first["schema_version"] == second["schema_version"]
    assert second["changed"] is False
    with sqlite3.connect(system) as connection:
        assert connection.execute("SELECT COUNT(*) FROM SYS_SCHEMA_RELEASES").fetchone()[0] == 1


def test_catalog_registers_every_current_and_future_physical_spec(
    tmp_path: Path,
) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    result = register_business_schema(system, business)

    assert set(result["registered_tables"]) == {
        table_name for table_name, *_ in BUSINESS_TABLES
    }


def test_workstation_registration_does_not_require_local_business_replica(
    tmp_path: Path,
) -> None:
    system = tmp_path / "system.db"
    missing_business = tmp_path / "missing" / "stormwater.db"

    result = register_business_schema(system, missing_business)

    assert system.is_file()
    assert not missing_business.exists()
    assert set(result["registered_tables"]) == {
        table_name for table_name, *_ in BUSINESS_TABLES
    }


def test_compatible_transition_registration_is_idempotent(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    target = register_business_schema(system, business)

    first = ensure_compatible_schema_transition(
        system,
        from_release_id="portal-coordinator-v1",
        from_schema_version=1,
        from_catalog_hash="legacy-catalog-hash",
    )
    second = ensure_compatible_schema_transition(
        system,
        from_release_id="portal-coordinator-v1",
        from_schema_version=1,
        from_catalog_hash="legacy-catalog-hash",
    )

    assert first["to_release_id"] == target["release_id"]
    assert first["changed"] is True
    assert second["migration_id"] == first["migration_id"]
    assert second["changed"] is False
    with sqlite3.connect(system) as connection:
        count = connection.execute(
            "SELECT COUNT(*) FROM SYS_SCHEMA_MIGRATIONS WHERE from_release_id=? AND active=1",
            ("portal-coordinator-v1",),
        ).fetchone()[0]
    assert count == 1


def test_compatible_transition_supersedes_unpublished_target(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    first_target = register_business_schema(system, business)
    first_route = ensure_compatible_schema_transition(
        system,
        from_release_id="portal-coordinator-v1",
        from_schema_version=1,
        from_catalog_hash="legacy-catalog-hash",
    )

    with sqlite3.connect(system) as connection:
        connection.execute(
            "UPDATE SYS_SCHEMA_RELEASES SET status='deprecated' WHERE release_id=?",
            (first_target["release_id"],),
        )
        connection.execute(
            """
            INSERT INTO SYS_SCHEMA_RELEASES(release_id, schema_version, catalog_hash, status)
            VALUES ('portal-coordinator-corrected-test', 3, 'corrected-catalog-hash', 'active')
            """
        )
        connection.commit()

    replacement = ensure_compatible_schema_transition(
        system,
        from_release_id="portal-coordinator-v1",
        from_schema_version=1,
        from_catalog_hash="legacy-catalog-hash",
    )

    assert replacement["to_release_id"] == "portal-coordinator-corrected-test"
    assert replacement["migration_id"] != first_route["migration_id"]
    assert replacement["changed"] is True
    with sqlite3.connect(system) as connection:
        routes = connection.execute(
            """
            SELECT migration_id, to_release_id, active
            FROM SYS_SCHEMA_MIGRATIONS
            WHERE from_release_id=?
            ORDER BY migration_id
            """,
            ("portal-coordinator-v1",),
        ).fetchall()
    assert sum(int(row[2]) for row in routes) == 1
    assert any(row[0] == first_route["migration_id"] and row[2] == 0 for row in routes)
    assert any(row[1] == "portal-coordinator-corrected-test" and row[2] == 1 for row in routes)


def test_additive_schema_draft_registers_and_migrates(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    first = register_business_schema(
        system,
        business,
        registered_at=datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc),
    )
    manager = SchemaManager(system, business)
    manager.initialize()
    active = registered_business_catalog(system)
    operations = [
        {
            "kind": "add_column",
            "table_id": "SYS.user_favorite",
            "column": "note",
            "sqlite_type": "TEXT",
            "nullable": True,
            "default": None,
        },
        {
            "kind": "create_index",
            "table_id": "SYS.user_favorite",
            "index": "PORTAL_UF_note",
            "columns": ["note"],
            "unique": False,
        },
    ]
    draft = apply_compatible_schema_draft(active["tables"], operations)
    second = register_business_schema(
        system,
        business,
        registered_at=datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc),
        catalog_override=schema_draft_catalog_for_registration(draft),
        migration_handler=COMPATIBLE_SQLITE_HANDLER,
        migration_specification={
            "operations": [
                {**operation, "table": "PORTAL_USER_FAVORITES"}
                for operation in operations
            ]
        },
    )

    assert second["previous_release_id"] == first["release_id"]
    assert manager.plan()["migrations"][0]["handler_name"] == COMPATIBLE_SQLITE_HANDLER
    manager.migrate()
    with closing(sqlite3.connect(business)) as connection:
        columns = {row[1] for row in connection.execute('PRAGMA table_info("PORTAL_USER_FAVORITES")')}
        indexes = {row[1] for row in connection.execute('PRAGMA index_list("PORTAL_USER_FAVORITES")')}
    assert "note" in columns
    assert "PORTAL_UF_note" in indexes
    assert manager.validate()["valid"] is True


def test_additive_schema_draft_rejects_required_field_without_default(tmp_path: Path) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    register_business_schema(system, business)
    active = registered_business_catalog(system)

    with pytest.raises(ValueError, match="needs a default value"):
        apply_compatible_schema_draft(
            active["tables"],
            [{
                "kind": "add_column",
                "table_id": "SYS.user_favorite",
                "column": "required_note",
                "sqlite_type": "TEXT",
                "nullable": False,
                "default": None,
            }],
        )


def test_alembic_schema_draft_adds_and_renames_table_and_field_without_data_loss(
    tmp_path: Path,
) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    register_business_schema(
        system,
        business,
        registered_at=datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc),
    )
    manager = SchemaManager(system, business)
    manager.initialize()

    active = registered_business_catalog(system)
    add_operations = [
        {
            "kind": "add_table",
            "table_id": "tbl_0123456789abcdef0123456789abcdef",
            "physical_table": "SCHEMA_TEST_ITEMS",
            "dependency_order": 900,
        },
        {
            "kind": "add_column",
            "table_id": "tbl_0123456789abcdef0123456789abcdef",
            "column": "item_name",
            "sqlite_type": "TEXT",
            "nullable": True,
            "default": None,
        },
        {
            "kind": "create_index",
            "table_id": "tbl_0123456789abcdef0123456789abcdef",
            "index": "IX_SCHEMA_TEST_ITEMS_NAME",
            "columns": ["item_name"],
            "unique": False,
        },
    ]
    add_draft = apply_schema_draft(active["tables"], add_operations)
    add_migration = prepare_schema_migration_operations(active["tables"], add_operations)
    first = register_business_schema(
        system,
        business,
        registered_at=datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc),
        catalog_override=schema_draft_catalog_for_registration(add_draft),
        migration_handler=ALEMBIC_SCHEMA_HANDLER,
        migration_specification={"operations": add_migration},
    )

    plan = manager.plan()
    assert plan["migrations"][0]["handler_name"] == ALEMBIC_SCHEMA_HANDLER
    assert plan["migrations"][0]["migration_kind"] == "custom"
    manager.migrate()
    with closing(sqlite3.connect(business)) as connection:
        connection.execute(
            """
            INSERT INTO SCHEMA_TEST_ITEMS(
                global_id, record_revision, deleted, conflict_state, item_name
            ) VALUES ('test-item-1', 'revision-1', 0, 'none', 'Preserved value')
            """
        )
        connection.commit()

    active = registered_business_catalog(system)
    table = next(
        item for item in active["tables"]
        if item["table_id"] == "tbl_0123456789abcdef0123456789abcdef"
    )
    field = next(
        item for item in table["fields"]
        if item["physical_column"] == "item_name"
    )
    rename_operations = [
        {
            "kind": "rename_table",
            "table_id": "tbl_0123456789abcdef0123456789abcdef",
            "physical_table": "SCHEMA_MAINTENANCE_ITEMS",
        },
        {
            "kind": "rename_column",
            "table_id": "tbl_0123456789abcdef0123456789abcdef",
            "field_id": field["field_id"],
            "column": "display_name",
        },
        {
            "kind": "drop_index",
            "table_id": "tbl_0123456789abcdef0123456789abcdef",
            "index": "IX_SCHEMA_TEST_ITEMS_NAME",
        },
    ]
    rename_draft = apply_schema_draft(active["tables"], rename_operations)
    rename_migration = prepare_schema_migration_operations(
        active["tables"], rename_operations
    )
    second = register_business_schema(
        system,
        business,
        registered_at=datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc),
        catalog_override=schema_draft_catalog_for_registration(rename_draft),
        migration_handler=ALEMBIC_SCHEMA_HANDLER,
        migration_specification={"operations": rename_migration},
    )

    assert second["previous_release_id"] == first["release_id"]
    manager.migrate()
    with closing(sqlite3.connect(business)) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        fields = {
            row[1]
            for row in connection.execute(
                'PRAGMA table_info("SCHEMA_MAINTENANCE_ITEMS")'
            )
        }
        indexes = {
            row[1]
            for row in connection.execute(
                'PRAGMA index_list("SCHEMA_MAINTENANCE_ITEMS")'
            )
        }
        preserved = connection.execute(
            "SELECT display_name FROM SCHEMA_MAINTENANCE_ITEMS WHERE global_id='test-item-1'"
        ).fetchone()

    assert "SCHEMA_TEST_ITEMS" not in tables
    assert "SCHEMA_MAINTENANCE_ITEMS" in tables
    assert "item_name" not in fields
    assert "display_name" in fields
    assert "IX_SCHEMA_TEST_ITEMS_NAME" not in indexes
    assert preserved == ("Preserved value",)
    assert manager.validate()["valid"] is True
    final_catalog = registered_business_catalog(system)
    final_table = next(
        item for item in final_catalog["tables"]
        if item["table_id"] == "tbl_0123456789abcdef0123456789abcdef"
    )
    final_field = next(
        item for item in final_table["fields"]
        if item["physical_column"] == "display_name"
    )
    assert final_table["physical_table"] == "SCHEMA_MAINTENANCE_ITEMS"
    assert final_field["field_id"] == field["field_id"]


def test_schema_draft_rejects_manually_assigned_table_identity(
    tmp_path: Path,
) -> None:
    system = tmp_path / "system.db"
    business = tmp_path / "stormwater.db"
    _create_business_database(business)
    register_business_schema(system, business)
    active = registered_business_catalog(system)

    with pytest.raises(ValueError, match="application-generated"):
        apply_schema_draft(
            active["tables"],
            [{
                "kind": "add_table",
                "table_id": "RPT7K2M9.forbidden_item",
                "physical_table": "SCHEMA_FORBIDDEN_ITEMS",
                "dependency_order": 901,
            }],
        )
