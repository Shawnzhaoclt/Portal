from __future__ import annotations

import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from portal.app.management import database
from portal.app.management.database import Base
from portal.app.management.models import Resource, User
from portal.app.management.services import effective_resource_permission, set_selected_user_role


def user(*, admin: bool = False, system_admin: bool = False) -> User:
    return User(
        username="tester",
        first_name="Portal",
        last_name="Tester",
        email="tester@example.com",
        employee_id="100001",
        password_hash="test",
        is_active=1,
        is_admin=1 if admin else 0,
        is_system_admin=1 if system_admin else 0,
    )


def resource(*, active: bool = True, released: bool = True, public: bool = True) -> Resource:
    return Resource(
        resource_id="MAPTEST1",
        resource_key="release_test",
        name="Release test",
        resource_type="map",
        url="/map_release_test",
        is_active=1 if active else 0,
        is_released=1 if released else 0,
        is_public=1 if public else 0,
    )


class ResourceReleaseAuthorizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.session = Session(self.engine)

    def tearDown(self) -> None:
        self.session.close()
        self.engine.dispose()

    def test_unreleased_resource_is_hidden_from_users_and_portal_admins(self) -> None:
        pending = resource(released=False)
        self.assertIsNone(effective_resource_permission(self.session, user(), pending))
        self.assertIsNone(effective_resource_permission(self.session, user(admin=True), pending))

    def test_unreleased_resource_is_visible_to_system_admin_preview(self) -> None:
        system_admin = user(system_admin=True)
        effective = effective_resource_permission(self.session, system_admin, resource(released=False))
        self.assertIsNotNone(effective)
        self.assertEqual(effective["source"], "system_admin_unreleased_preview")

    def test_system_admin_simulating_admin_cannot_see_unreleased_resource(self) -> None:
        system_admin = user(system_admin=True)
        set_selected_user_role(system_admin, "admin")
        self.assertIsNone(effective_resource_permission(self.session, system_admin, resource(released=False)))

    def test_inactive_resource_is_hidden_even_from_system_admin(self) -> None:
        self.assertIsNone(
            effective_resource_permission(self.session, user(system_admin=True), resource(active=False, released=False))
        )


class ResourceReleaseMigrationTests(unittest.TestCase):
    def test_existing_resources_are_backfilled_as_released(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        with engine.begin() as connection:
            connection.execute(text("""
                CREATE TABLE SYS_RESOURCES (
                    id INTEGER PRIMARY KEY,
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
                    created_at VARCHAR NOT NULL,
                    updated_at VARCHAR NOT NULL
                )
            """))
            connection.execute(text("""
                INSERT INTO SYS_RESOURCES (
                    id, resource_id, resource_key, name, resource_type, url,
                    is_public, is_active, created_at, updated_at
                ) VALUES (
                    1, 'MAPTEST1', 'release_test', 'Release test', 'map', '/map_release_test',
                    0, 1, '2026-08-01 08:00:00', '2026-08-02 09:30:00'
                )
            """))

        with patch.object(database, "engine", engine):
            database._migrate_resource_release_status()

        with engine.connect() as connection:
            row = connection.execute(
                text("SELECT is_released, released_at, released_by_user_id FROM SYS_RESOURCES WHERE id = 1")
            ).mappings().one()
            self.assertEqual(row["is_released"], 1)
            self.assertEqual(row["released_at"], "2026-08-02 09:30:00")
            self.assertIsNone(row["released_by_user_id"])
            foreign_keys = connection.execute(text("PRAGMA foreign_key_list('SYS_RESOURCES')")).mappings().all()
            self.assertTrue(
                any(
                    row["from"] == "released_by_user_id" and row["table"] == "SYS_USERS"
                    for row in foreign_keys
                )
            )
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
